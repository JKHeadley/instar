# Side-Effects Review — account-swap conversation continuity (transcript copy)

## Scope of change

- `src/core/SessionRefresh.ts` — new exported `ensureResumeTranscriptInConfigHome(uuid,
  targetConfigHome)` + a guarded call in `refreshSession`, just before the respawner,
  when `accountSwap.configHome` is set and not a `fresh` respawn. Copies the conversation
  transcript into the target account's config home so `claude --resume` finds it.

## The gap (caught by live testing, not the mocked e2e)

Claude stores transcripts PER CONFIG HOME: `<CLAUDE_CONFIG_DIR>/projects/<projectDir>/
<uuid>.jsonl`. The P1.3 swap changes `CLAUDE_CONFIG_DIR` to the new account then runs
`claude --resume <uuid>` — which looks in the NEW config home and finds nothing, because
the transcript is still in the OLD account's config home. So the "continuity guarantee"
(the headline feature) would silently LOSE the conversation (resume → fresh start). The
P1.3 comment "the resume UUID is account-agnostic" was right about the UUID but missed
that transcript STORAGE is config-home-local. The merged e2e passed only because it
mocked the refresh — it never moved a real conversation between real config homes.

## The fix

Before the `--resume` respawn under the new config home, find the transcript by uuid
across the user's `~/.claude*` config homes (default + enrollment-wizard slots) and copy
it into the target config home, preserving the `projects/<projectDir>/` relative path.
Idempotent (no-op if already present), best-effort (never throws — a miss is logged and
the session simply starts fresh, the prior behavior).

## Authority / autonomy

No new authority. Only runs on an account swap (`accountSwap.configHome` set), which is
itself opt-in/dark. Touches only the per-account `projects/` transcript files (copy, never
delete). When no swap is requested — every existing refresh/recovery — this code does not
run; behaviour is byte-for-byte unchanged.

## Framework generality

Claude-code-specific by nature (the `<CLAUDE_CONFIG_DIR>/projects/.../<uuid>.jsonl` layout
is Claude's), matching the standard's Claude-first scope. The account-swap path is only
taken for claude-code sessions; other frameworks don't set `configHome`.

## Failure modes considered

- `fresh` respawn → skipped (we intentionally start a new conversation).
- No `claudeSessionId` on the session → logged, skipped (can't know the uuid); resumed
  session may start fresh — same as today, not a regression.
- Transcript exists nowhere / unreadable → returns false, logged; respawn proceeds (fresh).
- Already in the target → no-op (idempotent).
- Config home outside `~/.claude*` → not found by the search (documented limitation; all
  current config homes — default + wizard slots — live under HOME).

## Migration / parity

Pure additive logic on files claude already writes — no migration, no config, no stored
shape change. Ships via dist.
