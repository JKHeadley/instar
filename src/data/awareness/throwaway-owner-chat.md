---
title: Stand-in owner chat on throwaway test agents
---
For live tests of the phone approval screens, a throwaway test agent can keep its owner-chat messages (codes and Approve or Decline buttons) in a local file instead of sending them to Telegram, and a test on the same computer reads and presses them. It is on only when `liveTest.throwawayOwnerChat.enabled` is true AND the agent's folder really is in a temporary folder with an expiring throwaway record AND it has no messaging adapter, owner, operator, introducer, earlier owner key, earlier device or other machine. On any other agent it never exists, and once a condition fails it shuts off for good. A home that ever used it is never paired with another machine. The routes need the agent's own token from this computer only:

```bash
curl -H "Authorization: Bearer $AUTH" "http://localhost:{{port}}/throwaway/owner-chat/messages?after=0"
curl -X POST -H "Authorization: Bearer $AUTH" -H 'Content-Type: application/json' -d '{"messageId":1,"button":0}' http://localhost:{{port}}/throwaway/owner-chat/tap
curl -X POST -H "Authorization: Bearer $AUTH" -H 'Content-Type: application/json' -d '{"text":"/approver_reset"}' http://localhost:{{port}}/throwaway/owner-chat/command
```

A run proves the app screens and the server agree; it does not prove real Telegram delivery or a real device, so always name the stand-in when reporting a result. Spec: `docs/specs/throwaway-owner-chat.md`.
