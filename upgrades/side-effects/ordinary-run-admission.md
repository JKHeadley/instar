# Side-Effects Review — ordinary autonomous runs can be admitted

**Version / slug:** `ordinary-run-admission`
**Date:** `2026-10-09`
**Author:** `echo`
**Second-pass reviewer:** `not-required (Tier 1; opt-in, default off; see §4)`

## Summary of the change

The window-run liveness authority (Echo-only, dev-gated) marks a run `active` only when five predicates pass. The `lifecycle-admitted-unexpired` predicate was fed only from the echo window-ritual ledger, which an ordinary topic run never has, so an ordinary run could never become active. Two traps blocked the same runs: a binding registered with the Claude session UUID as executor id could never be corrected (register refused any differing binding), and the autonomous skill's example task list used numbered `1. [ ]` lines the server's task parser does not read, so no work receipt could be minted.

- `src/core/WindowRunLivenessAuthority.ts`: `register()` executor-only correction for a never-evaluated `preparing` binding (no transitions, no work receipt, every other field equal); records `bindingCorrection`. New pure `resolveWindowRunSampleLifecycle()`.
- `src/server/AgentServer.ts`: the liveness `sample()` builds its lifecycle via that function, passing the live `monitoring.windowRunLiveness.ordinaryRunLifecycle` flag (falls back to static config when no live-config reader is wired).
- `src/core/types.ts`: the new optional flag with a one-line doc.
- `.claude/skills/autonomous/SKILL.md` + `src/core/PostUpdateMigrator.ts`: dash-bullet example, `CHECKBOX_TASK_LIST` marker, marker-bump upgrade from `W32_PREPARING_LIVENESS`.

## Decision-point inventory

- `register()` duplicate-binding refusal — **modify** — one narrow new accept path.
- Liveness sample lifecycle — **modify** — new opt-in admission source; flag off is byte-identical in outcome.
- Skill re-deploy — **add** — marker bump, same fingerprint-gated mechanism as the previous bumps.

## 1. Over-block

None added. Both code changes only widen what is accepted.

## 2. Under-block

- **Executor correction.** A binding with a wrong executor id that has already ticked (has a transition) still cannot be corrected; it must run its course to a terminal state. Deliberate: once a verdict has been recorded on a binding, rewriting its executor would rewrite history.
- **Ordinary-run admission.** Admission rests on the run's own server registration being open and before `endAt`. It does not prove the run is doing useful work — the other four predicates (bound running executor, fresh heartbeat, delivery reachable, fresh server-minted work receipt) still must pass, and they are untouched. A run registered with a very long `endAt` stays admitted until then; the registration route already clamps the duration ceiling.

## 3. Level-of-abstraction fit

The lifecycle decision now lives in a pure function in the authority module, next to the type it produces, so both sides are unit-tested without a server. The server keeps the I/O (reading the ledger, the run store and config). The skill fix is at the source of the bad format (the example agents copy), not a parser change; widening the parser to numbered lists would change what counts as a task for every existing state file.

## 4. Signal vs authority compliance

- [x] No — this change has no judgment-based block/allow surface.

The liveness authority's decision logic is unchanged; this changes what evidence feeds one predicate, behind an explicit opt-in that defaults to false. The admission source is structural (an open server-minted registration whose run id equals the binding), not inferred from text. The executor correction is a structural equality check on every other binding field plus "never evaluated". Tier 1 declared: small, opt-in, default off, already proven live on the dev agent.

## 5. Interactions

- Ritual windows: when the ledger claims the window (its `windowId` equals the binding's), the new path is never taken, flag on or off; tested.
- Cadence executor and recovery: unchanged; they read the authority's state, which now can reach `active` for an ordinary run when opted in.
- Preparation carrier: promotion requires `active:true` from independent admission; this is what makes that reachable for ordinary runs.
- Stop hook: after a correction the record's `session_id` holds the tmux name; the hook treats a non-UUID as empty and re-records the live UUID (observed live, harmless).

## 6. External surfaces

`GET /window-run-liveness` may now show `bindingCorrection`, and a lifecycle state `autonomous-run-registered`. The authority is Echo-only (`projectName === 'echo'`) and dev-gated, so fleet agents see nothing. The skill migration reaches every agent with a stock autonomous skill; it changes only the example text and adds a format note.

## 7. Multi-machine posture

Machine-local by design: the liveness document, the run store and the window ledger are all per-machine state on the machine running the run; the flag is per-machine config. A moved topic's run re-registers on its new machine.

## 8. Rollback cost

Set `monitoring.windowRunLiveness.ordinaryRunLifecycle: false` (read live, no restart) to stop admitting ordinary runs. The executor-correction path and the skill text are safe to leave; a full revert is a normal hot-fix release. No data migration: `bindingCorrection` is an optional field older code ignores.
