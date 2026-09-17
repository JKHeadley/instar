# Side-Effects Review — Resume Follows the Account

**Version / slug:** `resume-follows-account`
**Date:** `2026-09-16`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Three fixes for a topic resume loop seen on sagemind: (1) `placeResumeTranscript` places the freshest copy of a topic conversation into the Claude login a pinned topic spawn uses, never deleting a copy, and refuses internal one-shot transcripts; (2) `SessionManager.isPaneDead` reads tmux's pane-exit flag so a crashed startup takes the existing one-time fresh retry, which now keeps the session's settings; (3) `TopicResumeMap` stops guessing a topic's conversation from the newest file, ignores guessed legacy entries, skips dead or missing panes in its heartbeat, and finds transcripts under `~/.claude-*` logins. Files: `src/core/claudeResumeTranscript.ts` (new), `src/core/SessionManager.ts`, `src/core/TopicResumeMap.ts`, `src/core/SessionRefresh.ts`, `src/core/types.ts`, `src/core/Config.ts`, `src/scaffold/templates.ts`, `src/core/PostUpdateMigrator.ts`, tests.

## Decision-point inventory

- Launch with or without `--resume` after placement — modify (adds a filesystem-fact check before an existing launch).
- Replace, keep or set aside an existing transcript copy — add (deterministic byte-prefix rule, never deletes).
- Pane dead during readiness and at the not-ready branch — modify (routes to the existing retry branch).
- Heartbeat record a resume pointer — modify (removes the guessing branch; skips dead/missing panes).

## 1. Over-block

A topic whose conversation exists only as an `sdk-cli`-entrypoint transcript would launch fresh. Topic sessions are always interactive (`cli`) launches, so no legitimate topic conversation has that entrypoint. A topic whose saved pointer was written by the old guess starts fresh once after upgrade; that pointer was never trustworthy. An agent whose hook bridge never reports a session id loses the single-session guess that previously recovered its resume; that guess is the defect being removed.

## 2. Under-block

Threadline agent-to-agent resume across an account change is not fixed (tracked ACT-1275, ACT-1278). A legacy pointer saved as `hook` that points at a wrong conversation is not caught on unpinned launches (placement runs only for pinned logins); it can cost one wrong resume, not a loop. A nested `claude` process inside a pane can briefly rotate a session id (tracked ACT-1284). A concurrent outside writer to a transcript between the prefix comparison and the stat re-check is not excluded; the window is milliseconds and only at topic spawn.

## 3. Level-of-abstraction fit

Placement lives at the single interactive spawn site where the launch login is resolved, which is the only point that knows both the resume id and the login. Pane-exit detection lives in `SessionManager` next to the existing liveness helpers. The pointer changes stay inside `TopicResumeMap`, the pointer's owner.

## 4. Signal vs authority compliance

No brittle check gains authority over messages or agent behaviour. Placement only adds or preserves data. The pane-dead check routes to recovery branches that already hold that authority, and every probe error falls back to the previous behaviour. The heartbeat change narrows what may be written.

## 4b. Judgment-point check

No competing-signals decision point is added; every decision is a filesystem or tmux fact (classified `invariant` in the spec §4).

## 5. Interactions

- `resumeFailed` listener (server.ts) — unchanged; now reached for dead-pane crashes as intended.
- Monitor exit transition — unchanged; it may also record the dead pane's exit; the retry path marks the record failed first, as before.
- `SessionRefresh` account swap — now uses the same placement function; no behaviour change beyond freshest-copy selection and never overwriting a diverged copy.
- sagemind's local `repatch-resume-homes.mjs` — its anchor comment is unchanged, so it may still insert its block; that block is an additional existence check and is harmless alongside the upstream one.
- TokenLedger scans `~/.claude/projects`; a copy placed there is ingested once (request ids dedupe).

## 6. External surfaces

One config key (`sessions.resumeFollowsAccount.enabled`, default on), one CLAUDE.md awareness bullet (template + migration), new log lines, and `DegradationReporter` events for `not-found`, `one-shot` and `forked` placements with fixed text naming only the outcome. Placement writes transcript copies (mode 0600) into other login folders on the same machine.

## 7. Multi-machine posture

Machine-local by design: a transcript copy only serves a Claude login on the same machine (`physical-credential-locality`, spec §Multi-machine posture). No replicated state is added; the resume map keeps its existing per-machine posture.

## 8. Rollback cost

Set `sessions.resumeFollowsAccount.enabled: false` and restart to disable placement and dead-pane checks; the heartbeat change has no switch because it only removes a guess. A release revert restores everything. No data migration: placed copies and `.forked-*` files are ordinary files that older versions ignore.

## Conclusion

The change is narrow, reversible, and removes a guaranteed loop. Ready to ship with the kill switch as the rollback lever.

## Second-pass review (if required)

Reviewer: independent second-pass subagent, 2026-09-16.

Concur with the review. Nothing deletes or truncates a transcript: `placeResumeTranscript` only renames copies aside, writes through a temp file, never overwrites attachments, and returns `'error'` on any exception, leaving the launch as before. Every new tmux check fails toward "alive" or "skip", and the retry cannot loop. One narrow point raised (the dead same-name session cleared at spawn did not mark its old record ended) was fixed in the same change: the record is marked `failed` before the kill.
