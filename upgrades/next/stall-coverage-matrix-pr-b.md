# Framework stall-coverage matrix — PR-B (runtime gate, acceptance machinery, live-check job)

## What Changed

The second half of the stall-coverage standard: the apprenticeship transition gate now verifies each framework's stall-coverage matrix from LIVE state. At `pending→active` a provisional matrix (complete enumeration, hermetic checks) is required; at `active→complete` the full validation runs — resolvable detector/recovery symbols, closePath refs resolved against the live commitments ledger (a delivered or missing ref is a dead anchor), guard postures cross-checked against the guards inventory via each row's guardKey, and the whole verdict executed in a bounded worker (60s, timeout fails closed with a retryable reason distinct from invalidity). Every declared gap, N/A reason, and covered row is enumerated for a recorded operator acceptance: a single-use, content-hash-bound challenge accepted via the dashboard PIN or a verified-operator reply — the transition caller's own token can never self-accept. Install provenance (source-carrying vs fleet) is derived at init with a one-time migration backfill, so a fleet install gets the honest `matrix-unverifiable-no-source` verdict instead of a bogus refusal. A weekly `stall-matrix-live-check` job (ships off, silent no-op without source) re-validates the standing matrices and mints tracked refs for auto-seeded debt.

The gate ships OBSERVE-FIRST: `apprenticeship.stallCoverageGate` defaults to `{enabled: true, dryRun: true}` — refusals are suppressed and logged as would-refuse verdicts until the operator flips enforcement on named evidence. The gate registers as a load-bearing-soaking row in the guards inventory (30-day soak) so an unflipped gate becomes visible debt, never silent rot.

## Evidence

- 290 tests across 11 suites green (gate unit boundaries both sides, acceptance authority incl. replay/self-acceptance/hash-mismatch refusals, real HTTP 409 + dry-run suppression integration, e2e lifecycle with contentHash + HEAD SHA + dirty-flag audit).
- Full unit tier run: 37,533 passed (one silent-fallback ratchet trip resolved by annotating deliberate fallbacks; baseline unchanged).
- tsc clean; guard-manifest lint clean; live-check script smoke-tested (no-source silent no-op; dead-server = named ledger-unreachable, zero partial mints).

## What to Tell Your User

No day-to-day behavior changes. When a new AI framework is onboarded onto your agent's platform, the onboarding sign-off now structurally requires an honest, verified answer for every known way a session can get stuck — and any gap needs your recorded approval, not a quiet checkbox.

## Summary of New Capabilities

- Runtime stall-coverage gate on apprenticeship transitions (dry-run first, operator-owned enforcement flip).
- PIN/verified-operator acceptance machinery with single-use, content-bound challenges.
- Weekly matrix live-check job with tracked-ref minting for auto-seeded debt.
