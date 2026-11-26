---
title: Codex model defaults
---
New Codex conversations use the newest reviewed Sol model by default. In `sessions.frameworkDefaultModels`, use `latest:astra` to follow Astra or enter an exact model ID to keep a pin. A change through the authenticated config API applies to new launches on the receiving machine without restarting the server. Running conversations keep their current model. If a pinned framework default falls behind, the server logs a warning. When asked what model a new conversation will use, read its resolved profile at `GET /topic-profile/:topicId`.
