<!-- bump: patch -->
## What Changed

Conversations → Review suggestions no longer reloads itself every 30 seconds. The console's periodic page refresh re-ran the Conversations page, which cancelled an Accept or "Accept all projects" mid-way and redrew the same list, so a tap looked like it did nothing. The suggestions view now refreshes only on its own Refresh button, and a running Accept holds any page refresh until it finishes. When an Accept stops (the PIN unlock lapsed, or another machine has not confirmed a step yet), the card says why and offers Continue.

## What to Tell Your User

- "The suggested-projects page stays put now: it won't reload under you, and Accept all runs through. If it has to pause, it tells you why and you can tap Continue."

## Summary of New Capabilities

- Review suggestions stays still while you work on it, and Accept / Accept all are no longer cancelled by the page refresh.

## Evidence

- `tests/unit/console-conversations-dom.test.ts` (new: suggestions view opts out of the page refresh; refresh held during an Accept; ordinary list unchanged).
