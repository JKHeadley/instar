# Side-effects review for explicit native first turn

The server-owned launch adapter opens a private app-server pipe and obtains the native thread identity without sending work. It rechecks the admission and the private home before binding the native ID and home identity to the saved claim. It sends one turn/start only after that write. A failed or ambiguous reply does not retransmit. Rejection closes the controller and leaves the durable hold in a non-actuating state.

The native tests cover successful first input, changed admission and controller EOF with zero model requests before the first turn. The old hook-only barrier has no production authority. No server startup caller, default flip, live account wiring, or app-server Stop lifecycle is included. Unexpected post-start faults still need a production supervisor to close the controller and report the execution outcome.

## Class-Closure Declaration

The prepared native pipe and first-turn request are one-shot under the existing durable work claim. No autonomous retry, polling loop or unbounded-self-action is added.

## Second-pass review

**Reviewer:** explicit_turn_review, independent Instar second-pass agent

Concur for the disabled launch composition. Native identity and private home are bound before the sole first-turn write. Rejection and failed release await teardown while preserving the durable hold.
