# Side-Effects Review — dispatch (guidance-out) logic (Phase 1, increment 7)

**Slug:** `feedback-factory-dispatch`
**Date:** `2026-05-27`
**Author:** Echo (autonomous)
**Spec:** `docs/specs/feedback-factory-migration.md` (converged v2, approved by Justin 2026-05-26)
**Scope:** The pure logic of the dispatch endpoint (the channel that sends guidance back out to agents) — type/priority vocab, semver version-compat filtering, and the create-dedup title normalization. NOT the HTTP wiring/storage (app-placement decision, blocked).

## Summary of the change

Ports the pure logic of `the-portal/pages/api/instar/dispatches/index.ts` into `src/feedback-factory/dispatch/dispatch.ts`: the dispatch `DISPATCH_TYPES`/`DISPATCH_PRIORITIES` vocab + validators, `parseVersion`/`isVersionGte`/`isVersionLte` (the semver comparison), `filterDispatchesForVersion` (an agent only receives a dispatch whose `[minVersion, maxVersion]` window includes its version), and `normalizeDispatchTitle` (trim + 500-char cap, used for create-dedup). **Not wired into any route yet** — no behavioral change.

## Equivalence verification

Reference is TypeScript, so equivalence is by faithful transcription + exhaustive both-sides-of-boundary unit tests (9): semver compare at equal/greater/lesser across all three components; the version-compat filter with min-only / max-only / both-bounds / unbounded, boundaries inclusive; unparseable version → `[0,0,0]`; title trim + 500 cap. The comparison loop, the inclusive-equal semantics, and the filter predicate are copied verbatim from the reference.

## Seven-dimension review

1. **Over/under-reach** — Pure functions, no I/O, no state, not imported by any runtime path.
2. **Level-of-abstraction fit** — `src/feedback-factory/dispatch/` — the dispatch layer. HTTP/storage excluded (the blocked app-placement decision); this is the reusable core.
3. **Signal vs Authority** — N/A; pure filters/validators.
4. **Interactions** — None. New isolated module; nothing imports it yet.
5. **Rollback cost** — Trivial: delete the module + tests.
6. **Migration parity** — N/A. New internal library code; no agent-installed file touched.
7. **Failure modes** — (a) Semver-compare divergence (esp. inclusive-equal + multi-component ordering) → covered by both-direction tests across all components. (b) Unparseable version handling → tested ([0,0,0] fallback matches the reference, so a garbage version is treated as 0.0.0). (c) Title-dedup divergence → trim+slice(500) transcribed + tested.

## Tests

- Tier-1 unit (CI): `tests/unit/feedback-factory/dispatch.test.ts` — 9 tests (vocab, parseVersion, gte/lte, version-compat filter boundaries, title normalization).
- No cross-runtime parity harness (reference is TS; equivalence by transcription + boundary tests).
- No integration/E2E this increment: HTTP wiring/storage is the blocked app-placement decision; this logic attaches to a route when that's decided. Reasoned, documented.
