---
title: "Quota pacing, step 3: spend by account, from where the work was written (read-only)"
slug: "quota-pacing-spend-by-account"
author: "echo"
parent-principle: "Verify the State, Not Its Symbol"
eli16-overview: "quota-pacing-spend-by-account.eli16.md"
status: "draft"
approved: false
parent-spec: "quota-pacing-forecast.md (step 1 lists 'spend by account in the usage ledger' as step 3 and labels account size an assumption); unified usage ledger (UsageLedger.ts); quota-pacing-account-choice.md (step 2)"
lessons-engaged:
  - "P20 Verify the State, Not Its Symbol: a session's account tag is a label; the folder the provider wrote the transcript into is the evidence"
  - "P2 Signal vs Authority: read-only measurement; nothing here places, moves or sheds work"
  - "P24 Never Silently Cut the Data: rows with no resolvable account are counted and shown, never dropped or guessed"
origin: "Justin, topic 144201, 2026-11-18 22:04 PST: 'I want to make sure that we have a continuous effort to optimize our use of tokens for all accounts'. Step order from the token pacing plan, topic 141385, 2026-11-17 10:19 PST."
---

# Quota pacing, step 3: spend by account

## Problem

The unified usage ledger (`src/monitoring/UsageLedger.ts`) records one row per model request with machine, engine, model, conversation, job and list-price cost. It has an `account_id` column, but:

1. **It is filled only from the spawn binding**, the account the session was *tagged* with (`binding?.accountId`, lines ~1037 and ~1490 on `7429f4fcc`). On 2026-11-17 three sessions were tagged Headley while their processes ran on Dawn's login. Every row they wrote would carry the wrong account. A session with no binding (hand-started, default login) gets `null`.
2. **No read surface groups by account.** `/usage/tree` and `/usage/top` refuse `account` (`by must use machine, framework, model, topic, job, feature, session_kind, session`).
3. **Step 1's forecast assumes every account is the same size** ("assumes equal-sized accounts"), because nothing measures how many tokens one percentage point of an account's weekly window is worth.

So today nobody can answer "which account did this week's work actually come from?" or "how much work is one point of Headley's week compared with one point of Dawn's?". Every later pacing step needs both answers.

## Goal

- Every ledger row carries the account that **actually** served it, taken from where the provider wrote the transcript, with the tagged account kept beside it. A disagreement between the two is surfaced, not resolved by guessing.
- The usage routes can group by account, pool-wide.
- For each account and each closed weekly cycle, the ledger reports tokens spent against points used, so later steps can stop assuming equal-sized accounts.

## Non-goals

- No placement, swap, shedding or model change. Read-only.
- No dashboard page in this step; the routes and an awareness entry are the surface.
- No change to how transcripts are found, deduplicated or priced.

## Design

### 1. Served account from the root

Each scan root already has an origin (`subscription-pool`, `codex:subscription-pool`, or another). Root registration (`UsageLedger` ~585-596) already iterates the pool's `{ framework, configHome }` homes.

- The registration carries the pool account id with each subscription root: `CoverageRoot.accountId` for roots whose origin is `subscription-pool` or `codex:subscription-pool`.
- A row read from a file under that root gets `served_account_id` = that id, with `served_basis: 'transcript-root'`.
- A root that is not a pool home (the default `~/.claude`, `~/.codex`, or any other) gets `served_account_id` only if exactly one pool account has that folder as its `configHome` (on the Studio, `codex-dawn-sagemind` is `/Users/dabombstudio/.codex`). Otherwise it is null with `served_basis: 'unknown-root'`.
- The existing `account_id` column keeps the tagged account from the binding. It is renamed in reads as `taggedAccountId` and is not changed on write.

A new column `served_account_id` (TEXT, nullable) and `served_basis` (TEXT) are added by an idempotent migration (`ALTER TABLE ... ADD COLUMN` guarded by a column check, the pattern the ledger's existing migrations use). Existing rows are not rewritten: they read `served_basis: 'before-attribution'` and are counted under "unknown" in every account view. The ledger's 30-day window means they age out on their own.

**Why the root is evidence:** Claude Code and Codex write a session's transcript into the config home of the login that ran it (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`). A file's folder records which login the process used. The tag records only which login it was asked to use. This is the check that would have caught the 2026-11-17 mix-up in the ledger.

**When the root is not evidence:** a home shared by two pool accounts, or a home that is a symlink to another, gives `served_basis: 'ambiguous-root'`. The account is then null, never one of the candidates. The root registration resolves symlinks with `fs.realpathSync` before comparing homes.

### 2. Mismatch signal

A row where both accounts are known and differ is a **mismatch**. The ledger keeps a per-machine count by `(session_id, tagged, served)` and exposes it in `/usage/coverage` as `accountMismatches: [{ sessionId, tagged, served, requests, firstTs, lastTs }]` (top 50 by requests, plus a total). This is a signal only. Placement already has its own fix (PR #3390); this makes a recurrence visible within one scan.

### 3. Reads by account

- `/usage/tree` accepts `by=account` (grouped by `served_account_id`, with `unknown` as its own bucket), and `/usage/top` accepts `dim=account`.
- New `GET /usage/accounts?since=&until=&scope=pool|local`: per account, the requests, tokens by part (input, output, cache read, cache write) and list-equivalent cost, plus the `unknown` bucket and the mismatch total. Pool scope merges machines by the same fan-out the other `/usage/*` routes use, and names machines that did not answer.
- Accounts are keyed by step 1's login identity key (`identityKey(provider, email)` in `quotaPacing.ts`) when the pool record has an email, so one login enrolled on two machines under different slot ids is counted once. A slot with no identity is reported under its slot id and labelled `identity unknown`.

### 4. Size of a point

For each account and each **closed** weekly cycle in step 1's history (`QuotaHistoryLedger` cycle-end rows), compute:

- `pointsUsed`: the cycle's last valid reading (a lower bound when that reading is censored, as step 1 defines),
- `tokensServed`: the sum of tokens with `served_account_id` = that account and `ts` inside the cycle, by part, and the list-equivalent cost,
- `coverage`: the share of the cycle's requests on that account's machines whose served account was known.

Reported as `GET /usage/accounts/size?account=&cycles=` (and inside `/usage/accounts` as the latest closed cycle). The figure is `costPerPoint = cost / pointsUsed`. List-equivalent cost is used because the providers meter by price-weighted usage, not raw token counts.

It is reported **only** when:
- `pointsUsed ≥ 5`,
- coverage is at least 0.9, and
- every machine that holds that login's transcripts answered.

Otherwise the result is `cannot-tell` with the reason. This is evidence for a later step to weigh, never an input to any decision in this one.

### 5. Switch and rollout

- **Switch:** `usage.ledger.servedAccount`, resolved through `resolveDevAgentGate()` (on for development agents without the key, off for the fleet). When off, no new columns are written, the new query values answer `400 bad-query` as today, and `/usage/accounts*` answers `503 served-account-off`. The column migration runs regardless, because it is additive and idempotent, so turning the switch on later needs no migration.
- Registered in `src/core/devGatedFeatures.ts` and given a ladder in `src/data/feature-ladders.json` whose metrics read `/usage/coverage` (unknown share, mismatches).

## Maturation plan

- **test-agent-live:** before merge, a throwaway agent boots the real server with two seeded pool homes and a transcript written under each, plus one session tagged with home A whose transcript sits in home B. `/usage/accounts` reports each account's tokens; the coverage view lists the mismatch; `/usage/tree?by=account` groups correctly; with the switch off the routes answer 503.
- **dev-agent-live:** on from merge on Echo's machines.
- **fleet:** last rung, after the review.
- **graduation criterion:** a review on the maturation board reads, after two weekly resets per account, the unknown share, the mismatch counts (any mismatch after PR #3390 is a placement bug to file), and whether `costPerPoint` is stable enough across cycles to replace step 1's equal-size assumption. It promotes on judgment from that evidence.
- **ladder:** usage.ledger.servedAccount
- **dark-window:** the evidence minimum is two closed weekly cycles per account; a reminder at 4 weeks after merge if the review has not happened.

## Safety and side effects

- **Authority:** none. Nothing reads these numbers to decide anything in this step.
- **Write path:** two extra columns set from data already in hand at scan time (the root being read). No new file reads.
- **Migration:** additive columns, guarded, idempotent; old rows untouched.
- **Privacy:** account slot ids and identity hashes, never emails or tokens; bearer-only routes.
- **Unknown is not zero:** rows with no served account are shown as their own bucket with a share, never folded into an account.

## Tests (three tiers)

- **Unit:** root-to-account mapping (pool home, default home owned by one pool account, shared home → ambiguous, symlinked home resolved, non-pool root → unknown); row gets served and tagged accounts; mismatch counting and the top-50 cut with total; identity merge across slot ids; size-of-a-point with censored, low-points, low-coverage and missing-machine cases → `cannot-tell` with the right reason; migration idempotent on an existing database; switch off writes no served columns.
- **Integration:** `/usage/tree?by=account`, `/usage/top?dim=account`, `/usage/accounts` local and pool with one peer down, `/usage/accounts/size`, 503 when off.
- **E2E (feature is alive):** the production init path wires the pool homes with account ids into the ledger and `/usage/accounts` answers 200 on a development agent with no config key.

## Measure of success

- Correctness is the unit tests.
- On Echo within a week: at least 90% of the week's requests carry a served account; every mismatch is either explained (a pre-#3390 session) or filed as a placement bug; at least one closed cycle per active account reports a `costPerPoint`.

## Decision points touched

| Decision point | Classification | Basis |
|---|---|---|
| The transcript's root folder decides the served account | invariant; basis: external-constraint; evidence: Claude Code and Codex write transcripts into the config home the process ran with (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), so the folder is the provider-side record of the login used | The tag is kept beside it, never overwritten. |
| Shared or symlinked homes give `ambiguous-root` (null), never a guess | invariant; basis: enumerable-domain; evidence: a folder used by two accounts cannot say which one wrote a file | |
| Size of a point reported only at ≥5 points, ≥0.9 coverage, all machines answered | judgment-candidate; floor: failing any condition gives `cannot-tell` with the reason, never a number; arbiter: the graduation review, from how often each condition fails | Starting values; display only. |
| Top 50 mismatches listed, total always given | judgment-candidate; floor: the total is never cut, only the listed detail; arbiter: the graduation review | |

## Multi-machine posture

- **Ledger rows:** unchanged posture: each machine records what it read, merged on read by the existing `/usage/*` pool fan-out. `/usage/accounts` uses the same fan-out and names machines that did not answer.
- **Root-to-account mapping:** per machine. machine-local-justification: physical-credential-locality — a config home is a folder on this machine's disk holding that login's credentials and transcripts.
- **Switch:** per machine. machine-local-justification: physical-credential-locality — it governs only this machine's attribution of its own transcript folders.
- Accounts are merged across machines by login identity, so one login on two machines is counted once.

## Frontloaded Decisions

- The served account comes from the transcript root; the tag is kept as a separate column, never overwritten.
- Old rows are not backfilled; they read `before-attribution` and age out of the 30-day window.
- Size of a point uses list-equivalent cost, not raw tokens.
- Read-only, dev-gated; no dashboard page in this step.

## Open questions

*(none)*
