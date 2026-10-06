/**
 * /qq — quick side questions that don't pollute the conversation (Claude Code's /btw, for pi).
 *
 * Four commands:
 *
 *  /qq <question>            side question, no tools
 *  /qqro <question>          side question, read-only tools only (read, grep, find, ls)
 *  /ro                       (side thread) toggle follow-ups between no-tools and read-only
 *  /nvm                      (side thread) "never mind" — drop the WHOLE side thread and
 *                             return to the main conversation
 *
 *  Neither side-question command touches the active tool set: the request is a
 *  byte-identical prefix extension of your last turn, so on llama.cpp/vLLM
 *  it costs ZERO extra prefill (the cache only grows). Tool policy is
 *  two-layer:
 *    1. the prompt note asks the model to comply (no tools / read-only);
 *    2. a hard guardrail: a tool_call handler is active for the duration of
 *       the side turn and BLOCKS any call outside the allow-list.
 *       The model receives the block reason as a tool error and falls back
 *       to answering in text. A rogue write/bash can therefore never
 *       execute during a side question.
 *
 * The Q&A takes over the main transcript like a normal turn. It STAYS there —
 * read it in place at your own pace. After EVERY side answer, the first
 * keypress decides:
 *
 *   f    → side-thread mode: the side branch stays and the input goes back
 *          to you. From now on, PLAIN TEXT in the editor runs as the next
 *          side question (no /qq needed); /ro toggles the tool policy;
 *          /nvm drops the whole thread. Every side answer ends in the same
 *          f / m / dismiss choice again.
 *   m    → MERGE: no rewind — the whole thread becomes part of the
 *          conversation and the next message continues right after it.
 *   any  → DISMISS: the WHOLE side thread (every question and answer in
 *          it) is rewound away and the conversation continues as if it
 *          never happened (mechanism: append Q&A on a side branch of pi's
 *          session tree, then navigateTree() back to the thread root).
 *
 *  Built-in pi commands (/new, /fork, /resume, /compact, /tree, …) are
 *  handled by pi before any extension can see them, so the mode detects
 *  their EFFECTS via session events (session_start / session_compact /
 *  session_tree) and ends itself: the thread is absorbed or orphaned, and
 *  plain text goes back to the main conversation.
 *
 *  The mode is also visible at all times:
 *    - the editor's top border switches to a "qq side thread" title
 *      (setEditorComponent with a CustomEditor subclass), and the footer
 *      status shows the live tool policy;
 *    - the slash-command list adapts (pi has no unregister, so via an
 *      autocomplete filter): inside the thread /qq and /qqro disappear
 *      (plain text is the question), outside it /ro and /nvm disappear.
 *      Hidden commands are still typeable — /qq inside the thread simply
 *      asks the next question, /ro and /nvm outside it only warn.
 *
 * Side questions:
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
 *      keypress decides: m merges (no rewind), f opens the side thread,
 *      any other key dismisses (rewinds the whole thread to its root).
 *      Dismissal consumes control keys and passes printable characters
 *      through, so you can start typing your next prompt immediately.
 *   4. If no assistant reply was produced (aborted before answering), rewind
 *      immediately — nothing to read.
 *
 * After a dismiss the exchange remains in the session file as a dead branch,
 * visible in /tree (auditability; you can re-attach it later by navigating to
 * it). Nothing is copied or deleted; pi never rewrites history.
 */

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	InputEvent,
	InputEventResult,
} from "@earendil-works/pi-coding-agent";

/**
 * Timeouts (ms). Exported so tests can shrink them (and so the impatient
 * can tune them) without touching the logic.
 */
export const config = {
	/** How long to wait for the side turn to settle before giving up. */
	settleTimeoutMs: 5 * 60 * 1000,
	/** How long to wait for true idle before declaring a rewind failed. */
	idleTimeoutMs: 60 * 1000,
	/** How long a queued question may wait for the agent to settle. */
	queueTimeoutMs: 2 * 60 * 60 * 1000,
};

/**
 * Editor variant shown while the side thread is open: the top border
 * carries the mode title so the input box never masquerades as the main
 * conversation. All app keybindings are preserved (interactive mode copies
 * them onto any CustomEditor subclass).
 */
class QqSideEditor extends CustomEditor {
	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		const title = " qq side thread — type a follow-up · /ro read-only · /nvm back to main ";
		if (width < 2 + title.length) return super.renderTopBorder(width, hiddenLineCount);
		return this.borderColor(`──${title}` + "─".repeat(width - 2 - title.length));
	}
}

/** Structural mirror of pi-ai's ImageContent (avoids importing pi-ai directly). */
type QqImage = { type: "image"; data: string; mimeType: string };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Wait for the next agent settle. Subscribe BEFORE re-checking idle so a
 * settle landing in the gap between the caller's check and the subscription
 * cannot be missed. Resolves false after config.queueTimeoutMs so a broken
 * settle can never wedge /qq (and the inFlight guard) forever.
 */
async function waitUntilSettled(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<boolean> {
	let resolveSettled: () => void;
	const settled = new Promise<void>((r) => (resolveSettled = r));
	const off = pi.on("agent_settled", () => resolveSettled());
	let queueTimer: ReturnType<typeof setTimeout> | undefined;
	try {
		if (ctx.isIdle()) return true; // settled in the gap between check and subscribe
		const timeout = new Promise<"timeout">((r) => {
			queueTimer = setTimeout(() => r("timeout"), config.queueTimeoutMs);
		});
		const result = await Promise.race([settled.then(() => "settled" as const), timeout]);
		return result === "settled";
	} finally {
		if (queueTimer !== undefined) clearTimeout(queueTimer);
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

/**
 * Rewind to a target leaf: no-op if the session was swapped or we're already
 * there; wait for true idle first (navigateTree refuses while a run or
 * compaction is active); re-check both before navigating.
 */
async function rewindLeaf(ctx: ExtensionCommandContext, sessionId: string, target: string): Promise<void> {
	if (ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getLeafId() === target) return;
	if (!(await waitUntilIdle(ctx, config.idleTimeoutMs))) {
		throw new Error("session still busy after 60s — nothing was rewound");
	}
	if (ctx.sessionManager.getSessionId() === sessionId && ctx.sessionManager.getLeafId() !== target) {
		await ctx.navigateTree(target);
	}
}

// ---------------------------------------------------------------------------
// Side question: take over the transcript, dismiss/merge on next keypress
// ---------------------------------------------------------------------------

/** A side thread: root is the leaf before the thread's first question. */
interface ThreadState {
	root: string | null;
	sessionId: string | null;
}

/** Side-thread mode control (state lives in the extension closure). */
interface ModeCtl {
	/** Enter mode after a "f" keypress (no-op if already active). */
	enter: (ctx: ExtensionCommandContext) => void;
	/** Leave mode: clears the status and removes ALL mode subscriptions. */
	exit: () => void;
}

async function runInline(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	label: string,
	question: string,
	policy: "none" | "ro", // tool policy for the prompt note (no freeze)
	thread: ThreadState,
	mode: ModeCtl,
	images?: QqImage[],
): Promise<void> {
	const sm = ctx.sessionManager;
	const homeLeaf = sm.getLeafId();
	if (!homeLeaf) {
		ctx.ui.notify(`/${label} needs an existing session (empty session has no branch point).`, "warning");
		return;
	}
	const sessionId = sm.getSessionId();

	// Thread bookkeeping. The thread is invalid (→ start fresh) when:
	//  - a real (non-qq) turn continued the branch after a follow-up prompt —
	//    the thread was absorbed into the conversation and can never be
	//    rewound away again, or
	//  - the root is no longer on the active path (e.g. /tree'd away).
	// In both cases the side-thread mode (if any) ends with it: the plain-text
	// hijack must never outlive the thread it feeds.
	if (thread.root && thread.sessionId === sessionId) {
		const b = sm.getBranch(sm.getLeafId() ?? undefined);
		const i = b.findIndex((e) => e.id === thread.root);
		const realTurn = (i >= 0 ? b.slice(i + 1) : []).some((e) => {
			if (e.type !== "message") return false;
			const m = e.message as { role?: string; content?: unknown };
			if (m.role !== "user") return false;
			const text =
				typeof m.content === "string"
					? m.content
					: Array.isArray(m.content)
						? (m.content as { type?: string; text?: string }[])
								.filter((x) => x?.type === "text")
								.map((x) => x.text ?? "")
								.join(" ")
							: "";
			return !text.startsWith("qq: ") && !text.startsWith("qqro: ");
		});
		if (i < 0 || realTurn) {
			thread.root = null;
			thread.sessionId = null;
			mode.exit();
		}
	}
	// A stale root from another session (/new mid-thread) is dropped; a fresh
	// question anchors the thread at homeLeaf; a follow-up keeps it.
	if (thread.root && thread.sessionId !== sessionId) {
		thread.root = null;
		thread.sessionId = null;
		mode.exit();
	}
	if (!thread.root) {
		thread.root = homeLeaf;
		thread.sessionId = sessionId;
	}

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

	// Readable in the transcript while pending. The note constrains the MODEL
	// (single self-contained reply, no questions back) — it does not prevent
	// the USER from following up in the side thread; each follow-up arrives
	// as a new turn carrying its own note.
	const note =
		policy === "ro"
			? "quick side question — answer it directly and concisely in a single reply, and do not ask me anything. You may use read-only tools (read, grep, find, ls) to inspect files, but do not modify anything and do not run commands."
			: "quick side question — answer it directly and concisely in a single reply, and do not ask me anything. Do not use any tools and do not modify anything.";

	// Send and wait for the settle; the subscriptions are ALWAYS removed —
	// a leaked session_before_compact handler would silently cancel every
	// future compaction, and a leaked guardrail would block tools forever.
	let result: "settled" | "timeout";
	let settleTimer: ReturnType<typeof setTimeout> | undefined;
	try {
		pi.sendUserMessage(
			images && images.length > 0
				? [{ type: "text", text: `${label}: ${question}\n\n(${note})` }, ...images]
				: `${label}: ${question}\n\n(${note})`,
		);
		const timeout = new Promise<"timeout">((r) => {
			settleTimer = setTimeout(() => r("timeout"), config.settleTimeoutMs);
		});
		result = await Promise.race([settled.then(() => "settled" as const), timeout]);
	} finally {
		if (settleTimer !== undefined) clearTimeout(settleTimer);
		offSettled();
		offBeforeCompact();
		offToolCall();
	}

	// Failure paths discard only THIS question (the rest of the thread,
	// if any, survives); a deliberate dismiss rewinds the WHOLE thread.
	const rewindTo = (target: string) => rewindLeaf(ctx, sessionId, target);
	const rewindThisQuestion = () => rewindTo(homeLeaf);

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
		// No (readable) assistant reply — discard only this question.
		let ok = true;
		try {
			await rewindThisQuestion();
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
		// Non-interactive mode: can't wait — discard this question now.
		try {
			await rewindThisQuestion();
		} catch (e) {
			ctx.ui.notify(`/${label} rewind failed: ${e instanceof Error ? e.message : String(e)}`, "error");
		}
		return;
	}

	const leaf = sm.getLeafId() as string;

	ctx.ui.setStatus(label, "side answer · f follow-up · m merges · any other key dismisses the thread");
	ctx.ui.notify(`${label} side answer ready — f follow-up, m merges, any other key dismisses the side thread.`, "info");

	const offInput = ctx.ui.onTerminalInput((data: string) => {
		offInput();
		ctx.ui.setStatus(label, undefined);

		// m / M: MERGE — the leaf is already at the side answer, so keeping it
		// means simply NOT rewinding: the next message continues right after
		// the Q&A and it becomes part of the live context. Thread ends.
		if (data === "m" || data === "M") {
			mode.exit();
			// Close marker: without it a resumed session cannot tell a MERGED
			// thread from an OPEN one (identical branch shape). Custom
			// entries don't participate in the LLM context — it's free.
			pi.appendEntry(label, { closed: true });
			thread.root = null;
			thread.sessionId = null;
			ctx.ui.notify(`${label} merged — side Q&A is now part of the conversation.`, "info");
			return { consume: true };
		}

		// f / F: FOLLOW-UP — open the side thread: the branch stays and the
		// input goes back to the user. From now on, plain text in the editor
		// runs as the next side question; /ro toggles the tool policy; /nvm
		// drops the whole thread.
		if (data === "f" || data === "F") {
			mode.enter(ctx);
			ctx.ui.notify(
				`${label} side thread open — just type a follow-up (it runs as a side question) · /ro read-only · /nvm back to main.`,
				"info",
			);
			return { consume: true };
		}

		// anything else: DISMISS — rewind the WHOLE side thread away. The
		// thread state is cleared only AFTER a successful rewind so a failed
		// one can be retried with another /qq.
		mode.exit();
		void (async () => {
			try {
				if (sm.getLeafId() === leaf) {
					const target = thread.root ?? homeLeaf;
					await rewindTo(target);
				}
				thread.root = null;
				thread.sessionId = null;
				ctx.ui.notify(`${label} dismissed — side thread removed from the conversation.`, "info");
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

/** Structural view of a branch entry (message or custom marker). */
type QqBranchEntry = {
	id: string;
	type: string;
	customType?: string;
	message?: { role: string; content: unknown };
};

/**
 * Resume detection (see the session_start handler): the in-memory thread
 * state dies with the process, but the thread itself lives in the session
 * file. If the branch ENDS in side Q&A — a run of consecutive
 * (marker, "label: question", assistant answer) triples, optionally
 * followed by an UNANSWERED (marker, "label: question") pair (pi was exited
 * while the follow-up was still streaming) — the user most likely quit
 * mid-thread. Returns the thread root (the entry before the thread's first
 * marker) plus whether the last question was answered, or null.
 *
 * A MERGED thread is distinguishable: the merge appends a close marker, so
 * the branch no longer ends in a triple/pair. An ABSORBED thread (a normal
 * message followed the side Q&A) likewise fails the walk.
 */
export function detectSideThreadRoot(
	branch: QqBranchEntry[],
): { root: string; answered: boolean } | null {
	const isMarker = (e: QqBranchEntry) =>
		e.type === "custom" && (e.customType === "qq" || e.customType === "qqro");
	const isSideUser = (e: QqBranchEntry) =>
		e.type === "message" &&
		e.message?.role === "user" &&
		typeof e.message.content === "string" &&
		(e.message.content.startsWith("qq: ") || e.message.content.startsWith("qqro: "));
	const isAnswer = (e: QqBranchEntry) => e.type === "message" && e.message?.role === "assistant";

	let j = branch.length - 1;
	let answered = true;
	if (j >= 1 && isMarker(branch[j - 1]) && isSideUser(branch[j])) {
		j -= 2; // trailing unanswered question (exited mid-stream)
		answered = false;
	}
	let matched = false;
	for (; j - 2 >= 0; j -= 3) {
		if (isMarker(branch[j - 2]) && isSideUser(branch[j - 1]) && isAnswer(branch[j])) {
			matched = true;
			continue;
		}
		break;
	}
	if (!matched && answered) return null; // leaf is not part of any side Q&A
	return j >= 0 ? { root: branch[j].id, answered } : null;
}

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
	// The active side thread: root is the leaf before the thread's first
	// question — a dismiss rewinds the WHOLE thread back to it. Cleared on
	// merge, on a successful dismiss, and by runInline when the thread is
	// absorbed (a real turn continues the branch) or orphaned (/tree away).
	const thread: ThreadState = { root: null, sessionId: null };

	// ── Side-thread mode (opened with "f" on a side answer) ──────────────
	// While active, plain editor input is hijacked into the next side
	// question. The mode CANNOT outlive its thread: built-in pi commands
	// (/new, /fork, /resume, /compact, /tree, …) never reach extension input
	// handlers, so their effects are detected via session events and end the
	// mode. Our own rewinds navigate only AFTER exitMode(), so the
	// session_tree handler never reacts to them.
	let sideMode = false;
	let followUpPolicy: "none" | "ro" = "none";
	let modeCtx: ExtensionCommandContext | null = null;
	let modeSubs: Array<() => void> = [];

	const modeStatus = (): string =>
		`side thread${followUpPolicy === "ro" ? " · read-only" : ""} — /ro toggles · /nvm leaves`;

	const exitMode = (): void => {
		if (!sideMode) return;
		sideMode = false;
		for (const off of modeSubs) off();
		modeSubs = [];
		modeCtx?.ui.setEditorComponent(undefined); // restore the default editor
		modeCtx?.ui.setStatus("qq", undefined);
		modeCtx = null;
	};

	const dropThreadAndExit = (): void => {
		thread.root = null;
		thread.sessionId = null;
		exitMode();
	};

	function enterMode(ctx: ExtensionCommandContext): void {
		if (sideMode) return;
		sideMode = true;
		followUpPolicy = "none";
		modeCtx = ctx;
		// The input box itself advertises the mode: top border becomes the
		// side-thread title (restored by exitMode via setEditorComponent(undefined)).
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new QqSideEditor(tui, theme, keybindings));
		ctx.ui.setStatus("qq", modeStatus());
		// (session_start is handled by the PERMANENT handler below — one
		// place that both voids the mode and re-detects a resumable thread.)
		modeSubs = [
			pi.on("input", onModeInput),
			pi.on("session_compact", dropThreadAndExit),
			pi.on("session_shutdown", exitMode),
			pi.on("session_tree", (e) => {
				if (e.fromExtension) return; // our own rewinds navigate after exitMode
				dropThreadAndExit();
			}),
		];
	}

	const modeCtl: ModeCtl = { enter: enterMode, exit: exitMode };

	// The slash-command list is static (pi has no unregister), so the mode is
	// reflected in the AUTOCOMPLETE surface instead: while the side thread is
	// open, /qq and /qqro disappear from the list (plain text is the question);
	// while it is closed, /ro and /nvm disappear (they only warn outside the
	// thread). Hidden commands stay typeable. Registered once, on the first
	// session_start (fires at startup); addAutocompleteProvider applies the
	// wrapper immediately and it reads the live mode state per suggestion.
	let autocompleteWrapped = false;
	pi.on("session_start", (_event, ctx) => {
		const c = ctx as ExtensionCommandContext;
		if (!autocompleteWrapped) {
			autocompleteWrapped = true;
			c.ui.addAutocompleteProvider((current) => ({
				triggerCharacters: current.triggerCharacters,
				shouldTriggerFileCompletion: current.shouldTriggerFileCompletion?.bind(current),
				getSuggestions: (lines, line, col, opts) =>
					current.getSuggestions(lines, line, col, opts).then((s) => {
						if (!s) return s;
						const hidden = new Set(sideMode ? ["qq", "qqro"] : ["ro", "nvm"]);
						const items = s.items.filter((it) => !hidden.has(it.value));
						return items.length === 0 ? null : { ...s, items };
					}),
				applyCompletion: (lines, line, col, item, prefix) => current.applyCompletion(lines, line, col, item, prefix),
			}));
		}
		// A session start voids any in-memory mode (and a resumed process has
		// none) — but the thread itself lives in the session file. If the
		// branch ends in side Q&A, the user exited pi mid-thread: re-anchor
		// the thread. An ANSWERED thread re-enters the mode (plain text
		// resumes the follow-up; /nvm drops it; m after an answer keeps it);
		// an unanswered one (exited mid-stream) only restores the thread
		// state so /nvm can still drop it.
		const found = detectSideThreadRoot(c.sessionManager.getBranch() as QqBranchEntry[]);
		if (found) {
			exitMode();
			thread.root = found.root;
			thread.sessionId = c.sessionManager.getSessionId();
			if (found.answered) {
				enterMode(c);
				c.ui.notify(
					"Resumed the side thread you left open — type a follow-up · /ro read-only · /nvm drops it · m after an answer keeps it.",
					"info",
				);
			} else {
				c.ui.notify(
					"You left a side question without an answer — /nvm drops the thread, or just continue in the main conversation.",
					"info",
				);
			}
		} else {
			dropThreadAndExit();
		}
	});

	// Plain editor input becomes the next side question while the side
	// thread is open. Must NOT hijack:
	//  - our own side messages (sendUserMessage arrives with source
	//    "extension" — hijacking those would recurse forever);
	//  - rpc/extension drivers (a remote caller never meant a side question);
	//  - slash input: built-ins are handled by pi before this event, /ro and
	//    /nvm are extension commands dispatched before this event, and
	//    /qq… works as-is; anything else passes through untouched.
	async function onModeInput(event: InputEvent): Promise<InputEventResult> {
		if (!sideMode) return { action: "continue" };
		if (event.source !== "interactive") return { action: "continue" };
		const text = event.text.trim();
		if (!text) return { action: "handled" }; // never let an empty prompt through in mode
		if (text.startsWith("/")) return { action: "continue" };
		if (!modeCtx) return { action: "continue" };
		await executeSideQuestion(modeCtx, followUpPolicy === "ro" ? "qqro" : "qq", text, event.images);
		return { action: "handled" };
	}

	/** Shared by the /qq commands and the side-thread input hijack. */
	async function executeSideQuestion(
		ctx: ExtensionCommandContext,
		label: "qq" | "qqro",
		question: string,
		images?: QqImage[],
	): Promise<void> {
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
			await runInline(pi, ctx, label, question, label === "qqro" ? "ro" : "none", thread, modeCtl, images);
		} finally {
			inFlight = false;
		}
	}

	const register = (label: "qq" | "qqro", description: string) =>
		pi.registerCommand(label, {
			description,
			handler: async (args: string, ctx: ExtensionCommandContext) => {
				const question = args.trim();
				if (!question) {
					ctx.ui.notify(`Usage: /${label} <question>`, "warning");
					return;
				}
				await executeSideQuestion(ctx, label, question);
			},
		});

	register("qq", "Quick side question (no tools) — f follow-up, m merges, any other key dismisses the thread");
	register(
		"qqro",
		"Quick side question (read-only tools only) — f follow-up, m merges, any other key dismisses",
	);

	pi.registerCommand("ro", {
		description: "Side thread: toggle read-only tools for follow-ups (works after f)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!sideMode) {
				ctx.ui.notify("Not in a side thread — /ro only works after you press f on a side answer.", "warning");
				return;
			}
			followUpPolicy = followUpPolicy === "ro" ? "none" : "ro";
			ctx.ui.notify(
				followUpPolicy === "ro"
					? "Follow-ups are now read-only (read, grep, find, ls)."
					: "Follow-ups are back to no tools.",
			);
			ctx.ui.setStatus("qq", modeStatus());
		},
	});

	pi.registerCommand("nvm", {
		description: "Side thread: never mind — drop the whole side thread and return to the main conversation",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!sideMode && !thread.root) {
				ctx.ui.notify("No side thread to dismiss.", "warning");
				return;
			}
			if (inFlight) {
				ctx.ui.notify("A side question is in flight — wait for it (or abort with esc), then /nvm.", "warning");
				return;
			}
			const sessionId = ctx.sessionManager.getSessionId();
			const root = thread.root && thread.sessionId === sessionId ? thread.root : null;
			exitMode();
			if (root) {
				try {
					await rewindLeaf(ctx, sessionId, root);
					thread.root = null;
					thread.sessionId = null;
					ctx.ui.notify("Side thread dismissed — you're back on the main conversation.", "info");
				} catch (err) {
					// Keep the thread state so /qq + any key can retry the rewind.
					ctx.ui.notify(
						`Failed to dismiss the side thread: ${err instanceof Error ? err.message : String(err)} — press /qq and hit any key to retry.`,
						"error",
					);
				}
			} else {
				thread.root = null;
				thread.sessionId = null;
				ctx.ui.notify("Back to the main conversation.", "info");
			}
		},
	});
}
