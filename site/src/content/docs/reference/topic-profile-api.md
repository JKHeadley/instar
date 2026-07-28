---
title: Topic Profile API
description: Routes and internal components for the per-topic framework / model / thinking-mode profile.
---

The [Topic Profile](../../features/topic-profile/) feature pins a per-topic execution profile
(framework, model, thinking mode). The conversational surface is primary; these routes back the
dashboard and power-user `/topic` command. All write routes require the topic's verified bound
operator and the `X-Instar-Request` intent header. The feature ships dark behind a dev-agent gate —
routes return `503` until it graduates.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /topic-profile/:topicId` | Read the resolved profile for a topic (model, tier, thinking mode, framework). |
| `POST /topic-profile/:topicId` | Write/replace the topic's pinned profile (operator-gated). |
| `POST /topic-profile/:topicId/propose` | Propose a change for confirm-then-apply (the propose-confirm flow). |
| `POST /topic-profile/:topicId/undo` | Revert the topic to its previous pinned profile. |
| `POST /topic-profile/:topicId/clear` | Clear the topic's pin (fall back to defaults / policy). |
| `POST /topic-profile/:topicId/reapply` | Re-apply the current pin (e.g. after a cooldown), reconciling the live session. |

Examples:

```bash
# Read a topic's resolved profile
curl -H "Authorization: Bearer $AUTH" http://localhost:4042/topic-profile/23225

# Pin a topic to Fable with high thinking (operator-gated; needs the intent header)
curl -X POST -H "Authorization: Bearer $AUTH" -H "X-Instar-Request: 1" \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-fable-5","thinkingMode":"high"}' \
  http://localhost:4042/topic-profile/23225
```

## Internal components

- **`TopicProfileStore`** — the durable pin store, a single-writer compare-and-set store so a config
  write can never silently clobber an operator's setting.
- **`TopicProfileResolver`** — resolves the effective profile for a topic at session-spawn time
  (pin → policy → defaults).
- **`TopicProfileOrchestrator`** — applies a changed pin: classifies the change, picks the gentlest
  swap (in-flight tier swap → `claude --resume` → continuation), respects protected/busy/autonomous
  sessions, runs the circuit breaker, and discloses real context loss.
- **`CodexResumeMap`** — captures Codex's resume handle so a Codex-framework topic can also restart
  none-loss (the symmetric counterpart to the Claude resume map).
- **`TopicProfileTransferCarrier`** — carries a topic's profile across machines via the mesh
  `topic-profile-pull` verb, so when another machine acquires the topic, the pin follows.

## Resolution & swap

The swap method for a changed pin is a pure decision (`classifyProfileChange`): a within-framework
Claude model-tier change on a confirmed-idle session can swap in-flight (zero loss) only when the
state-detection canary verifies an independent thinking-control read; otherwise it degrades to a
`claude --resume` restart (none-loss), or a continuation from recent history when no resume point is
capturable. The `TopicProfileOrchestrator` never profile-kills a protected session, and "switch now"
overrides a busy session but never overrides protection.
