# Side-Effects Review for Sealed Preview Staging

The approved local history contract requires an explicit, immutable preview for a prepared selection. This checkpoint adds internal publication and replay to upload staging. Status does not mint or expose the confirmation challenge. Its existing expiry checks can still persist expiry and start disposal. HTTP, native UI and copy execution remain outside the checkpoint.

## Over-block

A competing reader returns busy and can retry before the original deadline. Writer contention produces the same result after child exit. A tampered receipt, changed owner, changed boot or expired grant fails closed. Only a prepared operation can publish.

## Under-block

Preview can become stale as the destination changes. Replay validates the sealed receipt and prepared index. It returns the original observation and does not rehash each normalized payload. A future apply worker needs to verify all payload digests and EOF before its first mutation permit. Copy admission would need fresh validation and durable scoped write permits. The internal copy-intent inspector checks binding and does not consume a challenge, create a permit or copy data. Expired-row retirement remains subject to the existing review and is not implemented here.

## Abstraction fit and interactions

Upload staging owns the operation deadline, normalized artifact custody and sealed preview allocation. It checks the authenticated owner before and after asynchronous work. The fixed reader keeps the real child custody until it exits. The preview table is created under the existing SQLite metadata reservation. The bounded private receipt is sealed before its row is inserted. Failed publication attempts try to dispose owned allocations through the existing ledger. Unresolved or interrupted creates remain charged for tag recovery. Each preview adds one retained row and one ledger allocation record, so disposed previews still contribute bookkeeping pressure. Retry verifies the digest and returns the same challenge and original deadline. The preview writer lock can create or tighten local lock metadata as accounted for by the existing preview prerequisite review.

## Signal versus authority

Under docs/signal-vs-authority.md, owner, issuer, deadline, hash and explicit selection bindings are protocol facts. Project counts are descriptive. A challenge can be presented for explicit confirmation, but no path in this checkpoint turns it into write authority.

## External surfaces and machine scope

This adds an internal table and methods only. A live preview binds to the issuing machine and boot. Receipts and challenge data are local to that target and never replicated. Existing upload calls keep their explicit completion and preparation steps. Automatic preparation, recovery-only admission, and HTTP activation are outside this checkpoint.

## Rollback

Reverting the internal API leaves the private preview table unused. The existing ledger still owns tagged allocations and retires them using established disposal. No conversation data needs migration because this component publishes only preview metadata.

## Class-Closure Declaration

The unbounded-self-action class does not apply. An explicit preview request runs one fixed read job, and the existing staging custody owns its bounded termination. Replaying a sealed preview starts no new worker. No autonomous preparation or retry loop is part of this checkpoint.

## Independent Review

The independent reviewer concurred with the exact split, with disclosures for existing status expiry, charged failed allocations and retained bookkeeping. Those disclosures appear above. The reviewer did not run tests.

## Reader memory-monitoring evidence

The sealed receipt preserves the fixed reader’s sampled or unavailable status independently of the parser status recorded by project. Replay validates the finite status value and returns the original observation. This adds no memory-control policy or route.
