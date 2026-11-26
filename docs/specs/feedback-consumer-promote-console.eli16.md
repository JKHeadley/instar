# Approving feedback processing from Development

The feedback pipeline can sort incoming reports and prepare work items while it is in practice mode. It needs the owner’s approval before it begins creating work items. Development previously had no button for this step, so Feedback could say nothing needed you while the pipeline was waiting for a decision.

When the machine running Feedback has a batch ready, Development now shows one approval. Select Promote to review the work items in the batch and see the maximum number that feedback processing can create per run. Confirm with your Dashboard PIN. The server checks that the proposal you saw is still current before applying the approval. If the proposal has changed, the page reloads the current batch so you can review it again.

A configured practice mode or an empty queue shows a status without an approval. An approved promotion lets feedback processing create work items within the per-run limit.
