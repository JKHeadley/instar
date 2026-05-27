# Instar Upgrade Guide — NEXT

<!-- bump: patch -->

## What Changed

**Framework-Onboarding Mentor System — playbook promotion + observability (§19.5).** The final
buildable-while-dormant piece. Adds the playbook lifecycle (`none → candidate → extracted →
superseded`) with a **non-Echo attestation gate**: the mentor can flag a lesson as a candidate, but
it cannot promote its own lesson into the reusable onboarding checklist — `candidate → extracted`
requires a non-Echo party to attest, and who attested is recorded. This is the structural anti-gaming
guard that keeps the playbook from being end-to-end under the proposing agent's control. Also adds an
adversarial-telemetry read-out: bucket-distribution (a spike in "blame the mentee" is the tell),
leak-suspected count, probable-loop count, and how many lessons reached the playbook.

Two new read-only routes; the `promoted_by` column migrates forward on existing ledgers via an
idempotent `ALTER TABLE`. Still part of the dormant mentor system — nothing activates.

## What to Tell Your User

- The mentor can now nominate a lesson for the reusable checklist, but it can't graduate its own
  lessons — that needs a sign-off from someone other than the mentor, and the system records who.
- There's a one-glance read-out of the issue mix and the safety counters (leak hits, runaway-loop
  flags), so drift is visible.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Playbook promotion | `POST /framework-issues/:id/promote` `{status, promotedBy}` — `extracted` requires a non-Echo attester |
| Observability telemetry | `curl -H "Authorization: Bearer $AUTH" http://localhost:<port>/framework-issues/observability` — bucket distribution + leak/loop/extracted counts |

## Evidence

Net-new feature, not a bug fix — no prior failure to reproduce. The non-Echo gate is proven on both
sides: a unit test asserts `candidate→extracted` is **refused when the attester is `echo` or empty**
(throws "non-Echo attestation required") and **allowed + records `promoted_by`** for a non-Echo actor;
an integration test confirms the same over HTTP (400 for Echo, 200 + `promotedBy` for a non-Echo
attester). Observability counts are asserted against a seeded ledger. 11 new tests; affected
push-config suite green vs canonical main; route docs-coverage 56% ≥ 55% floor.
