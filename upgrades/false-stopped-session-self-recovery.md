# False stopped-session notices now self-recover

## What Changed

A failed session resume can now start its fresh replacement under the name already registered to the conversation. Slack and Telegram health checks use current session, startup, reply, and ownership evidence before claiming a conversation stopped. A genuinely dead unanswered conversation gets one automatic fresh restart; only a failed recovery sends one plain failure notice. Slack thread recovery reads the correct thread history.

## Evidence

Read-only Indra logs showed the old registered session dying while a separately named fallback answered. The fallback-name regression failed before the fix and passed afterward. Focused monitor, proxy, routing, and recovery tests passed; a live Slack API contract suite passed on the demo workspace. The full throwaway-agent Slack restart and death canary, and post-update observation on Indra, remain required to confirm the production result.

## What to Tell Your User

If your session stops while you are waiting, the agent will try to resume the conversation itself. You will hear about it only if that recovery fails. You no longer need to reply with a session-management command.

## Summary of New Capabilities

Conversations recover automatically from a dead session and avoid false stopped notices while a replacement is answering.
