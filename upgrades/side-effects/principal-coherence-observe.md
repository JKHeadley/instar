# Side-effects review — Principal-Coherence Signal, observe-only (Know Your Principal, increment 3)

## What this change does
The READ side of the operator binding — the first runtime consumer of
`PrincipalGuard.evaluatePrincipalCoherence` (shipped pure + unwired in #902).
On the outbound delivery seam (`checkOutboundMessage` in routes.ts), every
finalized agent message is checked against the topic's VERIFIED operator. When
the message credits an operator-ROLE decision (approval / mandate / credential /
lock / acting-for) to a principal who is NOT the bound operator — the "Caroline"
identity-bleed failure, caught in the agent's OWN output — a structured line is
appended to `state/principal-coherence.jsonl`.

- `src/core/types.ts`: one new optional config block,
  `monitoring.principalCoherence?: { enabled: boolean }`. Documented, off by
  default by absence.
- `src/server/routes.ts`: one new observe function `observePrincipalCoherence`,
  modeled byte-for-byte on the existing `observeSelfViolation`, plus one
  fire-and-forget `void observePrincipalCoherence(...)` call placed next to the
  existing `void observeSelfViolation(...)` at the top of `checkOutboundMessage`
  (before the gate-availability early-return, so it runs regardless of whether a
  tone gate is configured).

## The load-bearing security property
The operator the check resolves against comes ONLY from
`TopicOperatorStore.asVerifiedOperator(topicId)` — the authenticated-sender
binding (#904/#906/#2d), never a name read from content. A name in the agent's
prose can therefore never become the "known good" principal; it can only ever be
the thing being CHECKED. This is the whole point of the standard: an unverified
identity is a guess, not a fact.

## SIGNAL-ONLY contract (identical to observeSelfViolation)
- **Returns void; fire-and-forget.** It has NO path to block, delay, rewrite, or
  influence the outbound message or the tone-gate verdict. The verdict field in
  the audit line (block for mandate/credential, warn otherwise) is RECORDED for
  later analysis and NEVER enforced — proven by an e2e assertion that a
  credential misattribution still returns 200, not 422.
- **Fail-open.** Every operation is guarded; the outer body is try/catch and each
  fs op is independently guarded. Any throw is swallowed and the message sends.
- **Dark by default.** Inert unless `monitoring.principalCoherence.enabled === true`
  AND `ctx.topicOperatorStore` is non-null AND the topic id is numeric. Absent
  config (every existing + new agent today) = fully inert, zero cost.
- **Observe-first rationale.** The PrincipalGuard regex can false-positive on
  prose that merely names a capitalized person. Observe mode exists precisely to
  measure that FP rate on real outbound BEFORE any warn/block surface is built.

## Blast radius
- **Additive.** No route added, no class added, no dependency added. One config
  key, one function, one fire-and-forget call.
- **Hot path, but cold by default.** The call sits on the outbound delivery path,
  but when the flag is off it returns on the first `if` before touching the store
  or importing PrincipalGuard (dynamic import, so the cold path never even loads
  the module).
- **Audit write.** On a finding it appends to `state/principal-coherence.jsonl`,
  mkdir-ing `state/` defensively first (the TopicOperatorStore only creates that
  dir on its first write, which may not have happened yet). Append-only; bounded
  per message by the number of distinct attributions found.

## Migration parity
None required. This is server-side route behavior + a config TYPE only. The
config flag follows the exact convention of its sibling observe flag
`monitoring.correctionLearning` — read with `=== true`, so absent → off. Behavior
is therefore IDENTICAL for new and existing agents with no migrateConfig write
(adding one would only cosmetically materialize a false flag). The
`correctionLearning` flag has no migrateConfig/generateDefaultConfig entry for
the same reason; this mirrors it.

## Tests (all three tiers)
- Tier 1 (unit): `tests/unit/principal-coherence-operator-seam.test.ts` (5) —
  locks the store→guard contract the wiring depends on, both sides of the
  boundary (bound operator resolves → no finding; outsider → finding; unbound →
  finding; credential/mandate → block verdict; benign prose → nothing).
- Tier 2 (integration): `tests/integration/principal-coherence-signal.test.ts`
  (5) — over the wire: flag on + bound operator + misattribution logs; bound
  operator attribution logs nothing; unbound logs operatorBound:false; flag off
  logs nothing; a block-verdict finding never 422s.
- Tier 3 (e2e): `tests/e2e/principal-coherence-lifecycle.test.ts` (4) — production
  AgentServer boot; feature-is-alive write lands; signal-only (credential → 200,
  not 422); bound-operator no-op; flag-off dark.

## Rollback
Revert the one observe function + its one call site + the config type, and delete
the three test files. The jsonl on disk is inert. No data migration to unwind.
