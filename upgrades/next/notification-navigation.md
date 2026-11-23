# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed
A slow Mark read save on Notifications could refresh that page after the person had already opened another page. Refresh now belongs to the exact view that started the save. The save completes normally and active views still refresh.

## What to Tell Your User
Marking a notification read no longer pulls you back to Notifications if you open another page before the save finishes.

## Summary of New Capabilities
No new capability; repair of delayed notification refresh behavior.

## Evidence
Deferred-response rendered-page tests reproduce navigation, newer filter and removed-page cases. Existing active-view save coverage remains. Full shared verification and released live checks remain pending.
