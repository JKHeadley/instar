# Side-Effects Review — Live credential re-pointing (Increment A, Step 1: config + dark-gate foundation)

**Version / slug:** `live-credential-repointing-increment-a-foundation`
**Date:** `2026-06-13`
**Author:** `echo`
**Second-pass reviewer:** `not required` (no decision logic; see §4)

## Summary of the change

First commit of the approved live-credential-repointing build (Increment A, ships dark). This is the **foundation only** — it reserves the switch and the config shape with **zero runtime behavior**. Files touched:

- `src/core/types.ts` — adds the `subscriptionPool.credentialRepointing` config type (`enabled`, `dryRun`, `manualLeversEnabled`, and the Increment-B `balancer` knobs, present so the shape is stable from A).
- `src/config/ConfigDefaults.ts` — adds the `subscriptionPool.credentialRepointing` default block with a literal `enabled: false` + `dryRun: true` + `manualLeversEnabled: true`, appended at the end of `SHARED_DEFAULTS` (after `topicProfiles`).
- `src/core/devGatedFeatures.ts` — adds a `DARK_GATE_EXCLUSIONS` entry, `category: 'destructive'`, `configPath: subscriptionPool.credentialRepointing.enabled`, so the gate resolves OFF + dry-run for EVERYONE including the dev agent. (Deliberately NOT `DEV_GATED_FEATURES`, which would resolve LIVE-with-writes on Echo — the rev-2 blocking finding.)
- `tests/unit/credential-repointing-dark-gate.test.ts` — 4 tests proving the registry entry/category, dark-on-dev, dark-on-fleet, and the lint pairing invariant.
- `tests/unit/lint-dev-agent-dark-gate.test.ts` — adds the new `enabled: false` path to the golden line-map EXPECTED (recomputed via the attributor; appended at end so it shifts no prior entry).
- Spec + companions: `docs/specs/live-credential-repointing-rebalancer.{md,eli16.md,build-plan.md}` + `docs/specs/reports/...convergence.md`.

**Decision points the change interacts with:** the dark-feature gate (`resolveDevAgentGate` / `DARK_GATE_EXCLUSIONS`). This commit REGISTERS the feature in that gate as a destructive dark feature; it adds no new gate logic of its own.

## Decision-point inventory

- `DARK_GATE_EXCLUSIONS` (src/core/devGatedFeatures.ts) — **add** (one registry row) — registers `subscriptionPool.credentialRepointing.enabled` as a `destructive` dark feature so it resolves OFF + dry-run for all agents. No code path reads the flag yet; the swap/oracle/route logic that will consume it lands in steps 2–10.

The change adds **no** message-filtering, dispatch, session-lifecycle, or block/allow decision point. It is config + types + a single gate-registry row + tests + docs.

---

## 1. Over-block

**No block/allow surface — over-block not applicable.** The foundation gates nothing at runtime; it only declares a config default and a dark-gate registry row. The eventual feature (later steps) writes credentials and is itself dark + dry-run until a deliberate two-flag flip.

---

## 2. Under-block

**No block/allow surface — under-block not applicable.** Nothing is being filtered or rejected by this commit.

---

## 3. Level-of-abstraction fit

Correct layer. Config defaults belong in `ConfigDefaults.ts`; the type belongs in `types.ts`; the dark-feature classification belongs in the existing `DARK_GATE_EXCLUSIONS` registry (the same place the worktree-reaper and mcp-process-reaper destructive features are registered). The commit REUSES the existing dark-gate machinery rather than inventing a parallel switch — exactly the precedent the rev-2 review demanded (a `DEV_GATED_FEATURES` omit-enabled would have resolved LIVE on Echo). No lower primitive is being re-implemented.

---

## 4. Signal vs authority compliance

Compliant — and the question is largely vacuous for this commit because it adds **no authority and no signal logic**. It registers a destructive feature as dark. The full feature's signal-vs-authority posture (the identity oracle is a *signal*; oracle-unavailable → quarantine-never-repair, never a destructive "repair"; the per-slot write funnel is a structural single-mover, not a brittle check with blocking authority) was settled across the 5 converged review rounds and is in `lessons-engaged`. Because this commit introduces no decision logic, **second-pass review is not required** under Phase 5 (no block/allow on messaging/dispatch, no session-lifecycle mutation, no new gate/sentinel/watchdog decision — only a registry row in an existing gate).

---

## 5. Interactions

- **Dark-gate golden line-map test:** the new `enabled: false` literal is picked up by the `attributeEnabledFalsePaths` attributor. Handled — EXPECTED in `lint-dev-agent-dark-gate.test.ts` recomputed; the entry was appended at the END of `SHARED_DEFAULTS` so it shifts no prior line and only ADDS `'1015'`. Verified: 52/52 unit tests pass.
- **applyDefaults deep-merge:** `subscriptionPool.credentialRepointing` is add-missing-only; an operator's existing `subscriptionPool` values are never overwritten. No shadowing of any sibling default.
- No double-fire / race surface — there is no runtime code in this commit.

---

## 6. External surfaces

Nothing visible to other agents, users, or systems. The feature is dark for everyone; no routes, no notices, no spawn-time behavior ship in this commit. `GET /credentials/*` routes are NOT added yet (step 7). The config block backfills onto existing agents via `migrateConfig` add-missing (wired in step 9, not this commit) — until then existing agents simply lack the (dark, inert) block, which changes no behavior.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN, by necessity** — credentials live in each machine's own keychain/config homes, and the spec's core invariant ("exactly one home per credential") is per-machine because the keychain is per-machine. The ledger (`state/credential-locations.json`, step 2) and swap engine are deliberately machine-local; a swap on machine A must never reach into machine B's keychain. The existing multi-machine handoff "swap-in-flight" guard is composed-with (not replaced) in the later swap-executor step (rev-1 finding). For THIS foundation commit there is no cross-machine surface at all — it is config + a gate row. The full feature's multi-machine posture is documented in the spec §2.3/§2.10.

---

## 8. Rollback cost

Near-zero. The feature is dark (`enabled:false` + `dryRun:true`) and has no runtime consumers in this commit, so reverting is a plain `git revert` of a config/types/test/docs commit with no data migration and no agent-state repair. Even after later steps land, going live requires a deliberate two-flag flip; backing out is flipping `enabled` back to false (live read at the chokepoint).
