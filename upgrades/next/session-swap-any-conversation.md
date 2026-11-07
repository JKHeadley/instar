<!-- bump: patch -->

## What Changed

App and Slack conversations can switch engine and model, as Telegram topics could. The dashboard and the iPhone app offer the switch on any session that has a conversation. The phone's door route takes a conversation reference (`telegram:N`, `app:<key>`, `slack:<team>:<channel>[:<thread>]`), and `GET /sessions` rows carry `conversationRef`. App and Slack sessions now start on their conversation's engine and model. A switch restarts the session with the conversation kept, and says so in the conversation. Slack resume records store the engine they were made under, so a switch never resumes the old engine's transcript. Moving between machines is still Telegram-only (next part).

## What to Tell Your User

You can now change the engine or model of an app or Slack conversation from the app or the dashboard, the same way as a Telegram one. The conversation carries on, on the new engine. Moving those conversations to another machine comes next.

## Summary of New Capabilities

- Engine and model switching for app and Slack conversations (dashboard and phone)
- `conversationRef` on `GET /sessions` rows
- `POST /mobile/sessions/door/<reference>` for any conversation
- `/topic-profile/app:<key>`

## Evidence

Unit tests cover:
- reference mapping, authority, the phone's signed line and allowlist;
- the profile-aware app spawn and its message-free restart;
- Slack resume guards and the engine-aware gate;
- the write surface's token rule;
- dashboard and app follow-through.

End-to-end: on a production boot with a paired phone and Face ID, an app conversation's door switch passes the production allowlist and reaches its route.
