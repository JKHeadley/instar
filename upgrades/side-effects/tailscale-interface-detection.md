# Side-Effects Review — Detect the tailscale rope from the interface table

**Version / slug:** `tailscale-interface-detection`
**Date:** `2026-08-19`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `not required`

## Summary of the change

`detectTailscaleIp` asked a tailscale CLI *binary* whether this machine held a tailnet address,
preferring the macOS app bundle via `resolveTailscaleBin`. On a machine carrying two Tailscale
installs (the app bundle AND a standalone/brew copy) the two CLIs talk to different daemons over
different sockets; when the preferred copy is signed out while the other daemon holds the address,
the CLI answers "logged out" and the machine advertises no tailscale endpoint. The change adds
`pickTailscaleIpFromInterfaces`, which reads the machine's own interface table for a non-internal
100.64/10 IPv4 bound to a tunnel device, and consults it BEFORE the CLI tier — which is retained as
a fallback. Files: `src/core/MeshUrlAdvertiser.ts`, `tests/unit/MeshEndpointAdvertiser.test.ts`.

## Decision-point inventory

- `MeshUrlAdvertiser.detectTailscaleIp` — **modify** — a new first tier is added ahead of the
  existing CLI tier. The function decides only whether to ADVERTISE a rope; it never decides
  reachability, never selects a rope for a request, and never blocks.

Pass-through (unchanged code, corrected input): the mesh lease layer's rope hedging, the rope-health
monitor's per-(peer, kind) classification, and `GET /health → multiMachine.syncStatus.meshEndpoints`.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

The nearest analogue is a false NEGATIVE, which is the bug being fixed: the CLI tier rejected a
machine that genuinely held a tailnet address. The new tier can only add a detection the CLI tier
missed; it never suppresses one the CLI tier would have made, because the CLI tier still runs when
the interface read yields nothing.

---

## 2. Under-block

No block/allow surface — under-block not applicable.

Two detection gaps the change deliberately does not close:

1. **Unconventional tunnel device names.** `TAILSCALE_IFACE_RE` accepts only `utun<N>`,
   `tailscale<N>`, and `ts<N>`. A platform naming its tunnel device something else falls through to
   the CLI tier — the pre-change behaviour, so nothing regresses.
2. **IPv6-only tailnets.** Only IPv4 100.64/10 is accepted, matching the pre-change contract; a
   machine with only a tailnet IPv6 address is still detected via the CLI tier or not at all,
   exactly as before.

---

## 3. Level-of-abstraction fit

Correct layer. The question "does this machine hold a tailnet address?" is a fact about this
machine's network state, so it belongs where the machine describes itself — the advertiser — and it
should be answered from the OS rather than from an application's opinion about itself.

Reading the interface table is the LOWER-level primitive that was available and unused; the previous
implementation reached for a higher-level, less reliable proxy (a CLI, which requires a binary on
disk, a working PATH, an exec, and the right daemon socket). Moving down a layer is the correction.

No higher-level gate exists that should own this: the rope-health monitor and the lease layer consume
the advertised endpoint set and have no access to the interface table. Nothing was re-implemented —
`isTailscaleCgnat` (already in `PeerEndpointResolver`) is reused for the range check rather than
duplicated.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart gate.

`pickTailscaleIpFromInterfaces` produces an advertised endpoint — a SIGNAL. It holds no blocking
authority: it cannot refuse a peer, demote a rope, or fail a lease. The authorities that act on ropes
(the lease layer's hedging, the rope-health monitor's demote/recover decisions, the recovery probe)
are untouched and keep their own evidence bars. A wrong signal here produces a rope that fails its
signed handshake and is demoted by the existing machinery — it cannot itself cause a wrong decision.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. There are no competing signals to
weigh: the address is either bound to a tunnel device or it is not. The domain is enumerable (an
invariant — a tailnet IPv4 lives in 100.64/10 and, on the platforms instar supports, on a
tunnel-shaped device), and the narrowing to tunnel device names is a safety guard against the one
known ambiguity (carrier-grade NAT on a real adapter), not a judgment about which of several live
signals wins.

---

## 5. Interactions

- **Shadowing:** the new tier runs BEFORE the CLI tier and short-circuits on success, so it shadows
  the CLI tier by design. That is safe because the two answer the same question and the interface
  table is the more authoritative source; when it yields nothing the CLI tier runs unchanged.
- **Double-fire:** none. `detectTailscaleIp` returns a single address; two tiers cannot both
  contribute an endpoint. No events are emitted.
- **Races:** none introduced. The read is synchronous, allocates nothing shared, and holds no state
  between calls. It removes a race rather than adding one — the exec-based tier could time out under
  the process-ceiling exhaustion seen on 2026-08-19 and silently return null.
- **Feedback loops:** none. The interface table is OS state that instar does not write.

Interaction worth naming explicitly: the **rope recovery probe** (U4.3) re-dials ropes marked dead.
A machine that previously advertised no tailscale rope had nothing for the probe to recover — the
rope was invisible, not demoted. After this change such a machine advertises the rope, so a genuinely
broken tailnet now surfaces as a demoted rope with a recovery episode rather than as silence. That is
the intended direction (a real state becomes visible), and it uses existing machinery unchanged.

---

## 6. External surfaces

- **Other agents on the same machine:** no change.
- **Other users of the install base:** multi-machine agents on an affected machine begin advertising
  a tailscale endpoint that was previously missing. Single-machine agents are a strict no-op (no
  peers to advertise to, and the server keeps its localhost bind).
- **External systems:** strictly REDUCES external dependency — the primary path no longer execs a
  third-party binary. No network call is added.
- **Persistent state:** none. The advertised endpoint set is recomputed per advertisement; no schema
  change, no migration, no stored value to repair.
- **Timing / runtime conditions:** improves them. The primary path removes a bounded-3s subprocess
  exec from the advertisement path, so it no longer depends on process-table headroom, PATH, or a
  daemon socket being answerable.
- **Operator surface (Mobile-Complete Operator Actions):** no operator-facing actions added or
  touched. The existing `GET /health` and `GET /mesh/rope-health` reads render the same shape.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable. No dashboard renderer, markup file, approval page, or
grant/revoke/secret-drop form is staged.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Posture: machine-local BY DESIGN, advertised across the mesh by the existing endpoint exchange.**

The reason it should differ per machine: an interface address is a fact about the machine that holds
it and is meaningless on any other. Replicating it would be actively wrong — a peer must never
conclude it has a tailnet address because a different machine does.

The pool-wide question ("which ropes does each machine have?") is already answered by the existing
advertisement + `GET /health → multiMachine.syncStatus.meshEndpoints`, which this change feeds
without altering its shape. This change is only meaningful on a multi-machine agent, which is exactly
why the single-machine-only assumption trap does not apply: the feature IS the multi-machine path.

- **User-facing notices:** emits none. The rope-health monitor owns notices and already has its own
  one-voice, episode-scoped gating; this change alters no notice text or trigger.
- **Durable state on topic transfer:** holds none. Nothing strands — a moved topic's machine reads
  its own interface table.
- **Generated URLs:** it contributes the host portion of a mesh endpoint, which is consumed only by
  peers dialling that machine directly. These are not shareable links and do not cross a machine
  boundary in a user-visible form.

---

## 8. Rollback cost

- **Hot-fix release:** revert the code change, ship as the next patch. Pure code change.
- **Data migration:** none. No persistent state, no schema change.
- **Agent state repair:** none. Reverting simply returns affected machines to advertising no
  tailscale rope; the peers' hedging falls back to the other ropes as it does today.
- **User visibility:** during a rollback window, an affected machine returns to the LAN + Cloudflare
  ropes — the pre-change behaviour, not a new regression.

---

## Conclusion

The review produced no design changes. The change moves a self-fact from an unreliable proxy (one of
possibly several CLI copies) to the authoritative source (the OS interface table), keeps the old path
as a fallback so no working detection is lost, and narrows the accepted device names to close the one
realistic false-positive (carrier-grade NAT on a real adapter). It removes a subprocess exec from the
advertisement path, which also removes a failure mode observed the same day under process-table
exhaustion. It produces a signal, never an authority. Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** not required

None of the Phase-5 triggers apply: no block/allow decision on inbound, outbound, or dispatch; no
session lifecycle, compaction, or respawn surface; not a coherence gate, idempotency check, or trust
level; and not a sentinel, guard, gate, or watchdog. It is a self-describing detection that feeds
those systems.

---

## Evidence pointers

- `tests/unit/MeshEndpointAdvertiser.test.ts` — interface-tier detection, CGNAT-on-`en0` rejection,
  CLI-tier fallback preserved.
- The existing CLI-tier tests now pass `ifaces: null` explicitly; without it they read the real
  interface table of whatever machine runs them, which is non-hermetic and would have masked this
  exact bug.
- Field observation 2026-08-19: the Studio reached the operator's laptop over tailscale at
  100.x while that laptop's own agent reported only two ropes, the tailscale one absent.
