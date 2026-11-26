---
title: Helper sessions placed by load
---
A topicless helper started with `POST /sessions/spawn` can ask to run where there is room: add `"placement": "auto"` to the body. It still starts on this machine while this machine has room. When this machine is busy (its own load verdict is saturated or impaired, it is short of memory, or its load is at or above 1.0 per core), the helper starts on another machine in the pool that has room and memory to spare, through that machine's own `/sessions/spawn`. Without the field, nothing changes. Every agent-started spawn also writes where it would have gone to `logs/agent-session-placement.jsonl` (no prompt text), so you can see how much load could move.

Only `name`, `prompt`, `workWeight`, `framework` and `model` travel. A request with a `topicId`, `jobSlug`, `ultracode`, `spawnRole`, `topicName`, `requireTopicBinding`, `targetMachineId` or a bind token stays here (`placementReason: "options-do-not-travel"` or `"topic-bound"`). A placed helper runs in the OTHER machine's agent home, so use `auto` only when its prompt is location-independent: it fetches its inputs from a shared source (a pushed branch, a document, a message) and returns results through a shared channel.

Answers: `201` with `placementOutcome: "peer"` and `placedOn` (started there), `"local"` or `"local-fallback"` with `placementReason` (started here). `409 placementOutcome: "exists-on-peer"` means that name is already running on the named machine. `409 placement-bound-elsewhere` means the name was placed earlier and its outcome is not known: check that machine, then use a NEW name. `202 placementOutcome: "unconfirmed"` means the hand-off timed out and the helper may have started there. Do not start the same work again under a new name; this machine keeps checking and raises one attention item if it cannot confirm. `GET /sessions/<name>/output` works for a placed helper (read from its machine). A kill answers `409 placed-on-peer`: stop it on that machine.

```bash
curl -X POST http://localhost:{{port}}/sessions/spawn -H "Authorization: Bearer $AUTH" -H 'Content-Type: application/json' \
  -d '{"name":"review-pr-123","prompt":"Check out PR 123 in a fresh worktree, review it, post the review on the PR.","placement":"auto"}'
```
