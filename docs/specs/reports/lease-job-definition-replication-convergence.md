# Lease job definition replication — convergence report

**Author:** echo  
**Date:** 2026-11-05  
**Rounds:** 5  
**Outcome:** internal reviewers concurred; external Codex CLI timed out and supplied no opinion.

## Iteration summary

| Round | Material findings and resolution | Standards-Conformance Gate |
| --- | --- | --- |
| 1 | Peer supplied executable authority, secret export, stale content, symlink races, partial apply, legacy jobs, and missing portability declaration. Added explicit approval, content roots, strict source projection, quarantine and admission fence. | Ran; 95 standards, 2 possible violations. |
| 2 | Coverage metadata lacked content root; approval flow conflicted; unknown manifest fields and changed bodies could leak; destination-specific approval threatened liveness. Kept content root in a separately signed bundle, defined one quarantine state machine, and required exact-content export approval. | Ran; 95 standards, 2 possible violations. |
| 3 | A machine signature could forge human approval; source revocation could not reach an offline holder; rollback would leave runnable imports. Chose destination-local operator approval, stated the offline tradeoff, and specified a pre-revert quarantine command. | Ran; 95 standards, 2 possible violations. |
| 4 | Machine-local justification keys did not match P21's closed taxonomy. Bound local approval to the machine's dashboard PIN, journal to its disk, and treated source generation as replicated metadata. | Ran; 95 standards, 4 possible violations. |
| 5 | Security, integration and lessons reviewers concurred; no material design finding remained. | Ran; 95 standards, 3 advisory possible violations. |

## Converged design

Portable user jobs require an explicit declaration and exact-root source export approval. Peers exchange only recipient-encrypted, signed bundles. The destination keeps a bundle outside scheduler paths until its own operator approves the exact root. Imports preserve local edits, fence scheduler admission during apply, and leave incomplete work visible. A machine pin remains an intentional restriction. The lease holder alerts for unapproved, missing, pinned, stale and conflicting jobs. Git-sync remains disabled; no backup transport is used.

The design makes the safety tradeoff explicit: a changed job that has not been approved on the destination may wait after an unexpected handoff. That gap is reported rather than silently skipped or executed from untrusted peer bytes. Offline receivers cannot observe a later source revocation, so they retain only their own previously approved root and show source coverage as stale.

## External review disclosure

`codex-cli` was detected with `gpt-6-astra`, but its isolated review returned `degraded: timeout`; Gemini was not authenticated. No external-model findings were used. Internal reviews covered security, integration/scalability, adversarial and lessons/decision completeness. The conformance gate ran each round.

## Left behind

- Advisory gate findings on repeated reminders and poll brakes are addressed by the existing one-hour alert floor, daily reminder ceiling, five-minute poll and durable per-peer backoff. Implementation tests must prove those bounds.
- Legacy definitions that cannot migrate safely remain visible as incomplete; they are not silently discarded.

## Implementation review addendum — 2026-11-05

The post-convergence code review tightened the filesystem, admission, and rollback plan without expanding peer authority. Collection now uses a bounded descriptor-relative Python helper and a 64-file bundle cap. A durable pending journal and apply latch withhold interrupted imports. The loader also withholds revoked, disarmed, or changed imported manifests; the scheduler rehashes all imported files immediately before admission and after an asynchronous gate. Emergency script rollback requires a stopped agent; the live route has a PIN-gated admission fence and disarm latch. Code and integration reviewers concurred after five implementation passes. The only residual limit is concurrent writes by another process with the same local project permissions, documented in the side-effects artifact.
