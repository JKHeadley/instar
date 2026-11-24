---
title: "Isolated Codex turn observer prototype"
slug: "conversation-working-signal-prototype"
author: "echo"
status: approved
approved: true
approved-by: "Echo after six recorded reviews and independent source confirmation, for this inert review checkpoint only"
tier: 2
parent-principle: "Signal vs. Authority"
eli16-overview: docs/specs/conversation-working-signal-prototype.eli16.md
review-convergence: "2026-11-24T11:18:41.605Z"
review-iterations: 6
review-completed-at: "2026-11-24T11:18:41.605Z"
review-report: "docs/specs/reports/conversation-working-signal-prototype-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
single-run-completable: true
frontloaded-decisions: 3
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Isolated Codex turn observer prototype

## Problem statement

A native Codex turn can begin outside Instar's message-delivery observer. An isolated prototype needs to preserve the evidence already developed and let reviewers repeat the local experiment. The scope of this checkpoint is an unreachable prototype library and focused tests. It is not approval of the product [working indicator](conversation-working-signal.md).

## Frontloaded Decisions

Keep every component disconnected from production calls, native helper packaging, feature configuration, session startup, chat routes, and the browser. Keep the managed-resume hook review mismatch open. Ordinary launch and hook trust must be proved separately before any wiring or activation. Use this branch only for review and recovery of the work. Do not merge or release it. The normal TypeScript compiler can emit these unreferenced modules into dist; the checkpoint adds no packaging wiring and the normal build and release do not build or distribute the C helper.

## Proposed design

An ordered signal combines a turn/start request over the verified frontend socket, its JSON-RPC response with the exact request ID and an in-progress native turn ID, and an ordered turn/started notification with the selected thread ID and that same native turn ID. Either ordering is accepted after the request: matching response then native start, or native start then matching response. In either sequence the first fragment creates no positive and the request-ID check precedes every response turn-ID check. A late response for a discarded request is ignored without changing a later pending request, which can still confirm using its own exact response and start. A native start carries no request ID. On the selected thread, a late native start for a different turn clears the candidate once compared with the current response, regardless of arrival order. A mismatched turn invalidates the pending observation. A second overlapping request on the selected thread discards both candidates. An exact response and native start for the second request cannot make the hint positive. Only a later distinct request can create a new candidate. A mismatched turn ID or completion before response confirmation suppresses a positive. Unsupported or ambiguous observations clear both the pending evidence and any positive hint. Well-formed replies with other request IDs and notifications known to concern another thread are unrelated traffic and do not clear evidence. A skipped data message can contain completion, so a delayed native start cannot confirm a response retained from before the skip. There is no durable state and no general activity inference. The frame inspector observes bounded text and forwards unchanged wire bytes, including unobserved messages. A new signal requires subsequent exact matching evidence.

A caller-owned disposable macOS launch can start one app-server and a private Unix relay. Require positive inherited-descriptor kernel PID checks at both ends before piping. Nothing calls this in production. The native C helper is present as source only, without build or release inclusion. One caller request owns one child. On cancellation or disconnect the relay closes and the owning launch attempts to reap the child and remove its own isolated private directory through SafeFsExecutor. The disposal can wait for an OS child close; it is not a guarantee of general production shutdown latency. The client provides expected process identity, executable and effective environment as trusted fixture context. Do not generalize this proof to production inputs.

Retain the tested fixed bounds as experiment limits, not product response or capacity promises. The 64 KiB cap applies to one directional tap’s frame assembly and is not a whole-observer memory cap. The tested code accepts each retained string identifier only up to 256 UTF-16 code units and numeric request IDs only as safe integers. It keeps one selected thread and one pending correlation or thread-selection request. Identifiers are replaced or cleared on the corresponding request transition, ambiguity or disconnect, even where no visible hint was produced. The wire still passes through after the assembly cap is exceeded, and the tests cover oversize fragmented forwarding. A separate historical 4 MiB paused-client experiment was byte-exact across the isolated relay. The tracked tests below reproduce bounded fragmented forwarding and the native lifecycle, rather than the historical 4 MiB measurement. Freshness starts on receipt of the matching native start, using the injected monotonic clock. A positive establishes receipt of a correlating native start within the preceding ten seconds. It does not establish that the session is still active. Reads recompute freshness and omit a positive at 10 seconds even if no further frame arrives. A response confirming an already old start cannot make it fresh again. A pending response with no native start has no display effect. Launch and helper attempt deadlines bound their individual operations in the disposable proof. A stale or mismatched completion for the selected thread can conservatively clear the hint. Reinstate nothing until fresh correlated evidence exists.

## Decision points touched

| Decision | Classification |
|---|---|
| Accept an observation | invariant; basis: enumerable-domain; evidence: exact native start/request/response match is required to display the optional hint |
| Attach a Unix stream | invariant; basis: irreversible-consequence; evidence: unchecked peer identity could expose the conversation or allow untrusted observation |
| Limit retention | invariant; basis: external-constraint; evidence: keep frame inspection bounded, and the forwarding path stays available for over-limit bytes |
| Stop the disposable child | invariant; basis: enumerable-domain; evidence: only the exact child and relay owned by that caller are eligible to close |

## Multi-machine posture

Machine-local by design for this prototype because the observed socket and PID exist in one local kernel.
machine-local-justification: hardware-bound-resource
There are no remote responses, notices, durable state, projected URLs or agent status APIs in this checkpoint.

## Verification and exclusions

Four focused unit files cover turn ordering, helper isolation, expiry, frame bounds and actual Unix relay refusal and termination. Independent review checks no production importers, deployment reference or UI wiring. A disposable Codex TUI and loopback app-server demonstrate native completion and actual PID matching. Embedded and managed fresh Stop behavior matched in the fixture. Managed resume still pauses for hook review until explicitly approved in the disposable fixture. This is a blocker for any future product exposure. Existing full verification remains under the verification coordinator.

The reproducible focused command is `node node_modules/vitest/vitest.mjs run tests/unit/codex-working-turn.test.ts tests/unit/codex-working-protocol.test.ts tests/unit/codex-working-frame-tap.test.ts tests/unit/codex-working-relay.test.ts`. It includes same-thread overlap, delayed confirmation before and exactly at the cutoff, and clock-only expiry. The tracked review-only native fixture requires macOS, Xcode command line tools, Codex 0.171.0 and tmux. Build TypeScript using `node node_modules/typescript-native/bin/tsc`, then run `node tests/fixtures/codex-working-signal/probe.mjs --inject` for the managed path and `node tests/fixtures/codex-working-signal/probe.mjs --embedded` for ordinary startup. The fixture compiles the C peer check into its temporary directory, starts a private tmux server and configures only the repository loopback provider. Fixed-clock unit tests distinguish a turn completion from elapsed expiry. The managed fixture observes an early clear in the successful native-completion callback before the remaining freshness expires and the same blocked-then-allowed Stop decisions as the embedded fixture. Reproduce the mismatch with `node tests/fixtures/codex-working-signal/probe.mjs --resume`; require both exit 1 and the bounded fixture diagnostic containing `Hooks need review`; a general startup failure is insufficient. In contrast, `--embedded --resume` passes. No fixture requires production credentials, config or a normal agent session.

## Future product enabling criteria

Prove packaged peer verification, real SessionManager startup and teardown, launch and resume hook/approval parity, signed local read authorization, safe display and a policy for separately bounding old start evidence and already-ended turns whose completion was missed. This document settles none of those.

## Maturation plan

- **test-agent-live:** the tracked fixture runs with an isolated Codex home, local provider and private tmux server. Repeat the passing fresh run and independently reproduce the resumed hook prompt.
- **dev-agent-live:** review and replay the draft checkpoint from a disposable checkout only. No normal development-agent launch calls the prototype.
- **fleet:** no distribution, rollout or release from this review branch.
- **graduation criterion:** no promotion of this prototype branch. A separately reviewed product candidate must prove the independent enabling criteria above before seeking release.
- **dark-window:** ends when the draft is replaced by a separately approved product branch or archived. The documented resume mismatch blocks release of this checkpoint.
- **ladder:** disposable fixture, draft review, then a separately approved and separately verified product candidate.

## Open questions

*(none)*
