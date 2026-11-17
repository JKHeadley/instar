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

- **Hook point:** inside `QuotaPoller.pollAccount()`, just before it returns a snapshot, keyed by the attributed account id. Every read passes through there: the scheduled pass and triggered checks (via `pollOne()`), the post-enrollment check route (`routes.ts`, `poller.pollAccount(account)`), and the relogin runtime's verification reads. It records the raw window values before the poller's expired-window substitution, and the poller passes `measuredAtSynthesized` when a rollout reading had no captured time. The call is separately wrapped in try/catch and runs whether or not the pool's own `update()` succeeds. A ledger failure never changes a poll result (`@silent-fallback-ok`: history is observational; each failure is counted as `ledgerWriteFailures` and shown as reduced coverage).
- **Account id check:** `record()` and every read reject an id that fails the pool's `^[a-z0-9-]+$` rule, before any filesystem access. The resolved path must stay inside `.instar/state/quota-history/`. An attributed id that is not in the local pool is not recorded (counted as `unattributedReads`).
- **Storage:** append-only JSONL per account at `.instar/state/quota-history/<accountId>.jsonl`. One row per reading:
  `{ v: 1, polledAt, measuredAt, source, drifted, windows: { fiveHour?, sevenDay?, fable? : { pct, resetsAt } }, noQuotaWindow? }`.
  `polledAt` is this machine's clock at the read and is used for ordering and freshness. `measuredAt` is the data's own time (for a Codex rollout snapshot, the rollout file's time). A `measuredAt` more than 5 minutes after `polledAt` is clamped to `polledAt` and counted. `drifted` is true when the poller flagged identity drift for that slot. No tokens, emails or content.
- **Window validity:** a window whose `resetsAt` is empty, unparseable, or not after `polledAt` (the Codex path writes `{ utilizationPct: 0, resetsAt: '' }` for a passed reset; a Claude read can carry a past reset with the old percentage) is stored with `pct: null` and marked invalid. A Fable `percent: null` is likewise stored as `null`, not 0. Invalid windows never start a cycle, never enter a rate, and never read as 0% or as a fresh cycle.
- **Spacing:** a row with the same `measuredAt` as the previous one is skipped. A read less than 5 minutes after the previous row replaces that row instead of adding one. So the file grows at most one row per 5 minutes however many checks are triggered.
- **Retention, derived and disclosed:** the forecast reads the current cycle and the previous one (two weekly windows, 14 days), so rows stay at full resolution for 14 days. After that they compact to one row per hour for another 7 days, so the previous cycle can be replayed for the calibration check. Beyond 21 days only one **cycle-end row** per window is kept (the last valid reading before each reset), so the reset history stays available for calibration indefinitely at a few hundred bytes per cycle. A hard cap of 5,000 rows per file is enforced on append and on load; lines over 4 KB are skipped as malformed. Compaction writes a temp file and renames it. Once a day, files whose account is no longer in the local pool are moved to `quota-history/retired/`. Nothing is cut silently: `coverage` reports, per account, `fullResolutionSince`, `hourlySince`, `cycleEndsKept`, `droppedRows` and `malformedRows`, and a forecast that relies on hourly rows says so.
- **Restart:** the file is read once into memory on first use, under the same caps.

**Multi-machine (the real topology).** On Echo every machine lists the same 14 account ids (follow-me accounts), so every machine polls every account and writes its own copy. The pool view therefore:

- reads each machine's summaries and recent rows through the bearer-auth pool fan-out (§3), calling each peer's `GET /quota-pacing?scope=local`, which never fans out itself;
- validates every peer row before use (`pct` finite in 0 to 100, timestamps parseable, row cap per account, response size cap); bad rows are dropped and counted under `malformedRows` with the machine id;
- merges rows for one login by identity (§2), by `polledAt`, using only rows that are not `drifted`, and keeps the machine id on each merged point. When two machines disagree by more than 5 points within the same 15 minutes, the account shows "machines disagree" and is treated as unknown for that period, never averaged;
- lists a machine that does not answer under `couldNotRead`. Its accounts are still forecast from the other machines' readings when those exist.

### 2. Forecast: `quotaPacing.ts` (new, pure, `src/monitoring/quotaPacing.ts`)

Pure functions over history rows plus `now`. No I/O and no clock reads, so every boundary can be tested.

**Which windows are forecast.** The weekly window, and on Claude accounts the separate Fable weekly window. Each is forecast on its own and never mixed with another (mixing windows is the `scoreAccount` bug that step 2 fixes). The five-hour window is shown as its current reading and reset time only: the rates below need more than five hours of data, and the five-hour lockout is already handled by the existing brakes. Every output carries `basis: "weekly window only"`.

**Per window, per account:**

- **Ordering.** Rows are sorted by `measuredAt`. A row whose `measuredAt` is not later than the newest valid row for that window (an old rollout reading arriving after a live one) is kept for audit but excluded from rates, and counted as `outOfOrderRows`.
- **Age-unknown readings.** A Codex rollout reading with no captured time has `measuredAtSynthesized: true` (the poller now passes this through). Its age is unknown, so it never makes an account fresh and never enters a rate.
- **Cycle segmentation.** A new cycle starts when a valid row's `resetsAt` is later than the previous valid row's `resetsAt` by more than half the window length. An invalid window (§1) closes the current cycle with usage unknown until the next valid reading. A percentage drop of more than 2 points with no move in `resetsAt` (an early provider reset or a credit) starts a new rate segment, so it never counts as negative burn. Rates use only the current segment.
- **Pace.** Least-squares slopes, in percentage points per hour, over the current segment: the last 6 hours (needs at least 3 rows over 2 hours), the last 24 hours (needs at least 3 rows over 12 hours) and the whole segment (needs at least 3 rows over 12 hours). Least squares copes with uneven spacing. A slope without enough data is `null`. Each slope reports the span it actually used.
- **Central forecast.** `used + pace × hoursLeft`, where `pace` is the 24-hour slope, else the whole-segment slope. When both are `null`, the forecast is `unknown`, never 0.
- **Range.** `low` and `high` project the slowest and fastest of the known slopes the same way. Projections are kept uncapped internally; displayed values are capped at 100. The page words the range as "at the slowest and fastest pace of the last day". It describes recent pace, not capacity, so there is no "reachable maximum".
- **Freshness, with a reason.** Freshness uses `polledAt`. An account is fresh when its newest valid row is within 3 × its own read interval: `pollIntervalMs` normally, or the backed-off interval when the poller has benched the account. Otherwise it is `stale` with a reason: `benched` (reads backed off), `signed-out` (the last read outcome was an authentication refusal), `read-failing` (the last read failed for another reason), `not-polled` (no read recorded). Failed reads are recorded as outcome rows with no percentages, so "signed out since 14:00" is visible. A rollout reading's age is never taken as proof the account was idle. Stale or missing never counts as 0% or 100%.

**Per provider (the runway), weekly window, plus a separate Fable runway for Claude:**

- **What it models, said plainly on the page:** weekly quota room only, assuming work can move between accounts that share a machine. It does not model five-hour lockouts or the 90% placement threshold, so it says "weekly room", never "stays usable".
- **Accounts are matched by identity, not by label.** The runway counts each login once, keyed by provider plus a hash of the provider-attested email (`SubscriptionAccount.email`; the hash, never the email, is used and returned). The account id is for display. A slot with identity drift is not merged. Two machines that hold the same login under different ids are counted once.
- **Placement limits.** Burn can move only between logins that share at least one machine where both are usable. On Echo every machine lists every account, so all of them share. A login no machine can place on is shown but adds no room.
- **Account size.** Accounts are summed as equal percentage points. Each account's plan (Pro, Max 5x, Max 20x, Codex Pro and so on, when the pool knows it) is listed next to the "assumes equal-sized accounts" note.
- **Three scenarios, each consistent across supply and demand:**
  - *Central:* each account burns at its central pace; an account with unknown pace burns at the median known pace in the provider; an unknown or stale account keeps its last known room.
  - *Pessimistic:* each account burns at its `high` slope; unknown pace burns at the fastest known pace; an unknown or stale account has no room. The page notes that this overstates, because accounts' busy hours don't line up.
  - *Optimistic:* each account burns at its `low` slope; unknown pace burns at 0; an unknown or stale account keeps its last known room.
- **Walk forward** hour by hour for 168 hours (one weekly window). Each hour subtracts the total burn. When an account reaches its limit, its burn moves to the account it shares a machine with that resets soonest and still has room, which is the drain order placement already uses. At each account's reset hour its room returns to 100.
- **Output per scenario:** the lowest point (percentage points of room left, and when), and the first hour with no account left, if any. When every account has unknown pace, demand can't be bounded and the provider is `cannot-tell`.
- Codex and Claude accounts are never pooled together (framework-safe, matching placement).

**Verdicts (fixed wording, plain language; first match wins).** The words lead with the pool, not one account ("9 of 14 Claude accounts have room").

- Provider runway: `cannot-tell` ("not enough readings to tell", with the reason) → `runs-dry` (the central scenario runs out: "at the current pace, weekly room runs out {day} {time}; next reset {n} hours later") → `tight` (the pessimistic scenario runs out or its lowest point is under 50 points, half of one account: "fine at the current pace, but could get tight on {day} {time} if the busiest recent pace kept up") → `sustainable` ("weekly room lasts all week, even at the fastest recent pace").
- Account (weekly and Fable): `unknown` (with reason) → `used-up-as-planned` (at 100% while the provider is not `runs-dry`; neutral, "at its limit until {reset}") → `will-hit-limit` (the central forecast reaches 100 before reset; neutral wording while the provider is `sustainable`: "will reach its limit around {time}; the pool has room") → `will-leave-unused` (central forecast under 85: "will leave about {100 − central}% unused at {reset}; could reach {high}% at the fastest recent pace") → `on-track`.
- The 85 and 50 lines are advisory display defaults, kept in one constants block and tunable without a schema change. The Codex "leave enough for background tasks" reserve is judged at pool level through the runway, not per account. Nothing reads these verdicts to decide anything in this step.

**Self-check of the forecast (calibration, reported, not a gate).** The forecast is pure, so it is replayed rather than stored. After each account reset, the forecast as it would have been 24 hours before the reset is recomputed from history and compared with the actual cycle-end reading. Per account and in total: error of the central forecast, whether the actual fell inside the range, below `low` or above `high`, and the range width. Correctness of the arithmetic is the unit tests. Calibration says whether recent pace predicts use. It is evidence for the step 5 spec to weigh, not a pass mark set here.

### 3. Surface

- `GET /quota-pacing` (bearer auth, owner-only; not added to `TEAM_ROUTE_TIERS` or any phone route). The default answer is pool scope: `{ schema: "quota-pacing/1", generatedAt, scope: "pool", providers: [{ provider, framework, verdict, plain, scenarios: { central, pessimistic, optimistic }, fableRunway?, accounts: [...] }], coverage: {...}, sources: [{ machineId, status, reason? }], calibration: {...} }`.
- `?scope=local` is what peers serve: this machine's per-account summaries (current-segment used, slopes with spans, reset times, freshness and reason, identity hash), plus raw valid rows for the current and previous cycle, capped at 800 rows and 512 KB per answer. A local answer carries `scope: "local"`, and its provider verdict is `cannot-tell` ("only this machine's readings") whenever this agent has peers.
- **Pool fan-out:** copies the `queuePaceRoutes.ts` pattern. The peer URL allowlist is checked first; at most 16 peers, 4 at a time, a 10-second deadline, the byte cap above; one `sources` row per machine with a reason (`off`, `unsupported`, `deadline`, `too-large`, `invalid`); pool builds are rate-limited (429). This uses the bearer-auth pool fan-out (`poolPeerFetch`). It is not a signed mesh read; a signed read would be a new mesh verb, out of scope here.
- `?account=ID&history=1` adds one account's rows for the current and previous cycle, with `resolution` on each row. The id is validated (§1); an id not in the pool gets 404 with no file read.
- **Agent awareness:** one entry file, `src/data/awareness/quota-pacing.md`: "Will an account's quota expire unused, or will Claude or Codex run out of weekly room? Read `GET /quota-pacing`, never answer from memory. Lead with the pool ('9 of 14 accounts have room'), never one account's number. It is a forecast, not an instruction: don't hold, shed or add work because of it; the quota scheduler and placement keep their authority. A 503 means it isn't turned on for this agent." It reaches existing agents through the feature-notes rebuild, so no `migrateClaudeMd` step is needed.
- **CapabilityIndex:** an entry for the `/quota-pacing` prefix, next to queue-pace's.
- No dashboard tab in this step. The page is step 1b, after the numbers have been checked against real resets.

### 4. Switch, storage classification and rollout

- **Switch:** `subscriptionPool.pacing.enabled`, resolved through `resolveDevAgentGate()` (`explicit ?? !!developmentAgent`). The key is left out of config defaults. A migration in `migrateConfig()` removes a default-shaped `enabled: false` and keeps an explicit `true`, copying `migrateConfigExternalHogSentinelDevGate`. A test proves a development agent without the key resolves to on. When off: no ledger writes, no sweeps, and the route answers `503 quota-pacing-off`.
- **Turning it off:** writes and sweeps stop. Existing files stay where they are until the feature is turned on again (which resumes retention) or they are deleted by hand. No other behaviour depends on the switch.
- **Not synced, not backed up, by design:** `.instar/state/quota-history/` is added to the FileClassifier sync-exclusion list, and a `WriteDomainRegistry` entry declares it machine-local with the logical story "merged live by `GET /quota-pacing`" and the file-level arm `git-sync-excluded`. It is not in BackupManager's default includes: the history is derived telemetry, and after a restore the forecast reads `unknown` until it rebuilds.
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
- **Disk:** hard cap of 5,000 rows per account, about 1 MB; about 15 MB for 14 accounts at the worst case, typically a third of that.
- **Privacy:** no tokens, emails or content. Account handles (which may name a person), identity hashes, machine ids and percentages, bearer-only.
- **Unknown is not zero:** every missing, stale, synthesized, out-of-order or malformed input surfaces as `unknown` or `cannot-tell` with a reason, never as an empty or full account.

## Tests (three tiers)

- **Unit, `quotaPacing.ts`:** sorting and out-of-order rows excluded; synthesized-age rows never fresh; cycle detection across a reset, an invalid (`resetsAt: ''`) window and an early drop (no negative burn); slopes `null` below their spans; central, low and high projections, uncapped internally and capped on display; five-hour, weekly and Fable never mixed; the 11-17 replay gives `will-leave-unused`; a busy week gives `on-track`; runway with staggered resets; burn moving to the soonest-resetting shared account; each scenario's rules for unknown pace and unknown room; identity merge counts one login once and refuses drifted slots; Claude and Codex never pooled; both sides of every verdict line, including `runs-dry` when the central scenario runs out and `tight` when only the pessimistic one does; calibration replay.
- **Unit, `QuotaHistoryLedger`:** id validation and path containment; append; same-`measuredAt` skip; 5-minute replacement; future `measuredAt` clamp; invalid windows stored with `pct: null`; outcome rows for failed reads; compaction at 14 days to hourly and at 21 days to cycle-end rows; 5,000-row cap with `droppedRows`; 4 KB line skip; atomic rewrite; daily retire of removed ids; restart reload.
- **Wiring:** `pollAccount()` calls the ledger with the attributed id on every path (scheduled, triggered, manual refresh, relogin verification); a throwing ledger leaves the poll result unchanged; the dev-gate resolution.
- **Integration:** `GET /quota-pacing` over a seeded history returns the verdicts; `503` when off; `?scope=local` caps; pool fan-out with one peer down and one returning invalid rows; `?account=` with a bad id gives 404 and no file read.
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
| Cycle segmentation (reset time advancing by more than half the window; invalid window closes a cycle; a drop of more than 2 points with no reset move starts a segment) | invariant; basis: external-constraint; evidence: the provider publishes `resetsAt` per window, and a forward jump is the provider's own statement that a new window began; a usage drop without one can only be a provider-side reset or credit, because usage never decreases inside a window | Arithmetic over provider data. |
| Freshness cutoff (3 × the account's own read interval) and slope minimum spans (2 hours for 6h, 12 hours for 24h and segment) | judgment-candidate; floor: their only effect is `unknown` instead of a number, the conservative direction; arbiter: the graduation review, from stale-reason counts and calibration | Advisory defaults; each slope reports its actual span. |
| Retention (14 days full, 7 more hourly, cycle-end rows kept; 5,000-row cap; one row per 5 minutes) | invariant; basis: external-constraint; evidence: the forecast reads two weekly windows (14 days) at full resolution; calibration replays the previous cycle (hourly is enough for a 24-hours-before forecast); cycle-end rows keep every reset value; the cap and spacing bound disk at about 1 MB per account; cuts are disclosed in `coverage` | Storage bound with disclosure, not a behavioural limit on the agent. |
| Walk-forward rules (168-hour horizon; burn moves to the soonest-resetting shared account; unknown pace and room per scenario) | invariant; basis: enumerable-domain; evidence: 168 hours is one weekly window; the drain order mirrors existing placement (`scoreAccount` use-before-reset); each scenario's assumptions are stated on the page | Modelling assumptions, disclosed, gating nothing. |
| Multi-machine merge (identity hash; drifted slots excluded; more than 5 points apart within 15 minutes = unknown) | invariant; basis: irreversible-consequence; evidence: averaging two disagreeing logins or counting one login twice would report room that does not exist; refusing to merge only produces `unknown` | Conservative by construction. |

## Multi-machine posture

- **Reading history files:** machine-local, merged live on read. machine-local-justification: physical-credential-locality (each reading comes from a login whose credential lives in that machine's config home, and it is that machine's read of it; the files are excluded from git-sync and merged by `GET /quota-pacing`).
- **`GET /quota-pacing`:** unified by default (pool scope, proxied on read over the bearer pool fan-out, merged by identity). A machine that does not answer is named in `sources`.
- **Config switch:** per machine, like every dev-gated switch.
- No notices are sent, so no one-voice gating is needed. No URLs are generated.

## Frontloaded Decisions

- Storage is JSONL per account, not SQLite: matches the file-based state rule and the queue-pace ledger.
- The pool fan-out is the bearer pattern from `queuePaceRoutes.ts`, not a new signed mesh verb.
- Accounts are summed as equal percentage points, labelled as an assumption, with each plan shown; calibrating account size is step 3.
- The history is not synced and not backed up; it rebuilds after a restore.
- No dashboard page in this step (step 1b); the endpoint and the awareness entry are the surface.
- The `quota-pacing/1` schema and the verdict words are a published interface read by agents through the awareness entry. They are not cheap to change; a change bumps the schema.
- Dev-gated through `resolveDevAgentGate`. Cheap-to-change-after: the switch is read-only telemetry that writes only its own excluded state folder.

## Open questions

*(none)*
