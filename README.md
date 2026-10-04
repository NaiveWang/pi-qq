# pi-qq — `/qq` quick side question

Ask a one-off "by the way" question **without letting the Q&A enter the ongoing
context** — the same idea as Claude Code's `/btw`.

## Commands

| Command | Tool policy during the question |
|---|---|
| `/qq <question>` | prompt asks the model to use **no** tools |
| `/qqro <question>` | prompt asks the model to use **only** read-only tools (`read`, `grep`, `find`, `ls`) |

Neither command touches the active tool set: the side request is a
byte-identical prefix extension of your last turn, so on llama.cpp/vLLM it
costs **zero extra prefill** (the server's prefix cache only grows, and the
cache is still intact for the next main turn). Tool policy is two-layer:

1. the prompt asks the model to comply (no tools / read-only only), and
2. a hard guardrail **blocks any out-of-policy tool call before it executes**
   — the model receives the block reason as a tool error and falls back to
   answering in text. A rogue `write`/`bash` can never run during a side
   question.

## How it works

The Q&A takes over the main transcript like a normal turn and **stays there**
until you decide its fate with your next keypress:

- **any key** → **dismiss**: the side branch is rewound away and the
  conversation continues as if it never happened. Printable keys pass through,
  so you can start typing your next prompt immediately.
- **m** → **merge**: the Q&A becomes part of the conversation and the next
  message continues right after the answer.

Mechanically, a pi session is an append-only **tree** of entries and the model
context is always built from the root→leaf path. `/qq` exploits that:

1. Remembers the current leaf (`homeLeaf`), appends a marker entry, and sends
   the question (with its tool-policy note) — the Q&A lands on a
   **temporary side branch**.
2. Waits for the run to fully settle (`agent_settled`).
3. Puts up "any key dismisses · m merges" (footer status + notification) and
   waits for **your** keypress.
4. On dismiss, **snaps the leaf back** to `homeLeaf` (same mechanism as
   `/tree`). On merge, it simply doesn't rewind.

After a dismiss the exchange is excluded from all future model requests and
compaction — but it remains in the session file as a dead branch, visible in
`/tree` (you can re-attach it later by navigating to it). Nothing is copied or
deleted; pi never rewrites history.

## Compaction safety

A side question must never compact the **main** conversation. If the session
is near its token limit, the side turn itself can trip auto-compaction — and
a compaction entry stranded on the main line would truncate the real history
out of context (its summary would have been written from side-branch
context). So during a side turn pi-qq:

- **cancels auto-compaction** (`session_before_compact` → `cancel`),
- **waits for true idle** (no run, no compaction) before rewinding —
  `navigateTree` refuses while the session is busy,
- **notifies** when a rewind fails instead of failing silently (the Q&A stays
  visible so you can see it; re-run the command to dismiss again),
- warns up front when the context is ≥ 90% of the window (the side turn may
  overflow; `/compact` first is the clean move).

**Cost note:** the side request still sends the full current context (the
model needs it to answer "which of the two approaches…"). What `/qq` saves is
the recurring cost — the exchange never rides along in every subsequent turn.

## Install

```bash
pi install npm:@elvinw/pi-qq
```

or from a local clone:

```bash
pi --extension ./pi-qq
```

or place this directory in `~/.pi/agent/extensions/` (personal) or
`.pi/extensions/` (project), then `/reload`.

No `npm install` is needed to *run* it: the only import is `import type`,
which is erased when pi loads the extension.

## Development

```bash
npm install        # pulls the published pi-coding-agent 1.0.2 types + tsc
npm run typecheck
```

The `pi-coding-agent` dev-dependency exists purely for local typechecking
against the published API; `node_modules/` is git-ignored.

## Safety

- Tool policy is two-layer while the tool set itself stays untouched
  (deliberate, for cache preservation): the prompt asks the model to comply,
  and a `tool_call` guardrail blocks any out-of-policy call before it
  executes — the model sees the block reason as a tool error and answers in
  text instead. Nothing can write files or run commands during `/qq`.
- If the answer is aborted or errors before producing text, the leaf snaps
  back immediately (nothing to read).
- `/new`, `/fork`, or quit mid-question: the wait bails out; the side branch
  is just an orphan branch (harmless).
- Double `/qq`/`/qqro` is rejected while one is running.
- Requires the agent to be idle (also keeps it compatible with single-slot
  llama.cpp, `-np 1`).
