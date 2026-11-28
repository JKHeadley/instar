---
title: "Usage limit reaches jobs, /health status and /quota"
slug: "feedback-feedback-87c7e291-c3b3-4a5b-b80d-ef4bbfcb6a12"
author: "echo"
parent-spec: "docs/specs/usage-wall-rescue.md"
---

# Usage limit reaches jobs, /health status and /quota

Feedback: `feedback-87c7e291-c3b3-4a5b-b80d-ef4bbfcb6a12` (cluster
`cluster-a-key-only-agent-that-runs-out-of-weekly-claude-usage-goes-s`, severity critical).

## Problem statement

The report was measured on a key-only agent (1.3.1651, 2026-11-04). When the weekly Claude
usage ran out, `claude -p` printed "You've hit your weekly limit" and exited 1. Then:

1. A Slack person saw the standby's "actively working" line and then nothing.
2. New job sessions died about 20 s after starting.
3. `/health` kept `claudeKey` at `ok`. A usage limit is not a 401, and the top-level status stayed `ok`.
4. `/quota` reported `no_data`.
5. Nothing reached the Slack attention channel. Neither operator was a member of it.

The reporter asked for three things: tell the operator plainly, tell each waiting person, and
keep messages until usage comes back.

### What current code already covers

Most of this shipped on 2026-11-07, after the report, in `src/core/UsageLimitWatch.ts`
(#2898, #2937):

- A conversation session that settles at the limit banner fires the watchdog's `usage-wall`
  event. Its transcript confirms the event, and the watch then opens a limited state.
  `noteCallLimited()` does the same for internal calls refused for usage. A real probe ends
  the limited state.
- The standby reads `personNotice()`, so a waiting person hears
  "I've run out of Claude usage…" and not "actively working" (item 1).
- The operator gets `operatorLimitText`, and an all-clear when usage is back. The notice goes
  through `deliverOperatorNotice` (`src/core/claudeKeyRecovery.ts`). That function skips an
  attention channel where no operator is a member and sends direct messages instead (item 5).
- Walled conversations persist in `usage-limit-watch.json`. When usage is back they restart
  with their held messages, or the person is asked to send again.
- Authenticated `/health` shows `claudeUsage: { status: 'limited', since, resets }`.

### Remaining gaps (this spec)

- **G1. Jobs are not covered.** Three places miss them:
  - The `usage-wall` event fires only for a session that *settles* on the banner. A job session
    that exits within ~20 s never fires it.
  - `listWalledSessions` skips `jobSlug` sessions.
  - `JobScheduler`'s `canRunJob` gate never consults `isLimited()`.

  So while the agent is limited, every scheduled Claude job spawns a session, burns a slot, dies
  and gets reported as a generic failure. If jobs are the only Claude traffic, nothing opens
  the limited state at all, and the operator is never told (item 2).
- **G2. The `/health` top-level status stays `ok`.** `isDegraded` in `src/server/routes.ts`
  includes `activeClaudeKeyHealth()…status === 'dead'` but has no usage-limit term. Monitors
  that read only `status` see a healthy agent that cannot answer anyone (item 3).
- **G3. `/quota` says `no_data`.** The route reads only `quotaTracker.getState()`, which a
  key-only agent never fills. The limit that is known never shows there (item 4).

## Proposed design

All three changes read the existing `UsageLimitWatch` state. None adds a new detector,
network call, shell-out, credential read or configuration switch. The probe stays the only
authority for whether the agent is limited, as it is today.

### G1. Job deaths and the job gate

1. **Signal from a job death.** In `JobScheduler`'s completion path, the session-death
   classification already runs (`classifySessionDeath`). When a failed Claude job is
   classified as `quota`, the scheduler calls an optional injected hook,
   `onUsageLimitedDeath?: (slug) => void`. `server.ts` wires that hook to
   `usageLimitWatch.noteCallLimited()`. This is a signal only: `noteCallLimited` is already
   rate-limited (`SIGNAL_MIN_PROBE_INTERVAL_MS`), returns early when another pool account has
   room, and opens the limit only on the probe's `limited` answer. Pane text never opens the
   limit by itself.
2. **Gate while limited.** The two `scheduler.canRunJob = …` compositions in `server.ts` check
   one more thing first. If `activeUsageLimitWatch()?.isLimited()` is true and the job would
   run on `claude-code`, the gate returns
   `{ allowed: false, reason: 'quota', detail: 'claude usage limited' }`. That reuses the
   existing `SkipReason` and the existing `scheduleRetry` path, so the job is deferred, not
   lost. Script jobs already bypass the gate. Jobs on other frameworks are not gated.
3. **Job notice.** When a job is skipped because of the limit, the job's own summary does not
   send a failure notice. The operator notice from `UsageLimitWatch` (sent once, with a
   6-hour gap) covers it, so there is no new notification channel.

`listWalledSessions` keeps skipping job sessions. A deferred job reruns on its own schedule
once `isLimited()` is false, so jobs need no restart-with-held-messages.

### G2. /health status

Add `|| activeUsageLimitWatch()?.isLimited() === true` to `isDegraded`, next to the key-dead
term. That changes only the reported `status` string. Unauthenticated callers already get
`status`, so they learn only that the agent is degraded, not why. `claudeUsage` details stay
authenticated-only.

### G3. /quota

When `activeUsageLimitWatch()?.status()` is non-null, `/quota` adds `claudeUsage` with the same
shape as in `/health`. If there is no tracker state, the top-level `status` becomes `'limited'`
instead of `'no_data'`. When tracker state exists, it is returned unchanged and `claudeUsage`
sits beside it. When the agent is not limited, the response is byte-identical to today's.

## Decision points touched

- `JobScheduler` death handling: a new **signal** (`onUsageLimitedDeath`). The authority stays
  `UsageLimitWatch`'s probe.
- The `canRunJob` composition: a new deterministic **block** while the probe-proven limited
  state is true. It applies to `claude-code` jobs only and fails open when the watch is absent.
- The `/health` `isDegraded` and `/quota` status: **reporting** only.

## Regression tests

All tests are hermetic Vitest tests. They use injected fakes and a fresh `fs.mkdtempSync`
directory for any state file, with no network, no home-directory paths and no credentials.
Each test fails on current code.

1. `tests/unit/usage-limit-jobs.test.ts`
   - *"a Claude job that dies at the usage limit asks the usage watch for a probe"*: drive
     `JobScheduler` completion with a failed job whose captured output holds the weekly-limit
     banner. Assert that the injected `onUsageLimitedDeath` is called once with the slug.
     Today the hook does not exist, so nothing is called.
   - *"while usage is limited a Claude job is deferred, not spawned"*: give the gate
     composition a fake watch with `isLimited() === true`. Trigger a `claude-code` job. Assert
     the result is `'skipped'`, the gate reason is `quota` with detail `claude usage limited`,
     a retry is scheduled, and no session spawn is attempted. Repeat with
     `isLimited() === false` and assert a normal spawn. Repeat with a script job and with a
     non-Claude framework while limited, and assert neither is blocked.
2. `tests/unit/usage-limit-health-quota.test.ts`
   - *"/health reports degraded while Claude usage is limited"*: register a fake active watch
     whose `status()` is limited, with no other degradations. Assert `status === 'degraded'`.
   - *"/quota shows the usage limit instead of no_data"*: with no tracker state and a limited
     watch, assert `status === 'limited'` and that `claudeUsage.resets` is the banner's reset
     text. With the watch not limited, assert the response equals today's `no_data` shape.

The existing `usage-limit-watch.test.ts`, `usage-limit-key-pickup.test.ts` and
`usage-limit-notice-regression.test.ts` stay as they are and must keep passing.

## Acceptance criteria

1. On a key-only agent with exhausted usage and only scheduled jobs running, the limited state
   opens after the probe confirms it. The operator is told once, and later job runs are
   deferred with reason `quota` / `claude usage limited` until the probe reads `ok`.
2. `/health.status` is `degraded` while limited and returns to its prior value after recovery.
3. `/quota` shows `claudeUsage` while limited and is unchanged otherwise.
4. Conversation behavior (person notice, operator routing, held-message recovery) is unchanged.

## Out of scope

Making the attention channel's membership correct is an operator setup matter. Operator
notices already fall back to direct messages. Adding pool accounts or changing usage-wall
rescue is also out of scope.
