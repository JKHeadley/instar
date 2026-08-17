# Standards direction guard

The standards pipeline compares every Rule-bearing article with the protected-base
registry. Additions, removals, and edits require a direction ratification bound to
the exact base revision, registry hashes, article identity, and before/after article
hashes. An edit declares `strengthen`, `neutral`, or `weaken`; the declaration has no
authority until its Ed25519 signature verifies.

## Trust boundary

The approver public key is read from the protected-base revision at
`.github/keyrings/telegram-principal-pub.pem`. CI extracts that exact file from the
base SHA before running the check. The candidate checkout's copy is never a trust
source, so replacing the candidate key and signing with the replacement does not
authorize a change. Candidate pin bytes are also compared with protected base and
any drift is refused even when the registry itself is unchanged. This closes a
two-step attack where a pin-only change lands first and authorizes a later weakening.

Bootstrap and rotation are consequently not self-service repository changes. They
require an explicitly separate protected-main control-plane authorization that can
bypass this one immutable-pin check; ordinary PR CI always refuses the drift. Once a
real pin exists, changing it through an ordinary candidate is never accepted merely
because that candidate supplies a matching signature.

The corresponding private key must remain outside the repository, agent-readable
credential stores, and build environment. The current fleet file is a comments-only
placeholder: no production approver key is configured, and therefore every standards
change fails closed until an independently controlled key is deliberately installed
in protected main. The test suite uses ephemeral fixture keys only; none are reusable
approval credentials.

## Identity and rename cost

An explicit `Article ID` is authoritative. Existing articles that predate explicit IDs
receive a deterministic legacy identity derived from family and heading. Renaming one
of those headings is deliberately conservative: it appears as one removal plus one
addition, and both require independent ratification. That review friction is the cost
of preventing a rename from resetting constitutional identity.

## Approval ledger

Candidate ratifications live in `docs/standards-direction-approvals.json`. The ledger
is declarative evidence, not a trust root. A stale, forged, self-signed, wrong-base,
wrong-article, or replayed record is rejected. A legitimate strengthening follows the
same signed path as a weakening; the guard does not use keywords to infer prose meaning.
