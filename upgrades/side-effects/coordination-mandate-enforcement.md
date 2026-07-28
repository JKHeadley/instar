# Side-effects review — Coordination Mandate enforcement (spec §4, G2.2)

Spec: `docs/specs/coordination-mandate.md` (approved by Justin, A/A/B, 2026-06-05).
Change: new `src/coordination/` module (types, MandateStore, MandateGate, MandateAudit,
ConditionsRegistry) + six `/mandate*` routes wired through `AgentServer` → `RouteContext`.

## 1. Blast radius
Additive only. No existing route, gate, sentinel, or store is modified. The engine is
**deny-by-default and inert**: with no mandate issued (the universal state at deploy),
every `/mandate/evaluate` call denies — so shipping this changes NO behavior anywhere
until the operator issues the first mandate through the PIN-gated route. It never
weakens an existing safety check; it adds a controlled delegation surface beside them.

## 2. State / data
Two new files under the `.instar/state/` convention, created on first use:
`coordination-mandates.json` (the signed mandates) and `mandate-audit.jsonl`
(append-only, hash-chained). No schema migration; absent files mean an empty store and
an empty audit. Torn-trailing-line tolerant reads.

## 3. Security model (the load-bearing dimension)
- **requester ≠ authorizer preserved:** the human-authored mandate is the authorizer.
  The agent's Bearer token CANNOT issue or revoke — `/mandate/issue` and
  `/mandate/:id/revoke` require the operator's dashboard PIN (sha256 + timingSafeEqual +
  per-IP attempt limiting, mirroring `/dashboard/unlock`). Tested at all three tiers.
- **Authorship proof (T1/T2):** HMAC over the canonical authored bytes (key-order-stable
  serialization), produced only at issuance. A forged or widened mandate fails
  `verifyAuthorship` → the gate denies. `revoked` is excluded from the proof so the
  kill switch works post-issuance; revocation is checked on every evaluation (T5).
- **Conditions (T7/T10):** objective resolvers from real state; an unregistered or
  throwing resolver evaluates FALSE (deny-safe). The first mandate (per decision 3B)
  carries no conditioned authority; `integrity-gate-pass` and `parity-zero-divergence`
  are registered deny-safe stubs until the real state is wired for a future cutover
  authority — which per decision 1A is not delegated anyway.
- **Audit (T3/T8):** every decision (allow AND deny) appends a hash-chained entry;
  `verifyChain()` detects any edit/deletion and is surfaced on `GET /mandate/audit`.
- **Stated trust boundary (T12):** an attacker with local disk write access could edit
  server-managed state — the same trust root as today; the proof stops forged AUTHORED
  content, and the audit chain makes tamper detectable. Out of scope per the spec.

## 4. Failure modes
- No `stateDir` → engine is null → all `/mandate*` routes 503 (tested).
- Engine init failure → own try/catch, never cascades to other inits.
- Malformed issuance body → 400 with a specific reason (agents pair, non-empty
  authorities, future expiry — each tested both sides).
- No `dashboardPin` configured → issuance/revocation 503 (PIN auth unavailable) — the
  gate cannot be bypassed by the PIN simply being absent.

## 5. Interactions
- `RouteContext` gains a required `coordination` field; the only production assembler
  (`AgentServer`) is updated. Route tests use partial `ctx: any` → unaffected (tsc green).
- Express route-order hazard handled: `/mandate/audit` and `/mandate/evaluate` are
  registered BEFORE `/mandate/:id` (tested explicitly).
- No locks, queues, LLM calls, or budgets shared with other components.

## 6. Performance
O(mandates) reads of a small JSON file per evaluation + one appendFileSync per decision.
Evaluation volume is a handful of A2A actions per migration step — negligible.

## 7. Migration parity
No `.claude/settings.json` hook, config default, or hook-script change → no
`PostUpdateMigrator` entry needed. Server-side code activates on the next server start
after update. Agent-Awareness satisfied: CLAUDE.md template gains a Coordination
Mandate blurb (`generateClaudeMd`). The feature is inert-by-default everywhere (deny
without a mandate), so fleet exposure is zero until an operator issues one.

## Tests
- Unit (`tests/unit/coordination-mandate.test.ts`, 17): authorship valid/forged/widened,
  revoke-preserves-proof, canonical key-order stability, audit chain intact/tampered,
  conditions (true/false/unknown/compound/throwing), the gate's FULL deny ladder
  (missing, forged, expired, revoked, non-party, unlisted action, out-of-bounds params,
  unmet condition) + both allow paths, bounds helper both sides.
- Integration (`tests/integration/mandate-routes.test.ts`, 9): PIN-less issue refused,
  wrong PIN refused, issue/list/evaluate/revoke round-trip, deny-by-default audited,
  route order, validation 400s, 503s.
- E2E (`tests/e2e/coordination-mandate-lifecycle.test.ts`, 5): real AgentServer boot,
  alive + Bearer-gated, deny-by-default on fresh boot, full PIN-issue→allow→deny→
  revoke→deny lifecycle with chain-verified audit, and the production-HMAC
  wiring-integrity proof (persisted authProof verifies; a widened mandate fails).

## Post-review amendment (same PR, pre-merge)

- **Discoverability:** the `/mandate` prefix is classified in `CapabilityIndex.ts`
  (CAPABILITY_INDEX → surfaced in `/capabilities` with all six endpoints + the
  evaluate-before-acting + PIN-gating semantics), satisfying the
  capabilities-discoverability gate. Agents discover the gate; they still cannot
  issue through it.
