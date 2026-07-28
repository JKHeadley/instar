# Instar Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Four codex-compatibility and robustness fixes found while dogfooding a codex agent.

**1. Codex session resume now works.** `ThreadResumeMap` / `TopicResumeMap`
`jsonlExists` only checked the Claude transcript layout
(`~/.claude/projects/<encoded>/<uuid>.jsonl`), so it returned false for every
codex session — `get()` returned null and resume silently failed fleet-wide for
codex agents. It now also resolves codex rollout files
(`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`) via a new
`findRolloutFileSync`. The Claude path is byte-for-byte unchanged.

**2. The silence watchdog now sees codex jobs.** `ActiveWorkSilenceSentinel`
only recognized codex's interactive-TUI "working" signature, so a
`codex exec --json` job (which emits a JSON event stream, not the TUI status
line) read as idle and was never watched. The codex activity signature now
matches the exec-json event stream (`thread`/`turn`/`item` events); the idle
model-name guard is preserved.

**3. Duplicate agent-to-agent replies fixed.** A sender that timed out on the
receiver's session spawn retried with a fresh `message.id`, slipping past the
id-based relay dedup and causing a duplicate reply. A bounded content-hash dedup
at the `relay-agent` ingress collapses an identical retry within a short window.

**4. Clearer ship-gate error.** The artifact-sha-mismatch block now prints the
exact sha to write plus the freeze / re-stage / no-amend recipe.

## Summary of New Capabilities

- Codex-based agents resume conversations across restarts and compactions, the
  same as Claude agents.
- The silent-freeze watchdog now monitors codex background/job sessions, so a
  wedged `codex exec --json` job is detected and nudged instead of hanging
  unseen.
- Agent-to-agent messaging is idempotent against a slow-retry: an identical
  message redelivered within the window is acknowledged once, not replied to
  twice.
- The developer ship-gate gives an actionable sha-mismatch message instead of a
  dead end.

## Evidence

**1. Codex resume.** Reproduction: take a codex agent's saved resume UUID and
call the resume guard. Before: `jsonlExists(uuid)` returned `false` (it only read
`~/.claude/projects`), so `get()` returned `null` and the session re-spawned
fresh instead of resuming. After: with a codex rollout present at
`$CODEX_HOME/sessions/.../rollout-<ts>-<uuid>.jsonl` and no Claude jsonl,
`jsonlExists(uuid)` returns `true` and resume proceeds. A fixture test sets
`$HOME` to a codex-only layout and asserts the predicate flipped false to true.

**2. Silence watchdog.** Reproduction observed live 2026-05-30: a
`codex exec --json` commitment-detection job froze mid-turn (last pane output
`{"type":"turn.started"}`) and sat idle for ~8.5 hours; the watchdog never
flagged it because `looksActivelyWorking` returned false for the JSON event
frame. After: the same frame is recognized as active, so the session is
silence-eligible and the freeze is detected after the threshold. The idle
model-name line (`gpt-5.3-codex medium · <dir>`) still reads as inactive (no
false positive).

**3. Duplicate replies.** Reproduction observed live 2026-05-30: a codex agent's
reply doubled six times in one evening — the sender timed out on the receiver's
spawn and resent the same content with a fresh id, which the id-based dedup did
not catch, so the receiver spawned and replied twice. After: an integration test
drives the real `POST /messages/relay-agent`; a retry with a fresh id but
identical `(sender, thread, content)` is deduped and the receiver is handed the
message exactly once, while genuinely different content and a different sender
both still process.

**4. Ship-gate message.** Reproduction observed live 2026-05-30: an agent hit the
sha-mismatch block, regenerated the artifact to "fix" it (which changed the
volatile `Date:` line, hence the sha), and chased the hash for ~2 hours. Before:
the message only said "artifact content has changed (sha mismatch)". After: a
subprocess test stages a deliberately-wrong recorded sha and confirms the block
now prints the exact computed sha plus the re-stage / no-amend recipe.

## What to Tell Your User

Codex-based agents can now resume conversations and are watched by the
freeze-detector just like Claude agents; agent-to-agent chats no longer
double-send on a slow retry; and the developer ship-gate gives an actionable
message instead of a dead end. No action needed — these land automatically on
update.
