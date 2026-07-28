---
title: Salience-gate the Threadline reply surface (stop low-salience a2a chatter spamming the user topic)
slug: threadline-salience-surface-gate
date: 2026-05-31
author: echo
status: approved
review-convergence: internal-plus-adversarial-self-review-2026-05-31
approved: true
approved-by: Justin (Telegram topic 13435, 2026-05-31 — "Your call" on the surface-vs-silence bias, matching his stated #16 intent "suppress low-salience chatter to the silent hub; surface only salient/failure-visible")
approval-note: >
  Justin delegated the bias decision ("your call") after I presented the A/B framing. Reading the
  code revealed the real bug is sharper than the A/B question: the salience verdict was COMPUTED but
  IGNORED for surfacing. This makes the already-computed salience actually gate the dormant-session
  surface — directly implementing his stated intent — while preserving "never hide first contact"
  (the classifier's first-reply fallback) and "never hide a genuine failure" (the failure-visible
  safety valve).
second-pass-required: false
second-pass-status: n/a-behavior-preserving-for-all-existing-cases-plus-both-sides-tested
eli16-overview: threadline-salience-surface-gate.eli16.md
---

# Salience-gate the Threadline reply surface (#16)

## Background — the verdict was computed but ignored

When agent B replies to a topic-linked thread, `TopicLinkageHandler.tryRouteReplyToTopic`:
1. classifies the reply via `SalienceGate` → `user-visible` | `agent-internal`,
2. resolves a delivery mode: `live-inject` (session alive, inline relay), `resume-pending`
   (dormant session — reply durably in MessageStore, picked up next interaction), or
   `failure-visible` (a stalled inject / no auto-pickup path),
3. decides whether to fire a Telegram surface (a post in the user's topic).

The surface gate was:
```ts
const shouldSurface =
  deliveryMode !== 'live-inject' &&
  (verdictResult.verdict === 'user-visible' ||
    deliveryMode === 'failure-visible' ||
    deliveryMode === 'resume-pending');
```
`deliveryMode` is ALWAYS one of `{live-inject, failure-visible, resume-pending}`, so the
`verdict === 'user-visible'` clause is **dead** — for every non-`live-inject` delivery the OR-clause
already passes via `failure-visible`/`resume-pending`. So a dormant-session reply **always**
surfaced, regardless of salience. Intermediate agent-to-agent chatter to a dormant topic spammed the
user's topic — the #16 complaint. (The per-thread + per-topic rate limits capped the flood but
couldn't suppress individually low-value posts.)

## Fix — make the computed salience actually gate the dormant surface

```ts
const shouldSurface =
  deliveryMode === 'failure-visible' ||
  (deliveryMode === 'resume-pending' && verdictResult.verdict === 'user-visible');
```
- `live-inject` → never surface (the agent relays inline; unchanged).
- `failure-visible` → ALWAYS surface, regardless of salience — a genuine delivery failure is never
  hidden (the safety valve; unchanged).
- `resume-pending` → surface ONLY if `user-visible` (salient). A low-salience reply stays **quiet**
  in the user's topic: the inbound path records it in the **ConversationStore — the browsable
  Threadline hub** (the dashboard's Threadline tab, via `evaluateAndRecordInbound`), so it is not
  lost; it just doesn't fire a noisy topic notification. This is exactly the "suppress low-salience
  chatter to the silent, browsable hub" behavior. (There is no automatic topic-resume *replay* of a
  quieted reply — recovery is via the hub; a salient reply still surfaces, and a genuine delivery
  failure still surfaces via failure-visible.)

This resolves the A/B bias elegantly: the `SalienceGate` first-reply fallback (`isFirstReply ?
'user-visible' : 'agent-internal'`) still surfaces genuine FIRST contact even when the classifier is
unavailable, while subsequent low-salience chatter is suppressed. So: first answer never hidden,
intermediate chatter quiet, genuine failures always surfaced.

## Why it's safe
- Behavior-preserving for every existing case: `live-inject` (no surface), `failure-visible` (always
  surface), and `resume-pending + user-visible` (surface) are all unchanged. Only `resume-pending +
  agent-internal` changes: was surface, now quiet. All 21 prior TopicLinkageHandler tests stay green.
- The reply is durably recorded in the ConversationStore (the browsable Threadline hub) on the
  inbound path (`evaluateAndRecordInbound`), so a suppressed low-salience reply is NOT dropped — it
  lives in the hub for browsing. It is intentionally not pushed to the topic and is not auto-replayed
  on resume; that is the desired "low-salience → silent hub" behavior, not a loss. (Verified against
  the code on adversarial review — the inbound threadline path does NOT write to MessageStore, and
  the topic wake path resumes via TopicResumeMap UUID only; an earlier comment claiming MessageStore
  + next-interaction replay was inaccurate and is corrected in this PR.)
- The failure-visible safety valve is untouched: if delivery genuinely failed, the user is always
  told something arrived, regardless of salience.

## Migration parity
N/A — code-only (`TopicLinkageHandler.ts`, compiled into `dist`); ships in the normal release. No
agent-installed file, config, or template change → no `PostUpdateMigrator` pass.

## Agent Awareness
N/A — internal reply-routing behavior; the routing-to-hub vs parent-topic model is already documented
in the CLAUDE.md template's Threadline hub section. No new endpoint/trigger/lookup to surface.

## Test plan
Unit (`TopicLinkageHandler.test.ts`, +3 decision-boundary cases): resume-pending + agent-internal →
no surface; resume-pending + user-visible → surface; failure-visible + agent-internal → still
surfaces (safety valve). The 21 existing cases (live-inject no double-post, failure-visible surface,
per-topic rate-limit, slow-reply first-contact) stay green. Threadline regression suite
(ThreadlineRouter, integration, keystone) green.
