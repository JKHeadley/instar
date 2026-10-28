---
title: "Local-Verify Capacity — a second verifier machine (and why not batched verifies)"
slug: "local-verify-capacity"
author: "echo"
parent-principle: "Structure beats Willpower"
parent-spec: "local-verify-merge-authority"
ships-staged: true
supervision: tier0
lessons-engaged: [P1-structure-beats-willpower, P2-signal-vs-authority, P4-testing-integrity, P6-zero-failure, P19-no-unbounded-loops, P20-verify-the-state, P21-multi-machine-entity, bounded-blast-radius, 80-20-convergence, reuse-1x-first, unmeasured-instruments]
status: approved
review-convergence: "2026-10-26 — Codex rounds 1-4, round 4 CONVERGED (no material findings); Gemini unavailable (not authed, ACT-150). See reports/local-verify-capacity-convergence.md"
approved: true
approved-by: "Justin (Telegram topic 130715, 2026-10-26 17:51 PDT: \"Yes! We should make this work top priority … see this work through to completion\", answering the plan that named batching 3-5 PRs per run and running the slow tests on an idle second machine)"
---

## Problem statement

Local Verify (`docs/specs/local-verify-merge-authority.md`) runs one full verify at a time, on the serving-lease holder (the Studio). Measured 2026-10-20..26: 121 verifies, median 18.5 minutes; the PR queue was full (10) for most of 2026-10-26 and labelled throughput PRs were turned away. Four changes already shipped or are in review shorten each run and remove idle time (fail-fast #2392, balanced shards #2393, restart recheck #2396, labelled overflow #2397). They do not add capacity: one machine still runs one verify at a time, and the Studio is also where most builder sessions run.

Two ways large teams add capacity, both in the operator's plan:

1. **More machines.** The Mac Mini (10 cores, ~90% idle at 19:00 on 2026-10-26) is an instar source checkout with Local Verify switched off. A second verifier doubles the number of verifies in flight.
2. **Batched verifies (a merge queue).** Test several queued PRs together on top of `main`; if the batch passes, all of them can merge from one run; if it fails, fall back to testing them one by one.

This spec adds the first, staged and off by default, under the existing merge authority. It changes no rule about what a passing record is; it adds where a record may come from (a peer). The second was reviewed and is not built (Part C explains why).

## Part D — a peer verifier

### Roles

- **Coordinator:** the machine holding the serving lease (today the Studio). It owns the verify queue, the index, the merge line and main health, exactly as now.
- **Peer:** a machine that does NOT hold the lease, with `monitoring.localVerify.enabled: true` and `monitoring.localVerify.peer.enabled: true`. It runs single PR verifies handed to it and keeps their records in its own journal. It never merges, never posts commit statuses, never verifies `main`, never decides main health. **The peer is a merge-authorizing principal**: a record it produces can, once imported, let the coordinator merge a PR. It is trusted on the same basis as the coordinator itself (same agent, same verifier code, the operator's own pool, the agent's Bearer token over the pool's existing mesh transport); a compromised peer could forge a success record, as could a compromised coordinator. This is stated, not implied away.

### Dispatch (coordinator → peer)

1. The coordinator's pump gives its own next entry the first chance to start. Peer dispatch runs on a later timer, so a free local slot starts local work first. If an unrelated full suite occupies the coordinator's slot, the peer can still take a queued eligible PR immediately; it does not wait for the coordinator to start a verifier. With a configured peer (`monitoring.localVerify.peers: [{ machineId }]`, at most 2), the dispatcher picks the next eligible entry in queue order: a PR verify (never `main`), not held by the main-red hold, not already remote, with fewer than `peer.maxAttemptsPerEntry` (2) remote attempts. After a durable peer reservation or a closed-PR dequeue, the coordinator immediately recomputes its next-slot priority claim from locally runnable work: it releases a claim when only remote work remains and retains one for queued main or another local PR.
2. **Today's base first.** Before reserving, the entry goes through the same conditional base refresh a local start uses (`decideBaseRefresh` → `refreshBaseThenPump`'s read of the base head and of the PR's open state, with its audited fallback to the last known base on a read failure, and its drop of a closed PR). After that asynchronous read the coordinator re-checks that the entry is still queued, unreserved, unheld, at the same head and still dispatchable, and that the chosen peer is still idle; only then does it continue. It mints `attemptId` (16 random bytes, hex) and writes durable dispatch intent on the entry BEFORE sending: `remote: { machineId, attemptId, leaseEpoch, sentAt, state: 'sending', dispatched: { pr, headSha, baseSha, baseRefName, verifierVersion, policyHash } }`, persisted with the queue. `dispatched` is an immutable snapshot: every later check compares against it, never against the entry's mutable fields, and a restore keeps the marker as written (it does not refresh the base of a reserved entry).
3. `POST /local-verify/peer-run` to the peer's mesh endpoint: `{ attemptId, pr, headSha, baseSha, baseRefName, verifierVersion, policyHash, coordinatorMachineId, leaseEpoch }`.
4. The peer accepts idempotently: the same `attemptId` returns the same answer. It refuses (409, reason in body) when: it holds the lease (`is-lease-holder`); the peer role is off (`peer-disabled`, 503); it already runs a different attempt or its host suite slot is busy (`peer-busy`); `verifierVersion`/`policyHash` differ from its own (`verifier-mismatch`); `coordinatorMachineId` is not the lease holder it observes (`not-coordinator`); its own GitHub read of the PR fails eligibility (`checkEligibility`) or shows a head other than `headSha` (`head-moved`). It verifies against EXACTLY the `baseSha` it was sent (no re-read of `main`).
5. On acceptance the entry's `remote.state` becomes `accepted`. A `peer-busy` refusal is backpressure: the marker is cleared, the attempt does NOT count and the breaker is not touched; that peer is not offered work again until its `peer-status` shows it idle. Every other refusal clears the marker and counts the attempt. A send whose answer is lost stays `sending`; the next poll (below) resolves it.
6. **A reserved entry is the peer's.** While an entry carries a remote marker it is excluded from the coordinator's local selection, from the pre-start base refresh, and from execution-key derivation; a peer that already has an outstanding attempt (known from the markers) is never offered another. If a new request for that PR arrives with a different head, the attempt is abandoned (marker cleared, `peer-cancel` sent) and the new head is queued in the kept place as today. All transitions (dispatch, acceptance, import, abandonment, local start) run on the service's single event loop and re-check the marker at the moment they apply, so no two of them can act on one entry.

### Results (peer → coordinator)

- The peer keeps the attempt in its own journal entry and record: the record gains an optional `attempt: { id, coordinatorMachineId, leaseEpoch }` field (validated like the rest of the record).
- New peer-readable routes (Bearer; served on a non-holder; 503 when the peer role is off): `GET /local-verify/peer-status` → `{ inFlight: { attemptId, pr } | null, verifierVersion, policyHash, slotBusy }`; `GET /local-verify/peer-result?attemptId=…` → `{ state: 'unknown' | 'running' | 'done', record? }`.
- The coordinator polls `peer-result` for its remote entries every 60 s. It imports a record only if ALL hold: `record.attempt.id === remote.attemptId`; `repo`, `pr`, `headSha`, `baseSha`, `baseRefName` equal the `dispatched` snapshot; `verifierVersion`, `policyHash` equal the coordinator's own; `machineId` is the peer it was sent to; the coordinator still holds the lease at the SAME `leaseEpoch` as at dispatch; the entry is still at that head; `validateRecord` passes. By outcome: a `success` or `failure` record goes through the one completion path (`complete(record, 'peer')`, so the index, journal, merge line and status projection treat it like a local record) and the entry is dequeued; an `error` record (infrastructure) is not recorded: the marker is cleared, the attempt counts, and the entry returns to scheduling (after `peer.maxAttemptsPerEntry` attempts, local only). Any failed check drops the record (audited `peer-record-rejected` with the reason) and clears the marker; the attempt counts; the entry stays at its place.
- A `peer-result` of `unknown` for an attempt (in `sending` OR `accepted`) more than 2 minutes after it was sent means the peer has no such attempt (never accepted, or lost in a peer restart): the marker is cleared, the attempt counts, and `peer-cancel` is sent so a delayed `peer-run` for that id is refused later. The peer keeps a tombstone for every cancelled or abandoned `attemptId` (bounded, 7 days) and refuses a `peer-run` for one (`attempt-cancelled`).

### Bounds, recovery and role changes

- **One attempt wins.** Only the attempt named in the entry's marker can be imported; a late result of an earlier attempt is rejected by `attemptId`.
- **Per-entry bound.** After `peer.maxAttemptsPerEntry` (2) remote attempts, the entry is only ever run locally (P19: no unbounded redispatch).
- **Run bound.** A remote attempt not `done` within `peer.maxRunMs` (60 min) is abandoned: the marker is cleared, the attempt counts, the peer is told `POST /local-verify/peer-cancel { attemptId }` (best effort; the peer also self-cancels an attempt it has run past `maxRunMs`).
- **Per-peer breaker.** 3 consecutive transport or execution failures (unreachable, a refusal other than `peer-busy`, an abandoned or `unknown` attempt, a rejected record) skip that peer for 30 min (one deduped attention item `local-verify:peer-breaker:<machineId>` while open). Busy is never a failure.
- **Restarts.** The remote marker is persisted with the queue, so a coordinator restart resumes polling the same attempt. A peer restart runs the existing orphan reaping (`reapOrphan`) before it accepts anything, marks the interrupted attempt cancelled (tombstone), and answers `unknown` for it; the coordinator reclaims as above.
- **Pending updates.** When an installed update is waiting only for the current verifier run to finish, the coordinator starts no new local or peer verify, and a peer reports its slot busy and refuses a new hand-off as backpressure. Both sides recheck after asynchronous status or PR reads, so an update that arrives during a read cannot gain another restart hold.
- **Lease moves.** Import requires the dispatch-time lease epoch, so a coordinator that lost the lease (or regained it at a new epoch) imports nothing from earlier dispatches; it clears those markers. A peer that becomes the lease holder stops accepting `peer-run` (`is-lease-holder`) and cancels any peer attempt it is running (tombstoned); peer attempts are never promoted into the new coordinator's own authority (one completion rule, no special path). The queue itself stays machine-local, as the parent spec defines; the new coordinator's queue fills from its own requests and the watcher's ticks.
- **Never blocks local work.** The coordinator never waits on a peer before starting its own next run.

### Setup (the operator's chores are the agent's)

The coordinator-side gate stays as it is: Local Verify is built only on an instar source checkout (`.git` + `scripts/safe-merge.mjs`), because that machine merges. A **peer** never merges and never runs safe-merge, so its build path needs only the installed verifier (`dist/localVerify/runVerifyMain.js`), its own bare clone under `.worktrees/.verify/`, and a GitHub login for the eligibility read: `buildLocalVerifyService` builds a peer-only service when `peer.enabled` is true and the source-checkout check fails, and that service refuses every coordinator role (no `POST /local-verify`, no merge line, no status loop, no `main` verifies). Probed 2026-10-26 19:47 on the Mini: agent home `/Users/justin_instar_1/.instar/agents/echo` is not a git checkout; `gh` is logged in as `EchoOfDawn` (scopes `repo`, `workflow`); Node v24.14.1 (same as the Studio); 185 GB free. Turning it on is config on the Mini (`monitoring.localVerify.enabled`, `peer.enabled`, `greenPrAutoMerge.expectedGhLogin: EchoOfDawn`), done by the agent through its own session there. The coordinator's `peers` list stays empty until the Mini answers `peer-status` with matching versions.

The peer HTTP client sends the coordinator's local API Bearer token and `X-Instar-AgentId` set to the coordinator's `projectName`. Paired machines can have different local tokens or project names, so activation requires an authenticated `GET /local-verify/peer-status` from the coordinator to return 200 with that token and header; a 401 or 403 leaves the peer unconfigured. The Studio and Mini accepted the same token in a live probe on 2026-10-27. The HTTP integration test mounts the real authentication middleware and checks matching and wrong tokens and agent IDs.

## Part C — batched verifies (rejected for v1, pending the operator)

The first review (Codex, 2026-10-26) showed that batching as drafted is unsound here: if A and B pass together and only A merges (B is held, refused or pushed again), A lands on `main` without ever having been tested without B, and withdrawal cannot undo that merge. The sound form lands a tested batch atomically (one merge of the combined tree), which changes how every PR lands. And the payoff is small at the measured pass rate: expected runs per PR for batch size k are (1 + k(1 − p^k))/k, which at p = 0.8 gives about 1.16×, 1.22× and 1.19× throughput for k = 2, 3, 4. The operator was asked (topic 130715, 19:46) to confirm dropping it; until then it is not built.

## Out of scope

- More than 2 peers, peers on Windows (the Mama PC runs under WSL; the test suite's tmux and path assumptions are unproven there).
- Selecting only the tests a change touches (prototype 2026-10-26: typical code PRs reach 55-75% of the integration and e2e files through imports, plus ~150 files that reach code by spawning or reading `dist`; the saving is smaller than balanced shards and the soundness cost is higher).

## Tests

Unit: peer-run refusals (each reason) and idempotent acceptance; a queued entry whose base advanced is refreshed before dispatch; dispatch while an unrelated suite occupies the local slot, including when main stays local; dispatch intent persisted before send; import checks (each mismatch, wrong attempt, wrong base, lease epoch changed, late earlier attempt) drop and keep the entry; lost acceptance resolved by `unknown`; per-entry bound then local only; run bound and cancel; breaker; restart resumes polling; peer restart reclaims; held and `main` entries never dispatched. Integration: the three peer routes over HTTP on a non-holder, refused on the holder, and a busy coordinator dispatches through the real HTTP client. E2E: coordinator and peer services built through the production wiring dispatch while the coordinator slot is occupied, with the peer reservation visible through `/local-verify`.
