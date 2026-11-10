---
title: Chief of Staff
description: The always-on conversation that keeps every project moving — and the replicated record store it runs on.
---

Every Instar agent is getting a **Chief of Staff**: one always-on conversation, pinned at the top of the app and the dashboard, that checks each bound project on a cadence, restarts stalled work, points drifting work back at its goal, and brings the owner only what needs them. The full design is `docs/specs/chief-of-staff-topic.md`; this page describes the pieces as they ship.

## The record store (`ChiefOfStaffStore`)

Everything the Chief of Staff knows lives in one replicated-record kind, `chief-of-staff-record` (store key `chiefOfStaff`), implemented in `src/core/ChiefOfStaffStore.ts`. It rides the same journal substrate every other replicated store uses, so each of the agent's machines reads the same facts.

The substrate merges one whole record per key by highest HLC and has no field-wise merge, so every record two machines could write concurrently is **immutable and event-keyed**, and every mutable view is **derived** by folding the union:

| Record | What it is | How the view is derived |
|---|---|---|
| `tree` | a conversation's parent link | last writer by HLC; tombstone on unparent |
| `binding` | a project's goal, definition of done, cadence, linked repos | last writer by HLC; written only by owner taps; its identity for closure purposes is its record HLC |
| `binding-lifecycle` | `closed` / `reopened` / `unpark` events | newest valid event wins; a `closed` counts only when its `bindingHlc` matches the winning binding; `reopened` and `unpark` count only from an owner tap |
| `check-event` | one check: verdict, evidence hash, progress seen, net-diff high-water mark | restart counters, park, breaker window, `nextCheckAt` and `nextActionAllowedAt` are folded from these plus the intents |
| `intent` + `outcome` | an action claim and its transition log (`executing`, `started`, `superseded`, `rejected`, `lost`, `aborted`) | the furthest legal transition present; illegal or wrong-writer transitions are ignored, so arrival order cannot change the terminal state |
| `renewal` | an owner check-in, signed by the receiving machine | lease expiry = latest signature-valid renewal + the lease length; nothing stored is trusted as an expiry |
| `graduation`, `last-tick` | pilot metrics; loop liveness marker | immutable snapshots |

Retention for the kind is **never-delete** (`rotateKeep: 0`): a dropped archive would erase a binding or the breaker's window. Volume is tiny (about one check event per project per day).

## The action protocol (`ChiefOfStaffActionProtocol`)

Every side-effecting action (restart a stalled project by injecting a continuation or starting a bounded run, redirect a drifting one) goes through one durable state machine in `src/core/ChiefOfStaffActionProtocol.ts`: `claimed → executing → started | superseded | rejected | lost | aborted`. The lease holder signs each claim; the machine that owns the conversation verifies the signature against the current lease holder and a fresh renewal, re-checks ownership, the open-intent rule and the stand-down list under the conversation lock, writes `executing` and waits for the fsync before acting, then records `started`. Recovery (`settle`) is authenticated the same way and never marks an action lost without the owner's tombstone. Unauthenticated commands write nothing. Two mesh verbs, `cos-action` and `cos-settle`, carry this between machines, and the Liveness Reconciler, the resume queue and the progress heartbeat each take an optional stand-down read so they never act on a conversation the Chief of Staff is acting on.

## What it is built on

Nothing here is a new transport or a new store. Records are written through `ReplicatedRecordEmitter` (which stamps the hybrid-logical-clock envelope and hands the record to `CoherenceJournal`), peer machines' copies are read back through `ReplicatedPeerStreamReader`, a peer's stream is applied locally by `JournalSyncApplier`, and the `chiefOfStaff` store key is on the `ReplicatedStoreReconcilerWiring` allowlist so `ReplicatedStoreReconciler` compares the folds across machines like every other replicated store. The two protocol verbs travel as ordinary mesh commands: `MeshRpc` defines `cos-action` and `cos-settle` in the command union and their registered-peer access class, and `MeshRpcClient` carries them to the conversation's owning machine.

## Waiting for durability

The action protocol must know a record is on disk before it starts a work session. `CoherenceJournal` gained two calls for that: `emitReplicatedRecordWithSeq`, which returns the record's sequence number, and `awaitDurableSeq`, which resolves only once the journal's fsync-advanced high-water mark has reached that sequence (and rejects on timeout, on a flush error, or when the journal is not active).

## The check-in loop (`ChiefOfStaffLoop`, `ChiefOfStaffEvidence`)

The loop in `src/core/ChiefOfStaffLoop.ts` runs on the lease holder only, every fifteen minutes by default, and for each bound project that is due it does the same four things in order. It **gathers** deterministic evidence through `src/core/ChiefOfStaffEvidence.ts`: pull requests merged since the last check and the net diff on linked branches (through the authenticated GitHub runner, one listing per repository per tick), the run registry, the Liveness Reconciler's condition, whether a session is alive, overdue commitments, and the conversation's timestamps plus a byte-bounded tail that is always treated as untrusted text. A source that cannot be read becomes an `unknown` item, never a zero. It then applies the **deterministic floors** (all done items pass, nothing moved for a cadence, an owner message newer than the agent's reply) and, only when those leave a question open, asks the **judge** — one metered call through the shared `LlmQueue` under its own `chief-of-staff` budget, with the bound disclosed in the prompt and a closed verdict set; the judge is a signal, and the floors overrule it. Finally it **acts** through the action protocol above: a stalled project is restarted (a bounded run, never more than the configured maximum hours, never more than two restarts per tick, and never again once the restart-without-progress cap or the weekly breaker trips), a drifting one is redirected, a project that claims done is verified against its done definition, and a project waiting on the owner is listed in the next note. Every check is a `check-event` record in the replicated store, so the fold on any machine gives the same answer.

The loop also keeps the **operator lease**: an owner message in the Chief of Staff conversation is recorded as a signed renewal, and when no renewal is younger than the configured window (72 hours by default) the loop keeps observing and writing notes but takes no action. `GET /chief-of-staff` returns the loop's health, the protocol's status and one row per bound project; `GET /chief-of-staff/projects/:key` returns one project's state, its recent checks with the evidence ids they cited, and its intent history. Both answer 503 on an agent where the feature is off.

## What is live today

The store kind is registered on every agent. The action protocol and the check-in loop are built and wired, but both sit behind the development-agent gate (`chiefOfStaff.enabled` is only honoured on an agent marked as a development agent), and the loop's renewals and notes need the pinned conversation, which arrives in the next release together with the dashboard and app surfaces. On every other agent no conversation, notice, setting or behaviour changes.
