<!-- bump: patch -->
## What Changed

- Needs-you strip (dashboard): closed by default as one line (tone dot, "Needs you · N" / "N+", first need on one line); opens to the full list with paging, could-not-check sentences at its bottom, and "Hide". The badge reads "N+" for "at least N". Matches the Instar app's build-120 line.
- Unnamed conversations: a Telegram topic with no stored name shows its Chief of Staff project title in the app's conversation list (`GET /mobile/conversations`), conversation search, and the dashboard (`GET /telegram/topics?scope=pool` now carries `fallbacks`). A stored name always wins; the title is never saved as the topic's name.

Overview: `docs/specs/needs-compact-and-name-fallback.eli16.md`.

## What to Tell Your User

"Needs you" is now a single calm line at the top; tap it to see the list. Conversations that lost their names show their project's title instead of "Name not available yet".

## Summary of New Capabilities

- `GET /telegram/topics?scope=pool` returns `fallbacks: [{ topicId, title, source: 'project' }]` for topics no machine can name.

## Evidence

- Unit: `tests/unit/conversation-fallback-title.test.ts`, `tests/unit/console-needs-pages.test.ts`. Integration: `tests/integration/telegram-issue-topics-route.test.ts`. Screenshots at phone and laptop size.
