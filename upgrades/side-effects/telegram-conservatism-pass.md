# Side-Effects Review — Telegram Conservatism Pass

**Version / slug:** `telegram-conservatism-pass`
**Date:** `2026-07-04`
**Author:** `echo`
**Second-pass reviewer:** `echo (guard-adjacent; independent re-read appended)`

## Summary of the change

Closes the `origin:'system'`/`'user'` bypass in the auto-topic flood ceiling. `TelegramAdapter.createForumTopic` previously enforced its last-resort budget ONLY for `origin:'auto'`; a bare `origin:'system'` skipped it entirely, and `createAttentionItem` used `origin:'system'` for every HIGH/URGENT item (never coalesced) → an unbounded per-item topic path. The change: (1) the ceiling now applies to every origin except an explicit human request (`origin:'user'`) or a caller that declares its topic cardinality-bounded (`opts.bounded === true`); (2) the genuine create-once system topics are marked `bounded:true`; (3) critical attention topics get a distinct budget label and coalesce (never drop) on ceiling-refusal. Files: `src/messaging/TelegramAdapter.ts`, `src/commands/server.ts`, `tests/integration/notification-flood-burst-invariant.test.ts`. Decision point touched: the topic-creation flood ceiling (a delivery shaper).

## Decision-point inventory

- `TelegramAdapter.createForumTopic` flood-ceiling exemption — **modify** — exemption narrowed from `origin ∈ {user,system}` to `origin===user || bounded===true`.
- `TelegramAdapter.createAttentionItem` critical-topic path — **modify** — critical items now ride a distinct budget label and coalesce on refusal instead of degrading.

---

## 1. Over-block

A create-once system topic caller that a FUTURE author forgets to mark `bounded:true` would be budgeted against the ceiling (12/10min global). Because these topics are low-volume create-once, the ceiling is not approached in normal operation; a refusal self-heals on the next window (the topic recreates). No user message and no attention item is ever rejected — only a redundant per-item topic is withheld, and even then the item is coalesced into the single notices topic. Conservative-direction residual.

---

## 2. Under-block

The raw-API lifeline topic creation (`lifeline/TelegramLifeline.ts:2685`) bypasses the adapter chokepoint entirely (separate process, create-once) and is NOT covered by this change — tracked follow-up `<!-- tracked: CMT-1901 -->`. It is create-once and cannot flood, so the miss is bounded. `origin:'user'` remains fully exempt by design (a human explicitly asking for a topic is the sanctioned exception).

---

## 3. Level-of-abstraction fit

Correct layer. The change lives in the ONE function where topics are born (`createForumTopic`) and reuses the existing `topicCreationGuard` (an `AttentionTopicGuard` instance) and `routeToFloodNotice` — it does not add a parallel guard or a new primitive. The ceiling is exactly the chokepoint the *Bounded Notification Surface* standard designates; this change fixes a hole in it rather than bolting on a new layer.

---

## 4. Signal vs authority compliance

- [x] No — this change has no NEW block/allow authority over agent behavior or information flow; it tunes an existing delivery shaper.

The `topicCreationBudget` ceiling and `AttentionTopicGuard` are DELIVERY SHAPERS (the rate-counter carve-out in `docs/signal-vs-authority.md`): they change the FORM of delivery (one coalesced topic + a log line instead of a new topic per item) and never withhold a critical notice or drop an item. This change narrows an over-broad exemption and adds a coalesce branch — strictly more conservative, no new brittle blocking logic.

---

## 5. Interactions

- **Shadowing:** the critical path now uses a distinct budget label (`attention-item-critical`) so LOW/NORMAL attention topics (`attention-item`) do not starve the critical budget and vice-versa. No shadowing.
- **Double-fire:** none — one `decide()` call per creation attempt (unchanged cardinality).
- **Races:** the guard is a per-process in-memory counter (no shared state); concurrent creations share the existing `floodNoticePending` in-flight map so the coalesce topic is created once. Unchanged.
- **Feedback loops:** the overflow surfaces (flood-notice, agent-health lane) are marked `bounded:true`, so the ceiling can NEVER refuse the very topic the coalesce path needs — no infinite regress. Verified in the design and by the passing 1,000-item critical-flood test (which creates exactly one coalesced topic).

---

## 6. External surfaces

- **Telegram:** fewer topics under a flood — the intended user-visible effect. A genuine lone emergency still gets its own topic (verified by the retained lone-emergency test).
- **Persistent state:** none changed. Coalesced items are still written to the attention store + `state/attention-suppressed.jsonl` (existing paths).
- **Other agents / users:** none — internal delivery shaping.
- **Operator surface (Mobile-Complete):** no operator-facing actions added or touched. Not applicable.

---

## 6b. Operator-surface quality

No operator surface (no `dashboard/*`, approval, or grant/secret form touched) — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN.** The topic-creation budget is a per-`TelegramAdapter`-instance rate counter, and only the machine fronting Telegram polling creates topics. A per-machine budget is correct: it bounds the topics THAT machine creates, which is the only machine creating any. No durable state is introduced (nothing to strand on a topic transfer), no user-facing notice needs one-voice gating beyond what already exists (the change reduces notices), and no URLs are generated. Same posture as the existing `AttentionTopicGuard`.

---

## 8. Rollback cost

Pure code, no migration, no durable-state change. Back-out = revert the diff in a single hot-fix release. The new `bounded` opt is falsy-by-default, so an un-reverted partial state can only be MORE conservative, never a flood. Lowest-cost rollback class.

---

## Second-pass review (guard-adjacent — independent re-read)

Re-read the diff cold against the artifact. The one real behavior change is that a FLOOD (8+ in 10min per label, or 12+ global) of HIGH/URGENT attention items now coalesces instead of each spawning a topic. This contradicts the OLD "critical never coalesced" invariant — but that invariant was itself the unbounded hole (it made "mark it HIGH" a flood bypass), and the operator directive explicitly prefers a single alert topic under flood. The item is never dropped (coalesced + stored + audited). The generous per-label ceiling means a normal handful of genuine emergencies is unaffected. **Concur with the review.** No concern raised.
