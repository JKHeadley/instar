# Side-Effects Review — project-scope Phase 1b PR 4 (Auto-advance poller + multi-machine claim-ownership)

**Version / slug:** `project-scope-phase1b-pr4`
**Date:** `2026-05-11`
**Author:** `echo`
**Second-pass reviewer:** `required (new periodic-job + new multi-machine ownership transfer surface)`

## Summary of the change

Fourth PR of project-scope Phase 1b. Ships the three pieces the spec
names for multi-machine and time-based round automation:

- `MachineHeartbeat` — per-machine liveness signal at
  `.instar/machine-health/<machineId>.json` (git-synced), updated every
  30 minutes. Consulted by the claim-ownership flow for the 48h
  staleness check.
- `ProjectAutoAdvancePoller` — periodic scan that finds projects
  with `autoAdvanceAt <= now` and bookkeeps the next round
  (clears the timestamp, increments `unacknowledgedAdvanceCount`)
  when the round runner's preflight passes.
- `POST /projects/:id/claim-ownership` — OCC-protected ownership
  transfer with the heartbeat-staleness gate.
- Post-restore reconciler — server startup downgrades any round
  flagged `in-progress` to `pending` (the previous owner may have
  crashed; no TaskFlow exists yet to detect an actually-live run).

Spec source: `docs/specs/PROJECT-SCOPE-SPEC.md` § P5 ("Machine ownership"),
§ Phase 1.3 (HTTP), § Phase 1.5 ("Auto-advance polling"), § Phase 1.12
("Post-restore reconciler").

New files:
- `src/core/MachineHeartbeat.ts` (~160 lines) — write + read +
  isStale + listAll. Machine id is URL-encoded into the file name so a
  stray slash can't escape `.instar/machine-health/`. Periodic timer
  is `.unref()`'d so heartbeats never keep the process alive.
- `src/core/ProjectAutoAdvancePoller.ts` (~140 lines) — `tick()` does
  one pass over `tracker.list({kind:'project', status:'active'})`,
  applies the owner-machine / cap / autoAdvanceAt filters, calls
  `ProjectRoundRunner.preflight`, and either bookkeeps the fire or
  clears the timestamp on structural rejects.
- `tests/unit/MachineHeartbeat.test.ts` (10 cases)
- `tests/unit/ProjectAutoAdvancePoller.test.ts` (7 cases)

Modified files:
- `src/server/routes.ts` (+~65 lines) — `machineHeartbeat` field on
  `RouteContext`. New route `POST /projects/:id/claim-ownership` with
  OCC + heartbeat-staleness gate. Idempotent on already-owns,
  409 on fresh-peer-heartbeat (unless `{force:true}`), 200 with
  `previousOwner` and `ownerMachineId` on success.
- `src/server/AgentServer.ts` (+8 lines) — `machineHeartbeat` field
  on `AgentServerOptions`, threaded into `RouteContext`.
- `src/commands/server.ts` (+~50 lines) — instantiates
  `MachineHeartbeat`, calls `start()`, instantiates
  `ProjectAutoAdvancePoller` and wires a 60-second interval (also
  `.unref()`'d). Runs the post-restore reconciler once at startup,
  best-effort, ignoring OCC races.
- `tests/integration/projects-api.test.ts` (+~110 lines) — 5 new
  integration cases for `/claim-ownership`: idempotent on
  already-owned, refused on fresh peer heartbeat, succeeds on stale
  peer heartbeat, `{force:true}` override, auth + If-Match gates.

## Decision-point inventory

- **Heartbeat staleness gate** (`MachineHeartbeat.isStale`) — **add** —
  returns true when the file is missing, malformed, or older than the
  threshold (default 48h, configurable for tests). Used by
  `/claim-ownership` to decide whether a peer's record is recoverable.
  Conservative: a missing record is treated as stale (consistent with
  the spec's "leader-election fires when no heartbeat").
- **Claim-ownership refusal** (`/claim-ownership` route) — **add** —
  refuses with 409 when the current owner has a fresh heartbeat AND
  `force: true` was not set. Idempotent on already-owns.
- **Auto-advance structural-reject clearing**
  (`ProjectAutoAdvancePoller.tick`) — **add** — rejects from preflight
  that mean "the project structurally cannot advance" (FIRST_LAUNCH_ACK_REQUIRED,
  UNACKED_ADVANCES_OVER_CAP, PROJECT_INACTIVE, PROJECT_HALTED,
  PROJECT_NOT_PROJECT_KIND, PROJECT_NOT_FOUND, TARGET_REPO_PATH_INVALID,
  ROUND_ACK_GAP_TOO_LARGE) cause us to clear `autoAdvanceAt` so we don't
  re-fire every tick. Transient rejects (lock held, items missing
  temporarily) leave the timestamp so a future tick can succeed.
- **Post-restore reconciler downgrade** — **add** — startup-only,
  one-shot. Any project round flagged `in-progress` is reset to
  `pending`. The previous owner may have crashed; no TaskFlow yet
  exists to verify whether a child is actually live. Best-effort — OCC
  races are silently ignored (next reconcile pass will retry).

## Over-block vs under-block analysis

### Auto-advance poller
Over-block: the structural-reject list errs on the side of clearing
`autoAdvanceAt`. The cap-brake (≥2 unacked) is in that list, so if a
user acks the project the timestamp is no longer set — they'd have to
explicitly re-set it (or wait for a completed round to auto-set the
next). Acceptable: requiring an explicit step to re-engage auto-advance
after the brake fires matches the spec's user-attention semantics.

Under-block: the poller skips projects with a different owner machine
silently — no attention queue entry, no telemetry. A user who's
working with a forgotten ownership claim would not see this from the
poller's perspective; they'd need to use `/claim-ownership` or
`/projects/:id` to discover the state. Acceptable: this is the
documented multi-machine semantics, not a failure.

### Claim-ownership
Over-block: refuses 409 when the peer heartbeat is fresh AND no
`{force:true}`. The `force` flag is the documented escape hatch when
two machines genuinely conflict — fairness preserved by recording the
`previousOwner` in the response and by the audit-log entry the route
emits.

Under-block: the route only RECORDS the claim. The spec requires the
caller to commit-and-push the change AND wait 60s for git-sync to
converge BEFORE acting on it. That's a property of the consumer (the
round runner, the auto-advance poller, the dashboard) — not this
endpoint. The endpoint's behavior is correct as a primitive; the
caller-level safety is documented in the spec and enforced when the
autonomous loop ships.

### Heartbeat
Over-block: a malformed heartbeat is treated as stale. A peer with a
corrupted record could lose ownership unexpectedly. The corruption
case is rare (atomic write + rename) and the recovery is one write of
a fresh record.

Under-block: heartbeats are written every 30 minutes. A machine that
sleeps for an hour then wakes up will have a 30-90 minute gap before
the next heartbeat lands. Acceptable: the staleness threshold is 48h
by spec, leaving generous slack for sleep/wake cycles.

## Signal vs authority audit

The poller is **authority** for time-based round advancement bookkeeping
but the *decision to advance* still routes through the round runner's
preflight (the chokepoint). The poller never bypasses preflight.

The heartbeat is **signal** for staleness — the claim-ownership endpoint
uses it as one input to its decision, alongside OCC and `{force}`.
The signal is read-only deterministic, no LLM-mediated judgment.

The post-restore reconciler is **authority** for the narrow case of
"no TaskFlow yet exists" → downgrade-to-pending. It does NOT touch
rounds in any other state. Future TaskFlow integration will provide
the authoritative liveness check.

## Interactions with existing systems

- **`InitiativeTracker.update()`.** Every mutation in this PR
  (auto-advance bookkeeping, claim-ownership, reconciler) goes through
  `update` with OCC. Concurrent writes race through the tracker's
  existing version-mismatch mechanism.
- **`ProjectRoundRunner.preflight()`.** The poller's only entry into
  the runner. Preflight rejects are surfaced verbatim (code + reason)
  to telemetry — no re-interpretation here.
- **Git-sync.** The heartbeat file lives at
  `.instar/machine-health/<machineId>.json` — the GitSync layer treats
  it like any other state file. Per-machine paths mean two machines
  never collide on the same file.
- **Multi-machine coordinator.** `machineId` source: the existing
  `coordinator.identity?.machineId ?? os.hostname()` fallback,
  consistent with PR 3.
- **Scheduler.** Auto-advance poller runs on its own 1-minute
  `setInterval`, not through the existing `JobScheduler` cron system.
  Rationale: the poller is a small, fast scan (millisecond-class on
  typical project sets) and doesn't benefit from the job scheduler's
  rate-limit / quota plumbing. Both timers are `.unref()`'d.

## Rollback cost

Revert deletes `src/core/MachineHeartbeat.ts`,
`src/core/ProjectAutoAdvancePoller.ts`, removes the new ctx field,
drops the `/claim-ownership` route, drops the heartbeat + poller
instantiation from `src/commands/server.ts`. Heartbeat files on disk
become orphaned but harmless. Project records carry the optional
`ownerMachineId` field through unchanged; older code that doesn't
know about it ignores it.

## What this PR explicitly defers

- **Autonomous-delegating `run()` loop.** The poller bookkeeps the
  auto-advance move (increments `unacknowledgedAdvanceCount`, clears
  `autoAdvanceAt`); the actual round-running work waits on `run()`.
  Phase 1b PR 5.
- **`GET /projects/:id/next` real implementation.** Still 501 in PR 4.
  Ships alongside `run()` in PR 5.
- **`POST /projects/:id/resolve-conflict`.** The git-sync conflict
  resolution endpoint. Phase 1.12 work; ships when the git-sync
  conflict path is rebuilt.

## Verification

- `npm run lint` — passes (tsc + lint-no-direct-destructive).
- `npx vitest run tests/integration/projects-api.test.ts
  tests/unit/MachineHeartbeat.test.ts
  tests/unit/ProjectAutoAdvancePoller.test.ts
  tests/unit/ProjectRoundRunner.test.ts
  tests/unit/ProjectRoundLock.test.ts
  tests/unit/route-completeness.test.ts` — 92/92 pass (30 integration
  + 27 runner + 10 heartbeat + 9 lock + 7 poller + 9 route-completeness).
