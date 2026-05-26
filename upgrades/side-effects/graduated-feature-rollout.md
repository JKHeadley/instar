# Side-Effects Review — Graduated Feature Rollout

Spec: `docs/specs/GRADUATED-FEATURE-ROLLOUT-SPEC.md` (v2 CONVERGED + ratified; driver twice-weekly). Branch `build/graduated-feature-rollout` off JKHeadley/main @ v1.3.0.

## What changes for a deployed agent

Makes the existing InitiativeTracker self-populating + self-driving — no parallel system, no new persistence namespace. Additively:
- **Schema:** the `Initiative` type gains an optional typed `rollout` block (`flagPath`, `stage`, `evidenceSource`, `promotionCriteria`, `lastDigestNotifiedAt`) + a `RolloutStage` type. Purely additive; pre-rollout records leave it undefined; create/update plumb it through (whitelisted, like the other project-scope fields), so TaskFlow serialization is unchanged for records that don't use it.
- **`FeatureRolloutReconciler`** (new, server-wired, in-process): auto-registers/advances a `kind:'task'` initiative from spec frontmatter + trace + git state. Bounded since-last-run scan; OCC `ifMatch` on every write; id normalize/truncate/hash; rename-by-specPath; bounded backfill (historical specs terminal, only recent/ships-staged active). In-process because `POST /initiatives` deliberately drops the needed fields.
- **One twice-weekly builtin driver job** (`initiative-digest-review`, Mon+Thu): reads `/initiatives/digest`, gathers evidence, sets `needsUser` recommendations. **Read-only w.r.t. config flags** — it never flips `flagPath`. Retires/replaces the bespoke `session-reaper-promotion-review`.
- **Discoverability (Layer D):** `/initiatives` un-suppressed in the capability matrix; a Registry-First "what are we working on" row in the CLAUDE.md template; a session-start line that fires ONLY on a *new* needs-user edge (deduped) — near-silent.

## The safety invariant (over/under-block)

The danger is a feature silently reaching `default-on`. Structurally impossible here: `deriveRolloutStage` computes the stage from **observation only** (live flag + shipped ConfigDefaults default); `default-on` requires the shipped default to be enabled (a human code change). The driver has **no write path** to flags. And `default-on` *archives* the track (reopenable) rather than marking all phases `done` (which would seal the record against a future regression via the immutable TaskFlow terminal). Under-block (a stalled rollout) is handled by nag-decay (§4.7), not by forcing advancement.

## Level-of-abstraction / signal-vs-authority

The reconciler + driver compute signals (verdicts, recommendations); authority to advance stays with the human flipping the config flag. The reconciler only *observes* and reflects.

## Interactions

- Built ON the InitiativeTracker; disjoint from the Evolution Action Queue (`evolution-overdue-check`) and Commitments (§4.8) — no double-nag.
- Auto-registered tasks are top-level (retroactive `parentProjectId` attach is validation-rejected); project membership stays a deliberate `/instar-project` act.
- The driver replaces the bespoke per-feature job (which the builtin-job reconciler retired on restart) — a single builtin, restart-durable.

## Rollback

The `rollout` schema field is additive/optional. The reconciler + driver ship off/observational; disabling the driver job (`enabled:false`) and not wiring the reconciler reverts to today's passive tracker. No data migration; archived tracks remain readable.

## Tests

3-tier incl. the dogfood backfill e2e (SessionReaper retroactive), near-silent edge dedupe, flag-never-flipped, wiring-integrity. Live test-as-self before merge.

## Post-build review fixes (multi-agent code review)

Independent review (correctness + wiring/regression passes) confirmed the wiring is clean and the no-silent-default-on invariant holds, and caught one BLOCKER + minors, all fixed:
- **BLOCKER — default-on seal:** `status:'archived'` maps to TaskFlow's TERMINAL `cancelled`, which would seal a default-on rollout track against a later regression (tests missed it by not enabling TaskFlow). Fixed: default-on now parks the track as **`paused`** (non-terminal → reopenable, and off the active/stale list); historical non-rollout backfill keeps `archived` (genuinely terminal). A new TaskFlow-enabled regression test proves default-on→live reopens (would fail pre-fix).
- **MINOR:** `makeFlagObserver` now handles bare-boolean flags (not just `{enabled,dryRun}` objects). Scanner reads `createdAt ?? timestamp` (trace timestamp field drift). Test uses `SafeFsExecutor` (destructive-tool lint).

## CI fix — job-template frontmatter YAML

CI caught a real bug the local pre-push smoke missed: the driver job's `description` contained `Near-silent: posts` — the `: ` made the real YAML loader read it as a nested mapping ("bad indentation of a mapping entry"), so `installBuiltinJobs` errored during migration and several migration/parity unit shards failed. Fixed by removing colon-space / arrow / `§` chars from the description (matching the unquoted-no-colon convention of the other job templates). Verified: js-yaml parses it, and default-jobs-valid + migration-guarantee + parity-primitives-lifecycle are green.
