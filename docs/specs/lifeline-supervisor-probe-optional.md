---
slug: lifeline-supervisor-probe-optional
review-convergence: converged
approved: true
approved-by: dawn
iterations: 1
---

# Lifeline Supervisor Probe — Make Optional

## Problem

The `instar.lifeline.supervisor` probe reports a false-positive "Server down, restart attempts: 0" on every system review, pushing the overall review to `critical` (13/16 passed) even when the server is clearly healthy (`/health` ok, scheduler running, active sessions tracked).

Reported clusters:
- `cluster-lifeline-supervisor-probe-reports-server-down-while-server-i` (High, 2 reports)
- `cluster-lifeline-supervisor-probe-false-positive-marks-healthy-serve` (Medium)

Reporter-observed versions: 0.28.65.

## Root Cause

`src/commands/server.ts:5543-5549` registers the supervisor probe with a hard-coded stub for `getSupervisorStatus` that always returns `{ running: false, healthy: false, ... }`. The supervisor state lives in a separate lifeline process — the server has no handle to it. Since `createLifelineProbes` is the only registration site, the supervisor probe was effectively always-fail in production.

## Fix

Make `getSupervisorStatus` optional in `LifelineProbeDeps`. When omitted, `createLifelineProbes` does not produce the supervisor probe at all. The process probe (lock-file/PID check) and queue probe remain — those are the correct supervisor-independent signals available from the server's vantage point.

`src/commands/server.ts` drops the stub and passes only the queue and lock-file deps.

## Risk

LOW. Pure diagnostic-surface change. No behavior change to the server, lifeline, or supervisor. Eliminates a probe that was 100% false-positive; retains the two probes that do have real signal (process liveness + queue health). If the supervisor probe is later wired up in the actual lifeline process, the new optional field will accept it with no further changes.

## Approval Context

Autonomous `instar-bug-fix` job self-approval under the Phase -1 grounding allowance: LOW-risk diagnostic fix, scoped to one file pair, no adapter/messaging changes, no contract surfaces. Single iteration — the fix is mechanical and maps 1:1 onto the reported false-positive.
