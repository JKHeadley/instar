---
title: Machine self-assertion — how a machine states a fact about itself it cannot prove locally
slug: machine-self-assertion
status: draft
eli16-overview: docs/specs/machine-self-assertion.eli16.md
---

# Machine self-assertion

## 1. The problem, stated once

Two production failures in the same week share one shape.

**A. The lost key (2026-08-27 → 2026-08-29, two days of one-way mesh).** The Studio's
`.instar/machine/` identity files went missing. Its Ed25519 mesh keypair was regenerated;
`machineId` and public metadata were restored from the Mini's replicated copy. The three
peers still held the OLD `signingPublicKey`. Every outbound signed RPC from the Studio was
refused `401 auth-rejected:signature-invalid` (10,968 consecutive failures per rope).
Peer→Studio traffic kept working, so the mesh ran one-way and no layer noticed.

The repair required a human with filesystem access to write the new public identity onto
each peer. There is no in-product path: `POST /api/pair` is the only route that stores a
remote identity, and it requires a pairing code minted by `instar pair` on the awake
machine — which is the machine that cannot be trusted by its peers, because its key just
changed.

**B. The invisible address (2026-08-29, one machine unreachable-by-registry).** A peer
whose agent runs inside WSL sees exactly one NIC: `eth0 172.22.96.135`, a virtual address
unreachable from anywhere but its own Windows host. Tailscale runs on the Windows side,
outside the VM. The agent advertises what it can see, so it advertises an address that
cannot work, and it can never advertise `100.101.95.10` — the address every other machine
actually reaches it on — because that address does not exist in its world.

PR #1992 stopped the resulting data loss (peers no longer discard a proven rope because an
advertisement omitted it). It did not, and cannot, give the machine a way to state the
true address.

**The shared shape:** a machine must assert a fact about itself — *this is my key*, *this
is my address* — that it cannot prove from local evidence, to peers that have no
independent way to verify it. In A the proof is gone (the old private key is lost, so no
continuity signature is possible). In B the proof never existed locally (the address lives
outside the machine's namespace).

## 2. Why the obvious answer is not obviously right

The mesh already has an authenticated channel between machines: the shared agent bearer
token over TLS/Tailscale. That token is how the incident was actually repaired — an
authenticated `POST /api/files/save` to each peer.

So the tempting design is: *let a machine re-announce its identity over the bearer channel.*

The cost is explicit and must not be buried. Today a leaked bearer token grants broad API
access but **cannot forge a machine identity** — signature verification is a separate,
stronger boundary rooted in keys the token does not control. Making identity assertable
over the token collapses those two boundaries into one. A leaked token would then be able
to:

- substitute its own key for a legitimate machine's (impersonation on the mesh), and
- redirect a machine's advertised endpoints to an attacker-controlled address
  (interception of cross-machine traffic).

This is a real widening, not a theoretical one, and it is the reason this document exists
rather than a patch.

## 3. Constraints any accepted option must satisfy

1. **No silent two-day outage.** Whatever is chosen, a mesh that is refusing a peer's
   signatures must become loudly visible fast. (Note: the alert DID fire correctly on
   2026-08-28 07:31 and was buried in a 237-item attention queue — that failure is tracked
   separately and is not solved here.)
2. **A human action is acceptable; a human *discovery* is not.** Requiring an approval tap
   is fine. Requiring the operator to notice the breakage themselves is not.
3. **No new capability for an unauthenticated party.** Nothing here may be reachable
   without existing authentication.
4. **Reversible.** Every option ships behind a flag whose absence is today's behaviour.
5. **Evidence over assertion, where evidence exists.** Where a machine CAN prove something
   locally, the proof — not the claim — must be what is accepted.

## 4. Options

### Option 1 — Detect loudly, repair by hand (no new authority)

Add no assertion path. Instead:
- Classify a rope failing with `401 auth-rejected` distinctly from an unreachable one. A
  peer that answers 401 is *provably alive* and must never be graded `peer-offline`.
  Today's classifier reads a stopped heartbeat as the innocent explanation, but the
  heartbeat stopped *because* of the very fault — a signal the fault suppresses cannot
  distinguish the two cases.
- Raise a dedicated, non-coalescing alert for the key-mismatch condition, with the exact
  repair command.

**Cost:** repair still requires filesystem access to each peer, so it fails constraint 2's
spirit for a travelling operator. **Benefit:** zero new attack surface. Small, and it is
strictly required regardless of which other option is chosen.

### Option 2 — Operator-approved re-announce (one tap, PIN-gated)

A machine detecting sustained `signature-invalid` to a peer raises an Attention item with
a **dashboard-PIN-gated** approve action. On approval, the peer stores the new identity.

Proof of possession is required: the claimant signs a peer-issued nonce with the NEW key,
so approval binds the operator's decision to a specific key the claimant demonstrably
holds. The bearer token alone never suffices — the PIN is a second, human-held factor the
token does not grant, which keeps the boundary from collapsing (constraint 3, and the
existing Know-Your-Principal standard).

**Cost:** one operator tap per rotation event (rare — this is the first in the mesh's
lifetime). **Benefit:** the widening is bounded by a factor an attacker holding only the
token does not have.

### Option 3 — Continuity-chained rotation (automatic, no human)

A machine rotates by signing the new key with the OLD one; peers accept because the chain
is unbroken. Fully automatic, no new trust in the bearer token.

**This does not solve incident A.** The old private key was *lost* — that is precisely the
scenario. Option 3 is worth building for *planned* rotation hygiene, but it is inert for
the unplanned loss that actually happened. Recorded here so it is not mistaken for a
solution to the incident.

### Option 4 — Externally-observed endpoints (solves B specifically)

For the address problem, the reachable address is a fact **other machines already know**:
they connect to it successfully. Rather than letting the machine assert an address it
cannot see, let peers record the address they *observed the connection arriving from*, and
treat that observation as the endpoint.

This satisfies constraint 5 exactly — it replaces an unprovable self-assertion with
first-hand evidence held by the observer. It adds no authority to the bearer token, and
degrades safely (no observation ⇒ today's behaviour).

**Cost:** an observed source address can be a NAT boundary rather than a durable route, so
observations need corroboration (repeated, from multiple peers) before being trusted, and
must never displace a working advertised endpoint — only supplement a missing one.

## 5. Recommendation

**Option 1 + Option 4, and Option 2 only if the operator accepts the widening.**

Option 1 is unconditional: the classifier bug is real regardless, and cheap.

Option 4 solves the address case *without* touching the token boundary at all, which makes
it strictly preferable to any self-assertion design for that half of the problem. The
insight generalises: when a machine cannot prove a fact about itself, prefer moving the
question to a party that CAN observe it over inventing a way to trust the claim.

Option 2 remains the only answer for the key case, and it is the one that costs something.
It should be the operator's explicit decision, taken with §2 in front of them, not folded
into an implementation.

## 6. What is deliberately not decided here

Whether to accept the Option-2 widening. That is the operator's call.
<!-- tracked: CMT-211 -->

> **CMT-211** — Carry the machine-self-assertion decision to closure: (1) the operator's
> accept-or-decline on the PIN-gated key re-announce path, taken with the token/identity
> boundary-collapse cost stated (spec section 2); (2) classify a rope failing auth-rejected
> as a PROVABLY-ALIVE peer rather than 'offline - expected', since the heartbeat that
> grades it stopped because of the very fault; (3) scope the Tailscale key-expiry warning
> to nodes that actually back a mesh peer endpoint, so a dead unrelated tailnet node stops
> warning forever; (4) the externally-observed-endpoint path that lets peers record the
> address they OBSERVED, which is what a NAT'd or VM-hosted agent cannot assert about
> itself.

## 7. Evidence

- `logs/server.log` — 926 `[rope-probe] probe failed … auth-rejected:signature-invalid`.
- `.instar/machine/identity.json` — `keysRotatedAt: 2026-08-28T02:01:55Z`, with the
  recorded reason naming the lost private keys.
- Peers' stored copies read directly at `/api/files/read` on each machine: old
  `signingPublicKey` `MCowBQYDK2VwAyEAhPiJ…` vs current `MCowBQYDK2VwAyEAVfPs…`.
- Mama PC interface table captured on-machine: `platform: linux`, `eth0 172.22.96.135`
  only, no CGNAT address present.
- Post-repair verification: signed mesh probes to all three peers returned the typed
  `403 not-router` refusal (the exact success contract).
