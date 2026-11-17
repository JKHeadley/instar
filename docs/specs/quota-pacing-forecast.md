---
title: "Quota pacing, step 1: reading history, provider runway and per-account forecast (read-only)"
slug: "quota-pacing-forecast"
author: "echo"
parent-principle: "Structure > Willpower; Signal vs Authority (a forecast is a measurement, never a gate)"
eli16-overview: "quota-pacing-forecast.eli16.md"
status: "draft"
approved: false
parent-spec: "POOL-AWARE-QUOTA-THROTTLE-SPEC.md (pool headroom); queue-pace.md (the pure-arithmetic + ledger pattern this copies); codex-live-quota-read (Codex windows)"
origin: "Justin, topic 141385, 2026-11-17 10:19 PST (token pacing controller) and 10:54 PST (pool-first: one account maxing early is fine, the provider's group must stay usable). Brainstorm: .instar/lanes/token-pacing-brainstorm/combined.md (doc 68f34063). Fable 5.2 and GPT-6 Astra both name this as the first slice."
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

- **Hook point:** `pollAccount()` becomes a thin public wrapper around a private `pollAccountInner()` that returns a typed result: `{ kind: "snapshot", snap }`, `{ kind: "failed", reason }` (authentication refused, needs reauth, network or HTTP error, busy credential write), or `{ kind: "not-a-read" }` (the read gate dropped it, or the identity check returned nothing). The wrapper records snapshots and failures and ignores `not-a-read`, then returns exactly what `pollAccount()` returns today. Every read passes through it: the scheduled pass and triggered checks (via `pollOne()`), the post-enrollment check route (`routes.ts`, `poller.pollAccount(account)`) and the relogin runtime's verification reads. The `signed-out` reason comes from the poller's existing `loginChecks` state. Two small poller changes ride along: the snapshot carries `measuredAtSynthesized: true` when a Codex rollout reading had no captured time (the line that sets `measuredAt`), and the ledger call is separately wrapped in try/catch and runs whether or not the pool's own `update()` succeeds. A ledger failure never changes a poll result (`@silent-fallback-ok`: history is observational; each failure is counted as `ledgerWriteFailures` and shown as reduced coverage).
- **Account id check:** `record()` and every read reject an id that fails the pool's `^[a-z0-9-]+$` rule, before any filesystem access. The resolved path must stay inside `.instar/state/quota-history/`. An attributed id that is not in the local pool is not recorded (counted as `unattributedReads`).
- **Storage:** append-only JSONL per account at `.instar/state/quota-history/<accountId>.jsonl`. One row per reading:
  `{ v: 1, polledAt, measuredAt, measuredAtSynthesized?, identity, source, drifted, windows: { fiveHour?, sevenDay?, fable? : { pct, resetsAt } }, noQuotaWindow? }`.
  `polledAt` is this machine's clock at the read and is used for ordering and freshness. `measuredAt` is the data's own time (for a Codex rollout snapshot, the rollout file's time). A `measuredAt` more than 5 minutes after `polledAt` is clamped to `polledAt` and counted. `drifted` is true when the poller flagged identity drift for that slot. `identity` is the login's identity key (§2) at the time of the read, or `null` when the pool has no provider-attested email for it. Rate segments and calibration are partitioned by `identity`: when a slot is rebound to a different login, its earlier rows are never mixed into the new login's forecast. No tokens, emails or content.
- **Window validity:** a window whose `resetsAt` is empty, unparseable, or not after `polledAt` (the Codex path writes `{ utilizationPct: 0, resetsAt: '' }` for a passed reset; a Claude read can carry a past reset with the old percentage) is stored with `pct: null` and marked invalid. A Fable `percent: null` is likewise stored as `null`, not 0. Invalid windows never start a cycle, never enter a rate, and never read as 0% or as a fresh cycle.
- **Spacing (fixed buckets):** rows are kept in fixed 5-minute buckets keyed by `floor(polledAt / 5 min)`; a later reading in the same bucket replaces the earlier one only when both have the same `resetsAt` and validity, otherwise it is appended, so the last reading before a reset is never overwritten. The newest row is held in memory and flushed when its bucket closes (or on shutdown), so the file itself is append-only. Outcome rows follow the same rule. However often checks are triggered, the file grows by at most one row per 5 minutes per window state.
- **Retention, derived and disclosed:** the forecast reads the current cycle and the previous one (two weekly windows, 14 days), so rows stay at full resolution for 14 days. After that they compact to one row per hour for another 7 days, so the previous cycle can be replayed for the calibration check. Beyond 21 days only one **cycle-end row** per window is kept (the last valid reading before each reset). That keeps every cycle's actual outcome; replaying a forecast needs the rows from the day before the reset, so calibration covers the last three cycles only. A hard cap of 5,000 rows per file is enforced on append and on load. It is derived, not arbitrary: at most one row per 5 minutes for 14 days is 4,032 rows, plus 168 hourly rows, plus cycle-end rows (one a week), so normal operation stays under it; the cap only bites if something writes faster than the spacing rule allows. When it bites, the oldest rows go first, which is the direction that keeps the current cycle intact; the forecast then says "history cut short" and calibration for the affected cycle is reported as unavailable rather than computed from partial data. Lines over 4 KB are skipped as malformed. Compaction writes a temp file and renames it. Compaction and the daily sweep run on an unref'd timer, never inside the poll call, and the first load and every rewrite are asynchronous. Once a day, files whose account is no longer in the local pool are moved to `quota-history/retired/`. Nothing is cut silently: `coverage` reports, per account, `fullResolutionSince`, `hourlySince`, `cycleEndsKept`, `droppedRows` and `malformedRows`, and a forecast that relies on hourly rows says so.
- **Restart:** the file is read once into memory on first use, under the same caps.

**Multi-machine (the real topology).** On Echo every machine lists the same 14 account ids (follow-me accounts), so every machine polls every account and writes its own copy. The pool view therefore:

- reads each machine's computed summaries through the bearer-auth pool fan-out (§3), calling each peer's `GET /quota-pacing?scope=local`, which never fans out itself;
- validates every peer summary before use (percentages finite in 0 to 100, timestamps parseable, at most 64 logins per answer, the fan-out's byte cap read while streaming); a bad summary is dropped and counted under `malformedSummaries` with the machine id; a peer whose `polledAt` is more than 5 minutes ahead of this machine's clock is ignored for that login and counted as `clockAhead`;
- merges per login by identity (§2): it ranks summaries from machines where the slot is not drifted by data quality first (a live read beats a usage-file read; a synthesized `measuredAt` ranks last), then by newest `measuredAt`, and names the machine it chose; `polledAt` is used only for freshness. Clock skew between machines is tolerated up to the 5-minute clamp in §1. When two machines' summaries of the same kind (both live, or both from usage files) for the same login were measured within 15 minutes of each other and differ by more than 5 points of usage, the login shows "machines disagree" and is unknown, never averaged;
- lists a machine that does not answer under `couldNotRead`. Its accounts are still forecast from the other machines' readings when those exist.

### 2. Forecast: `quotaPacing.ts` (new, pure, `src/monitoring/quotaPacing.ts`)

Pure functions over history rows plus `now`. No I/O and no clock reads, so every boundary can be tested.

**Which windows are forecast.** The weekly window, and on Claude accounts the separate Fable weekly window. Each is forecast on its own and never mixed with another (mixing windows is the `scoreAccount` bug that step 2 fixes). The five-hour window is shown as its current reading and reset time only: the rates below need more than five hours of data, and the five-hour lockout is already handled by the existing brakes. Every output carries `basis: "weekly window only"`.

**Per window, per account:**

- **Ordering.** Eligibility is decided in arrival order (`polledAt`): a reading whose `measuredAt` is not later than the newest already-accepted `measuredAt` for that window and identity (an old usage-file reading arriving after a live one) is kept for audit, excluded from rates, and counted as `outOfOrderRows`. Accepted readings are then sorted by `measuredAt` for the slopes.
- **Age-unknown readings.** A Codex rollout reading with no captured time has `measuredAtSynthesized: true` (the poller now passes this through). Its age is unknown, so it never makes an account fresh and never enters a rate.
- **Cycle segmentation.** A new cycle starts when a valid row's `resetsAt` is later than the previous valid row's `resetsAt` by more than half the window length. An invalid window (§1) closes the current cycle with usage unknown until the next valid reading. A percentage drop of more than 2 points with no move in `resetsAt` (an early provider reset or a credit) starts a new rate segment, so it never counts as negative burn. Rates use only the current segment. **Fixed-window check:** this all assumes each weekly window is fixed (its `resetsAt` stays put within a cycle). If a window's `resetsAt` moves forward by less than half a window more than 3 times within one cycle, the window is marked `rolling-suspected` and that account's forecast is `cannot-tell` ("this provider's window doesn't behave like a fixed week"). The test-agent rung checks one real cycle of `resetsAt` readings for each provider before merge.
- **Pace.** Least-squares slopes, in percentage points per hour, over the current segment: the last 6 hours (needs at least 3 rows over 2 hours), the last 24 hours (needs at least 3 rows over 12 hours) and the whole segment (needs at least 3 rows over 12 hours). Least squares copes with uneven spacing. A slope without enough data is `null`. Each slope reports the span it actually used.
- **Central forecast.** `used + pace × hoursLeft`, where `pace` is the 24-hour slope, else the whole-segment slope. When both are `null`, the forecast is `unknown`, never 0.
- **Range.** `low` and `high` project the slowest and fastest of the known slopes the same way. Projections are kept uncapped internally; displayed values are capped at 100. The page words the range as "between the slowest and fastest of the recent paces (last 6 hours, last 24 hours, this cycle so far)", naming which slope set each end. It describes recent pace, not capacity, so there is no "reachable maximum".
- **Freshness, with a reason.** Freshness uses `polledAt`. An account is fresh when its newest valid row is within 3 × its own read interval: `pollIntervalMs` normally, or the backed-off interval when the poller has benched the account. Otherwise it is `stale` with a reason: `benched` (reads backed off), `signed-out` (the last read outcome was an authentication refusal), `read-failing` (the last read failed for another reason), `not-polled` (no read recorded). Failed reads are recorded as outcome rows with no percentages, so "signed out since 14:00" is visible. A rollout reading's age is never taken as proof the account was idle. Stale or missing never counts as 0% or 100%.

**Per provider (the runway), weekly window, plus a separate Fable runway for Claude:**

- **What it models, said plainly on the page:** weekly quota room only, assuming work can move between accounts that share a machine. It does not model five-hour lockouts or the 90% placement threshold, so it says "weekly room", never "stays usable".
- **Accounts are matched by identity, not by label.** The runway counts each login once, keyed by provider plus the first 16 hex characters of a SHA-256 of the lower-cased provider-attested email (`SubscriptionAccount.email`). The email itself is never stored or returned. A login with no attested email gets `identity: null`: it is forecast on its own, never merged with another, and shown with "identity unknown". The account id is for display. A slot with identity drift is not merged. Two machines that hold the same login under different ids are counted once.
- **Placement limits.** Burn can move only between logins that share at least one machine where both are usable. On Echo every machine lists every account, so all of them share. A login no machine can place on is shown but adds no room.
- **Account size.** Accounts are summed as equal percentage points. Each account's plan (Pro, Max 5x, Max 20x, Codex Pro and so on, when the pool knows it) is listed next to the "assumes equal-sized accounts" note.
- **Three scenarios, each consistent across supply and demand:**
  - *Central:* each account burns at its central pace; an account with unknown pace burns at the median known pace in the provider; an unknown or stale account keeps its last known room.
  - *Pessimistic:* each account burns at its `high` slope; unknown pace burns at the fastest known pace; an unknown or stale account has no room. The page notes that this overstates, because accounts' busy hours don't line up.
  - *Optimistic:* each account burns at its `low` slope; unknown pace burns at 0; an unknown or stale account keeps its last known room.
- **Walk forward** hour by hour for 168 hours (one weekly window). Each account's demand persists every hour. When an account reaches its limit, its demand moves to the account it shares a machine with that resets soonest and still has room, which is the drain order placement already uses. When no such account has room, that demand is **unserved** for the hour (it is never dropped) and resumes being served when an account in that placement group resets. At each account's reset hour its room returns to 100.
- **Output per scenario:** the lowest point (percentage points of room left, and when), and the first hour with unserved demand, naming the placement group and the accounts whose demand went unserved. When every account has unknown pace, demand can't be bounded and the provider is `cannot-tell`.
- Codex and Claude accounts are never pooled together (framework-safe, matching placement).

**Verdicts (fixed wording, plain language; first match wins).** The words lead with the pool, not one account ("9 of 14 Claude accounts have room").

- Provider runway: `cannot-tell` ("not enough readings to tell", with the reason) → `runs-dry` (the central scenario has unserved demand: "at the current pace, weekly room runs out {day} {time}; next reset {n} hours later") → `tight` (provisional until calibration has run, and labelled so; the pessimistic scenario has unserved demand or its lowest point is under 50 points, half of one account: "fine at the current pace, but could get tight on {day} {time} if the busiest recent pace kept up") → `sustainable` ("weekly room lasts all week, even at the fastest recent pace").
- Account (weekly and Fable): `unknown` (with reason) → `used-up` (at 100%: "at its limit until {reset}"; shown neutral while the provider is not `runs-dry`) → `will-hit-limit` (the central forecast reaches 100 before reset; neutral wording while the provider is `sustainable`: "will reach its limit around {time}; the pool has room") → `will-leave-unused` (central forecast under 85: "will leave about {100 − central}% unused at {reset}; could reach {high}% at the fastest of the recent paces") → `on-track`.
- The 85 and 50 lines are advisory display defaults, kept in one constants block and tunable without a schema change. The Codex "leave enough for background tasks" reserve is judged at pool level through the runway, not per account. Nothing reads these verdicts to decide anything in this step.

**Self-check of the forecast (calibration, reported, not a gate).** The forecast is pure, so it is replayed rather than stored. After each account reset, the forecast as it would have been 24 hours before the reset is recomputed from history, using only readings with `polledAt` at or before that moment (what was actually known then), and compared with the actual cycle-end reading. Per account and in total: error of the central forecast, whether the actual fell inside the range, below `low` or above `high`, and the range width. Correctness of the arithmetic is the unit tests. Calibration says whether recent pace predicts use. It is evidence for the step 5 spec to weigh, not a pass mark set here. Each machine replays from its own history; the pool view shows the calibration from the same machine whose summary it chose for that login. Replaying the previous cycle's hour-by-hour profile instead of a straight line is noted as a candidate for step 5.

### 3. Surface

- `GET /quota-pacing` (bearer auth, owner-only; not added to `TEAM_ROUTE_TIERS` or any phone route). The default answer is pool scope: `{ schema: "quota-pacing/1", generatedAt, scope: "pool", providers: [{ provider, framework, verdict, plain, scenarios: { central, pessimistic, optimistic }, fableRunway?, accounts: [...] }], coverage: {...}, sources: [{ machineId, status, reason? }], calibration: {...} }`.
- `?scope=local` is what peers serve: this machine's computed per-login summaries only (identity key, display id, drifted flag, slot status (active, needs-reauth, disabled, at limit), read interval including any back-off, live-or-file source, current-segment used, the three slopes with their spans, central/low/high forecasts, reset times, `polledAt` of the newest valid row, freshness and reason). About 1 KB per login, so the answer stays small without any row cap: no raw rows cross machines. A local answer carries `scope: "local"`, and its provider verdict is `cannot-tell` ("only this machine's readings") whenever this agent has peers.
- **Pool fan-out:** the queue-pace fan-out in `queuePaceRoutes.ts` is extracted into one shared helper (`poolFanOut`) and used by both routes, so the limits are not re-invented: `poolPeerFetch`, the peer URL allowlist check, the existing peer count, batch size, per-peer timeout, overall deadline and pool-build rate limit, all unchanged from queue-pace. queue-pace's behaviour is unchanged, which its existing tests prove. Each machine gets a `sources` row with a status and reason (`off`, `unsupported`, `deadline`, `too-large`, `invalid-body`, `unreachable`, `omitted-cap`). It is not a signed mesh read; a signed read would be a new mesh verb, out of scope here.
- `?account=ID&history=1` (local scope only, never forwarded) adds this machine's rows for that account for the current and previous cycle, with `resolution` on each row. The id is validated (§1); an id not in the local pool, including a retired one, gets 404 with no file read.
- **Agent awareness:** one entry file, `src/data/awareness/quota-pacing.md`: "Will an account's quota expire unused, or will Claude or Codex run out of weekly room? Read `GET /quota-pacing`, never answer from memory. Lead with the pool ('9 of 14 accounts have room'), never one account's number. It is a forecast, not an instruction: don't hold, shed or add work because of it; the quota scheduler and placement keep their authority. A 503 means it isn't turned on for this agent." It reaches existing agents through the feature-notes rebuild, so no `migrateClaudeMd` step is needed.
- **CapabilityIndex:** an entry for the `/quota-pacing` prefix, next to queue-pace's.
- No dashboard tab in this step. The page is step 1b, after the numbers have been checked against real resets.

### 4. Switch, storage classification and rollout

- **Switch:** `subscriptionPool.pacing.enabled`, resolved through `resolveDevAgentGate()` (`explicit ?? !!developmentAgent`). The key is left out of config defaults, so a development agent without it is on and a fleet agent is off. No migration is needed: the key has never existed, so there is no shipped default to undo, and an explicit `false` an operator writes is respected. A test proves a development agent without the key resolves to on. Registered in `src/core/devGatedFeatures.ts` (with a justification like queue-pace's) and given a ladder in `src/data/feature-ladders.json` whose fleet-rung metrics read the ledger's coverage, `ledgerWriteFailures` and stale-reason counts. When off: no ledger writes, no sweeps, and the route answers `503 quota-pacing-off`.
- **Turning it off:** writes and sweeps stop. Existing files stay where they are until the feature is turned on again (which resumes retention) or they are deleted by hand. No other behaviour depends on the switch.
- **Not synced, not backed up, by design:** `.instar/state/quota-history/` is added to the FileClassifier sync-exclusion list (the file-level arm). The route is registered in `WriteDomainRegistry` with the logical story `pool-scope-read-merge`. It is not in BackupManager's default includes: the history is derived telemetry, and after a restore the forecast reads `unknown` until it rebuilds.
- **Telemetry, not memory:** this is an operational telemetry store. Compacting and deleting old rows under the retention rule in §1 is allowed; it is never agent memory.

## Maturation plan

- **test-agent-live:** before merge, a throwaway test agent (one-machine route) boots the real server with seeded history, including a replay of the real 11-17 headley Codex readings, and the route answers 200 with that account as `will-leave-unused`. The two-machine throwaway (Studio + M5 Pro) proves the pool fan-out, the identity merge and the `couldNotRead` path.
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

- **Unit, `quotaPacing.ts`:** arrival-order eligibility and out-of-order rows excluded; rows of a rebound slot partitioned by identity; rolling-suspected window gives cannot-tell; demand persists as unserved when a placement group is exhausted; merge picks newest measuredAt; synthesized-age rows never fresh; cycle detection across a reset, an invalid (`resetsAt: ''`) window and an early drop (no negative burn); slopes `null` below their spans; central, low and high projections, uncapped internally and capped on display; five-hour, weekly and Fable never mixed; the 11-17 replay gives `will-leave-unused`; a busy week gives `on-track`; runway with staggered resets; burn moving to the soonest-resetting shared account; each scenario's rules for unknown pace and unknown room; identity merge counts one login once and refuses drifted slots; Claude and Codex never pooled; both sides of every verdict line, including `runs-dry` when the central scenario runs out and `tight` when only the pessimistic one does; calibration replay.
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
| The 85 (account) and 50 (provider) display lines | judgment-candidate; floor: display only, they gate nothing and change no behaviour; arbiter: the graduation review tunes them from calibration evidence | Advisory defaults in one constants block, tunable without a schema change. |
| Cycle segmentation (reset time advancing by more than half the window; invalid window closes a cycle; a drop of more than 2 points with no reset move starts a segment) | invariant; basis: external-constraint; evidence: the provider publishes `resetsAt` per window, and a forward jump is the provider's own statement that a new window began; for a fixed window usage cannot decrease inside it, so a drop can only be a provider-side reset or credit; the fixed-window assumption is itself checked per window (`rolling-suspected` gives cannot-tell) and verified against one real cycle per provider at the test-agent rung | Arithmetic over provider data. |
| Freshness cutoff (3 × the account's own read interval) and slope minimum spans (2 hours for 6h, 12 hours for 24h and segment) | judgment-candidate; floor: their only effect is `unknown` instead of a number, the conservative direction; arbiter: the graduation review, from stale-reason counts and calibration | Advisory defaults; each slope reports its actual span. |
| Retention (14 days full, 7 more hourly, cycle-end rows kept; 5,000-row cap; 5-minute buckets) | invariant; basis: external-constraint; evidence: the forecast reads two weekly windows (14 days) at full resolution; calibration replays the previous cycle (hourly is enough for a 24-hours-before forecast); cycle-end rows keep every reset's actual outcome; the cap and spacing bound disk at about 1.25 MB per account; cuts are disclosed in `coverage` | Storage bound with disclosure, not a behavioural limit on the agent. |
| Walk-forward rules (168-hour horizon; burn moves to the soonest-resetting shared account; unknown pace and room per scenario) | invariant; basis: enumerable-domain; evidence: 168 hours is one weekly window; the drain order mirrors existing placement (`scoreAccount` use-before-reset); each scenario's assumptions are stated on the page | Modelling assumptions, disclosed, gating nothing. |
| Multi-machine merge (identity key; drifted and identity-less slots never merged; more than 5 points apart within 15 minutes of measurement = unknown) | invariant; basis: irreversible-consequence; evidence: averaging two disagreeing logins or counting one login twice would report room that does not exist; refusing to merge only produces `unknown` | Conservative by construction. |

## Multi-machine posture

- **Reading history files:** machine-local, merged live on read.
- machine-local-justification: physical-credential-locality
  Each reading comes from a login whose credential lives in that machine's config home, and it is that machine's read of it. The files are excluded from git-sync and merged by `GET /quota-pacing`.
- **`GET /quota-pacing`:** unified by default (pool scope, proxied on read over the existing bearer pool fan-out, merged per login by identity from each machine's summaries). A machine that does not answer is named in `sources`.
- **Config switch:** per machine, like every dev-gated switch.
- No notices are sent, so no one-voice gating is needed. No URLs are generated.

## Frontloaded Decisions

- Storage is JSONL per account, not SQLite: matches the file-based state rule and the queue-pace ledger.
- The pool fan-out is queue-pace's bearer fan-out, extracted into a shared helper with its limits unchanged, not a new signed mesh verb.
- Accounts are summed as equal percentage points, labelled as an assumption, with each plan shown; calibrating account size is step 3.
- The history is not synced and not backed up; it rebuilds after a restore.
- No dashboard page in this step (step 1b); the endpoint and the awareness entry are the surface.
- The `quota-pacing/1` schema and the verdict words are a published interface read by agents through the awareness entry. They are not cheap to change; a change bumps the schema.
- Dev-gated through `resolveDevAgentGate`, registered in `devGatedFeatures.ts` and `feature-ladders.json`; no config migration. Cheap-to-change-after: the switch is read-only telemetry that writes only its own excluded state folder.

## Open questions

*(none)*
