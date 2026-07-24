---
title: Stall-Coverage Gate
description: Runtime apprenticeship gate, acceptance routes, and the stall-matrix-live-check job.
---

The runtime half of the framework stall-coverage matrix standard
(`docs/specs/framework-stall-coverage-matrix.md`; constitutional entry: "Stall
Coverage Is Enumerated, Not Discovered"). The CI ratchet keeps matrices honest on
every push; THIS surface makes apprenticeship sign-off consume them from live state.

## The gate (`core/ApprenticeshipStallGate`)

`src/core/ApprenticeshipStallGate.ts` wires into the apprenticeship transition
chokepoint:

- `pending→active`: a provisional matrix must exist for the instance's framework —
  complete class enumeration, hermetic checks only (schema, tokens, ref formats).
- `active→complete`: full validation in a bounded worker (60s; a timeout REFUSES
  with a retryable reason distinct from matrix-invalid): resolvable
  detector/recovery symbols, evidence containment, closePath liveness against the
  live commitments ledger (only a 404 or terminal status is a dead ref — any other
  failure is `ledger-unreachable (retry)`), and guard-posture cross-checks via each
  row's `guardKey` against the guards inventory (covered ⇒ live; covered-dark ⇒
  dark/dry-run, not missing; `exempt:<id>` ⇒ vacuous-with-reason recorded).
- Install provenance decides the degraded rung: a fleet (no-source) install gets
  the honest `matrix-unverifiable-no-source` verdict + acceptance-carried sign-off;
  a source-carrying install with a stripped tree is refused; no provenance record
  ⇒ `provenance-record-missing — re-run update/migration`.
- Config: `apprenticeship.stallCoverageGate` in `.instar/config.json`, read LIVE at
  the callsite. Inline default `{enabled: true, dryRun: true}` — under dryRun every
  refusal (presence AND validity) is suppressed and logged as a would-refuse
  verdict in `logs/apprenticeship-decisions.jsonl`. A malformed block resolves to
  the safe default with a loud log line. The enforce flip is operator-owned; the
  gate registers as a load-bearing-soaking row in `GET /guards` (30-day soak) so an
  unflipped gate surfaces as visible debt.
- Every decision record carries the validated content hash, the checkout HEAD SHA,
  and the dirty flag — no validate-then-decide gap.

## Acceptance routes

Every declared gap, N/A reason, and covered row must be accepted by an
authenticated principal DISTINCT from the transition caller (requester ≠ acceptor;
a Bearer principal is structurally refused at bind).

- `POST /apprenticeship/instances/:id/matrix-acceptance/enumerate` (Bearer) —
  the server renders and records the exact enumerated set and mints a SINGLE-USE,
  content-hash-bound challenge. Optional body `{"scope":"rows","rowIds":["<framework>:<classId>"]}`
  or `{"scope":"override","rule":"<rule>","classId":"<classId>"}` mints row-scoped
  acceptances / per-instance overrides (Decision-20 canonical row hashing: unrelated
  codemod additions never void a row acceptance; any accepted-row change does).
  Optional `topicId` posts the enumeration to Telegram for reply-anchored binding.
- `POST /apprenticeship/instances/:id/matrix-acceptance` — the bind: dashboard-PIN
  (checkMandatePin funnel) or the verified-operator conversational reply-anchor.
  The current hash is re-resolved at bind (accept-then-edit voids); a used
  challenge is refused (replay). Acceptance artifacts persist in
  `logs/apprenticeship-decisions.jsonl`.

## The `stall-matrix-live-check` job

`src/scaffold/templates/jobs/instar/stall-matrix-live-check.md` — weekly, tier-1
supervised, ships `enabled: false` fleet-wide; its body probes for an analyzable
source tree and exits silently on a pure end-user install. Where it runs (a
source-carrying/maintainer agent), `scripts/stall-matrix-live-check.mjs` re-runs
the non-hermetic checks over ALL matrices in `docs/frameworks/`: closePath
liveness, guard-posture cross-checks, the 45-day `unreviewed` warning rung, and
the §2.1 mint flow for codemod-seeded `pending-mint` rows (idempotent
framework-issue filings + ONE aggregated commitment per pass). Failures raise ONE
deduped attention item per findings-set; an unreachable server exits with a named
`ledger-unreachable` result and zero partial mints.

## When to use (agent proactivity)

- "Why won't this apprenticeship instance complete?" → read the refusal reasons
  (class id + rule name; never raw matrix content) and the decision log.
- "Accept the declared gaps" → drive the enumerate + PIN/reply acceptance routes —
  a prose "accepted" is structurally insufficient by design.
- "Is the gate enforcing yet?" → `GET /guards` (the
  `apprenticeship.stallCoverageGate.enabled` row shows live/soaking posture).
