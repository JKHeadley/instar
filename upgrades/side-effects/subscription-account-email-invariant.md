# Side-Effects Review — Subscription account email invariant

**Version / slug:** `subscription-account-email-invariant`
**Date:** `2026-07-23`
**Author:** `Instar Agent (instar-codey)`
**Second-pass reviewer:** `updater_deferral_review (independent, CONCUR)`

## Summary of the change

New subscription registrations prove their provider email from the credential
slot; old email-less rows receive one bounded boot repair and otherwise appear
as explicit gaps. Follow-me resolution returns honest missing/conflict/not-found
codes. Its autonomous consumer now uses durable pair-scoped finite backoff.

## Decision-point inventory

- `POST /subscription-pool` — modify — provider proof, not caller input, admits identity.
- `resolveFollowMeEnrollTarget` — modify — unanimous holder identity or typed refusal.
- `driveDeliveredFollowMeEnrollments` — modify — persisted eligibility schedule bounds retries.

## 1. Over-block

A non-Anthropic registration is refused until that provider has a real identity
adapter. This is intentional: accepting an unproved email would recreate the
incident class. A temporarily unavailable Anthropic profile endpoint also
refuses registration; an already complete account remains usable.

## 2. Under-block

Production account creation and identity repair are both module-private
symbol commits held by `SubscriptionAccountEmailRegistrar`; generic `update()`
has no email field. The only direct fixture seam throws outside `NODE_ENV=test`.
Legacy
email-less rows remain readable only through `listEmailGaps()` and never enter
selectors or normal account reads.

The finite retry row persists a semantic holder-email/gap/mandate evidence key.
An unchanged pair parks after four attempts; changed identity or authority
evidence deletes that episode and permits one new bounded episode. The live
sweep also deduplicates all applicable mandates to one attempt per pair.

## 3. Level-of-abstraction fit

Provider truth is resolved at the registration boundary using the existing
credential identity oracle. The pool owns validation/persistence, the resolver
owns holder agreement, and the consumer store owns retry eligibility. No
parallel enrollment authority was introduced.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart gate.

The identity oracle supplies evidence; the existing enrollment expected-email
gate remains the authority. Retry scheduling is an enumerable finite-state
invariant, not a language heuristic.

## 4b. Judgment-point check

No static heuristic is added at a competing-signals decision point. Email
presence, canonical equality, mandate expiry, and attempt number are enumerable
invariants.

## 5. Interactions

- **Shadowing:** direct registration validates shape and credential-field
  smuggling before the network oracle so malformed requests keep their existing
  deterministic 400 response.
- **Double-fire:** one `AgentServer` sweep remains the only live delivered-
  mandate caller; the backoff store does not start its own timer.
- **Races:** the existing sweep single-flight encloses store reads and writes;
  persistence uses tmp+rename. Legacy repair CAS-checks the independent
  credential-ledger epoch before and after the provider probe.
- **Feedback loops:** failure advances monotonically through three delays to
  parked. Success clears the pair. Identity failures wake only when holder
  evidence becomes unanimous; authority failures wake only when the applicable
  mandate set changes.

## 6. External surfaces

The pool GET adds `emailGaps`; complete `accounts` remains the normal list.
Follow-me 409 bodies add `code` and `accountId` while keeping `error`. The
dashboard shows the exact actionable error, and the PIN-gated repair route
provides the phone-complete remediation. A machine-local JSON backoff file is
added. No credential, token, config-home content, or raw provider response is
replicated or displayed.

Boot reconciliation shares one oracle instance with the ledger, enrollment,
and HTTP routes. When legacy gaps exist, repair runs against the preserved
independent binding and destructive ledger seeding is skipped; complete pools
may seed normally. The server starts without waiting, while inventory-tagged
identity mutation routes return a stable temporary 503 until the bounded
reconciliation finishes.

The touched operator action stays phone-completable in the existing account
matrix; no new laptop-only action was added.

## 6b. Operator-surface quality

1. **Leads with the primary action:** yes; the existing matrix action remains in-place.
2. **Zero raw internals as primary content:** yes; the server code is not rendered, only plain corrective text.
3. **Destructive actions de-emphasized:** yes; no destructive action was added.
4. **Plain language + phone width:** yes; the change replaces one status string in the existing responsive cell without adding layout width.

## 7. Multi-machine posture

**Machine-local BY DESIGN:** credential proof and retry act on the credential
slot and delivered mandate held by that target machine. Non-credential account
metadata remains replicated through `subscription-account-meta`, and pool reads
remain proxied/merged through `?scope=pool`. No new user-facing notice or URL is
generated. The durable retry row does not follow topic transfer because it is
bound to a physical account-machine pair.

## 8. Rollback cost

Revert and ship a patch. The additive `emailGaps` field is harmless to old
clients. The backoff JSON may be left on disk; old code ignores it. Repaired
emails are truthful provider-attested metadata and do not require reversal.

## Conclusion

The change closes the incident at its three recurring seams: incomplete
registration, misleading refusal, and unbounded retry. Identity writes are
registrar-owned, legacy repair requires independent stable binding evidence,
and the live hammering loop is structurally bounded with causal wake.

## Second-pass review (if required)

**Reviewer:** updater_deferral_review
**Independent read of the artifact:** CONCUR after three blocking passes. The
final pass independently verified the real route-capability inventory, bounded
deadline repair, and pool-scope gap aggregation (18 focused tests green).

## Evidence pointers

The invariant-focused slices are green: 157 unit tests, 87 integration tests,
and 23 E2E tests. The production build and the full lint chain are green.

The full integration configuration is green: 453 files passed, 2 skipped;
3,714 tests passed and 12 skipped. The full E2E configuration completed after
disabling pnpm's dependency auto-repair for the nested preflight harness:
314 files passed, 1 skipped; 2,981 tests passed, 8 skipped, and 3 todo. Two
pre-existing host-timing scenarios remained red: the ultracode argv delivery
probe and the Telegram respawn readiness probe. The exact nested dev-preflight
E2E is green when run against the stable dependency tree.

The default configuration was also exercised end-to-end. Its invariant-owned
tests stayed green; unrelated headless-spawn and host-timing failures remained,
and the first run exposed the same nested pnpm auto-repair harness issue before
the stable rerun of the dedicated integration and E2E configurations.

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`, `closure: guard`,
`guardEvidence: { enforcementType: ratchet, citation:
tests/unit/follow-me-consumer-backoff-store.test.ts, howCaught: a permanently
failing account-machine pair advances through three bounded delays and reaches
a durable parked steady state after its fourth attempt, so an every-minute
failure edge cannot remain eligible }`. Repository-wide self-action convergence
coverage remains in `tests/unit/self-action-convergence.test.ts`.

## Mini-node continuation checkpoint

The email-invariant lane was resumed on the Mini, its stale fixtures were
updated for provider-attested email identity, and the full ceremony/test pass
above was completed. The Claude subscription-pinning E2E now explicitly pins
its claimed framework, so a Codex-hosted runner cannot turn the resolver into
the correct non-Claude no-op.
