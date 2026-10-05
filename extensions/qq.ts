/**
 * /qq — quick side questions that don't pollute the conversation (Claude Code's /btw, for pi).
 *
 * Two commands:
 *
 *  /qq <question>            side question, prompt asks the model NOT to use
 *                            any tools
 *  /qqro <question>          side question, prompt asks the model to use only
 *                            read-only tools (read, grep, find, ls)
 *
 *  Neither command touches the active tool set: the request is a
 *  byte-identical prefix extension of your last turn, so on llama.cpp/vLLM
 *  it costs ZERO extra prefill (the cache only grows). Tool policy is
 *  two-layer:
 *    1. the prompt note asks the model to comply (no tools / read-only);
 *    2. a hard guardrail: a tool_call handler is active for the duration of
 *       the side turn and BLOCKS any call outside the command's allow-list.
 *       The model receives the block reason as a tool error and falls back
 *       to answering in text. A rogue write/bash can therefore never
 *       execute during a side question.
 *
 * The Q&A takes over the main transcript like a normal turn. It STAYS there —
 * read it in place at your own pace. Your next keypress decides:
 *
 *   any key  → DISMISS: the side branch is rewound away and the conversation
 *              continues as if it never happened (mechanism: append Q&A on a
 *              side branch of pi's session tree, then navigateTree() back).
 *   m        → MERGE: no rewind — the Q&A becomes part of the conversation
 *              and the next message continues right after the answer.
 *
 * Both commands:
 *   - if the agent is running, the question is QUEUED: it waits for the flow
 *     to fully settle (agent_settled is the final boundary — retries,
 *     continuations included) and then runs. Aborting the flow also
 *     unblocks. Strictly serial, so single-slot llama.cpp (-np 1) is fine.
 *   - cancel auto-compaction for the duration of the side turn: a side
 *     question must never compact the MAIN conversation (if the compaction
 *     entry were stranded on the main line, it would truncate the real
 *     history out of context)
 *   - never leave the session stuck: the rewind waits for true idle
 *     (no run, no compaction) before navigating
 *
 * Inline-mode mechanics:
 *   1. homeLeaf = current leaf; append a marker entry.
 *   2. sendUserMessage("<label>: <question>") — appears in the transcript,
 *      agent streams the answer inline. Subscribe to agent_settled BEFORE
 *      sending (it is the final boundary: retries, auto-compaction and
 *      queued continuations are all done).
 *   3. On settled, if an assistant reply exists: enter PENDING state —
 *      footer status + notification tell you the choices. The first terminal
 *      keypress decides: m merges (no rewind), any other key dismisses
 *      (rewinds to homeLeaf). Dismissal consumes control keys and passes
 *      printable characters through, so you can start typing your next prompt
 *      immediately.
 *   4. If no assistant reply was produced (aborted before answering), rewind
 *      immediately — nothing to read.
 *
 * After a dismiss the exchange remains in the session file as a dead branch,
 * visible in /tree (auditability; you can re-attach it later by navigating to
 * it). Nothing is copied or deleted; pi never rewrites history.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const QQ_SETTLE_TIMEOUT_MS = 5 * 60 * 1000;
const QQ_IDLE_TIMEOUT_MS = 60 * 1000;
const QQ_QUEUE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Wait for the next agent settle. Subscribe BEFORE re-checking idle so a
 * settle landing in the gap between the caller's check and the subscription
 * cannot be missed. Resolves false after QQ_QUEUE_TIMEOUT_MS so a broken
 * settle can never wedge /qq (and the inFlight guard) forever.
 */
async function waitUntilSettled(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<boolean> {
	let resolveSettled: () => void;
	const settled = new Promise<void>((r) => (resolveSettled = r));
	const off = pi.on("agent_settled", () => resolveSettled());
	try {
		if (ctx.isIdle()) return true; // settled in the gap between check and subscribe
		const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), QQ_QUEUE_TIMEOUT_MS));
		const result = await Promise.race([settled.then(() => "settled" as const), timeout]);
		void timeout;
		return result === "settled";
	} finally {
		off();
	}
}

/** navigateTree refuses while a run or compaction is active; wait for true idle. */
async function waitUntilIdle(ctx: ExtensionCommandContext, timeoutMs: number): Promise<boolean> {
	const start = Date.now();
	while (!ctx.isIdle()) {
		if (Date.now() - start > timeoutMs) return false;
		await sleep(100);
	}
	return true;
}

// ---------------------------------------------------------------------------
// Side question: take over the transcript, dismiss/merge on next keypress
// ---------------------------------------------------------------------------

async function runInline(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	label: string,
	question: string,
	policy: "none" | "ro", // tool policy for the prompt note (no freeze)
): Promise<void> {
	const sm = ctx.sessionManager;
	const homeLeaf = sm.getLeafId();
	if (!homeLeaf) {
		ctx.ui.notify(`/${label} needs an existing session (empty session has no branch point).`, "warning");
		return;
	}
	const sessionId = sm.getSessionId();

	// No tool freeze: keep the request a byte-identical prefix extension of
	// the last turn (zero extra prefill on llama.cpp/vLLM). Tool behavior is
	// requested in the prompt note AND enforced by the guardrail below.
	pi.appendEntry(label, { question });

	// Guardrail: block any tool call outside this command's allow-list for
	// the duration of the side turn. The blocked call becomes an error result
	// the model sees, so it falls back to a text answer.
	const allow = policy === "ro" ? new Set(["read", "grep", "find", "ls"]) : new Set<string>();
	const offToolCall = pi.on("tool_call", (event) => {
		if (allow.has(event.toolName)) return;
		return {
			block: true,
			reason:
				policy === "ro"
					? `/${label} side question is read-only: ${event.toolName} is blocked (allowed: read, grep, find, ls). Answer in text instead.`
					: `/${label} side question has no tools: ${event.toolName} is blocked. Answer in text instead.`,
		};
	});

	// Subscribe BEFORE sending: agent_settled can race sendUserMessage.
	let resolveSettled: () => void;
	const settled = new Promise<void>((r) => (resolveSettled = r));
	const offSettled = pi.on("agent_settled", () => resolveSettled());

	// Cancel auto-compaction for the duration of the side turn. A compaction
	// triggered by the side question would summarize (and truncate) the MAIN
	// conversation — and if the side branch is later rewound, the compaction
	// entry could be stranded on the main line with a side-branch summary.
	const offBeforeCompact = pi.on("session_before_compact", () => ({ cancel: true }));

	// Readable in the transcript while pending; the note carries the tool policy.
	const note =
		policy === "ro"
			? "quick side question — answer directly and concisely, no follow-up. You may use read-only tools (read, grep, find, ls) to inspect files. Do not modify anything and do not run commands."
			: "quick side question — answer directly and concisely, no follow-up. Do not use any tools and do not modify anything.";

	// Send and wait for the settle; the subscriptions are ALWAYS removed —
	// a leaked session_before_compact handler would silently cancel every
	// future compaction, and a leaked guardrail would block tools forever.
	let result: "settled" | "timeout";
	try {
		pi.sendUserMessage(`${label}: ${question}\n\n(${note})`);
		const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), QQ_SETTLE_TIMEOUT_MS));
		result = await Promise.race([settled.then(() => "settled" as const), timeout]);
		void timeout; // (no handle to clear; the late-resolution path is harmless)
	} finally {
		offSettled();
		offBeforeCompact();
		offToolCall();
	}


	// Rewind the session back to homeLeaf, waiting for true idle first
	// (navigateTree refuses while a run or compaction is active).
	const rewind = async (): Promise<void> => {
		if (sm.getSessionId() !== sessionId || sm.getLeafId() === homeLeaf) return;
		if (!(await waitUntilIdle(ctx, QQ_IDLE_TIMEOUT_MS))) {
			throw new Error("session still busy after 60s — rewound nothing, run /qq again to dismiss");
		}
		if (sm.getSessionId() === sessionId && sm.getLeafId() !== homeLeaf) {
			await ctx.navigateTree(homeLeaf);
		}
	};

	if (sm.getSessionId() !== sessionId || sm.getLeafId() === homeLeaf) {
		// Session was replaced or nothing was appended — nothing to rewind.
		if (result === "timeout") ctx.ui.notify(`/${label}: timed out waiting for the agent to settle.`, "error");
		return;
	}

	// "Answered" = an assistant message WITH readable text ANYWHERE on the
	// side branch (never trust the leaf alone: trailing entries may follow
	// the reply; a batch of blocked tool calls has no text and is not an
	// answer worth reading).
	const hasText = (e: { type?: string; message?: { role?: string; content?: unknown } }): boolean => {
		if (e.type !== "message" || e.message?.role !== "assistant") return false;
		const c = e.message.content;
		if (typeof c === "string") return c.length > 0;
		if (!Array.isArray(c)) return false;
		return c.some(
			(b): b is { type: "text"; text: string } =>
				typeof b === "object" && b !== null && (b as { type?: string }).type === "text" &&
				typeof (b as { text?: string }).text === "string" && (b as { text: string }).text.length > 0,
		);
	};
	const branch = sm.getBranch(sm.getLeafId() ?? undefined);
	const homeIdx = branch.findIndex((e) => e.id === homeLeaf);
	const side = homeIdx >= 0 ? branch.slice(homeIdx + 1) : branch;
	const answered = side.some(hasText);

	if (result === "timeout" || !answered) {
		// No (readable) assistant reply — rewind immediately.
		let ok = true;
		try {
			await rewind();
		} catch (e) {
			ok = false;
			ctx.ui.notify(`/${label} rewind failed: ${e instanceof Error ? e.message : String(e)}`, "error");
		}
		if (ok) {
			ctx.ui.notify(
				result === "timeout"
					? `/${label}: timed out — side question removed from the conversation.`
					: `/${label}: no answer produced — side question removed from the conversation.`,
				"warning",
			);
		}
		return;
	}

	// PENDING: the answer sits in the transcript. Wait for a keypress.
	if (typeof ctx.ui.onTerminalInput !== "function") {
		// Non-interactive mode: can't wait — rewind now.
		try {
			await rewind();
		} catch (e) {
			ctx.ui.notify(`/${label} rewind failed: ${e instanceof Error ? e.message : String(e)}`, "error");
		}
		return;
	}

	const leaf = sm.getLeafId() as string;

	ctx.ui.setStatus(label, "side answer · any key dismisses · m merges into conversation");
	ctx.ui.notify(`${label} side answer ready — any key dismisses it, m keeps it in the conversation.`, "info");

	const offInput = ctx.ui.onTerminalInput((data: string) => {
		offInput();
		ctx.ui.setStatus(label, undefined);

		// m / M: MERGE — the leaf is already at the side answer, so keeping it
		// means simply NOT rewinding: the next message continues right after
		// the Q&A and it becomes part of the live context.
		if (data === "m" || data === "M") {
			ctx.ui.notify(`${label} merged — side Q&A is now part of the conversation.`, "info");
			return { consume: true };
		}

		// anything else: DISMISS — rewind the side branch away.
		void (async () => {
			try {
				if (sm.getLeafId() === leaf) await rewind();
				ctx.ui.notify(`${label} dismissed — side answer removed from the conversation.`, "info");
			} catch (e) {
				ctx.ui.notify(`/${label} rewind failed: ${e instanceof Error ? e.message : String(e)} — the side Q&A is still in the transcript.`, "error");
			}
		})();
		// Swallow control/escape keys (so they don't trigger editor actions);
		// pass printable characters through so you can start typing the next
		// prompt immediately.
		const printable = /\p{L}|\p{N}|\p{P}|\p{S}|\p{Z}/u.test(data);
		return printable ? undefined : { consume: true };
	});
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/** Warn (don't block) when the side turn is likely to overflow the window. */
function preflightUsage(ctx: ExtensionCommandContext, label: string): void {
	const usage = ctx.getContextUsage?.();
	if (usage && usage.tokens !== null && usage.contextWindow > 0) {
		const pct = Math.round((usage.tokens / usage.contextWindow) * 100);
		if (pct >= 90) {
			ctx.ui.notify(`/${label}: context is at ~${pct}% of the window — the side turn may fail; consider /compact first.`, "warning");
		}
	}
}

export default function qqExtension(pi: ExtensionAPI) {
	let inFlight = false;

	const register = (label: string, description: string, policy: "none" | "ro") =>
		pi.registerCommand(label, {
			description,
			handler: async (args: string, ctx: ExtensionCommandContext) => {
				const question = args.trim();

				if (!question) {
					ctx.ui.notify(`Usage: /${label} <question>`, "warning");
					return;
				}
				if (inFlight) {
					ctx.ui.notify("A side question is already in flight.", "warning");
					return;
				}
				if (!ctx.model) {
					ctx.ui.notify(`No model selected for /${label}.`, "warning");
					return;
				}

				inFlight = true;
				try {
					// Busy: QUEUE the question instead of rejecting it. Wait for
					// the current flow to fully settle, then run. The loop
					// re-checks after every settle so a run that starts right
					// after one (queued continuation, new user message) is also
					// waited out. Aborting the flow settles it and unblocks.
					// homeLeaf is captured inside runInline — AFTER the wait —
					// so the rewind target is the leaf the flow ended on.
					let queued = false;
					while (!ctx.isIdle()) {
						if (!queued) {
							queued = true;
							ctx.ui.notify(`/${label}: agent is busy — queued, will run when the current flow settles (abort unblocks).`, "info");
							ctx.ui.setStatus(label, "queued · waiting for the agent to settle");
						}
						if (!(await waitUntilSettled(pi, ctx))) {
							ctx.ui.notify(`/${label}: gave up waiting after 2h — question dropped.`, "error");
							return;
						}
					}
					ctx.ui.setStatus(label, undefined);

					preflightUsage(ctx, label);
					await runInline(pi, ctx, label, question, policy);
				} finally {
					inFlight = false;
				}
			},
		});

	register("qq", "Quick side question (no tools) — any key dismisses, m merges into the conversation", "none");
	register(
		"qqro",
		"Quick side question (read-only tools only) — any key dismisses, m merges",
		"ro",
	);
}
