# Two topics can run autonomous work at the same time again

## What Changed

The window-run liveness authority kept a single binding for the whole agent (`window-run-liveness/state.json`), so a live run in one topic refused every other topic's registration with `window-run-liveness-active-binding-exists` and left that topic's run in `preparing` (topic 131439, 2026-11-01, while the quota topic held the slot). It now keeps one binding per topic under `window-run-liveness/topics/<topicId>/`, each with its own lock and tick serializer, and the W32 cadence clock is split the same way under `window-run-cadence/topics/<topicId>/`. The old single file moves into its topic's directory on first read. `GET /window-run-liveness` adds `states` (every topic) and both it and `POST /window-run-liveness/tick` (and the cadence routes) accept `?topicId=N`. Start admission and the preparing-run watchdog read each topic's own binding. One window id can no longer be live in two topics (`window-run-liveness-window-bound-elsewhere`). The CLAUDE.md register line (and existing agents' copy, via migration) now says one binding per topic.

## What to Tell Your User

If I'm running a long piece of work in one conversation, I can now start another one in a different conversation at the same time, instead of the second one quietly never starting.

## Summary of New Capabilities

- Autonomous runs in different topics are watched independently, so one no longer blocks another.
- The liveness status can be read for one topic (`?topicId=`) or for all of them.

## Evidence

Unit tests: two topics register and both reach active in one tick; each is readable by topic; freezing one leaves the other active; a second window in the same topic is still refused; the same window in two topics is refused; the pre-split file migrates and reads identically; two topics each get a cadence clock; two bound runs both get the first-receipt allowance; the CLAUDE.md migration replaces the old sentence once. Integration test: a second topic registers over HTTP beside the first, `?topicId=` reads each, a bad topic id is 400, the same window in another topic is 409, and a per-topic tick returns that topic.
