# Needs-you confirming review

The independent agent and the cross-model reviewer reviewed draft f93983a4 after the original six rounds. The independent agent confirmed the typed batch action, partial answers, signed evidence checks and stale-instruction safeguards. It identified missing authority rules for withdrawal. The cross-model reviewer identified three additional requirements for partial-batch redisplay, pooled resume positions and incomplete-count semantics.

The amended draft requires a live authorized coordinator and current lease. The source compares the exact pending ask identity atomically at append. It records withdrawal separately from lifecycle and owner decision records. It also specifies a fresh disclosure for the unanswered items, retention of the first unreturned candidate and a lower-bound count on incomplete reads.

The dark prototype is exercised by 54 focused unit tests and two server lifecycle tests. Its lifecycle test injects coordinator authority and a journal. It proves the route rejects an unauthorized caller, persists one withdrawal for equal retries, suppresses that exact ask and admits a newer episode. Production needs an authenticated source adapter and durable journal integration. The confirming review found material issues on the reviewed draft, so convergence is still open for the amended contract.
