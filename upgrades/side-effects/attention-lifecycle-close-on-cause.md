# Side-Effects Review — Attention lifecycle: items close when their cause clears

**Version / slug:** `attention-lifecycle-close-on-cause`
**Date:** `2026-10-25`
**Author:** `echo`
**Second-pass reviewer:** `GPT-6 Astra (codex) + Gemini 4 Argon (gemini) — spec review round 1; see docs/specs/reports/attention-lifecycle-close-on-cause-review-r1-*.md`

**Tier:** 2 (fleet-wide behavior change to the attention store; new authority to close items; default ON). Size: ~12 source files, ~900 LOC incl. tests. Effort: 1 spec review round (both reviewers), 1 commit attempt expected.

## Summary of the change

The attention store (`TelegramAdapter`) gains a lifecycle layer, spec `docs/specs/attention-lifecycle-close-on-cause.md`: (1) one row per CONDITION — every writer (`createAttentionItem`, `upsertAttentionItem`, the agent-health reopen, `POST /attention`) goes through one `admitAttentionObservation` helper that lands repeats on the existing row (refreshing body/priority when the ask changes, reopening a closed row for a new episode, holding a recent operator WONT_DO); (2) `clearAttentionCondition` + `POST /attention/clear` for producers that know their cause cleared, plus `AttentionConditionStore.onClear` so the two existing condition-store producers close their rows; (3) an hourly idempotent reconciliation pass (`runAttentionLifecyclePass`, `POST /attention/lifecycle/sweep`, `GET /attention/lifecycle`) — supersede duplicates → producer-verified clears → bounded expiry (automated 14 d, operator-asked 30 d, ACK/IN_PROGRESS/security/active-condition never), with the first pass per machine running expiry as a dry run; (4) `CommitmentTracker` operator-wait expiry (user-owned / user-blocked commitments expire after 14 d with a per-row reason); (5) producer hooks (sign-in repair, held replies, duplicate reconciler, idle-zombie veto, stand-down, orphaned work, follow-me email gate, swap anti-thrash, identity drift, evolution-overdue job) passing stable `conditionKey`s and clearing on their real signals. Files: `src/core/AttentionLifecycle.ts` (new), `src/messaging/TelegramAdapter.ts`, `src/core/AttentionConditionStore.ts`, `src/server/routes.ts`, `src/monitoring/CommitmentTracker.ts`, `src/core/types.ts`, `src/scaffold/templates.ts`, `src/core/PostUpdateMigrator.ts`, producer files listed in the spec §3.3.

## Decision-point inventory

- `TelegramAdapter.admitAttentionObservation` — add — decides whether an observation is a new row, a repeat, a refresh, a reopen or a held WONT_DO.
- `TelegramAdapter.clearAttentionCondition` — add — closes open rows a producer says are over; refuses sticky/security rows.
- `TelegramAdapter.runAttentionLifecyclePass` — add — supersession, verified clears, expiry; first-pass dry run.
- `AttentionLifecycle.classifyAttentionLifecycle / decideAttentionExpiry` — add — the expiry class and window per row (reuses `admitItemToHub` for "operator-asked").
- `AttentionConditionStore.clear / clearSubject` — modify — now fire `onClear`.
- `CommitmentTracker.runAutoExpirySweep` — modify — operator-wait branch judged before the agent branch.
- `POST /attention` — modify — passes `conditionKey` / `sticky`.
- Producer raise sites (spec §3.3) — modify — stable keys + clear calls.

---

## 1. Over-block

The layer never blocks a raise. The closest thing to an over-block is a WRONG CLOSE:

- **Derived-key collapse of two different conditions.** Two rows merge only when source, category, normalized title AND the id skeleton agree; the skeleton blanks only ISO datetimes, epoch ms/s, `ep-N` and dotted attempt suffixes — not UUIDs, hex runs, topic ids or `CMT-123`. Residual: two genuinely different conditions whose producer gives them the same title and ids differing only by a timestamp. The fix for such a producer is a `conditionKey`; the merged row keeps every id in `aliases`, so nothing is lost and a PATCH by either id lands.
- **Expiry of a still-real automated condition nobody re-observed for 14 days.** Accepted by design (spec §3.4 and the declined Astra finding 2): the resolution says "never confirmed cleared", the row is not deleted, the producer's next observation reopens it, and the first pass per machine is a reviewable dry run. ACK/IN_PROGRESS, security (category/source/title/sticky) and condition-store-active rows are excluded.
- **Operator-wait commitment expiry** closes an unanswered authorization as UNANSWERED (never granted); the agent must ask again.

---

## 2. Under-block

- A producer with no `conditionKey`, a unique title per raise and no clear signal still gets one row per raise until expiry (14 d). Bounded, not eliminated.
- A sticky/security row that is genuinely stale is never closed by the system — by design; the operator closes it.
- Expiry measures silence, not truth: a row the operator never saw and whose producer never cleared ages out after 14/30 d. The `wouldExpire` list on the first pass and the jsonl audit are the review surface.
- `GET /attention?scope=pool` P17 coalescing is unchanged (source-only key, HIGH/URGENT uncoalesced) — a display concern owned by the console work; noted in the spec.

---

## 3. Level-of-abstraction fit

Right layer: the store is the one chokepoint every producer already passes through, so "one row per condition" and "bounded retention" become structural instead of 70 producer patches (Structure > Willpower). Producer hooks sit where the producer already knows its clear signal. The expiry classifier reuses the existing hub-admission policy (`admitItemToHub`) so "what the user was asked" and "what expires slowly" are one rule, not two drifting ones. No LLM, no new authority over messages — only over the attention store's own rows.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface over user-facing messages or agent actions.

The layer closes attention ROWS (bookkeeping about notices), never a message, a session or an action. Closes are reversible (PATCH reopen / producer reopen), labelled (`closedBy`, `resolution`), audited (`logs/attention-lifecycle.jsonl`) and bounded (first-pass dry run; `expiry.dryRun`; `enabled:false`).

---

## 4b. Judgment-point check (Judgment Within Floors standard)

The 14/30-day windows are static heuristics at a point where signals could compete (silence vs. still-real). They are not a judgment point because: the row is never deleted, the close is labelled as an expiry not a resolution, any producer observation reopens it, and the floors (security/sticky never; ACK/IN_PROGRESS never; active condition never; first pass dry) carry the safety. The windows mirror the already-approved 21-day commitment auto-expiry and the console's own 14-day stale rule. An LLM judge over 850 rows × 4 machines would spend budget to decide what silence already decides.

---

## 5. Interactions

- **Shadowing:** `admitAttentionObservation` runs before hub routing in every writer; the hub repost throttle (6 h) still applies to refreshes, and a reopen drops its throttle entry so the reopen is visible (Argon 7). The hub filter is untouched.
- **Double-fire:** a producer that both calls `clearAttentionCondition` and is asked by the pass resolver reports `cleared` twice → the second finds no open row; idempotent. `AttentionConditionStore.onClear` and the pass's inactive-record resolver both close the same rows; the second is a no-op.
- **Races:** the pass and a concurrent raise touch the in-memory map on one event loop; no await inside the pass. A crash between the condition-store write and the item close is reconciled on the next pass (Astra 6).
- **Feedback loops:** none — the layer emits no attention items of its own.
- **Remote ack (WS4.1, dark on the fleet):** a queued ack by id still lands on the row (alias resolution); episode-binding of acks is noted in the spec as out of scope.

---

## 6. External surfaces

- Telegram: fewer hub posts (repeats no longer post); refreshes/reopens post as today's upsert did. No new topics.
- Persistent state: new optional fields on rows in `state/attention-items.json` (additive; old readers ignore them); new `state/attention-lifecycle.json`; new `logs/attention-lifecycle.jsonl`. Commitments: expired rows carry a resolution string; replication carries status as today.
- API: `GET /attention` rows carry `conditionKey/aliases/occurrences/lastSeenAt/episode/closedBy`; three new routes (`/attention/lifecycle`, `/attention/lifecycle/sweep`, `/attention/clear`); `POST /attention` accepts two optional fields. Status vocabulary unchanged.
- Other agents: every instar agent gets the layer on update (default on). Dashboard/console: unchanged in this PR (PR 2359 owns `dashboard/console/`); the legacy dashboard shows `resolution` already.
- **Operator surface:** no operator-facing ACTION is added — closes are automatic or agent-driven. The operator's levers are the existing PATCH (dashboard tap) and config. Not applicable beyond that.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable (no `dashboard/*` file touched).

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN, proxied-on-read.** Each machine's attention store is its own (a held reply IS on that machine; a stale-owner witness IS that machine's evidence); the lifecycle runs per store. The pool-wide view stays the existing `GET /attention?scope=pool` read (P17 coalesce + the console's grouping). No creation-time cross-machine lock (spec §3.3 decision: a mesh round-trip per raise for a read-side problem). Notices: the layer emits none, so no one-voice gating is needed. Durable state does not strand on topic transfer (rows are about machine conditions, not topics). URLs: none generated. Commitment expiry skips replicas (`originMachineId` ≠ self) — the origin machine expires its own row and replication carries it.

---

## 8. Rollback cost

- **Hot-fix / config:** `messaging[].config.attentionLifecycle.enabled: false` (read live) restores exact pre-feature writer behavior and stops the pass; `expiry.dryRun: true` keeps dedupe + verified clears but lists expiry only. `commitments.operatorWait.enabled: false` stops commitment expiry.
- **Data migration:** none required to roll back. Rows closed by the layer stay closed with `closedBy` + resolution; reopen individually via PATCH or let the producer reopen them. New fields are ignored by old code.
- **Agent state repair:** none. The CLAUDE.md bullet is additive.
- **User visibility:** fewer attention posts during the window; no regression on rollback.

---

## Conclusion

Both external reviewers moved the design materially: verified-only clears for sign-in and held replies, one writer helper, a reconciliation pass instead of age-only expiry, no UUID blanking, delimiter-bounded prefixes, the first-pass dry run, cut re-ask/predicate/lease-gating. Declined with reasons recorded in the spec: an allowlist-only expiry (leaves the long tail the operator complained about) and deferring commitment expiry (item 3 of the brief). Clear to ship once the full suite is green and the one-time sweep report is written.

---

## Second-pass review (if required)

**Reviewer:** GPT-6 Astra + Gemini 4 Argon (spec round 1)
**Independent read of the artifact: concur with changes applied**

Astra's verdict was "not ready" on the first draft; every finding is answered in the spec's "Review changes" table (accepted, narrowed, or declined with the reason). The code review surface is the PR.

---


## Verify-run fix (2026-10-26)

The first local verify on the rebased head found one real regression: the hourly pass's catch only console-logged a failure, which `tests/unit/no-silent-fallbacks.test.ts` counts as a new silent fallback (495 over a 494 baseline). The catch now also reports `Telegram.AttentionLifecycle` to `DegradationReporter`; a failed pass is skipped and rows stay as they are until the next hour. No baseline change, no new authority, no new self-action. The relogin integration/e2e failures in the same run also fail on unrelated PRs (2350, 2356, 2357) and pass on main and in isolation; they are not caused by this change.

The second verify run (base v1.3.1443) failed the same ratchet at 495 on main itself: a routes.ts change merged between v1.3.1440 and v1.3.1443 shifted the extractor window so the telemetry-enable route's catch (which answers a 500 naming the error, so it is not silent) started counting. That catch now carries an in-window `@silent-fallback-ok` with that reason; the scanner reports 494 again. No behavior change.

## Evidence pointers

- `tests/unit/AttentionLifecycle.test.ts`, `tests/unit/attention-lifecycle-store.test.ts`, `tests/unit/commitment-operator-wait-expiry.test.ts`, `tests/unit/attention-producer-hooks.test.ts`
- `tests/integration/attention-lifecycle.test.ts`
- `tests/e2e/attention-lifecycle-alive.test.ts`
- Live evidence: `docs/issues/attention-noise-items-never-close.md`; sweep report `docs/audits/attention-noise-sweep-2026-10-25.md` (written after deploy).

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`:** `unbounded-self-action` — the hourly reconciliation pass is a self-triggered controller (setInterval) that closes rows on its own.
- **`closure`:** `guard` — `tests/unit/self-action-convergence.test.ts` (ratchet) over the registry entry `attention-lifecycle-pass` in `src/testing/selfActionRegistry.ts`.
- **`guardEvidence`:** enforcement `ratchet`. Convergence argument: the pass acts only on OPEN rows and every action moves a row to a terminal state (DONE) that the pass itself never reopens, so under the pinned worst case (a backlog of duplicate + stale rows that nobody ever touches again) the total action count is bounded by the number of rows present (one close per row, ever) and the per-row count is 1; from the second pass on, with no new rows, the pass closes zero — horizon-independent. The settling brake is structural (terminal state + idempotent re-read), not a counter. The only way the count grows is a producer creating new rows, which is that producer's own self-action and is bounded by its own entry (or by the one-row-per-condition rule, which turns a repeat into an update instead of a new row).
