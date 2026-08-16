# Side-Effects Review — Capability Map user-provenance fallback

**Version / slug:** `capability-map-user-provenance-fallback`
**Date:** `2026-04-22`
**Author:** Dawn (instar-bug-fix autonomous job, AUT-6010-wo)
**Second-pass reviewer:** not-required (LOW-risk classifier fallback; no public API, schema, or adapter surface touched)

## Summary of the change

In `src/core/CapabilityMapper.ts`, the `classify()` method now assigns `provenance: 'user'` to any capability that falls through all three existing classification rules (builtin-manifest, evolution linkage, custom hook dir) AND still carries the pre-classify default `'unknown'`. Capabilities whose scanners pre-assign a non-`unknown` provenance (e.g. the `hooks/instar/` subdir) are preserved untouched.

The persisted manifest's `classificationReason` gains a matching case: `'agent-local config directory'` for `user`-classified entries.

Files touched:
- `src/core/CapabilityMapper.ts` — two edits in the `classify()` and `persistManifest()` methods.
- `tests/unit/capability-mapper-advanced.test.ts` — one existing test renamed and updated to assert the new behavior (mystery skill classified as `user`, not left in `drift.unmapped`).

Feedback cluster addressed: `cluster-capability-map-has-104-unmapped-capabilities`. Reporter wanted the drift endpoint to stop flagging fully-functional agent-local capabilities as "unmapped." This ships exactly that: agent-local skills/scripts/jobs/context that aren't shipped-builtin and aren't evolution-linked are now correctly labeled `user`-provenance.

## Decision-point inventory

- Final fallback branch in `classify()` — **modify** — converts `unknown` → `user` when nothing else matched; preserves non-`unknown` pre-set provenance.
- `classificationReason` ternary in `persistManifest()` — **extend** — new case `user ? 'agent-local config directory'`.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

None. The change adds a positive classification where one was missing. It does not gate, reject, or short-circuit any path. The only capabilities affected are those that previously would have been labeled `unknown`; they now get a more specific `user` label.

Hooks already pre-assigned `instar` by the scanner (`hooks/instar/` subdir) would be overwritten by a naive fallback, so the guard `cap.provenance === 'unknown'` explicitly preserves them.

---

## 2. Under-block

**What failure modes does this still miss?**

- Capabilities legitimately sourced from neither the bundle, an evolution proposal, nor the agent's own config — e.g. a third-party drop-in dir if one ever exists — would also be labeled `user`. Today no such source exists; the scanners only reach paths under `projectDir/.claude/` and `stateDir/hooks/`, both agent-owned. If a future scanner adds a truly "external" source, it must pre-assign a non-`unknown` provenance to avoid mislabeling.
- Already-persisted `unknown` entries in each agent's on-disk `capability-manifest.json` will continue to show `unknown` until the next `refresh()` runs. That's fine: drift detection already re-classifies on scan; no migration is required.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The classifier is the correct seam — it's the single chokepoint every capability passes through, and the `Provenance` type already names `'user'` as a first-class value. The alternative (adding `user` at each scanner) would duplicate the rule across six scanners and drift over time. The alternative (post-hoc in `buildMap`) would scatter classification across multiple layers.

---

## 4. Signal vs authority compliance

**Required reference:** `docs/signal-vs-authority.md`

**Does this change hold blocking authority with brittle logic?**

- [x] No. This change has zero blocking authority. It produces a *label* on a read-only classification path. No gating, no rejection, no downstream authority decision hangs off the new label; the drift endpoint and summary table consume the label for display only.

---

## 5. Interactions

- **Manifest persistence** — the new label is written to `capability-manifest.json`. Persisted entries that previously read `provenance: 'unknown'` will, on the next scan, persist as `provenance: 'user'`. The drift detector's `changed` list will surface these as a one-time provenance transition per agent. That's expected and visible in the drift report; it's the signal that the fix took effect.
- **Summary counters** — `buildMap()` already counts `user`-provenance capabilities into `userConfigured`. That counter was 0 for all agents pre-fix; it now reflects reality. `unmapped` drops correspondingly.
- **Test coupling** — one existing test (`reports unmapped capabilities (unknown provenance)`) asserted the old behavior and has been renamed and updated. All 208 tests across the three capability-mapper test files still pass.

---

## 6. Revert cost

Single-commit revert. Two tiny edits in `CapabilityMapper.ts` plus one test update. No schema, migration, config, or API contract changed. Persisted manifests with `user` provenance would be re-labeled `unknown` on the next post-revert scan — fully reversible.

---

## 7. Justification for shipping now (vs. deferring)

The cluster has sat with governance=`implement` and concrete research notes pointing at the exact line of code. The fix is two small conditional edits; the risk of shipping is strictly lower than the continued noise of ~100+ agent-local capabilities being flagged as "unmapped" across every drift report on every agent. Deferring would keep the drift signal polluted and continue to show `userConfigured: 0` in summaries that should show a much larger number.
