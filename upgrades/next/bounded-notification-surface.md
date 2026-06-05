---
user_announcement:
  - audience: user
    maturity: stable
    headline: "Topic-spam fixed for good"
    body: "Notification floods now collapse into one summary notice instead of a wall of new Telegram topics — enforced by a hard limit inside the messaging layer itself, plus a test that blocks any future feature that could flood. Urgent alerts still always come through individually."
---

# Bounded Notification Surface — topic floods structurally impossible

## What to Tell Your User

Your agent can no longer spam your Telegram group with a wall of topics, no matter what goes wrong inside it. After the third topic-flood incident (a boot-time checker misread shared state and raised 110 false alarms at once), the limit now lives inside the one function that creates topics — every automatic topic creation is budgeted by default, floods collapse into one summary notice, and a CI test fails any future build that could flood. Genuine emergencies still always get their own topic.

## Summary of New Capabilities

- `TelegramAdapter.createForumTopic` now enforces a last-resort `topicCreationBudget` (per-label 8 + global 12 per 10-min window, config-tunable via `messaging[].config.topicCreationBudget`) on every `origin: 'auto'` creation — and `'auto'` is the DEFAULT, so a future caller that never heard of the budget is still bounded. `'user'` (human-initiated) and `'system'` (fixed create-once infra topics) are exempt. Overflow throws `TopicFloodBudgetError` — the same failure shape as a Telegram 429, which every caller already survives.
- `AgentWorktreeDetector` enumerates safe roots from the DISK (`~/.instar/agents/*/.worktrees`) instead of the racy shared agent registry (the flood's root cause: a lost-update window + a silent parse-failure→empty-list fallback made the agent's own worktrees look misplaced), and aggregates N findings into ONE summary attention item with a stable feature-scoped `sourceContext` (the per-item unique paths were what dodged the 2026-05-28 per-source budget).
- `tests/integration/notification-flood-burst-invariant.test.ts`: the requirement-as-test — 1,000-item bursts through the real pipeline with shipped-default budgets must create ≤ budget topics, covering both the unique-source and unique-label dodges; proves no item is ever dropped and HIGH/URGENT always get their own topic even mid-flood.
- `scripts/lint-no-unfunneled-topic-creation.js` (in `pnpm lint`): no raw `createForumTopic` Bot-API call outside the budgeted funnel (SafeGitExecutor-style closed allowlist).
- `migrateWorktreeMisplacedFloodItems`: purges the stale per-path `worktree-misplaced:*` false-positive items from every flooded agent's attention store on update (idempotent, atomic; the new `worktree-misplaced-summary:*` format is kept).
- Constitution: new Building standard **"Bounded Notification Surface"** + catalog entry **P17** (any user-facing notification surface needs a chokepoint budget + a burst test before it ships).

## What Changed

`createForumTopic`/`findOrCreateForumTopic` gained an optional `opts?: { origin, label }` parameter (back-compatible; omitted = budgeted `auto`); known callsites declare origins (`user`: hub-commands "open this"/"tie", `/new`, dashboard create-topic/session routes; `system`: Lifeline, Dashboard, Updates, Attention, flood-notice, agent-health lane; labeled `auto`: attention items, job topics, threadline bridge, collaboration surfacer). CLAUDE.md template gains a "Bounded Notification Surface" section via `migrateClaudeMd` (content-sniffed, parity-tracked). Detector resolver gained a `cwd` test seam (its tests silently depended on the running machine's checkout at `process.cwd()`).
