---
title: Codex Account Selection Before Weekly Reset
---
New cloud Codex conversations use the local account pool just like background Codex work. Among accounts with room, a fresh, valid weekly reset date takes priority: use the allowance that expires first and keep later-reset accounts in reserve. A short-window reset constrains capacity; it is not the weekly spending deadline.

When someone asks which account is being used, read `GET /sessions` for its recorded account and `GET /subscription-pool` for that account's usage and reset. Do not infer a session's account from the pool's least-used entry or the default login. An old untagged session is still unattributed; do not invent a tag.

Explicit account choices and local-model launches keep their meaning. This repair adds no automatic restart of active conversations: existing work and refresh gates still apply, and placement is reconsidered on the next normal launch. An automatically moved resume whose saved conversation cannot be opened reports failure while preserving its rollout and pending message; it does not silently start a fresh conversation.
