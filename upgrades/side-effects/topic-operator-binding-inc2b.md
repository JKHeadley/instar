# Side-effects review — Topic Operator binding (Know Your Principal #898, increment 2b)

## What this change does
Wires the already-merged `TopicOperatorStore` (#904) into the live `AgentServer`
composition and exposes it over HTTP, plus the session-start injection block.

- `AgentServer.ts`: a new `topicOperatorStore` field constructed under the
  `stateDir` guard inside its own try/catch (mirrors the `approvalLedger`
  precedent), then passed into `routeCtx`.
- `routes.ts`: a `topicOperatorStore` field on `RouteContext` and four routes —
  `GET /topic-operator`, `GET /topic-operator/:topicId`,
  `GET /topic-operator/session-context?topicId=N`, `POST /topic-operator`.
- `CapabilityIndex.ts`: a `topicOperator` capability entry (prefix
  `/topic-operator`) so the routes are discoverable.

## Blast radius
- **Additive only.** No existing route, field, or store is modified. The store
  is constructed when `stateDir` is available and is otherwise `null`; every
  route degrades to `503` (feature-not-available) when it is `null`, never a
  null-deref crash. The E2E test asserts the routes answer `200` on the real
  production boot path (the store is genuinely composed in, not null).
- **No auth change.** All four routes sit behind the existing Bearer
  middleware, identical to `/topic-bindings` and `/approvals`.
- **Fail-safe by construction.** An init failure is caught and reported via
  `console.warn`; it can never block server boot. A corrupt store file is
  treated as empty (a missing operator means the cross-principal guard treats
  everything as unverifiable — deny-safe, not allow-safe).

## The load-bearing security property (unchanged from #904)
The operator is established ONLY from the authenticated sender `uid`. The POST
route refuses a blank uid with `400`; a `displayName` (a content name) is never
authoritative — it is only lowercased for prose-matching. There is no code path
by which a name read from content becomes the operator. This is the structural
fix for the "Caroline" identity-bleed failure mode, and the integration + E2E
tests both assert the blank-uid refusal over the wire.

## Migration parity
No migration is required. These are server-side routes and an in-process store
field — they reach existing agents automatically on the next server update (the
Migration Parity Standard governs agent-installed FILES: settings hooks, config
defaults, CLAUDE.md template, hook scripts, skills — none of which this touches).
The store auto-creates `state/topic-operators.json` on first write; no config
key is added, so there is nothing for `migrateConfig` to backfill.

The session-start HOOK wiring (so the `<topic-operator>` block is actually
fetched and injected at boot) is deliberately NOT in this increment — that is a
hook-template change requiring `migrateHooks`, and is scoped to increment 2c so
this PR stays a focused, reviewable composition+routes change. Until 2c lands the
block is reachable at the route but nothing injects it yet; that is intentional.

## Framework generality
This is framework-agnostic. `platform` is a generic string (`telegram` |
`whatsapp` | `slack` | …), so the binding works for any messaging adapter, not
just Telegram. The `session-context` route returns a plain text block that any
framework's session-start hook can fetch and inject — it is not coupled to
Claude Code, Codex, or Gemini. The store has no platform-specific logic; it
delegates identity establishment to `PrincipalGuard.establishOperator`, which is
itself pure and framework-neutral.

## Tests
- Tier 1 (unit): `tests/unit/topic-operator-store.test.ts` (10) — shipped in #904.
- Tier 2 (integration): `tests/integration/topic-operator-routes.test.ts` (10) —
  full HTTP pipeline over a real file-backed store, incl. the blank-uid refusal
  and the store-not-wired 503 degradation.
- Tier 3 (E2E): `tests/e2e/topic-operator-lifecycle.test.ts` (6) — feature-alive
  on the real `AgentServer` boot path (200 not 503), full bind→read→inject
  lifecycle, durable-write proof, and the over-the-wire blank-uid refusal.

## Rollback
Revert the three source edits + delete the two test files. The store on disk
(`state/topic-operators.json`) is inert without the routes and can be left or
removed with no consequence.
