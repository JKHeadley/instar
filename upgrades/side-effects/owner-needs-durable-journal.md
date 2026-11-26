# Dark Chief of Staff journal append

The separate operation checks its writer lock and serving authority before preparing a record and checks them again immediately before append. It validates the same replicated envelopes and acknowledges the exact write only after data and directory sync. Preappend refusal never queues a decision. A marker on the writer's local disk gates later enqueues and complete reads for this kind if acknowledgement is uncertain. Exact reconciliation requires a complete authorized view and a local re-sync. Partial or unproven outcomes remain fenced.

Normal production paths cannot create this marker in this checkpoint. Direct peer serving still needs a matching fence, and stale-lock replacement lacks a non-reclaimable ownership guarantee around the append. Those are activation prerequisites. Rollback on an unused production writer is a code revert.

## Second-pass review

**Reviewer:** Independent journal safety reviewer.
**Result:** Concur for the unwired checkpoint. Sequence reuse and local receipt exposure were fenced after initial feedback. The direct peer read and replacement lock concerns remain explicit prerequisites for activation.
