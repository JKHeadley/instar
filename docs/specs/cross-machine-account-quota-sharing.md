---
title: Cross-Machine Account & Quota Sharing
status: draft
tags: [multi-machine, subscription-pool, quota, placement, seat-transfer, seamlessness]
author: echo
created: 2026-06-16
related:
  - docs/specs/ws51-subscription-pool-scope.md
  - docs/specs/live-credential-repointing-rebalancer.md
  - docs/specs/MULTI-MACHINE-SESSION-POOL-SPEC.md
  - docs/specs/MULTI-MACHINE-SEAMLESSNESS-SPEC.md
  - docs/specs/live-user-channel-proof-standard.md
commitments: [CMT-1568]
eli16-overview: cross-machine-account-quota-sharing.eli16.md
lessons-engaged:
  - "Structure > Willpower (P1): extend the proven seat-transfer primitive, not a new parallel serve-routing path"
  - "Signal vs Authority: canServe is an advisory signal feeding placement authority, never a brittle blocker"
  - "reach ≠ authority (L15): cross-machine routing rides signed mesh RPC carrying this machine's identity"
  - "Comprehensive-First (P10): own the coarse-quotaState foundation gap in-scope, do not defer the load-bearing mechanism"
  - "No silent degradation: replace the 'place anyway → dead reply' all-walled path with an honest in-channel notice"
  - "Operator override outranks a prior convergence: credential SHARING is the directed primary; do not defer it"
# CONVERGENCE TAG VOID — the 2026-06-16T20:38Z convergence was for the prior
# (credential-move-deferred) design, which the operator overrode at 14:49 PDT.
# This revision (credential-sharing PRIMARY) MUST be re-converged before /instar-dev build.
prior-review-convergence-void: "2026-06-16T20:38:09.360Z (design superseded by operator override)"
---

# Cross-Machine Account & Quota Sharing

> **⚠ REVISION IN PROGRESS — read §3 first.** The operator overrode the prior
> design (2026-06-16 14:49 PDT): cross-machine credential **SHARING** is now the
> directed PRIMARY mechanism (see §3). Sections §2 (hard constraints C1/C2 framed
> as bars), §4 (Frontloaded Decisions), and §5–§12 still describe the SUPERSEDED
> seat-transfer-primary design — they will be reconciled to the credential-sharing
> primary at the next re-converge. The seat-transfer/placement machinery in those
> sections is RETAINED but DEMOTED to a complementary optimization layer (§5B).
> The prior convergence tag is VOID (frontmatter). This must re-converge before
> any /instar-dev build, AND is coordination-gated: build edits to SubscriptionPool
> / secret-sync / credential read-write must be synced with the "Subscription &
> Auth Standard" session first (shared subsystem).

## 0. Key concepts (glossary)
- **Seat** — a conversation's durable ownership + per-topic state on one machine
  (the machine that "holds" the conversation).
- **Walled** — a machine has no account with available Claude quota right now (its
  LLM circuit is open / every account is rate-limited).
- **`canServe`** — a machine can produce a reply for a given conversation: it has a
  live, non-walled account AND its adapter reaches that conversation's channel.
- **Seat transfer** — moving a conversation's ownership + state to another machine
  (the already-proven `/pool/transfer` mechanism), so the new owner serves it.
- **Dead reply** — the bug this spec kills: the user sees "🔭 working…" but no
  answer ever comes, because the owning machine can't actually serve.

## 1. Problem (operator-grounded)

Operator directive, 2026-06-16 11:49 PDT (verbatim intent):

> "the experience needs to be absolutely seamless and that includes seamlessly
> sharing all accounts and all quota across machines."

The concrete failure that surfaced it: a conversation's seat genuinely moves
Laptop→Mini (proven live — `seatMoved:true`, ownership replicated, inbound
follows ownership to the Mini). But the **Mini cannot produce the reply**,
because Claude accounts are pinned per-machine and the Mini has **zero** of the
operator's accounts. The user sees a "🔭 working…" placeholder and never a real
answer. That dead-reply IS the seam.

The end state the operator requires: **whichever machine holds a conversation
serves it from the whole pool's accounts/quota** — the user never sees "this
machine has no quota," regardless of which machine an account was logged into.

## 2. Hard constraints (load-bearing invariants — verified in v1.3.602 source)

Violating any one strands a credential or trips Anthropic enforcement.

- **C1 — Tokens are never extracted, never stored in instar's vault.**
  `SubscriptionPool.ts:17-20`; `FORBIDDEN_CREDENTIAL_FIELDS`
  (`SubscriptionPool.ts:183-194`); secret-sync excludes the Claude OAuth blob.

- **C2 — One credential blob, one config-home slot, always.**
  `live-credential-repointing-rebalancer.md §0.d` (proven live, E2 `rotated:true`):
  Anthropic rotates the refresh token on every exchange; the same lineage
  readable from two homes/machines self-destructs on first concurrent refresh.
  A naive "copy the blob to every machine" therefore strands the account.

- **C3 — Headless OAuth refresh is unreliable.** A credential parked on a
  machine that never runs the real client warm goes stale. A credential that
  lives on a machine must actually be USED there to stay valid.

- **C4 — Quota is visible cross-machine, but only COARSELY today.**
  `MachinePoolRegistry` carries `quotaState {blocked, blockedUntil, reason}` per
  peer via heartbeat + `PeerPresencePuller`. **CORRECTION from review (F1):** that
  signal is derived from `QuotaTracker.getState()` reading **only the default
  config-home's credential** — it is single-account/default-home granularity, a
  coarse boolean, NOT a per-account pool read (the deferred CMT-1416 plumbing).
  Per-account aggregate serveability is therefore **net-new work, in-scope here**
  (§5.1), not a free "extend C4."

- **C5 — Placement is quota-aware and platform/workspace-aware** (shipped this
  run, `PlacementExecutor.ts`). **CORRECTION from review (F2):** when EVERY
  machine is walled, `PlacementExecutor.ts:154-157` currently **places anyway**
  ("placing somewhere beats placing nowhere") and returns `outcome:'placed'` —
  i.e. it routes to a walled machine that then produces the exact dead reply this
  spec exists to kill. The `no-machine-serves-channel` path raises an internal
  attention item, NOT a conversational in-channel notice. So "honest degradation"
  is **net-new work** (§5.4), not a mirror of an existing fix.

## 3. Design decision: SHARE THE CREDENTIAL across machines (operator-directed primary)

> **OPERATOR OVERRIDE (Justin, 2026-06-16 14:49 PDT):** an earlier converged
> revision made "move the WORK to the logged-in machine" the answer and DEFERRED
> credential sharing. The operator rejected that as unsatisfactory: *"once the user
> logged in one time on one machine, that account should be shareable across
> machines — I've logged into the same account on multiple machines and used it,
> there's no reason this isn't possible."* He is right. This revision makes
> **cross-machine credential sharing the PRIMARY mechanism**; the convergence tag
> on the prior revision is STALE and this must be re-converged before build.

> **PRIMARY: the user logs into a Claude account ONCE on one machine; that account
> credential is securely synced to the operator's other machines so EVERY machine
> can serve from it — with zero per-machine login and free scaling. The
> refresh-token rotation hazard is handled by cross-machine coordination, not by
> avoiding sharing.**

The genuine technical facts (verified in v1.3.602 source), and why sharing IS safe:
- **Refresh-token rotation is real but NARROW** (`live-credential-repointing §0.c`
  E2 `rotated:true`; `OAuthRefresher.ts:285`): exchanging a refresh token mints a
  new one and invalidates the old. The hazard is ONLY two machines refreshing the
  **same lineage concurrently** — NOT a bar on sharing. The 8h access token
  (`expires_in:28800`) can be used by many machines at once; only the occasional
  REFRESH must be serialized.
- **This matches the operator's lived experience:** the same account works on
  multiple devices because each holds a usable grant; collisions only happen if a
  single token lineage is refreshed from two places at the same instant.
- **C1 ("instar never extracts tokens into NON-Claude-Code tools",
  `SubscriptionPool.ts:17-20`) does NOT bar machine→machine sync into the PEER's
  Claude Code** config-home. Syncing the operator's own credential, encrypted
  end-to-end, to the operator's own other machine's Claude Code is in-bounds — the
  prior revision over-applied C1. (The existing secret-sync already moves the
  operator's other secrets this way; Claude OAuth was simply never enrolled —
  `SecretMigrator.ts:42-48` omits `claudeAiOauth`. The fix is to enroll it.)

### Primary mechanism — credential sync + refresh coordination (§5A, NET-NEW, the core build)
1. **Enroll Claude OAuth into the existing E2E secret-sync** (X25519/AES-256-GCM,
   per-recipient, forward-secret — `SecretStore.ts:9-13`): the account credential
   blob (`claudeAiOauth`) is encrypted and synced to the operator's registered
   peer machines, landing in each peer's Claude Code config-home keychain slot
   (`CredentialProvider.writeCredentials` / the `CredentialWriteFunnel`). One login
   → usable on every machine. No second login, no per-machine work.
2. **Refresh-coordination lease (the rotation fix):** concurrent SERVING is free
   (shared 8h access token); but a REFRESH takes a pool-wide single-flight lease —
   the refreshing machine exchanges, then **propagates the rotated blob back to all
   peers** before releasing. A peer never refreshes a lineage it doesn't hold the
   lease for; a peer whose copy is superseded pulls the fresh blob first. This is
   the one-lineage-one-refresher-at-a-time invariant, enforced ACROSS machines
   (the live-credential-repointing work did it within one machine; this lifts it to
   the pool via the mesh coordinator).
3. **At-rest honesty:** the synced credential lands on each peer's disk (keychain
   or `.credentials.json`). Transit is encrypted; at rest it is protected by that
   machine's keychain/file perms. If a pool machine is one the operator does not
   physically control (a rented cloud VM), the operator can exclude it as a
   credential-sync RECIPIENT (residency opt-out). Stated, not hidden.

### Complementary layer — quota-aware placement / seat transfer (§5B, reuses proven primitives)
With the credential shared, ANY machine can serve, so placement is now free to put
a conversation on the best machine. The proven `POST /pool/transfer` +
`OwnershipApplier` + quota-aware placement remain — but as an OPTIMIZATION
(availability + affinity), no longer the workaround for a credential-less machine.
The earlier revision's hard-won correctness work (one-voice, epoch-fencing,
honest-degradation, operator-binding carry) is RETAINED for this layer.

Why the collapse-to-owner==server reasoning still holds for the placement layer:

- **It reuses proven primitives (Structure > Willpower).** `POST /pool/transfer`
  + `OwnershipApplier` + quota-aware placement already move a seat between
  machines and were proven live this run (`seatMoved:true`, the Mini materializes
  ownership). A serve≠owner split would invent a parallel serve-routing path with
  its own continuation, lease, and inbound-queue semantics — all net-new.
- **It dissolves the double/zero-voice problem.** The "single-negotiator lease"
  the draft cited does **NOT** govern user replies — in source it is
  `SpeakerElection`, which constrains only duplicate-prone *sentinel notices*, not
  user-initiated flows. User replies are exactly-once via per-machine ownership +
  the inbound-queue atomic claim (`PendingInboundStore`). There is no mutex
  spanning two machines. If serve and ownership diverge, both machines (or
  neither) can answer. Collapsing the split makes the serving machine the owner,
  so the existing single-machine claim + lease hold unchanged.
- **It eliminates stranded per-topic state** (topic profile, escalation hint,
  inbound queue, operator binding) — they travel with the seat through the
  existing `TopicProfileTransferCarrier` / working-set carrier, as they already do
  on a manual transfer.
- **Authority is preserved (Know Your Principal) — but the authoritative operator
  binding must TRAVEL with the seat.** The reply is produced by the machine that
  now owns the topic; that machine must resolve the *verified* operator, and the
  authoritative `TopicOperatorStore` binding is local-only (the cross-machine
  replicated copy is advisory, non-authoritative by design). So the transfer
  **carries the authoritative operator binding as part of the carrier payload**
  (§5.3, §6) — the destination adopts it as authoritative on landing, rather than
  falling back to the advisory replicated record. Without this carry the
  destination would have no authoritative principal for the topic (the NEW-1
  strand the review caught); with it, authority is genuinely preserved.
  **The carried binding is FENCED (external/codex #3 — it must not become a new
  authority-overwrite surface):** the payload is bound to `(topicId, ownershipEpoch,
  source-machine identity, monotonic version)`; the destination REJECTS a binding
  whose epoch/topic mismatches the transfer it is admitting, or whose version is
  older-or-equal to a binding it already holds (a late/stale carry never clobbers a
  fresher local authoritative write — the same ordering rule the profile carrier
  already enforces).

This makes the feature **"quota-aware automatic seat transfer"**: the same lever a
human invokes with "move this to the Mac Mini," fired automatically by the pool
when (and only when) the current owner cannot serve and a peer can — guarded by
hysteresis so a flapping account can't thrash the seat.

**Why P2P credential sync and not a centralized broker:** a centralized token
service would mean instar holding/serving the operator's Claude tokens from a
shared backend — that genuinely trips C1 (extracting tokens into a non-Claude-Code
service). P2P sync keeps each token landing only in a real Claude Code config-home
on one of the operator's own machines, encrypted in transit. So the choice is P2P
sync (in-bounds) over a broker (out-of-bounds), NOT "no sharing at all."

### Tradeoff stated explicitly
With the credential shared, the design delivers BOTH availability AND affinity:
every machine can serve, so placement is free to pick the most capable / least-
loaded machine. The only residual cost is the refresh-coordination lease (a brief
pool-wide single-flight on the occasional token refresh) — negligible vs. the 8h
access-token window.

### Rejected / deferred alternatives
- **Centralized token broker** — rejected on C1 (instar would serve tokens from a
  shared backend; P2P sync into real Claude Code homes is the in-bounds form).
- **"Move the work, never the credential" (the prior revision's primary)** —
  DEMOTED to a complementary optimization (§5B). Rejected AS THE PRIMARY answer
  per the operator override: it puts the burden back on which machine happens to
  hold a login, which is exactly the non-seamless behavior the operator rejected.
- **Serve≠owner remote-serve split** — still rejected (double/zero-voice, stranded
  state). The placement layer keeps owner==server.
- **Turn-proxy (relay each LLM turn through a peer)** — rejected on C1 (no token
  interception seam without extracting the token).
  Cross-ref: a legitimate relay seam could only come from the in-flight
  provider-substrate / subscription-path interactive-pool work — out of scope.
- **Credential MOVE (copy/relocate an OAuth blob across machines)** — **REMOVED
  from this spec, deferred to its own spec** (`cross-machine-credential-move`).
  Rationale (decision-completeness + lessons): it adds ZERO user-visible
  capability over automatic seat transfer (the reply always comes either way); it
  touches identity + external token rotation + account-loss blast radius, so it is
  **never "cheap behind a dark flag"**; and the draft's claim that it "reuses the
  already-converged swap protocol" is **false** — that protocol is explicitly
  "entirely machine-local … never violated across machines by construction"
  (`live-credential-repointing-rebalancer.md §2.6`). No cross-machine swap
  protocol exists to reuse. If the operator later specifically wants an account to
  physically RESIDE on a given machine, that is the moment for the separate spec.
- **Centralized credential service** (a token broker / Vault-style shared store,
  the common industry pattern) — rejected on C1/C2: the Claude OAuth token may not
  be extracted or centralized at all, so a broker is unavailable to us. The P2P
  seat-transfer is the adaptation forced by that constraint (external/gemini).

## 4. Frontloaded Decisions

| # | Decision | Resolution | Why forced (not taste) |
|---|----------|------------|------------------------|
| D1 | Serve unit: spawn-on-peer vs turn-proxy | **Seat transfer** (spawn-on-peer + `claude --resume` continuation, the existing transfer mechanism) | Turn-proxy re-opens C1; seat transfer reuses proven path |
| D2 | Who holds the voice when serve≠owner | **N/A — collapsed.** Owner == server; existing single-machine claim/lease holds | Removes the only cross-machine reply-mutex gap |
| D3 | Should ownership follow serveability | **Yes** — automatic seat transfer when owner can't serve, peer can | This IS the feature; the flap risk is handled by D4 |
| D4 | Flap/oscillation control | **Hysteresis + stickiness with concrete defaults** (all config-tunable under `subscriptionPool.serveFailover.*`): min seat dwell `60_000ms` (reuse `SpeakerElection.DEFAULT_DWELL_MS`); recovered-account debounce `≥ 2× heartbeat interval` before a recovered owner may pull the seat back; damping on the llm-circuit half-open probe (a single probe-success does NOT count as recovered for seat purposes — require a sustained-non-walled window); per-source failover-rate cap. Reuse the rebalancer's cooldown/fresh-data discipline for the cooldown mechanism | Quota oscillates at reset boundaries; no damping = session thrash |
| D5 | Option A credential move | **Out of scope** — deferred to `cross-machine-credential-move` spec | Adds no user-visible capability; never cheap; cited protocol is machine-local |
| D6 | Config flag | `subscriptionPool.serveFailover.{enabled, dryRun}`, sibling of `credentialRepointing`; live-on-dev / dark-on-fleet, `dryRun:true` canary | Migration Parity + dev-gate convention |
| D7 | Transport for the automatic transfer | The existing signed mesh RPC path that `/pool/transfer` already uses (`spawnOnMachine`/`sendDrain`, recipient-bound + nonce + RBAC) — never a raw Bearer fan-out | reach ≠ authority; serve is a spawn primitive |
| D8 | `canServe` trust | **Advisory candidate filter, never authority.** The elected peer revalidates its live llm-circuit/quota at seat-admission and bounces `cannot-serve` fast → try next candidate → else honest degradation. A stale/lying advert never produces a dead reply | Heartbeat is 30s–30min stale; canServe can be wrong |
| D9 | Honest-degradation notice ownership | Emitted by exactly the topic's owner/voice-holder, idempotent per (topic, walled-episode) with a coalescing window, through the existing dedup/attention path. **Cross-topic aggregation:** when ≥N topics enter a walled-episode within the coalescing window (the correlated reset-boundary case), collapse to ONE pool-level "all accounts walled — N conversations affected, resets ~<t>" notice (aggregate-don't-enumerate). **Defaults (external/codex #4):** aggregate when ≥3 topics enter a walled-episode within the coalescing window, scoped per (operator, platform/workspace) so one busy user gets ONE notice per channel not one per topic — all config-tunable. **Both terminals named:** episode closes on recovery (drain the queued inbound) OR, if no recovery before the durable inbound-queue TTL, closes via that queue's expiry loss-notice (`durable-inbound-message-queue.md`) — never an open loop | Bounded Notification + no double-voice + no flood + Close-the-Loop |
| D10 | Fail-open posture of the failover machinery | Fail-open is conditioned on whether the LOCAL machine can serve (external/codex #5 — fail-open must not become the dead-reply bug): **(a) local owner CAN serve** + failover machinery uncertain ⇒ owner serves as today (the safe no-op). **(b) local owner CANNOT serve** (certain — its own circuit is open) + failover uncertain ⇒ **honest degradation (§5.4), NEVER a silent local attempt** that reproduces the "🔭 working…" dead reply. Uncertainty about PEERS is distinct from certainty about SELF | A broken guard never strands a reply, AND never silently retries a serve it knows will fail |
| D11 | Auto-transfer consent semantics | Auto-failover targets ONLY `online + canServe:true` peers (the manual `needsConfirmation`-for-offline-target case never applies). For a topic with a LIVE autonomous run, auto-failover **inherits the autonomous-run-suspend behavior** (the owner literally cannot serve, so suspend-and-move is correct) — it does NOT silently skip the suspend | Reconcile the dropped manual consent gate on the no-operator path |
| D12 | `canServe` capability granularity (external/codex) | **v1 assumes all pool accounts are model/provider/tool equivalent** (the operator's own Claude subscriptions). `canServe` therefore covers liveness + non-walled + channel-reachability only. If a future pool mixes accounts of differing model/plan/org capability, the **admission revalidation (D8) is the enforcement point** — the destination bounces `cannot-serve` if it cannot satisfy the turn's required model/tool tier, falling to the next candidate. Capability mismatch never produces a wrong-tier reply, only a bounce | Accounts may differ by plan/model access; admission is the safe check |
| D13 | Walled-episode queue policy (external/codex) | During a walled episode the inbound is held by the existing `PendingInboundStore` durable queue — **reuse its ordering (FIFO per topic), TTL, bounded depth, and expiry loss-notice** (`durable-inbound-message-queue.md`); a newer inbound on the same topic supersedes/coalesces with the blocked one rather than fanning out stale replies on drain. No net-new queue semantics — this spec defers to the durable queue's contract | Avoid stale replies draining into an evolved conversation; bounded backlog |

## 5. Architecture

### 5.1 Per-account serveability in the capacity heartbeat (foundation work, F1)
Replace the coarse default-home `quotaState.blocked` with a derived per-machine
**`canServe`** computed from the SubscriptionPool's per-account quota across ALL
that machine's config-home slots: `canServe = ∃ account whose slot is live AND
not walled AND whose adapter can reach the conversation's channel`. Plumb it
through `MachineCapacity`/the heartbeat advert (the CMT-1416 deferred plumbing,
now in-scope). `canServe` is parameterized by a **`ServeRequirement` shape**
(external/codex #1) — v1 fills `{platform, channel/workspace, provider}`; the
contract is extensible so a future model/tool/org-tier check (D12) extends the
SAME shape rather than becoming admission-only retry logic. **Representation
(external/codex #2):** the heartbeat advert is NOT a single misleading global
boolean — it carries a small capability summary (per-platform/workspace
reachability + a "has any non-walled account" flag); the inbound path resolves the
per-topic `canServe` by a local cached lookup against that summary keyed by the
topic's `ServeRequirement`. `canServe`
**is precomputed and heartbeat-carried — never computed
live on the inbound path** (scalability F1/F4: the inbound path does only an
O(peers) in-memory pick from the cached registry; any unavoidable live read goes
through `PoolPollCache` so bursts coalesce + load-shed).

### 5.2 Channel-granular reachability (security/adversarial F9)
`canServe` reachability is evaluated at **(platform + specific channel/workspace/
bot)** granularity for the conversation in question — reuse the platform-aware
placement `servesChannels` advert scoped to the topic's channel — never
platform-coarse (a peer connected to a *different* Slack workspace is NOT a valid
server for this topic).

### 5.3 Automatic seat transfer (the core loop)
On an inbound for a topic whose **current owner is `canServe:false`** for that
topic's channel: select the least-loaded `canServe:true`, channel-reachable peer
and fire the existing validated transfer planner (`POST /pool/transfer`
equivalent, over signed mesh RPC, D7). The destination admits the resumed session
through its own guards and **revalidates serveability at admission (D8)**; on a
`cannot-serve` bounce, try the next candidate (bounded attempts) → else §5.4.

**Single decision point (composes with the inbound-queue, not beside it).** The
quota-walled trigger does NOT run a second, independent scheduler against the same
inbound row. "Owner walled" is fed as a **release-to-failover reason into the
existing `PendingInboundStore` hold-for-stability policy**, with the quota-aware
candidate as the target — so exactly one place decides hold-vs-move and one place
selects the target. This forecloses the two-uncoordinated-controllers hazard (a
held-for-wobble inbound and a quota-failover firing against different targets, or
a double-dispatch).

**Concrete herd/concurrency controls** (config-tunable under
`subscriptionPool.serveFailover.*`): the failover-trigger decision is
**single-flighted per topic** (one in-flight transfer per topic);
`maxConcurrentFailoversPerSource` (default 3) and `maxConcurrentFailoversPerDest`
(default 2) bound a burst. **Load score** for candidate selection is the existing
placement scorer (active-session count + CPU load-per-core, the `PlacementExecutor`
inputs) PLUS an in-flight-failover term (`score += inFlightFailoverCount * W`) so
consecutive picks diverge across all eligible peers rather than herding onto one.
**Retry-storm controls (external/codex #4):** a `cannot-serve` bounce applies a
short per-destination cooldown (the peer is skipped for a jittered window before
re-consideration); failover attempts carry jitter; a destination may publish a
transient `acceptingFailovers:false` backpressure flag (separate from quota) that
removes it from the candidate set without claiming it is walled. **At-cap
behavior:** defer to the next tick (the inbound stays queued per D13), falling to
§5.4 honest degradation only if the cap stays saturated past a bounded window.

Dry-run (D6) **logs every proposed transfer and the proposed destination
(including any residency decision) without performing it** — the soak surface for
verifying placement + residency before `dryRun:false`.

**Residency is a structural filter, not advisory metadata:** a machine the
operator tagged residency-excluded is removed from the `canServe`-eligible
DESTINATION set in candidate selection (§7) — it can never be auto-selected even
as the sole `canServe:true` peer (it then falls to §5.4, which distinguishes "all
accounts walled" from "quota exists only on a residency-excluded machine").

Subject to D4 hysteresis: a transfer requires the owner to be genuinely walled
(not a sub-second blip), and a recovered account does not snap the seat back until
the dwell window passes (stickiness — serve where it landed until that machine
can't).

### 5.4 Honest degradation (replaces "place anyway", F2) — the NO-TRANSFER branch
This branch is reached when NO machine can serve the topic's channel (whole pool
walled / no reachable, residency-allowed server). **No seat moves here** — so
there is no inbound-queue strand: the inbound stays durably queued **on the
owner** (where it already is) and serves on the next local recovery. Do **NOT**
place-anyway onto a walled machine. Surface the honest notice per D9 (one
in-channel notice; cross-topic aggregated at a reset boundary; both terminals —
drain-on-recovery or the inbound-queue TTL loss-notice), and branch the
`all-machines-quota-blocked` `PlacementExecutor` path so it no longer manufactures
a dead reply.

**The TRANSFER branch (§5.3) has no SQLite strand by construction:** the inbound
that TRIGGERS the transfer is re-delivered to the new owner through the pool's
existing inbound owner-routing (the durable inbound queue already routes a real
inbound to the topic's current owner machine), NOT by migrating
`PendingInboundStore` rows between machines. The transfer carries per-topic
*governing* state (next item), never the raw queue table.

### 5.5 In-flight & race handling (adversarial F3/F4)
**Handoff state machine (external/codex #2 — name the states + idempotency).** The
triggering inbound moves through one explicit per-topic state machine, so
re-delivery cannot duplicate or lose it: `queued → failover-pending → ownership-
advanced → released-to-new-owner` (or `→ released-to-honest-degradation` when no
peer can serve). The inbound carries an **idempotency key** (platform event id) so
the existing per-message exactly-once ledger drops any redelivery; `failover-
pending` has a bounded **timeout** → on expiry it falls to §5.4 honest degradation
rather than hanging. The inbound stays in durable custody (`PendingInboundStore`)
across all transitions; only the OWNER pointer advances.

- A transfer-in-flight inbound is fenced by `ownershipEpoch`: a reply is accepted
  only if the delegation/transfer epoch still matches the current owner at send
  time; a superseded epoch discards the orphaned in-flight turn (the new owner
  re-evaluates fresh) — never double-voice, never a reply under a dead epoch.
- A seat-admission that fails (peer walled between advert and admit) fails BACK to
  the next candidate, bounded, then §5.4 — never leaves the inbound in
  claimed/working limbo (the original-bug guard).

## 6. Cross-Machine Coherence (mandatory posture table)

| Surface | Posture | Path |
|---------|---------|------|
| `canServe` per-machine signal | advertised-via-heartbeat (NOT a store) | `MachineCapacity` heartbeat advert + `PeerPresencePuller`, consumed at placement |
| Seat ownership after auto-transfer | replicated | durable ownership journal + `OwnershipApplier` (existing, proven) |
| Per-topic governing state (topic profile, escalation hint) | travels-with-seat | `TopicProfileTransferCarrier` + working-set carrier (existing) |
| Authoritative operator binding | travels-with-seat (NEW carry) | carrier payload extended to move the authoritative `TopicOperatorStore` binding (not the advisory replicated copy); destination adopts it as authoritative on landing — closes the NEW-1 strand; proven in §8 wiring test |
| Pending inbound | NOT migrated — re-routed | the triggering inbound is re-delivered to the new owner via the pool's existing inbound owner-routing; `PendingInboundStore` SQLite rows never move (the no-transfer branch keeps its queue local, §5.4) |
| Other per-topic stores (TopicIntent, UsherSignal, RemoteAck) | accepted known-limitation (external/gemini #1) | These are advisory/context stores, NOT reply-blocking — the user-visible outcome (a real reply, served) is unaffected whether they travel or not. They already do not travel on the EXISTING manual `/pool/transfer`; this spec does not regress that, and carrying them is tracked with the manual-transfer carrier work (one carrier, fixed once). The automatic path does not make them *more* likely to strand — it removes the human who'd have noticed, which is why we name it explicitly here rather than leave it silent. |
| Honest-degradation notice | one-voice, owner-emitted | existing dedup/attention path; never a non-owner emit |
| Serve-failover routing decision | proxied-on-read | `GET /pool/placement?topic=N` reports serve-vs-owner + last failover reason; `GET /subscription-pool?scope=pool` for per-account quota |
| Failover audit | proxied-on-read | `logs/serve-failover.jsonl` per machine + pool-scope read |

Single-machine no-op is **structural**: the failover candidate set excludes self
and is empty on a single-machine pool → the owner serves itself unchanged,
byte-for-byte today's behavior. No peers ⇒ feature never engages.

## 7. Security (folding the security reviewer)
- Auto-transfer rides the **signed mesh RPC** (recipient-bound + nonce + epoch +
  RBAC), never a replayable Bearer fan-out (D7).
- `canServe`/`quotaState` are **untrusted peer claims**, advisory only (D8);
  placement keys on typed/clamped fields (boolean `canServe`, enum
  `quotaState.blocked`) — never free-text `reason`; peer strings stay inside the
  untrusted-data envelope, never surfaced as an instruction.
- Trust model stated on record: every pool machine is the operator's own,
  mutually trusted via mesh keypairs; a future multi-operator pool re-opens
  `canServe` verification. **Authentication ≠ trustworthiness (external/codex #3):**
  signed mesh RPC proves a peer's IDENTITY, not its health or intent — a
  compromised but still-trusted peer could become an owner and receive conversation
  state. v1 accepts the single-operator-own-machines trust floor; the operator's
  levers for a sensitive topic are the residency opt-out (exclude a machine as a
  destination) and a future per-topic sensitive-allowlist / manual-approval hook
  (named here, deferred — not built in v1).
- Data-residency honesty: a transferred seat runs the conversation (transcript,
  continuation) on the destination's disk. Transit is mesh-encrypted; at rest it
  lands on that machine's disk under its filesystem permissions. If a pool
  includes a machine the operator does not physically control (a rented cloud
  VM), the operator can exclude it from being an auto-transfer DESTINATION (a
  residency opt-out tag), distinct from excluding it from quota reads.

## 8. Testing (Testing Integrity — all tiers, not just live proof)
- **Unit:** `canServe` derivation both sides (≥1 live account ⇒ true; all walled
  ⇒ false; per-account, multi-slot); channel-granular reachability; failover
  candidate selection + herd-spread; epoch fencing.
- **Integration:** the placement/transfer route returns 200 when available, 503
  when dark; honest-degradation notice emitted once; `/pool/placement` reports the
  serve split.
- **E2E lifecycle:** "feature is alive" — dev-gated route reachable; single-machine
  no-op proven.
- **Wiring-integrity:** every DI'd component non-null, delegates to the real
  transfer planner + real heartbeat advert (no no-ops); **the carrier actually
  moves the authoritative operator binding** (assert the destination resolves the
  verified operator from the carried binding, not the advisory replicated copy —
  the NEW-1 regression test).
- **Semantic:** both sides of every boundary — owner-can-serve (no transfer) vs
  owner-walled+peer-can (transfer) vs whole-pool-walled (honest notice); flap
  damped by hysteresis; stale-canServe bounce → next candidate.
- **Adversarial (external/codex #6 + gemini #3):** duplicated triggering inbound
  during a transfer (idempotency-key drops it); stale-owner-epoch reply rejected
  (§5.5); stale/older-version authoritative-binding carry rejected (D-fence);
  peer advert lies (`canServe:true` then bounces → next candidate, never a dead
  reply); saturated failover cap → defer/recover; **admission-failure loop** (two
  peers both stale → bounded by per-dest cooldown + jitter, terminates at honest
  degradation, never bounces unboundedly).
- **Live-User-Channel Proof (§9):** the gold-standard capstone, on top.

## 9. The bar (Live-User-Channel Proof — this feature is judged by its own standard)
NOT done until a user-role session drives it through the REAL channel: operator
sends a real message to a topic owned by a machine with NO working account; the
seat auto-transfers to a pool peer with quota; the user receives a real, correct
reply — proven, signed artifact, BEFORE the operator is asked to test. Telegram
AND Slack, covering the dead-account scenario on both.

## 10. Observability (Observable Intelligence)
- `/metrics/features` keys: `serve-failover` (engaged / found-server / no-server /
  whole-pool-walled), with provider/model + fire-rate.
- `logs/serve-failover.jsonl`: one structured record per routing decision (topic,
  from→to, reason, epoch, outcome) — reap-log/credential-audit precedent.
- `GET /pool/placement?topic=N` extended with serve-vs-owner split + last failover
  reason; `GET /subscription-pool?scope=pool` already carries per-account quota.

## 11. Migration / rollout (Migration Parity + Agent Awareness)
- Config: `subscriptionPool.serveFailover.{enabled,dryRun}` added via
  `migrateConfig()` (existence-checked), registered in `devGatedFeatures.ts`
  (live-on-dev / dark-on-fleet, `dryRun:true` canary).
- CLAUDE.md: BOTH the new-agent path (`generateClaudeMd()`) AND the existing-agent
  path (`migrateClaudeMd()` with a content-sniffing guard, per Migration Parity) —
  document the auto-transfer behavior + the residency opt-out + how to read
  `/pool/placement` serve split.
- Ships dark + dry-run first (logs intended transfers, performs none); single-
  machine = strict no-op; dashboard Machines/Subscriptions tab surfaces the
  serve-vs-owner split.

## 12. Open questions
*(none — all resolved into §4 Frontloaded Decisions)*
