<!-- bump: patch -->

# Bounded tail-reads stop the 12MB telegram-log + 14MB feedback-store from freezing the event loop

## What Changed

FOUR callers each did a synchronous `fs.readFileSync` of the ~12MB `.instar/telegram-messages.jsonl`
just to inspect its last 50–200 lines: `CommitmentSentinel.parseRecentMessages` (5-min timer),
`CoherenceMonitor`'s output-sanity check (5-min timer), `checkLogForAgentResponse` (PresenceProxy ack
path, event-driven), and `TelegramAdapter.getMessageLog` (analysis route). A 12MB sync read + split
on a 5-minute timer froze the event loop up to ~20s per pass — the same ~0-CPU false-sleep signature
the JobRunHistory fix removed. Separately, `JsonlFeedbackStore` re-read + re-`JSON.parse`d the entire
~14MB `feedback.jsonl` at the start of every processing pass even when nothing had changed. This is
the THIRD + FOURTH event-loop-blocker class behind the dashboard "disconnected" flapping (after sync
tmux, sync keychain, and the JobRunHistory 13MB re-read).

The fix is two behavior-preserving mechanisms: (A) a shared bounded tail-read utility
(`src/utils/jsonl-tail.ts`) that reads only the last 512KB via `openSync`/`readSync` — mirroring
`CoherenceJournal.readTailTolerant` — used by the four telegram-log readers; and (B) a
`(size, mtimeMs)` load cache in `JsonlFeedbackStore` (mirroring the JobRunHistory cache) that serves a
clone of the prior parse when the file is byte-for-byte unchanged.

## What to Tell Your User

If your dashboard kept dropping its connection even after the tmux, keychain, and job-history fixes,
these two large files were the remaining cause: a 12MB message log re-read whole on a 5-minute timer,
and a 14MB feedback log re-parsed from scratch every pass. After this update both freezes are gone —
the message-log checks read only the last chunk of the file (instant regardless of size), and the
feedback log is served from memory when nothing changed. (A separate cleanup — capping those files'
unbounded growth — is tracked separately.)

## Summary of New Capabilities

- New `src/utils/jsonl-tail.ts` bounded tail-reader (`readJsonlTailLines` / `readJsonlTailLastLines`):
  reads only the last `maxBytes` (default 512KB ≈ 2,600 lines) via `statSync`/`openSync`/`readSync`,
  drops the partial first line, never loads the whole file, never throws.
- The four telegram-log tail readers (CommitmentSentinel, CoherenceMonitor, PresenceProxy ack path,
  TelegramAdapter.getMessageLog) converted from whole-12MB-file sync reads to bounded tail-reads;
  parsed/filtered results are identical to the old full-split-then-slice.
- `JsonlFeedbackStore` gains a `(size, mtimeMs)`-keyed in-memory load cache: unchanged file = zero-IO
  clone-on-serve, any change = full re-read. Existing load semantics (dedup-last-wins, torn-line skip,
  corrupt-file recovery) preserved exactly.
- Removes the third + fourth event-loop-blocker class behind the dashboard flapping and the
  associated SleepWakeDetector false-wakes.

## Evidence

Root cause diagnosed by a live profiler catching the event loop frozen in a whole-file
ReadFileUtf8 → split on a 5-minute timer (the ~0-CPU false-sleep signature). Fix covered by 48 tests
across four files: `jsonl-tail` (9 — tail correctness, partial-line drop, missing/empty file,
truncation flag), `CoherenceMonitor-bounded-read` (2 — a `fs.readFileSync` spy FAILS if the whole
12MB log is read, AND a bad pattern in a RECENT agent message at the END of a multi-MB log is still
detected via the tail), `CommitmentSentinel` (26), `jsonl-feedback-store` (11 — including cache-hit
serves zero-IO and any change re-reads). Cross-impact suites green; tsc exit 0; no-silent-fallbacks +
bounded-accumulation lints green.
