<!-- bump: patch -->
## What Changed

- **Attention items are one per condition and close when their cause clears** (`docs/specs/attention-lifecycle-close-on-cause.md`). Every writer into the attention store goes through one admission rule: a repeat of an open condition updates the existing row (`occurrences`, `lastSeenAt`) instead of adding a sibling; a changed ask refreshes the row and re-posts; a condition that returns after being closed reopens the same row (`episode` increments) instead of being silently swallowed; an operator's WONT_DO holds the condition closed for 30 days. Producers name the condition with a stable `conditionKey` (POST /attention accepts it; `sticky` marks a row the system must never close); without one, a key is derived from source, category, title and the id with its timestamps / episode counters blanked (UUIDs, hex ids and topic ids are kept).
- **Producers close their own items.** `POST /attention/clear` (`conditionKey` | `id` | delimiter-terminated `idPrefix`, plus `resolution`) and `TelegramAdapter.clearAttentionCondition`. `AttentionConditionStore.clear/clearSubject` now close the items they minted (`onClear`). Hooked producers: sign-in repair (closes only on verified success, cancel or a healthy cell), held replies (zero unresolved held operations for the topic), stale-owner release and the rope prober, the duplicate reconciler, idle-zombie veto, stand-down, orphaned work, the follow-me email gate, swap anti-thrash, credential identity drift, the evolution-overdue job.
- **An hourly reconciliation pass** (`runAttentionLifecyclePass`; `POST /attention/lifecycle/sweep {dryRun?}`; status `GET /attention/lifecycle`) merges duplicate open rows for one condition (`closedBy: superseded`), closes rows whose producer reports the condition over (`cause-cleared`), and expires untouched rows with an honest label (`closedBy: expired`, resolution "never confirmed cleared"): automated notices after 14 days, items the agent raised or that ask for a decision after 30 days; acknowledged / in-progress rows, security items and once-per-episode conditions still active never. The first pass on a machine runs expiry as a dry run. Audit: `logs/attention-lifecycle.jsonl`.
- **Commitments waiting on the operator expire** (`owner: user`, or blocked on user-input / user-authorization) after 14 days with a per-row reason ("waited N days for your authorization; ask again if still needed"), judged before the agent-owned rule; replicas are the origin machine's. `commitments.operatorWait { enabled, maxAgeDays, dryRun:false }`.
- `GET /attention` rows carry `conditionKey`, `aliases`, `occurrences`, `lastSeenAt`, `episode`, `closedBy`; a PATCH close is `closedBy: operator`. Agents' CLAUDE.md (template + migration) explains the lifecycle and the clear route.
- Rollback: `messaging[].config.attentionLifecycle.enabled: false` (exact previous behavior); `attentionLifecycle.expiry.dryRun: true` keeps merging and verified clears but only lists expiry; `commitments.operatorWait.enabled: false`.

## What to Tell Your User

Your attention list will stop piling up. The same problem noticed again updates one entry instead of adding another; when a problem is fixed (a sign-in repaired, a held reply delivered) its entry closes by itself; and an automated notice nobody touched for two weeks is closed with a label saying it expired, not that it was handled. Security items are never closed for you, and anything you have acknowledged is left alone. Promises I made that were waiting on you for more than two weeks are closed as unanswered — ask me again if they still matter. The first time this runs on each machine it only lists what it would expire.

## Summary of New Capabilities

- One attention row per condition; `conditionKey` / `sticky` on POST /attention.
- `POST /attention/clear`, `GET /attention/lifecycle`, `POST /attention/lifecycle/sweep`.
- Bounded expiry of untouched attention items and of commitments waiting on the operator, with labelled resolutions and a jsonl audit.

## Evidence

- Operator report 2026-10-25 17:08 PDT (topic 127504); live counts in `docs/issues/attention-noise-items-never-close.md`: 1,140 open items pool-wide, 27 sign-in-repair rows for 7 real cells, 243 held-reply rows, 47 operator-waiting commitments.
- Source inventory: ~70 producers / ~135 sites; 8 ever close their own item; 32 embed a timestamp/episode/attempt in the id; no retention of any kind.
- Spec review: `docs/specs/reports/attention-lifecycle-close-on-cause-review-r1-{astra,argon}.md`.
- Tests: `tests/unit/AttentionLifecycle.test.ts`, `tests/unit/attention-lifecycle-store.test.ts`, `tests/unit/commitment-operator-wait-expiry.test.ts`, `tests/unit/attention-producer-hooks.test.ts`, `tests/integration/attention-lifecycle.test.ts`, `tests/e2e/attention-lifecycle-alive.test.ts`.
