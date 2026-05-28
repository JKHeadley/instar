# Side-Effects Review — dispatch request handlers (Phase 1, increment 12)

**Slug:** `feedback-factory-dispatch-handlers`
**Date:** `2026-05-27`
**Author:** Echo (autonomous → interactive)
**Spec:** `docs/specs/feedback-factory-migration.md` (converged v2, approved by Justin 2026-05-26)
**Scope:** The framework-agnostic dispatch request handlers (faithful ports of `handleList` + `handleCreate`) + the store dispatch ops. Completes the front's request layer (receiver + dispatch). NOT the HTTP binding/deploy.

## Summary of the change

Adds `src/feedback-factory/dispatch/handlers.ts` — `handleDispatchList` + `handleDispatchCreate`, faithful ports of the reference dispatch endpoint, as pure request→response functions over the FeedbackStore + the ported dispatch logic (dispatch.ts). Adds `FeedbackStore.listDispatches`/`findDispatchByTitle`/`createDispatch` + `InMemoryFeedbackStore` impls. Reproduces the reference exactly: list gates on the `instar/` UA, applies the since/type DB filter + the version-compat filter, returns the mapped `{dispatches, count, asOf}`; create requires the internal key (x-internal-key or Bearer), validates (title ≥3, content ≥10, **type REJECTED** if invalid, priority defaulted, min/maxVersion semver), dedups by normalized title, and returns 201/200-duplicate. **Not wired into any route yet** — no behavioral change.

Note the asymmetry with the public receiver: dispatch create REJECTS an invalid type (it's an internal, authed endpoint), whereas the public feedback receiver defaults it — both faithful to their respective references.

## Seven-dimension review

1. **Over/under-reach** — Pure request→response functions over the store. Not wired to any route. The internal-key auth is injected (the operated binding provides the real key).
2. **Level-of-abstraction fit** — Reusable "recipe" → core; the framework binding + real store are operated-side. The version-compat filter reuses the already-tested `filterDispatchesForVersion`.
3. **Signal vs Authority** — N/A; create is internal-authed (the reference's 401 gate is reproduced); list is the `instar/`-UA fingerprint gate.
4. **Interactions** — `dispatch/handlers.ts` imports dispatch.ts + the store interface; nothing imports it yet. Store gains a dispatches Map (isolated from feedback/clusters).
5. **Rollback cost** — Trivial: delete the handlers + store ops + tests.
6. **Migration parity** — N/A. Core library code; no agent-installed file.
7. **Failure modes** — (a) Response divergence → exact status/message/auth/order tested. (b) Version-compat filter wrong → reuses the 9/9-tested `filterDispatchesForVersion` + a hidden-from-older-agent handler test. (c) Dedup-by-title divergence → tested (201 then 200-duplicate). (d) Auth bypass → 401 tested for missing/wrong key; Bearer form tested.

## Tests

- Tier-1 unit (CI): `tests/unit/feedback-factory/dispatch-handlers.test.ts` — 8 tests (list: UA-gate, basic list+asOf, version-compat hide, type filter; create: 401, Bearer-auth, validation messages, 201-then-dedup).
- No E2E this increment — the route binding + deploy are gated on the blocked app-placement + Prisma-adapter decisions.

## Status note

With this, the **entire front + processor request/decision layer is ported** (receiver submit + dispatch list/create handlers, all the processor brain, the store seam + composition + observability). The only remaining feedback-factory work is genuinely blocked on external inputs: the real Prisma adapter (DB creds/schema), the framework binding + Vercel deploy (app-placement + Vercel project), agent-awareness (after live), and the operational cutover (Dawn + live systems).
