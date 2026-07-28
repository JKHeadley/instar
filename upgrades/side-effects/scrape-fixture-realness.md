# Side-effects review — Scrape/Parser fixture-realness enforcement

Spec: `docs/specs/scrape-fixture-realness.md` (converged @ iter 4, approved) · ELI16: `docs/specs/scrape-fixture-realness.eli16.md`
Parent principle: Testing Integrity

## What the change is

Structural enforcement of the `code=t` lesson: a parser of untrusted real-world text must be tested against a byte-for-byte REAL captured fixture, not a hand-authored clean string. Adds (1) a registry standard, (2) a `tests/fixtures/captured/` convention with secret-redaction + provenance sidecars, (3) a registry-driven lint `scripts/lint-scrape-fixture-realness.js` that requires each registered parser's test to load a captured fixture via `loadCapturedFixture`, feed it to the parser, and assert — plus a non-blocking register-or-justify warning for un-registered `parse*`/`scrape*` exports. No runtime code changes.

Files: `scripts/lint-scrape-fixture-realness.js`, `scripts/redact-captured-fixture.mjs`, `tests/helpers/loadCapturedFixture.ts`, `tests/fixtures/captured/**`, `docs/STANDARDS-REGISTRY.md`, `package.json` (lint chain), `scripts/pre-push-gate.js` (direct invocation), `tests/unit/framework-login-driver.test.ts` (migrated), + tests for the lint and the redaction helper.

## 1. Over-block — legitimate inputs rejected that shouldn't be
The lint only enforces realness for parsers EXPLICITLY in the `SCRAPE_PARSERS` registry (seeded with one). It never fires on un-registered code — so it cannot false-positive a normal test. The register-or-justify check is a non-blocking WARNING (exit code unaffected). Near-zero over-block by construction (FD1).

## 2. Under-block — failure modes still missed
- The lint proves the registered test loads-feeds-asserts; it cannot prove the assertion is non-trivial (a deliberately weak `expect`) — owned as a review concern (FD6).
- It cannot prove un-redacted bytes were genuinely real (provenance is review-checkable, not machine-verifiable) — owned (FD2).
- Inline/method/private parsers aren't caught by the `parse*`/`scrape*` export scan — the PR register-or-justify trigger (review) is primary; the warning is a backstop (FD3). This is the conformance gate's noted Structure-vs-Willpower residual, accepted because full coverage needs the unbounded heuristic FD1 rejects.

## 3. Level-of-abstraction fit
Correct layer: a build-time lint alongside the existing `lint-*` family, run via `npm run lint` (the real battery) + the pre-push gate. The redaction helper sits in `scripts/` with its peers. The fixture convention sits under `tests/fixtures/`. No runtime layer touched.

## 4. Signal vs authority compliance
A hard-blocking lint over a CURATED registry — legitimate per Signal-vs-Authority because the false-positive surface is near-zero by construction (identical posture to `lint-no-direct-llm-http` / `lint-dev-agent-dark-gate`, both hard-block on curated lists). The register-or-justify check is signal-only (warning, never blocks). No brittle blocking authority over messages/sessions.

## 5. Interactions
- Adds one entry to the `npm run lint` `&&`-chain (ordering-independent; each lint is self-contained) + a direct pre-push invocation (mirrors the two existing direct lints). No shadowing/double-fire.
- The migrated `framework-login-driver` realness test now loads from disk via `loadCapturedFixture` instead of an inline const; the de-wrap assertion (full URL ≠ `code=t`) is unchanged, so the regression guard and the realness convention reinforce each other.
- The redaction helper is a new dependency of the fixture-authoring flow; it carries its own unit tests so a redaction bug can't silently produce a passing-but-fake fixture.

## 6. External surfaces
None at runtime. Build-time only: a new lint contributors run via `npm run lint`; a new standard in the registry; a new fixtures dir. Nothing visible to users, other agents, or other systems.

## 7. Multi-machine posture (Cross-Machine Coherence)
Machine-local by design (FD4): build-time lint over the committed source tree + committed fixtures. No runtime surface, no state, no cross-machine behavior. Every machine builds the identical repo and runs the identical lint over the identical fixtures.

## 8. Rollback cost
Cheap. Revert the new files + the three small wiring edits (package.json, pre-push-gate.js, the migrated test). No data migration, no runtime/state. The migrated fixture can revert to an inline const if ever needed (the assertion is unchanged).

## Second-pass (high-risk: "lint"/gate)
The lint's core (`checkTest`) was independently re-read against the spec: it requires, within the registry-named test, a `loadCapturedFixture('<slug>')` assigned to a var, that var passed as the first arg to the registered parser symbol (member-expression accepted), and an `expect(`. The sidecar check validates required fields + ISO timestamp. Matches the spec's canonical-shape matcher; the realness is executed (the suite runs the named test). Concur.

## Follow-up fix (CI regressions)

Two regressions this PR introduced were caught by CI (not the 3 files I first ran) and fixed:
1. **Dangling ref:** the standard cited the `SCRAPE_PARSERS` token; the standards-enforcement-auditor resolves backticked `FOO_BAR` tokens as `src/**` symbols, and this one lives in `scripts/`, so it never resolved → danglingCount 0→1. Rephrased the standard to "a curated parser registry" (no marker token). Re-verified danglingCount=0.
   - Over-block/Under-block: none — the lint's behavior is unchanged; only the registry prose changed.
2. **Pre-push-gate scratch test:** the direct lint invocation added to `scripts/pre-push-gate.js` ran against the gate's resolved ROOT, which is a scratch dir in the gate's own unit tests (where the registered fixtures don't exist) → status 1. Removed the redundant direct invocation; the lint is enforced via the `npm run lint` chain that CI runs (authoritative). No loss of enforcement.
   - Rollback cost: trivial (re-add the block if a future need arises, guarded for scratch).
