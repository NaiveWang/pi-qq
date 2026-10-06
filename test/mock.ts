/**
 * Mock pi environment for testing extensions/qq.ts.
 *
 * The extension imports pi's types ONLY (no runtime dependency), so the
 * whole logic can be exercised against a mock ExtensionAPI + an in-memory
 * session tree that mirrors the shape of pi's JSONL entries.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { MockSession, MockCtx } from "./types.ts";
import qqExtension from "../extensions/qq.ts";

// ---------------------------------------------------------------------------
// Agent behavior (what the model does after a user message is sent)
// ---------------------------------------------------------------------------

export interface AgentBehavior {
	/** Assistant reply text; null/undefined = the agent produces no text answer. */
	answer?: string | null;
	/** Tool name the model "attempts" before answering (exercises the guardrail). */
	toolCall?: string;
	/** Delay before the run settles, ms (default 20). */
	delayMs?: number;
	/** false = the run never settles (timeout tests). */
	settles?: boolean;
}

// ---------------------------------------------------------------------------
// Mock Pi
// ---------------------------------------------------------------------------

export interface ToolResult {
	block?: boolean;
	reason?: string;
}

export class MockPi {
	/** Handlers receive (event, ctx), mirroring pi. */
	listeners = new Map<string, Set<(event: unknown, ctx: unknown) => unknown>>();
	commands = new Map<string, { description: string; handler: (args: string, ctx: unknown) => Promise<void> | void }>();
	/** Listener count right after extension registration (permanent subs, e.g. session_start). */
	baselineActive = 0;
	sentMessages: string[] = [];
	appended: { type: string; data: unknown }[] = [];
	toolResults: (ToolResult | undefined)[] = [];
	session: MockSession;
	ctx: MockCtx;
	behavior: AgentBehavior;

	constructor(session: MockSession, ctx: MockCtx, behavior: AgentBehavior) {
		this.session = session;
		this.ctx = ctx;
		this.behavior = behavior;
	}

	on(event: string, handler: (event: unknown) => unknown): () => void {
		if (!this.listeners.has(event)) this.listeners.set(event, new Set());
		this.listeners.get(event)!.add(handler);
		return () => {
			this.listeners.get(event)?.delete(handler);
		};
	}

	/** Invoke every registered handler for an event; returns their results. */
	emit(event: string, payload?: unknown): unknown[] {
		// Mirrors pi: handlers receive (event, ctx).
		return [...(this.listeners.get(event) ?? [])].map((h) => h(payload, this.ctx));
	}

	activeByEvent(event: string): number {
		return this.listeners.get(event)?.size ?? 0;
	}

	activeCount(): number {
		let n = 0;
		for (const s of this.listeners.values()) n += s.size;
		return n;
	}

	registerCommand(name: string, def: { description: string; handler: (args: string, ctx: unknown) => Promise<void> | void }): void {
		this.commands.set(name, def);
	}

	/** pi.appendEntry: a custom marker entry that also lands in the session tree. */
	appendEntry(type: string, data: unknown): void {
		this.appended.push({ type, data });
		const e = this.session.add("custom", undefined);
		e.customType = type;
	}

	/** pi.sendUserMessage: appends the user entry, then simulates the agent run. */
	sendUserMessage(text: string): void {
		this.beginRun(text);
	}

	/** Simulate the agent executing a user message (append entry, run, settle). */
	beginRun(text: string): void {
		this.sentMessages.push(text);
		this.session.add("message", { role: "user", content: text });
		this.ctx.idle = false;
		if (this.behavior.settles === false) {
			// The run never emits agent_settled (broken/lost settle event), but
			// the session itself goes idle — the realistic failure mode.
			this.ctx.idle = true;
			return;
		}
		setTimeout(() => this.finishRun(), this.behavior.delayMs ?? 20);
	}

	/** The run ends: optional tool-call attempt, optional answer, then settle. */
	finishRun(): void {
		if (this.behavior.toolCall) {
			const results = this.emit("tool_call", { toolName: this.behavior.toolCall, input: {} });
			this.toolResults.push(...(results as (ToolResult | undefined)[]));
		}
		const answer = this.behavior.answer;
		if (typeof answer === "string") {
			this.session.add("message", { role: "assistant", content: [{ type: "text", text: answer }] });
		}
		this.ctx.idle = true;
		this.emit("agent_settled", {});
	}
}

// ---------------------------------------------------------------------------
// Env factory + helpers
// ---------------------------------------------------------------------------

export interface Env {
	pi: MockPi;
	session: MockSession;
	ctx: MockCtx;
	behavior: AgentBehavior;
}

/** Build a fresh environment with a seeded main conversation. */
export function makeEnv(behavior: AgentBehavior = {}): Env {
	const session = new MockSession();
	session.seed();
	const ctx = new MockCtx(session);
	const pi = new MockPi(session, ctx, behavior);
	(qqExtension as unknown as (pi: unknown) => void)(pi);
	pi.baselineActive = pi.activeCount();
	return { pi, session, ctx, behavior };
}

/** Invoke a registered command handler. */
export function run(env: Env, name: string, args: string): Promise<void> {
	const cmd = env.pi.commands.get(name);
	if (!cmd) throw new Error(`command /${name} not registered`);
	return Promise.resolve(cmd.handler(args, env.ctx as unknown as ExtensionCommandContext));
}

/** Simulate a main-conversation run (NOT via the extension) for queue tests. */
export function externalRun(
	env: Env,
	opts: { settleAfterMs?: number; answer?: string; text?: string; then?: () => void },
): void {
	env.session.add("message", { role: "user", content: opts.text ?? "external task" });
	env.ctx.idle = false;
	setTimeout(
		() => {
			if (opts.answer) env.session.add("message", { role: "assistant", content: [{ type: "text", text: opts.answer }] });
			env.ctx.idle = true;
			env.pi.emit("agent_settled", {});
			opts.then?.();
		},
		opts.settleAfterMs ?? 30,
	);
}

/** Poll until cond() is true (or fail). */
export async function waitFor(cond: () => boolean, what: string, ms = 3000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > ms) throw new Error(`timed out waiting for: ${what}`);
		await new Promise((r) => setTimeout(r, 5));
	}
}

/** True while the extension is in PENDING (waiting for a keypress). */
export const isPending = (env: Env): boolean => env.ctx.terminal.size > 0;

/**
 * Submit text the way pi's editor would (agent-session prompt()):
 *  1. if the text is a registered slash command, dispatch it IMMEDIATELY
 *     (before the input event — extension commands manage their own LLM
 *     interaction and cannot be intercepted by input handlers);
 *  2. otherwise fire the `input` event — handlers run in registration
 *     order, and a `{action: "handled"}` result short-circuits the rest (pi
 *     consumes it);
 *  3. otherwise it becomes a plain model message (what pi does with unknown
 *     slash text too).
 * NOTE: while the side thread is open, a plain-text submission resolves only
 * AFTER the resulting side question reaches its keypress — fire it
 * (const p = submitInput(...)), wait for PENDING, press, then await p.
 */
export async function submitInput(
	env: Env,
	text: string,
	source: "interactive" | "rpc" | "extension" = "interactive",
): Promise<"consumed" | "command" | "message"> {
	if (text.startsWith("/")) {
		const space = text.indexOf(" ");
		const name = space === -1 ? text.slice(1) : text.slice(1, space);
		const cmd = env.pi.commands.get(name);
		if (cmd) {
			await cmd.handler(space === -1 ? "" : text.slice(space + 1), env.ctx as unknown as ExtensionCommandContext);
			return "command";
		}
	}
	for (const h of env.pi.listeners.get("input") ?? []) {
		const r = (await h({ type: "input", text, source }, env.ctx)) as { action?: string } | undefined;
		if (r?.action === "handled") return "consumed";
	}
	env.pi.sentMessages.push(text);
	// Faithful to pi: an unconsumed input becomes a user message on the
	// current leaf (which, if it lands after a thread root, absorbs the
	// thread into the conversation).
	env.session.add("message", { role: "user", content: text });
	return "message";
}
