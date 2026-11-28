---
title: Permanent agent links
---
Optional and off by default: with `agentLinks.enabled: true` in the config (read live, no restart), I can make a link on instar.sh that names this agent by its identity, not by a machine's address, and opens a page (home, a document, or a conversation) in the Instar app on a paired iPhone or Mac. Make one with `curl -s -X POST -H "Authorization: Bearer $AUTH" -H 'Content-Type: application/json' -d '{"target":"conversation","ref":"<app conversation id or Telegram topic number>"}' http://localhost:{{port}}/agent-links` (targets: `home`, `doc` with `ref` = document id and an optional `comment` key, `conversation`); share the returned `url` like any link.

- A link only opens a page. It grants no access: the person needs their own pairing, and the agent still checks access when the page opens.
- instar.sh stores nothing and never sees which agent or page: that part sits after the `#`. Anyone holding the link (and the chat app that carries it) can read its agent and page ids. A `comment` key also shows who wrote that comment, so add it only when it is needed.
- A browser without the app gets a page with an "Open in Instar" button; nothing redirects.
- `warning: split-identity` in the answer means some of my machines hold a different identity, so the link won't open through phones paired only to those machines.
