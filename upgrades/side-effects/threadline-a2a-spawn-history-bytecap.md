# Side-effects — Threadline a2a spawn history byte-cap

**Change:** `ThreadlineRouter.buildHistoryContext()` and `buildPrompt()` now bound
the thread-history block and the latest-message body by bytes before they are
embedded in the a2a reply-spawn prompt. New pure exported helpers
`capMessageBody()` and `buildBoundedHistorySection()`.

## Behavioral side-effects

- **Spawned a2a reply workers see a bounded history.** On long threads (history
  exceeding ~6 KB), the spawn prompt now contains the most recent messages that
  fit rather than the entire thread. Older messages are dropped (newest-first);
  the history header notes "older omitted to fit". This is a deliberate trade to
  keep the spawn command under tmux's ~16 KB limit. Resume-based sessions and the
  durable thread store are unaffected — full history still lives in
  `conversations.json`; only the one-shot wake-up prompt is trimmed.
- **Very large single messages are truncated in the prompt** (per-message 1500
  bytes in history; 3500 bytes for the latest body) with an explicit
  `…[truncated N chars]` marker. The full message body is still persisted in the
  thread store; only its inline copy in the spawn prompt is capped.
- **No change to behavior on short threads.** Threads whose total history is under
  budget render identically to before (same numbering, same "N of N messages"
  header without the "older omitted" suffix).

## Blast radius

- Scoped entirely to `src/threadline/ThreadlineRouter.ts`. No change to
  `SessionManager.spawnSession`, the core tmux spawn, job sessions, or any other
  framework path.
- No config, schema, hook, or migration changes. No new dependencies.
- The cap constants are module-level (not configurable) — matching the Mentor
  Stage-A precedent. If a future need arises they can be promoted to
  `ThreadlineRouterConfig`.

## Migration parity

None required — this is internal runtime logic shipped in `src/`. Existing agents
receive it on their normal version update; there is no agent-installed file
(`.claude/settings.json`, `.instar/config.json`, CLAUDE.md template, hook, or
skill) to migrate.

## Follow-up (not in this change)

File-based prompt passing in `SessionManager.spawnSession` (mirroring
`PipeSessionSpawner`'s `"$(< file)"` pattern) would eliminate the command-length
limit for all spawn paths and preserve full context — deferred as higher blast
radius than an urgent hotfix warrants.
