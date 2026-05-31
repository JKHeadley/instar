---
title: Router confirms a remote placement (placing → active) so transfers don't stick
slug: router-confirm-claim-on-place
status: approved
review-convergence: 2026-05-31T12:10:00+00:00
approved: true
author: echo
approval-note: >
  Self-approved by Echo under the standing 12h deploy mandate (topic 13481).
  Bug #11 of the multi-machine live-transfer cascade, found live: a moved session's
  ownership never left 'placing', so the laptop queued every later message instead
  of forwarding to the mini. Scoped to the single-router topology; the cross-machine
  durable ownership store (Track-H) is separate hardening. Flagged in the PR per
  cross-agent discipline.
---

# Router confirms a remote placement (placing → active)

## Problem

Found live (2026-05-31): with bugs #4/#5/#6/#8/#9/#10 fixed, "move this to the Mac
mini" forwards, the mini accepts + spawns + persists the session. But subsequent
messages for that topic logged `route … action=queued owner=?` and fell through to
local injection — the conversation never actually moved.

Root, traced through the ownership FSM (`SessionOwnership.ts`): a new-session
placement is `place` (→ status `placing`) then the owner must `claim` (→ `active`).
`SessionRouter.placeAndClaim` does the `place` and dispatches the spawn, but NOTHING
ever issues the `claim`. So the record stays `placing` forever, and
`SessionRouter.dispatchOne` routes a `placing`/`transferring` record to the
queue-and-return branch → every later message queues. This affects EVERY transfer,
not just a crashed one.

(The owner-side resume runs on the target machine, and the live ownership store is
per-machine in-memory — the shared cross-machine store is the separate, unbuilt
"Track-H" piece — so the target cannot itself advance the router's authoritative
record. In the single-router topology the router holds that record.)

## Goal

After the router places a session on a remote machine and dispatches the spawn, the
ownership record advances `placing → active` so the router forwards subsequent
messages to the new owner instead of queueing them forever.

## Non-goals

- Does NOT wire the shared cross-machine durable ownership store (Track-H) — ownership
  is still per-machine in-memory and non-durable across restarts. That is separate
  hardening; this makes the live single-router transfer FUNCTION.
- Does NOT change self-placement (router == owner → handled locally, no remote claim).
- Does NOT address bug #7 (the standby has no Telegram token → a running moved session
  is still mute).

## Design

`SessionRouter` gains an optional `confirmClaim(sessionKey, machineId)` dep. In
`placeAndClaim`, immediately after a successful `spawnOnMachine(remote)` (and only on
the remote branch — self-placement returns handled-locally and never confirms), the
router calls `confirmClaim(sessionKey, chosenMachine)`.

`server.ts` wires it to `ownReg.cas({ type: 'claim', machineId }, …)`. The FSM permits
a `claim` whose `machineId` equals the placed owner (the `place` set
`ownerMachineId = chosenMachine`), so the router legitimately confirms on the target's
behalf. Best-effort: a confirm failure leaves the placement to recover via the normal
owner-dead/stale fences.

## Testing

- Tier 1 (`SessionRouter.test.ts`): a remote placement now calls
  `confirmClaim('s1','m_remote')` after the spawn; a self-placement does NOT confirm.
  The FSM `place(placing) → claim(active)` transition is already covered in
  `SessionOwnership.test.ts`.
- 47 SessionRouter + ownership + wiring tests green; `tsc --noEmit` clean.
- Tier-3: the live re-test (fresh topic — avoids the prior stuck record) shows
  subsequent messages forward to the mini instead of queueing.

## Migration parity

Pure code (one optional dep + a call + the wiring). No config/hook/route/CLAUDE.md
change. The dep is optional → callers that don't wire it are unaffected; the pool path
is gated past `'dark'`. Existing agents get it on the v-next update.
