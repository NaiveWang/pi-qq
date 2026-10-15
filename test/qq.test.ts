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
 * 10. Resume (pi exited mid-thread → session_start re-anchors the follow-up)
 * 11. True deletion: pruneBranches self-patch + drop ladder
 * 12. Sub-threads (/sub) and /merge — in-session grouping; drop/merge are
 *     always session-wide (initial /qq + follow-ups + sub-threads)
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { config, detectSideThreadRoot, installSessionPrune } from "../extensions/qq.ts";
import { makeEnv, run, waitFor, externalRun, isPending, submitInput, type Env } from "./mock.ts";
import { MockSession, mkUsage } from "./types.ts";

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

test("registers /qq, /qqro and /nvm as commands; /ro, /sub, /merge are input-level (mode-scoped), not commands", () => {
	const env = makeEnv();
	for (const name of ["qq", "qqro", "nvm"]) assert.ok(env.pi.commands.has(name), `/${name} registered`);
	for (const name of ["ro", "sub", "merge"]) assert.ok(!env.pi.commands.has(name), `/${name} NOT a registered command`);
	assert.match(env.pi.commands.get("qq")!.description, /f follow-up/);
	assert.match(env.pi.commands.get("qqro")!.description, /read-only/);
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
	env.ctx.press("d");
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
	env.ctx.press("d");
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

test("other keys are swallowed and the gate STAYS armed (no accidental dismiss)", async () => {
	const env = makeEnv({ answer: "a" });
	const homeLeaf = env.session.leafId!;
	const p = await toPending(env, "qq", "q");
	const answerLeaf = env.session.leafId!;
	assert.notEqual(answerLeaf, homeLeaf, "the side answer advanced the leaf");

	// A stray printable key: consumed, thread NOT dismissed, gate still armed.
	const res1 = env.ctx.press("h");
	assert.deepEqual(res1[0], { consume: true }, "stray printable key is consumed");
	assert.equal(env.session.leafId, answerLeaf, "stray key did NOT dismiss the thread");
	assert.ok(isPending(env), "gate still armed after a stray key");

	// A stray control key: also consumed, still armed.
	const res2 = env.ctx.press("\u0003");
	assert.deepEqual(res2[0], { consume: true }, "stray control key is consumed");
	assert.equal(env.session.leafId, answerLeaf, "still not dismissed");
	assert.ok(isPending(env), "gate still armed");

	// The gate is still armed: an explicit d now dismisses. Wait for the
	// success notice (emitted AFTER the rewind completes) so both the leaf
	// update and the notification are done — waiting on the leaf alone races
	// with the fire-and-forget drop.
	env.ctx.press("d");
	await p;
	await waitFor(
		() => !!env.ctx.notifyOf((m) => m.includes("Side thread removed")),
		"dismiss success notice",
	);
	assert.equal(env.session.leafId, homeLeaf, "d rewound to homeLeaf");
	assert.equal(env.pi.activeCount(), env.pi.baselineActive, "no leaked subscriptions");
});

test("status set during PENDING and cleared after the keypress", async () => {
	const env = makeEnv({ answer: "a" });
	const p = await toPending(env, "qq", "q");
	assert.ok(
		env.ctx.statuses.some((s) => s.key === "qq" && s.status === "side answer · f follow-up · m merges · d dismisses (other keys ignored)"),
		"status shown while pending",
	);
	env.ctx.press("d");
	await p;
	const last = [...env.ctx.statuses].reverse().find((s) => s.key === "qq");
	assert.equal(last?.status, undefined, "status cleared after keypress");
});

test("prompt note: /qq has no tools, /qqro is read-only", async () => {
	const env = makeEnv({ answer: "a" });
	await toPending(env, "qqro", "q");
	const sent = env.pi.sentMessages[0];
	assert.match(sent, /read-only tools \(read, grep, find, ls\)/);
	env.ctx.press("d");
	await waitFor(() => !isPending(env), "settled");
});

// ---------------------------------------------------------------------------
// 3. Follow-up threads (f)
// ---------------------------------------------------------------------------

test("follow-up in mode has NO keypress gate: the next plain text is the next follow-up", async () => {
	const env = makeEnv({ answer: "a1" });
	const root = env.session.leafId!;

	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;

	// The follow-up's answer STAYS on the branch — no keypress to press.
	// (Previously this armed the m/f/dismiss gate: the first character you
	// typed would have dropped the whole thread, and "f" was expected.)
	const p2 = submitInput(env, "q2");
	await waitFor(() => env.pi.sentMessages.length === 2, "q2 sent");
	await p2;
	assert.equal(isPending(env), false, "no keypress gate in mode");

	// Typing immediately runs the NEXT follow-up — no /qq, no keypress.
	const p3 = submitInput(env, "q3");
	await waitFor(() => env.pi.sentMessages.length === 3, "q3 sent");
	assert.ok((env.pi.sentMessages.at(-1) ?? "").startsWith("qq: q3"), "q3 ran as a side question");
	await p3;
	assert.notEqual(env.session.leafId, root, "thread still alive after two follow-ups");

	// In mode, /nvm is what ends the thread: the WHOLE thing goes.
	await submitInput(env, "/nvm");
	await waitFor(() => env.session.leafId === root, "thread dropped to its root");
	const users = env.session.branch().filter((e) => e.message?.role === "user" && typeof e.message.content === "string");
	assert.deepEqual(users.map((e) => e.message!.content), ["main question"], "all side Q&As gone");
});

test("thread grows across multiple follow-ups; a real turn absorbs it in order", async () => {
	const env = makeEnv({ answer: "a" });
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;
	// In a live thread /qq and /qqro are hidden (and declined if typed) —
	// follow-ups are plain text; /ro steers the label to qqro.
	await submitInput(env, "/ro");
	const p2 = submitInput(env, "q2");
	await waitFor(() => env.pi.sentMessages.length === 2, "q2 sent");
	await p2; // no keypress in mode — the answer stays
	await submitInput(env, "/ro"); // toggle back to no-tools
	const p3 = submitInput(env, "q3");
	await waitFor(() => env.pi.sentMessages.length === 3, "q3 sent");
	await p3;

	// A real (unlabeled) turn lands — it absorbs the whole thread, in order.
	env.session.add("message", { role: "user", content: "real question" });
	env.session.add("message", { role: "assistant", content: [{ type: "text", text: "real answer" }] });

	const firstLines = env.session
		.branch()
		.filter((e) => e.message?.role === "user" && typeof e.message.content === "string")
		.map((e) => (e.message!.content as string).split("\n")[0]);
	assert.deepEqual(
		firstLines,
		["main question", "qq: q1", "qqro: q2", "qq: q3", "real question"],
		"all three Q&As present, in order, then the real turn",
	);
	// The mode is over (the thread was absorbed): plain text goes to main.
	assert.equal(await submitInput(env, "back to work"), "message", "mode ended by the absorption");
});

test("follow-up's context includes the earlier side Q&A", async () => {
	const env = makeEnv({ answer: "the first answer" });
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;
	const leafAfterQ1 = env.session.leafId!;

	const p2 = submitInput(env, "q2");
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
	await p2; // no keypress in mode — the answer (and the thread) stays
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
	env.ctx.press("d"); // dismiss the q3 probe
	await p2;
	await waitFor(() => env.session.leafId === realAnswer.id, "rewound only the new question");
	assert.ok(env.session.findUserEntry("qq: q1"), "absorbed Q&A stays");
	assert.ok(env.session.branch().some((e) => e.message?.content === "a real question"), "real turn stays");

	// The mode is over: plain input is no longer hijacked. (During PENDING
	// the editor is not deliverable — the terminal owns the input — so this
	// is checked AFTER the keypress.)
	assert.equal(await submitInput(env, "back to work"), "message", "mode ended by the absorption");
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
	assert.ok(env.ctx.statuses.some((s) => s.key === "qq" && s.status === "side thread — /ro toggles · /sub sub-thread · /merge to main · /nvm back"));
	assert.ok(env.ctx.editorComponent, "custom editor installed in mode");

	const p2 = submitInput(env, "q2?");
	await waitFor(() => env.pi.sentMessages.length === 2, "follow-up sent");
	const sent = env.pi.sentMessages[1];
	assert.ok(sent.startsWith("qq: q2?"), "plain text labeled as a side question");
	await p2; // the answer STAYS on the branch (no keypress in mode)

	await submitInput(env, "/nvm"); // → the WHOLE thread (q1 + q2) goes
	await waitFor(() => env.session.leafId === root, "thread rewound to its root");
	assert.equal(env.ctx.editorComponent, undefined, "editor restored after /nvm");
	assert.equal(env.pi.activeCount(), env.pi.baselineActive, "no leaked subscriptions");
});

test("/ro toggles the follow-up policy on and off (follow-ups do not reset it)", async () => {
	const env = makeEnv({ answer: "a" });
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;

	await submitInput(env, "/ro");
	assert.ok(env.ctx.notifyOf((m) => m.includes("read-only")));
	const p2 = submitInput(env, "q2");
	await waitFor(() => env.pi.sentMessages.length === 2, "q2 sent");
	assert.ok(env.pi.sentMessages[1].startsWith("qqro: q2"), "follow-up runs read-only");
	await p2; // no keypress in mode — the policy must NOT reset

	await submitInput(env, "/ro");
	assert.ok(env.ctx.notifyOf((m) => m.includes("back to no tools")));
	const p3 = submitInput(env, "q3");
	await waitFor(() => env.pi.sentMessages.length === 3, "q3 sent");
	assert.ok(env.pi.sentMessages[2].startsWith("qq: q3"), "follow-up back to no tools");
	await p3;
});

test("/ro outside a side thread is NOT a command (passes through as a message)", async () => {
	const env = makeEnv();
	assert.equal(await submitInput(env, "/ro"), "message", "not consumed, not a registered command");
	assert.equal(env.ctx.notifs.length, 0, "no warning — it just goes to the model");
});

test("/nvm drops the whole thread and returns to the main conversation", async () => {
	const env = makeEnv({ answer: "a" });
	const root = env.session.leafId!;
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;

	const p2 = submitInput(env, "q2");
	await waitFor(() => env.pi.sentMessages.length === 2, "q2 sent");
	await p2; // the answer stays (no keypress in mode)

	await submitInput(env, "/nvm");
	await waitFor(() => env.session.leafId === root, "rewound to the thread root");
	assert.deepEqual(
		env.session.branch().filter((e) => e.message?.role === "user").map((e) => e.message!.content),
		["main question"],
		"both side Q&As gone",
	);
	assert.equal(await submitInput(env, "back to work"), "message", "mode off: plain input no longer hijacked");
	assert.equal(env.ctx.editorComponent, undefined, "editor restored");
	assert.equal(env.pi.activeCount(), env.pi.baselineActive, "no leaks");
});

test("/nvm with no thread is a command that passes through as a message", async () => {
	const env = makeEnv();
	assert.equal(await submitInput(env, "/nvm"), "command", "a registered command");
	assert.ok(
		env.pi.sentMessages.includes("/nvm"),
		"outside a side thread it is re-sent to the model as a plain message",
	);
});

test("REGRESSION: input-event ctx has NO navigateTree (command ctx does) — why /nvm must be a command", async () => {
	const env = makeEnv();
	// Capture the context an ACTUAL input handler receives via the dispatch.
	// Faithful to pi: the input-event context (createContext) lacks
	// navigateTree; only the command context (createCommandContext) has it.
	// The mock enforces this so /nvm (a command) can never regress into an
	// input handler that crashes with "ctx.navigateTree is not a function".
	const captured: { ctx?: { navigateTree?: unknown } } = {};
	env.pi.on(
		"input",
		((_e: unknown, ctx: unknown) => {
			captured.ctx = ctx as { navigateTree?: unknown };
			return { action: "continue" };
		}) as unknown as (event: unknown) => unknown,
	);
	await submitInput(env, "probe");
	assert.equal(captured.ctx?.navigateTree, undefined, "the dispatched input ctx has NO navigateTree");
	assert.equal(typeof env.ctx.navigateTree, "function", "the command ctx HAS navigateTree");
});

test("/nvm while a side question is in flight warns and does not rewind", async () => {
	const env = makeEnv({ answer: "a", delayMs: 80 });
	const root = env.session.leafId!;
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;

	const p2 = submitInput(env, "q2");
	await waitFor(() => env.pi.sentMessages.length === 2, "q2 sent");
	await submitInput(env, "/nvm"); // in flight → refuses
	assert.ok(env.ctx.notifyOf((m) => m.includes("in flight")));
	assert.notEqual(env.session.leafId, root, "nothing rewound while in flight");

	await p2; // q2's answer settles — it stays (no keypress in mode)
});

test("session_compact in mode exits the mode (thread absorbed)", async () => {
	const env = makeEnv({ answer: "a" });
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;

	env.pi.emit("session_compact", { type: "session_compact" });
	assert.equal(await submitInput(env, "x"), "message", "plain input no longer hijacked");
	assert.equal(env.ctx.editorComponent, undefined, "editor restored");
	assert.equal(env.pi.activeCount(), env.pi.baselineActive, "mode subscriptions cleaned up");
});

test("session_tree navigation in mode exits the mode", async () => {
	const env = makeEnv({ answer: "a" });
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;

	env.pi.emit("session_tree", { type: "session_tree", newLeafId: "e1", oldLeafId: "e2" });
	assert.equal(await submitInput(env, "x"), "message", "navigation ended the mode");
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
	assert.equal(await submitInput(env, "x"), "message", "session change ended the mode");
});

test("extension-source input is never hijacked (recursion guard)", async () => {
	const env = makeEnv({ answer: "a" });
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;

	// Our own side messages arrive via sendUserMessage → source "extension".
	const res = await submitInput(env, "x", "extension");
	assert.equal(res, "message", "extension input passes through");
	assert.equal(env.pi.sentMessages[1], "x", "NOT hijacked into a side question");

	// A real (unlabeled) turn landed: the thread is absorbed, so the next
	// interactive input is a real message too — the mode cannot outlive
	// its thread.
	assert.equal(await submitInput(env, "q2"), "message", "absorbed thread: mode over");
});

test("/qq inside a live thread is hidden AND not dispatched", async () => {
	const env = makeEnv({ answer: "a" });
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;

	assert.equal(await submitInput(env, "/qq"), "command", "dispatched, but the handler declines in-mode");
	assert.ok(env.ctx.notifyOf((m) => m.includes("Already in the side thread")));
	assert.equal(env.pi.sentMessages.length, 1, "nothing new sent");

	// The mode is still active for plain input.
	const p2 = submitInput(env, "q2");
	await waitFor(() => env.pi.sentMessages.length === 2, "q2 sent");
	assert.ok((env.pi.sentMessages.at(-1) ?? "").startsWith("qq: q2"), "plain input is the follow-up");
	await p2;
});

test("unknown slash input in mode becomes a real message (absorbs the thread)", async () => {
	const env = makeEnv({ answer: "a" });
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;

	const res = await submitInput(env, "/xyz");
	assert.equal(res, "message", "unknown command passes through to the model");

	// A real turn landed: the thread is absorbed, the mode is over.
	assert.equal(await submitInput(env, "q2"), "message", "mode over after absorption");
});

test("plain input while a side question is in flight warns and is dropped", async () => {
	const env = makeEnv({ answer: "a", delayMs: 80 });
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;

	const p2 = submitInput(env, "q2");
	await waitFor(() => env.pi.sentMessages.length === 2, "q2 sent");
	const res = await submitInput(env, "q3");
	assert.equal(res, "consumed", "consumed, not queued");
	assert.ok(env.ctx.notifyOf((m) => m.includes("already in flight")));

	await p2; // q2's answer settles — it stays (no keypress in mode)
	assert.equal(env.pi.sentMessages.length, 2, "q3 never sent");
});

test("full mode loop: /qq → f → type → /ro → type → /nvm", async () => {
	const env = makeEnv({ answer: "a" });
	const root = env.session.leafId!;

	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;

	const p2 = submitInput(env, "q2");
	await waitFor(() => env.pi.sentMessages.length === 2, "q2 sent");
	await p2; // no keypress in mode

	await submitInput(env, "/ro");
	const p3 = submitInput(env, "q3");
	await waitFor(() => env.pi.sentMessages.length === 3, "q3 sent");
	assert.ok(env.pi.sentMessages[2].startsWith("qqro: q3"), "q3 ran read-only");
	await p3;

	await submitInput(env, "/nvm");
	await waitFor(() => env.session.leafId === root, "back at the thread root");
	assert.deepEqual(
		env.session.branch().filter((e) => e.message?.role === "user").map((e) => e.message!.content),
		["main question"],
		"whole thread gone",
	);
	assert.equal(await submitInput(env, "back to work"), "message", "mode off");
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

test("autocomplete hides /qq and /qqro inside the thread (/ro, /nvm are not commands)", async () => {
	const env = makeEnv({ answer: "a" });
	env.pi.emit("session_start", { type: "session_start", reason: "startup" });
	const wrapped = env.ctx.autocompleteFactories[0](
		// pi's provider only lists REGISTERED commands — /ro and /nvm are
		// not among them (the input handler owns them instead).
		fakeProvider([
			{ value: "qq", label: "qq" },
			{ value: "qqro", label: "qqro" },
			{ value: "compact", label: "compact" },
		]),
	) as {
		getSuggestions(lines: string[], line: number, col: number, opts: { signal: AbortSignal }): Promise<{ items: { value: string }[]; prefix: string } | null>;
	};
	const sig = { signal: new AbortController().signal };

	// Outside the thread: everything registered is visible.
	let s = await wrapped.getSuggestions(["/"], 0, 1, sig);
	assert.deepEqual(s!.items.map((i) => i.value), ["qq", "qqro", "compact"]);

	// Inside the thread: /qq and /qqro hidden.
	const p = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p;
	s = await wrapped.getSuggestions(["/"], 0, 1, sig);
	assert.deepEqual(s!.items.map((i) => i.value), ["compact"]);
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
	assert.ok(border.includes("/sub sub-thread"));
	assert.ok(border.includes("/merge to main"));
	assert.ok(border.includes("/nvm back"));

	await submitInput(env, "/nvm");
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
	env.ctx.press("d");
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

test("activity-aware settle timeout: a long streaming answer survives past the fixed deadline", async () => {
	// The run streams for 450ms (3x the 150ms deadline) but emits a
	// message_update every 30ms. The activity-aware timer re-arms on each
	// update, so it settles cleanly instead of timing out at 150ms.
	config.settleTimeoutMs = 150;
	const env = makeEnv({ answer: "long answer", stream: { everyMs: 30, totalMs: 450 } });
	const homeLeaf = env.session.leafId!;
	await toPending(env, "qq", "q");
	assert.ok(!env.ctx.notifyOf((m) => m.includes("timed out")), "no timeout despite total > deadline");
	assert.ok(env.ctx.notifyOf((m) => m.includes("side answer ready")), "reached PENDING (answer delivered)");

	// Clean up: dismiss (rewinds to homeLeaf), confirm no leaked subscriptions.
	env.ctx.press("d");
	await waitFor(
		() => env.session.leafId === homeLeaf && !!env.ctx.notifyOf((m) => m.includes("Side thread removed")),
		"dismissed",
	);
	assert.equal(env.pi.activeCount(), env.pi.baselineActive, "no leaked subscriptions");
});

test("failed question mid-thread keeps the thread alive", async () => {
	const env = makeEnv({ answer: "a1" });
	const root = env.session.leafId!;
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;

	// q2 fails (no answer) → only q2 is discarded.
	env.behavior.answer = null;
	await submitInput(env, "q2");
	await waitFor(() => !!env.session.findUserEntry("qq: q1") && !env.session.findUserEntry("qq: q2"), "q2 discarded, q1 survives");

	// Thread still alive: q3 succeeds, and /nvm removes the WHOLE thread.
	env.behavior.answer = "a3";
	const p3 = submitInput(env, "q3");
	await waitFor(() => !!env.session.findUserEntry("qq: q3"), "q3 sent");
	await p3;

	await submitInput(env, "/nvm");
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
	env.ctx.press("d");
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
	await submitInput(env, "/nvm");
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
	env.ctx.press("d");
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
	env.ctx.press("d");
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
	await waitFor(() => env.pi.sentMessages.length === 2, "q2 sent");
	await p2; // the answer stays (no keypress in mode)

	// Exit + resume: pi starts again on the same session file.
	env.pi.emit("session_start", { reason: "resume" });
	assert.notEqual(env.ctx.editorComponent, undefined, "mode re-entered");
	assert.ok(env.ctx.notifyOf((m) => m.includes("Resumed the side thread")));

	// The follow-up is resumed: plain text is the next side question, same thread.
	const p3 = submitInput(env, "q3");
	await waitFor(() => !!env.session.findUserEntry("qq: q3"), "q3 sent");
	assert.ok((env.pi.sentMessages.at(-1) ?? "").startsWith("qq: q3"));
	await p3; // q3's answer settles — it stays (no keypress in mode)

	// /nvm drops the WHOLE thread (q1, q2, q3) back to its root.
	await submitInput(env, "/nvm");
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
	assert.equal(await submitInput(env, "hello"), "message", "plain input not hijacked");
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
	assert.equal(await submitInput(env, "hello"), "message", "plain input not hijacked");
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
	await submitInput(env, "/nvm");
	await waitFor(() => env.session.leafId === root, "dropped back to the thread root");
});

test("resume of a plain session (no side markers) does nothing", async () => {
	const env = makeEnv();
	env.pi.emit("session_start", { reason: "resume" });
	assert.equal(env.ctx.editorComponent, undefined);
	assert.equal(await submitInput(env, "hello"), "message", "plain input not hijacked");
});

// ---------------------------------------------------------------------------
// 11. True deletion: pruneBranches self-patch + drop ladder
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
	const prev = config.patchTargetPiVersions;
	config.patchTargetPiVersions = ["9.9.9"];
	try {
		const status = installSessionPrune();
		assert.equal(status.installed, false);
		assert.match(status.reason ?? "", /9\.9\.9/);
	} finally {
		config.patchTargetPiVersions = prev;
	}
});

test("installSessionPrune allowlist covers both verified pi versions", () => {
	// 1.1.0 and 1.2.0 have byte-identical SessionManager, so both are safe
	// patch targets. Guard the allowlist so a future edit doesn't silently
	// drop one of them.
	for (const v of ["1.1.0", "1.2.0"]) {
		assert.ok(config.patchTargetPiVersions.includes(v), `allowlist missing ${v}`);
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
	env.ctx.press("d");
	await waitFor(() => !!env.ctx.notifyOf((m) => m.includes("Side thread removed from the session")), "prune notice");
	assert.deepEqual(env.session.pruneCalls, [homeLeaf], "pruned to the thread root");
	assert.equal(env.session.leafId, homeLeaf);
	assert.deepEqual(env.ctx.navigatedTo, [], "no rewind");
	assert.equal(env.ctx.forkCalls.length, 0, "no fork");
	assert.equal(env.pi.activeCount(), env.pi.baselineActive, "no leaks");
});

test("dismiss PRUNE preserves the side thread's billed usage (still counts in the stats)", async () => {
	// The side answer bills 50 tokens; the seeded main answer bills 100.
	const env = makeEnv({ answer: "42", usage: mkUsage(30, 20) });
	const homeLeaf = env.session.leafId!;
	env.session.pruneBranches = (id) => env.session.pruneSim(id); // simulate patched pi
	await toPending(env, "qq", "q?");
	env.ctx.press("d");
	await waitFor(() => !!env.ctx.notifyOf((m) => m.includes("Side thread removed from the session")), "prune notice");

	// The side answer is physically gone ...
	const sideAnswer = [...env.session.entries.values()].find(
		(e) => e.type === "message" && e.message?.role === "assistant" && (e.message?.content as { type: string; text?: string }[]).some((c) => c.text === "42"),
	);
	assert.equal(sideAnswer, undefined, "side answer pruned from the file");

	// ... but its billed usage is preserved as a `usage` entry at the branch point.
	const preserved = [...env.session.entries.values()].find((e) => e.type === "usage" && e.usage);
	assert.ok(preserved, "a usage entry survived the prune");
	assert.equal(preserved!.usage!.totalTokens, 50, "preserved the side thread's 50 tokens");
	assert.equal(preserved!.parentId, homeLeaf, "anchored at the branch point");
	assert.equal(env.session.leafId, preserved!.id, "leaf re-pinned to the preserved usage entry");

	// The session stats (sum of all entries' usage) still see main (100) + preserved side (50).
	let total = 0;
	for (const e of env.session.entries.values()) {
		if (e.type === "message" && e.message?.role === "assistant" && e.message.usage) total += e.message.usage.totalTokens;
		else if (e.type === "usage" && e.usage) total += e.usage.totalTokens;
	}
	assert.equal(total, 150, "main (100) + preserved side (50) still count");
});

test("dismiss REWINDS in place when the patch is absent — even if ctx.fork exists (never fork)", async () => {
	const env = makeEnv({ answer: "42" });
	const homeLeaf = env.session.leafId!;
	env.ctx.installForkSim(); // ctx.fork EXISTS but must not be used —
	// a fork would create a duplicate session file in /resume per dismiss.
	await toPending(env, "qq", "q?");
	env.ctx.press("d");
	await waitFor(() => env.session.leafId === homeLeaf, "rewound to homeLeaf");
	assert.deepEqual(env.ctx.navigatedTo, [homeLeaf], "plain in-place rewind");
	assert.equal(env.ctx.forkCalls.length, 0, "NEVER forks");
	assert.equal(env.ctx.forkReplacedNotifs.length, 0);
	assert.deepEqual(env.session.pruneCalls, [], "no prune");
	assert.ok(env.ctx.notifyOf((m) => m.includes("true deletion is unavailable")), "one-time fallback notice");
	assert.ok(env.ctx.notifyOf((m) => m.includes("Side thread removed from the conversation")));
});

test("dismiss REWINDS when neither patch nor fork is available (baseline)", async () => {
	const env = makeEnv({ answer: "42" });
	const homeLeaf = env.session.leafId!;
	await toPending(env, "qq", "q?"); // unpatched pi: no prune on the mock
	env.ctx.press("d");
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
	await waitFor(() => env.pi.sentMessages.length === 2, "q2 sent");
	await p2; // no keypress in mode
	await submitInput(env, "/nvm");
	await waitFor(() => !!env.ctx.notifyOf((m) => m.includes("Side thread removed from the session")), "prune notice");
	assert.deepEqual(env.session.pruneCalls, [root], "whole thread pruned to the root");
	assert.deepEqual(
		env.session.branch().filter((e) => e.message?.role === "user").map((e) => e.message!.content),
		["main question"],
		"both side Q&As gone",
	);
});

// ---------------------------------------------------------------------------
// 12. Sub-threads (/sub) and /merge — in-session grouping, session-wide
//     drop/merge
// ---------------------------------------------------------------------------

/** Drive: /qq q1 → f → q2 → /sub → q3 (a thread with one sub-thread). */
async function toSubThread(env: Env): Promise<void> {
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;
	const p2 = submitInput(env, "q2");
	await waitFor(() => env.pi.sentMessages.length === 2, "q2 sent");
	await p2;
	await submitInput(env, "/sub");
	const p3 = submitInput(env, "q3");
	await waitFor(() => env.pi.sentMessages.length === 3, "q3 sent");
	await p3;
}

test("/sub starts a sub-thread: boundary marker, depth in status and title, session continues", async () => {
	const env = makeEnv({ answer: "a" });
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;
	const p2 = submitInput(env, "q2");
	await waitFor(() => env.pi.sentMessages.length === 2, "q2 sent");
	await p2;

	const res = await submitInput(env, "/sub");
	assert.equal(res, "consumed");
	assert.equal(env.pi.sentMessages.length, 2, "no side question sent");
	assert.deepEqual(
		env.pi.appended.filter((a) => (a.data as { fork?: boolean })?.fork === true),
		[{ type: "qq", data: { fork: true } }],
		"one fork boundary marker",
	);
	const last = env.session.branch().at(-1)!;
	assert.equal(last.type, "custom", "marker appended at the leaf");
	assert.deepEqual(last.data, { fork: true });
	assert.ok(env.ctx.statuses.some((s) => s.key === "qq" && s.status?.includes("· sub 1")), "depth in footer status");

	// The editor border is a LIVE getter: re-rendering after /sub shows the depth.
	const factory = env.ctx.editorComponents.at(-1) as (tui: unknown, theme: unknown, keybindings: unknown) => unknown;
	const editor = factory({}, { borderColor: (s: string) => s, selectList: {} }, { matches: () => false }) as {
		renderTopBorder(w: number, h: number): string;
	};
	assert.ok(editor.renderTopBorder(200, 0).includes("sub-thread 1"), "depth in the border title");

	// A follow-up still runs as a side question, with the whole chain in context.
	const p3 = submitInput(env, "q3");
	await waitFor(() => env.pi.sentMessages.length === 3, "q3 sent");
	await p3;
	const users = env.session
		.branch()
		.filter((e) => e.message?.role === "user")
		.map((e) => String(e.message!.content).split("\n")[0]);
	assert.deepEqual(users, ["main question", "qq: q1", "qq: q2", "qq: q3"], "sub-thread is the same session");
});

test("/nvm after /sub drops the WHOLE session (initial /qq + sub-thread)", async () => {
	const env = makeEnv({ answer: "a" });
	const root = env.session.leafId!;
	await toSubThread(env);

	await submitInput(env, "/nvm");
	await waitFor(() => env.session.leafId === root, "rewound to the FIRST /qq root");
	const users = env.session.branch().filter((e) => e.message?.role === "user").map((e) => e.message!.content);
	assert.deepEqual(users, ["main question"], "all side Q&A gone (initial + sub)");
	assert.equal(env.ctx.editorComponents.at(-1), undefined, "mode exited");
	const res = await submitInput(env, "back to work");
	assert.equal(res, "message", "plain text is a real message again");
});

test("/merge after /sub keeps the whole chain (initial /qq + sub-thread) as conversation", async () => {
	const env = makeEnv({ answer: "a" });
	await toSubThread(env);

	const res = await submitInput(env, "/merge");
	assert.equal(res, "consumed");
	assert.equal(env.ctx.editorComponents.at(-1), undefined, "mode exited");
	assert.deepEqual(
		env.pi.appended.filter((a) => (a.data as { closed?: boolean })?.closed === true),
		[{ type: "qq", data: { closed: true } }],
		"close marker at the leaf",
	);
	const users = env.session
		.branch()
		.filter((e) => e.message?.role === "user")
		.map((e) => String(e.message!.content).split("\n")[0]);
	assert.deepEqual(users, ["main question", "qq: q1", "qq: q2", "qq: q3"], "whole chain kept in order");
	const res2 = await submitInput(env, "back to work");
	assert.equal(res2, "message", "next message continues after the chain");
});

test("/sub and /merge outside a side thread are NOT commands (pass through as messages)", async () => {
	const env = makeEnv({ answer: "a" });
	for (const cmd of ["/sub", "/merge"]) {
		const res = await submitInput(env, cmd);
		assert.equal(res, "message", `${cmd} passes through`);
		assert.equal(env.pi.sentMessages.at(-1), cmd);
	}
	assert.equal(env.pi.appended.length, 0, "no markers appended");
});

test("/sub while a side question is in flight warns and appends nothing", async () => {
	const env = makeEnv({ answer: "a", delayMs: 80 });
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;
	const p2 = submitInput(env, "q2");
	await waitFor(() => env.pi.sentMessages.length === 2, "q2 sent");

	const res = await submitInput(env, "/sub");
	assert.equal(res, "consumed");
	assert.ok(env.ctx.notifyOf((m) => m.includes("in flight")), "warning");
	assert.equal(env.pi.appended.filter((a) => (a.data as { fork?: boolean })?.fork === true).length, 0, "no fork marker");

	await p2;
});

test("/merge while a side question is in flight warns; the mode stays open", async () => {
	const env = makeEnv({ answer: "a", delayMs: 80 });
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;
	const p2 = submitInput(env, "q2");
	await waitFor(() => env.pi.sentMessages.length === 2, "q2 sent");

	const res = await submitInput(env, "/merge");
	assert.equal(res, "consumed");
	assert.ok(env.ctx.notifyOf((m) => m.includes("in flight")), "warning");
	assert.equal(env.pi.appended.filter((a) => (a.data as { closed?: boolean })?.closed === true).length, 0, "no close marker");
	assert.ok(env.ctx.editorComponents.at(-1), "mode still active");

	await p2;
});

test("resuming a session with a sub-thread re-enters the mode at the right depth", async () => {
	const env = makeEnv({ answer: "a" });
	const root = env.session.leafId!;
	await toSubThread(env);

	// "Restart": the extension reloads on the same session file.
	env.pi.emit("session_start", { reason: "resume" });
	assert.ok(env.ctx.notifyOf((m) => m.includes("Resumed the side thread")));
	assert.ok(env.ctx.statuses.some((s) => s.key === "qq" && s.status?.includes("· sub 1")), "depth restored");

	// /nvm still drops the WHOLE session (initial /qq + sub-thread).
	await submitInput(env, "/nvm");
	await waitFor(() => env.session.leafId === root, "rewound to the first /qq root");
	assert.equal(env.ctx.editorComponents.at(-1), undefined, "mode exited");
});

test("detectSideThreadRoot: /sub boundaries are transparent; close marker still blocks resume", () => {
	const main = (id: string) => ({ id, type: "message", message: { role: "user", content: "main" } });
	const qm = (id: string) => ({ id, type: "custom", customType: "qq", data: { question: "x" } });
	const qu = (id: string) => ({ id, type: "message", message: { role: "user", content: `qq: ${id}` } });
	const an = (id: string) => ({ id, type: "message", message: { role: "assistant", content: [{ type: "text", text: "a" }] } });
	const fk = (id: string) => ({ id, type: "custom", customType: "qq", data: { fork: true } });
	const cl = (id: string) => ({ id, type: "custom", customType: "qq", data: { closed: true } });

	// Plain thread (unchanged behavior).
	assert.deepEqual(detectSideThreadRoot([main("m0"), qm("1"), qu("2"), an("3"), qm("4"), qu("5"), an("6")]), {
		root: "m0",
		answered: true,
		forks: 0,
	});
	// Fork between triples: transparent, root is still before the FIRST marker.
	assert.deepEqual(detectSideThreadRoot([main("m0"), qm("1"), qu("2"), an("3"), fk("4"), qm("5"), qu("6"), an("7")]), {
		root: "m0",
		answered: true,
		forks: 1,
	});
	// Unanswered question after a fork.
	assert.deepEqual(detectSideThreadRoot([main("m0"), qm("1"), qu("2"), an("3"), fk("4"), qm("5"), qu("6")]), {
		root: "m0",
		answered: false,
		forks: 1,
	});
	// Bare fork at the tail (user /sub'd, then exited before the next question):
	// the thread is still open and resumable, at the sub depth.
	assert.deepEqual(detectSideThreadRoot([main("m0"), qm("1"), qu("2"), an("3"), qm("4"), qu("5"), an("6"), fk("7")]), {
		root: "m0",
		answered: true,
		forks: 1,
	});
	// Merged inside a sub-thread: close marker at the tail blocks resume.
	assert.equal(detectSideThreadRoot([main("m0"), qm("1"), qu("2"), an("3"), fk("4"), qm("5"), qu("6"), an("7"), cl("8")]), null);
	// Absorbed after a sub-thread: a real message follows.
	assert.equal(
		detectSideThreadRoot([main("m0"), qm("1"), qu("2"), an("3"), fk("4"), qm("5"), qu("6"), an("7"), { id: "8", type: "message", message: { role: "user", content: "real" } }]),
		null,
	);
});

test("detectSideThreadRoot: real on-disk user messages are content-BLOCK arrays, not strings", () => {
	// sendUserMessage("qq: ...") is stored by pi as [{ type: "text", text }],
	// not a plain string. The old string-only isSideUser check matched none of
	// these, so a real mid-thread resume was never detected and the next plain
	// message silently absorbed the thread. Regression guard for both shapes.
	const au = (id: string, text: string) => ({
		id,
		type: "message",
		message: { role: "user", content: [{ type: "text", text }] },
	});
	const qm = (id: string) => ({ id, type: "custom", customType: "qq", data: { question: "x" } });
	const an = (id: string) => ({ id, type: "message", message: { role: "assistant", content: [{ type: "text", text: "a" }] } });
	const real = (id: string) => ({ id, type: "message", message: { role: "user", content: [{ type: "text", text: "back to work" }] } });
	const base = [au("m0", "main conversation")];

	// Answered thread, array-content side questions → detected, root at m0.
	assert.deepEqual(detectSideThreadRoot([...base, qm("1"), au("2", "qq: q1"), an("3"), qm("4"), au("5", "qq: q2"), an("6")]), {
		root: "m0",
		answered: true,
		forks: 0,
	});
	// Unanswered trailing question (exited mid-stream), array content.
	assert.deepEqual(detectSideThreadRoot([...base, qm("1"), au("2", "qq: q1"), an("3"), qm("4"), au("5", "qq: q2")]), {
		root: "m0",
		answered: false,
		forks: 0,
	});
	// Absorbed: a real (non-qq) ARRAY-content message follows → not resumable.
	assert.equal(detectSideThreadRoot([...base, qm("1"), au("2", "qq: q1"), an("3"), real("4")]), null);
});

test("/nvm after out-of-band absorption does NOT rewind the real turn (stale state)", async () => {
	const env = makeEnv({ answer: "a" });
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;
	const p2 = submitInput(env, "q2");
	await waitFor(() => env.pi.sentMessages.length === 2, "q2 sent");
	await p2;

	// An rpc driver lands a REAL turn: it absorbs the thread, and the mode
	// stays stale-active until the next interactive input.
	await submitInput(env, "real turn", "rpc");
	assert.equal(env.ctx.editorComponents.at(-1) !== undefined, true, "stale mode still on");

	const res = await submitInput(env, "/nvm");
	assert.equal(res, "command", "stale /nvm is a no-op command (not passed through, nothing rewound)");
	assert.ok(env.session.findUserEntry("qq: q1"), "absorbed side Q&A kept");
	assert.ok(env.session.findUserEntry("real turn"), "real turn kept — NOTHING rewound");
	assert.equal(env.ctx.editorComponents.at(-1), undefined, "stale mode ended");
});

test("/merge after out-of-band absorption is a no-op consume (nothing to merge)", async () => {
	const env = makeEnv({ answer: "a" });
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;
	const p2 = submitInput(env, "q2");
	await waitFor(() => env.pi.sentMessages.length === 2, "q2 sent");
	await p2;
	await submitInput(env, "real turn", "rpc");

	const res = await submitInput(env, "/merge");
	assert.equal(res, "consumed");
	assert.equal(env.pi.appended.filter((a) => (a.data as { closed?: boolean })?.closed === true).length, 0, "no close marker on an absorbed thread");
	assert.ok(env.session.findUserEntry("qq: q1"), "Q&A still part of the conversation");
	assert.ok(env.session.findUserEntry("real turn"), "real turn intact");
	assert.equal(env.ctx.editorComponents.at(-1), undefined, "stale mode ended");
});

test("near-miss of a mode command in mode (\"/nvm'\") runs as a FOLLOW-UP, not a real message", async () => {
	const env = makeEnv({ answer: "a" });
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;
	const p2 = submitInput(env, "q2");
	await waitFor(() => env.pi.sentMessages.length === 2, "q2 sent");
	await p2;

	// The stray quote makes it NOT a command — in the thread it is just text.
	const res = await submitInput(env, "/nvm'");
	assert.equal(res, "consumed", "hijacked by the mode, not sent as a real message");
	assert.equal(env.pi.sentMessages.length, 3, "ran as a follow-up");
	assert.equal(env.pi.sentMessages.at(-1)!.split("\n")[0], "qq: /nvm'");
	assert.ok(env.ctx.notifyOf((m) => m.includes("not a command")), "explained the near-miss");
	assert.ok(env.session.findUserEntry("qq: q1"), "thread still alive — nothing absorbed");
	assert.ok(env.ctx.editorComponents.at(-1), "mode still on");

	// The exact command still works and drops the whole session (typo Q&A included).
	await submitInput(env, "/nvm");
	await waitFor(() => env.session.findUserEntry("qq: q1") === undefined, "thread dropped");
});

test("near-misses of /sub and /merge also run as follow-ups in mode (no markers)", async () => {
	const env = makeEnv({ answer: "a" });
	const p1 = await toPending(env, "qq", "q1");
	env.ctx.press("f");
	await p1;
	await submitInput(env, "/subx");
	await submitInput(env, "/merge!");
	assert.deepEqual(env.pi.sentMessages.slice(1).map((s) => s.split("\n")[0]), ["qq: /subx", "qq: /merge!"]);
	assert.equal(env.pi.appended.filter((a) => {
		const d = a.data as { fork?: boolean; closed?: boolean } | undefined;
		return d?.fork || d?.closed;
	}).length, 0, "no fork or close markers");
	assert.ok(env.session.findUserEntry("qq: q1"), "thread intact");
	assert.ok(env.ctx.editorComponents.at(-1), "mode still on");
});

test("near-miss OUTSIDE the session is an ordinary message", async () => {
	const env = makeEnv({ answer: "a" });
	const res = await submitInput(env, "/nvm'");
	assert.equal(res, "message", "no session → scope rule: ordinary text");
	assert.equal(env.pi.sentMessages.at(-1), "/nvm'");
});
