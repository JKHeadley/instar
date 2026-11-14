# Side-Effects Review — Skill Learning Sentinel, slice 0 (the repairs the spec depends on)

**Version / slug:** `skill-learning-sentinel-slice0`
**Date:** `2026-11-06`
**Author:** `echo`
**Second-pass reviewer:** `echo (reviewer subagent) — required: touches a boot path, session spawn, and a reconcile that writes skill files`

**Spec:** `docs/specs/skill-learning-sentinel.md` (converged 7 rounds, `approved: true` by Justin, topic 139880,
2026-11-06). This slice is §6 "slice 0" and Frontloaded Decisions 6, 7, 18, 19, 20, 21, 28, 29.
**Tier:** 2 (fleet-wide migration + hook rewrite + a boot-time writer). **Size:** see PR body.

## Summary of the change

Slice 0 repairs two pieces of existing design that were built but never worked, and adds the per-machine
plumbing the sentinel needs before it can observe anything:

1. **Canonical skills backfill** (`migrateSkillsCanonicalBackfill` in `PostUpdateMigrator`): the Skill concept
   spec (approved 2026-05-19) deferred the migration that fills `.instar/skills/` from existing `.claude/skills/`
   and `.agents/skills/`; it never shipped, so the parity rule was a structural no-op on every real agent.
   Copy-only, idempotent, conflict policy per decision 6 (`.claude` copy becomes canonical; a differing `.agents`
   copy is left untouched and logged; nothing deleted); renderings are stamped. `installBuiltinSkills()` now writes
   canonical first and renders through the parity rule.
2. **Skill-use telemetry hook rewrite** (`getSkillUsageTelemetryHook`): the old hook echoed raw `args` into JSON
   (8 of 51 rows unparseable on this agent) and wrote one git-tracked file every machine appended to. The new hook
   emits one python-built JSON row with no free text (`ts, skill, session_id, session_name, topic_id, machine_id,
   content_hash`) to a per-machine file under `.instar/skill-telemetry/`. `SessionManager` exports
   `INSTAR_MACHINE_ID` (and `INSTAR_TOPIC_ID` where known) beside `INSTAR_SESSION_NAME` at the four tmux spawn
   sites; `SessionMaintenanceRunner` rotates the new directory; the legacy flat file is gitignored.
3. **Every-machine reconcile** (`LearnedSkillReconciler`): renderings live outside `stateDir` and never sync, and
   `FrameworkParitySentinel` is never constructed, so nothing re-renders at runtime on any machine. The reconciler
   renders `instar-learned` canonicals (only those) at boot (after the boot pull) and on a 10-minute tick —
   verify-then-render,
   with a per-machine baseline shard so an operator's local edit is detected and never overwritten, journaled
   transitions, and the renderer patched to temp+rename.
4. **Backups, config defaults, gitignore:** `BackupManager.includeFiles` gains the new paths; `migrateConfig` adds
   the `monitoring.skillLearning` block with `enabled: false`; the state db and legacy telemetry file are
   gitignored; `feature-ladders.json` gains the `monitoring.skillLearning` entry (with the live kill switch
   `monitoring.skillLearning.reconcile.enabled`, default true); `skill.md` records that its backfill claim was not
   carried until now. `migrateBuiltinSkillRenderings` renders absent framework layouts for EVERY canonical skill
   (additive, never overwriting), not only built-ins.

Files: `src/core/PostUpdateMigrator.ts`, `src/core/SessionManager.ts`, `src/core/SessionMaintenanceRunner.ts`,
`src/providers/parity/rules/skillParityRule.ts` (renderer write only), `src/monitoring/LearnedSkillReconciler.ts`
(new), boot/tick wiring in the server (an `onPulled` seam on `SyncOrchestrator` is added but has no production
caller today — `SyncOrchestrator` is not constructed in `src/`; the hourly git-sync job's pulls are covered by the
tick, not by a post-pull hook), `src/core/BackupManager.ts`, `src/config/ConfigDefaults.ts`, config types,
`src/data/feature-ladders.json`, `specs/instar-concepts/skill.md`, tests: unit (including integration-shaped cases) and an e2e boot test; a route-level integration tier arrives with slice 1's routes.

## Decision-point inventory

- `LearnedSkillReconciler` edit protection — **add** — a deterministic floor: a rendering whose content differs
  from its baseline, or has a stale stamp with no baseline, is marked `user-edit-conflict` and is never written.
  This is a safety guard on an irreversible action (overwriting an operator's hand edit), the documented exemption
  class in `docs/signal-vs-authority.md`.
- Canonical backfill conflict policy — **add** — enumerable domain (`.claude` wins, `.agents` differs → leave +
  log). No judgment, no model.
- Telemetry hook validation (`SLUG_RE`, machine-id grammar, `re.fullmatch`) — **add** — structural validators at a
  boundary. Sessions without `INSTAR_MACHINE_ID` fall back to `.instar/machine/identity.json`; a residual
  `unknown.jsonl` is git-ignored so no shared file ever syncs.
- No message-flow, dispatch, spawn-admission or session-lifecycle decision is added or changed. The spawn sites
  gain an environment variable only.

---

## 1. Over-block

The reconcile refuses to render when a rendering has no baseline and a stale stamp — on every machine's **first
boot after this update**, every learned rendering is in exactly that state (no baseline yet). Consequence: on first
boot a rendering whose stamp is stale and that has no baseline is locked as `unknown-provenance` and left as-is.
Mitigation built in: in the same first pass the reconciler seeds the baseline from renderings whose stamp matches
the current canonical (verified in sync) and renders missing ones, so only genuinely stale renderings lock. A lock
is not self-healing: it clears only when the operator makes the rendering equal canonical or removes it (then it is
rendered as missing); until slice 1 ships the status route, locks are visible only in the boot log line. There are
**no learned skills on any agent yet** (the sentinel that writes them is slices 1–3), so the practical over-block
surface at ship time is empty; hand-written skills are never touched.

The backfill skips a directory whose name fails the slug grammar (logged). A hand-written skill with an uppercase
or dotted directory name stays where it is and is not made canonical — it keeps working as before.

## 2. Under-block

- A rendering edited by an operator **between** a render and the baseline write is journaled; a crash exactly
  there is recovered from the journal, but an edit that lands in the same instant as the recovery is attributed
  to the system write. Window: milliseconds, one machine, learned skills only.
- The hook's `content_hash` is read when the hook runs, not when the Skill tool read the file (the spec labels
  this `stamp-at-hook`); a render in that window is bucketed `version-uncertain` by slice 1, not by this slice.
- The backfill cannot know whether an `.agents` copy that differs from the `.claude` copy is the newer one; it
  logs and leaves it unstamped (decision 6). Because `migrateParityRenderings` refuses only a `user-edit-conflict`,
  that copy is overwritten from canonical on the next enabled-framework-set change — spec-conformant (canonical is
  authoritative), named here so it is not a surprise.

## 3. Level-of-abstraction fit

Migrations live where every other agent-installed-file change lives (`PostUpdateMigrator`, Migration Parity
Standard). The reconciler is its own small module rather than a change to `FrameworkParitySentinel`, because that
sentinel is unconstructed and owns a broader contract (all primitives, all skills); this slice deliberately
reconciles learned skills only. The hook remains a bash PostToolUse hook (the Skill tool has no other seam).

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface over messages, dispatch or agent intent.
- [x] The only deterministic refusal (never overwrite an operator's edit) is a safety guard on an irreversible
  action — the exemption class the principle names.

## 4b. Judgment-point check (Judgment Within Floors standard)

No competing-signals decision point is added. The reconcile's rule is enumerable (hash equal / not equal /
absent). The tick interval (10 min) is scheduling mechanics, not a behaviour cap. The spec's judgment points
(draft / retire / cost) are slices 1–3 and are not touched here.

---

## 5. Interactions

- **Shadowing:** `migrateParityRenderings` currently skips with "no canonical instances found"; after the
  backfill it finds instances and will render — this is the intended wake-up of existing design, and the stamps
  the backfill writes make verify report "in sync" so no mass re-render happens.
- **Double-fire:** the reconciler and `migrateParityRenderings` can both render at update boot. Order: migrations
  first (they run before the server constructs sentinels), reconciler after; both are idempotent on an in-sync
  rendering (verify-then-render writes nothing).
- **Races:** two machines never write the same baseline/journal file (per-machine shards). The renderer's
  temp+rename removes the partial-file read a live session could hit mid-write.
- **Feedback loops:** none; the hook writes a row, nothing reads it until slice 1.
- `SessionMaintenanceRunner` rotation gains a directory; the legacy flat file keeps its entry.

## 6. External surfaces

- Other agents on the machine: none (agent-home scoped).
- Install base: every agent receives the backfill, the hook rewrite and the config default on its next update
  (Migration Parity). The backfill copies files; it deletes nothing. The hook change alters the telemetry row
  shape — the only reader shipped so far is this spec's slice 1.
- External systems: none.
- Persistent state: new dirs `.instar/skills/` (populated), `.instar/skill-telemetry/`,
  `.instar/skill-learning/{rendered-baselines,journal}/`; new config block; two gitignore lines; backup entries.
- Operator surface: none added in this slice (console section is slice 1).

## 6b. Operator-surface quality

Not applicable — no dashboard, approval page or form is touched in this slice.

## 7. Multi-machine posture (Cross-Machine Coherence)

- Canonical skills (`.instar/skills/`): **replicated** — inside `stateDir`, git-synced like every `.instar/` file.
- Renderings (`.claude/skills/`, `.agents/skills/`): **unified by reconcile** — outside `stateDir`, never synced;
  every machine re-derives them from synced canonical (boot, post-pull, tick). This is the gap the slice closes.
- Baseline shard, journal, telemetry: **replicated per-machine shards** (`<machineId>` in the filename, one
  writer each, conflict-free on sync). Telemetry rows from a session with no resolvable machine id go to
  `unknown.jsonl`, which is git-ignored precisely because it would otherwise be one file written by every machine.
- Config block default: machine-local by the existing config model (config.json is not synced) — the default is
  `enabled: false` everywhere, so no machine diverges in behaviour.
- No user-facing notice; no generated URL.

## 8. Rollback cost

A code revert removes the reconciler, the hook rewrite and the new migrations. What stays: the populated
`.instar/skills/` (ordinary files; the parity rule tolerates them), the per-machine telemetry files, the config
block, two gitignore lines. None of it changes behaviour with the code reverted. No data migration to undo;
nothing was deleted.

---

## Conclusion

The review changed two things in the design before code was written: (1) the first-boot case (no baseline for any
rendering) is handled by seeding baselines from renderings that verify in sync, so the "no baseline + stale stamp ⇒
lock" floor does not lock every learned skill on every machine's first boot; (2) the reconciler is registered as a
self-triggered controller in the self-action registry so the convergence ratchet proves it settles (steady-state
bound: zero renders once every rendering matches canonical; settling brake: a conflict is locked, never retried).
No decision point over messages or intent is added. Clear to ship behind the existing dark default
(`monitoring.skillLearning.enabled: false`); the backfill and the hook rewrite are repairs of shipped design and run
unconditionally, which the spec (decisions 6, 7, 18) and the operator's approval cover.

## Evidence pointers

- Unit/integration/e2e test files listed in the PR body; `npx tsc --noEmit` clean; the convergence ratchet run.
- Spec: `docs/specs/skill-learning-sentinel.md` §2 (the defects found: `.instar/skills/` absent on this agent, 8 of
  51 telemetry rows unparseable, `FrameworkParitySentinel` never constructed), §6 slice 0.

## Class-Closure Declaration (display-only mirror)

Two classes are closed; the trace carries the gate-blocking one (`unbounded-self-action`), the second is mirrored
here and in the PR body:

- `defectClass: unbounded-self-action`, `closure: guard`, `guardEvidence: {enforcementType: ratchet, citation:
  tests/unit/self-action-convergence.test.ts, howCaught: the reconciler is registered as controller
  learned-skill-reconciler; under sustained pressure its emits are bounded by the number of learned canonicals
  (verify-then-render emits nothing once every rendering matches canonical — the steady-state bound) and a
  conflicted or failed rendering is locked/counted and never retried within or across ticks (the settling brake),
  so the ratchet would have caught an unbounded re-render loop}`.
- `defectClass: prompt-parser-contract-drift` (the agent-authored telemetry hook emitted rows its own reader could
  not parse — 8 of 51 on this agent — because raw tool arguments were interpolated into a JSON string by the shell),
  `closure: guard`, `guardEvidence: {enforcementType: ratchet, citation: the hook unit test added in this change
  (tests/unit/ — runs the generated bash with a hostile `args` payload and `JSON.parse`s every emitted row),
  howCaught: any future hook body that can emit an unparseable row fails that test}`.

## Second-pass review

_(appended by the reviewer subagent)_

**Reviewer:** independent reviewer subagent
**Independent read of the artifact: concern** (advisory only — no safety, security or data-loss finding; nothing blocks the commit)

Verified against code: (b) the only refusals are the edit lock (safety floor on an irreversible overwrite) and the slug / machine-id structural validators — compliant; (c) first boot is handled per rendering in one pass: in-sync ⇒ baseline seeded, missing ⇒ rendered, stale stamp + no baseline ⇒ `unknown-provenance` lock — implemented; (d) backfill is copy-only, temp+rename, no delete path, `.claude` wins, differing `.agents` logged; (e) stdin via `printf '%s'`, python builds the row, `SLUG_RE` runs before the stamp path is joined; (f) spawn export is `coordinator.identity?.machineId ?? null` — no hostname; the reconciler's shard name uses the identity (`coordinator.start()` at server.ts:5089 precedes construction at :6074), hostname only when unpaired; (g) registered, ratchet green; (h) per-machine shard/journal; (i) `hasOwnProperty`, exact-line gitignore check, `existsSync` guards. Runs: `tsc --noEmit` exit 0; 9 unit files 674 passed / 4 failed — all 4 in the backfill file against the normaliser mid-rewrite (12:20:44); re-run on the current tree 15/15; `self-action-convergence` green; e2e 7/7.

Statements broader than the code, with resolutions:
1. "Renders after a GitSync pull / at the sync() call sites": only the BOOT pull triggers it. `SyncOrchestrator.onPulled` has no production caller (`SyncOrchestrator` is never constructed in `src/`); the hourly git-sync job is covered by the 10-minute tick alone. Say so in Summary §3 and §7.
2. §7 "nothing written by two machines": every session without `INSTAR_MACHINE_ID` — all sessions spawned before this update, and unpaired agents — appends to `.instar/skill-telemetry/unknown.jsonl`, one synced file shared by every machine (the §2 defect shape). Gitignore `skill-telemetry/unknown.jsonl` or have the hook fall back to `.instar/machine/identity.json`.
3. §1 "conflicted until the baseline is seeded" implies self-healing; a lock clears only when the operator makes the rendering equal canonical or deletes it (then `missing-rendered-file` renders). `status()` has no route, so locks are visible only in the boot log line. Reword; note the surface is slice 1.
4. "tests at three tiers": no `tests/integration` file; the integration-shaped cases live in `tests/unit`, and the e2e alive test constructs the reconciler directly (no route). Say "unit + e2e".
5. The live kill switch `monitoring.skillLearning.reconcile.enabled` is read by server.ts but undeclared in `SKILL_LEARNING_DEFAULTS`, `types.ts` and the ladder entry. Declare it.
6. §5 interaction: the differing `.agents` copy is left unstamped (decision 6); `migrateParityRenderings` refuses only `user-edit-conflict`, so on the next enabled-framework-set change (new marker) it overwrites that copy with canonical. Spec-conformant; name it.
7. `migrateBuiltinSkillRenderings` renders absent layouts for EVERY canonical, not only built-ins (additive, never overwrites). Wording understates scope.
8. Hook: python `re.match(..., "$")` accepts a trailing newline; `re.fullmatch` is exact. Cosmetic (rows stay parseable; the JS side already rejects it).
9. `docs/specs/skill-learning-sentinel.md` is on neither this branch nor main (PR #2871 open); the cited path lands only if that merges first.

Not checked by the reviewer: the full unit suite beyond the nine touched files; a live server boot with the change; the git-sync job script's pull path; the backfill against this agent's real `.claude/skills/`.
