# Side-Effects Review — health-check runs as its script on development agents; built-in schedule edits survive updates

**Version / slug:** `cmt-1586-health-check-script-schedule-edits`
**Date:** `2026-11-10`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1 (declared): small and fully reversible by revert. 16 files (7 source, 5 test, 4 docs/notes), about 595 added lines; roughly 340 are tests and 175 are docs. Effort: 0 spec review rounds (Tier 1, no converged spec), 1 commit attempt planned.

Two defects from CMT-1586 (topic 130742):

1. **fb-13940f65-ead.** On Echo (a development agent), `health-check` was removed from `jobs.scriptRunners.disabledSlugs` and the server restarted, but `GET /jobs` kept showing `runner: session-rollback`, and a Haiku session still ran every 5 minutes (about 99M tokens a day). Root cause: `JobScheduler.scriptRunnersActiveFor` has a code-owned audit gate. While `JOB_COST_AUDIT_READY.laterScriptJobs` is false, it refuses every slug in `SCRIPT_RUNNER_FIRST_WAVE_DISABLED_SLUGS` that is not in `AUDIT_READY_SCRIPT_SLUGS` (which held only `llm-decision-grading`). Config cannot open it by design. The missing lock file (`untrusted-no-lockfile`) is a red herring: it is the documented state for unsigned local builds, and `checkScriptTrust` runs it. Fix: add `health-check` to `AUDIT_READY_SCRIPT_SLUGS` (`src/scheduler/JobCostAuditReadiness.ts`). The gate exists so that no new model call activates before it is audited (Justin, topic 130742, 2026-10-27 08:41 PDT: "ALL calls to Jev or ANY LLM should abide by our benchmark auditing standards"). The health-check script reads only the authenticated `/health` and disk space. Its Jev triage, outage backup and triage sessions stay closed in code (`buildScriptTriageConfigGetter` forces `enabled: false`; `resultTriage: false`), and anomaly narration is deterministic. So a script run adds no new model call and removes an unaudited Haiku session. Two existing paths apply to script runs exactly as they already apply to session runs, so neither is new. (a) `jevAudit.capture` records the run; if the Jev job-completion audit is enabled in config, its nightly batch may grade it. (b) An anomaly push goes out through `/telegram/reply`, whose outbound tone gate reviews it. `script-job-supervisor` stays inactive (its LLM call is not audited), which is correct and unchanged.
2. **fb-d075a5c4-c4c.** `installBuiltinJobs` (run on every update by `PostUpdateMigrator.migrateBuiltinJobs`) regenerated `.instar/jobs/schedule/<slug>.json` from the template, preserving only `enabled` and `disabledAtBodyHash`. The 07:32 update therefore reset Echo's health-check `*/10` to `*/5`. Fix: each install writes `shippedSchedule` (the template's schedule). On the next install, a saved `schedule` that differs from the saved `shippedSchedule` is an operator edit and is kept, if it parses as cron. Otherwise the new shipped value is used. A manifest from before this field cannot be told apart and takes the shipped value once (today's behaviour); edits after that are kept. Files: `InstallBuiltinJobs.ts`, `buildPerSlugManifest.ts`, `AgentMdJobLoader.ts` (type only), `routes.ts` (fork drops the field), CLAUDE.md template + migration + framework mirror (`BUILTIN_SCHEDULE_EDIT_AWARENESS`).

Spec note: `docs/specs/job-cost-reduction.md` §11 is amended with the health-check addition and its reason.

## Decision-point inventory

- `JobScheduler.scriptRunnersActiveFor` audit gate — modify (data only) — one more slug in the code-owned no-model allowlist. The gate's logic is unchanged.
- `installBuiltinJobs` manifest regeneration — modify — keeps an operator-edited `schedule`. This is a preservation rule, not a block/allow decision.

---

## 1. Over-block

No new block surface. The audit gate becomes less restrictive for one slug only.

---

## 2. Under-block

- The gate now lets `health-check` run as a script on development agents. If a later change gives the health-check script a model call, or turns on `resultTriage`, the allowlist entry would let that call through without re-review. Mitigations: the allowlist comment states the no-model condition, and opening `resultTriage` is its own audited change that covers every triage job, health-check included.
- Schedule: an operator edit made before this ships (Echo's `*/10`) was already lost and is not restored. The operator re-applies it once after this update. The CLAUDE.md bullet says so.
- Schedule: an operator who edits `shippedSchedule` by hand can defeat detection. That is deliberate tampering with an internal field; the result is only the wrong schedule, never a security effect.

---

## 3. Level-of-abstraction fit

Right layer. The audit gate is the single code-owned authority for "may this slug run as a script before its family is audited"; the fix changes its data, not its logic. Config cannot widen it, and that stays true. Schedule preservation belongs in the installer: it is the only writer that regenerates built-in manifests, and it already preserves `enabled` and `disabledAtBodyHash` the same way.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The audit gate's authority and logic are unchanged. One slug is added to the code-owned set that authority reads. The installer change preserves data and makes no block/allow decision.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. "Saved schedule differs from the recorded shipped schedule" is an enumerable invariant (either the operator changed it or they didn't), not a judgment.

---

## 5. Interactions

- **Shadowing:** the per-slug supervision holds (`held_slugs`, census health, write failures) run before the audit gate, and they still apply to health-check. On Echo today, `llm-decision-grading` is held for `independent-history-mismatch`; health-check is not held. The default `disabledSlugs` and the development-agent gate run after it, and still apply.
- **Double-fire:** while health-check runs as a script, no rollback session fires (it is one or the other per trigger). The result-triage pipeline that would add sessions is code-dark.
- **Races:** none new. `scriptRunnersActiveFor` is read live at each trigger, as before.
- **Fork:** `POST /jobs/:slug/override` copies the manifest into a user job. It now drops `shippedSchedule`, so a user job owns its schedule outright and portable bundles don't gain another unknown key. (Forks already carried `forkedAt`, which the portable key list also rejects. That is unchanged and outside this fix; filed as fb-9175ccc0-66d.)
- **Migration invariant 2 (schedule drift):** this applies to the `jobs.json` → agentmd migration, comparing against `jobs.json` entries. Unaffected.
- **Daily canary:** the script-canary timer starts once any script job is active (`AgentServer.ts` canary wiring). On Echo, `llm-decision-grading` is held, so health-check may be the first active script job. That starts daily must-fail canary passes over the listed script jobs (`ScriptCanaryRunner`). They are deterministic and call no model, but a failing canary raises an attention item. This is the designed coverage for script jobs, now reached.
- **Unfork:** unforking returns a manifest with no `shippedSchedule`, so the next update resets that schedule to the shipped value once (the legacy case). The CLAUDE.md bullet covers re-applying.
- **Feedback loops:** none.

---

## 6. External surfaces

- **Fleet:** unchanged. Fleet agents don't set `developmentAgent`, so the gate keeps health-check on its session, and the shipped default `disabledSlugs` still lists it. Pinned by unit, integration and e2e tests.
- **Agents whose script runners are on and that removed health-check from `disabledSlugs`:** health-check runs as a script and `GET /jobs` shows `runner: script`. Script runners are on for development agents by default, or for any agent that explicitly set `jobs.scriptRunners.enabled: true`. Echo's config already omits health-check. I have not surveyed other agents' configs; any agent in this state made that choice explicitly.
- **Persistent state:** built-in manifests gain a `shippedSchedule` key on the next update. Older builds ignore it (loose manifest validation), and a downgrade takes the shipped schedule, which is today's behaviour.
- **CLAUDE.md:** one new Job Scheduler bullet, content-sniffed on `shippedSchedule`, and mirrored to other frameworks' instruction files.
- **Operator surface:** no operator-facing actions added. Schedule edits are agent-performed file edits, as before.

---

## 6b. Operator-surface quality

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design**, unchanged. The script-runner gate reads each machine's own config and runs that machine's jobs. Built-in manifests live in each machine's `.instar/jobs/schedule/` and each machine's installer preserves its own edits. This matches how `enabled` is already preserved. No notices, no new durable cross-machine state, no URLs. No status surface changes; `GET /jobs` (and `?scope=pool`) already report `runner` per machine.

---

## 8. Rollback cost

Pure code revert, then a patch release. Live, per agent and with no restart, putting `health-check` back in `jobs.scriptRunners.disabledSlugs` returns it to the session path (tested). For schedule preservation, the extra `shippedSchedule` key is harmless after a revert: older code ignores it and goes back to overwriting the schedule.

---

## Conclusion

Both causes were found by reading the running build, not guessed. The live Echo build ships the same `AUDIT_READY_SCRIPT_SLUGS = {llm-decision-grading}`, and the ledger shows no hold on health-check. Both fixes are minimal and keep fleet behaviour. The review led to one design change: dropping `shippedSchedule` on fork. Clear to ship once the second-pass reviewer concurs.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose reviewer subagent (read-only), 2026-11-10
**Independent read of the artifact:** concur

It confirmed: no new model call (triage, backup, narration, supervision and daily supervisor are all closed, with file:line evidence); fleet unchanged; schedule preservation falls back safely in every case (legacy, malformed, blank, invalid cron); DisabledBodyDrift and the route's read-modify-write keep the field. It asked for four accuracy fixes, all applied above: qualify "zero model calls" (existing Jev completion audit capture and outbound tone gate), the daily canary activation, the explicit `scriptRunners.enabled: true` opt-in edge, and the unfork legacy reset. It also noted the unsupported "Echo only" claim, which was replaced.

---

## Evidence pointers

- `tests/unit/job-cost-runner/JobScheduler-script-runner.test.ts`: health-check active on a development agent once config omits it; live rollback by re-listing; fleet stays off; later waves stay code-gated.
- `tests/integration/health-check-script-runner-route.test.ts`: the real `GET /jobs` reports `script` / `session-rollback` across the same cases.
- `tests/e2e/job-cost-lifecycle.test.ts`: the shipped health-check script runs through the production scheduler with zero sessions and `tokens: 0`; re-listing spawns the rollback session.
- `tests/unit/scheduler/InstallBuiltinJobs.test.ts`: schedule edit kept across an update (also when the default changes), unedited follows the default, edit back rejoins, legacy manifest, invalid cron reset, loader schedules the edit.
- `tests/unit/PostUpdateMigrator-builtinScheduleEdit.test.ts`: migration parity through `migrateBuiltinJobs` with the real shipped health-check template; CLAUDE.md bullet idempotent.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect: both defects are in scheduler/installer source code.

- **`defectClass`:** `unbounded-self-action`
- **`closure`:** `n/a`. No self-triggered controller is added or changed. An existing cron job (health-check) runs its script instead of spawning a session on development agents, so there are fewer spawns. The schedule change only preserves an operator-chosen cron in a manifest.
