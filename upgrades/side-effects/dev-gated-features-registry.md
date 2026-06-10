# Side-Effects Review — Dev-Gated-Feature Registry + Both-Sides Wiring Test (Slice 2)

**Change:** Slice 2 of DEV-AGENT-DARK-GATE-CONFORMANCE-SPEC (the converged +
operator-approved spec). Adds the layer that catches a dev-gated feature wired to
resolve **dark on a dev agent** — the gap Slice 1's lint cannot see.

- `src/core/devGatedFeatures.ts` (new) — `DEV_GATED_FEATURES` registry (name +
  config path + description) and a `getConfigByPath` reader.
- `tests/unit/devGatedFeatures-wiring.test.ts` (new) — for each registered
  feature, applies the REAL `getMigrationDefaults` and asserts
  `resolveDevAgentGate(<configPath>)` is **true** under a `developmentAgent: true`
  config and **false** under a fleet config, plus a "teeth" test confirming an
  injected `enabled: false` default fails the live-on-dev assertion (the literal
  #1001 mechanism).

**Registry membership (the design decision in this slice):** only features whose
intent is "dark fleet / LIVE on dev" are included (growthAnalyst, coherenceJournal,
warmSessionA2A, secretSync, geminiLoopDriver, respawnBuildContext,
selfKnowledgeSessionContext — verified to omit `enabled` in defaults). Deliberately
EXCLUDED, with reasons in code: `monitoring.mcpProcessReaper` (destructive — ships
OFF + dry-run for everyone incl. dev by design) and `monitoring.resourceLedger`
(ledger defaults `enabled: true`; only sampling rides the gate off the same key).

## 1. Over-block — what legitimate inputs does this reject that it shouldn't?
The test asserts every registered feature is live-on-dev / dark-on-fleet. A
feature that legitimately ships dark-everywhere or live-everywhere would fail if
wrongly added to the registry — but membership is a deliberate, reviewed choice
(the two non-conforming features are explicitly excluded with documented reasons),
so the test only constrains features that genuinely follow the convention.

## 2. Under-block — what failure modes does this still miss?
Catches the hardcoded-default half of the #1001 shape (a `false` baked into the
feature's default → `applyDefaults` injects it → live-on-dev assertion fails) for
**registered** features. Still misses: (a) a dev-gated feature never added to the
registry; (b) the construction-side half where a site reads `enabled === true`
without any gate (no default to catch) — that is Slice 3's spec-intent cross-check.
Both limits are named in the spec's layer table.

## 3. Level-of-abstraction fit — right layer?
Yes — a unit test over the real config-default assembly (`applyDefaults` +
`getMigrationDefaults`), the same path PostUpdateMigrator uses. It exercises the
actual default→gate resolution, not a source regex, so it catches the mechanism
rather than a spelling.

## 4. Signal vs authority compliance
The test is CI authority (fails the build) over a deterministic, mechanical
property — same posture as the rest of the suite. The registry is inert data; it
holds no runtime authority (Slice 3 consumes it read-only).

## 5. Interactions — shadowing, double-fire, races?
None. `devGatedFeatures.ts` is pure data + a pure path reader; the test builds
throwaway config objects. No shared state, no runtime wiring in this slice.

## 6. External surfaces — visible to other agents/users/systems?
None. No routes, no config, no agent-installed files. Repo-internal source + test.
No Migration Parity entry needed.

## 7. Rollback cost — back-out if wrong?
Trivial — delete the two files. No runtime behavior, no state, no deployed artifact.

## No deferrals
Slice 3 (spec-intent cross-check) is the next slice of the same approved spec,
tracked under CMT-1253 — not a deferral of this slice's scope. <!-- tracked: CMT-1253 -->

## Second-pass review (independent)
The registry membership was derived by auditing each `resolveDevAgentGate` site's
default against the convention: the 7 included features verified to omit `enabled`
(test green on all = no hidden hardcoded default); the 2 excluded features
(mcpProcessReaper, resourceLedger) inspected and confirmed intentionally NOT
dark-on-fleet. The teeth test confirms the guard fires on a planted regression.
