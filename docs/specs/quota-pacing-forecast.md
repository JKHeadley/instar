---
title: "Quota pacing, step 1: reading history, provider runway and per-account forecast (read-only)"
slug: "quota-pacing-forecast"
author: "echo"
parent-principle: "Signal vs. Authority"
eli16-overview: "quota-pacing-forecast.eli16.md"
status: "converged"
approved: true
approved-by: "Echo under standing authority: Justin approves only constitution changes (Instar 1.x, 2026-10-22 08:58 PDT, memory only-constitution-changes-need-justin); this spec touches no constitution file. Request origin: Justin, topic 141385, 2026-11-17 10:19 PST."
parent-spec: "POOL-AWARE-QUOTA-THROTTLE-SPEC.md (pool headroom); queue-pace.md (the pure-arithmetic + ledger pattern this copies); codex-live-quota-read (Codex windows)"
lessons-engaged:
  - "P2 Signal vs Authority: the forecast is a measurement; nothing in this step reads it to decide"
  - "P19 No Unbounded Loops: compaction and the sweep are timer-driven, bounded and tier 0"
  - "P20 Verify the State, Not Its Symbol: every reading carries its source and age; synthesized, out-of-order, invalid and stale inputs surface as unknown"
  - "P21 Multi-machine: unified, proxied on read; logins merged by identity"
  - "P24 Never Silently Cut the Data: retention derived, every cut disclosed in coverage"
origin: "Justin, topic 141385, 2026-11-17 10:19 PST (token pacing controller) and 10:54 PST (pool-first: one account maxing early is fine, the provider's group must stay usable). Brainstorm: .instar/lanes/token-pacing-brainstorm/combined.md (doc 68f34063). Fable 5.2 and GPT-6 Astra both name this as the first slice."
review-convergence: "2026-11-17T22:07:53.681Z"
review-iterations: 3
review-completed-at: "2026-11-17T22:07:53.681Z"
review-report: "docs/specs/reports/quota-pacing-forecast-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 7
cheap-to-change-tags: 1
contested-then-cleared: 5
---

# Quota pacing, step 1: reading history and forecast

## Problem

Instar reacts to how full a subscription account is right now. Nothing looks ahead. No part of the system can answer:

- Where will this account be when its window resets?
- Will this provider's group of accounts (all Claude accounts, all Codex accounts) stay usable until the next reset arrives?

It cannot answer because there is no history. `QuotaPoller.burnRate()` uses only the last two readings, kept in memory (`prevByAccount`, `lastByAccount`). On 2026-11-17 the two readings were 34 seconds apart and the rate read 0. A restart loses both.

The cost is real. On 11-17 the headley Codex account had 57% of its week left 12 hours before reset, with no warning the day before. It was saved only because the operator noticed a screenshot.

## Goal

A read-only measurement, built from data the poller already reads:

1. A durable, bounded history of every quota reading, per account and per window.
2. A pure forecast function: per account, where each window lands at its reset (a range); per provider, a runway over the next 7 days and its lowest point.
3. One endpoint and one plain verdict per provider and per account.

## Non-goals (later steps, separate specs)

- Changing account choice for new sessions. The three account-choice bugs (window pairing in `scoreAccount`, the Fable window ignored by `bindingUtilization`, expired-window readings) are step 2.
- Spend by account in the usage ledger (step 3). Project priority (step 4).
- Any AI assessment, suggestion, card, or lever (steps 5 to 7).
- This step never sheds jobs, swaps sessions, changes models, holds work, or sends a message. Its output is a measurement only (Signal vs Authority).

## Design

### 1. Reading history: `QuotaHistoryLedger` (new, `src/monitoring/QuotaHistoryLedger.ts`)

- **Hook point:** `pollAccount()` becomes a thin public wrapper around a private `pollAccountInner()` that returns a typed result: `{ kind: "snapshot", snap }`, `{ kind: "failed", reason }` (authentication refused, needs reauth, network or HTTP error, busy credential write), or `{ kind: "not-a-read" }` (the read gate dropped it, or the identity check returned nothing). The wrapper records snapshots and failures and ignores `not-a-read`, then returns exactly what `pollAccount()` returns today. Every read passes through it: the scheduled pass and triggered checks (via `pollOne()`), the post-enrollment check route (`routes.ts`, `poller.pollAccount(account)`) and the relogin runtime's verification reads. The `signed-out` reason comes from the poller's existing `loginChecks` state. Three small additive poller changes ride along, none of which changes a value any existing reader uses: the snapshot carries `measuredAtSynthesized: true` when a Codex rollout reading had no captured time; it carries `fableUnknown: true` when the provider sent `percent: null` for the Fable window (the existing `Number(l.percent ?? 0)` stays as it is, so the poll result is unchanged, and the ledger stores `null`); and the typed result carries the attributed account id. The rest of the wrapper: and the ledger call is separately wrapped in try/catch and runs whether or not the pool's own `update()` succeeds. A ledger failure never changes a poll result (`@silent-fallback-ok`: history is observational; each failure is counted as `ledgerWriteFailures` and shown as reduced coverage).
- **Account id check:** `record()` and every read reject an id that fails the pool's `^[a-z0-9-]+$` rule, before any filesystem access. The resolved path must stay inside `.instar/state/quota-history/`. An attributed id that is not in the local pool is not recorded (counted as `unattributedReads`).
- **Storage:** append-only JSONL per account at `.instar/state/quota-history/<accountId>.jsonl`. One row per reading:
  `{ v: 1, polledAt, measuredAt, measuredAtSynthesized?, identity, source, drifted, windows: { fiveHour?, sevenDay?, fable? : { pct, resetsAt } }, noQuotaWindow? }`.
  `polledAt` is this machine's clock at the read and is used for ordering and freshness. `measuredAt` is the data's own time (for a Codex rollout snapshot, the rollout file's time). A `measuredAt` more than 5 minutes after `polledAt` is clamped to `polledAt` and counted. `drifted` is true when the poller flagged identity drift for that slot. `identity` is the login's identity key (§2) at the time of the read, or `null` when the pool has no provider-attested email for it. Rate segments and calibration are partitioned by `identity`: when a slot is rebound to a different login, its earlier rows are never mixed into the new login's forecast. No tokens, emails or content.
- **Window validity:** a window whose `resetsAt` is empty, unparseable, or not after `polledAt` (the Codex path writes `{ utilizationPct: 0, resetsAt: '' }` for a passed reset; a Claude read can carry a past reset with the old percentage) is stored with `pct: null` and marked invalid. A Fable reading flagged `fableUnknown` is likewise stored as `null`, not 0. Invalid windows never start a cycle, never enter a rate, and never read as 0% or as a fresh cycle.
- **Spacing (fixed buckets):** rows are kept in fixed 5-minute buckets keyed by `floor(polledAt / 5 min)`; a later reading in the same bucket replaces the earlier one only when both have the same `resetsAt` (within the reset tolerance, §2) and validity, otherwise it is appended, so the last reading before a reset is never overwritten. The newest row is held in memory and flushed when its bucket closes, when its window state changes, or on shutdown, so the file itself is append-only and a reading before a reset is written before the reset's own reading. One in-process writer per file serializes appends and compaction. Outcome rows follow the same rule. However often checks are triggered, the file grows by at most one row per 5 minutes per window state.
- **Retention, derived and disclosed:** the forecast reads the current cycle (up to 7 days) and calibration replays the previous one, so rows stay at full resolution for 14 days. After that they compact to one row per hour for another 7 days, so the previous cycle can be replayed for the calibration check. Beyond 21 days only one **cycle-end row** per window is kept (the last valid reading before each reset). That keeps every cycle's actual outcome; replaying a forecast needs the rows from the day before the reset, so calibration covers the last three cycles only. A hard cap of 5,000 rows per file is enforced on append and on load. It is derived, not arbitrary: one row per 5-minute bucket for 14 days is 4,032 rows; extra rows appear only when a window's state changes inside a bucket, which the five-hour window does about 5 times a day (about 70 rows over 14 days); plus 168 hourly rows and one cycle-end row per window per week. That is about 4,300 rows, so normal operation stays under 5,000; the cap only bites if something writes faster than the spacing rule allows. When it bites, the oldest rows go first, which is the direction that keeps the current cycle intact; the forecast then says "history cut short" and calibration for the affected cycle is reported as unavailable rather than computed from partial data. Lines over 4 KB (a valid row is about 250 bytes, so only a corrupt line can be that long) are skipped and counted as `malformedRows`. Compaction writes a temp file and renames it, and the rename, unlink and retire moves go through SafeFsExecutor. Compaction (hourly) and the retired-file sweep (daily) are a pure data transform (supervision tier 0) and run on an unref'd timer, never inside the poll call, and the first load and every rewrite are asynchronous. Once a day, files whose account is no longer in the local pool are moved to `quota-history/retired/`, kept there 35 days, and moved back if the same id is enrolled again. Nothing is cut silently: `coverage` reports, per account, `fullResolutionSince`, `hourlySince`, `cycleEndsKept`, `droppedRows` and `malformedRows`, and a forecast that relies on hourly rows says so.
- **Restart:** the file is read once into memory on first use, under the same caps.

**Multi-machine (the real topology).** On Echo every machine lists the same 14 account ids (follow-me accounts), so every machine polls every account and writes its own copy. The pool view therefore:

- reads each machine's computed summaries through the bearer-auth pool fan-out (§3), calling each peer's `GET /quota-pacing?scope=local`, which never fans out itself;
- validates every peer summary before use (used percentages finite in 0 to 100; forecasts finite and within -100 to 1,000, because they are uncapped projections; slopes finite and within ±100 points per hour; ids and statuses re-checked against `^[a-z0-9-]+$` and clamped in length, timestamps parseable, the fan-out's existing byte check on the whole body; at about 1 KB per login that cap holds well over a hundred logins, and an answer over it is refused whole as `too-large` in `sources`, never cut silently); a bad summary is dropped and counted under `malformedSummaries` with the machine id; a peer whose `polledAt` is more than 5 minutes ahead of this machine's clock is ignored for that login and counted as `clockAhead`;
- merges per login by identity (§2): it ranks summaries from machines where the slot is not drifted by freshness first (fresh beats stale), then by source (a live read beats a usage-file read; a synthesized `measuredAt` ranks last), then by newest `measuredAt`, and names the machine it chose; `polledAt` is used only for freshness. Clock skew between machines is tolerated up to the 5-minute clamp in §1. When two machines' summaries of the same kind (both live, or both from usage files) for the same login were measured within 15 minutes of each other and differ by more than 5 points of usage, the login shows "machines disagree" and is unknown, never averaged;
- lists a machine that does not answer under `couldNotRead`. Its accounts are still forecast from the other machines' readings when those exist.

### 2. Forecast: `quotaPacing.ts` (new, pure, `src/monitoring/quotaPacing.ts`)

Pure functions over history rows plus `now`. No I/O and no clock reads, so every boundary can be tested.

**Which windows are forecast.** The weekly window, and on Claude accounts the separate Fable weekly window. Each is forecast on its own and never mixed with another (mixing windows is the `scoreAccount` bug that step 2 fixes). The five-hour window is shown as its current reading and reset time only: the rates below need more than five hours of data, and the five-hour lockout is already handled by the existing brakes. Every output carries `basis: "weekly window only"`.

**Per window, per account:**

- **Ordering.** Eligibility is decided in arrival order (`polledAt`): a reading whose `measuredAt` is not later than the newest already-accepted `measuredAt` for that window and identity (an old usage-file reading arriving after a live one) is kept for audit, excluded from rates, and counted as `outOfOrderRows`. Accepted readings are then sorted by `measuredAt` for the slopes.
- **Age-unknown readings.** A Codex rollout reading with no captured time has `measuredAtSynthesized: true` (the poller now passes this through). Its age is unknown, so it never makes an account fresh and never enters a rate.
- **Reset tolerance.** Two `resetsAt` values within 5 minutes of each other count as the same reset. Real Codex values drift by 1 to 2 seconds between reads, so exact comparison would be wrong. The bucket rule, the cycle rule and the fixed-window check all use this one definition.
- **Cycle segmentation.** A new cycle starts when a valid row's `resetsAt` is later than the previous valid row's `resetsAt` by more than half the window length. An invalid window (§1) closes the current cycle with usage unknown until the next valid reading. A percentage drop of more than 2 points with no move in `resetsAt` (an early provider reset or a credit) starts a new rate segment, so it never counts as negative burn. Rates use only the current segment. **Fixed-window check:** this all assumes each weekly window is fixed (its `resetsAt` stays put within a cycle). If a window's `resetsAt` moves forward by more than the reset tolerance but less than half a window more than 3 times within one cycle, the window is marked `rolling-suspected` and that account's forecast is `cannot-tell` ("this provider's window doesn't behave like a fixed week"). The test-agent rung checks one real cycle of `resetsAt` readings for each provider before merge.
- **Straight-line caveat.** Placement drains the soonest-resetting account first, so a late-resetting account can look idle until the others fill up. The per-account forecast is a straight line from its own pace and says so; the runway (below) is where load moving between accounts is modelled.
- **Pace.** Least-squares slopes, in percentage points per hour, over the current segment: the last 6 hours (needs at least 3 rows over 2 hours), the last 24 hours (needs at least 3 rows over 12 hours) and the whole segment (needs at least 3 rows over 12 hours). Least squares copes with uneven spacing. A slope without enough data is `null`. Each slope reports the span it actually used.
- **Central forecast.** `used + pace × hoursLeft`, where `pace` is the 24-hour slope, else the whole-segment slope. When both are `null`, the forecast is `unknown`, never 0.
- **Range.** `low` and `high` project the slowest and fastest of the known slopes the same way. Projections are kept uncapped internally; displayed values are capped at 100. The page words the range as "between the slowest and fastest of the recent paces (last 6 hours, last 24 hours, this cycle so far)", naming which slope set each end. It describes recent pace, not capacity, so there is no "reachable maximum".
- **Freshness, with a reason.** An account is fresh only when its newest valid row was both read (`polledAt`) and measured (`measuredAt`, not synthesized) within 3 × its own read interval, so re-reading an old usage file never makes an account fresh. The interval is `pollIntervalMs` normally, or the backed-off interval when the poller has benched the account. Otherwise it is `stale` with a reason: `benched` (reads backed off), `signed-out` (the last read outcome was an authentication refusal), `read-failing` (the last read failed for another reason), `not-polled` (no read recorded), `identity-drifted` (the slot's reads are filed under another account), `file-only` (live reads failing, only an old usage file comes back). Failed reads are recorded as outcome rows with no percentages, so "signed out since 14:00" is visible. A rollout reading's age is never taken as proof the account was idle. Stale or missing never counts as 0% or 100%.

**Per provider (the runway), weekly window, plus a separate Fable runway for Claude:**

- **What it models, said plainly on the page:** weekly quota room only, assuming work can move between accounts that share a machine. It does not model five-hour lockouts or the 90% placement threshold, so it says "weekly room", never "stays usable".
- **Accounts are matched by identity, not by label.** The runway counts each login once, keyed by provider plus the first 16 hex characters of a SHA-256 of the lower-cased provider-attested email (`SubscriptionAccount.email`). The email itself is never stored or returned. One email is assumed to mean one subscription per provider (true for all 14 logins today); the key is computed from `normalizeSubscriptionEmail().key`, so every machine produces the same value. The 16-hex hash can be confirmed by guessing an email; that is acceptable because the route is owner-only and already shows account handles. A login with no attested email gets `identity: null`: it is forecast and shown on its own with "identity unknown", but its room is not added to the provider runway (it could be the same subscription as another slot), and the runway says how many such slots it left out. The account id is for display. A slot with identity drift is not merged. Two machines that hold the same login under different ids are counted once.
- **Placement limits.** Burn can move only between logins that share at least one machine where both are usable. On Echo every machine lists every account, so all of them share. A login no machine can place on is shown but adds no room.
- **Account size.** Accounts are summed as equal percentage points, and the page says "assumes equal-sized accounts". Plans differ (the plan lives only in each login's credentials, not in the pool record), so showing the plan is left to step 3.
- **Three scenarios, each consistent across supply and demand:**
  - *Central:* each account burns at its central pace; an account with unknown pace burns at the median known pace in the provider; an unknown or stale account keeps its last known room.
  - *Pessimistic:* each account burns at its `high` slope; unknown pace burns at the fastest known pace; an unknown or stale account has no room. The page notes that this overstates, because accounts' busy hours don't line up.
  - *Optimistic:* each account burns at its `low` slope; unknown pace burns at 0; an unknown or stale account keeps its last known room.
- **Walk forward** hour by hour for 168 hours (one weekly window). Each account's demand persists every hour. When an account reaches its limit, its demand moves to the account it shares a machine with that resets soonest and still has room, which is the drain order placement already uses. When no such account has room, that demand is **unserved** for the hour (it is never dropped) and resumes being served when an account in that placement group resets. At each account's reset hour its room returns to 100.
- **Output per scenario:** the lowest point (percentage points of room left, and when), and the first hour with unserved demand, naming the placement group and the accounts whose demand went unserved. When every account has unknown pace, demand can't be bounded and the provider is `cannot-tell`.
- Codex and Claude accounts are never pooled together (framework-safe, matching placement).

**Verdicts (fixed wording, plain language; first match wins).** The words lead with the pool, not one account ("9 of 14 Claude accounts have room").

- Provider runway: `cannot-tell` ("not enough readings to tell", with the reason) → `runs-dry` (the central scenario has unserved demand: "at the current pace, weekly room runs out {day} {time}; next reset {n} hours later") → `tight` (labelled provisional until at least one reset has been replayed for that provider; the pessimistic scenario has unserved demand or its lowest point is under 50 points, half of one account: "fine at the current pace, but could get tight on {day} {time} if the busiest recent pace kept up") → `sustainable` ("weekly room lasts all week, even at the fastest recent pace").
- Account (weekly and Fable): `unknown` (with reason) → `used-up` (at 100%: "at its limit until {reset}"; shown neutral while the provider is not `runs-dry`) → `will-hit-limit` (the central forecast reaches 100 before reset; neutral wording while the provider is `sustainable`: "will reach its limit around {time}; the pool has room") → `will-leave-unused` (central forecast under 85: "will leave about {100 − central}% unused at {reset}; could reach {high}% at the fastest of the recent paces") → `on-track`.
- The 85 and 50 lines are advisory display defaults, kept in one constants block and tunable without a schema change. The Codex "leave enough for background tasks" reserve is judged at pool level through the runway, not per account. Nothing reads these verdicts to decide anything in this step.

**Self-check of the forecast (calibration, reported, not a gate).** The forecast is pure, so it is replayed rather than stored. After each account reset, the forecast as it would have been 24 hours before the reset is recomputed from history, using only readings with `polledAt` at or before that moment (what was actually known then), and compared with the actual cycle-end reading. An outcome counts only when the last valid reading before the reset is within 3 × the account's read interval of it; otherwise that cycle's outcome is reported as `censored` (with how long before the reset the last reading was) and left out of the error and range statistics. Per account and in total: error of the central forecast, whether the actual fell inside the range, below `low` or above `high`, and the range width. Correctness of the arithmetic is the unit tests. Calibration says whether recent pace predicts use. It is evidence for the step 5 spec to weigh, not a pass mark set here. Each machine replays from its own history; the pool view shows the calibration from the same machine whose summary it chose for that login. Replaying the previous cycle's hour-by-hour profile instead of a straight line is noted as a candidate for step 5.

### 3. Surface

- `GET /quota-pacing` (bearer auth, owner-only; not added to `TEAM_ROUTE_TIERS` or any phone route). The default answer is pool scope: `{ schema: "quota-pacing/1", generatedAt, scope: "pool", providers: [{ provider, framework, verdict, plain, scenarios: { central, pessimistic, optimistic }, fableRunway?, accounts: [...] }], coverage: {...}, sources: [{ machineId, status, reason? }], calibration: {...} }`.
- `?scope=local` is what peers serve: this machine's computed per-login summaries only (identity key, display id, drifted flag, newest valid `measuredAt` and whether it was synthesized, this machine's calibration for that login, slot status (active, needs-reauth, disabled, at limit), read interval including any back-off, live-or-file source, current-segment used, the three slopes with their spans, central/low/high forecasts (uncapped projections, which may exceed 100; used percentages are validated to 0-100), reset times, `polledAt` of the newest valid row, freshness and reason). About 1 KB per login, so the answer stays small without any row cap: no raw rows cross machines. A local answer carries `scope: "local"`, and its provider verdict is `cannot-tell` ("only this machine's readings") whenever this agent has peers.
- **Pool fan-out:** the queue-pace fan-out in `queuePaceRoutes.ts` is extracted into one shared helper (`poolFanOut`) and used by both routes, so the limits are not re-invented: `poolPeerFetch`, the peer URL allowlist check, the existing peer count, batch size, per-peer timeout, overall deadline, whole-body byte check after reading and pool-build rate limit (counted per route), all unchanged from queue-pace. queue-pace's behaviour is unchanged, which its existing tests prove. Each machine gets a `sources` row with a status and reason (`off`, `unsupported`, `deadline`, `too-large`, `invalid-body`, `unreachable`, `omitted-cap`, `http-error`). It is not a signed mesh read; a signed read would be a new mesh verb, out of scope here.
- `?account=ID&history=1` (local scope only, never forwarded) adds this machine's rows for that account for the current and previous cycle, with `resolution` on each row. The id is validated (§1); an id not in the local pool, including a retired one, gets 404 with no file read.
- **Agent awareness:** one entry file, `src/data/awareness/quota-pacing.md`: "Will an account's quota expire unused, or will Claude or Codex run out of weekly room? Read `GET /quota-pacing`, never answer from memory. Lead with the pool ('9 of 14 accounts have room'), never one account's number. It is a forecast, not an instruction: don't hold, shed or add work because of it; the quota scheduler and placement keep their authority. A 503 means it isn't turned on for this agent." It reaches existing agents through the feature-notes rebuild, so no `migrateClaudeMd` step is needed.
- **CapabilityIndex:** an entry for the `/quota-pacing` prefix, next to queue-pace's.
- No dashboard tab in this step. The page is step 1b, after the numbers have been checked against real resets.

### 4. Switch, storage classification and rollout

- **Switch:** `subscriptionPool.pacing.enabled`, resolved through `resolveDevAgentGate()` (`explicit ?? !!developmentAgent`). The key is left out of config defaults, so a development agent without it is on and a fleet agent is off. No migration is needed: the key has never existed, so there is no shipped default to undo, and an explicit `false` an operator writes is respected. A test proves a development agent without the key resolves to on. Registered in `src/core/devGatedFeatures.ts` (with a justification like queue-pace's) and given a ladder in `src/data/feature-ladders.json` whose fleet-rung metrics read a durable tick log, `logs/quota-pacing.jsonl`: one row per hour per machine with `{ ts, machineId, accounts, withHistory, stale: { reason: count }, ledgerWriteFailures, malformedRows, droppedRows, verdicts: { verdict: count } }`, rotated like the other jsonl logs. When off: no ledger writes, no sweeps, and the route answers `503 quota-pacing-off`.
- **Turning it off:** writes and sweeps stop. Existing files stay where they are until the feature is turned on again (which resumes retention) or they are deleted by hand. No other behaviour depends on the switch.
- **Not synced, not backed up, by design:** `.instar/state/quota-history/` is added to the FileClassifier sync-exclusion list (they are merged live, so syncing them would only create conflicts). No `WriteDomainRegistry` entry is added: its direct-write list only admits hardware-bound files, these are not, and the registry's test only requires registered files to be sync-excluded, not the reverse. The FileClassifier exclusion is the whole mechanism, as for other merged-on-read telemetry. It is not in BackupManager's default includes: the history is derived telemetry, and after a restore the forecast reads `unknown` until it rebuilds.
- **Telemetry, not memory:** this is an operational telemetry store. Compacting and deleting old rows under the retention rule in §1 is allowed; it is never agent memory.

## Maturation plan

- **test-agent-live:** before merge, a throwaway test agent (one-machine route) boots the real server with seeded history, including a replay of the real headley Codex account (`codex-justin-gmail`) built from its Codex rollout `rate_limits` history evaluated at 2026-11-17 14:20Z, just after the last reading before the operator added work (the usage files record only when the account is used, so they hold nothing between 14:16Z and 21:15Z; a live poller reads every 15 minutes, so that gap does not occur in use). The route answers 200, and the forecast gives that account `will-leave-unused`: 24-hour slope about 0.24 %/h, central about 47% at reset, about 16 hours ahead. The same rung checks one real cycle of `resetsAt` readings per provider for the fixed-window assumption. The two-machine throwaway (Studio + M5 Pro) proves the pool fan-out, the identity merge and the `couldNotRead` path.
- **dev-agent-live:** on from merge on Echo's machines through the dev gate. Each forecast is compared with real resets as they happen.
- **fleet:** default-on for every agent is the last rung. It is read-only, so the risk is disk and CPU, not behaviour.
- **graduation criterion:** a review on the maturation board, filed at merge, reads the calibration replay after at least two resets per account, the coverage and stale reasons, disk use and any fault reported. It promotes on judgment from that evidence; nothing is promoted by a timer or a single number.
- **dark-window:** 3 weeks on Echo (two weekly resets for every account, plus slack for accounts that reset late in the week). Past that, the board raises it as dark too long.

## Safety and side effects

- **Authority:** none. Nothing reads the forecast to make a decision in this step. A later consumer needs its own spec with its own floor and arbiter.
- **Poll path:** one guarded call in `pollAccount()`. A thrown ledger error is caught and counted. A write is an append of about 250 bytes; compaction is an hourly atomic rewrite of at most about 1 MB. The poll result and timing are otherwise unchanged.
- **Disk:** hard cap of 5,000 rows per account, about 1 MB; about 17.5 MB for 14 accounts at the worst case, typically a third of that.
- **Privacy:** no tokens, emails or content. Account handles (which may name a person), identity hashes, machine ids and percentages, bearer-only.
- **Unknown is not zero:** every missing, stale, synthesized, out-of-order or malformed input surfaces as `unknown` or `cannot-tell` with a reason, never as an empty or full account.

## Tests (three tiers)

- **Unit, `quotaPacing.ts`:** arrival-order eligibility and out-of-order rows excluded; rows of a rebound slot partitioned by identity; rolling-suspected window gives cannot-tell while ±2-second reset jitter does not; identity-less slots excluded from runway supply; censored calibration outcomes; demand persists as unserved when a placement group is exhausted; merge picks newest measuredAt; synthesized-age rows never fresh; cycle detection across a reset, an invalid (`resetsAt: ''`) window and an early drop (no negative burn); slopes `null` below their spans; central, low and high projections, uncapped internally and capped on display; five-hour, weekly and Fable never mixed; the 11-17 replay gives `will-leave-unused`; a busy week gives `on-track`; runway with staggered resets; burn moving to the soonest-resetting shared account; each scenario's rules for unknown pace and unknown room; identity merge counts one login once and refuses drifted slots; Claude and Codex never pooled; both sides of every verdict line, including `runs-dry` when the central scenario runs out and `tight` when only the pessimistic one does; calibration replay.
- **Unit, `QuotaHistoryLedger`:** id validation and path containment; append; same-`measuredAt` skip; 5-minute buckets (sustained one-minute reads still add one row per bucket); future `measuredAt` clamp; invalid windows stored with `pct: null`; outcome rows for failed reads; compaction at 14 days to hourly and at 21 days to cycle-end rows; 5,000-row cap with `droppedRows`; 4 KB line skip; atomic rewrite; daily retire of removed ids; restart reload.
- **Wiring:** the `pollAccount()` wrapper records snapshots and failures but never `not-a-read`, and calls the ledger with the attributed id on every path (scheduled, triggered, manual refresh, relogin verification); a throwing ledger leaves the poll result unchanged; the dev-gate resolution.
- **Integration:** `GET /quota-pacing` over a seeded history returns the verdicts; `503` when off; `?scope=local` returns summaries only; pool fan-out with one peer down and one returning invalid summaries; two machines disagreeing gives unknown; `?account=` with a bad id gives 404 and no file read.
- **E2E (feature is alive):** the production init path in `server.ts` constructs the ledger and the route answers 200 (not 503) on a development agent with no config key.

## Measure of success

- **Correctness** is the unit tests: the arithmetic, the cycle handling and every verdict boundary.
- **Usefulness, on Echo within a week:** every enrolled account shows a forecast or a stated reason it can't, and the 11-17 replay shows the headley Codex account as `will-leave-unused` at least 24 hours before its reset.
- **Calibration** is reported after every reset. It is evidence for the graduation review and the step 5 spec to weigh, not a pass mark.

## Decision points touched

| Decision point | Classification | Basis |
|---|---|---|
| Verdict words and their order (all provider and account verdicts) | invariant; basis: enumerable-domain; evidence: a closed set of display labels over computed scenarios; nothing in this step reads them to block, allow or route | Signal only. A later consumer that acts on a verdict is a judgment-candidate with its own spec. |
| The 85 (account) and 50 (provider) display lines | judgment-candidate; floor: display only, they gate nothing and change no behaviour; arbiter: the graduation review, from how often each verdict fired and whether its wording held up against what happened at reset | Advisory defaults in one constants block, tunable without a schema change. |
| Cycle segmentation (reset time advancing by more than half the window; invalid window closes a cycle) | invariant; basis: external-constraint; evidence: the provider publishes `resetsAt` per window, and a forward jump is the provider's own statement that a new window began; the half-window rule tolerates the 1-2 second drift seen in real Codex `resets_at` values, where an exact-equality rule would split cycles; the fixed-window assumption is itself checked per window (`rolling-suspected` gives cannot-tell) and verified against one real cycle per provider at the test-agent rung | Arithmetic over provider data. |
| Fixed-window check ("more than 3" forward moves beyond the reset tolerance in one cycle); 5-minute reset tolerance; 5-minute future clamp; 4 KB line cap; 35-day retired-file keep | judgment-candidate; floor: each can only make an output `unknown`, drop a corrupt line with a count, or keep a file longer; arbiter: the graduation review | Starting values; none blocks, allows or routes anything. |
| Early-drop segment break (a usage drop of more than 2 points with no reset move) | judgment-candidate; floor: a break only shortens the segment, so slopes become `null` and the forecast `unknown` sooner; arbiter: the graduation review, from how often breaks fire and whether they coincide with real provider resets or credits | Readings are whole numbers from two sources, so a 1-point wobble is noise; 2 is a starting value, not a derived line. |
| Freshness cutoff (3 × the account's own read interval) and slope minimum spans (2 hours for 6h, 12 hours for 24h and segment) | judgment-candidate; floor: their only effect is `unknown` instead of a number, the conservative direction; arbiter: the graduation review, from stale-reason counts and calibration | Advisory defaults; each slope reports its actual span. |
| Retention (14 days full, 7 more hourly, cycle-end rows kept; 5,000-row cap; 5-minute buckets) | judgment-candidate; floor: every cut is disclosed in `coverage` and calibration for a cut cycle is reported unavailable, never computed from partial data; arbiter: the graduation review, from disk use and `droppedRows`; derivation: evidence: the forecast reads two weekly windows (14 days) at full resolution; calibration replays the previous cycle (hourly is enough for a 24-hours-before forecast); cycle-end rows keep every reset's actual outcome; the cap and spacing bound disk at about 1.25 MB per account; cuts are disclosed in `coverage` | Storage bound with disclosure, not a behavioural limit on the agent. |
| Walk-forward rules (168-hour horizon; burn moves to the soonest-resetting shared account; unknown pace and room per scenario) | judgment-candidate; floor: display only, every assumption stated on the page; arbiter: the graduation review, from calibration; evidence: 168 hours is one weekly window and the drain order mirrors existing placement (`scoreAccount` use-before-reset) | Modelling assumptions, disclosed, gating nothing. |
| Multi-machine merge (identity key; drifted and identity-less slots never merged; more than 5 points apart within 15 minutes of measurement = unknown) | judgment-candidate; floor: the merge can only produce a chosen summary or `unknown`, never invented room (one login is never counted twice and disagreeing readings are never averaged); arbiter: the graduation review, from how often "machines disagree" fires and on which logins | Read-only and display-only, so nothing irreversible follows from it. |

## Multi-machine posture

- **Reading history files:** unified, proxied on read. Each machine keeps the readings it took itself (they are its own observations, not shared state that could diverge), and every read of the forecast merges all machines through the pool fan-out, so no machine's readings are ever invisible to the agent. The files are excluded from git-sync because they are merged live, not because they belong to one machine.
- **`GET /quota-pacing`:** unified by default (pool scope, proxied on read over the existing bearer pool fan-out, merged per login by identity from each machine's summaries). A machine that does not answer is named in `sources`.
- **Config switch:** per machine, like every dev-gated switch.
- No notices are sent, so no one-voice gating is needed. No URLs are generated.

## Frontloaded Decisions

- Storage is JSONL per account, not SQLite: matches the file-based state rule and the queue-pace ledger.
- The pool fan-out is queue-pace's bearer fan-out, extracted into a shared helper with its limits unchanged, not a new signed mesh verb.
- Accounts are summed as equal percentage points, labelled as an assumption; showing plans and calibrating account size are step 3.
- The history is not synced and not backed up; it rebuilds after a restore.
- No dashboard page in this step (step 1b); the endpoint and the awareness entry are the surface.
- The `quota-pacing/1` schema and the verdict words are a published interface read by agents through the awareness entry. They are not cheap to change; a change bumps the schema.
- Dev-gated through `resolveDevAgentGate`, registered in `devGatedFeatures.ts` and `feature-ladders.json`; no config migration. Cheap-to-change-after: the switch is read-only telemetry that writes only its own excluded state folder.

## Open questions

*(none)*
