# Side-Effects Review — the server must supply an oracle that speaks Codex

## Summary of the change

The enrol route falls back to a composite (Codex-aware) identity oracle only when the server
supplies none. The server has always supplied one — the plain Anthropic oracle — so the
fallback never ran and Codex enrolment still failed `email-unresolved` with a working Codex
reader present. The server now constructs the composite oracle for SUBSCRIPTION identity and
passes it. The credential-LOCATION ledger keeps the Anthropic oracle.

## The pattern this completes

Three layers, three releases, each passing every test that existed:

1. **The oracle** could not read a Codex slot. Fixed; test drove the reader.
2. **The route's provider gate** refused Codex before asking the oracle. Fixed; test drove
   the registrar — one layer below the gate.
3. **The oracle wiring**: the route's Codex-aware default was dead code because the caller
   always overrode it. Found by attempting the enrolment again after (2) shipped.

Each fix was correct and each test was honest. What none of them did was exercise the
operation the whole feature exists to perform, on the real surface, in a real environment.
That is precisely the Live-User-Channel Proof standard, and this feature is now a three-time
demonstration of what its absence costs.

**A default that a caller always overrides is not a default.** That is the reusable finding.

## Decision-point inventory

One: which oracle answers "who is signed in to this credential slot?" during subscription
enrolment. It gates enrolment only; it grants nothing.

## 1. Over-block / 2. Under-block

Over-block: none introduced. The composite tries Codex, then falls through to the identical
Anthropic path — an Anthropic slot takes the same code with the same result.

Under-block: the composite reports a Codex home that cannot identify itself as
`codex-slot-<reason>` rather than masking it as an Anthropic failure, so an unverifiable slot
is still refused, with a more honest reason than before.

## 3. Level-of-abstraction fit

Scoped deliberately. Subscription-account identity and credential-LOCATION identity are
different questions: the ledger and its gate are the Claude credential re-pointing machinery
and are Anthropic-specific by design. Widening the ledger's oracle would change
quarantine/repair behaviour for Codex homes — a different feature with a different blast
radius. A test pins that the ledger keeps the Anthropic oracle.

## 4. Signal vs authority

Unchanged. The oracle reports identity; the registrar decides. This swaps which reporter is
asked, not who decides.

## 5. Interactions

The credential-field guard still runs first, so the registry still cannot be handed a token.
Enrolled accounts are untouched. The ledger, its gate, and the identity audit keep the exact
oracle instance they had.

## 6. Multi-machine posture

Machine-local BY DESIGN. Identity is read from a credential slot on this machine's disk.
Nothing replicates.

## 7. Failure modes

The composite delegates to the Anthropic oracle on any non-Codex slot and on an
`auth-file-missing` Codex probe, so an Anthropic-only machine behaves identically. A Codex
read that throws is caught inside the composite and falls through, which is pre-existing
behaviour covered by the earlier suite.

## 8. Rollback cost

Pass `credentialIdentityOracle` instead of `subscriptionIdentityOracle` — one identifier.
No state, no migration.

## Evidence

12 tests in this file. The three new ones: the server passes the composite (verified by
restoring the old wiring — it fails, so it catches the defect that shipped); the ledger keeps
the Anthropic oracle, so scope stays narrow; and an end-to-end property stated as behaviour
rather than wiring — the composite resolves a Codex slot with a CONTROL asserting the plain
oracle genuinely cannot, so the result is attributable to the composite rather than to an
easily-resolved fixture.
