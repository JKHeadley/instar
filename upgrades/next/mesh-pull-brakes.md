---
bump: patch
---

## What Changed

Audit fix #2 under "No Unbounded Loops" (P19): the lease transport — the
machine-to-machine "who is awake" wire — gains its missing brakes. (1) Per-peer
failure logging is now state-change-based via the new pure `PeerFailureLogGate`
(first failure / every-360th reminder / recovery-once): a down peer at the
deliberate ~5s anti-blinding pull cadence now produces ~49 log lines per day
instead of ~17,000, and previously-SILENT non-ok responses (a peer actively
rejecting us) are now visibly logged under the same bound. (2) Both transport
fetches carry `AbortSignal.timeout` — the pull loop's re-entrancy guard meant a
single hung socket would have wedged every future pull forever. The timeout
defaults to 30s and is derived from `leaseTtlMs` at the server construction
site (`min(ttl/2, 30s)`) — sized ABOVE the fleet's documented 5–40s
receiver-stall envelope after the adversarial second-pass reviewer showed a
10s default could convert a slow-but-alive peer into "no medium" and falsely
self-suspend a healthy lease holder via the renewal path. Cadence, lease, and
anti-blinding semantics unchanged.

## What to Tell Your User

If you run me on more than one machine: my logs no longer flood with thousands
of identical "can't reach the other machine" lines when a machine is down (you
get one line when it goes, a brief reminder every half hour, one when it's
back), and a single stuck network connection can no longer silently break the
machines' ability to notice each other — without any risk of a healthy machine
wrongly stepping down.

## Summary of New Capabilities

- Bounded mesh failure logging (state-change + capped reminders, recovery
  notices, rejecting-peer visibility) via `PeerFailureLogGate` — reusable for
  other fixed-cadence transports.
- Hung-socket protection on all lease-transport HTTP calls (config-derived
  abort timeout).

## Evidence

Loop-safety audit (CMT-1109) verified at source: `pullPeer` per-attempt logging
(~17k lines/day per down peer at 5s cadence — the reaper-flood signature) and
no abort signal on either fetch while `leasePulling` blocks re-entry. Reviewer
finding applied pre-commit (timeout 10s→30s + config derivation; the
false-self-suspend trace is documented in `docs/specs/mesh-pull-brakes.md`).
Tests: 22 green across `PeerFailureLogGate.test.ts` (incl. the P19
sustained-failure bound: 17,280 failures → 49 lines) and
`HttpLeaseTransport.test.ts` (AbortSignal presence pin, gated pull/broadcast
logging, recovery-once, server.ts derivation wiring pin); all pre-existing
lease suites green; tsc clean.
