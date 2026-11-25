# Side-effects review for managed Stop precedence

The packaged hook sends an enrolled worker's Stop through the authenticated managed decision path before reading an older autonomous run file. A local emergency stop allows exit before any server call. The launch tag selects a route. The server still verifies enrollment and authorizes every continuation.

An untagged worker follows the existing autonomous or explicit task-ledger path. The migration upgrades known stock hook bytes, including the first managed version, and preserves unrecognized local copies. The feature remains disabled by default with no new launch path in this change.

The tests exercise an allow and continue response with an active older run, an emergency stop with no server call, and exact predecessor migration. The packaged lifecycle fixture also starts with an active older run on disk.

## Second-pass review

**Reviewer:** managed_legacy_precedence_review, independent Instar second-pass agent

Concur with the routing and exact-hash migration. The server retains authority and the emergency flag prevents a managed request. The reviewer requested a history-independent predecessor fixture and explicit managed emergency-stop coverage. Both are included.
