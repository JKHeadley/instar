---
title: "Quota pacing, step 3: spend by account, from where the work was written (read-only)"
slug: "quota-pacing-spend-by-account"
author: "echo"
parent-principle: "Verify the State, Not Its Symbol"
eli16-overview: "quota-pacing-spend-by-account.eli16.md"
status: "converged"
approved: true
approved-by: "Echo under standing authority: Justin approves only constitution changes (Instar 1.x, 2026-10-22 08:58 PDT, memory only-constitution-changes-need-justin); this spec touches no constitution file. Request origin: Justin, topic 144201, 2026-11-18 22:04 PST."
parent-spec: "quota-pacing-forecast.md (step 1 lists 'spend by account in the usage ledger' as step 3 and labels account size an assumption); unified usage ledger (UsageLedger.ts); quota-pacing-account-choice.md (step 2)"
lessons-engaged:
  - "P20 Verify the State, Not Its Symbol: a session's account tag is a label; the folder the provider wrote the transcript into is the evidence"
  - "P2 Signal vs Authority: read-only measurement; nothing here places, moves or sheds work"
  - "P24 Never Silently Cut the Data: rows with no resolvable account are counted and shown, never dropped or guessed"
origin: "Justin, topic 144201, 2026-11-18 22:04 PST: 'I want to make sure that we have a continuous effort to optimize our use of tokens for all accounts'. Step order from the token pacing plan, topic 141385, 2026-11-17 10:19 PST."
review-convergence: "2026-11-19T06:18:42.657Z"
review-iterations: 3
review-completed-at: "2026-11-19T06:18:42.657Z"
review-report: "docs/specs/reports/quota-pacing-spend-by-account-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 5
cheap-to-change-tags: 0
contested-then-cleared: 10
---

# Quota pacing, step 3: spend by account

## Problem

The unified usage ledger (`src/monitoring/UsageLedger.ts`) records one row per model request with machine, engine, model, conversation, job and list-price cost. It has an `account_id` column, but:

1. **It is filled only from the spawn binding**, the account the session was *tagged* with (`binding?.accountId`, lines ~1037 and ~1490 on `7429f4fcc`). On 2026-11-17 three sessions were tagged Headley while their processes ran on Dawn's login. Every row they wrote would carry the wrong account. A session with no binding (hand-started, default login) gets `null`.
2. **No read surface groups by account.** `/usage/tree` and `/usage/top` refuse `account` (`by must use machine, framework, model, topic, job, feature, session_kind, session`), and their pool views read replicated rollups that have no account key.
3. **Step 1's forecast assumes every account is the same size** ("assumes equal-sized accounts"), because nothing measures how many tokens one percentage point of an account's weekly window is worth.

So today nobody can answer "which account did this week's work actually come from?" or "how much work is one point of Headley's week compared with one point of Dawn's?". Every later pacing step needs both answers.

## Goal

- Every ledger row carries the account that **actually** served it, taken from where the provider wrote the transcript, with the tagged account kept beside it. A disagreement between the two is surfaced, not resolved by guessing.
- A usage route reports spend by account, pool-wide.
- For each account and each closed weekly cycle, the ledger reports tokens spent against points used, so later steps can stop assuming equal-sized accounts.

## Non-goals

- No placement, swap, shedding or model change. Read-only.
- No dashboard page in this step; the routes and an awareness entry are the surface.
- No change to how transcripts are found, deduplicated or priced.

## Design

### 1. Served slot and served account, recorded at scan time

Claude Code reads and writes under `CLAUDE_CONFIG_DIR` and Codex under `CODEX_HOME`; the ledger scans `<home>/projects` and `<home>/sessions` (`UsageLedger` ~697 and ~1349). A transcript's root is therefore the **slot** (the config home) the process ran in. That is physical. Which **account** sat in that slot is a second question, answered in this order:

1. **Live credential re-pointing in use** (`CredentialLocationLedger` present and not in unknown mode): the slot's assignment `{ slot, accountId, since, lastVerifiedAt, quarantined }`.
   - The row gets `served_account_id` = the assignment's account and `served_basis: 'ledger-verified'` when `since` ≤ the row's timestamp, a verification at or before the row's time is on record (the journal's `verified` entries for that slot, or `lastVerifiedAt` ≤ the row's time), and the slot is not quarantined. A verification that came only after the row does not certify it: such a row is `'ledger-unverified'`. A process started before a swap keeps the credentials it loaded, so a row whose session began before the assignment's `since` is `'slot-changed'` even if written after it.
   - It gets `'ledger-unverified'` (account still recorded) when the tenant was never confirmed.
   - It gets `'slot-changed'` (account null), which happens only on a late scan or a backfill since attribution runs at scan time, when the assignment began after the row **and** the journal shows a different account entered the slot. A `reconcile` or `seed` that re-records the same tenant does not count as a change.
2. **No re-pointing** (each enrolled account owns its own home): the enrollment mapping `configHome → accountId`. Whether the slot really held that login **at the row's time** is judged from a new, small durable log, `.instar/state/identity-checks/<slotId>.jsonl`. The poller's `reconcileIdentity` records intervals `{ from, lastConfirmedAt, result: 'confirmed' | 'drifted', identity }`: a new line when the result or identity changes, and `lastConfirmedAt` of the open interval updated in memory on every confirmed poll and flushed by rewriting the last line at most every 15 minutes and on shutdown (bounded to a few hundred lines a year per slot). A failed or unavailable check (`identityForSlot` answering `unavailable`) closes the open interval instead of extending it. A row then gets:
   - `'enrollment-confirmed'` when the row's time falls inside a `confirmed` interval, or after one by less than 3 poll intervals past its `lastConfirmedAt` with no other interval begun in between. The row's `served_identity` is the identity **that check recorded**, never the slot's current enrollment, so a home re-bound to another login after the work cannot relabel it.
   - `'enrollment-drifted'` (account null) when the latest check before it was `drifted`.
   - `'identity-unconfirmed'` (account recorded, labelled) otherwise.

   Codex slots are never identity-checked (`reconcileIdentity` returns early for non-Claude), so their rows are always `'identity-unconfirmed'`. Drift is never judged from the flag's state at scan time, because the flag clears on the first confirmed poll and scans can run days after the work.
3. **A root no pool account owns, or one two accounts share:** `served_slot` is recorded, account null, `served_basis: 'unknown-root'` or `'ambiguous-root'`. The scanner does not follow symlinked roots (it checks with `lstat` and skips them), so no symlink resolution is added; a symlinked home stays unscanned, as today.
4. **Rows with no transcript** (internal model calls, grain `invocation`): `served_basis: 'no-transcript'`, account from the binding only, shown as their own bucket.

Every row also keeps `served_slot`. The existing `account_id` column keeps the tagged account from the binding and is not changed on write. Three write sites set the new columns: transcript rows (~1037), Codex rollout rows (~1490), and the invocation flush (`flushInvocations`). When the settle window pairs an invocation row with a transcript row, the transcript row's served fields win, because they rest on the root.

Each row also stores `served_identity`, always in step 1's format (`identityKey(provider, email)`: provider plus the first 16 hex of SHA-256 of the normalized email), computed at write time from the identity the evidence for that row recorded: for `enrollment-confirmed` rows, the identity the confirming check saw; for `ledger-verified` rows, the identity the credential ledger's oracle confirmed at `lastVerifiedAt`; otherwise null. It is never read from the slot's current enrollment, so a later re-binding of a slot never relabels old spend. New nullable columns `served_slot`, `served_account_id`, `served_identity` and `served_basis` are added to the raw events table only, with a guarded idempotent `ADD COLUMN`. The rollup tables are **not** changed (see §3). Existing rows read `served_basis: 'before-attribution'`.

The resolver is an in-memory map rebuilt at the start of each scan tick when the credential ledger's `version` or the pool's account list has changed (neither emits events), plus the identity-check logs loaded once and appended in memory as the poller writes them. No per-row file reads; the two new small logs (identity checks, switch history) are read once at boot and kept in memory.

### 2. Mismatch signal

A mismatch is a row whose tagged account (`account_id`) and served account are both known and differ. Both are pool account ids, so they compare directly. `/usage/coverage` gains an `accountMismatches` total. `GET /usage/account-mismatches?since=&limit=&cursor=` lists every mismatching session `{ sessionId, tagged, served, servedBasis, requests, firstTs, lastTs }`, newest first. The default page is 50 and the maximum 500; it is paged, never cut. Mismatches count from `ledger-verified`, `enrollment-confirmed` and `identity-unconfirmed` rows, each with its basis shown; only the first two are presented as confirmed, and an unconfirmed mismatch is counted in the total but listed separately, so it is never treated as a placement bug on its own. Across machines, each machine returns its page newest first with a per-machine cursor; the holder merges by `(lastTs desc, machineId, sessionId)`, emits up to `limit` rows, and the composite cursor advances each machine only past the rows actually emitted, so no fetched-but-unemitted row is skipped. The fan-out maps a peer's 404 to `served-account-unsupported` and 503 to `served-account-off`, with a per-peer size limit sized for a 500-row page.

### 3. Reads by account

Pool views of `/usage/tree` and `/usage/top` are answered by the lease holder from replicated hour and day rollups whose keys have no account. Re-keying them would be a table rebuild on every machine plus a replication change. This step does **not** do that:

- `GET /usage/accounts?since=&until=` is computed on each machine from its own raw events (kept 90 days). On the lease holder (or proxied to it, like the other `/usage/*` routes) it fans out to every machine through the existing bearer pool fan-out helper (`src/server/poolFanOut.ts`) at request time, merges by account, and names machines that did not answer or are on an older build (`served-account-unsupported`). Per account it returns requests, tokens by part, list-equivalent cost and a breakdown by `served_basis`; the unknown buckets are separate. It counts the same row statuses as the existing reads (transcript rows `counted`, invocation rows `counted` or `paired`); invocation rows held, in disagreement or ambiguously paired land in the `no-transcript` bucket.
- `/usage/account-mismatches` fans out the same way and pages per machine.
- `/usage/tree` and `/usage/top` are unchanged.
- Spend is grouped by the stored `served_identity`, never by today's pool membership, so one login enrolled on two machines is counted once and a re-bound slot never mixes logins. Rows with a null `served_identity` are never mixed into a login: they are grouped under `unidentified` by account id and basis, as their own labelled buckets.

### 4. Size of a point

For each account, each **closed** weekly cycle in step 1's history, and each weekly window separately (`sevenDay`, and `fable` on Claude accounts), compute:

- `pointsUsed`: the sum over the cycle's rate segments (step 1's segments, which already split at early drops and credits) of last minus first valid reading in each segment. Cost is counted only between each segment's first and last valid reading, so points and spend cover the same intervals. A cycle with `pointsUsed` of 0 is `cannot-tell (no use)`.
- `costServed`: list-equivalent cost of `ledger-verified` and `enrollment-confirmed` rows whose `served_identity` is this login and whose time falls inside the cycle's matched segments. For `fable`, only Fable-model rows count. Binding-only rows (`no-transcript`) never enter it and are shown separately as `costBindingOnly`; `identity-unconfirmed` rows (all Codex rows today) are shown separately as `costUnconfirmed`. The figure uses `costServed` only; for Codex it is therefore `cannot-tell (no identity check)` until a later change confirms Codex identity, with `costUnconfirmed / pointsUsed` shown beside it as a labelled estimate.
- `unattributedCost`: the cost in that cycle of rows on the same machines with a null served account. This is an upper bound on what the account may be missing.
- `retentionComplete`: whether the whole cycle lies after every contributing machine's actual oldest raw row (retention is 90 days but the raw-row ceiling can drop rows sooner).

Only cycles whose whole span lies inside step 1's full-detail history (the last 14 days) can be segmented; older cycles keep only their cycle-end reading and are `cannot-tell (history thinned)`. In practice this gives the last one or two closed cycles per account, which is what the review needs.

The figure is `costPerPoint = costServed / pointsUsed`. It is withheld (`cannot-tell` with the reason) when `pointsUsed` is 0, the cycle is not retention-complete, a contributing machine did not answer, or the switch was not on for the whole cycle on every contributing machine. Otherwise it is shown with a `quality` label: `low` when `pointsUsed < 5` or `unattributedCost` exceeds 10% of `costServed`, else `ok`.

Every figure carries a standing caveat: use of the same login outside this agent (the web app, the phone, machines outside the pool) adds points but no ledger cost, so `costPerPoint` is a **lower bound** on the full list-equivalent cost per point. It is a workload-dependent ratio, not a capacity measurement: a different mix of models or cache use changes it. This is evidence for a later step to weigh, never an input to any decision in this one.

### 5. Switch and rollout

- **Switch:** `usage.ledger.servedAccount`, resolved through `resolveDevAgentGate()`. Each machine appends its resolved value at boot and on every change to `.instar/state/served-account-switch.jsonl` (`{ at, on }`), and returns that history in its fan-out answer. "On for the whole cycle" and the default `since` are derived from it; a machine with no history (an older build) counts as off. The development-agent flag is agent-wide, so it resolves the same on every machine of an agent unless an operator sets it differently on one. A machine with it off writes `served_basis: 'off'`, so a partial rollout shows in the reads. When off, `/usage/accounts` and `/usage/account-mismatches` answer `503 served-account-off`. The column migration runs regardless, because it is additive and idempotent.
- Unknown shares are reported from the switch-on time onward (`since` defaults to it), broken down by `served_basis`, so old `before-attribution` rows never distort the measure.
- Registered in `src/core/devGatedFeatures.ts` with a ladder in `src/data/feature-ladders.json` whose metrics read `/usage/accounts` (unknown share by basis) and the mismatch total.

## Maturation plan

- **test-agent-live:** before merge, a throwaway agent boots the real server with two seeded pool homes and a transcript written under each, plus one session tagged with home A whose transcript sits in home B. `/usage/accounts` reports each account's cost with its basis, `/usage/account-mismatches` lists the mislabelled session, and with the switch off both answer 503. A second run seeds a credential-ledger assignment that changed after a row, and that row reads `slot-changed`.
- **dev-agent-live:** on from merge on Echo's machines.
- **fleet:** last rung, after the review.
- **graduation criterion:** a review on the maturation board reads, after two weekly resets for most accounts (a newly enrolled account is reported as not yet sized and does not block), the unknown share, the mismatch counts (any confirmed mismatch after PR #3390 is a placement bug to file), and whether `costPerPoint` is stable enough across cycles to replace step 1's equal-size assumption. It promotes on judgment from that evidence.
- **ladder:** usage.ledger.servedAccount
- **dark-window:** the evidence minimum is two closed weekly cycles per account; a reminder at 4 weeks after merge if the review has not happened.

## Safety and side effects

- **Authority:** none. Nothing reads these numbers to decide anything in this step.
- **Write path:** four extra columns set from data in hand at scan time (the root being read, an in-memory slot map). No new file reads.
- **Migration:** additive columns on the raw events table only, guarded, idempotent; rollups and replication untouched; old rows untouched.
- **Privacy and team access:** account slot ids and identity hashes, never emails or tokens. The new routes sit under `/usage` with exactly the access rule of the existing `/usage/*` routes: agent bearer only, and not on any phone allowlist.
- **Unknown is not zero:** rows with no served account are shown as their own bucket with a share, never folded into an account.

## Tests (three tiers)

- **Unit:**
  - Each `served_basis`:
    - ledger-verified, ledger-unverified, slot-changed
    - enrollment-confirmed, enrollment-drifted and identity-unconfirmed judged at the row's time (a row written while drifted but scanned after recovery stays drifted); Codex always unconfirmed; the identity-check log's intervals (new line on change, `lastConfirmedAt` rewritten at most every 15 minutes and on shutdown, closed by an unavailable check), including a full day of confirmed polls then a restart and a delayed scan
    - unknown-root, ambiguous-root, no-transcript, off, before-attribution
  - Rows and pairing:
    - transcript, rollout and invocation rows each get the right columns
    - an invocation/transcript pair keeps the transcript's served fields
  - Mismatches: mismatch counting; paging defaults and maximum; interleaved timestamps across machines over several pages with no row skipped.
  - Identity merge: merge across slot ids by enrollment email.
  - Size of a point:
    - separate sevenDay and fable figures
    - retention-incomplete and missing-machine cases → cannot-tell
    - low points and high unattributed cost → shown with `quality: low`
  - Plumbing:
    - the in-memory resolver rebuilds when the ledger version or the pool's account list changes
    - the migration is idempotent on an existing database
    - with the switch off, rows are written as `off`
- **Integration:**
  - `/usage/accounts` and `/usage/account-mismatches`, holder and non-holder (proxied)
  - one peer down; one peer on an older build (`served-account-unsupported`)
  - `/usage/tree` and `/usage/top` unchanged
  - 503 when off
- **E2E (feature is alive):** the production init path gives the ledger the slot resolver (pool plus credential ledger), and `/usage/accounts` answers 200 on a development agent with no config key.

## Measure of success

- Correctness is the unit tests.
- On Echo within a week: at least 90% of the week's requests carry a served account; every mismatch is either explained (a pre-#3390 session) or filed as a placement bug; at least one closed cycle per active account reports a `costPerPoint`.

## Decision points touched

| Decision point | Classification | Basis |
|---|---|---|
| The transcript root decides the served slot | invariant; basis: external-constraint; evidence: Claude Code and Codex write transcripts under the config home the process ran with (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), and the ledger reads them from those folders | The slot, not yet the account. |
| Account in the slot: credential ledger assignment (verified, unverified, changed since) when re-pointing is on, else the enrollment home judged against the identity-check log at the row's time (3-poll-interval gap) | judgment-candidate; floor: an assignment newer than the row, a drifted slot, an unknown or shared root all give a null account, never a guess; every row records its basis; arbiter: the graduation review, from the share of rows per basis and the mismatches found | The best available record of the tenant, labelled with how good it is. |
| The tag is kept beside the served account and never overwritten | invariant; basis: enumerable-domain; evidence: the two answer different questions (what was asked, what was used) and the mismatch between them is the signal | |
| Size of a point withheld when there was no use, retention is incomplete, a machine did not answer, or the switch was not on for the whole cycle; else shown with a quality label (low under 5 points or over 10% unattributed cost), and always as a workload-dependent lower bound | judgment-candidate; floor: an incomplete sum is never shown as whole; a low-quality figure is labelled, never hidden; the outside-use and workload caveats are always attached; arbiter: the graduation review | The 5-point and 10% marks only label. |
| Mismatch list paged (default 50, max 500), never cut | invariant; basis: enumerable-domain; evidence: every mismatch is a row the review must be able to read; paging bounds one response, not the set | |
| Rollups are not re-keyed; account reads fan out over raw events | judgment-candidate; floor: a machine that cannot answer is named, never counted as zero; arbiter: the graduation review, from response times and peers that did not answer | Avoids a table rebuild and a replication change. |

## Multi-machine posture

- **Ledger rows and the new columns:** unified, proxied on read. Each machine records the rows it read, and `/usage/accounts` and `/usage/account-mismatches` fan out to every machine at request time through the existing bearer pool fan-out. A machine that did not answer, or that runs an older build, is named.
- **The slot-to-account resolver:** per machine. machine-local-justification: physical-credential-locality — a config home is a folder on this machine's disk holding a login's credentials, and the credential ledger that says which account is in it is that machine's own record.
- **Switch:** unified by default. It resolves from the agent-wide development flag, so every machine of an agent agrees unless an operator sets one differently, and a machine with it off writes `served_basis: 'off'`, so a split shows in every read.
- Accounts are merged across machines by `served_identity` (step 1's identity key); rows without one stay in labelled `unidentified` buckets.

## Frontloaded Decisions

- The served slot comes from the transcript root. The served account comes from the credential ledger when re-pointing is on, otherwise from the enrollment home, and its basis is recorded either way. The tag is a separate column and is never overwritten.
- The rollups are not re-keyed. Account reads fan out over raw events (90-day retention).
- Old rows are not backfilled. They read `before-attribution`, and unknown shares count only from the switch-on time.
- Size of a point uses list-equivalent cost, is computed per weekly window, and is always presented as a workload-dependent lower bound.
- Read-only and dev-gated; no dashboard page in this step.

## Left behind

- Codex identity is never checked, so Codex size-of-a-point stays an unconfirmed estimate until a later change adds a Codex identity check.
- Re-keying the replicated rollups so `/usage/tree` and `/usage/top` can group by account (a table rebuild plus a replication change); `/usage/accounts` covers the need over raw events.
- Size of a point for cycles older than step 1's 14-day full-detail history.

## Open questions

*(none)*
