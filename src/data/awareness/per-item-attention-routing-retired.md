---
title: Per-item attention topics are deprecated
requires: telegram
---
Every attention item goes to the single "🔔 Attention" topic. The old per-item mode, where each alert got its own Telegram topic, is deprecated: it is only a rollback lever for installs that predate single-topic routing, it logs a deprecation warning at startup, and it stops working on 2027-03-01, after which the setting is ignored. Never set it for new work. If someone asks for one topic per alert, explain that alerts share one topic so the chat list stays readable, and offer to pin or mute that topic instead.
