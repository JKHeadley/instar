# Side-Effects Review — Bounded Notification Surface (topic-flood invariant)

**Version / slug:** `bounded-notification-surface`
**Date:** `2026-06-05`
**Author:** `echo`
**Second-pass reviewer:** `not required (Tier 1; operator-directed incident remediation, approval in topic 11960)`

## Summary of the change

Three-layer structural fix for the 2026-06-05 topic-spam flood (the third such incident): (1) `AgentWorktreeDetector` enumerates safe roots from the disk instead of the racy agent registry and aggregates N misplaced worktrees into ONE attention item; (2) `TelegramAdapter.createForumTopic` — the topic-creation chokepoint — enforces a last-resort `topicCreationBudget` on every `origin: 'auto'` creation, with 'auto' as the default so undeclared callers are bounded; (3) a burst-invariant integration test + a funnel lint pin the bound in CI. A `PostUpdateMigrator` migration purges stale per-path flood items fleet-wide. The standard joins the constitution as "Bounded Notification Surface" (P17), pending operator ratification at PR review.

## Decision-point inventory

One new decision point: `createForumTopic` may now REFUSE an `origin:'auto'` creation past the budget (throws `TopicFloodBudgetError`). It is a delivery shaper in the same class as `AttentionTopicGuard` — it never withholds critical notices (HIGH/URGENT attention items pass `origin:'system'`), never drops an item (attention items are still stored; the existing coalesce path is untouched), and its failure shape (a thrown error from topic creation) is one every existing caller already handles, because Telegram 429s produce the same shape today.

## 1. Over-block

Worst case: a legitimate feature creating >8 auto topics per label (or >12 globally) in 10 minutes gets refused; its content degrades exactly as it does under a Telegram rate limit (caller catch paths; attention items stay in the store topic-less; job notifications log the failure). Budgets are config-tunable per agent (`messaging[].config.topicCreationBudget`). User-initiated (`origin:'user'`: hub commands, /new, dashboard create) and create-once system topics (Lifeline, Dashboard, Updates, Attention, flood-notice, agent-health lane) are exempt, so no human-facing path can be over-blocked.

## 2. Under-block

HIGH/URGENT attention items are exempt at both layers BY DESIGN (critical never coalesced) — a feature that floods at URGENT can still flood; that is the documented, deliberate trade (criticals must always land) and is unchanged from the 2026-05-28 lockdown. The lifeline's single raw `createForumTopic` call (separate process, fixed cardinality 1) is allowlisted in the lint with justification.

## 3. Level-of-abstraction fit

The bound moved from per-feature cooperation (dodgeable — this incident proved it) to the creation primitive itself, mirroring the SafeGitExecutor/SafeFsExecutor single-funnel precedent. The detector fix removes a registry read that was the wrong ground truth for an on-disk question.

## 4. Migration / fleet rollout

`migrateWorktreeMisplacedFloodItems` is idempotent (skips when no old-format ids present), atomic (tmp+rename), and only deletes items with the retired `worktree-misplaced:` id prefix; the new `worktree-misplaced-summary:` items are preserved. CLAUDE.md awareness ships via `migrateClaudeMd` with a content-sniff guard (Migration Parity), tracked in the feature-delivery-completeness parity test.

## 5. Reversibility

Config off-switches: `topicCreationBudget: { enabled: false }` restores pre-change creation behavior; the detector change is signal-only (never moves/deletes worktrees). No data is destroyed anywhere except the stale flood items the migration purges — which are reconstructible from `git worktree list` if ever needed (and were 100% false positives).
