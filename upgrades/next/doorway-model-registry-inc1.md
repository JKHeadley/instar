<!-- internal-only -->

## What Changed

Doorway/Model Knowledge Registry — rollout increment 1 (the foundational, dark/inert, backward-compatible piece of `docs/specs/DOORWAY-MODEL-KNOWLEDGE-REGISTRY-SPEC.md`):

- **Enriched the canonical registry** (`scripts/model-registry-freshness.manifest.json`, now `registrySchemaVersion: 2`): every door carries a `topModels[]` list — the exact model id, a role label, a `frontier` flag, `pricing` (null on carry-over), and `verifiedAt`. Seeded 1:1 from the already-reviewed `frontierAllowlist` (spec D4 carry-over: `verifiedAt:"carried-over-from-allowlist"`), so no new research/operator round-trip was needed to land it.
- **Made the frontier set DERIVED, not hand-maintained** (spec §1.4): the freshness lint's DRIFT tooth (`scripts/lint-model-registry-freshness.mjs`) now checks each pin against the ids in `doors[door].topModels[]` carrying `frontier:true` — a *view* of the one hand-edited structure — instead of the separate `frontierAllowlist{}` (now removed). This eliminates the second hand-maintained list that was itself a rot vector. Backward-compatible: a door with a literal `frontierAllowlist` and no `topModels` behaves exactly as before; a door with BOTH emits a non-gating `TRANSITION` finding so the stale literal can't silently linger.

The lint stays in non-gating `report` mode. No runtime code (`src/`), route, job, config default, hook, or agent-installed file changes in this increment — the deterministic prober, live scan-state, `GET /doorways`, the scan job, and the config knob are later rollout increments and are NOT in this PR.

## Evidence

- `node scripts/lint-model-registry-freshness.mjs` → PASS against the enriched shipped manifest (all pins resolve via the derived frontier set; staleness OK).
- `tests/unit/model-registry-freshness.test.ts` → 20/20 pass (11 pre-existing + 9 new: derived-frontier drift both sides, `frontier:false` exclusion, the transition finding, old-shape backward-compat, and direct `frontierSetForDoor` unit coverage). The shipped-manifest self-consistency test passes via the derived path.
- Deferred items (spec §Deferred DF1-DF6) filed as tracked follow-ups: `docs/specs/reports/DOORWAY-MODEL-KNOWLEDGE-REGISTRY-followups.md` + `<!-- tracked: 29723 -->` markers in the spec body (owner topic 29723).
