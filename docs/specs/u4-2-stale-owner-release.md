---
title: "U4.2 — Stale-Owner Release Path (a dark owner must not strand its topics)"
slug: "u4-2-stale-owner-release"
author: "echo"
status: "draft"
parent-principle: "The Agent Is Always Reachable — a conversation must never be stranded on a machine that has gone dark"
sibling-principles: "Verify the State, Not Its Symbol; A Refusal Stays a Refusal; Bounded Blast Radius"
parent-spec: "docs/specs/U4-mesh-self-healing-index.md; MULTI-MACHINE-SESSION-POOL-SPEC.md; MULTI-MACHINE-SEAMLESSNESS-SPEC.md"
project: "self-healing-mesh (topic 29836)"
depends-on: "fenced serving lease; Working-Set Handoff (coherence/fetch-working-set); multiMachine.meshTransport (multi-transport reachability); Autonomous Liveness Reconciler (adjacent, run-layer)"
---

# U4.2 — Stale-Owner Release Path

## 1. Problem

Topic ownership (which machine holds a topic's session) is recorded durably. When the
OWNER machine goes dark mid-work, the topic can be STRANDED: the (now-stale) ownership
record still points at the dark machine, and the healthy peer won't take over because
ownership was never released. The acute form is the 2026-07-01 24h-session-death loop
(`mesh-lease-tick-wedge` memory): a flaky peer wedged the lease tick →
`holdsLease:false` on the survivor → the liveness reconciler saw "not my topic" and
declined to revive → the session died with no takeover.

This is distinct from, but adjacent to, the Autonomous Liveness Reconciler (which
heals a run marked-active-with-no-session ON THE OWNING MACHINE). U4.2 is the
TOPIC-OWNERSHIP layer: when the owning machine itself is gone, someone else must be
allowed to claim the topic — safely.

## 2. Design

**A fenced, TTL'd per-topic ownership lease that a peer can CLAIM only when the owner
is provably gone across ALL transports.**

- **Ownership heartbeat:** the owner machine refreshes a per-topic ownership lease
  (monotonic fence token, short TTL) as part of its existing capacity heartbeat — no
  new timer. A topic's ownership record carries `{ownerMachineId, fenceToken,
  lastHeartbeatAt}`.
- **Claim precondition (the load-bearing safety):** a peer may claim a topic ONLY
  when BOTH hold: (a) the ownership lease TTL has expired (stale heartbeat), AND (b)
  the owner is **provably unreachable across EVERY advertised mesh transport** — not
  just the one rope that happened to fail. This multi-transport check is the key
  robustness upgrade and the direct fix for the single-rope-flap false-death: a
  Cloudflare flap while Tailscale/LAN are up is NOT a dead owner. **Fail CLOSED on any
  transport ambiguity** — a reachable-on-LAN owner is never declared stale; when
  reachability can't be determined, the topic is NOT claimed (the safe direction: a
  brief strand beats a split-brain double-owner).
- **Atomic takeover:** the claiming peer does a CAS on the ownership record keyed on
  the expired fence token (only one peer wins), bumps the fence, then pulls the
  topic's working set via the existing `coherence/fetch-working-set` carrier before
  resuming the session. If the old owner returns, its stale fence loses every write
  (the standard fenced-lease guarantee).
- **Genuinely-unresolvable partition:** if the owner LOOKS alive on some transport but
  is unreachable for control (can't hand off, can't be demoted), emit ONE
  Attention-queue item (dedup per partition episode — the same shape as the existing
  split-brain item), presenting the operator the demote decision. NEVER silently pick
  in this case — a wrongly-demoted live owner is a double-reply/split-brain risk.

## 3. Multi-machine posture (mandatory)

Inherently multi-machine — this IS a multi-machine feature. The ownership record is
the existing replicated placement state; the fence token makes concurrent claims
safe (CAS). Reachability is judged per-transport by the CLAIMING machine against the
owner. Single-machine install = strict no-op (no peers, so no topic is ever claimed;
the sole machine always owns its topics). The unresolvable-partition attention item
is pool-coalesced so both survivors of a 3-machine partition raise ONE item.

## 4. Tests

- `expired-ownership-lease-plus-all-transports-down-allows-claim`.
- `expired-lease-but-owner-reachable-on-one-transport-does-NOT-claim` (the anti-flap
  safety — the single-rope-flap false-death fix).
- `transport-ambiguity-fails-closed` (unknown reachability → no claim).
- `concurrent-claims-only-one-wins` (fenced CAS).
- `stale-owner-return-loses-writes` (fence guarantee).
- `working-set-pulled-before-resume`.
- `unresolvable-partition-raises-one-deduped-attention-item-never-silent-demote`.
- Single-machine: `no-peers-never-claims` (strict no-op).

## 5. Rollback / rollout

Ships dark → dry-run (logs "would claim topic N from dark owner" without mutating
ownership) → dev-agent → fleet, gated by `multiMachine.sessionPool.staleOwnerRelease`.
The dry-run stage is essential — a wrong claim moves a live conversation. Rollback =
drop the flag; ownership reverts to release-only-on-explicit-transfer (today). The
fenced-lease + multi-transport-reachability primitives are reused, not new.

## Frontloaded Decisions

1. **All-transports-down is the claim bar, not one-rope-down** — the single-rope
   false-death is the exact bug to avoid; a peer reachable on any rope is alive.
2. **Fail closed on ambiguity** — a brief strand is recoverable; a split-brain
   double-owner (two machines replying as the same agent) is the worse failure. The
   ladder always resolves toward "don't claim when unsure."
3. **Unresolvable partition → operator decision, never silent demote** — mirrors the
   existing split-brain attention item; a wrongly-demoted live owner is unacceptable.
4. **Reuse the fenced lease + working-set carrier** — no new takeover machinery.

## Open questions

None.

> TTL and the multi-transport-probe timeout are config knobs with defaults aligned to
> the existing lease TTL — frontloaded config, not open questions.
