# Side-Effects Review — Blocker Ledger dev-gate registration (PR-1055 follow-up fix)

**Version / slug:** `blocker-ledger-dev-gate`
**Date:** `2026-06-10`
**Author:** `echo`
**Second-pass reviewer:** `not required (4-file conformance fix to an enforced standard; no new decision logic)`

## Summary of the change

Registers the Blocker Ledger (merged in PR #1055) under the **developmentAgent dark-feature gate standard** enforced by `lint-dev-agent-dark-gate` (PR #1056). The two PRs merged within minutes of each other from divergent branch points, so PR #1055's hardcoded `monitoring.blockerLedger.enabled: false` default never met the new lint in CI — leaving main latently red (the next branch off main fails `npm run lint`). This fix conforms the feature to the standard: ConfigDefaults **omits** `enabled` (`blockerLedger: {}`), `AgentServer` resolves it via `resolveDevAgentGate(...)` (LIVE on a development agent for dogfooding, DARK on the fleet → routes 503), the config type makes `enabled` optional, and the feature is registered in `DEV_GATED_FEATURES` with the required safety justification (signal-only, no egress, no destructive action; one bounded fail-closed ≤200-token B17 check on the rare settle).

Files: `src/config/ConfigDefaults.ts`, `src/server/AgentServer.ts`, `src/core/types.ts`, `src/core/devGatedFeatures.ts`.

## Decision-point inventory

- `AgentServer` BlockerLedger construction condition — **modify** — from a literal `enabled === true` check to `resolveDevAgentGate(enabled, config)`. The gate's semantics: explicit `true`/`false` wins; absent → live on dev agents, dark on fleet. No other decision point touched.

---

## 1. Over-block

No block/allow surface — over-block not applicable. (Fleet behavior is unchanged: absent flag still resolves false on non-dev agents → routes 503 exactly as before.)

## 2. Under-block

No block/allow surface — under-block not applicable. The one behavior change is intended: development agents now run the ledger live without a config edit (the dogfood-on-dev standard).

## 3. Level-of-abstraction fit

Correct layer: this moves the feature onto the EXISTING gate primitive (`resolveDevAgentGate`) + registry (`DEV_GATED_FEATURES`) rather than a parallel mechanism. The wiring test (`devGatedFeatures-wiring.test.ts`) auto-covers the new entry with real ConfigDefaults.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

The gate resolution is configuration mechanics, not a judgment decision. The ledger's own signal-only posture (PR #1055 artifact) is unchanged.

## 5. Interactions

- **Shadowing/double-fire/races:** none — same single construction site, same null-→503 path.
- **Migration interplay:** `applyDefaults` adds only MISSING keys; an existing agent that already received `blockerLedger: { enabled: false }` from PR #1055's default keeps that explicit false (fleet-safe; dev agents that want live can clear it or set true). New installs get the empty object → gate decides. No surprise activation on the fleet.

## 6. External surfaces

None beyond the intended one: a development agent's `/blockers` routes go live (local Bearer-auth API + dashboard tab). Zero egress; no fleet-visible change.

## 7. Rollback cost

Trivial: revert restores the literal `enabled: false` default. No persistent state created by the gate itself.

## Conclusion

A 4-file conformance fix that repairs the PR #1055 × #1056 merge race (latent red main) and lands the feature on the correct dev-gate standard — which also supersedes the manual dogfood config flip on the dev agent. Verified: `lint-dev-agent-dark-gate` clean, `tsc` clean, dev-gate wiring test green (proves live-on-dev/dark-on-fleet with real defaults), Blocker Ledger unit (35) + integration (7) + e2e (4) all green. Clear to ship.

---

## Evidence pointers

- `node scripts/lint-dev-agent-dark-gate.js` → clean (was: `[C: unclassified dark default]` on ConfigDefaults.ts:257).
- `tests/unit/devGatedFeatures-wiring.test.ts` → green including the new `blockerLedger` entry.
- `tests/unit/BlockerLedger.test.ts` (28) + `tests/unit/blockerSettleAuthority.test.ts` (7) + `tests/integration/blocker-ledger-routes.test.ts` (7) + `tests/e2e/blocker-ledger-lifecycle.test.ts` (4) → green.
