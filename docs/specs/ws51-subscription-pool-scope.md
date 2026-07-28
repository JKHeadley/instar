---
title: "WS5.1 — Subscription-Pool Pool-Scope Visibility: Spec"
slug: "ws51-subscription-pool-scope"
author: "echo"
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
eli16-overview: "ws51-subscription-pool-scope.eli16.md"
status: "converged"
review-convergence: "2026-06-13T10:00:00.000Z"
review-iterations: 1
review-completed-at: "2026-06-13T10:00:00.000Z"
approved: true
approved-by: "operator pre-approval — Justin, topic 13481, 2026-06-12/13: full session pre-approval for this initiative's decisions (exercised by Echo in the pre-approved autonomous run; operator may revoke). Build prompt: .instar/plans/ws51-subscription-pool-scope-build-prompt.md"
parent-spec: "MULTI-MACHINE-SEAMLESSNESS-SPEC.md (WS5.1); docs/specs/ws24-knowledge-replication.md (the merged sibling whose spec-frontmatter shape this mirrors)"
lessons-engaged:
  - "L15 Authorization: reach ≠ authority — the pool-scope read fans out carrying THIS machine's Bearer (its own authority), never a caller-supplied token; an unauth peer degrades to a classified `unauthorized` failed row, never a smuggled credential."
  - "P4 Testing Integrity: three tiers + named adversarial-lens tests (credential/URL-leak, auth-boundary, no-recursion, per-machine-seat-not-coalesced, classified-failure per reason)."
  - "no-silent-fallbacks: the NEW peer-fetch catch is tagged @silent-fallback-ok — a down/slow/401 peer is the DESIGNED tolerant path, reported up-stack in pool.failed (never swallowed, never a 500)."
  - "Phase C: the design holds for N machines — the fan-out is over resolvePeerUrls() (authenticated mesh URLs, no LAN/2-peer assumption); pool.failed accounts for EVERY unreachable peer by machineId (a dark cloud VM = a classified row, never a silent omission); per-machine seat is meaningful so the SAME account on two machines stays individually visible (never P17-coalesced)."
dependency-gate:
  blocks: "WS5.1 reuses the MERGED WS4.1 pool fan-out template (GET /sessions?scope=pool): resolvePeerUrls(), Promise.all over the peer set with a 5s timeout each, machinePoolRegistry nickname tagging, and the classified pool.failed shape."
  status: "SATISFIED — verified on 2026-06-13: GET /sessions?scope=pool present in src/server/routes.ts (WS4.1 merged to JKHeadley/main); resolvePeerUrls + machinePoolRegistry are real RouteContext members."
  enforcement: "The integration test boots a REAL peer routes app + a REAL 401-enforcing peer + a dead port and asserts every peer is accounted for in pool.failed — the fan-out template is exercised, not assumed."
cross-model-review: "not-run (pre-approved autonomous build mirroring the merged WS4.1 sessions-pool-scope template exactly; the 4 adversarial lenses are exercised in tests/unit/subscription-pool-scope.test.ts + tests/integration/subscription-pool-scope.test.ts)"
tracked-followups: "the placement tie-breaker (prefer the machine with more account-pool headroom on an otherwise-equal tie) is DEFERRED <!-- tracked: CMT-1416 -->: it requires plumbing account-pool aggregate headroom through the capacity heartbeat (MachineCapacity carries quotaState.blocked only — no per-account remaining%), which is larger than a clean small slice. The pool-scope READ ships alone. WS5.2 (account follow-me) / WS5.3 (escalation rides the topic) are separate surfaces."
---

## 1. Problem

`GET /subscription-pool` reports ONLY this machine's account pool (`{ enabled, count, accounts }` from `ctx.subscriptionPool.list()`). When the agent runs on more than one machine, the operator cannot see "how much quota is left across ALL my machines / accounts" in one view — each machine answers only for itself. The dark/offline machines are simply absent, indistinguishable from "no accounts there."

## 2. Design — a read-side, additive, dark pool-scope branch

Add a `scope=pool` branch to the existing `GET /subscription-pool` handler (`src/server/routes.ts`), mirroring `GET /sessions?scope=pool` exactly. When `req.query.scope === 'pool'`:

1. **Self accounts** — `ctx.subscriptionPool?.list() ?? []`, each tagged `{ machineId: selfMachineId, machineNickname, remote: false }`.
2. **Fan-out** — `const peers = ctx.resolvePeerUrls?.() ?? []` (ONLINE-registered peers only, authenticated mesh URLs). `await Promise.all(peers.map(...))` fetches each peer's **PLAIN** `/subscription-pool` (NEVER `?scope=pool` — no recursion), carrying THIS machine's Bearer (`Authorization: Bearer ${ctx.config.authToken}`), with `AbortSignal.timeout(5000)`.
3. **Tag** — each remote account gets `{ machineId, machineNickname (from machinePoolRegistry.getCapacity), remote: true }`.
4. **Classified failure** — a non-OK / down / slow / unauth peer pushes a `pool.failed: [{ machineId, error }]` row with a NORMALIZED reason: `unauthorized` (401/403), `error` (other non-OK), `timeout` (Timeout/Abort), or `unreachable` (any other network failure). NEVER a raw `err.message`, peer URL, or TLS error (no leak). NEVER a 500. The catch is tagged `// @silent-fallback-ok` — the tolerant degrade is reported up-stack, not swallowed.
5. **Response** — an OBJECT (not the plain array-bearing shape): `{ enabled: !!ctx.subscriptionPool, accounts: [...selfTagged, ...remote], pool: { selfMachineId, selfMachineNickname, peersQueried, peersOk, failed }, scope: 'pool' }`.
6. **Per-machine seat preserved** — the SAME account id on two machines is kept individually visible (NOT P17-coalesced); a per-machine seat is quota-meaningful (differs from attention-notice coalescing).
7. **No-op superset** — single-machine / no `resolvePeerUrls` → the self-only view tagged `scope: 'pool'` with empty `pool.failed`. An unwired pool → `enabled: false`, `accounts: []`, still `scope: 'pool'`.

The plain (no-`scope`) route is UNCHANGED — back-compatible `{ enabled, count, accounts }`. No config flag (a pure route-branch → the dark-gate line-map is unchanged). No replication, no PII machinery, no HLC.

## 3. Phase C — robustness under arbitrary pool size & degraded conditions

- **N machines, no LAN assumption.** The fan-out is over `resolvePeerUrls()` (authenticated mesh URLs), not a 2-peer special case. `Promise.all` is bounded by the live peer set; each fetch has its own 5s timeout, so an N-machine pool cannot storm or hang.
- **A dark cloud VM is a classified failure row, never a silent omission.** Every unreachable/offline/unauth peer appears in `pool.failed` by `machineId`. The operator can tell "machine X has no accounts" from "machine X is unreachable."
- **No amplification / recursion.** The peer fetch hits the PLAIN route, so a pool-scope read never triggers a second fan-out on the peer.

## 4. Adversarial review (4 lenses — folded as named tests)

1. **Credential/URL leak** — no `failed` reason and no tagged account exposes a peer URL, token, or raw TLS error. Test embeds an IP:port + the local token in the raw error and asserts neither appears in the response; the normalized reason is `unreachable`.
2. **Auth boundary** — the fan-out carries THIS machine's Bearer (same as the sessions route); it never forwards a caller-supplied token. Test sends an `X-Forwarded-Token` and asserts the outbound `Authorization` is exactly `Bearer <selfToken>`. A 401-enforcing peer degrades to an `unauthorized` failed row, not a throw (integration test).
3. **No-recursion / amplification** — the peer fetch targets `<url>/subscription-pool` (no `scope=pool`). Test asserts the called URL and a single fetch per peer.
4. **Placement safety** — the placement tie-breaker is DEFERRED <!-- tracked: CMT-1416 --> (see frontmatter); nothing in this slice touches the placement decision, so it provably cannot move a live session.

## 5. Migration parity

- `src/scaffold/templates.ts` `generateClaudeMd()` — a "Quota across ALL my machines (pool-scope read)" bullet on the Subscription Pool block (new agents).
- `src/core/PostUpdateMigrator.ts` — the same bullet added to the section-install template AND an idempotent content-sniffed additive-bullet patcher for existing agents that already carry the section (mirrors the proactive-swap patcher). The section heading is unchanged, so the feature-delivery-completeness featureSection + shadow markers stay green.
