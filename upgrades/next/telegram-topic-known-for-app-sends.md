## What Changed

A message or file sent from the app into a Telegram topic is no longer refused as "This conversation no longer exists on the agent" when the serving machine shows that topic's history but never named it or bound a session to it. This happened with job topics named on another machine: Justin's "Email Check - Justin" topic was named on the laptop, the app listed it from there, the Mac Studio showed its history and posted job notices into it, and every send from the app into it was refused. Text send, file upload, pins, read marks and "open session" now share one rule (`src/messaging/telegramTopicKnown.ts`): a topic is known when this machine has named it, bound it to a session, or holds history for it. A topic with none of these is still refused.

The scheduler notice "it is set to run only on another machine, and this machine is the one running jobs" now names this machine and the machines the job is pinned to, and says how to fix it: add this machine to the job's `machines` list, remove the list, or disable the job.

## Evidence

Reproduction, 2026-11-12 on Luna's Mac Studio: topic 534 had job notices in `telegram-messages.jsonl` (2026-11-10, 11-11, 11-12) but no entry in `topic-session-registry.json`; the photo upload returned 404 `unknown-conversation`, and the text send's check (`getAllTopicMappings`) would refuse with `unknown-topic`. After: `tests/integration/mobile-operator-chat.test.ts` sends into a topic that has only history on this machine and gets 200 with the message routed; a topic with no name, session or history still gets 404 `unknown-topic`. `tests/unit/telegram-topic-known.test.ts` covers both sides plus an unreadable log. `tests/unit/job-continuity-alert.test.ts` checks the notice names both machines and the fix.

## What to Tell Your User

If the app ever said a Telegram conversation "no longer exists" while you could see it and its messages, that is fixed: you can send messages and files into it again. Notices about a job pinned to another machine now say which machine and how to fix it.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| App sends into any Telegram topic this machine shows | Automatic |
| Pinned-job notice names the machines and the fix | Automatic |
