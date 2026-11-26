<!-- bump: patch -->

## What Changed

The Development page shows a Promote action when the feedback service returns a batch ready for owner approval. The review lists the work items that run first, the maximum for each run, and what happens when an item is held. Approval sends the exact proposal and PIN in one request. A stale proposal is refreshed so the owner can review the current batch.

## What to Tell Your User

When Feedback is ready to start creating work items, it shows one approval on Development. Open Promote to review the batch and confirm with your PIN. Feedback updates the approval count after the server accepts it.

## Summary of New Capabilities

Review and approve feedback promotion from the Development page.

## Evidence

Dashboard tests and disposable Chromium fixtures cover the pending count, exact review, one-request PIN, success refresh, configured simulation and stale proposals. The promotion control requires the server proposal response.
