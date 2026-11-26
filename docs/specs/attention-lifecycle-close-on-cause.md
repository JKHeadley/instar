---
title: "Attention Lifecycle: items close when their cause clears"
slug: "attention-lifecycle-close-on-cause"
author: "echo"
date: "2026-10-25"
status: "approved"
tier: 2
parent-principle: "Self-Heal Before Notify — The Operator Hears Only When Self-Healing Fails"
eli16-overview: "docs/specs/attention-lifecycle-close-on-cause.eli16.md"
review-convergence: "2026-10-26T01:20:00Z"
review-iterations: 1
review-completed-at: "2026-10-26T01:20:00Z"
review-report: "docs/specs/reports/attention-lifecycle-close-on-cause-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra, gemini-cli:gemini-4-argon"
approved: true
approved-by: "operator (Justin) — Echo Bugs topic 10000000850 brief, 2026-10-25 17:08 PDT: fix the class in a 24h autonomous run; merge myself unless a constitution file changes"
---

# Attention Lifecycle: items close when their cause clears

**Operator report (topic 127504, 2026-10-25 17:08 PDT):** "the overwhelming number of awaiting actions/attention items ... the vast majority of these should NOT need the user's attention. If the user is overloaded ... they will simply ignore all of them. I know because this is exactly what's been happening to me."

**Glossary.** *Attention item* — one row in `state/attention-items.json`, posted once into the 🔔 Attention hub topic. *Producer* — the code that raises an item. *Condition* — the real-world state an item describes (this account needs sign-in on this machine; this topic's reply is held). *Episode* — one occurrence of a condition between it starting and clearing. *Sticky* — an item that must never be closed by the system because only a human can judge it (security, an explicit decision the agent asked for).

## 1. Problem (measured, 2026-10-25 ~17:10 PDT)

- 1,140 open items across the pool (852 after the console's own re-count; 794 of the 912 on the Mac Studio alone are OPEN). The operator ignores the hub.
- Source read of every producer (`createAttentionItem`, `upsertAttentionItem`, `POST /attention` callers): **~70 producers at ~135 sites. 8 ever close their own item.** The other ~62 leave the row OPEN until a human taps /done or PATCHes it.
- **32 producers put a timestamp, episode number, attempt counter, day or hour bucket in the id.** Each recurrence mints a new row, so one condition becomes a pile: 27 "Claude Code sign-in repair" rows for 7 real account×machine cells (ids `subscription-relogin-<episode>-<kind>[-attempt]`); 243 `telegram-origin-held:<topic>:<timestamp>` rows; 65 `stale-owner-release:...:ep-<n>` rows; 71 duplicate-reconciler rows.
- `createAttentionItem` returns an existing id unchanged, even when that item is closed. A producer with a stable id that was closed once can never speak again (standdown-latched, negotiator-failopen, resume-queue:aggregate).
- `AttentionConditionStore.clearSubject` marks a condition inactive so the next episode gets a new id, but **never closes the item it minted** (`src/core/AttentionConditionStore.ts:124-135`).
- **There is no retention of any kind.** `loadAttentionItems`/`saveAttentionItems` keep every row forever; the only removals are two one-shot id migrations.
- Commitments: `CommitmentTracker.isAutoExpiryEligible` expires only `owner:'agent'` rows (21 days). The 47 open rows waiting on the operator (`owner:'user'`, or `blockedOn` user-input / user-authorization) wait forever; 36 are untouched 14+ days.

The console (PR 2359) groups repeats and marks 14-day-old items "probably already handled". That is display honesty, not the fix.

## 2. Principles

1. **An item describes a condition, not an event.** One condition → one open row, however many times the producer observes it, on one machine. Recurrence updates the row (`occurrences`, `lastSeenAt`); it does not add a row.
2. **The system closes what the system can see has cleared.** A producer that knows its clear signal closes its own item. Nothing waits for a human to tap /done on a condition that already ended.
3. **What the system cannot see clear, it does not keep forever.** An automated notice untouched for a bounded time expires with an honest label ("expired, never confirmed cleared") — it is not marked done, and the resolution says so.
4. **Sticky items are never touched by the system.** Security items never expire. A decision or approval the agent explicitly asked for expires only after a longer window, with a resolution that says the operator never answered.
5. **Structure over willpower.** Lifecycle lives in ONE place (the attention store), not as 70 producer patches. Producer hooks are the cheap 9 that cover ~500 of the 852 open rows.
6. **Signal-only, silent.** Closing never posts a hub message. The lifecycle layer never blocks a raise and never raises anything itself except the one-time sweep report.

## 3. Design

### 3.1 Condition identity (one row per condition) — one writer helper

`AttentionItem` gains optional, persisted fields: `conditionKey?: string` (producer-supplied stable identity, no timestamps), `aliases?: string[]` (other ids that observed this condition), `occurrences?: number`, `lastSeenAt?: string`, `episode?: number` (bumped on each reopen), `closedBy?: 'operator' | 'cause-cleared' | 'superseded' | 'expired'`, `sticky?: boolean`. The alias index is rebuilt on load.

**One helper, `admitAttentionObservation(item)`, is used by every writer** — `createAttentionItem`, `upsertAttentionItem`, `createOrReopenAgentHealthAttentionItem` and the HTTP route (which now passes `conditionKey`/`sticky` through, validated: strings ≤ 200 chars / boolean). Lookup order: exact id → alias → condition key (producer key, else derived key) over ALL rows (open and closed), newest first. Then:

1. **Open row found, same text and priority** → a repeat: `occurrences++`, `lastSeenAt`, status untouched (an operator's ACKNOWLEDGED / IN_PROGRESS survives a mere repeat). No hub post.
2. **Open row found, text or priority changed** → the required action changed: body and priority refreshed in place, status back to OPEN, re-posted through the existing hub routing (its 6-hour repost throttle already lets a priority escalation through). The incoming id joins `aliases`. This is what today's `upsertAttentionItem` does; it becomes the shared path.
3. **Closed row found** → a new episode: reopen in place (`episode++`, `occurrences++`, body refreshed, `closedBy`/`resolution` cleared, hub repost — the repost-throttle entry is dropped so the reopen is visible). Exception: a `WONT_DO` set by the operator holds the CONDITION closed for 30 days — the observation is recorded (`occurrences`, alias) but the row stays closed and silent.
4. **Nothing found** → create.

**Derived key** (used only when the producer gives no `conditionKey`): `sourceContext|category|normalizedTitle|idSkeleton`. `normalizedTitle` trims, lowercases and collapses whitespace — it never strips digits or identifiers. `idSkeleton` blanks ONLY per-episode shapes: ISO dates/datetimes, 13-digit epoch-ms, 10-digit epoch-seconds, `ep-N`/`epN` counters, dotted attempt suffixes (`.1.r2.o1`). It does **not** blank UUIDs or hex runs: an operation id or a machine id can be the thing that needs action (two lost replies to one topic are two losses). Topic ids, `CMT-123`, slugs are kept. Two rows share a derived key only when source, category, title AND the stable part of the id agree.

Why the title is in the derived key: it is the producer's one-line statement of the condition and what the console already groups by; the id skeleton keeps two different topics/accounts apart when the title is generic.

### 3.2 Clear on cause

New method `clearAttentionCondition(match: { conditionKey?: string; id?: string; idPrefix?: string }, resolution: string): number` — closes every matching open row as `DONE`, `closedBy:'cause-cleared'`, silent (no hub post). `idPrefix` is delimiter-bounded (the caller's prefix must end in a delimiter, e.g. `…:ep-`) so `:ep-1` can never match `:ep-10`. Exposed as `POST /attention/clear` `{ conditionKey | id | idPrefix, resolution }` (Bearer) for job/script producers. **Sticky rows are refused by this path** (counted, logged) — only the operator closes a security item.

`AttentionConditionStore` gains an optional `onClear(baseKey, itemId)` callback; `clear`/`clearSubject` call it with the record's base key (`producer:type:subject:scope`), and server.ts wires it to `clearAttentionCondition({ idPrefix: `${baseKey}:ep-` })` — every episode of that condition closes, including rows left from before this change. Both current users (RopeRecoveryProber, StaleOwnerReleaseEngine) are fixed by that one wiring, and the reconciliation pass (§3.4) also closes rows whose condition record is already inactive (a crash between the two writes cannot leave them apart).

### 3.3 Producer hooks (the 80/20 set, by open-row count)

| Producer | Open rows | `conditionKey` | Clear signal (file:line today) |
|---|---|---|---|
| assisted-subscription-relogin | 27 (+ pool) | `subscription-relogin:<accountId>:<machineId>` | **Verified recovery only:** `transition` to `succeeded` (`SubscriptionReloginStore.ts:500-518`), an operator `cancel`, or the pool cell for that account×machine reading healthy on a quota poll. `failed` / `refused` / a new attempt do NOT clear — they refresh the row's text (rule 2) so the operator sees the current ask. The success `terminal` notice becomes the close (no separate "repaired, nothing to do" row) |
| telegram-origin-forward-to-holder | 243 | `telegram-origin-held:<topicId>` (aggregate: `telegram-origin-held:aggregate`) | the topic has **zero unresolved held operations** — a new store query over all held forwards for the topic, independent of retry due-time and page limits (`OriginStoreBackend.ts:495` returns only due rows and must not be the signal). Expiry rows (`…:expired:<operationId>`) stay distinct per operation (a loss is per message) and are `automated` class |
| stale-owner-release / rope prober | 65 + | store itemId (already) | `AttentionConditionStore.clearSubject/clear` via the new `onClear`; rows whose condition record is inactive are also closed by the reconciliation pass. Escalation stays on every quorum member (an unavailable lease holder must not silence the witnesses) |
| duplicate-reconciler | 71 | `dup-reconciler:<kind>:<key>` (echo rows: `dup-reconciler:echo`) | episode delete (`DuplicateSessionReconciler.ts:365, :573`); breaker when `breakerClamped(key)` is false (`:653-661`) |
| idle-zombie-veto | 18 | `idle-zombie-veto:<topicId>` | `idleKillBackoff.recordKilled/clear/reset` (`SessionManager.ts:1711, :4800, :3112…`) |
| session-reaper:standdown | 14 | `standdown:<kind>:<topicId>` | `pruneLatches` delete (`StandDownRegistry.ts:627`); `contestedWork` null (`SessionReaper.ts:1097`); mutual-muzzle: notice, expires |
| orphaned-work | ~95 | `orphaned-work:<slug>` (drop `workSig` from the id) | `evaluate()` → `skip('clean'|'owner-alive')` or worktree gone (`OrphanedWorkSentinel.ts:192-196`) |
| account-follow-me-email-gate | 25 | existing id | `outcome:'validated'` for the login, or login left `store.active()` (`EnrollmentWizard.ts:500-512`) |
| subscription-pool:swap-antithrash | 17 | `swap-antithrash:<kind>[:<session>]` | `!blind` (`SwapAntiThrash.ts:491`); hops below threshold (`:771`) |

Also: `quota-poll-identity-oracle` already closes but rebuilds the id from `detectedAt`; switch it to `conditionKey: credential-identity-drift:<accountId>` so the close cannot miss. `evolution-overdue-check` job template: id `evolution-overdue` (no date) and a `POST /attention/clear` step when the overdue list is empty; migration updates installed templates.

Pool-wide duplication: every per-machine raise is genuinely about that machine (a held reply IS on that machine; a stale-owner witness IS that machine's evidence). The cross-machine view stays read-side: the pool read's P17 coalesce and the console's grouping. **Decisions:** no creation-time cross-machine lock (a mesh round-trip on every raise for a read-side problem), and no change to P17 in this spec (its grouping limits — source-only key, HIGH/URGENT uncoalesced — are a display concern owned by the console work and are noted there).

### 3.4 Reconciliation pass (dedupe → verified clears → expiry)

`AttentionLifecycleSweeper` runs one idempotent pass hourly inside the adapter (first pass 2 min after boot; also the body of `POST /attention/lifecycle/sweep`). The same pass serves the one-time cleanup, so last week's terminal repairs and conditions cleared before this shipped are caught without replaying their hooks. Steps, in order, each row touched at most once per pass:

1. **Supersede duplicates.** Group open rows by condition key (producer key, else derived key). Where a key has >1 open row, keep the newest-touched, fold the others in (`occurrences` summed, their ids into `aliases`), close them `DONE`, `closedBy:'superseded'`, `resolution:'superseded by <keptId>'`.
2. **Verified clears.** For producers with an authoritative local state, close rows whose condition is provably over: a sign-in row whose episode is `succeeded`/cancelled or whose cell reads healthy; a condition-store row whose record is inactive; an origin-held row whose topic has zero unresolved held operations. Unknown or unavailable producer state → the row is left alone (never "probably fine").
3. **Expiry** (the long tail). For each remaining OPEN row (ACKNOWLEDGED / IN_PROGRESS are **never** expired — the operator touched them), `age = now − max(updatedAt, lastSeenAt)`:

| Class | Rule | Window (default) | Resolution text |
|---|---|---|---|
| security | `sticky:true`, or `category`/`sourceContext`/`title` matches `/security|credential-exposure|credential-leak|\bleak/i` | never | — |
| operator-asked | the hub filter would admit it as needing the user (`needsUser`, agent-raised `sourceContext:'agent'`, a NEEDS_USER source, URGENT — `admitItemToHub(...,'signal')`), or category matches `/decision|approval|review/i` | 30 d | `expired: the operator did not answer within 30 days. Raise it again if it still matters.` |
| automated | everything else | 14 d | `expired: never confirmed cleared; untouched for 14 days.` |

A row whose condition-store record is still **active** is never expired (that producer deliberately raises once per episode). `closedBy:'expired'`, status `DONE`. Silent. Every close is one line in `logs/attention-lifecycle.jsonl` (`{ts, id, conditionKey, closedBy, resolution, ageDays, class}`), never a hub post. Why 14 days: it matches the console's "probably already handled" line, so what the operator sees as stale and what the store closes agree. Why DONE and not a new status: the vocabulary spec (`attention-api-vocabulary-compatibility.md`) fixes the status set; `closedBy` + `resolution` carry the honesty and are returned on `GET /attention` and the dashboard. An expired row that was wrong is reopened by `PATCH … {status:'OPEN'}` or by the producer's next observation; a condition nobody observes again stays closed — expiry is a bounded answer to silence, not a claim the problem ended.

**First-pass review window (structural):** the first pass on a machine (no prior `state/attention-lifecycle.json`) runs expiry as a **dry run** — would-close rows are listed in the log and in `GET /attention/lifecycle` — while dedupe and verified clears run live. From the second pass on, expiry is live. This gives every machine one reviewable list before anything ages out, with no second release needed.

Sweep status: `GET /attention/lifecycle` → `{ enabled, dryRun, firstPassAt, lastSweepAt, lastPass: {superseded, causeCleared, expired, wouldExpire}, windows, openByClass }`. Manual pass: `POST /attention/lifecycle/sweep` `{ dryRun?: boolean }` → the exact list it would/did close (id, title, class, ageDays, closedBy, resolution).

### 3.5 Commitments waiting on the operator

Today's `isAutoExpiryEligible` already expires agent-owned rows at 21 days regardless of `blockedOn` (`CommitmentTracker.ts:1879-1890`); what waits forever is `owner:'user'`. The auto-expiry sweep gains an **operator-wait branch, evaluated before the agent branch**: `owner === 'user'` (or `blockedOn ∈ {user-input, user-authorization}` on a non-agent owner), `status pending|violated`, wait start = the latest of `createdAt` and the current blocker episode's start, waited ≥ `commitments.operatorWait.maxAgeDays` (default 14), no future `hardDeadlineAt` → `expired` with a per-row resolution `expired: waited N days for the operator (user-input|user-authorization); ask again if still needed`. The branch has its **own** `dryRun` (default **false** — the existing `autoExpiry.dryRun` defaults to true and would make this inert), and the sweep report gains a per-row `disposition` list. Replicas from other machines are skipped: the origin machine expires its own row and replication carries it. An unanswered authorization that expires is not granted — it is closed as unanswered, and the agent must ask again if it still needs it.

Re-ask: **cut** (both reviewers). The operator asked for less nagging; a dark re-ask engine is scope without a user. Config block: `commitments.operatorWait: { enabled: true, maxAgeDays: 14, dryRun: false }`.

### 3.6 One-time sweep of today's backlog

After deploy the boot pass on each machine runs dedupe + verified clears live and lists would-expire rows (first-pass dry run, §3.4). I read that list on each of the four machines (`GET /attention/lifecycle`), check the operator-asked rows by hand, then run `POST /attention/lifecycle/sweep {dryRun:false}` per machine. The security item "Rotate exposed GitHub access token" (46 d) is verified by hand before any action: if the token was rotated it is closed by the operator path with the evidence named; if not, it stays open. Raw before/after open counts per machine plus every closed row (id, title, class, age, closedBy, resolution, machine) and every row left open as "unknown producer state" go to `docs/audits/attention-noise-sweep-2026-10-25.md` — the brief's deliverable.

### 3.7 Rollout and rollback

Ships **ON** by default (`messaging[].config.attentionLifecycle.enabled: true` — beside its siblings `attentionHubFilter` / `attentionRouting`). This is a correction of a defect the operator is living with now; dark-shipping it would leave the hub unusable for another release cycle, and the first-pass dry run gives each machine its review window structurally. Levers, all read live: `attentionLifecycle.enabled: false` (sweep off, condition dedupe off → today's exact behaviour), `attentionLifecycle.expiry.automatedDays`, `.operatorAskedDays`, `.dryRun` (log would-expire rows, expire nothing — dedupe and verified clears still run), `attentionLifecycle.wontDoHoldDays`. Rows are never deleted, only closed with a labelled resolution; a wrong close is reopened with `PATCH /attention/:id {status:'OPEN'}` or by the producer's next observation. `migrateConfig` adds the blocks with existence checks; `migrateClaudeMd` adds the awareness section (content-sniffed); the `evolution-overdue-check` job-template change rides the built-in job overwrite.

## 4. Non-goals

- A new attention status value, a cross-machine creation-time lock, changes to the hub's posting format, or any change under `dashboard/console/` (PR 2359 owns it).
- Fixing each of the ~62 non-closing producers individually. The derived key + expiry sweep bound them; the 9 hooks cover the volume.

## 5. Tests (all three tiers)

- **Unit** `tests/unit/AttentionLifecycle.test.ts`: derived-key normalization (timestamps/UUIDs/ep-N blanked; topic ids kept; different titles never collapse); create-twice-same-condition → one row with `occurrences:2`; reopen of a DONE id; WONT_DO 30-day hold; `clearAttentionCondition` by key/prefix/predicate; sweep classes (security never; operator-asked 30d; automated 14d; `dryRun` closes nothing); `AttentionConditionStore.onClear` fires on `clearSubject`; `CommitmentTracker` operator-wait expiry (user-owned pending 15d → expired; 13d → kept; replica skipped; future hardDeadline kept; `dryRun` kept).
- **Integration** `tests/integration/attention-lifecycle.test.ts`: `POST /attention` twice with timestamped ids and the same title/source → `GET /attention` shows one row; `POST /attention/clear` closes by prefix; `POST /attention/lifecycle/sweep {dryRun:true}` lists without closing; `{dryRun:false}` closes and `GET /attention/:id` shows `closedBy:'expired'`.
- **E2E** `tests/e2e/attention-lifecycle-alive.test.ts`: production init path; `GET /attention/lifecycle` → 200 with `enabled:true` and a real `lastSweepAt` after the boot pass (not 503).
- Producer hook tests: sign-in repair terminal → item closed; `AttentionConditionStore.clearSubject` → item closed; orphaned-work `clean` → closed.

## 6. Agent awareness

Template section "Attention items close themselves" in `generateClaudeMd()`: items are one per condition; raise with a stable `conditionKey`; close with `POST /attention/clear` when the cause clears; `GET /attention/lifecycle` for "why did my item disappear / why is this still open"; the expiry windows and that security items never expire. Proactive trigger: "why is the attention hub full of old items?" → `GET /attention/lifecycle` and `logs/attention-lifecycle.jsonl`.

## Review changes

**Round 1 — Gemini 4 Argon (ready with changes) · GPT-6 Astra (not ready).** Reports: `docs/specs/reports/attention-lifecycle-close-on-cause-review-r1-{argon,astra}.md`.

| Finding | Handled |
|---|---|
| Argon 1 / Astra 1 — TERMINAL includes failed/refused; closing there hides the failure. Origin-held `:495` returns only due rows. | Accepted. §3.3: sign-in clears only on `succeeded`, operator cancel, or a healthy cell; failed/refused/new attempt refresh the row. Origin-held clear = zero unresolved ops for the topic via a new all-rows query. |
| Argon 2 / Astra 4 — "bump and return" swallows a changed ask (suggested → phone-tap); three writers, three lifecycles; HTTP drops the new fields. | Accepted. §3.1: one `admitAttentionObservation` helper for every writer; changed text/priority refreshes + reposts, a mere repeat keeps ACK/IN_PROGRESS; route passes/validates `conditionKey`, `sticky`. |
| Argon 3 / Astra 3 (prefix) — `onClear(itemId)` misses prior episodes; `:ep-1` prefixes `:ep-10`. | Accepted. §3.2: callback passes the base key; clear uses the delimiter-bounded prefix `…:ep-`. |
| Argon 4 / Astra 3 (derived key) — skeleton too narrow (attempt suffixes) AND too wide (UUIDs identify losses); title must keep digits. | Accepted both halves. §3.1: dotted attempt suffixes + epoch-seconds blanked; UUIDs/hex NOT blanked; title keeps digits/identifiers. |
| Argon 5 / Astra 6 — the sweep must reconcile the existing pile (dedupe, verify, not just age) and survive a crash between the two stores. | Accepted. §3.4 is now a three-step idempotent reconciliation pass; inactive condition records close their rows on every pass. |
| Argon 6 / Astra 2 (classifier) — `source` is not a field; `needsUser` ignored; `autoExpiry.dryRun` defaults true. | Accepted. Operator-asked class reuses `admitItemToHub(...,'signal')`; the operator-wait branch has its own `dryRun:false`. |
| Argon 7 / Astra 5 — reopen must drop the repost-throttle entry; `closedBy:'operator'` on PATCH; episode protection for stale closes/acks; WONT_DO hold must bind the condition, not the id. | Accepted: throttle entry dropped on reopen; `episode` counter persisted and bumped; WONT_DO hold is checked by condition key over closed rows. Remote-ack episode binding (WS4.1) is dark on the fleet and out of scope here — noted, not built. |
| Argon 8 / Astra 8 — cut the re-ask engine and the `predicate` clear. | Accepted, both cut. |
| Astra 2 — blanket 14/30-day expiry can erase unanswered operator work; expire only disposable notice types. | **Partly accepted.** ACK/IN_PROGRESS never expire; an active condition-store record never expires; security also matched on title; sticky refused in every automatic close path; first pass per machine is a reviewable dry run. **Declined:** restricting expiry to an allowlist of notice types. The operator's complaint is the unknown long tail (~62 producers, 184 sources live) — an allowlist leaves exactly that pile. Bounded expiry with an honest label, after a 14/30-day silence, matches the console's own stale rule and the already-approved 21-day commitment expiry. Rollback is one lever. |
| Astra 7 — holder-only stale-owner escalation can silence witnesses; P17 coalesce is lossy. | Accepted for escalation (lease gating cut). P17 changes declined as out of scope (read-side display, console work); limits recorded in §3.3. |
| Astra 8 — defer commitment expiry entirely. | **Declined** (it is item 3 of the operator's brief), but narrowed per the finding: own branch first, own dryRun, wait-start from the blocker episode, per-row disposition, no re-ask. |
| Companion line 19 ("stays open with a label") was wrong. | Fixed: rows close as DONE with a labelled resolution. |
| Config location `attention.lifecycle` vs siblings. | Moved to `messaging[].config.attentionLifecycle`, where `attentionHubFilter` / `attentionRouting` live. |
