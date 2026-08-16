---
name: feedback-topic-arc-grounding
description: Multi-turn topic follow-ups must be answered against the topic's stated goal, not just the literal last message. Last-N-messages bootstrap is a transcript, not a brief.
metadata:
  type: feedback
---

In a multi-turn investigation topic, each user follow-up is a probe in a stated investigation — not a fresh micro-question. Ground every answer in the topic's original goal and the open threads still in play. If the answer only addresses the literal last question, expand it or explicitly note "narrow answer to a sub-question; here's how it ties back" before sending.

**Why:** On 2026-05-14 in topic qalatra (9235), Justin asked a deep-dive whose stated goal was "(1) what should Instar adopt from qalatra, (2) how would the two systems fit together — including Instar orchestrating qalatra." Every follow-up (worker, MCP server, heartbeats, skills/agents, jobs-need-agent.md) was a tile in that mosaic. I answered the heartbeats and skill/agent questions as standalone trivia, never grounded in the arc. Justin correctly called it shallow — and named it as an infra/awareness gap, not a personal mistake.

**How to apply:** On every Telegram resume in a topic with prior arc, before drafting:
1. Identify the topic's stated goal from the early turns (not just the last 1–2 messages).
2. Identify open threads — questions the user has raised that aren't yet answered against the goal.
3. Frame the response so each piece of new info advances or explicitly ties to the goal. Connect the dots for the user; don't make them assemble the mosaic.

The infrastructure fix that closes this structurally lives in [[capability-topic-intent-layer]] (if/when built): a per-topic intent record + arc-aware continuation header + pre-send arc check. Until that ships, this is a discipline rule.

Related: [[feedback-narrative-communication]] (plain narrative, bigger-picture framing), [[feedback-user-message-quality-bar]] (outbound messages must require action and be self-contained).
