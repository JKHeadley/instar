<!-- bump: patch -->

## What Changed

The Development page explains triage and readiness limits using the serving route. Subscription triage shows its daily call cap and the account usage threshold where it pauses. Subscription readiness shows approximately how many daily calls its processing budget covers. The dollar field appears only when the server confirms a metered API route.

## What to Tell Your User

The feedback approvals now show the model calls a subscription can use per day. Triage also shows when it pauses to leave room for other work on the account.

## Summary of New Capabilities

The Development page can distinguish subscription limits from a metered API cap.

## Evidence

Focused approval and route tests cover the subscription projection and unknown routes. Disposable Chromium fixtures cover the subscription and metered presentations at 390 and 1280 pixels and refresh the proposal after the batch limit is edited.
