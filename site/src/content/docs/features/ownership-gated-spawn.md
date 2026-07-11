---
title: Ownership-Gated Spawn & Duplicate Reconciliation
description: The routing verdict becomes binding at every session-creating callsite; duplicates that slip through are detected and converged back to one owner — with every judgment call durably audited.
---

On a multi-machine pool, one machine owns each conversation — but until this
layer, that routing verdict was *advice*: the code paths that actually create
sessions never asked. The 2026-07-10 incident showed the result: an owner
machine went briefly dark, the front-door machine's router correctly ruled
"queue this, the owner is unreachable" — and milliseconds later an older reflex
spawned bootleg local sessions anyway. When the owner came back: duplicate live
sessions that every cleanup guard separately refused to touch.

This feature (spec: `ownership-gated-spawn-and-judgment-within-floors`, the
first live instance of the **Judgment Within Floors** standard) closes the gap
in three layers, all shipping **dev-gated + dry-run (observe-only)**:

## Prevention — the SpawnAdmission seam

Every conversation-bound session-creating callsite (Telegram cold-spawn, both
respawn paths, Slack inbound and recovery spawns) now consults one deterministic
admission checkpoint before creating a session. Owner is this machine → spawn.
Owner is another live machine → forward, never a local copy. Owner is
temporarily dark → never a bootleg spawn: durable-queue custody where available,
plus an honest notice to the user ("that machine is restarting — your message is
saved" / "please resend"). Broken ownership records → the spawn proceeds
(reachability beats a broken store), but boundedly: journaled, escalated once,
circuit-broken.

In dry-run (the shipping posture) the seam changes nothing — it journals what
it WOULD have done, building the soak evidence the enforcement flip requires.

## Healing — the duplicate reconciler

A background pass on the serving-lease holder detects the same conversation
live on two machines, determines the rightful owner from evidence — a deliberate
pin, the strongest admissible ownership record, a server-registered live work
run; **never "who got the last message"** — repairs the ownership record through
the replicated journal, verifies the other machine actually observed the
repair, and hands the close to the existing gated session cleanup. Every
ambiguity (both copies working, contradictory evidence, a write conflict)
escalates to the operator's Attention queue instead of guessing. A per-topic
breaker stops a flapping conversation from being reconciled forever.

## Audit — the judgment-provenance log

Every ownership decision the seam or reconciler makes is durably recorded
(what it saw, what it chose, why) in a machine-local store with a 14-day
retention. The full context never leaves the deciding machine: the HTTP surface
serves redacted rows only, and the store's directory is on a hardcoded
never-served denylist in the file routes (symlink tricks included).

## Status & observability

- `GET /pool/duplicate-reconciler` — the one status read for the whole layer:
  reconciler posture (enabled/dry-run/substrate readiness), owner-dark notice
  episodes, spawn-admission counters, breaker state, and audit-log locations.
- `GET /pool/ownership-view?key=<topic>` — this machine's own ownership record
  for a conversation (the proxy-free read the reconciler's cross-machine
  echo-verification uses).
- `GET /judgment-provenance` — the redacted decision audit (`?limit=`,
  `?sinceHours=`, `?scope=pool` merges peers' redacted rows).

All three routes are Bearer-authed and answer `503` while the layer is dark
(single-machine installs, or the fleet default before rollout).

## Rollout

Increment 1 is strictly observe-only: four flags
(`multiMachine.sessionPool.ownershipGatedSpawn`, `.duplicateReconciler`,
`.judgmentArbiters`, `.commitmentCustodyTransfer`) all default to dry-run and
ride the dev-agent gate. Enforcement (Increment 2) additionally requires the
durable inbound queue live on the machine — the admission seam structurally
cannot block a spawn without durable message custody, so "refuse" can never
mean "lose the message."
