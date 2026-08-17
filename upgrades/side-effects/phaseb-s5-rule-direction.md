# Side-Effects Review — Standards Direction Guard

**Version / slug:** `phaseb-s5-rule-direction`
**Date:** `2026-08-17`
**Author:** Instar-codey
**Second-pass reviewer:** pending independent reviewer entry below

## Summary of the change

This change adds `scripts/standards-direction-guard.mjs`, integrates it into
`scripts/standards-coverage.mjs` and CI, stores direction approvals in
`docs/standards-direction-approvals.json`, and adds focused behavioral and
negative-control tests. Standards-change acceptance now compares stable article
identity against protected main, preserves removed identities in coverage
denominators, and requires exact independently signed direction ratification.

## Decision-point inventory

- `evaluateStandardsDirection` — **add** — accepts or refuses additions,
  removals, and edits against protected-base identities and signatures.
- `standards-coverage --check` — **modify** — consumes the direction result and
  uses continuity denominators for aggregate and family floors.
- CI standards job — **modify** — extracts protected-base registry and approver
  pin before invoking the existing check entry point.

---

## 1. Over-block

An ordinary heading rename on one of the 86 legacy articles changes its derived
identity and is treated as remove-plus-add, so it needs independent ratification.
Formatting anywhere inside an article also changes its article hash and needs a
declared, signed direction. These are known conservative costs: permissive rename
inference would reopen the identity-erasure path. With the repository's current
comments-only key placeholder, every standards amendment fails closed until a
real independently controlled public key is installed on protected main.

## 2. Under-block

A legitimate approver can ratify a direction declaration that is semantically
wrong; cryptography proves principal and bytes, not judgment quality. If the
approver private key becomes readable to the changer, the principal separation
collapses. The operational requirement is explicit: keep the private key outside
the repository, agent credential stores, and build environments. Candidate key
replacement is closed because the pin is read from protected main and all
candidate pin drift is refused, including a pin-only first step.

## 3. Level-of-abstraction fit

The guard operates at the correct split. Stable identity, before/after hashes,
population union, signature validity, and protected-base acquisition are closed
mechanical facts. Semantic direction remains a human declaration. The code does
not build a brittle prose classifier and does not compete with an LLM authority.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [x] Deterministic hard-invariant authority over a closed governance protocol.

The generic template's first three safe boxes do not describe this case. The
guard has blocking authority, but it does not judge prose with brittle logic.
It verifies enumerable invariants: exact identities and hashes, allowed direction
tokens, signature validity, and protected-base provenance. Human semantic judgment
arrives as a signed declaration. This is the principle document's deterministic
policy-evaluator / hard-invariant exception, not a message-meaning heuristic.

## 4b. Judgment-point check

No static heuristic is added at a competing-signals judgment point. The only
semantic choice, direction, is explicitly made and signed by an independent
principal. Code checks the declaration's closed protocol and never infers the
choice from competing evidence.

## 5. Interactions

- **Shadowing:** the direction guard runs alongside the existing area-audit and
  coverage floors. It adds errors; it does not prevent their evaluation or logs.
- **Double-fire:** a standards edit can produce both a stale area-audit objection
  and a direction objection. This is intentional: one binds review freshness,
  the other binds amendment direction and independent authority. Refreshing the
  first does not clear the second.
- **Races:** all inputs are immutable Git bytes or a candidate JSON file during a
  single CI process. There is no shared mutable runtime state.
- **Feedback loops:** none. The check never writes its approval ledger or registry.

## 6. External surfaces

CI output gains direction status, protected-base revision, trust-root provenance,
an explicit candidate-pin-not-authoritative fact, and a pin-drift-blocked fact.
Standards authors gain a signed JSON approval record. No Telegram, Slack,
Cloudflare, database, conversation, timing, or user data surface changes. No
operator-facing action is added; key custody and protected-main pin installation
remain repository governance operations.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

**Replicated through Git.** The registry, candidate ledger, public trust pin,
guard, CI wiring, and tests are committed bytes. Every machine on the same commit
derives the same canonical hashes and verdict. The signing private key is
deliberately not replicated to agent machines. The feature emits no user-facing
notices, holds no runtime durable state that can strand on topic transfer, and
generates no URLs.

## 8. Rollback cost

Revert the guard, coverage integration, workflow extraction, ledger, docs, and
tests as one patch and ship the next release. No data migration, agent-state
repair, secret rotation, or runtime cleanup is required. During rollback the old
self-attestation weakness returns, so rulebook amendments should remain paused.

## Conclusion

The review found two deliberate friction points and no accidental runtime side
effect: legacy renames require ratification, and the comments-only protected pin
blocks amendments until independent custody is provisioned. The candidate-pin
goalpost attack is closed in both one-change and two-change forms by protected-base
verification plus an unconditional candidate-drift refusal. Normal CI can never
bootstrap or rotate the pin; that requires separate protected-main control-plane
authority. The change is ready for normal CI.

## Second-pass review

**Reviewer:** independent Codex second-pass lane
**Independent read of the artifact:** concern resolved. The first review found
that protected-base verification stopped a same-change pin swap but allowed a
pin-only first step to become the next base. It also found the ELI16 overstated
malformed-placeholder behavior. Candidate pin drift is now always refused, the
pin-only regression is tested, bootstrap/rotation authority is stated explicitly,
and the malformed-key wording now matches the live pipeline. With those changes,
the review concurs on authority separation, denominators, rename friction,
multi-machine posture, and rollback.

## Evidence pointers

- `scratchpad/phaseB/REPORT-S5.md`
- `tests/unit/standards-direction-guard.test.ts`
- `tests/unit/standards-direction-guard-contract.test.ts`
- `tests/unit/standards-coverage-ratchet.test.ts`

## Class-Closure Declaration

`defectClass: claim-vs-evidence`, `closure: guard`, `guardEvidence:
{ enforcementType: gate, citation: scripts/standards-direction-guard.mjs#evaluateStandardsDirection,
howCaught: the exact old self-authored family refresh has no independently signed
direction record, so deletion and weakening remain refused even after that claim
is refreshed }`.
