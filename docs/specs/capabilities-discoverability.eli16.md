# Capabilities Discoverability — Plain-English Overview

> The one-line version: the endpoint that's supposed to tell every agent what it can do was lying about Secret Drop (and five other primitives), and we're fixing it plus locking the promise structurally.

## The problem in one breath

Every instar agent is told, in its onboarding file, to call `GET /capabilities` whenever it's not sure what tools it has. That endpoint was supposed to be the agent's "honest mirror" — a live list of every primitive the server can do. It wasn't honest: it left out Secret Drop, the commitment tracker, the token ledger, the semantic memory, and the listing-side endpoints for private views and Telegraph publishing. When an agent asked the mirror "do you have a safe way to collect a password from the user?" the mirror said no — even though the safe way (Secret Drop) was right there in the codebase. The agent then reached for an unsafe workaround.

## What already exists

- **The `/capabilities` endpoint.** A live JSON response listing the agent's available tools. The agent's standard onboarding (CLAUDE.md) tells it to trust this endpoint as the source of truth.
- **Secret Drop.** A safe channel for collecting credentials from users — the user types the password into a one-time web form, never into chat, and the agent retrieves it through a hardened path. The routes are all live: `POST /secrets/request`, `POST /secrets/retrieve/:token`, `GET /secrets/pending`, `DELETE /secrets/pending/:token`.
- **CommitmentTracker, TokenLedger, SemanticMemory.** Three other agent-facing primitives that are fully wired up in the server but were never listed in the `/capabilities` response.
- **The `BUILTIN_FEATURES` registry.** A separate list of opt-in features (with consent flows). Secret Drop is not opt-in — it's always-on infrastructure — so this isn't the right home for it. The discoverability fix has to live in `/capabilities`, not in the registry.

## What this adds

The `/capabilities` response now includes a `secrets` block — same shape as the existing blocks for Telegram, scheduler, etc. — listing every Secret Drop endpoint plus a one-line hardening note pointing at the safe retrieval helper. Four other primitives that were silently missing get the same treatment (`commitments`, `tokens`, `semantic`), and two blocks that previously surfaced only counts (`publishing`, `privateViewer`) gain explicit endpoint arrays.

Secondary change: a new lint test enumerates every top-level route prefix in the server and refuses CI if any prefix isn't either surfaced in the `/capabilities` response or explicitly allowlisted as an internal/operator-only endpoint. The lint is the structural guarantee that the next primitive can't slip through silently.

## The new pieces

- **The new blocks in `/capabilities`.** Plain JSON objects with `enabled`, `endpoints`, and (for Secret Drop) a `retrievalHint` warning against the unsafe pattern. They are pure data — they do not gate anything, they just describe what's available.
- **`tests/unit/capabilities-discoverability.test.ts`.** Walks `src/server/routes.ts` for every `router.get('/<prefix>...')` style registration, builds the set of all top-level prefixes, and asserts each is discoverable. Has an `INTERNAL_ALLOWLIST` for endpoints that should NOT appear (health checks, the capabilities endpoint itself, operator-only routes) — each entry needs a one-line reason.

## The safeguards

**Prevents future primitives from being invisible.** Today the failure happened because a primitive shipped without a corresponding `/capabilities` entry. The new lint enumerates every route prefix at test time and refuses the build if any prefix is unaccounted for. Adding a new primitive now means either adding it to the response or making a deliberate choice to allowlist it.

**Prevents the response shape from changing in a way that breaks existing consumers.** All changes are additive. The existing `publishing.pageCount` and `privateViewer.viewCount` fields are preserved; the new `endpoints` arrays are added alongside. Existing integration tests pass without modification.

**Prevents agents from learning the unsafe retrieval pattern.** The new `secrets.retrievalHint` field in the response includes a one-line warning that the raw `curl` pattern leaks the secret into the Bash transcript and points at the hardened retrieval script. The hardening note rides along with the discoverability fix so agents see it the moment they discover Secret Drop.

## What ships when

This is a single PR. Two interleaved fixes ship together: the response-body additions and the lint that locks them.

Two follow-ups are explicitly out of scope and tracked separately:

1. Ship the hardened retrieve script as an `src/templates/scripts/` template so every agent gets it on install. This fixes the second layer of the case-study failure (the workaround-reflex / unsafe retrieve pattern).
2. Refactor `/capabilities` to introspect from `FeatureRegistry` + the live router instead of being a hand-curated object literal. This removes the third manual edit point and makes the registry the single source of truth.

## What you actually need to decide

This PR closes the discoverability gap that started the case study. Two follow-ups remain (hardened retrieve script + introspecting `/capabilities`) — should they ship as separate PRs or be bundled into a single sequel?
