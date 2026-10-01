# Feedback readiness authority: a timeout no longer demotes it, a restart no longer voids it

## What Changed

Three live faults in the operated feedback drain's readiness authority (Mac Studio,
2026-09-30/10-01), fixed in `src/feedback-factory/drain/`:

- **One timeout demoted the authority for good.** The arbiter gave codex 20s for a
  50-candidate batch; the call hit `CodexExecJsonTimeoutError` and the drain demoted the
  authority to proposal-only with reason `readiness-schema-provenance-or-routing-failure`.
  Failures are now classified: `ReadinessContractViolation` (canary/envelope drift,
  resolved model or framework mismatch, output outside the decision schema) still demotes
  at once; a timeout or provider error is retried at the next review (15 min) and
  demotes only after `READINESS_TRANSIENT_FAILURE_LIMIT` (3) in a row (reason
  `readiness-authority-repeated-invocation-failure`). The model call budget is now 60s
  (`FEEDBACK_READINESS_MODEL_TIMEOUT_MS`) with its own stage budget; the run wall clock
  ceiling moved from 90s to 115s (under the 120s run lease). A reply wrapped in one
  markdown fence is accepted.
- **Same-machine restarts voided the approval.** The authority bound an exact owner
  epoch, and the lease epoch advances on every routine restart (22677 → 22679 live), so
  a stale-owner rejection would have needed a fresh PIN approval after every release.
  The store now records the drain owner's tenure (`drain_owner_continuity` in
  `drain_meta`; pre-marker stores derive it from run history). An authority approved for
  this machine survives same-machine epoch advances; another machine running the drain,
  or a finalized restore, still requires re-approval. The proposal card no longer shows
  "replace" for a same-machine epoch advance.
- **One suspicious title escalated the whole batch.** A title containing
  `execute.type:script` tripped the injection pattern, and all 50 candidates were
  escalated without the model being asked (run 1's "50 decisions, 0 ready"). Only the
  suspected candidate is escalated now; the rest go to the model.

## What to Tell Your User

The feedback sorter had stopped after one slow answer from the model. It now waits
longer, retries a slow answer instead of shutting itself off, and only stops if the
model keeps failing or breaks the rules. Your approval also survives routine restarts
on the same computer. Because the old version already switched itself off, approve it
once more on the dashboard's Feedback Drain tab, using the same PIN as before. After
that, a restart doesn't need a new approval.

## Summary of New Capabilities

- Readiness authority survives same-machine restarts; failover/restore still needs re-approval.
- Transient readiness model failures are retried; three in a row demote.
- Per-candidate injection escalation; 60s readiness model budget.
