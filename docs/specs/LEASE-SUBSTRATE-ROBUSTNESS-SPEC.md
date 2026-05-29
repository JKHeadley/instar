---
approved: false
eli16-overview: docs/specs/LEASE-SUBSTRATE-ROBUSTNESS-SPEC.eli16.md
parent-specs:
  - CROSS-MACHINE-SEAMLESSNESS-SPEC.md
  - MULTI-MACHINE-BOOTSTRAP-ROBUSTNESS-SPEC.md
---

# Spec — Lease-Substrate Robustness (durable git renewal + clean bring-up)

## TL;DR

Driving the live cross-machine handoff demo on real hardware surfaced that the
fenced lease is never durably renewed: **lease renewal confirms over the
in-memory HTTP tunnel transport and never re-writes the renewed lease to the
durable git substrate.** Because the tunnel transport is always wired, renewal
always takes the tunnel branch, so the git-committed lease keeps its original
acquire-expiry and lapses after one TTL. Any git-based observer — a freshly
joined machine, a restarted server, anyone reading the shared repo — sees the
lease expired and re-acquires it. Result: the lease bounces and a fresh join
hijacks a live holder. **This manifests on ANY multiMachine-enabled install,
including a single machine with no peers** (no observer is needed for the
durable lease to lapse; the next joiner/restart is the observer).

The fix makes the **durable git substrate the renewal floor** — but, per Round-1
convergence, NOT by writing git on every renew tick (that would be a ~2,880
commits/day write-amplification DoS). Instead: the tunnel carries the
high-frequency path, and git is refreshed **only when the git-committed expiry is
within the durable-refresh floor of lapsing** ("only-write-if-needed"). Honest
bound (R4): this is **~one durable commit per `(leaseTtlMs − durableRefreshFloorMs)`
window ≈ ¾·leaseTtlMs** — at the 60s default ~2,000–2,300 commits/day, a ~2.4×
reduction from per-tick (~5,760/day), made arbitrarily sparser ONLY by widening
`leaseTtlMs`. That sparseness trades 1:1 against failover latency (leaseTtlMs is
both the write-spacing ceiling AND the dead-holder/self-suspend bound) — for
2-machine personal use ~2,000/day against a tiny single-file repo is the accepted
design point (gc/repack handles history). NOT "O(1) per TTL". Self-suspend/liveness keys on **durable
(git) confirmation, not tunnel broadcast.** Every lease read from git is
re-verified (git is an untrusted transport; the Ed25519 lease signature is the
sole integrity boundary today). The remaining no-upstream `git pull` callsites
are swept structurally, and an automatable in-process two-coordinator test is the
binding gate (the live real-Telegram demo rides on top).

## §1 — Diagnosed root causes (code-confirmed on the live mesh, 2026-05-28)

1. **Renewal never persists to git (PRIMARY).** `LeaseCoordinator.renew()`:
   `if (this.d.tunnel) confirmed = await tunnel.broadcast(renewed); else confirmed = store.refresh(renewed)`.
   `server.ts` ALWAYS wires the `HttpLeaseTransport`, so the git `refresh` branch
   is never taken on renewal. `HttpLeaseTransport.broadcast()` returns `true` for
   a no-peer mesh, so renewal reports success while git is never updated. Git
   receives the lease only on ACQUIRE (`casWrite`), never on RENEW → to any git
   observer the lease perpetually expires after one TTL. **This is the bounce.**

2. **No-upstream `git pull --rebase` (SECONDARY).** Bare `git pull --rebase
   --autostash` fails ("Please specify which branch you want to rebase against")
   with no upstream. The lease store pulls before every CAS/refresh, so this also
   blocks renewal. The exact remaining bare callsites are **GitSync.ts {310, 312,
   375, 424, 661}** (line ~450 already takes an explicit `origin <branch>`;
   `pullRebase()` ~587/591 is already fixed). Bug #1 fixed PUSH upstream-awareness;
   PULL has the same gap. **Track B routes ALL of these through one shared
   upstream-aware helper (structural), not per-line edits.**

3. **Sub-TTL renew cadence (shipped, formalize).** Renewal previously ran only on
   the 2-min heartbeat timer while TTL is ~60s. `MultiMachineCoordinator`'s
   `leaseTickTimer` renews at `leaseTtlMs/2`; this spec keeps + tests it. NOTE:
   the renew TICK at ttl/2 is the in-memory/tunnel cadence; the DURABLE git write
   is decoupled and much rarer (see Track A).

4. **Fresh-join failover off a stale seed (shipped, formalize).** A freshly-joined
   standby evaluated failover against a stale seed `lastSeen`.
   `LeaseCoordinator.primeFromDurable()` (pull before first decision) closes the
   window; with #1 fixed (git lease stays fresh) this is belt-and-suspenders.

## §2 — Goal

A fresh multi-machine bring-up (including a solo machine with multiMachine
enabled) reaches a STABLE single-holder state with NO manual intervention; the
git-committed lease never appears expired to an observer while the holder is
alive; the durable write rate is bounded + sparse (~1 commit per ¾·leaseTtlMs
window, tunable by leaseTtlMs at a 1:1 cost in failover latency — NOT "O(1)/TTL");
a freshly
joined/restarted machine never hijacks a live holder; a git-partitioned holder
self-suspends within leaseTtlMs; and the live single-take handoff demo (operator
messages the agent; a handoff fires mid-reply; exactly one reply, no drop/double)
passes through the operator's real Telegram, with the heavy work isolated off the
production machine.

## §3 — Solution (tracks; each its own PR + 3-tier tests + migration-parity)

### Track A — Durable git renewal, write-only-when-needed (PRIMARY)

Normative requirements:

- **A1 — Durable floor, conditional + LATENCY-AWARE write, with a genuinely sparse
  cadence.** `renew()` persists the renewed lease to git **only when** the
  git-committed remaining TTL is `<= durableRefreshFloorMs` (`<=`, so the boundary
  tick fires). The floor must leave room for the write to COMPLETE before expiry:
  `durableRefreshFloorMs >= renewIntervalMs + worstCaseDurableWriteMs +
  tickJitterMs` (`worstCaseDurableWriteMs` = git pull+push p99, configurable). The
  amortized durable-write interval is `leaseTtlMs − durableRefreshFloorMs`.
  **For this to be SPARSE (not a per-tick commit-storm), the renew TICK must be
  small relative to the TTL** — otherwise (at the historical `leaseTtl =
  2·renewInterval` default) the floor's lower bound forces `floor ≈ leaseTtl`,
  collapsing the write-interval to ~one tick = ~2,880 commits/day, the very
  amplification this spec fights (R3: scalability — the earlier "O(1) per TTL"
  claim was FALSE at that ratio). Resolution: set `renewIntervalMs = min(
  ingressHeartbeatMs, leaseTtlMs/4)` and REQUIRE `leaseTtlMs >= 4·renewIntervalMs`,
  so the floor (≈ renewInterval + wcw + jitter) stays small relative to leaseTtl
  and the durable-write interval `leaseTtlMs − floor` spans multiple ticks. Honest
  bound: **~one durable commit per `(leaseTtlMs − floor)` window** (≈ one per
  leaseTtl-window), tunable sparser by widening `leaseTtlMs` — NOT one per renew
  tick. The tunnel/fast-path carries every tick in between. If git is
  read-UNAVAILABLE at a tick (partition), the conditional check cannot evaluate →
  treat as "cannot confirm durably" → the A3 self-suspend clock applies (R3:
  adversarial — read-unavailable, not just write-fail). The write-interval is
  ≈ `leaseTtlMs − floor` ≈ ¾·leaseTtlMs (floor is pinned near leaseTtlMs/4 by the
  validator), NOT ≈ leaseTtlMs. Test: with injected
  durable-write latency, the committed git expiry is ALWAYS in the future when any
  observer reads, across many cycles; AND durable commits over K TTLs ≈ K·(1 per
  leaseTtl-window), NOT K·(ticks per TTL).
- **A2 — Tunnel is accelerator, not floor.** The tunnel broadcast remains
  best-effort low-latency; it never substitutes for the durable floor.
- **A3 — Liveness keys on the git-confirmed EXPIRY, not on "did we just push."**
  The decoupling in A1 means most renew ticks legitimately skip the durable write.
  So self-suspend MUST NOT key on `lastRenewOkAt`-advances-only-on-write (that
  would self-demote a HEALTHY holder that simply wasn't scheduled to write yet —
  R2: adversarial + codex#2). Instead: a holder is LIVE while the **git-confirmed
  expiry (`lastDurableExpiry`) is still in the future**; a legit "no write needed"
  skip is a HEALTHY state that does NOT age the clock. Self-suspend fires only
  when the holder **fails an ATTEMPTED durable refresh** (the floor said write,
  the write/push failed) for the durable confirmation window. Normative binding
  invariant: the max interval between successive durable-write *attempts* (a
  function of `durableRefreshFloorMs`/`renewIntervalMs`) MUST be strictly
  `< leaseTtlMs − margin`, so a healthy holder always re-confirms before its
  durable expiry lapses. Test: a holder renewing every tick with ALL durable
  writes succeeding NEVER self-suspends, across many TTLs, regardless of the
  conditional-write cadence.
- **A4 — selfIssued clamp to EXACT VERIFIED git-confirmed expiry.** `holdsLease()`
  / `effectiveView()` clamp the effective expiry to `lastDurableExpiry` EXACTLY
  (any clock-safety adjustment must be non-positive); a machine's authority NEVER
  extends beyond what git has confirmed (R2 + codex#3). **`lastDurableExpiry` is
  sourced ONLY from a verifyLease-PASSING durable read** (R4: A5 gated authority +
  epoch-floor but not the expiry value — a planted same-epoch lease with a
  far-future `expiresAt` that fails verification must NOT inflate the clamp
  ceiling). A verify-failing durable read contributes neither authority, nor epoch
  floor, NOR expiry ceiling; the clamp falls back to the last VERIFIED durable
  expiry (mirroring `highestVerifiedGitEpoch`). Test: a planted same-epoch
  far-future-expiry lease that fails verifyLease does NOT raise the clamp ceiling.
- **A5 — Verify-on-read governs BOTH authority AND the epoch floor; + anti-replay.**
  Every lease read from the durable medium MUST pass `FencedLease.verifyLease`
  before (1) granting authority/folding into `effectiveView` AND (2) contributing
  the `gitCommittedEpoch` FLOOR passed to `acceptTunnelLease`. A durable lease
  that FAILS verification contributes neither authority nor an epoch floor —
  treat it as "no committed lease"; the floor falls back to the last VERIFIED
  committed epoch, NEVER to a tampered unsigned epoch (R2: security — a planted
  unsigned high-epoch git lease must not suppress a legit signed tunnel lease, nor
  reset the floor to 0 admitting a replay). The floor is a maintained monotonic
  `highestVerifiedGitEpoch` (advanced ONLY by a verifyLease-passing read), used as
  the floor when the current read fails verification — never the raw unverified
  `reg.lease.epoch`, never 0 (R3 codex). **Anti-replay (RESTART-DURABLE):** reject
  a durable read whose epoch is OLDER than the last-verified watermark for that
  holder. The watermark MUST survive process restart — the exact fresh-boot case
  this spec targets — so it is NOT an in-memory-only value (which would default
  empty on boot, leaving the assertion false). Anchor it on the registry's
  per-author `authoredUnderEpoch`, which `registryReplayGuard` ALREADY persists +
  enforces restart-durably; the lease floor inherits the same protection at prime
  time (R3 security). Git is an UNTRUSTED transport (commit signing self-disables
  + `verifyPulledCommits` is a no-op → the lease signature is the sole integrity
  boundary). Tests: a planted unsigned high-epoch git lease grants no authority AND
  does not raise the tunnel-acceptance floor; a RESTARTED coordinator priming from
  a git history whose HEAD lease is validly-signed-but-stale-epoch still rejects it.
- **A6 — refresh() same-epoch holder guard.** `refresh()` MUST verify the
  committed lease's holder is THIS machine (or absent) before overwriting at the
  same epoch (finding 3).
- **A7 — Confirmation semantics: solo-local vs remote-push.** On a machine with
  NO git remote configured, a local same-epoch write counts as durably confirmed
  (no push possible/needed) — so a solo multiMachine install never self-suspends
  (R1 findings 18/26/29). When a remote IS configured, durable confirmation
  requires a SUCCESSFUL push (a local commit whose push failed is NOT confirmed —
  it must not give false holder confidence; the self-suspend clock of A3 keys on
  push-confirmed durability) (codex#5). Phase-1 "alive" test: renew with a tunnel
  wired + zero peers (no remote) STILL durably persists/confirms.
- **A8 — Serving-liveness gate (input independent of lease-holding).** Renewal is
  driven only while the machine is actually serving, so a wedged-but-pushing
  holder can't stay "alive" via durable writes alone (R1 finding 14). `shouldServe`
  MUST be derived from an input INDEPENDENT of `holdsLease()` (e.g. ingress-poll
  liveness), NOT from the (A4-clamped) lease-holding state — otherwise a transient
  durable-confirm miss closes the renewal gate and becomes self-reinforcing
  demotion (R2 finding). (Re-acquire self-heals it, but the gate must not depend
  on lease-holding.) Track A INTRODUCES the signal and **WIRES it end-to-end this
  PR — not inert** (R3: a default-"always serving" stub leaves R1 finding 14, the
  wedged-but-pushing holder, unresolved, which is the whole point of A8). Concrete
  source + staleness: `shouldServe = (now − lastProcessedActivityMs) <=
  servingStalenessMs`. Crucially `lastProcessedActivityMs` is stamped on a
  COMPLETED unit of agent work (a finished inbound-message handling / a health
  self-check the wedged path cannot fake) — NOT on a successful poll/socket read
  (R4: a wedged-but-still-POLLING holder would pass a poll-based check and keep
  the lease; polling ≠ processing). `servingStalenessMs` MUST be `>=` the max
  durable-write interval `(leaseTtlMs − durableRefreshFloorMs) + margin` (R4: else
  a healthy holder mid-write-interval, with no inbound traffic, is wrongly demoted
  — so the bound is validator-checked, and a periodic internal health-tick
  satisfies it during idle). Only when NO ingress channel is configured (headless
  test) does it fall back to "serving". A wedged holder that stops PROCESSING past
  the bound stops renewing → its durable lease lapses → a healthy peer takes over.
  Test: a holder that polls but never completes processing stops durable renewal
  within `servingStalenessMs`; an idle-but-healthy holder does NOT.
- **A9 — Split-brain CAS gate untouched.** The acquisition `casWrite` strict-+1
  epoch gate and `canAcquire` are NOT modified; A1–A8 are renewal/observe-path only.

Files: `LeaseCoordinator.ts` (renew, self-suspend clock, selfIssued clamp,
effectiveView verify), `GitLeaseStore.ts` (conditional refresh, holder guard),
`MultiMachineCoordinator.ts` (serving-liveness gate). Tests: unit (conditional
write O(1)/TTL; durable-confirm self-suspend; verifyLease rejects tampered/unknown
holder; same-epoch different-holder declined; solo confirms locally),
integration (two in-process coordinators on a temp bare repo — durable expiry
advances, observer never sees expired, fresh join defers to live holder), E2E
(Track E).

### Track B — Upstream-aware pulls (structural sweep)
Route every sync-path pull through a single helper that mirrors `pullRebase()`'s
`@{u}` guard (bare when upstream set, explicit `origin <branch>` otherwise),
covering BOTH the `--rebase` callsites (`GitSync.ts` {312, 375, 661}) AND the
`--no-rebase` callsites ({310, 424}) — the helper takes the rebase mode as a
parameter so no callsite keeps a hand-rolled bare pull (R2: the sweep must not
miss the merge-pull paths). Line ~450 already takes an explicit `origin <branch>`.
The helper handles ONLY the upstream choice (bare vs explicit `origin <branch>`)
and returns/throws transparently — it MUST NOT swallow or reclassify errors, so
the existing per-callsite error routing at {310, 375, 424} (which catches
specific failure strings like "CONFLICT"/"could not apply"/"would be overwritten")
keeps working unchanged (R4). Unit: bare-vs-explicit chosen correctly for both
modes on a no-upstream branch; a conflict error still propagates to the caller's
existing handler.

### Track C — Renew cadence + durable-write spacing + STATED validator (formalize)
Change the renew tick to `renewIntervalMs = min(ingressHeartbeatMs, leaseTtlMs/4)`
(was `leaseTtlMs/2`) so the durable-write interval can span multiple ticks. Lift
`renewIntervalMs` and `worstCaseDurableWriteMs`/`tickJitterMs` into the resolved
seamlessness config so the validator can SEE them (R3: the validator referenced a
value derived only in MultiMachineCoordinator). **The validator is NORMATIVE and
EXPLICIT** — startup REJECTS the config (clear message, like the existing
seamlessness-invariant assertions) unless ALL hold:
1. `leaseTtlMs >= 4·renewIntervalMs` (room for a multi-tick durable interval);
2. `renewIntervalMs < durableRefreshFloorMs` (strict);
3. `durableRefreshFloorMs >= renewIntervalMs + worstCaseDurableWriteMs + tickJitterMs`
   (write completes before expiry — latency margin);
4. `durableRefreshFloorMs < leaseTtlMs`;
5. `(leaseTtlMs − durableRefreshFloorMs) >= minDurableWriteSpacingMs`, default
   `>= 2·renewIntervalMs` (UPPER-side bound: guarantees the durable-write cadence
   is genuinely sparse, not one-per-tick — R3: the validator had no spacing
   guarantee).
The single term **`margin`** referenced by A3's binding invariant is DEFINED here
as `worstCaseDurableWriteMs + tickJitterMs` (the same safety slack), and the A3
invariant `maxDurableWriteAttemptInterval < leaseTtlMs − margin` is validator-
enforced.

**MIGRATION-PARITY — the validator MUST NOT reject the shipped default (R4:
critical).** With the NEW `renewIntervalMs = min(ingressHeartbeatMs, leaseTtlMs/4)`
derivation, the default (`leaseTtlMs = 2·ingressHeartbeatMs` ⇒ `leaseTtlMs/4 <
ingressHeartbeatMs` ⇒ `renewIntervalMs = leaseTtlMs/4`) satisfies invariant 1
(`leaseTtlMs = 4·renewIntervalMs`) BY CONSTRUCTION, and the derived default floor
(`renewIntervalMs + wcw + jitter`) satisfies 3/4/5 at the 60s default. So the
shipped default config PASSES — the validator only rejects a config an operator
HAND-SET into a pathological combo, with a clear fix message. `migrateConfig`
re-derives `renewIntervalMs`/`durableRefreshFloorMs` for existing agents (they
were never persisted as overrides), so no deployed agent fails startup. A startup
assertion that can reject a default-derived config is itself the migration-parity
bug; the defaults are chosen to be self-satisfying and a CI test asserts the
shipped default + the documented presets all pass the validator.

### Track D — Fresh-join prime (formalize)
Keep `primeFromDurable()`; test with-vs-without priming.

### Track E — Live proof (binding gate = automatable test + manual demo)
**Binding gate:** an automatable in-process two-coordinator integration/E2E test
(real `GitLeaseStore` against a temp bare repo + real/fake tunnel) asserting: (a)
durable expiry advances over multiple renew intervals and never lapses; (b) a
second coordinator joining/reading never acquires while the holder is live; (c)
O(1) durable commits per TTL. **On top:** the manual single-take handoff demo
through the operator's real Telegram (reply work isolated to the lighter machine
to protect production — resource-isolation lesson). Manual demo is confirmation,
the automatable test is the gate.

## §4 — Conformance (six Instar standards)
- **Structure > Willpower:** correctness is structural (durable floor + verify on
  read), not a runbook.
- **LLM-Supervised Execution:** N/A substrate; the automatable Track-E test is the
  supervisor.
- **Testing Integrity (3 tiers):** every track ships unit + integration + the
  Track E E2E; the "renew durably persists with a tunnel wired + no peers" unit
  test is the Phase-1 alive test.
- **Zero-Failure:** full suite green before merge.
- **Agent Awareness:** add the `multiMachine.durableRefreshFloorMs` knob to the
  CLAUDE.md multiMachine dials list (Agent Awareness Standard).
- **Migration Parity:** the new config knob has a safe default (no action needed
  for existing agents); no schema migration; fixes ship in the dist and reach
  existing agents on update. Document the runtime durable-write-rate change.

## §5 — Rollback + interop
- **Rollback is NOT a feature toggle.** Track A is a correctness fix; reverting it
  returns the mesh to the known-broken bounce. Revert only by reverting ALL mesh
  machines together, pausing multiMachine during the revert.
- **Mixed-version interop (rolling update) — upgrade the HOLDER/awake FIRST.**
  (R3: the earlier "standby first" order was BACKWARDS.) An UNFIXED holder never
  durably renews → its git lease expires → a FIXED standby (which correctly reads
  the durable lease) would see it expired and HIJACK the live-but-unfixed holder.
  So upgrade the **awake/holder first**: once the holder is fixed it durably
  renews and its git lease stays fresh, after which upgrading the standby is safe
  (the fixed standby reads a valid unexpired lease and defers). A fixed holder
  durably-refreshing is always safe for an unfixed observer (it just sees fresher
  data). Document the (fixed/unfixed)×(holder/observer) matrix; the only unsafe
  cell is fixed-observer + unfixed-holder, which the holder-first order eliminates.

## §6 — Secondary hardening (non-blocking notes)
- Tunnel `/api/lease` ingest: rate-limit + per-holder last-verified-nonce cache
  (flood guard, finding 17).
- `/api/handoff/yield`: the authenticated sender's machineId MUST equal the
  `pendingFrom` from `/api/handoff/begin` (finding 6).
- `checkForUnresolvableSplit`: key `cannotAdvance` on durable-medium reachability,
  not tunnel-only, now that git is the floor (finding 20).
- Tunnel-path replay watermark (`HttpLeaseTransport.lastNonceByHolder`) is
  in-memory and resets on restart — A5's restart-durability covers only the git
  path (R4). This is ACCEPTED + bounded: `effectiveView` folds a tunnel lease only
  when `obs.lease.epoch > gitEpoch` (strict) and the git floor is read fresh on
  boot, so a post-restart tunnel replay at/below the durable floor is
  non-authority-bearing. Documented, not fixed (low residual risk).
- Operational: the lease/registry bare repo accrues ~2,000–2,300 lease-renew
  commits/day at the 60s default (~730k/yr) (R4 — the gc note must not understate
  this). Mitigation: periodic `gc`/repack on the bare repo, AND/OR widen
  `leaseTtlMs` (fewer commits, at a 1:1 failover-latency cost). For a 2-machine
  personal mesh this is acceptable; a many-machine deployment should widen the TTL
  or use a dedicated lease ref. State the rate explicitly so operators choose
  knowingly.

## Notes
Partial fixes for #2/#3/#4 already landed on PR #489 (honestly labeled partial).
This spec completes the set with the PRIMARY fix (#1, write-only-when-needed +
durable-confirm self-suspend + verify-on-read) + the structural sweep + the
automatable gate. Convergence Round 1: 38 findings (35 material) across 5 internal
reviewers; this revision integrates all material findings.
