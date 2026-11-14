# Side effects: make the 347 s multi-page graph proof opt-in

**PR:** #3090 · **Tier:** 1 (test selection only) · **Author:** Echo

## What changes

`tests/integration/conversation-graph-replication-contexts.test.ts`: the test "repairs a multi-page historical context across restart through the signed-peer ceremony" now runs only when `GRAPH_HISTORICAL_CONTEXT_SCALE_PROOF=1`, the same flag as its >3 MiB sibling. It took 347 s on the Studio. The integration lane is serial (`fileParallelism: false`, 30-min deadline), so this test pushed every Studio integration lane past the deadline from 2026-11-11 16:05Z. No production code, assertions or timeouts change.

## Side effects

- **Default coverage lost:**
  - the `contextPages >= 2` multi-page signed transfer (128 KiB pages);
  - page-boundary behaviour at moderate volume;
  - the bounded stage-byte and `referenceBytes` checks at 300 rows.

  The 8-row smoke still covers the native, activation, signed-peer, restart and source-loss repair path.
- **Risk:** a pagination regression would pass the default gate until the opt-in proof runs. Mitigation: the follow-up (CMT-1637, draft #3094) adds a fast default 112-row multi-page test (87 s, real 128 KiB pages), which joins the default lane once lane headroom is confirmed.
- **Signal vs authority:** no decision point is touched.
- **Rollback:** revert this one-line `it.runIf` wrapper.

## Second-pass review

**Reviewer:** independent Claude Sonnet subagent (fresh context, given the diff and the files rather than the author's conclusion), 2026-11-11 20:28 PST

**Verdict: CONCUR.**
- The change is limited to test selection, and it matches the existing pattern for the 4,000-row proof.
- Gating the test is the better trade than a lane that always fails Local Verify.
- Risks it named: pagination regressions pass the default gate, and flag-gated tests go stale unless something runs them.
- It asked that the follow-up be tracked; that is CMT-1637 and draft #3094.
