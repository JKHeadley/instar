---
slug: capabilities-discoverability
title: Capabilities Discoverability — close the gap between routes.ts and the self-discovery surface
review-convergence: 2026-05-21T05:00:00Z
approved: true
eli16-overview: capabilities-discoverability.eli16.md
---

# Capabilities Discoverability

## Problem

The CLAUDE.md template — bundled with every instar agent — instructs:

> Before EVER saying "I don't have", "I can't", or "this isn't available" — check what actually exists: `curl http://localhost:$INSTAR_PORT/capabilities`. This returns your full capability matrix. It is the source of truth about what you can do. Never hallucinate about missing capabilities — verify first.

This is a hard architectural promise: `/capabilities` is the authoritative self-discovery surface. If a primitive exists in the server, an agent that consults `/capabilities` will learn it exists; if `/capabilities` is silent, the agent treats the primitive as absent.

The promise was silently false. The handler at `src/server/routes.ts:GET /capabilities` is a hand-curated object literal that hand-lists ~25 subsystems by name. Several agent-facing primitives ship as registered routes (`POST /secrets/request`, `/secrets/retrieve/:token`, the full `/commitments/*` CRUD, `/tokens/*`, `/semantic/*`, the listing-side endpoints under `/views` and `/published`) but never appear in the response body.

The downstream failure mode is documented in the case study seeded into topic 11141 ("🔍 Discoverability Secret Access") on 2026-05-20. When an agent needed to collect a Bitwarden master password, it consulted `/capabilities`, saw no `secrets` block, and reached for unsafe credential-intake workarounds (chat paste, env vars). The actual safe primitive — Secret Drop — existed, but the discovery surface lied about it. The leak that followed was a downstream symptom of a structural lie at the discovery layer.

## Approach

Two changes, one PR:

**1. Fill the gaps in the response.** Add `secrets`, `commitments`, `tokens`, and `semantic` blocks to the `/capabilities` response. Expand the `publishing` and `privateViewer` blocks to include explicit endpoint arrays (they previously surfaced only counts). The `secrets` block includes a hardening note pointing at `.instar/scripts/secret-drop-retrieve.mjs` as the safe retrieval helper — the raw `curl` pattern leaks the secret value into the Bash tool transcript.

**2. Lock the promise with a unit test.** A new `tests/unit/capabilities-discoverability.test.ts` walks `src/server/routes.ts` for every top-level route prefix and asserts each either appears in the literal `res.json({...})` body of the `GET /capabilities` handler or is on an explicit `INTERNAL_ALLOWLIST` with a one-line reason. Adding a new prefix that is neither surfaced nor allowlisted will fail CI until the author makes a deliberate choice.

The `/capabilities` handler remains a hand-curated object literal in this PR. A follow-up (intentionally deferred) will refactor the handler to introspect from `FeatureRegistry` + the live Express router so the third manual edit point disappears entirely. The deferral is rational because the lint already enforces the invariant the refactor would automate.

## Non-goals

- Re-architect `/capabilities` to be self-introspecting. Deferred to a follow-up spec — out of scope here.
- Ship a hardened retrieve script as an `src/templates/scripts/` template. Required for the second-layer fix from the case study (the workaround-reflex failure mode), but distinct from the discoverability fix. Tracked separately.
- Update `routes.ts:5973` (the system message injected into spawned agents on Secret Drop submission). That instruction still teaches the raw-curl pattern. Same deferral as above.
- Add a corresponding `secret-drop` entry to `BUILTIN_FEATURES`. That registry is for opt-in features with a consent flow; Secret Drop is an always-on primitive and doesn't fit the schema.

## Acceptance criteria

- `GET /capabilities` returns a `secrets` object with `enabled: true`, an `endpoints` array containing each of the four Secret Drop routes, and a `retrievalHint` warning against the raw-curl pattern.
- `GET /capabilities` returns `commitments`, `tokens`, and `semantic` objects, each with `enabled: true` and an `endpoints` array.
- The `publishing` and `privateViewer` blocks each carry an `endpoints` array.
- `tests/unit/capabilities-discoverability.test.ts` enumerates every top-level route prefix in `src/server/routes.ts` and asserts each is either surfaced in the response body or in `INTERNAL_ALLOWLIST`.
- No regressions in the existing integration tests that exercise the `/capabilities` response (`tests/integration/view-tunnel-routes.test.ts`, `tests/integration/publishing-routes.test.ts`).

## Decision points touched

- `GET /capabilities` response body — the agent's authoritative self-discovery surface.
- The new lint test — fails CI on any route prefix that isn't either surfaced or explicitly allowlisted.

Neither change introduces new block/allow authority. Both are additive observability/safety changes. The signal-vs-authority principle is preserved: the lint is a brittle detector that emits a signal (a CI failure) which an existing authority (the human reviewer + CI gate) acts on. The detector has no block authority of its own at runtime.

## Migration

No agent-installed file changes. The `/capabilities` response shape is purely additive — existing fields are preserved, new fields are added. No `PostUpdateMigrator` entries needed. The hardened Secret Drop retrieve script (`.instar/scripts/secret-drop-retrieve.mjs`) is tracked in a separate spec.

## Rollback

Pure code change. Revert the routes.ts diff and the lint test; the manifest hashes regenerate on the next build. No persistent state, no agent-state repair, no user-visible regression during the rollback window.

## Origin

Topic 11141 ("🔍 Discoverability Secret Access"), seeded 2026-05-20 17:00 UTC. Root-cause audit on 2026-05-21. The case study explicitly named the discoverability gap as failure #1 of three compounding failures; this spec addresses failure #1 only. Failures #2 (workaround-reflex / unsafe retrieve pattern) and #3 (brittle dependence on machine-local props) are tracked separately.
