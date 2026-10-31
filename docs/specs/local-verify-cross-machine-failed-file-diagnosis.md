---
title: "Bounded cross-machine failed-file diagnosis for Local Verify"
slug: local-verify-cross-machine-failed-file-diagnosis
author: echo
status: draft
parent-spec: local-verify-capacity
parent-principle: Structure beats Willpower
ships-staged: true
supervision: tier0
lessons-engaged: [P1-structure-beats-willpower, P2-signal-vs-authority, P4-testing-integrity, P6-zero-failure, P19-no-unbounded-loops, P20-verify-the-state, P21-multi-machine-entity, bounded-blast-radius]
approved: true
approved-by: "Justin's explicit 24-hour throughput implementation instruction in Telegram topic 130715, 2026-10-30 23:43 PDT; implementation authorization only, not separate spec review."
delegated-scope: "Justin, Telegram topic 130715, 2026-10-30 23:43 PDT, approved the throughput implementation plan."
---

# Bounded cross-machine failed-file diagnosis for Local Verify

## Problem

A failed PR verify names the failing file and the machine that ran it, but the current record does not establish whether the same file fails on another machine or on the exact `main` base. Retrying a whole suite to answer that question consumes a scarce full-suite slot. The 2026-10-30 to 2026-10-31 baseline had 18 red checks among 47 completed checks; 17 named a failing lane. Those figures bound the possible diagnostic sample; they do not prove that all 17 have a small, usable failed-file set.

## Decision

After a validated PR failure with one to three concrete failed test files, the serving-lease coordinator may ask one idle peer machine to run only those files against (a) the same synthetic PR merge tree and (b) the exact `baseSha` tree. The two executions use the peer's installed, matching verifier and isolated test environment. The result is a **diagnostic observation**, kept outside `LocalVerifyRecord`, the merge index, commit statuses, `main` health, and the merge line. No diagnostic result, including a green rerun, can turn a red PR green, clear a hold, or authorize a merge. A new full Local Verify record is the only path to that result.

The coordinator starts at most one diagnostic for a `(repo, PR, headSha, baseSha, policyHash, failing-file set)` key. It does not diagnose errors without a failed file, `main` verifies, harness-changing PRs, protected-path changes, or records whose failure came only from an early preflight red. A full-suite failure's file identities come from the verifier's installed inventory and parsed lane reports, never from an agent's prose or user input. The orchestrator stores only the bounded failed-file identities (one to three, no test message text) in an optional, validated `LocalVerifyRecord.failedFiles` field **when the entire failed-file set fits**; it omits the field when there are more than three, so the completion journal survives restart and a peer import has the same trigger without silently truncating the case. A changed head, base, target, lease epoch, verifier version, or policy hash invalidates the observation; the old result remains historical with its exact key.

## Execution and bounds

The coordinator uses the existing peer machine list and Bearer-authenticated mesh client, but a separate diagnostic endpoint and result type. It never occupies the peer's full-suite verifier slot. A peer reports `busy` if it is verifying, has an update pending, or already owns a diagnosis; `busy` is backpressure and is not a failure. The targeted-lane limiter arbitrates each Vitest process, with its existing bounded wait counted inside the diagnosis's 15-minute deadline; a wait that exhausts the budget yields `inconclusive`. Diagnostics start only if the coordinator has no runnable merge verify waiting and the peer's recent status is healthy. A peer missing matching installed code refuses; the coordinator does not substitute its own or a PR's scripts.

The request carries a random attempt id; exact repo, PR, head, base, target, and failed-file identities; coordinator machine id and lease epoch; verifier version and policy hash. The peer re-reads PR identity and open state, confirms the coordinator's lease, verifies each path is a current test inventory entry, and fetches only the two exact SHAs. It creates private synthetic-merge and base worktrees using the existing Local Verify bare clone and installed orchestration seams. Each tree gets `npm ci` and the minimum build needed for the test file, with isolated `TMPDIR`, `TMUX_TMPDIR`, Vitest cache, and result paths. It runs each file exactly once on each tree, with the installed trusted unhandled-error reporter. Each process and descendants must be confirmed gone before the next tree; an unknown cleanup state ends as `inconclusive` and blocks any next diagnostic on that peer until the normal orphan sweep. The worktrees and temporary state are removed on success and on a contained failure.

Limits: at most three files, one peer, one attempt per exact key, one diagnosis per peer at a time, 15 minutes total including install/build/cleanup, 90 seconds per file/tree, and at most 10 MiB combined reports. No automatic retry after a timeout or transport error; the coordinator records `inconclusive` and stops. A process killed for time still waits for bounded descendant cleanup. A peer restart tombstones its in-flight attempt; a coordinator restart restores a durable pending marker and may poll a still-running attempt, but cannot start a second one. Retain final observations for 14 days and at most 200 keys, keeping active markers until terminal or explicitly invalidated. All remaining uncertainty is reported as `inconclusive`.

## Interpretation

Each file has four observations: original PR failure on machine A, PR rerun on peer B, base (`main`) run on peer B, and the latest same-base `main` record on A if one exists. The displayed classification is conservative:

| Peer PR | Peer base | Classification | Meaning |
| --- | --- | --- | --- |
| fails same assertion/file | passes | `pr-reproducible` | The PR-specific failure reproduces on B; fix the PR. |
| passes | passes | `machine-or-flake` | A and B disagree; examine environment or flakiness. |
| fails | fails | `base-or-shared` | The base also fails on B; inspect main health and dependency context. |
| any unknown, timeout, collection error, unhandled error, mismatched file or SHAs | any | `inconclusive` | No reliable file comparison. |

This classification is advisory. A peer base pass is one file-level observation, not a green `main` verify; a peer PR pass is not a green PR verify. The API returns the raw four observations and exact SHAs alongside the label so an agent cannot report more certainty than the evidence supports.

## State, API and rollout

The lease holder owns the diagnostic queue and journal beside Local Verify's existing machine-local state. A peer owns only its one in-flight attempt and a bounded tombstone/result ledger. `GET /local-verify` shows a small diagnostic summary; `GET /local-verify/diagnosis?pr=...&head=...&base=...` returns exact-key observations or 404. Peer routes are `/local-verify/peer-diagnose` and `/local-verify/peer-diagnosis-result`, Bearer authenticated and lease checked. The new `monitoring.localVerify.failedFileDiagnosis` mode is `off|observe|auto`, default `off` on every machine. `observe` computes eligible candidates and cost without dispatch; `auto` dispatches under the bounds above. Turning it off stops new requests and allows an existing bounded child to finish; stale markers are invalidated at boot.

Ship dark. Rehearse on an isolated test agent, then one peer on Echo in observe for 24 hours and auto for one 24-hour window only if it adds no merge-slot wait and stays within the machine-time budget. Expand per host only after measured diagnostic value exceeds added machine minutes. Existing agents get config/awareness through the update migration path. The CLAUDE.md template tells agents to read exact-key diagnosis after a red record, and to treat its label as advisory.

## Tests and acceptance

1. Unit: exact-key validation, file whitelist, all caps and timeouts, interpretation table including contradictory reports, lease/head/base/version invalidation, one-attempt dedupe, retention, restart tombstone, and no mutation of the merge index from a diagnostic result.
2. Integration: real HTTP authentication and peer route plumbing; one failed-file PR/base pair through private worktrees with controlled reports; peer busy and transport failures; invalid/late/mismatched results; restart recovery; status/record separation.
3. E2E: production `AgentServer` wiring boots with mode off and a 200 read surface; an enabled fixture runs one bounded diagnosis while the original PR record stays red and the green merge gate still refuses it. Verify all installed wiring dependencies are real.
4. Full `npm run test:all` and isolated-agent rehearsal pass. Report extra machine minutes and diagnostic yield before auto activation. Do not weaken the full-suite merge gate.

## Decision points touched

| Decision point | Class | Reason |
| --- | --- | --- |
| Whether to dispatch a diagnosis | invariant | Exact file, capacity, lease and mode checks bound cost. |
| Whether an observation is comparable | invariant | SHA, file and machine identity must match. |
| How a result affects merge | invariant | It never does; only a full Local Verify record can be green authority. |

## Open questions

*(none; review may contest the 15-minute cost ceiling and the choice of automatic trigger.)*
