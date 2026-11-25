# App Delete local storage checkpoint review

The independent review examined exact target binding, immutable creation custody, raw journal reads, byte locator validation and out-of-order replay. Its final proof concern was addressed by checking the decoded conversation and event IDs on both records. The focused tests exercise a durable fact before its target, rebuild, constructor reopen, index disagreement, duplicate facts, and wrong custodian or target.

Cross-model reviews of the combined design raised future admission and projection choices. The contract now requires the original custodian and request-bound intent, a durable authoritative-read restriction, a replayable cursor boundary for unresolved authorization, and catch-up before restoring a client cache. A missing or unreadable proof remains distinct from an accepted durable writer record. This disposition covers the local storage checkpoint only. The combined route, network and native contract will need implementation evidence before it can be enabled.

Related work includes signed App Forward and Reactions custody, exact message context, App journal replay, mobile unread projection, attachment purge and native cache history.

The closing Astra review found the two remaining local index-integrity issues resolved. A read snapshot and stable file checkpoint fence concurrent appends. The integrity scan reconciles unique raw removal IDs with both indexes and verifies an invalid candidate through the same negative path. The final local suite passed 25 store tests. Existing signed HTTP and production lifecycle regression suites passed 31 and 2 cases. No claim is made about a Delete route, a peer serving a removal, or a restored client cache.

## Signed fresh admission checkpoint

The next checkpoint introduces a private signed admission helper. Independent review found owner identity namespace and custody error ordering gaps. The follow-up binds the original signed pairing and stable current person, keeps permissions separate from retry identity, and reports custody independently of target identity before looking up any row. A machine namespace mismatch cannot authorize the action. Original signed-device proof still does not establish historical person authorship, so this checkpoint admits conversation owners. The production route, reservation effects and read projections remain unmounted. The private HTTP harness runs the real device authenticator.

The closing cross-model pass found no material issue in the private admission helper. Wrong custody is settled without reading any event, and unnamed operator identities need an account identifier before selection. The production authenticator test covered signed acceptance, exact ID scope, denied or absent target, wrong machine and unavailable holder, unsigned refusal, and namespace changes after owner replacement. No persistence or production Delete action was tested or claimed.

## Local history projection checkpoint

The independent and closing cross-model reviews concurred on this unmounted scope. The initial exact projection checked removal before row authorization. The final version applies the caller's access check first, retains ambiguity for a caller who could see both occurrences, and keeps a link usable for a caller whose only visible occurrence survives. Filtered pagination matches both target identifiers and the custodian before consuming page slots. The proof intentionally checks journal checkpoint and identity consistency, with no claim of detecting content-only tampering. The cold journal scan needs a bounded or background implementation and workload evidence before request-path use.

## Local history proof cache checkpoint

The Astra review concurred on the unchanged proof identity and fail-closed behavior. Its coverage suggestion was applied. The focused regression now counts two scans for A, B, A and a third scan after removing A's message, while separately asserting the visible rows. The cache is capped at 64 entries and index rebuild clears it. Cold proof cost remains a requirement before mounting interactive routes.
