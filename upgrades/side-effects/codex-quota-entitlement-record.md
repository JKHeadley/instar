# Side-Effects Review — Codex quota reader keeps the usage record, not the session-close entitlement record

**Version / slug:** `codex-quota-entitlement-record`
**Date:** `2026-09-20`
**Author:** `Echo`
**Second-pass reviewer:** `not required` (no block/allow surface; see §4)

## Summary of the change

Codex appends TWO kinds of `token_count.rate_limits` record to a rollout: many real `limit_id: "codex"` records carrying the account's usage windows during the session, and exactly one `limit_id: "premium"` entitlement/credits record at session close carrying `primary: null, secondary: null`. `parseUsageFromTail` took the newest record unconditionally, so the single closing line erased a whole session of real quota and the account's Subscriptions card went blank the moment its session ended. Live evidence from this machine: one rollout holds 600 `codex` records followed by 1 `premium` record, and the `premium` one won; 3 of 5 enrolled Codex accounts were reading blank.

Files touched: `src/providers/adapters/openai-codex/observability/codexRateLimitReader.ts` (record selection + a `windowsUnavailable` flag), `src/core/QuotaPoller.ts` (carry the flag into the stored snapshot), `src/core/SubscriptionPool.ts` (`AccountQuotaSnapshot.noQuotaWindow`), `dashboard/subscriptions.js` + `dashboard/index.html` (honest label + reading-age line), and three unit test files.

## Decision-point inventory

This change touches no block/allow decision point. The reader is a pure observability signal producer; its output is consumed by authorities that are not modified here.

- `codexRateLimitReader.parseUsageFromTail` — **modify** — selects WHICH of the account's own records is the usage reading. It chooses among records the account wrote; it never synthesises, estimates or adjusts a number.
- `QuotaPoller.pollAccount` (codex branch) — **pass-through** — stores the reader's snapshot plus one new display-only boolean.
- `dashboard/subscriptions.js renderAccounts` — **modify** — render-only; picks which sentence to show for an account with no bar.
- `QuotaCollector` codex branch (solo-Codex load-shed brake) — **pass-through, unmodified** — it requires BOTH `primary` and `secondary` before trusting a reading. Codex currently reports the weekly window under `primary` with `secondary: null`, so that brake continues to record `quotaUnknown` and shed exactly as it did before this change. Deliberately left alone: loosening a fail-safe brake is a separate decision with its own risk, not a side effect of a reader fix. Flagged for follow-up below.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

The nearest analogue is "which record is rejected as the reading". The selection rejects two shapes: a record from a non-`codex` limit family, and a record with no window object. Both rejections are conservative in the safe direction — they can only withhold a number, never invent one. The one behaviour worth naming: a hypothetical future `limit_id` that is neither `codex` nor window-less (another product's allowance, carrying windows) is ignored rather than displayed. That is deliberate — presenting another product's window as this account's quota would be a wrong number reaching placement, which is strictly worse than no number. Covered by a test.

---

## 2. Under-block

No block/allow surface — under-block not applicable.

What the change still does NOT solve: a reading is only as fresh as the account's last completed turn. An idle account keeps serving a days-old number, and after this fix `justin@sagemindai.io` reads 100% from 2026-09-14 because nothing has run on it since. The fix makes that number visible and labels its age; it does not make it current. Making it current would require actively spending quota to mint a fresh record, which is a cost-bearing decision, not a bug fix. An account whose real quota record has fallen outside the scanned rollout window (`DEFAULT_MAX_ROLLOUTS` = 8, widened only by mtime ranking) still reads as having no window; on this machine that affects no account — the one account with no reading (`dawn@sagemindai.io`) has genuinely never written a `codex`-family record, verified across five days of its rollouts.

---

## 3. Level-of-abstraction fit

Correct layer, and it uses the existing primitive rather than re-implementing it. The parse is a structural validator over lines the account itself wrote — exactly the "detector" tier in `docs/signal-vs-authority.md`. Window routing (which window is 5h vs weekly) is NOT re-implemented here: it stays in `classifyCodexWindows`, which the poller already calls, so a weekly window arriving under `primary` is still filed as `sevenDay`. The new `windowsUnavailable` / `noQuotaWindow` flag deliberately stops at the display layer instead of being handed to placement: "this account reports no window" is honest UI copy, not a routing fact, and giving it routing meaning would be exactly the detector-holding-authority mistake.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface.

The reader emits a structured observation (`{primary, secondary, capturedAt, windowsUnavailable}`). Every authority that consumes it — the proactive-swap threshold, placement's quota-blocked check, `QuotaTracker` — is unchanged. The change's effect on those authorities is that two exhausted accounts (100% and 94% weekly) now present a real number where they previously presented nothing, which makes placement MORE likely to route work away from them. That is the safe direction: a fix that only ever adds true information to a cautious consumer.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The record-kind check is an **invariant over a documented data format**, not a judgment: a `rate_limits` object either declares `limit_id: "codex"` (or omits it, the pre-`limit_id` rollout shape) and carries a window object, or it does not. There are no competing live signals to weigh — the account's own log states the kind. The one threshold introduced (`STALE_READING_MS` = 6h) governs a purely cosmetic label with no decision attached; showing or omitting an age line changes no behaviour anywhere in the system.

---

## 5. Interactions

- **Shadowing:** none. `parseUsageFromTail` has one caller inside the module (`readLatestCodexUsage`) plus direct test use. `readLatestCodexUsage` gains a preference order (windowed reading wins; a window-less reading is held back as a fallback) but never skips a rollout it previously read. It can only return MORE than before: every input that previously yielded a snapshot still yields one.
- **Double-fire:** not applicable — the reader performs no action and emits no notice. Nothing fires.
- **Races:** none introduced. The reader is read-only over rollout files, holds no state between calls, and the new local variables are function-scoped. `QuotaPoller`'s `lastByAccount` / `prevByAccount` bookkeeping is untouched.
- **Feedback loops:** the poller's own `burnRate` derivation compares consecutive snapshots. Before this change, an account could alternate between a windowed snapshot and a window-less one as sessions opened and closed, which is the noisiest possible input to a rate-of-change calculation. Preferring the windowed record makes the snapshot series more stable, not less.
- **Adjacent consumer verified:** `QuotaCollector`'s codex branch reads the same snapshot type and gates on `usage?.primary && usage.secondary`. That condition's truth value is unchanged for every account on this machine (none currently reports both windows), so the load-shed brake's behaviour is bit-for-bit the same.

---

## 6. External surfaces

- **Other agents on the same machine:** none — the reader is per-account and read-only over that account's own config home.
- **Install base:** the Subscriptions dashboard changes what it shows. Accounts that were blank will show a bar; a credits-only account's sentence changes from "No quota reading yet." to "This account reports no usage window."; a reading older than 6h gains an age line. No layout, no interaction, no removal.
- **External systems:** none. No network call is added; the reader still only reads local files.
- **Persistent state:** `AccountQuotaSnapshot` gains one optional boolean. The field is additive, absent on every existing stored snapshot, and treated as falsy when absent — old persisted pool state loads unchanged.
- **Timing / runtime conditions:** unchanged. The same rollouts are scanned with the same bounds (`DEFAULT_MAX_ROLLOUTS`, `DEFAULT_TAIL_BYTES`); the extra work is one string comparison per rate-limit line already being parsed.
- **Operator surface (Mobile-Complete Operator Actions):** no operator-facing ACTION is added or touched — nothing to approve, grant, revoke or submit. The change is read-only rendering on a surface the operator already reaches from their phone.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

This change touches `dashboard/subscriptions.js` and `dashboard/index.html`, so the section is required.

1. **Leads with the primary action?** Yes — the operator comes to this card to read a usage number, and the change's whole purpose is that the number is present where it was previously missing. Nothing is collapsed or moved; the bar remains the card's first content after the header, and the two new lines sit beneath it as support.
2. **Zero raw internals as primary content?** Yes. The new strings are "This account reports no usage window." and "Reading from 6d ago" — plain sentences. No field name, flag name, limit-family id, rollout path, thread UUID or hash reaches the DOM. The internal terms (`noQuotaWindow`, `limit_id`, `windowsUnavailable`) exist only in code and never in copy.
3. **Destructive actions de-emphasized?** Not applicable — this change adds no action of any kind, destructive or otherwise.
4. **Plain language + phone width?** Yes. Both additions are single short text lines appended to an existing vertical card that already stacks at phone width; the age line is rendered at 11px / 0.5 opacity as support metadata, deliberately quieter than the bar it annotates. No table, no horizontal layout, no new tap target, so no new truncation or horizontal-scroll risk. Both strings pass through `el()`'s `textContent`-only write path, preserving the module's no-`innerHTML` contract.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN**, with the reason: a Codex login and its session rollouts live on the disk of the machine that holds them, and per-CLAUDE.md policy Codex logins are never copied between machines. An account's usage reading is therefore a property of one machine's filesystem, and reading it anywhere else is impossible by construction, not by omission.

The pool-wide question is already answered by an existing **proxied-on-read** path: `GET /subscription-pool?scope=pool` fans out to each online peer's plain listing and merges the rows, tagging each with the machine holding it. That merge spreads account objects wholesale (`{...a}`), so the new `lastQuota.noQuotaWindow` field crosses to the merged view with no route change — the same machine that reads the rollout is the one that states the flag, and a peer never asserts a reading it did not take. A dark peer degrades to the existing classified `pool.failed` row.

A second cross-machine carrier was found DURING this review and fixed in-scope: the WS5.2 account-meta replicated store projects `lastQuota` wholesale into its `quota` field, and its receive-side clamp REJECTS any unknown quota key. Without a schema addition, a projection carrying `noQuotaWindow` would have been rejected wholesale on peers — stranding that account's replicated metadata. `noQuotaWindow` is now a known, strictly-boolean key in `validateQuota` (any other type rejects, same as every clamped field), with both sides of the boundary tested. Mixed-version window: a peer still on the previous release rejects a projection carrying the new key until it updates — transient, converges with the rolling update, and the failure mode is a stale replicated view, never a wrong value.

Explicitly: it emits **no user-facing notice** (nothing to one-voice-gate — the change is render-only and raises no attention item, no Telegram message); it holds **no durable state that can strand on topic transfer** (the snapshot is per-account, not per-topic, and account ownership does not move with a conversation); it **generates no URLs**.

---

## 8. Rollback cost

- **Hot-fix release:** revert the commit, ship as the next patch. The change is code-only.
- **Data migration:** none. The one new persisted field is optional and additive; leaving stale `noQuotaWindow: true` values in `subscription-pool` state after a revert is harmless — the reverted dashboard simply never reads the field.
- **Agent state repair:** none. No agent needs notifying or resetting; the next poll overwrites each snapshot regardless.
- **User visibility during rollback:** the regression is the original bug — cards go blank again at session close. Nothing is destroyed and no wrong number is ever shown; the failure mode in both directions is absence, not error.

---

## Conclusion

The review produced no design changes: the fix stayed inside the detector tier, the one flag it adds was deliberately confined to display rather than handed to placement, and the adjacent load-shed brake was checked and consciously left alone rather than opportunistically "fixed" in the same change. Two items are flagged for follow-up rather than silently absorbed — (a) `QuotaCollector`'s codex branch requires both windows in a world where Codex now sends one, so the solo-Codex brake may be shedding on a reading it could have trusted; (b) a quota reading is only as fresh as the account's last turn, and an actively-refreshed reading would cost quota to mint. Both are genuine separate decisions with their own risk, tracked below, not deferrals of this change's scope. The fix itself is verified against live data on all five enrolled accounts and is clear to ship.

<!-- tracked: ACT-018 --> **Follow-up (a)** — `QuotaCollector` requires `primary && secondary` for a codex reading; Codex reports one window. Needs its own review because it loosens a fail-safe brake.

<!-- tracked: ACT-019 --> **Follow-up (b)** — an actively-minted fresh reading per poll. Cost-bearing; needs an explicit operator decision.

---

## Second-pass review (if required)

**Reviewer:** not required.

Phase 5's trigger list is block/allow decisions on messaging or dispatch, session lifecycle, context/compaction, coherence gates and trust levels, and anything named sentinel/guard/gate/watchdog. This change is a read-only file parser plus two render strings, touches none of those, and adds no blocking authority (§4). The decision to leave `QuotaCollector`'s brake unmodified is what keeps it out of the lifecycle/safety surface.

---

## Evidence pointers

- Live before/after on all five enrolled Codex accounts, run through the BUILT reader against the real config homes:
  - before — `justin@sagemindai.io` blank, `headley.justin@gmail.com` blank, `dawn@sagemindai.io` blank, `amrch2388@gmail.com` 86%, `adriana@sagemindai.io` 96%
  - after — `justin@sagemindai.io` 100% weekly (captured 2026-09-14), `headley.justin@gmail.com` 94% weekly (captured 2026-09-15), `amrch2388@gmail.com` 86%, `adriana@sagemindai.io` 96%, `dawn@sagemindai.io` `windowsUnavailable: true`
- Root-cause evidence: one `justin@sagemindai.io` rollout contains 600 `limit_id: "codex"` records followed by exactly 1 `limit_id: "premium"` record, and the `premium` one is the final line of the file.
- `dawn@sagemindai.io` has no `limit_id: "codex"` record in any sizeable rollout across 2026-09-16..20 — its blank card is an honest state, not a parse failure.
- Tests: `tests/unit/codexRateLimitReader.test.ts` (15 pass; the 5 new cases were confirmed to FAIL against the pre-fix selection logic and pass after), `tests/unit/quota-poller.test.ts` (26 pass), `tests/unit/subscriptions-render.test.ts` (97 pass).

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The defect is in hand-written TypeScript reading a third-party (OpenAI Codex) log format, not in an LLM prompt, hook, config, skill or standards text. The change also adds no self-triggered controller: it starts no loop, monitor, sentinel, reaper, scheduler or recovery path, and fires no restart, swap, respawn, spawn, notify, retry, re-drive or kill. It is invoked only by the existing poller's existing cadence.
