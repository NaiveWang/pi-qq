/**
 * Scenario matrix for the /qq extension.
 *
 * Groups:
 *  1. Command surface
 *  2. Basic lifecycle (send → settle → PENDING → dismiss/merge)
 *  3. Follow-up threads (f)
 *  4. Side-thread mode (plain text, /ro, /nvm)
 *  5. Mode surface (autocomplete filter, editor title)
 *  6. Failure paths (no answer, timeouts)
 *  7. Queue (busy agent)
 *  8. Safety invariants (leaks, compaction, tool guardrail, session swaps)
 *  9. Preflight
 * 10. Patched core (this branch): pruneBranches self-patch + drop ladder
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { config, installSessionPrune } from "../extensions/qq.ts";
import { makeEnv, run, waitFor, externalRun, isPending, submitInput, type Env } from "./mock.ts";
import { MockSession } from "./types.ts";

// Restore shrunk timeouts after each test.
const DEFAULTS = { ...config };
afterEach(() => {
	Object.assign(config, DEFAULTS);
});

/** Drive a side question until PENDING. */
async function toPending(env: Env, cmd: string, question: string): Promise<void> {
	const p = run(env, cmd, question);
	await waitFor(() => isPending(env), `PENDING after /${cmd} ${question}`);
	return p;
}

// ---------------------------------------------------------------------------
// 1. Command surface
// ---------------------------------------------------------------------------

test("registers /qq, /qqro, /ro, /nvm", () => {
	const env = makeEnv();
	for (const name of ["qq", "qqro", "ro", "nvm"]) assert.ok(env.pi.commands.has(name), `/${name} registered`);
	assert.match(env.pi.commands.get("qq")!.description, /f follow-up/);
	assert.match(env.pi.commands.get("qqro")!.description, /read-only/);
	assert.match(env.pi.commands.get("ro")!.description, /toggle read-only/);
	assert.match(env.pi.commands.get("nvm")!.description, /drop the whole side thread/);
});

test("empty args → usage warning, no session change", async () => {
	const env = makeEnv();
	const before = env.session.leafId;
	await run(env, "qq", "   ");
	assert.ok(env.ctx.notifyOf((m) => m.includes("Usage: /qq")));
	assert.equal(env.session.leafId, before);
	assert.equal(env.pi.sentMessages.length, 0);
});

// ---------------------------------------------------------------------------
// 2. Basic lifecycle
// ---------------------------------------------------------------------------

test("happy path: marker + labeled message, PENDING, dismiss rewinds to homeLeaf", async () => {
	const env = makeEnv({ answer: "42" });
	const homeLeaf = env.session.leafId!;

	await toPending(env, "qq", "what is the answer?");

	// Marker entry recorded and in the tree (custom entry before the user message).
	assert.ok(env.pi.appended.some((a) => a.type === "qq" && (a.data as { question: string }).question === "what is the answer?"));
	const branch = env.session.branch();
	const markerIdx = branch.findIndex((e) => e.type === "custom");
	const userIdx = branch.findIndex((e) => e.message?.role === "user" && (e.message.content as string).startsWith("qq: "));
	assert.ok(markerIdx > -1 && userIdx === markerIdx + 1, "custom marker directly precedes the side user message");

	// The sent message is labeled and carries the no-tools note.
	const sent = env.pi.sentMessages[0];
	assert.ok(sent.startsWith("qq: what is the answer?"));
	assert.match(sent, /Do not use any tools/);

	// Dismiss → rewind to homeLeaf.
	env.ctx.press("x");
	await waitFor(() => env.session.leafId === homeLeaf, "rewind to homeLeaf");
	assert.ok(env.ctx.notifyOf((m) => m.includes("Side thread removed")));
	assert.equal(env.pi.activeCount(), env.pi.baselineActive, "no leaked subscriptions");
});

test("merge (m): no rewind, close marker at the leaf, thread ends", async () => {
	const env = makeEnv({ answer: "a1" });
	const p = await toPending(env, "qq", "q1");
	const leafAtAnswer = env.session.leafId!;
	env.ctx.press("m");
	await p;
	assert.ok(env.session.branch().some((e) => e.id === leafAtAnswer), "the answer stays in the branch");
	const leafEntry = env.session.branch().at(-1);
	assert.equal(leafEntry?.type, "custom", "close marker at the leaf");
	assert.equal(leafEntry?.customType, "qq", "close marker carries the label");
	assert.ok(env.ctx.notifyOf((m) => m.includes("merged")));

	// Thread ended: a NEW side question starts a fresh thread — dismissing it
	// must NOT rewind past the merged Q&A.
	const p2 = await toPending(env, "qq", "q2");
	env.ctx.press("x");
	await p2;
	await waitFor(() => !!env.session.findUserEntry("qq: q1"), "merged Q&A survives a later dismiss");
	assert.ok(!env.session.findUserEntry("qq: q2"), "only the new question was removed");
});

test("M and F are case-insensitive", async () => {
	const env = makeEnv({ answer: "a1" });
	const p = await toPending(env, "qq", "q1");
	env.ctx.press("M");
	await p;
	assert.ok(env.ctx.notifyOf((m) => m.includes("merged")));

	const p2 = await toPending(env, "qq", "q2");
	const leafAtAnswer = env.session.leafId!;
	env.ctx.press("F");
	await p2;
	assert.equal(env.session.leafId, leafAtAnswer, "F keeps the branch");
	assert.ok(env.ctx.notifyOf((m) => m.includes("follow-up")));
});

test("dismiss: printable key passes through, control key is consumed", async () => {
	const env = makeEnv({ answer: "a" });
	const p = await toPending(env, "qq", "q");
	const resPrintable = env.ctx.press("h");
	assert.equal(resPrintable[0], undefined, "printable key passes through to the editor");
	await p;

	const p2 = await toPending(env, "qq", "q2");
	const resCtrl = env.ctx.press("\u0003");
	assert.deepEqual(resCtrl[0], { consume: true }, "control key is consumed");
	await p2;
});

test("status set during PENDING and cleared after the keypress", async () => {
	const env = makeEnv({ answer: "a" });
	const p = await toPending(env, "qq", "q");
	assert.ok(
		env.ctx.statuses.some((s) => s.key === "qq" && s.status === "side answer · f follow-up · m merges · any other key dismisses the thread"),
		"status shown while pending",
	);
	env.ctx.press("x");
	await p;
	const last = [...env.ctx.statuses].reverse().find((s) => s.key === "qq");
	assert.equal(last?.status, undefined, "status cleared after keypress");
});

test("prompt note: /qq has no tools, /qqro is read-only", async () => {
	const env = makeEnv({ answer: "a" });
	await toPending(env, "qqro", "q");
	const sent = env.pi.sentMessages[0];
	assert.match(sent, /read-only tools \(read, grep, find, ls\)/);
	env.ctx.press("x");
	await waitFor(() => !isPending(env), "settled");
});

// ---------------------------------------------------------------------------
// 3. Follow-up threads (f)
// ---------------------------------------------------------------------------

test("f + follow-up + dismiss removes the WHOLE thread", async () => {
	const env = makeEnv({ answer: "a1" });
	const root = env.session.leafId!;

	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;

	const p2 = await toPending(env, "qq", "q2");
	env.ctx.press("x");
	await p2;
	await waitFor(() => env.session.leafId === root, "thread rewound to its root");

	const users = env.session.branch().filter((e) => e.message?.role === "user" && typeof e.message.content === "string");
	assert.deepEqual(users.map((e) => e.message!.content), ["main question"], "both side Q&As gone");
});

test("thread grows across multiple follow-ups, merge keeps everything in order", async () => {
	const env = makeEnv({ answer: "a" });
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;
	const p2 = await toPending(env, "qqro", "q2");
	env.ctx.press("f");
	await p2;
	const p3 = await toPending(env, "qq", "q3");
	env.ctx.press("m");
	await p3;

	const firstLines = env.session
		.branch()
		.filter((e) => e.message?.role === "user" && typeof e.message.content === "string")
		.map((e) => (e.message!.content as string).split("\n")[0]);
	assert.deepEqual(firstLines, ["main question", "qq: q1", "qqro: q2", "qq: q3"], "all three Q&As present in order");
});

test("follow-up's context includes the earlier side Q&A", async () => {
	const env = makeEnv({ answer: "the first answer" });
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;
	const leafAfterQ1 = env.session.leafId!;

	const p2 = run(env, "qq", "q2");
	await waitFor(() => env.pi.sentMessages.length === 2, "q2 sent");
	const q2Entry = env.session.findUserEntry("qq: q2");
	assert.ok(q2Entry, "q2 user entry exists");

	// q1's answer entry must be an ANCESTOR of q2 (i.e. in its context) —
	// the branch continues from exactly where q1's answer landed.
	const context = env.session.branch(q2Entry.id);
	assert.ok(context.some((e) => e.id === leafAfterQ1), "q1's answer is an ancestor of q2");
	assert.ok(
		context.some((e) => e.message?.role === "assistant" && JSON.stringify(e.message.content).includes("the first answer")),
		"q1's answer text is in q2's context",
	);
	await waitFor(() => isPending(env), "PENDING for q2");
	env.ctx.press("x");
	await p2;
});

test("real turn outside the mode absorbs the thread; next /qq starts fresh", async () => {
	const env = makeEnv({ answer: "a1" });
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;

	// A NORMAL turn lands on the branch via a path the mode does not control
	// (e.g. an rpc driver). The thread is absorbed — it can never be rewound
	// away again.
	env.session.add("message", { role: "user", content: "a real question" });
	const realAnswer = env.session.add("message", { role: "assistant", content: [{ type: "text", text: "real answer" }] });

	// The next /qq detects the absorption: FRESH thread, and the mode ends.
	const p2 = await toPending(env, "qq", "q3");
	assert.deepEqual(await submitInput(env, "x"), [], "mode ended by the absorption");
	env.ctx.press("x");
	await p2;
	await waitFor(() => env.session.leafId === realAnswer.id, "rewound only the new question");
	assert.ok(env.session.findUserEntry("qq: q1"), "absorbed Q&A stays");
	assert.ok(env.session.branch().some((e) => e.message?.content === "a real question"), "real turn stays");
});

// ---------------------------------------------------------------------------
// 4. Side-thread mode (plain text, /ro, /nvm)
// ---------------------------------------------------------------------------

test("f opens the mode: plain text runs as a labeled, in-context follow-up", async () => {
	const env = makeEnv({ answer: "a1" });
	const root = env.session.leafId!;
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;

	// The mode is visible: footer status + a custom editor (border title).
	assert.ok(env.ctx.statuses.some((s) => s.key === "qq" && s.status === "side thread — /ro toggles · /nvm leaves"));
	assert.ok(env.ctx.editorComponent, "custom editor installed in mode");

	const p2 = submitInput(env, "q2?");
	await waitFor(() => isPending(env), "PENDING for the follow-up");
	const sent = env.pi.sentMessages[1];
	assert.ok(sent.startsWith("qq: q2?"), "plain text labeled as a side question");

	env.ctx.press("x"); // dismiss → the WHOLE thread (q1 + q2) goes
	await p2;
	await waitFor(() => env.session.leafId === root, "thread rewound to its root");
	assert.equal(env.ctx.editorComponent, undefined, "editor restored after dismiss");
	assert.equal(env.pi.activeCount(), env.pi.baselineActive, "no leaked subscriptions");
});

test("/ro toggles the follow-up policy on and off (f does not reset it)", async () => {
	const env = makeEnv({ answer: "a" });
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;

	await run(env, "ro", "");
	assert.ok(env.ctx.notifyOf((m) => m.includes("read-only")));
	const p2 = submitInput(env, "q2");
	await waitFor(() => isPending(env), "PENDING for q2");
	assert.ok(env.pi.sentMessages[1].startsWith("qqro: q2"), "follow-up runs read-only");
	env.ctx.press("f"); // stay in the thread — policy must NOT reset
	await p2;

	await run(env, "ro", "");
	assert.ok(env.ctx.notifyOf((m) => m.includes("back to no tools")));
	const p3 = submitInput(env, "q3");
	await waitFor(() => isPending(env), "PENDING for q3");
	assert.ok(env.pi.sentMessages[2].startsWith("qq: q3"), "follow-up back to no tools");
	env.ctx.press("m");
	await p3;
});

test("/ro outside a side thread warns", async () => {
	const env = makeEnv();
	await run(env, "ro", "");
	assert.ok(env.ctx.notifyOf((m) => m.includes("Not in a side thread")));
});

test("/nvm drops the whole thread and returns to the main conversation", async () => {
	const env = makeEnv({ answer: "a" });
	const root = env.session.leafId!;
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;

	const p2 = submitInput(env, "q2");
	await waitFor(() => isPending(env), "PENDING for q2");
	env.ctx.press("f"); // editor free, nothing in flight
	await p2;

	await run(env, "nvm", "");
	await waitFor(() => env.session.leafId === root, "rewound to the thread root");
	assert.deepEqual(
		env.session.branch().filter((e) => e.message?.role === "user").map((e) => e.message!.content),
		["main question"],
		"both side Q&As gone",
	);
	assert.deepEqual(await submitInput(env, "back to work"), [], "mode off: plain input no longer hijacked");
	assert.equal(env.ctx.editorComponent, undefined, "editor restored");
	assert.equal(env.pi.activeCount(), env.pi.baselineActive, "no leaks");
});

test("/nvm with no thread warns and changes nothing", async () => {
	const env = makeEnv();
	await run(env, "nvm", "");
	assert.ok(env.ctx.notifyOf((m) => m.includes("No side thread")));
	assert.equal(env.pi.sentMessages.length, 0);
});

test("/nvm while a side question is in flight warns and does not rewind", async () => {
	const env = makeEnv({ answer: "a", delayMs: 80 });
	const root = env.session.leafId!;
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;

	const p2 = submitInput(env, "q2");
	await waitFor(() => env.pi.sentMessages.length === 2, "q2 sent");
	await run(env, "nvm", ""); // in flight → refuses
	assert.ok(env.ctx.notifyOf((m) => m.includes("in flight")));
	assert.notEqual(env.session.leafId, root, "nothing rewound while in flight");

	await waitFor(() => isPending(env), "PENDING for q2");
	env.ctx.press("m");
	await p2;
});

test("session_compact in mode exits the mode (thread absorbed)", async () => {
	const env = makeEnv({ answer: "a" });
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;

	env.pi.emit("session_compact", { type: "session_compact" });
	assert.deepEqual(await submitInput(env, "x"), [], "plain input no longer hijacked");
	assert.equal(env.ctx.editorComponent, undefined, "editor restored");
	assert.equal(env.pi.activeCount(), env.pi.baselineActive, "mode subscriptions cleaned up");
});

test("session_tree navigation in mode exits the mode", async () => {
	const env = makeEnv({ answer: "a" });
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;

	env.pi.emit("session_tree", { type: "session_tree", newLeafId: "e1", oldLeafId: "e2" });
	assert.deepEqual(await submitInput(env, "x"), [], "navigation ended the mode");
});

test("session_start (new/fork) in mode exits the mode", async () => {
	const env = makeEnv({ answer: "a" });
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;

	// A new session has an EMPTY branch (the old one is gone).
	const fresh = new MockSession();
	env.session = fresh;
	env.ctx.sessionManager = fresh;
	env.pi.session = fresh;
	env.pi.emit("session_start", { type: "session_start", reason: "new" });
	assert.deepEqual(await submitInput(env, "x"), [], "session change ended the mode");
});

test("extension-source input is never hijacked (recursion guard)", async () => {
	const env = makeEnv({ answer: "a" });
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;

	// Our own side messages arrive via sendUserMessage → source "extension".
	const res = await submitInput(env, "x", "extension");
	assert.deepEqual(res, [{ action: "continue" }], "extension input passes through");
	assert.equal(env.pi.sentMessages.length, 1, "nothing new was sent");

	// The mode is still active for interactive input.
	const p2 = submitInput(env, "q2");
	await waitFor(() => isPending(env), "PENDING");
	env.ctx.press("m");
	await p2;
});

test("slash input in mode passes through; the mode stays active", async () => {
	const env = makeEnv({ answer: "a" });
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;

	const res = await submitInput(env, "/xyz");
	assert.deepEqual(res, [{ action: "continue" }], "unknown command passes through");

	const p2 = submitInput(env, "q2");
	await waitFor(() => isPending(env), "PENDING");
	assert.ok(env.pi.sentMessages[1].startsWith("qq: q2"), "mode still active");
	env.ctx.press("m");
	await p2;
});

test("plain input while a side question is in flight warns and is dropped", async () => {
	const env = makeEnv({ answer: "a", delayMs: 80 });
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;

	const p2 = submitInput(env, "q2");
	await waitFor(() => env.pi.sentMessages.length === 2, "q2 sent");
	const res = await submitInput(env, "q3");
	assert.deepEqual(res, [{ action: "handled" }], "consumed, not queued");
	assert.ok(env.ctx.notifyOf((m) => m.includes("already in flight")));

	await waitFor(() => isPending(env), "PENDING for q2");
	assert.equal(env.pi.sentMessages.length, 2, "q3 never sent");
	env.ctx.press("m");
	await p2;
});

test("full mode loop: /qq → f → type → f → /ro → type → /nvm", async () => {
	const env = makeEnv({ answer: "a" });
	const root = env.session.leafId!;

	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;

	const p2 = submitInput(env, "q2");
	await waitFor(() => isPending(env), "PENDING for q2");
	env.ctx.press("f");
	await p2;

	await run(env, "ro", "");
	const p3 = submitInput(env, "q3");
	await waitFor(() => isPending(env), "PENDING for q3");
	assert.ok(env.pi.sentMessages[2].startsWith("qqro: q3"), "q3 ran read-only");
	env.ctx.press("f");
	await p3;

	await run(env, "nvm", "");
	await waitFor(() => env.session.leafId === root, "back at the thread root");
	assert.deepEqual(
		env.session.branch().filter((e) => e.message?.role === "user").map((e) => e.message!.content),
		["main question"],
		"whole thread gone",
	);
	assert.deepEqual(await submitInput(env, "back to work"), [], "mode off");
	assert.equal(env.pi.activeCount(), env.pi.baselineActive, "no leaks");
});

// ---------------------------------------------------------------------------
// 5. Mode surface (autocomplete filter, editor title)
// ---------------------------------------------------------------------------

function fakeProvider(items: { value: string; label: string; description?: string }[]) {
	return {
		triggerCharacters: ["/"],
		getSuggestions: async () => ({ items, prefix: "/" }),
		applyCompletion: (lines: string[], line: number, col: number) => ({ lines, cursorLine: line, cursorCol: col }),
	};
}

test("session_start registers the autocomplete filter exactly once", async () => {
	const env = makeEnv();
	env.pi.emit("session_start", { type: "session_start", reason: "startup" });
	env.pi.emit("session_start", { type: "session_start", reason: "new" });
	assert.equal(env.ctx.autocompleteFactories.length, 1, "wrapped once");
});

test("autocomplete hides /ro and /nvm outside the thread, /qq and /qqro inside", async () => {
	const env = makeEnv({ answer: "a" });
	env.pi.emit("session_start", { type: "session_start", reason: "startup" });
	const wrapped = env.ctx.autocompleteFactories[0](
		fakeProvider([
			{ value: "qq", label: "qq" },
			{ value: "qqro", label: "qqro" },
			{ value: "ro", label: "ro" },
			{ value: "nvm", label: "nvm" },
			{ value: "compact", label: "compact" },
		]),
	) as {
		getSuggestions(lines: string[], line: number, col: number, opts: { signal: AbortSignal }): Promise<{ items: { value: string }[]; prefix: string } | null>;
	};
	const sig = { signal: new AbortController().signal };

	// Outside the thread: /ro and /nvm hidden, the rest visible.
	let s = await wrapped.getSuggestions(["/"], 0, 1, sig);
	assert.deepEqual(s!.items.map((i) => i.value), ["qq", "qqro", "compact"]);

	// Inside the thread: /qq and /qqro hidden.
	const p = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p;
	s = await wrapped.getSuggestions(["/"], 0, 1, sig);
	assert.deepEqual(s!.items.map((i) => i.value), ["ro", "nvm", "compact"]);
});

test("the editor top border carries the side-thread title in mode only", async () => {
	const env = makeEnv({ answer: "a" });
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;

	assert.equal(env.ctx.editorComponents.length, 1, "editor swapped in");
	const factory = env.ctx.editorComponents[0] as (tui: unknown, theme: unknown, keybindings: unknown) => unknown;
	const editor = factory(
		{},
		{ borderColor: (s: string) => s, selectList: {} },
		{ matches: () => false },
	) as { renderTopBorder(w: number, h: number): string };
	const border = editor.renderTopBorder(120, 0);
	assert.ok(border.includes("qq side thread"), "border carries the mode title");
	assert.ok(border.includes("/nvm back to main"));

	await run(env, "nvm", "");
	assert.equal(env.ctx.editorComponents.at(-1), undefined, "editor restored after /nvm");
});

test("/tree away after f orphans the thread", async () => {
	const env = makeEnv({ answer: "a1" });
	const threadRoot = env.session.leafId!; // = 2nd seed entry
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;

	// Navigate to a DIFFERENT branch (thread root no longer on the active path).
	const other = env.session.add("message", { role: "user", content: "other branch" }, threadRoot);

	const p2 = await toPending(env, "qq", "q3");
	env.ctx.press("x");
	await p2;
	await waitFor(() => env.session.leafId === other.id, "only the new question removed");
	assert.ok(!env.session.branch(other.id).some((e) => e.message?.content?.toString().startsWith("qq: ")), "no side Q&A on this path");
});

// ---------------------------------------------------------------------------
// 6. Failure paths
// ---------------------------------------------------------------------------

test("no answer → auto-rewind + warning, never enters PENDING", async () => {
	const env = makeEnv({ answer: null });
	const homeLeaf = env.session.leafId!;
	await run(env, "qq", "q");
	assert.equal(env.ctx.terminal.size, 0, "no PENDING without an answer");
	await waitFor(() => env.session.leafId === homeLeaf, "auto-rewind");
	assert.ok(env.ctx.notifyOf((m) => m.includes("no answer produced")));
	assert.equal(env.pi.activeCount(), env.pi.baselineActive);
});

test("settle timeout → error, rewind, in-flight released", async () => {
	config.settleTimeoutMs = 80;
	const env = makeEnv({ answer: "a", settles: false });
	const homeLeaf = env.session.leafId!;
	await run(env, "qq", "q");
	assert.ok(env.ctx.notifyOf((m) => m.includes("timed out")));
	assert.equal(env.session.leafId, homeLeaf, "rewound after timeout");

	// In-flight released: the next /qq works.
	env.behavior.settles = true;
	const p2 = await toPending(env, "qq", "q2");
	env.ctx.press("m");
	await p2;
	assert.equal(env.pi.activeCount(), env.pi.baselineActive);
});

test("failed question mid-thread keeps the thread alive", async () => {
	const env = makeEnv({ answer: "a1" });
	const root = env.session.leafId!;
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;

	// q2 fails (no answer) → only q2 is discarded.
	env.behavior.answer = null;
	await run(env, "qq", "q2");
	await waitFor(() => !!env.session.findUserEntry("qq: q1") && !env.session.findUserEntry("qq: q2"), "q2 discarded, q1 survives");

	// Thread still alive: q3 succeeds, and dismissing it removes the WHOLE thread.
	env.behavior.answer = "a3";
	const p3 = await toPending(env, "qq", "q3");
	env.ctx.press("x");
	await p3;
	await waitFor(() => env.session.leafId === root, "whole thread rewound");
});

// ---------------------------------------------------------------------------
// 7. Queue (busy agent)
// ---------------------------------------------------------------------------

test("busy on call → queues, runs after the flow settles", async () => {
	const env = makeEnv({ answer: "a" });
	externalRun(env, { settleAfterMs: 40, answer: "external done" });

	const p = run(env, "qq", "q");
	assert.ok(env.ctx.notifyOf((m) => m.includes("queued")), "queued notification is immediate");

	await waitFor(() => isPending(env), "PENDING after the external run settled");
	const branch = env.session.branch();
	const extIdx = branch.findIndex((e) => e.message?.content === "external done");
	const qqIdx = branch.findIndex((e) => e.message?.content?.toString().startsWith("qq: "));
	assert.ok(qqIdx > extIdx, "side question ran AFTER the external flow");
	env.ctx.press("m");
	await p;
});

test("queue loop waits out a run that starts right after a settle", async () => {
	const env = makeEnv({ answer: "a" });
	externalRun(env, {
		settleAfterMs: 30,
		answer: "run1 done",
		then: () => externalRun(env, { settleAfterMs: 30, answer: "run2 done" }),
	});

	const p = run(env, "qq", "q");
	await waitFor(() => isPending(env), "PENDING only after the SECOND settle");
	const branch = env.session.branch();
	const run2Idx = branch.findIndex((e) => e.message?.content === "run2 done");
	const qqIdx = branch.findIndex((e) => e.message?.content?.toString().startsWith("qq: "));
	assert.ok(qqIdx > run2Idx, "side question ran after run2, not run1");
	env.ctx.press("m");
	await p;
});

test("queue timeout → gives up, in-flight released", async () => {
	config.queueTimeoutMs = 80;
	const env = makeEnv({ answer: "a" });
	env.ctx.idle = false; // busy forever, never settles
	await run(env, "qq", "q");
	assert.ok(env.ctx.notifyOf((m) => m.includes("gave up waiting")));
	assert.equal(env.pi.sentMessages.length, 0, "question never sent");

	// In-flight released.
	env.ctx.idle = true;
	const p2 = await toPending(env, "qq", "q2");
	env.ctx.press("m");
	await p2;
});

test("second /qq while one is in flight is rejected", async () => {
	const env = makeEnv({ answer: "a", delayMs: 60 });
	const p1 = run(env, "qq", "q1");
	await new Promise((r) => setTimeout(r, 10));
	await run(env, "qq", "q2");
	assert.ok(env.ctx.notifyOf((m) => m.includes("already in flight")));
	assert.equal(env.pi.sentMessages.length, 1, "only q1 was sent");
	await waitFor(() => isPending(env), "PENDING for q1");
	env.ctx.press("m");
	await p1;
});

// ---------------------------------------------------------------------------
// 8. Safety invariants
// ---------------------------------------------------------------------------

test("no leaked subscriptions: merge, dismiss, no-answer, and mode exit", async () => {
	// merge
	let env = makeEnv({ answer: "a" });
	let p = await toPending(env, "qq", "q");
	env.ctx.press("m");
	await p;
	await waitFor(() => env.pi.activeCount() === env.pi.baselineActive, "no leaks after merge");

	// dismiss
	env = makeEnv({ answer: "a" });
	p = await toPending(env, "qq", "q");
	env.ctx.press("x");
	await p;
	await waitFor(() => env.pi.activeCount() === env.pi.baselineActive, "no leaks after dismiss");

	// no answer
	env = makeEnv({ answer: null });
	await run(env, "qq", "q");
	await waitFor(() => env.pi.activeCount() === env.pi.baselineActive, "no leaks after no-answer");

	// side-thread mode exit via /nvm
	env = makeEnv({ answer: "a" });
	p = await toPending(env, "qq", "q");
	env.ctx.press("f");
	await p;
	await run(env, "nvm", "");
	await waitFor(() => env.pi.activeCount() === env.pi.baselineActive, "no leaks after mode exit");
});

test("compaction is cancelled during the side turn and allowed after", async () => {
	const env = makeEnv({ answer: "a", delayMs: 60 });
	const p = run(env, "qq", "q");
	await waitFor(() => env.pi.sentMessages.length === 1, "side message sent");
	const during = env.pi.emit("session_before_compact", {});
	assert.deepEqual(during, [{ cancel: true }], "compaction cancelled during the side turn");

	await waitFor(() => isPending(env), "PENDING");
	env.ctx.press("m");
	await p;
	assert.equal(env.pi.emit("session_before_compact", {}).length, 0, "handler gone after completion");
});

test("/qq blocks every tool call; /qqro allows read-only and blocks writes", async () => {
	// /qq: bash is blocked with a reason.
	let env = makeEnv({ answer: "text fallback", toolCall: "bash" });
	let p = await toPending(env, "qq", "q");
	env.ctx.press("m");
	await p;
	const blocked = env.pi.toolResults.find((r) => r?.block);
	assert.ok(blocked, "bash blocked for /qq");
	assert.match(blocked!.reason!, /no tools/);
	assert.equal(env.pi.emit("tool_call", { toolName: "bash" }).length, 0, "guardrail gone after completion");

	// /qqro: read is allowed (undefined = no interception).
	env = makeEnv({ answer: "a", toolCall: "read" });
	p = await toPending(env, "qqro", "q");
	env.ctx.press("m");
	await p;
	assert.ok(env.pi.toolResults.length >= 1 && env.pi.toolResults[0] === undefined, "read allowed for /qqro");

	// /qqro: bash is blocked with a read-only reason.
	env = makeEnv({ answer: "a", toolCall: "bash" });
	p = await toPending(env, "qqro", "q");
	env.ctx.press("m");
	await p;
	const roBlocked = env.pi.toolResults.find((r) => r?.block);
	assert.ok(roBlocked, "bash blocked for /qqro");
	assert.match(roBlocked!.reason!, /read-only/);
});

test("session replaced mid-turn → no crash, no rewind, no leak, in-flight released", async () => {
	const env = makeEnv({ answer: "a", delayMs: 60 });
	const p = run(env, "qq", "q");
	await waitFor(() => env.pi.sentMessages.length === 1, "side message sent");
	env.session.sessionId = "session-2"; // the session was swapped (/new)
	await p;
	assert.ok(!env.ctx.notifyOf((m) => m.includes("rewind failed")), "no rewind attempted");
	assert.equal(env.pi.activeCount(), env.pi.baselineActive, "no leaks");

	// In-flight released: a /qq in the new session works.
	env.behavior.delayMs = 20;
	const p2 = await toPending(env, "qq", "q2");
	env.ctx.press("m");
	await p2;
});

test("empty session → warning, no change", async () => {
	const env = makeEnv();
	env.session = new MockSession(); // no seed → no leaf
	env.ctx.sessionManager = env.session;
	env.pi.session = env.session;
	await run(env, "qq", "q");
	assert.ok(env.ctx.notifyOf((m) => m.includes("needs an existing session")));
	assert.equal(env.pi.sentMessages.length, 0);
});

test("rewind waits for idle; stuck-busy fails loud without crashing", async () => {
	// Case A: briefly busy → rewind proceeds once idle.
	let env = makeEnv({ answer: "a" });
	const homeLeaf = env.session.leafId!;
	const p = await toPending(env, "qq", "q");
	env.ctx.idle = false;
	env.ctx.press("x");
	setTimeout(() => {
		env.ctx.idle = true;
	}, 50);
	await p;
	await waitFor(() => env.session.leafId === homeLeaf, "rewound after idle");
	assert.ok(!env.ctx.notifyOf((m) => m.includes("rewind failed")));

	// Case B: stuck busy → fail-loud notification, no crash, state released.
	config.idleTimeoutMs = 60;
	env = makeEnv({ answer: "a" });
	const homeLeafB = env.session.leafId!;
	const p2 = await toPending(env, "qq", "q");
	env.ctx.idle = false; // stuck
	env.ctx.press("x");
	await p2;
	await waitFor(() => !!env.ctx.notifyOf((m) => m.includes("dismiss failed")), "fail-loud notification");
	assert.notEqual(env.session.leafId, homeLeafB, "nothing was rewound");
	assert.equal(env.pi.activeCount(), env.pi.baselineActive);
});

// ---------------------------------------------------------------------------
// 9. Preflight
// ---------------------------------------------------------------------------

test("preflight: ≥90% context warns, below does not", async () => {
	let env = makeEnv({ answer: "a" });
	env.ctx.contextUsage = { tokens: 9500, contextWindow: 10000 };
	const p = await toPending(env, "qq", "q");
	assert.ok(env.ctx.notifyOf((m) => m.includes("~95%")), "warning at 95%");
	env.ctx.press("m");
	await p;

	env = makeEnv({ answer: "a" });
	env.ctx.contextUsage = { tokens: 5000, contextWindow: 10000 };
	const p2 = await toPending(env, "qq", "q");
	assert.ok(!env.ctx.notifyOf((m) => m.includes("% of the window")), "no warning at 50%");
	env.ctx.press("m");
	await p2;
});

// ---------------------------------------------------------------------------
// 10. Resume (pi exited mid-thread → session_start re-anchors the follow-up)
// ---------------------------------------------------------------------------

test("resuming a session that ends in a side thread re-enters the mode", async () => {
	const env = makeEnv({ answer: "a1" });
	const root = env.session.leafId!;
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;
	const p2 = submitInput(env, "q2");
	await waitFor(() => isPending(env), "PENDING for q2");
	env.ctx.press("f");
	await p2;

	// Exit + resume: pi starts again on the same session file.
	env.pi.emit("session_start", { reason: "resume" });
	assert.notEqual(env.ctx.editorComponent, undefined, "mode re-entered");
	assert.ok(env.ctx.notifyOf((m) => m.includes("Resumed the side thread")));

	// The follow-up is resumed: plain text is the next side question, same thread.
	const p3 = submitInput(env, "q3");
	await waitFor(() => isPending(env), "PENDING for q3");
	assert.ok((env.pi.sentMessages.at(-1) ?? "").startsWith("qq: q3"));

	// Dismissing drops the WHOLE thread (q1, q2, q3) back to its root.
	env.ctx.press("x");
	await p3;
	await waitFor(() => env.session.leafId === root, "dropped back to the thread root");
	assert.equal(env.ctx.editorComponent, undefined, "mode off");
	assert.equal(env.pi.activeCount(), env.pi.baselineActive, "no leaks");
});

test("resume does NOT re-open a MERGED thread (close marker at the leaf)", async () => {
	const env = makeEnv({ answer: "a1" });
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("m"); // merge → close marker appended
	await p1;
	env.pi.emit("session_start", { reason: "resume" });
	assert.equal(env.ctx.editorComponent, undefined, "no mode: the thread was merged");
	assert.deepEqual(await submitInput(env, "hello"), [], "plain input not hijacked");
});

test("resume does NOT re-open an ABSORBED thread (normal message after the Q&A)", async () => {
	const env = makeEnv({ answer: "a1" });
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;
	// A normal message landed via another path (rpc) — it absorbs the thread.
	env.session.add("message", { role: "user", content: "back to work" });
	env.session.add("message", { role: "assistant", content: [{ type: "text", text: "ok" }] });
	env.pi.emit("session_start", { reason: "resume" });
	assert.equal(env.ctx.editorComponent, undefined, "no mode");
	assert.deepEqual(await submitInput(env, "hello"), [], "plain input not hijacked");
});

test("resume with an UNANSWERED trailing question restores the thread without the mode", async () => {
	const env = makeEnv({ answer: "a1" });
	const root = env.session.leafId!;
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;
	// Exited while the follow-up was still streaming: marker + question, no answer.
	env.pi.appendEntry("qq", { question: "q2" });
	env.session.add("message", { role: "user", content: "qq: q2\n\n(note)" });
	env.pi.emit("session_start", { reason: "resume" });
	assert.equal(env.ctx.editorComponent, undefined, "no mode (nothing to follow up on)");
	assert.ok(env.ctx.notifyOf((m) => m.includes("without an answer")));
	// /nvm can still drop the whole thread.
	await run(env, "nvm", "");
	await waitFor(() => env.session.leafId === root, "dropped back to the thread root");
});

test("resume of a plain session (no side markers) does nothing", async () => {
	const env = makeEnv();
	env.pi.emit("session_start", { reason: "resume" });
	assert.equal(env.ctx.editorComponent, undefined);
	assert.deepEqual(await submitInput(env, "hello"), [], "plain input not hijacked");
});

// ---------------------------------------------------------------------------
// 11. Patched core (this branch): pruneBranches self-patch + drop ladder
// ---------------------------------------------------------------------------

test("installSessionPrune installs on the exact pinned pi version", () => {
	const status = installSessionPrune();
	assert.equal(status.installed, true, `install failed: ${status.reason}`);
	assert.equal(typeof (SessionManager.prototype as unknown as { pruneBranches?: unknown }).pruneBranches, "function");
});

test("installSessionPrune is idempotent (an existing method is never overridden)", () => {
	installSessionPrune();
	const status = installSessionPrune();
	assert.equal(status.installed, true);
	assert.equal(status.native, true, "second run sees the method and stands down");
});

test("installSessionPrune refuses a version mismatch", () => {
	const prev = config.patchTargetPiVersion;
	config.patchTargetPiVersion = "9.9.9";
	try {
		const status = installSessionPrune();
		assert.equal(status.installed, false);
		assert.match(status.reason ?? "", /9\.9\.9/);
	} finally {
		config.patchTargetPiVersion = prev;
	}
});

test("pruneBranches keeps only root→target, re-pins the leaf, and rewrites the file", () => {
	installSessionPrune();
	const dir = mkdtempSync(join(tmpdir(), "qq-prune-"));
	try {
		const sm = SessionManager.create("/tmp", dir);
		const user = sm.appendMessage({ role: "user", content: "main q", timestamp: Date.now() });
		const a = sm.appendCustomEntry("a");
		const b = sm.appendCustomEntry("b"); // the side-thread node (to be pruned)
		sm.branch(a); // leaf back to a — like a dismissed /qq
		const c = sm.appendCustomEntry("c"); // mainline continues
		// Prune keeping root→a (the thread root), NOT the current leaf:
		const removed = (sm as unknown as { pruneBranches: (keepLeafId?: string) => number }).pruneBranches(a);
		assert.equal(removed, 2, "b and c removed (c was off the kept path)");
		assert.equal(sm.getEntry(b), undefined, "thread node gone from the index");
		assert.equal(sm.getEntry(c), undefined, "post-leaf entry gone");
		assert.ok(sm.getEntry(a), "kept path intact");
		assert.equal(sm.getLeafId(), a, "leaf re-pinned to the target");
		// The FILE on disk was actually rewritten and reopens cleanly:
		const file = sm.getSessionFile()!;
		const lines = readFileSync(file, "utf8").trim().split("\n").length;
		assert.equal(lines, 1 + sm.getEntryCount(), "disk matches in-memory state");
		const reopened = SessionManager.open(file);
		assert.equal(reopened.getEntry(b), undefined, "thread node gone from disk");
		assert.equal(reopened.getLeafId(), a, "leaf persisted");
		assert.ok(reopened.getEntry(user), "mainline intact on reopen");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("dismiss PRUNES the thread when the patch is available (no fork, no rewind)", async () => {
	const env = makeEnv({ answer: "42" });
	const homeLeaf = env.session.leafId!;
	env.session.pruneBranches = (id) => env.session.pruneSim(id); // simulate patched pi
	await toPending(env, "qq", "q?");
	env.ctx.press("x");
	await waitFor(() => !!env.ctx.notifyOf((m) => m.includes("Side thread removed from the session")), "prune notice");
	assert.deepEqual(env.session.pruneCalls, [homeLeaf], "pruned to the thread root");
	assert.equal(env.session.leafId, homeLeaf);
	assert.deepEqual(env.ctx.navigatedTo, [], "no rewind");
	assert.equal(env.ctx.forkCalls.length, 0, "no fork");
	assert.equal(env.pi.activeCount(), env.pi.baselineActive, "no leaks");
});

test("dismiss FORKS when the patch is absent but ctx.fork exists (no rewind)", async () => {
	const env = makeEnv({ answer: "42" });
	const homeLeaf = env.session.leafId!;
	env.ctx.installForkSim(); // unpatched pi ≥ 0.69
	await toPending(env, "qq", "q?");
	env.ctx.press("x");
	await waitFor(() => env.ctx.forkCalls.length === 1, "fork called");
	assert.equal(env.ctx.forkCalls[0].entryId, homeLeaf, "forks at the thread root");
	assert.equal(env.ctx.forkCalls[0].options?.position, "at");
	assert.equal(env.ctx.forkReplacedNotifs.length, 1, "success notice via withSession (old ctx is stale)");
	assert.deepEqual(env.ctx.navigatedTo, [], "no rewind");
	assert.deepEqual(env.session.pruneCalls, [], "no prune");
});

test("dismiss REWINDS when neither patch nor fork is available (baseline)", async () => {
	const env = makeEnv({ answer: "42" });
	const homeLeaf = env.session.leafId!;
	await toPending(env, "qq", "q?"); // unpatched pre-0.69 pi: no prune, no fork on the mock
	env.ctx.press("x");
	await waitFor(() => env.session.leafId === homeLeaf, "rewind to homeLeaf");
	assert.deepEqual(env.ctx.navigatedTo, [homeLeaf]);
	assert.ok(env.ctx.notifyOf((m) => m.includes("Side thread removed from the conversation")));
});

test("/nvm PRUNES the whole thread when the patch is available", async () => {
	const env = makeEnv({ answer: "a" });
	const root = env.session.leafId!;
	env.session.pruneBranches = (id) => env.session.pruneSim(id);
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;
	const p2 = submitInput(env, "q2");
	await waitFor(() => isPending(env), "PENDING for q2");
	env.ctx.press("f");
	await p2;
	await run(env, "nvm", "");
	await waitFor(() => !!env.ctx.notifyOf((m) => m.includes("Side thread removed from the session")), "prune notice");
	assert.deepEqual(env.session.pruneCalls, [root], "whole thread pruned to the root");
	assert.deepEqual(
		env.session.branch().filter((e) => e.message?.role === "user").map((e) => e.message!.content),
		["main question"],
		"both side Q&As gone",
	);
});
