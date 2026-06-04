# Side-Effects Review — Threadline A2A resume via deterministic session-id

**Version / slug:** `threadline-a2a-resume-session-id`
**Date:** `2026-06-04`
**Author:** `Echo (instar dev agent)`
**Second-pass reviewer:** `not required (Tier 1)`

## Summary of the change

Path 1 of the A2A continuity fix. Headless `claude -p` reply sessions never reported their session id, so `onSessionComplete` left the resume entry's uuid as a placeholder and resume-after-exit cold-spawned. Fix: when `ThreadlineRouter.spawnNewThread` spawns the first reply session it mints a uuid and passes it as `claude --session-id <uuid>` (so the transcript is created at exactly `<uuid>.jsonl`), and persists that uuid as the resume entry. `resumeThread` spawns the follow-up with `claude --resume <uuid>` (reloading the full transcript) and a minimal prompt (new message + grounding only — the transcript already holds history). Threaded through: `SessionManager.spawnSession` (new `sessionId?`/`resumeSessionId?` options → `--session-id`/`--resume` spliced into the claude-code headless argv before `-p`, mutually exclusive, gated on framework), `SpawnRequestManager` (forwards both from `SpawnRequest` → callback), the relay `spawnSession` callback in `server.ts`. Files: `src/core/SessionManager.ts`, `src/messaging/SpawnRequestManager.ts`, `src/commands/server.ts`, `src/threadline/ThreadlineRouter.ts` + tests.

## Decision-point inventory

- `SessionManager.spawnSession` headless argv (`src/core/SessionManager.ts`) — **modify (additive)** — splice `--session-id`/`--resume` when the new options are set; no change when absent.
- `ThreadlineRouter.spawnNewThread` resume-entry uuid (`src/threadline/ThreadlineRouter.ts`) — **modify** — save the real minted uuid instead of the placeholder.
- `ThreadlineRouter.resumeThread` prompt + spawn (`src/threadline/ThreadlineRouter.ts`) — **modify** — pass `resumeSessionId` + minimal prompt (drop re-injected history).
- `SpawnRequest`/`SpawnRequestManager.evaluate` forwarding — **modify (additive)** — carry `sessionId`/`resumeSessionId`.

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

None — no allow/block surface. The flags only set/resume the conversation id. No message is rejected. When the new options are absent (every non-A2A spawn), behavior is unchanged. "No block/allow surface — over-block not applicable."

## 2. Under-block

**What failure modes does this still miss?**

Rapid-fire (multiple messages while the reply session is still running): `--resume` on a still-busy session, or a fresh spawn hitting the 30s cooldown, is unchanged by this slice — that is the warm-session follow-up. Also: a `--resume` against a transcript that was deleted/rotated falls back to a fresh spawn (handled by the existing stale-uuid guard), losing that thread's history — acceptable + lossless beyond history.

## 3. Level-of-abstraction fit

The uuid is minted + owned by `ThreadlineRouter` (which owns the resume entry) and threaded down to the spawn primitive — the right layering. `SessionManager` only learns "set/resume this id," mirroring its existing `--resume` (triage) and `extraClaudeFlags` patterns.

## 4. Signal vs authority compliance

Not a gate/authority change. No approval surface added or relaxed. Trust gates on the inbound path are untouched.

## 5. Interactions

- Builds on shipped slices 1+2 (router finds the live session + real tmux name). With this, `get()`'s `jsonlExists(uuid)` now passes legitimately (the transcript exists at the minted id) → resume path fires for spaced follow-ups.
- The relay `spawnSession` callback keeps `codexAllowMcpTools: true` + all MCP/permission flags → the A2A worker still replies via `threadline_send`.
- 1548 threadline/fixes/continuity unit tests pass; tsc clean. One obsolete test (`includes thread history in resume prompt`) replaced — it asserted the now-removed history-re-injection behavior.

## 6. External surfaces

No new HTTP routes, no config defaults, no template/CLAUDE.md change. Pure internal session-lifecycle behavior. Migration-parity: nothing to migrate (no config/hook/template surface).

## 7. Rollback cost

Low — revert the four source files. No persisted-format change (the resume entry already had a `uuid` field; it now holds a real id instead of a placeholder — old placeholder entries simply fail `jsonlExists` and cold-spawn as before). No external dependency.

## Conclusion

Low-risk, additive, deterministic fix that completes the realistic turn-based A2A continuity case on top of the shipped foundation. The mechanism (`--session-id` set + `--resume` reload) was empirically verified before coding. Rapid-fire smoothness is explicitly out of scope.

## Second-pass review (if required)

Not required — Tier 1 (additive, gated, ~single-concern).
