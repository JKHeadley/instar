# Offline judge prototype impact

Tier 1. This reversible draft checkpoint adds internal evaluation helpers and 35 focused synthetic checks. There is no production caller, network or tool access, persistence, route change, setting, migration or release behavior.

1. **Over-block.** Ambiguous or mismatched evidence produces an incomplete research result. Existing judge records are retained by the caller.
2. **Under-block.** Correct hashes cannot authenticate host receipts. The schedule check compares receipts to the frozen plan. An integrating host still needs to pass the independently held plan digest and selected trial identity. The composed helper checks the schedule from the same parsed plan. The offline composition takes retry limits from the verified plan, shares selected attempts across binding and disclosure checks and preserves an explicit empty slot when a selected receipt is missing.
3. **Abstraction.** Helpers verify frozen inputs, select retries, bind raw results and summarize research evidence. Adjudication summaries receive only receipts accepted by the host and preserve the original signals. Missing or duplicate signal identities prevent adjudication summaries. Reference coverage compares replacement IDs against a host-frozen inventory. The host owns structural validation and evidence custody.
4. **Signal versus authority.** Consensus and independence are separate evidence. Neither outcome authorizes qualification, routing or activation.
5. **Interactions.** The prototype has no production call sites or settings. Unit and composed tests use invented inputs and a structural validator stub. An explicit test helper repeats the cross-worktree probe against the real offline validator. It loads executable code only from a caller-selected trusted local checkout.
6. **External surfaces.** No new files are read or written by the helpers. The real-validator check is a manually invoked research test. No production command, API, dashboard or external connection is added.
7. **Multi-machine posture.** No deployed state is created. The draft branch carries source and invented fixtures only.
8. **Rollback.** Revert this checkpoint. No live configuration or data migration is needed.

An early independent consensus review informed distinct slot states and the structural-only result. Independent review of the complete prototype and the shared repository verification remain pending. This is a draft for preserving work, with no release request.
