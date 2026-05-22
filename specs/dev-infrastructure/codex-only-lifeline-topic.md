---
title: "Codex creates only Lifeline — server owns the other topics"
slug: "codex-only-lifeline-topic"
author: "echo"
eli16-overview: "codex-only-lifeline-topic.eli16.md"
review-convergence: "2026-05-22T18:00:00Z"
review-iterations: 1
review-completed-at: "2026-05-22T18:00:00Z"
review-report: "docs/specs/reports/codex-only-lifeline-topic-convergence.md"
approved: true
---

# Codex creates only Lifeline — server owns the other topics

## Problem statement

Real-user retest of v1.2.20 (instar-codey on Codex) showed TWO
Dashboard topics in the Telegram group:

- "📊 Dashboard" created at 10:32 by the Codex agentic flow.
- "📢 Dashboard" created at 10:34 by the instar server on boot.

Root cause: the Codex agentic Telegram flow (v1.2.19+) creates
all four system topics (Lifeline, Updates, Dashboard, Attention).
But the instar SERVER also creates Dashboard / Updates / Attention
on its first boot — that's its existing job, via
`ensureDashboardTopic` (TelegramAdapter.ts, gated on
`config.dashboardTopicId`), `ensureAgentUpdatesTopic` and
`ensureAgentAttentionTopic` (server.ts, gated on state keys
`agent-updates-topic` / `agent-attention-topic`).

The two creators don't coordinate. The Codex flow persists ONLY
`config.lifelineTopicId` — so the server's `ensureLifelineTopic`
reuses the Codex Lifeline (no duplicate there). But the Codex
flow does NOT persist `config.dashboardTopicId` or the state keys
for Updates/Attention. So the server, seeing those unset, creates
its own — yielding the duplicate Dashboard the user saw.

(Why only Dashboard duplicated and not Updates/Attention in this
particular run is a boot-ordering artifact — `ensureDashboardTopic`
runs via the adapter poll-start while the server.ts ones run in a
later block. The duplicate risk exists for all three; Dashboard
is just the one that surfaced.)

## Proposed design

The cleanest fix follows the existing ownership boundary: the
server already owns Dashboard / Updates / Attention with canonical
intros, emojis, colors, and (critically) the dashboard-link
broadcast wiring. The Codex flow should create only what the
server reuses by persisted ID — Lifeline.

Change `buildTelegramAgenticPrompt`'s step 13 + 14:

- **Step 13**: create ONLY the Lifeline topic. Explicit
  instruction NOT to create Dashboard/Updates/Attention, with the
  reason (server creates them; duplicates otherwise). Lifeline is
  the exception because the Codex flow persists its ID (step 15)
  and the server's `ensureLifelineTopic` reuses it.

- **Step 14**: seed only the Lifeline topic with the richer
  orientation message. The message now tells the user that "a few
  more topics (Updates, Dashboard, Attention) will appear
  automatically once my server starts" — setting the expectation
  that more topics are coming so the brief single-topic state
  between Codex-done and server-boot doesn't look broken.

The post-server greeting (step from the state machine's
`send-greeting` action via `runSendLifelineGreeting`) is
unchanged — still fires in Lifeline after server boot.

The server's `ensureDashboardTopic` / `ensureAgentUpdatesTopic` /
`ensureAgentAttentionTopic` are unchanged — they create their
topics on boot exactly as before, now with no Codex-created
duplicates to collide with.

## Decision points touched

- Removes 3 of 4 topic-creation SIGNALS from the Codex prompt;
  the server's topic-ensure functions remain the single
  AUTHORITY for Dashboard/Updates/Attention.
- `config.lifelineTopicId` remains the coordination point between
  the Codex flow and the server's `ensureLifelineTopic`.
- No server-side change. The fix is entirely in the Codex prompt.

## Open questions

None for this fix.

## Out of scope (Justin's two follow-up asks)

1. **Inform the user when the tunnel can't connect** — when the
   quick tunnel fails (e.g. Cloudflare 429 rate-limit), the
   Dashboard topic should get a message explaining why there's no
   link yet + what to do. Separate server-side change to the
   tunnel-failure handler. Tracked for a follow-up.

2. **Backup tunnel pool** — when the primary (Cloudflare quick)
   tunnel fails, try alternate providers (named Cloudflare,
   localtunnel, bore, etc.) so the dashboard link survives a
   single-provider outage. Substantial feature; separate spec.

This PR is the duplicate-Dashboard fix only. The
no-dashboard-link issue Justin saw was a Cloudflare 429
rate-limit (verified by running cloudflared manually — "429 Too
Many Requests, error code 1015"), NOT a code bug. The two
follow-ups above make that failure mode visible + recoverable.
