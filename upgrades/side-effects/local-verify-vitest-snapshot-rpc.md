# Local Verify snapshot RPC recovery side effects

- Over-block. A missing report, mixed errors, or a different worker RPC method misses the recovery and follows normal verdict handling.
- Under-block. The exact message allows a single rerun. Only fresh complete test evidence can enter the existing passing decision. Genuine assertion failures remain visible to the ordinary verdict path.
- Layer. The installed orchestrator sees the trusted reporter, exit status, report, lane selection and remaining gate budget together. Vitest’s test timeout is unrelated to this worker timer.
- Signal versus authority. The timeout authorizes repeating the process once. Existing result evaluation retains authority to pass the gate.
- Interactions. Fresh files and temporary directories prevent retry reports from inheriting the first process’s evidence. Existing sibling cancellation and the total gate deadline still apply.
- External surfaces. The unit lane can take longer after the exact timeout. The audit reports the rerun. No new config or API is required.
- Multi-machine posture. The active runner owns per-invocation cleanup and reports on its own host. Existing signed verifier receipts carry the final result to the coordinator.
- Rollback. Revert the change. There is no persisted state migration.

## Second-pass review

**Reviewer:** Codex peer gate design reviewer (`peer_gate_design_review`), independent source review.

The reviewer first identified that a zero-error count could conceal malformed or contradictory reporter messages. After the fix required an exact empty message list, the reviewer concurred with the revised source and tests. The review confirmed the one-shot retry, fresh outputs, dirty-worktree check, total deadline and existing assertion authority. No runtime code changed after that concurrence.
