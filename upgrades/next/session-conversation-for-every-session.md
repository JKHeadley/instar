<!-- bump: patch -->

## What Changed

New session has a fourth choice, "Instar app conversation" (`POST /sessions/create` with `platform: 'app'`, and the phone's New session). The agent creates a native conversation named after the session, sets its engine and model if you picked them, and starts a session attached to it. You then talk to it in the app, and part 1's engine switching works on it. With no Telegram or Slack connected, this is now the automatic choice instead of terminal-only, which stays available. On a machine that doesn't run your app conversations, the conversation is still created, and its first message starts the session on the right machine. The dashboard and app session lists no longer hide app-conversation sessions as internal helpers.

## What to Tell Your User

When you start a new session, you can give it its own conversation in the Instar app, so you can talk to it from your phone and switch its engine later. If you don't use Telegram or Slack, that's now the default.

## Summary of New Capabilities

- `POST /sessions/create` with `platform: 'app'` (answers `conversationKey`; `started:false` with a reason when the session couldn't start yet)
- "Instar app conversation" in New session on the dashboard and the phone

## Evidence

Unit, integration and end-to-end tests. Integration covers:
- create, seed and start;
- the automatic choice;
- a standby;
- a refused start;
- a repeated request;
- refusals before anything is created.
