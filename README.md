# pi-qq — `/qq` quick side question

Ask a one-off "by the way" question **without letting the Q&A enter the ongoing
context** — the same idea as Claude Code's `/btw`.

> **This branch (`patched-core-0.2.x`) is the patched-core line.** It adds
> true deletion of dismissed threads (below) by additively patching pi's
> `SessionManager`, and is published as the **`patched`** dist-tag of the
> same package. It requires an **EXACT** pi version — currently **1.0.2**
> (`config.patchTargetPiVersion`, pinned in `devDependencies` too). On any
> other pi version the patch simply does not install and the extension
> degrades to the plain upstream behavior. For the unpatched build, use the
> `main` branch / `latest` tag.
>
> ```bash
> pi install npm:@elvinw/pi-qq@patched
> ```

## Patched core: dismissed threads are really gone

Mainline pi's session is append-only: dismissing a `/qq` thread can at best
move the leaf back, leaving the Q&A as a **dead branch** in the file (visible
in `/tree`). This branch closes that gap. At load time it **additively
installs** `pruneBranches(keepLeafId?)` on `SessionManager.prototype` —
keeping only the root→leaf path, rebuilding pi's own index, and rewriting the
session file. Never overriding an existing method, and only when the running
pi version exactly matches the pin (the patch touches private-by-convention
internals that may drift on any release).

Dismiss and `/nvm` then drop the thread through a ladder — the first tier
that works wins:

1. **prune** (this branch, exact pi match): the thread is physically removed
   from the session file — no dead branch, no dead fork file, same session
   id. (Other orphan branches are tidied too.)
2. **fork** (upstream pi ≥ 0.69): switch to a new session file holding only
   the mainline; the old file (with the thread) stays on disk.
3. **rewind** (any pi): the baseline — the thread is orphaned in the tree.

Transient failure paths (no answer, timeouts) still use a plain rewind:
they discard one small failed question and must not churn session files.

## Commands

| Command | Tool policy during the question |
|---|---|
| `/qq <question>` | prompt asks the model to use **no** tools |
| `/qqro <question>` | prompt asks the model to use **only** read-only tools (`read`, `grep`, `find`, `ls`) |
| `/ro` | Side thread: toggle the follow-up policy between no-tools and read-only |
| `/nvm` | Side thread: **never mind** — exit the mode and rewind the whole thread to its first question, as if it never happened |

The side thread is visible everywhere:

- **Input box**: while the thread is open, the editor's top border becomes a
  "qq side thread — … /ro read-only · /nvm back to main" title and the
  footer status shows the live tool policy.
- **Command list**: pi's command list is static (no unregister), so the mode
  is reflected in autocomplete: inside the thread `/qq` and `/qqro`
  disappear from the list (plain text is the question now); outside it `/ro`
  and `/nvm` disappear. Hidden commands are still typeable — `/qq` inside
  the thread just asks the next question, and `/ro`/`/nvm` outside it only
  warn.

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

- **f** → **open the side thread**: the input box becomes your side
  conversation. **Plain text is the next side question** (answered with the
  whole thread in context, no `/qq` prefix needed). `/ro` toggles the
  follow-up policy, `/qq`/`/qqro` also work (explicit policy per question).
  The mode ends when you: finish with **m** (merge) or any other key
  (dismiss), run `/nvm` (drop the thread), or when a normal (non-`/qq`)
  message lands via another path (rpc driver etc.) — that message absorbs
  the thread: it can never be rewound away again.
- **exit mid-thread** → the thread survives in the session file. When pi
  next starts on that session, the extension detects that the conversation
  ends in side Q&A and **re-opens the side thread**: an answered one re-
  enters the mode (type to follow up, `/nvm` drops it, `m` after an answer
  keeps it); one that was still streaming only restores the thread so
  `/nvm` can still drop it. A merged thread (its merge left a context-
  invisible close marker) and an absorbed one are correctly NOT re-opened.
- **m** → **merge**: the side Q&A becomes part of the conversation and the
  next message continues right after the answer.
- **any other key** → **dismiss**: the whole side thread (every question and
  answer in it) is rewound away and the conversation continues as if it never
  happened. Printable keys pass through, so you can start typing your next
  prompt immediately.

Mechanically, a pi session is an append-only **tree** of entries and the model
context is always built from the root→leaf path. `/qq` exploits that:

1. Remembers the current leaf (`homeLeaf`), appends a marker entry, and sends
   the question (with its tool-policy note) — the Q&A lands on a
   **temporary side branch**.
2. Waits for the run to fully settle (`agent_settled`).
3. Puts up "any key dismisses · m merges" (footer status + notification) and
   waits for **your** keypress.
4. On dismiss, **drops the thread at its root** — the leaf before the
   thread's first question, so a whole follow-up thread vanishes in one
   keypress — via the first available tier: prune (this branch) → fork →
   leaf rewind (plain upstream pi). On merge, it simply doesn't rewind.

After a dismiss the exchange is excluded from all future model requests and
compaction. On this branch it is also physically removed from the session
file; on plain upstream pi it remains as a dead branch, visible in `/tree`
(you can re-attach it later by navigating to it).

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
# patched-core line (this branch) — exact pi 1.0.2 required for the patch
pi install npm:@elvinw/pi-qq@patched
```

or from a local clone:

```bash
pi --extension ./pi-qq
```

or place this directory in `~/.pi/agent/extensions/` (personal) or
`.pi/extensions/` (project), then `/reload`.

No `npm install` is needed to *run* it: the only runtime import
(`CustomEditor`, for the mode's input-box title) is provided by pi itself
when it loads the extension.

## Development

```bash
npm install        # pulls the published pi-coding-agent 1.0.2 types + tsc
npm run typecheck
npm test           # 56 scenario tests (node:test, no extra deps)
```

The `pi-coding-agent` dev-dependency is **exactly pinned** (no `^`) because
the self-patch targets a specific pi version; it exists for local
typechecking against the published API. `node_modules/` is git-ignored.

### Tests

`test/` runs the extension against a **mock pi environment** (the extension
imports pi's types only — no runtime dependency — so a mock `ExtensionAPI`
plus an in-memory session tree exercise the real logic, no pi process
needed). The scenario matrix covers:

- **lifecycle** — send → settle → PENDING → dismiss/merge, key semantics
  (case, pass-through vs consume), status line, prompt notes
- **threads** — follow-up chains, context inheritance, thread absorption by
  a normal message, orphaning via `/tree`
- **side-thread mode** — plain-text follow-ups, `/ro` toggling (and
  non-reset on `f`), `/nvm` (with and without a thread, in-flight guard),
  auto-exit on `/compact`/`/tree`/`/new` effects, recursion guard, slash
  pass-through, in-flight guard, full e2e loop
- **mode surface** — autocomplete hides `/ro`+`/nvm` outside the thread and
  `/qq`+`/qqro` inside; the editor border carries the mode title in mode
  only
- **failures** — no answer, settle timeout, failed question mid-thread,
  stuck-busy rewind
- **queue** — busy-on-call, re-settle loop, queue timeout, in-flight guard
- **invariants** — zero leaked subscriptions on every path (including mode
  exit), compaction cancellation, tool guardrail (block/allow matrix),
  session swap, empty session, preflight warning
- **resume** — pi exited mid-thread: answered thread re-enters the mode
  (follow-up continues, dismiss drops the whole thread), merged/absorbed
  threads are not re-opened, unanswered (mid-stream) restore only the
  thread for `/nvm`, plain sessions untouched
- **patched core (this branch)** — `installSessionPrune` on the exact pi
  version (idempotent, version-mismatch refusal) and a real
  `SessionManager` integration test (prune keeps root→target, re-pins the
  leaf, rewrites the file, reopens cleanly); the drop ladder on dismiss and
  `/nvm` (prune / fork / rewind tiers)

## Safety

- Tool policy is two-layer while the tool set itself stays untouched
  (deliberate, for cache preservation): the prompt asks the model to comply,
  and a `tool_call` guardrail blocks any out-of-policy call before it
  executes — the model sees the block reason as a tool error and answers in
  text instead. Nothing can write files or run commands during `/qq`.
- If an answer is aborted or errors before producing text, only that
  question is rewound away immediately (nothing to read); the rest of an
  in-progress thread survives.
- Exitting pi mid-thread never loses the thread: it is re-detected from the
  session file on the next start (see **exit mid-thread** above). Merge
  leaves a context-invisible close marker so a resumed session can tell a
  merged thread from an open one.
- `/new`, `/fork`, or quit mid-question: the wait bails out; the side branch
  is just an orphan branch (harmless). Inside an open side thread these
  commands (and `/compact`, `/tree` navigation) **end the mode
  automatically** — the thread is absorbed or orphaned and plain text goes
  back to the main conversation.
- In side-thread mode, plain text submitted while a question is still
  streaming is dropped with a warning (strictly serial — one question at a
  time, single-slot llama.cpp safe).
- Double `/qq`/`/qqro` is rejected while one is running or queued.
- If the agent is running, the question is **queued** and runs automatically
  when the flow settles (aborting the flow unblocks it). Still strictly
  serial — compatible with single-slot llama.cpp (`-np 1`). A 2h wait cap
  drops the question rather than wedging the command.
