# Review round 1 — Gemini 4 Argon (gemini CLI), 2026-10-25

## 1. Verdict
**Ready with changes.** The store-level architecture is the right 80/20 design, but a few sharp edge cases in `SubscriptionReloginStore`, `AttentionConditionStore`, and derived-key matching will cause false closes or silent muting if not tightened before implementation.

---

## 2–5. Ranked Findings (Factual Errors, False-Close Risks, Practical Gaps, & Cuts)

### 1. [False-Close Risk] `SubscriptionReloginStore` terminal transitions include failures (`failed`, `refused`), which would auto-close items that still need the operator
* **Where:** Spec §3.3 (`assisted-subscription-relogin` clear signal) vs. `src/core/SubscriptionReloginStore.ts:283, 297, 501`.
* **Why it matters:** `TERMINAL` in `SubscriptionReloginStore` is the set `('succeeded', 'refused', 'cancelled', 'failed')`. Furthermore, `:517` enqueues a `'terminal'` notification when entering `TERMINAL`. If transitioning to `TERMINAL` clears `conditionKey: subscription-relogin:<accountId>:<machineId>`, two bad things happen:
  1. When automated repair **fails** or is **refused**, the system immediately closes the attention item telling the operator the account is broken—hiding the exact failure when human intervention is needed most.
  2. The clear hook races with the newly enqueued `'terminal'` notification.
* **Smallest fix:** Only clear `subscription-relogin:<accountId>:<machineId>` when transitioning to `'succeeded'`, `'cancelled'` (operator cancelled), or when a quota poll for that `accountId × machineId` reads healthy. Never clear on `'failed'` or `'refused'`.

### 2. [False-Close / Silent-Mute Bug] `createAttentionItem` condition-key hit (§3.1 rule 1 & 3) silently drops body/stage updates for multi-stage conditions
* **Where:** Spec §3.1 (`createAttentionItem` rules 1 and 3) vs. `src/core/SubscriptionReloginStore.ts:697` and `src/messaging/TelegramAdapter.ts:4208, 4365`.
* **Why it matters:** Under §3.1, if an item with the same `conditionKey` is already `OPEN`, `createAttentionItem` just bumps `occurrences`/`lastSeenAt` and returns the existing item without updating `title`/`summary`/`description` or posting to the hub. For `subscription-relogin:<accountId>:<machineId>`, an episode starts as a low-urgency `'suggested'` item (`OPEN`), then transitions to `'waiting-operator-only'` or `'phone-tap'` (which requires immediate action with a fresh verification code/link). If it hits the `OPEN` `'suggested'` row and only bumps `occurrences`, the phone-tap prompt or operator-only failure is silently swallowed and never posted to the hub.
* **Smallest fix:** When an `OPEN`/`ACKNOWLEDGED`/`IN_PROGRESS` hit occurs on `conditionKey` (or exact ID) and the incoming `title`, `summary`, or ` priority` changed (or priority escalated), update the row's text/priority in place and re-post to the hub (just like `upsertAttentionItem` at `TelegramAdapter.ts:4369` does when `!unchanged`).

### 3. [Factual Error & Practical Gap] `AttentionConditionStore` IDs end in `:ep-<n>`, so `idPrefix: itemId` misses prior episodes on restart
* **Where:** Spec §3.2 (`AttentionConditionStore.ts:89, 110–131`).
* **Why it matters:**
  1. **Factual error:** `AttentionConditionStore.ts:110` is `clear()`, and `:120–131` is `clearSubject()` (not `:124–135`).
  2. **Practical gap:** `AttentionConditionStore` mints `itemId = "${key}:ep-${episode}"` (`:89`). If an item from `ep-1` is sitting `OPEN` in `attention-items.json` from before this upgrade (or across a state reset where the condition store bumped to `ep-2`), passing only `current.itemId` (`...:ep-2`) to `onClear(itemId, subject)` will not match `...:ep-1`.
* **Smallest fix:** Have `AttentionConditionStore` pass `record.key` (the base `<producer>:<conditionType>:<subject>:<scope>` prefix without `:ep-<n>`) to `onClear(key, record.itemId)`, and clear with `{ idPrefix: `${key}:` }`. That closes the current episode and sweeps any orphaned prior episodes for the same condition in one shot.

### 4. [False-Close Risk] Derived `idSkeleton` regex is too narrow for existing volatile IDs and risks collapsing distinct items with numbers in titles
* **Where:** Spec §3.1 rule 3 (`derivedKey` = `sourceContext|category|normalizedTitle|idSkeleton`) and §1 (`subscription-relogin-<episode>-<kind>[-attempt]`).
* **Why it matters:**
  1. **Misses real volatile tokens:** The spec says `idSkeleton` only blanks ISO dates, 13-digit epoch-ms, `ep-?\d+`, hex ≥ 12 chars, and UUIDs. That will **not** blank 10-digit epoch-seconds, short random slugs, or `SubscriptionReloginStore.ts:697` suffixes like `:1.r2.o1` (`:<attempt>.r<slowRetries>.o<operatorReoffers>`).
  2. **Over-collapses if `normalizedTitle` strips numbers:** If `normalizedTitle` normalizes digits, two different accounts/ports/PRs whose differentiator is only in the title (and whose ID is a generic UUID that gets blanked) will collapse into one row.
* **Smallest fix:**
  1. Explicitly state that `normalizedTitle` only trims/lowercases/collapses whitespace and **never strips digits or identifiers**.
  2. Add 10-digit epoch seconds (`\b1[7-9]\d{8}\b`) and attempt/retry suffixes (`:\d+(\.[ro]\d+)*$`) to the `idSkeleton` blanking list.

### 5. [Practical Gap] One-time sweep (§3.6) won't collapse the ~500 *recent* duplicate rows (<14 days old)
* **Where:** Spec §3.4 & §3.6 (One-time sweep of today's backlog).
* **Why it matters:** The expiry sweeper only closes items where `age = now - max(updatedAt, lastSeenAt)` exceeds 14d (automated) or 30d (operator-asked). Meanwhile, §3.1 condition deduplication only runs inside `createAttentionItem` when a *new* item is created. What about the 243 `telegram-origin-held` rows or 65 `stale-owner-release` rows created *in the last 13 days*? They won't expire in the sweep, and if their topic/episode is already quiet, no producer tick will fire to clear them.
* **Smallest fix:** Add a **dedupe pass** to `AttentionLifecycleSweeper` (and `/attention/lifecycle/sweep`): group all currently `OPEN`/`ACKNOWLEDGED`/`IN_PROGRESS` items by `conditionKey ?? derivedKey`; if a group has >1 open row, keep the newest row open (summing `occurrences`) and close the older duplicates with `closedBy: 'superseded'`, `resolution: 'superseded by <newestId>'`.

### 6. [Practical Gap] `CommitmentTracker` auto-expiry is `dryRun: true` by default in code, and `Commitment` lacks `source` field in `TelegramAdapter.AttentionItem`
* **Where:**
  1. `src/monitoring/CommitmentTracker.ts:1872` (`dryRun: this.config.autoExpiry?.dryRun ?? true`) vs. Spec §3.5 ("existing `autoExpiry` dryRun semantics apply").
  2. Spec §3.4 (`source === 'agent'`) vs. `src/messaging/TelegramAdapter.ts:341–400` (`AttentionItem` interface).
* **Why it matters:**
  1. In `CommitmentTracker.ts:1872`, `autoExpiry.dryRun` defaults to `true`! If the new operator-wait branch inherits `autoExpiry.dryRun` without changing the default or using `commitments.operatorWait.dryRun ?? false`, operator-wait commitments will only log and **never actually expire** in production unless `autoExpiry.dryRun: false` is explicitly configured on every machine.
  2. In §3.4, the `operator-asked` class checks `source === 'agent'`, but `AttentionItem` (`TelegramAdapter.ts:341`) has `sourceContext?: string` and `needsUser?: boolean`, **not** `source`.
* **Smallest fix:**
  1. In §3.4, change the `operator-asked` rule from `source === 'agent'` to `needsUser === true || /^(agent|session|ask)/i.test(sourceContext ?? '') || /decision|approval|review/i.test(category)`.
  2. In §3.5, give `commitments.operatorWait` its own `dryRun: false` default (or flip `migrateConfig` to set `dryRun: false` explicitly).

### 7. [Practical Gap] Reopening a legacy per-item topic (`createAttentionItem` §3.1 rule 2) or lookup by alias breaks `PATCH /attention/:id`
* **Where:** Spec §3.1 rules 2 & 3 vs. `src/messaging/TelegramAdapter.ts:4365, 4812, 4859`.
* **Why it matters:**
  1. In §3.1 rule 2, `createAttentionItem` reopens a `DONE`/`WONT_DO` item in place. `upsertAttentionItem` (`:4372`) already does this cleanly—including clearing `this.attentionHubLastPost.delete(item.id)` so the hub repost throttle doesn't swallow the reopen message! If `createAttentionItem` doesn't delete `attentionHubLastPost`, a reopened item within the throttle window will reopen silently without posting to the hub.
  2. In §3.1 rule 3, deduplicated IDs are recorded in `aliases` "so a later clear/PATCH by either id lands", and `closedBy: 'operator'` holds `WONT_DO` for 30 days. Currently `getAttentionItem(itemId)` (`:4859`) and `updateAttentionStatus(itemId)` (`:4812`) only do `this.attentionItems.get(itemId)` and do not set `closedBy: 'operator'`.
* **Smallest fix:**
  1. Reuse `upsertAttentionItem`'s reopen path (including `this.attentionHubLastPost.delete(existing.id)`) when `createAttentionItem` reopens a `DONE` item.
  2. Add a small helper `resolveAttentionItem(idOrAlias)` used by `getAttentionItem`, `updateAttentionStatus`, and `clearAttentionCondition`, and stamp `closedBy: 'operator'` inside `updateAttentionStatus` by default when status is `DONE`/`WONT_DO`.

### 8. [Cut / Over-engineering] Cut commitment `operator-wait-reask` and `predicate` function from `clearAttentionCondition`
* **Where:** Spec §3.5 (Re-ask at 7 days, shipped dark) and §3.2 (`predicate?: (i) => boolean`).
* **Why it matters:**
  1. Building an event emitter and tracking state for `operator-wait-reask` at 7 days that ships disabled (`enabled: false`) violates YAGNI—the operator explicitly asked for *less* nagging, not a dark re-nagging engine.
  2. Every producer clear in §3.3 uses either `conditionKey` or `idPrefix`. None need an arbitrary `predicate` closure.
* **Smallest fix:** Cut `operator-wait-reask` (and its config block) completely; keep only the 14-day commitment expiry. Restrict `clearAttentionCondition` to `{ conditionKey?: string; idPrefix?: string }`.
