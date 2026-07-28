# Side-Effects Review — Codey gap-run fixes, batch 2

**Version / slug:** `codey-gap-run-fixes-batch-2`
**Date:** `2026-05-31`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Two more verified Codey gap-run fixes, ported to current main. F005: `script`-type jobs
execute directly in a bounded subprocess (`runScriptJob`) instead of spawning a model
session, branched before the session-capacity check so they never hold a slot. F009:
disabled/retired per-slug manifests load as disabled `JobDefinition`s without requiring
a markdown body, so they can shadow stale legacy `jobs.json` entries.

## Decision-point inventory

- **F005 — `triggerJob` script-vs-non-script branch.** Both sides tested: a script job is
  dispatched via `runScriptJob` (no session, runs even at the cap); non-script jobs are
  unchanged (existing suite passes).
- **F005 — `runScriptJob` success/failure paths.** Success records `success`; failure/
  timeout records `failure`/`timeout`, bumps `consecutiveFailures`, schedules a retry.
- **F009 — `loadAgentMdJobs` enabled-vs-disabled branch.** Both sides tested: disabled
  manifest → disabled job (no body needed); enabled agentmd → still requires a body.

## 1. Over-block

**What legitimate inputs does this change reject?** None. F005 changes the dispatch
mechanism for an existing job class, not its admissibility. F009 stops *dropping* a
disabled manifest — it admits more (a disabled, non-running job), never fewer.

## 2. Under-block

**What does this still miss?** F005: a script job that exceeds 2× its expected duration
is killed by the subprocess timeout and recorded as `timeout` (intended — that is the
hang guard). F009: only the disabled-manifest path is short-circuited; enabled agentmd
jobs still need a hydrated body. F006 (gate-noise flag) is out of this batch.

## 3. Level-of-abstraction fit

**Right layer?** Yes. F005 lives in `JobScheduler.triggerJob` (the single dispatch
chokepoint) + a `runScriptJob` sibling of `spawnJobSession`, reusing the same
`computeRunObservability` / `runHistory` / `state` / `claimManager` plumbing. F009 lives
in `loadAgentMdJobs` (the single manifest→JobDefinition loop).

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No blocking authority added. `runScriptJob` is bounded (timeout, capped output buffer)
and records outcomes through the same audit path as model jobs. F009 is a loader
robustness change with no gating.

## 5. Interactions

- **F005 ↔ session capacity / queue:** branching before the capacity check means script
  jobs never enqueue and never dequeue into a model spawn — the queue/dequeue path
  (`spawnJobSession`) is now reached only by non-script jobs. The `buildPrompt` `case
  'script'` remains for `switch` exhaustiveness but is no longer hit on the normal path.
- **F005 ↔ claims:** `runScriptJob` calls `claimManager.completeClaim` on success/failure,
  matching the model path's claim lifecycle.
- **F009 ↔ legacy jobs.json:** a disabled manifest now reaches the in-memory job list and
  shadows a same-slug legacy entry per the existing per-slug precedence rule.
- No interaction with sentinels, the SessionReaper, or any gate.

## 6. External surfaces

No new HTTP routes, no config keys, no Telegram. F005 changes a `script` job's execution
mechanism (subprocess vs session) — observable as a `script-<slug>-...` run-history entry
instead of a `job-<slug>-...` session. F009 changes which jobs the loader returns
(disabled retired manifests are now present + disabled). No agent-installed file
(`.claude/settings.json`, `.instar/config.json`, CLAUDE.md template, hook, skill, or job
template) is touched in this batch, so the Migration Parity Standard does not apply here
(it is exactly why F006 — which DOES touch job templates — is held for its own migration).
