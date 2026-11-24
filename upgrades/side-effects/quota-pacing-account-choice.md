# Side-Effects Review — Quota pacing step 2: account choice reads each limit window correctly

**Version / slug:** `quota-pacing-account-choice`
**Date:** `2026-11-18`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer spawned by the parent session — concern raised, addressed in c7723dd66, re-checked: concur`

## Summary of the change

Spec: docs/specs/quota-pacing-account-choice.md (converged at round 6, approved under standing authority). Tier 2. 26 files, about 2,150 added lines, roughly half of them tests. Effort: 6 spec review rounds and 1 build pass. The proportion is high for a ranking fix; the reason is the poller encodings (Claude and Codex both blank a reset in two different ways), which the first draft did not know about.

While `subscriptionPool.pacing.windowAwareChoice` resolves on (dev-gated: on for development agents, off for the fleet, explicit value wins), every account picker uses one window-aware rule:

- `src/core/windowAwareChoice.ts` (new, pure). `windowNow` classifies each window as measured / idle / rolled / unknown / not-offered / unread-none / unread-old-cycle / unread-stale. `assessAccount` / `rankAccounts` rank in two tiers by least room across the binding weekly windows over the soonest of their resets. The Fable window binds a known Fable launch and falls back to `fable-no-room`, never null.
- `src/core/windowAwarePlacement.ts` (new). One spawn-placement decision shared by both spawn resolvers. It computes the old rule alongside inside a try and records one shadow row. It also holds the dev-gate resolver.
- `QuotaAwareScheduler.ts`: `selectAccount` / `poolHeadroom` take a window-aware path behind `SelectionOptions.windowAware`. `bindingUtilization(snap, at)` is the window-aware overload; the one-argument form is unchanged. The scheduler class takes live `windowAware` inputs for placement and reactive swaps.
- `UsageWallRescue.ts`: `spawnAccount(ctx)` (the default resolver) ranks its fresh accounts with the shared score, both tiers. The notice-wording `selectAccount` passes the same options. It shares one freshness constant (`FRESH_READING_MS`, 60 min, unchanged value).
- `SessionManager.ts`: the resolver now receives `{ model, modelSource, sessionName }` at the three spawn sites.
- `QuotaPoller.ts`: records `windowBasis` (idle-live vs rolled-history), `resetsAtBeforeRewrite` and `windowsListed`. It adds `requestRead` (the out-of-cycle read gate: one per poll interval, backoff to 2 and 4 intervals, an in-memory breaker at 6 failures, live-only for Codex, skips needs-reauth / disabled / device-limit-benched accounts) and `liveOnly` on the Codex path.
- `SwapAntiThrash.ts`: `readingValidity(…, { windowAware })` adds the `rolled` / `unknown` / `unread` invalid reasons. Whole-pool blindness counts a rolled reading only after 2 failed out-of-cycle reads.
- `SubscriptionAccountMetaReplicatedStore.ts` strips the three new local fields from the replicated projection, because a peer's strict validator rejects unknown keys.
- `codexDeviceLimitWiring.ts`: the referee pick takes the window-aware options.
- `src/monitoring/AccountChoiceShadowLog.ts` (new) and `GET /quota-pacing/account-choice` (pool summary, local / per-machine paged raw rows).
- Plus the dev-gate registration, ladder, CapabilityIndex row, awareness entry, config type, `commands/server.ts` composition, and the release fragment.

## Decision-point inventory

- Account placement for a new session (pinned resolver, default resolver) — modify — inputs and ranking change behind the switch; authority unchanged.
- Reactive swap target (`QuotaAwareScheduler.onQuotaPressure`, no target) — modify — same window-aware selection behind the switch.
- Throttle headroom (`poolHeadroom`) — modify — rolled/unknown windows reported null; unmeasured-tier best sets `degraded`.
- Proactive swap validity (`readingValidity`, SwapAntiThrash) — modify — adds refusals only (rolled/unknown/unread invalid).
- Measurement-blind alert — modify — a rolled reading delays blindness by about two poll intervals.
- Out-of-cycle quota read — add — a new bounded read trigger in the poller.
- Codex device-limit referee pick — modify — window-aware options behind the switch.

---

## 1. Over-block

The rule can exclude or demote an account that was legitimate:
- A Claude account whose snapshot predates this build lacks `windowsListed`. A window absent from it reads `unread-none`, so the account sits in the unmeasured tier until its next poll, which writes the field. It stays usable (tier 2), and it asks for an out-of-cycle read.
- A rolled weekly window demotes immediately, even if the account is actually near-empty after its reset. That is intended (unknown is not room). The account is still picked when nothing measured qualifies, and its read lands within one interval.
- A swap target whose reading rolled is refused for proactive moves until a post-reset reading lands. This is a refusal only: reactive rescue is unaffected.
- The out-of-cycle gate skips accounts benched by the device-limit tripwire. Their regular reads already back off; no account loses eligibility from this.

## 2. Under-block

- A burst of spawns between two readings lands on the same top account. Today's default picker does the same; the 5-hour soft line and the wall rescue catch it. Burst spreading is left behind in the spec.
- The swap paths are model-blind, so a running Fable session can be swapped onto an account with no Fable room (spec Left behind).
- A mid-session `/model` change is not seen by placement.
- If a Codex live read of an elapsed window does not reflect use from another machine, an account in use elsewhere would read `idle`. The spec makes this premise a judgment-candidate verified at the test-agent rung, with a fallback to `rolled`. Until that rung runs, the premise is unverified.
- `isFresh` on the default path does not know about synthesized capture times. A synthesized Codex time is not on that path (Claude only), and such an account can only land in the unmeasured tier.

## 3. Level-of-abstraction fit

The window classification is a pure helper (`windowAwareChoice.ts`) that every picker reads, so the pickers cannot drift. The decision authority stays where it was: the two spawn resolvers, the scheduler swap and the anti-thrash validity gate. The new code changes their inputs and does not add a parallel gate. The read trigger lives in the poller, which already owns every quota read, its gates and the device-limit bench. It reuses `pollOne`, so a landed out-of-cycle reading persists, restores and records history exactly like a scheduled one.

## 4. Signal vs authority compliance

- [x] No — this change has no new block/allow surface of its own.

Placement already holds the authority to choose an account; this changes which numbers it reads and the order it ranks, behind a dev-gated switch. The only new refusals are in the anti-thrash validity gate, which already refuses an unmeasured reading (bound 0); `rolled`/`unknown`/`unread` are more cases of the same rule, consistent with "an unmeasured reading never drives a proactive move". The shadow log is pure signal.

## 4b. Judgment-point check

The spec's `## Decision points touched` classifies every rule: the rolled / old-cycle / placeholder rules, the measured-before-unmeasured tier and the weekly-urgency pairing as invariants with an external-constraint or enumerable-domain basis. The 5-hour grace, the Fable binding, the score heuristic, the Codex-idle premise, the re-read gate limits, the blindness delay and the 30-day keep are judgment-candidates, each with a floor and the graduation review as arbiter. The 90% soft line, the 60-minute freshness and the 0.25-hour clamp are reused unchanged.

## 5. Interactions

- **Shadowing:** with the switch on, `selectAccount` returns before the old filter runs. The old rule is computed only for the shadow row, inside a try. `poolHeadroom` and `selectAccount` share `rankAccounts`, so `placeable ⟺ selectAccount !== null` holds for every model. A unit test checks this over 300 randomized pools × 3 model cases. `spawnAccount` keeps `isFresh` and stays outside that invariant, as today.
- **Double-fire:** `requestRead` can be called by every picker in the same instant. The gate dedupes per account (in-flight flag plus interval), and `pollOne` already coalesces Codex live reads per home. A successful out-of-cycle read also clears the gate state; a scheduled poll that lands clears it too.
- **Races:** the gate state is in-memory and per account. A read that lands after a scheduled poll for the same account simply writes a newer snapshot through the same `pool.update` path.
- **Feedback loops:** a read request is triggered by unmeasured windows and ends them. A failing read backs off and the breaker opens after 6 attempts, so there is no tight loop.
- **Replication:** the three new snapshot fields are stripped from the account-meta projection. Without that, a peer's strict validator would reject the whole projection; a test covers it.
- **Reviewer login:** `configureClaudeReviewerLogin` uses the resolver with `{ shadow: false }`, so a reviewer call writes no placement row.

## 6. External surfaces

- New bearer-only route `GET /quota-pacing/account-choice` (registered in CapabilityIndex; awareness entry added). A new per-machine file is written at `logs/placement-shadow.jsonl`. The spec named it `account-choice-shadow.jsonl`; it was renamed because the maturation ladder's evidence-file allowlist refuses any path containing "account". The file is self-trimmed to 30 days and holds pool ids and percentages, never emails or tokens.
- Provider calls: at most one extra quota read per account per poll interval, only for unmeasured windows, backing off on failure.
- Config: new optional key `subscriptionPool.pacing.windowAwareChoice` (omitted from defaults; dev-gated).
- No operator-facing actions — not applicable for Mobile-Complete. No messages are sent.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

- **Placement decisions:** machine-local by design. A pick selects a login whose credential home lives on this machine's disk, and each machine places only its own spawns.
- **Switch:** per machine (it governs only this machine's placement).
- **Shadow log:** proxied-on-read. `GET /quota-pacing/account-choice` (default pool scope) merges every machine's per-day summary through the shared bearer fan-out, names machines that did not answer, and pages any one machine's raw rows with `?machine=ID`.
- **Out-of-cycle read gate:** machine-local by design. Each machine reads only the accounts it polls; the breaker is in memory, so a restart closes it.
- No user-facing notices. Durable state is a telemetry log, not tied to a topic. No URLs are generated. No status surfaces change (the CapabilityIndex row only adds the endpoint).

## 8. Rollback cost

Set `subscriptionPool.pacing.windowAwareChoice: false` (per machine, read live, no restart) and every picker returns to today's code. A code revert is a normal patch. Leftover state: the shadow log file (inert), and three extra fields on locally stored snapshots, which today's readers ignore and the projection strips. There is no migration and no user-visible regression during rollback.

---

## Where the build differs from the spec

- Shadow log path is `logs/placement-shadow.jsonl` (the ladder evidence allowlist refuses paths containing "account").
- `resetsAtBeforeRewrite` is a top-level map, not a per-window field (the replicated projection validates window objects strictly); all three new fields are stripped from the projection.
- The fallback model is `frameworkDefaultModels[framework]` (the spec's `sessions.model ?? defaultModel` does not exist in code).
- Codex live reads also record `windowsListed`.
- The reviewer-login use of the resolver writes no shadow row.
- The ladder has `dev-agent-live` and `fleet` rungs; the test-agent rung stays a manual pre-merge check.
- **Codex idle premise unverified; Codex post-reset rewrites read as rolled until a live read shows a new window.** At the test-agent rung no idle Codex account was available (live reads at 00:53 PST showed every Codex account with a future reset), so the spec's fallback applies: every Codex `{0, ''}` rewrite is `rolled-history`, including from `codex-app-server`. Claude's null reset from the usage endpoint stays `idle-live`.

## Left behind

- Codex headless placement (`UsageWallRescue.codexSpawnAccount`) is unchanged: not in the spec's caller table; it keeps today's least-used rule over fresh accounts.
- Burst spreading, Fable awareness in swap paths, and mid-session `/model` changes (as in the spec).

---

## Conclusion

The review found no design change beyond what the 6-round spec convergence already settled. It made one deviation from the spec text, renaming the shadow file to fit the ladder's evidence allowlist, and it states the Codex-idle premise as unverified until the test-agent rung runs. The change is clear to ship behind the dev gate once the second-pass reviewer concurs and the live throwaway-agent test in the spec's maturation plan has been run.

---

## Second-pass review (if required)

**Reviewer:** independent second-pass reviewer (spawned by the parent session)
**Independent read of the artifact:** concern (round 1), addressed in the follow-up commit; awaiting the reviewer's re-check

Concur with the review
- Re-check (git diff 8a8d1ba84 c7723dd66): round-1 concern resolved. The throttle at server.ts:17252 now spreads `windowAwareThrottleOpts()` (empty when off, so today's rule), and `rereadBreaker` is reported (QuotaAwareScheduler.ts:269-274). The pinned oldPick uses the configured soft line. The race fix uses an identity guard (QuotaPoller.ts:1203,1213). Codex resets now always read rolled-history, which is conservative: idle Codex accounts stay in the unmeasured tier and get at most one extra live read per interval. Residual nit: the throttle provider reads `quotaPoller` (declared at :17719) lazily; a call before that line throws, and QuotaTracker.ts:204-213 catches it and falls back to the file-based throttle, so it fails safe.
- (1) Switch off: identical on every caller. selectAccount/poolHeadroom gate on `windowAware === true` (QuotaAwareScheduler.ts:137,201). The scheduler/codex spreads give `{}` (QuotaAwareScheduler.ts:362-371, server.ts:17803). readingValidity skips the new loop (SwapAntiThrash.ts:179). `oldPick` matches the old body byte for byte (UsageWallRescue.ts:693-695, server.ts:25185).
- (2) Placement: no rolled, unknown, stale or synthesized window gives a pct or a deadline (windowAwareChoice.ts:121-151), and the tier sort puts measured accounts first (:291). The only path that still counts a rolled window as room is the unwired throttle above.
- (3) Never-loop: proved by the unit test for the wired functions. In production the throttle is the OLD rule. Old eligibility is a subset of window-aware eligibility, so throttle placeable ⇒ selectAccount non-null still holds. The reverse does not hold (the throttle may shed while placement could succeed). That is conservative, not a loop.
- (4) Fable: the fallback (windowAwareChoice.ts:336-343) returns null only when the non-Fable eligibility is empty too. No Fable-only null.
- (5) Read gate (QuotaPoller.ts:1180-1213): deduped per account, backs off 1/2/4 intervals, breaker at 6, fire-and-forget, and the error is caught. Nit: a failure that lands after a scheduled poll has cleared the entry re-adds the old count (:1199). Bounded.
- (6) Replication: the 3 fields are stripped (SubscriptionAccountMetaReplicatedStore.ts:267-274). Peers on older versions are unaffected.
- (7) Shadow: the row is written after the pick, inside try blocks (windowAwarePlacement.ts:94-119). record() buffers, and the timer is unref'd. Nit: the pinned shadow `oldPick` uses soft 90, while the new rule uses swapSoftThresholdPct (server.ts:25185 vs 25191).
- Deviations: all 7 are acceptable. Notes: readingValidity does not refuse `unread-none` (SwapAntiThrash.ts:360-365; refusal-only, so today's behaviour). A Codex live read with no windows lists none, so both windows read not-offered (QuotaPoller.ts:898-903; today's treatment). Codex headless placement unchanged belongs in Left behind.

**Response (follow-up commit):** the throttle now passes the window-aware options behind the same live switch (`windowAwareThrottleOpts()`, built above the throttle wiring together with `windowAwareEnabled`/`windowAwareDeps`), and poolHeadroom reports `rereadBreaker: 'open'` for the best account. A source-wiring unit test and the e2e grep fail if the throttle call drops it; a behavioural test checks null/degraded/breaker. The pinned shadow `oldPick` now uses the configured `swapSoftThresholdPct`. A stale out-of-cycle failure can no longer restore a cleared count (identity guard on the gate entry, with a test). codexSpawnAccount is listed under Left behind.

---

## Evidence pointers

Targeted test runs during build (Node 24, test-runner-bound slots):
- tests/unit/window-aware-choice.test.ts — 26 passed
- tests/unit/quota-poller-window-basis.test.ts — 11 passed (incl. the stale-failure race)
- tests/unit/window-aware-placement.test.ts — 14 passed (incl. the throttle wiring and its behaviour)
- tests/unit/swap-antithrash-engine.test.ts (32, incl. the new window-aware blindness case), quota-aware-scheduler (20), usage-wall-rescue (59), swap-continuity-wiring (34), quota-tracker-pool-aware (20) — all passed
- tests/unit/quota-poller (37), interactive-session-pin (9), lint-dev-agent-dark-gate (31), claudeReviewerLogin (10), feature-ladders-coverage (7), awareness-entry-registry (45), devGatedFeatures-wiring (316), account-follow-me-locally-executable (9) — all passed
- `npx tsc --noEmit -p .` — clean
