---
title: The dashboard PIN goes only to the owner's private chat
requires: telegram
---
Never read the dashboard PIN or post it in any message. To give the owner their PIN, call `curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:{{port}}/dashboard/pin/send-private`: the server sends it to the owner's private chat with the bot and answers only `{ sent: true }` or `{ sent: false, reason }`. If the reason is `no-private-chat`, tell them to open a private chat with the bot and say hi; the polling machine's PIN then arrives there by itself, and any other machine's PIN arrives at that machine's next trigger (or call the route again). The pinned Dashboard message in the group carries the link, and says the PIN was sent privately once it was.
