---
title: "Telegram Conservatism Pass — close the origin:'system' auto-topic bypass; act-don't-notify standard"
date: 2026-07-04
author: echo
status: approved
parent-principle: "Bounded Notification Surface — no feature may flood the user"
review-convergence: internal-multi-reviewer-2026-07-04
approved: true
approved-by: Justin
approved-via: "Frontload authorization 2026-07-04 (item #4 = yes) explicitly greenlighting the structural Telegram-conservatism pass; operator standing directive 2026-07-01 + constitutional escalation 2026-07-03 (topics 29723/29836). Design forks resolved under the autonomous blanket pre-approval (specs/decisions are the agent's to approve in a pre-approved run)."
tier: 2
tier-reasoning: "Changes a documented outbound-messaging behavioral invariant (HIGH/URGENT topic creation) at a delivery chokepoint — guard-adjacent, fleet-wide, so Tier 2 despite modest LOC."
eli16-overview: telegram-conservatism-pass.eli16.md
audit-companion: ../audits/telegram-conservatism-pass-2026-07-04.md
decisions-resolved:
  - "system-topic exemption → require explicit bounded:true (not a blanket origin:'system' pass)"
  - "critical topic flood → separate budget label + coalesce-on-refuse (bound it, never drop it)"
  - "act-don't-notify → ship as a PROPOSED standard for operator ratification, not code"
---

# Telegram Conservatism Pass

## Problem

The operator's most-repeated directive (2026-07-01, escalated to constitutional status 2026-07-03) is: be extremely conservative with Telegram — assume almost every candidate message is something the agent should ACT ON, not notify about; never create per-event topics; route ownerless notices to ONE alerts topic. An audit (topic 29836) found this directive has the weakest structural follow-through of any critical item, and a new topic was observed auto-created mid-session despite the existing guards.

Root cause (full enumeration in the audit companion): `TelegramAdapter.createForumTopic` enforced its last-resort flood ceiling **only for `origin === 'auto'`**. `origin: 'system'` (and `'user'`) bypassed it entirely. The *Bounded Notification Surface* standard claims the ceiling "covers every caller … no matter what source labels it passes" — but a caller could dodge it completely by declaring itself `'system'`. Concretely, `createAttentionItem` created HIGH/URGENT topics with `origin:'system'`, and `AttentionTopicGuard` never coalesces critical items — so a per-item critical stream had **zero** ceiling.

## Goals

1. Make the flood ceiling genuinely un-dodgeable: no origin flag may exempt a caller from it.
2. Keep the legitimately-bounded create-once system topics (Lifeline, Dashboard, Updates, Attention, Agent-Health, flood-notice) exempt — including the overflow surfaces the ceiling must never refuse.
3. Bound a flood of HIGH/URGENT items without harming the visibility of a genuine lone emergency, and never drop an item.
4. Add the disposition-level standard the operator actually asked for (act-don't-notify) as a ratifiable proposal.

Non-goals: rewriting the sentinel/proactive-send paths (Category C in the audit already conforms — existing-topic or fixed-alert-topic, never new topics); the raw-API lifeline bypass (tracked follow-up). <!-- tracked: CMT-1901 -->

## Design

### D1 — Explicit bounded exemption (closes the bypass)

`createForumTopic(name, iconColor, opts)` gains `opts.bounded?: boolean`. The ceiling exemption becomes:

```
exemptFromCeiling = origin === 'user' || opts.bounded === true
```

Everything else — including a bare `origin: 'system'` — rides `topicCreationGuard.decide(label)` exactly like `'auto'`. A refused creation throws `TopicFloodBudgetError` (unchanged shape — same as a Telegram 429, which every caller already survives).

`origin` retains its styling/semantic meaning; it is no longer an authorization to skip the ceiling. `bounded: true` is a caller **declaring** its topic is cardinality-fixed (create-once-then-reuse). The genuine create-once topics are marked `bounded: true`; the per-item attention path is not.

### D2 — Separate critical budget + coalesce-on-refuse (bound, never drop)

In `createAttentionItem`, critical (HIGH/URGENT) topics use a distinct budget label `attention-item-critical` (non-critical stay `attention-item`). Effects:

- A lone emergency amid a flood of LOW noise still gets its own topic (the critical budget is untouched by LOW traffic) — the visibility invariant is preserved up to a generous ceiling.
- A genuine FLOOD of distinct critical items trips the ceiling; the item is then **coalesced into the single "notices coalesced" topic** (via the existing `routeToFloodNotice`), marked `coalesced`, still recorded in the attention store. No item is ever swallowed. This is the `TopicFloodBudgetError` branch newly handled in the `createAttentionItem` catch (previously any creation failure degraded silently).

### D3 — Proposed standard (operator ratifies, not code)

`### Conservative Outbound: Act, Don't Notify` added to `docs/STANDARDS-REGISTRY.md`, clearly marked `⚠ PROPOSAL — awaiting operator ratification`. It states the default disposition (act, don't notify) above the two existing volume/routing standards.

## Signal vs authority

The change lives entirely in an existing DELIVERY SHAPER (`AttentionTopicGuard` / the `topicCreationBudget` ceiling), not a new authority. It changes the FORM of delivery (one coalesced topic + log line vs a new topic per item) and never withholds a critical notice or drops an item — every item stays in the attention store and the suppression audit. It adds no new brittle blocking authority over agent behavior or information flow. This is fully compliant with `docs/signal-vs-authority.md` (the rate-counter / delivery-shaper carve-out).

## Multi-machine posture

Machine-local by design. Topic creation and the budget counters are per-`TelegramAdapter` instance; only the machine that fronts Telegram polling creates topics. No replication path is needed — the budget is a per-process rate counter, correct to be local (the same class as `AttentionTopicGuard` today). No durable state strands on a topic transfer.

## Test plan (three tiers)

- **Unit** — `AttentionTopicGuard` pure-logic tests (unchanged; the guard is reused). The exemption/label semantics are exercised at the adapter integration tier.
- **Integration** — `notification-flood-burst-invariant.test.ts` (production-default budgets, real pipeline): (a) bare `origin:'system'` flood is now bounded (closed bypass); (b) `origin:'user'` and `origin:'system'+bounded:true` remain exempt; (c) a 1,000-item HIGH/URGENT stream is bounded AND every item stays in the store AND overflow is coalesced; (d) the pre-existing lone-emergency-amid-flood case still gets its own topic.
- **E2E / ratchet** — the burst-invariant test IS the build-failing ratchet; it fires the real pipeline and fails any future caller that can flood, including via `origin:'system'`.

## Rollback

Pure code, no migration, no durable state. Back-out = revert the diff (single hot-fix release). The `bounded` opt defaults to undefined (falsy), so the only behavior an un-reverted-but-misbehaving change could cause is *more* conservatism (a create-once topic wrongly un-marked would be budgeted, not lost — it would recreate on the next window). Conservative failure direction.

## Convergence (internal multi-reviewer, 2026-07-04)

- **Security / adversarial:** the closed bypass removes an escalation path (a compromised or buggy caller can no longer spam-create topics by declaring `'system'`). No new input is trusted. PASS.
- **Decision-completeness:** both sides of the exemption boundary are tested (exempt: user + bounded; non-exempt: bare system + auto). The critical path's refusal branch is handled (coalesce), not left to degrade. PASS.
- **Integration / shadowing:** the change reuses the existing `topicCreationGuard` and `routeToFloodNotice`; it does not add a parallel guard. The overflow surfaces (flood-notice, agent-health) are marked `bounded` so the coalesce path can never be refused by the ceiling it feeds (no infinite regress). PASS.
- **Over-block risk:** a create-once system caller that a future author forgets to mark `bounded` would be budgeted; because these are low-volume create-once, the generous global ceiling (12/10min) is not approached in practice, and a refusal self-heals on the next window. Residual, low, conservative-direction. NOTED.
- **External review (gemini adversarial pass, 2026-07-04) — findings + dispositions:**
  1. *"`origin:'user'` is an unauthenticated bypass."* — In instar's single-agent, single-trust-domain model there is no untrusted caller that sets `origin`; it is a code-internal declaration, not an external input (see MEMORY: single-agent → no multi-tenant defenses). A "system process wrongly setting `user`" is a code bug caught in review, not an exploit surface. Residual accepted; the bar to WEAKEN is `user`, and `user` topics are self-rate-limited by the human. NOTED.
  2. *"`bounded:true` is a convention, not enforced — invites drift."* — True, and identical in class to the existing `origin` typing. Mitigated by: only ~6 known callers, each visible in review; the burst-invariant ratchet fails the build if a NON-bounded caller can flood. A tracked enforcement item `<!-- tracked: CMT-1901 -->` (an allowlist lint of `bounded` labels) hardens convention into policy. ACCEPTED.
  3. *"If the flood-notice topic is closed by the user, the flood notification itself is dropped."* — Already handled: `routeToFloodNotice`/`ensureFloodNoticeTopic` catch a send failure, drop the cached topic id so it RECREATES on the next occurrence, and the item is ALSO recorded in the attention store + `state/attention-suppressed.jsonl`. So the item is never lost even if the coalesce topic was closed. Self-healing pre-existing behavior. RESOLVED.
  4. *"Coalescing distinct critical incidents loses contextual separation → triage cost."* — Real tension. Mitigated by scope: coalescing triggers ONLY under a genuine flood (≥8/label or ≥12 global per 10min) — a normal handful of emergencies each keep their own topic. Each coalesced item still carries its title + summary in the notices topic AND is individually in the attention store/dashboard. Collapsing a flood to one topic is the operator's explicit directive. ACCEPTED per directive.

Converged: no open blocking concerns; two residuals carry tracked items. <!-- tracked: CMT-1901 -->

## Open questions

*(none)*
