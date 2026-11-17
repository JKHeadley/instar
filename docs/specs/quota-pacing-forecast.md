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

- **Hook point:** `QuotaPoller.pollOne()`, right after `this.pool.update(...)`. That is the one place every scheduled and triggered read already passes through. It calls `ledger.record(attributedId, account.provider, account.framework, snap)`. The call is wrapped so a ledger failure never affects polling (`@silent-fallback-ok`: history is observational; the failure is counted and shown as reduced coverage).
- **Storage:** append-only JSONL per machine at `.instar/state/quota-history/<accountId>.jsonl`. One row per reading:
  `{ v: 1, at, source, windows: { fiveHour?, sevenDay?, fable? : { pct, resetsAt } }, noQuotaWindow? }`. No tokens, emails or secrets: the account id is already a charset-clamped handle.
- **Dedupe and spacing:** `at` is the snapshot's own `measuredAt`. A row with the same `at` as the previous one is skipped. A triggered read less than 5 minutes after the previous row replaces that row instead of adding one, so triggered reads cannot grow the file faster than one row per 5 minutes. A Codex rollout-file snapshot is recorded with `source: codex-rollout`.
- **Retention, with disclosure:** rows older than 14 days compact to one row per hour (the last in the hour); hourly rows are kept 35 days (five weekly cycles: two full cycles feed the pace and the calibration, the rest is margin). A hard cap of 5,000 rows per account file is enforced on append and on load; when it bites, the oldest rows go first and the count is kept as `droppedRows`. Compaction and drops are never silent: `coverage` reports, per account, the oldest full-resolution row, the oldest hourly row, and `droppedRows`, and a forecast whose cycle reaches back past full-resolution data says "uses hourly readings". Upper bound: 5,000 rows of about 200 bytes, about 1 MB per account.
- **Restart:** on first `record()` or read for an account, the file is read once into memory, applying the same 5,000-row cap. A malformed line is skipped and counted (`malformedRows`), never fatal.
- **Multi-machine:** each machine records the accounts it polls. Accounts are machine-local logins (`configHome`), so there is no double counting inside one machine. Pool-scope reads (`?scope=pool`) ask each machine over the existing signed pool read and merge by account id. The same account id seen from two machines (a follow-me account) is taken from the freshest reading at each time. A machine that does not answer is listed under `couldNotRead`, never treated as an empty account.

### 2. Forecast: `quotaPacing.ts` (new, pure, `src/monitoring/quotaPacing.ts`)

Pure functions over history rows plus `now`. No I/O and no clock reads, so every boundary can be tested.

**Which windows are forecast.** The weekly window, and on Claude accounts the separate Fable weekly window. Each is forecast on its own and never mixed with another (mixing windows is the `scoreAccount` bug that step 2 fixes). The five-hour window is shown as its current reading and reset time only, with no forecast: it is too short for the rates below, and its purpose (a short lockout) is already served by the existing brakes.

**Per window, per account:**

- **Cycle segmentation.** A reading whose `resetsAt` is later than the previous row's `resetsAt` by more than half the window length starts a new cycle. A percentage drop alone never counts as negative burn. Rates use only the current cycle's rows.
- **Pace.** Three least-squares slopes, in percentage points per hour, over the current cycle's rows: the last 6 hours, the last 24 hours, and the whole cycle so far. Least squares copes with uneven spacing (triggered reads between scheduled ones). A slope needs at least 3 rows spanning at least 2 hours; otherwise it is `null`. When all three are `null`, the account's pace is `unknown`, never 0.
- **Forecast at reset (range).** `low` uses the slowest of the known slopes, `high` the fastest, each projected linearly to the reset: `used + slope × hoursLeft`. The projections are kept uncapped internally. The displayed value is capped at 100, and the hour at which `high` reaches 100 is kept as `hitsLimitAt` when that is before the reset.
- **No "reachable maximum" figure.** The range is the whole statement. It describes recent pace, not capacity, and the page says so: "at the slowest and fastest pace of the last week".
- **Freshness.** Uses each row's `at`, which is the snapshot's own `measuredAt`. A Codex rollout-file snapshot keeps the `measuredAt` the poller gave it and is marked `source: codex-rollout`; its freshness is judged on the same field, and the account shows "read from a usage file, not a live check". The newest row older than 3 poll intervals (default 45 minutes) makes the account `stale`. Stale or missing never counts as 0% or 100%.

**Per provider (the runway), weekly window, plus a separate Fable runway for Claude:**

- **What it models, said plainly on the page:** weekly quota room only, assuming work can move between the accounts that the same machine can use. It does not model five-hour lockouts or the 90% placement threshold, so its wording is "weekly room" ("weekly room stays above zero all week"), never "stays usable".
- **Per machine first.** Logins are machine-local, so work cannot move from one machine's accounts to another's unless an account is a follow-me account on both. The runway is computed per machine over the accounts that machine can place on. The pool view (`?scope=pool`) lists each machine's runway side by side and does not sum across machines.
- **Two scenarios, each consistent across supply and demand.**
  - *Pessimistic:* each account burns at its `high` slope; an account with unknown pace burns at the fastest known slope on that machine; an unknown or stale account has no room.
  - *Optimistic:* each account burns at its `low` slope; an account with unknown pace burns at 0; an unknown or stale account has its last known room.
  - When every account on the machine has unknown pace, demand can't be bounded and the verdict is `cannot-tell`. When more than half of the machine's accounts are unknown or stale, it is also `cannot-tell`.
- **Walk forward** hour by hour for 168 hours. Each hour subtracts the total burn. When an account reaches its limit, its burn moves to the account on the same machine that resets soonest and still has room. That is the drain order placement already uses (use-before-reset). At each account's reset hour its room returns to 100.
- **Output per scenario:** the lowest point (percentage points of room left, and when), and the first hour with no account left, if any.
- Codex and Claude accounts are never pooled together (framework-safe, matching placement).

**Verdicts (fixed wording, plain language; first match wins):**

- Machine runway: `cannot-tell` ("not enough readings to tell", with the reason) → `runs-dry` (the pessimistic scenario reaches zero room: "could run out {day} {time} at the fastest recent pace; next reset {n} hours later") → `tight` (the pessimistic lowest point is under 50 points, half of one account: "tight on {day} {time}, about {n}% of one account left") → `sustainable` ("weekly room stays above zero all week, even at the fastest recent pace").
- Account (weekly and Fable): `unknown` (with reason) → `will-hit-limit` (`hitsLimitAt` is set: "could hit its limit around {time}, {n} hours before reset") → `used-up-as-planned` (at 100% while its machine runway is `sustainable`, shown neutral, not red) → `will-leave-unused` (`high` under 85: "will leave at least {100 − high}% unused at {reset}") → `on-track`.
- These bands are display labels. Nothing reads them to decide anything in this step.

**Self-check of the forecast (calibration, reported, not a gate).** After each account reset, the forecast made 24 hours before the reset is compared with the actual reset value and stored: absolute error of the midpoint, whether the actual fell inside the range, below `low`, or above `high`, and the range width. `GET /quota-pacing` reports these per account and in total. Arithmetic correctness is proven by the unit tests. Calibration is evidence about whether past pace predicts future use, and it is the input the step 5 spec judges, not a pass/fail line here.

### 3. Surface

- `GET /quota-pacing` (bearer auth). Answers `{ schema: "quota-pacing/1", generatedAt, providers: [{ provider, framework, verdict, plain, runway: { lowLine, highLine, lowestPoint, runsDryAt? }, fableRunway?, accounts: [...] }], coverage: { accounts, withHistory, stale, malformedRows, ledgerWriteFailures }, couldNotRead? }`.
- `?scope=pool` merges each machine's history as described in §1.
- `?account=ID&history=1` adds the raw rows for one account (bounded to the current and previous cycle).
- No dashboard tab in this step. The page itself is step 1b, after the numbers have been checked against real resets.
- Agent awareness: one entry file, `src/data/awareness/quota-pacing.md` (per `src/data/awareness/README.md`): "Will an account's quota expire unused, or will Claude or Codex run out this week? Read `GET /quota-pacing`, never answer from memory." It reaches existing agents through the feature-notes rebuild on update, so no `migrateClaudeMd` step is needed.

### 4. Switch and rollout (maturation path)

- Config `subscriptionPool.pacing.enabled`. When off: no ledger writes, and the route answers `503 quota-pacing-off`. Default is the dev gate: on for a development agent, off on the fleet.
- **Rung 1, test agent:** before merge, a throwaway test agent with seeded history (including a replay of the real 11-17 readings) proves the route answers 200 with the expected verdicts, through the real server boot.
- **Rung 2, development agent (Echo):** live on Echo's machines from merge. Dark window: at least two weekly resets per account, so calibration has real data.
- **Rung 3, fleet:** default-on for the fleet is decided at a graduation review after rung 2's window, using calibration, disk use and any reported fault. The review is filed on the maturation board at merge so it comes back on its own. Nothing is promoted by a timer.
- Turning it off stops writes. Existing files stay and age out by retention. No other behaviour depends on the switch.
- Migration parity: the config default is added with an existence check in `migrateConfig()`. No hook or skill changes.

## Safety and side effects

- **Authority:** none. Nothing reads the forecast to make a decision in this step. A later consumer needs its own spec.
- **Poll path:** the only change to existing code is one guarded call in `pollOne()`. A thrown ledger error is caught and counted. Writes are an append of under 300 bytes, synchronous like the pool's own persistence. The 15-minute poll is unaffected.
- **Disk:** bounded by retention (under 300 KB per account; about 4 MB for 14 accounts).
- **Privacy:** no tokens, emails or content. Account ids and percentages only. The route is bearer-only and not exposed to phones in this step.
- **Unknown is not zero:** every missing, stale or malformed input surfaces as `unknown` or `cannot-tell` with a reason, never as an empty or full account.

## Tests (three tiers)

- **Unit, `quotaPacing.ts`:** cycle detection across a reset (no negative burn); rates `null` under 45 minutes of span; forecast range low/high; capped at 100; reachable maximum below target produces the expire wording; five-hour, weekly and Fable never mixed; runway with staggered resets (an account refilling mid-walk raises the line); burn moves to remaining accounts when one runs dry; unknown accounts widen the range; more than half unknown gives `cannot-tell`; Claude and Codex never pooled; both sides of every verdict band.
- **Unit, `QuotaHistoryLedger`:** append, dedupe on the same `measuredAt`, compaction at 14 days to hourly, deletion at 35 days, malformed-line skip and count, restart reload.
- **Wiring:** `pollOne()` calls the ledger with the attributed id; a throwing ledger leaves the snapshot persisted and the poll result unchanged.
- **Integration:** `GET /quota-pacing` over a seeded history returns the verdicts; `503` when off; `?account=&history=1` bounded.
- **E2E (feature is alive):** the production init path in `server.ts` constructs the ledger and the route answers 200 with real (possibly empty) coverage, not 503, on a dev agent.

## Measure of success

- **Correctness** is the unit tests: the arithmetic, the cycle handling and every verdict boundary.
- **Usefulness, on Echo within a week:** every enrolled account shows a forecast, and replaying 11-17 from history shows the headley Codex account as `will-leave-unused` at least 24 hours before its reset.
- **Calibration** (the self-check in §2) is reported after every reset: midpoint error, share inside the range, share below `low`. It is evidence for the step 5 spec to weigh, not a pass mark set here.

## Decision points touched

| Decision point | Classification | Basis |
|---|---|---|
| Verdict bands (on-track / will-leave-unused / will-hit-limit / sustainable / tight / runs-dry / cannot-tell) | invariant; basis: enumerable-domain; evidence: display labels over a computed range, read by nothing that acts; no block/allow/route decision consumes them in this step | Signal only. A later consumer that acts on a verdict is a judgment-candidate and needs its own spec with floor and arbiter. |
| Cycle segmentation (new cycle when resetsAt advances by more than half the window) | invariant; basis: external-constraint; evidence: the provider publishes resetsAt per window; a forward jump of the published reset time is the provider's own statement that a new window began | Arithmetic over provider data, no competing signals. |
| Stale cutoff (3 poll intervals) and minimum rate span (45 minutes) | invariant; basis: external-constraint; evidence: the poller cadence is 15 minutes (QuotaPoller pollIntervalMs default); fewer than 2 readings 45 minutes apart cannot separate burn from a single noisy reading; the only effect of the cutoff is unknown instead of a number | Both make the output say unknown, the conservative direction; neither gates anything. |
| Retention (14 days full, 35 days hourly) | invariant; basis: external-constraint; evidence: weekly provider windows; 35 days holds five cycles, the two needed for the busiest-6h figure plus margin; disk bound stated in Safety | Storage bound, not a behavioral limit on the agent. |

## Multi-machine posture

- Reading history files: machine-local, merged on read. machine-local-justification: physical-credential-locality (each account's readings come from the login that lives in that machine's configHome; only that machine can poll it). The pool view is proxied-on-read through the existing signed pool read (`?scope=pool`), so the agent sees one unified forecast.
- `GET /quota-pacing?scope=pool`: proxied-on-read, merged by account id; a machine that does not answer is named in `couldNotRead`.
- Config switch: per machine, like every dev-gated switch; existing config sync applies.
- No notices are sent, so no one-voice gating is needed. No URLs are generated.

## Frontloaded Decisions

- Storage is JSONL per account, not SQLite: matches the file-based state rule and the queue-pace ledger.
- Accounts are summed as equal-sized percentage points, labelled as an assumption; calibrating account size is step 3 (spend by account).
- No dashboard page in this step (step 1b); the endpoint and the awareness entry are the surface.
- Dev-gated: on for a development agent, off on the fleet. Cheap-to-change-after: it is read-only and writes only its own state folder.

## Open questions

*(none)*
