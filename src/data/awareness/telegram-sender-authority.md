---
title: Who may use this agent on Telegram, and how the owner lets someone in
requires: telegram
---
On development agents (and later wherever the owner turns it on), only the owner, people on the Telegram list and people registered on the agent can reach a session or run commands. An empty list no longer means everyone. Only the owner can use whole-agent controls (`/switch-account`, `/local-model`, `/route`, `/lifeline restart|reset|doctor|queue`). Someone the agent can identify as not allowed gets one private reply, and the owner gets a join request in the agent's admin topic with a code. The owner answers `/approve <code>` or `/decline <code>`, and nobody else can. If someone asks why the agent ignores a friend, tell the owner to approve the friend's request with that code; never add people to the list yourself. On other agents the check only watches: the owner sees one item listing who would have been refused.
