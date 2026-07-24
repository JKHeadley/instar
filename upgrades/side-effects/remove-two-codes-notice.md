# Side-Effects Review — Retire the Two-Codes Sign-In Disclaimer

**Version / slug:** `remove-two-codes-notice`
**Date:** `2026-07-23`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** not required (no decision-point surface)

## Summary of the change

`EnrollmentWizard.flowNotice()` — the only producer of the "a brand-new Claude
login often asks for TWO codes" disclaimer — is deleted, along with the
`notice:` population in `EnrollmentWizard.start()`. No built-in flow populates
the pending-login `notice` field anymore. The generic optional-notice plumbing
(store field, API passthrough, dashboard if-present rendering) is retained;
its test fixtures now use neutral text so the render path stays covered
without re-shipping the stale advice. Operator directive 2026-07-23 (topic
29723): stop surfacing this disclaimer everywhere.

## Decision-point inventory

None touched. The notice was static informational text attached to pending
logins; it gated nothing, blocked nothing, and fed no classifier. The S7
email-identity gate, enrollment TTL/reissue machinery, and mandate
authorization paths are untouched.

## 1. Over-block

Not applicable — no block/allow surface exists in this change.

## 2. Under-block

Not applicable — nothing was previously blocked by the notice. The residual
risk is informational only: in the rare case Anthropic's sign-in still asks
for an email-verification code before the sign-in code (occasionally seen on
mobile), the operator sees that step without a prior warning. The provider's
own page walks them through it.

## 3. Level-of-abstraction fit

The removal is at the producer (wizard) layer, not the render layer — the
right place: render sites stay generic and any future notice-producing flow
gets them for free. Deleting the render plumbing instead would have coupled
this text decision to three UI surfaces.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no new block/allow surface and removes none.

## 4b. Judgment-point check

No heuristic added or removed at any decision point. Static text deletion.

## 5. Interactions

- **Shadowing:** none — no other component produced or keyed on the notice
  text. A repo-wide sweep for the disclaimer text and `flowNotice` references
  confirmed the producer was singular.
- **Double-fire:** none — nothing fires.
- **Races:** none — the `notice` field simply stays undefined; every consumer
  already handles absence (`?? null` / if-present rendering).
- **Feedback loops:** none.

## 6. External surfaces

Pending-login API responses now carry `notice: null`/absent where they carried
the disclaimer string; every consumer (dashboard subscriptions tab, matrix
cells, Telegram relay of login links) already renders nothing for an absent
notice. No schema change — the optional field remains in the type. Existing
persisted pending logins that carry the old notice string still render it
until they expire; no migration is needed for ephemeral TTL-bounded records.
