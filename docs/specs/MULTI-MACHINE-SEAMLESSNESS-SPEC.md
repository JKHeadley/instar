---
title: "Multi-Machine Seamlessness — Unified Gap-Closure Spec"
slug: "multi-machine-seamlessness"
author: "echo"
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
eli16-overview: "multi-machine-seamlessness.eli16.md"
principal-deferral-approval: <!-- tracked: CMT-1413 -->
  - deferral: "WS5.2 account follow-me (credential-bearing cross-machine enrollment)" <!-- tracked: CMT-1413 -->
    sign-off: "operator pre-approval, topic 13481, 2026-06-12 13:16 PDT (Justin: full pre-approval for this initiative's decisions)"
    commitment: "CMT-1413"
    plan: "own focused security convergence round before ANY credential-bearing code; flag multiMachine.accountFollowMe reserved-dark"
  - deferral: "WS2.3 PII transport/at-rest details (relationships + user registry replication)" <!-- tracked: CMT-1413 -->
    sign-off: "operator pre-approval, topic 13481, 2026-06-12 13:16 PDT"
    commitment: "CMT-1413"
    plan: "own security convergence round before the WS2.3 store ships; boundary (encrypted transit, receiver revalidation, origin-tagged rollback) fixed in this spec"
lessons-engaged:
  - "P3 Migration Parity: every flag via migrateConfig(); WS3.2 backfill ships its PostUpdateMigrator entry in the same PR; CLAUDE.md additions via migrateClaudeMd() (see Migration & Awareness)"
  - "P8 UX & Agent Agency: WS1.4 needsConfirmation is context-before-consent; every refusal pairs with a recovery path (WS4.3 re-route-or-attention, WS1.2 honest forced-close notice, WS5.1 agent-driven enrollment) — no dead ends"
  - "P4 Testing Integrity: three tiers per workstream + named invariant tests (exactly-one-owner, exactly-one-speaks, single-machine no-op, burst-invariant, P19 sustained-failure)"
  - "P5 Agent Awareness: every agent-facing surface ships generateClaudeMd() + migrateClaudeMd() entries with proactive triggers"
  - "P7 Observable Intelligence: every autonomous decision (forward, drain, reconcile, merge, refusal) emits feature metrics + audit lines"
  - "P10 Comprehensive-First: WS5.2 and WS2.3-transport are principal-approved deferrals to focused convergence rounds; NO recurrence-risking credential/PII code ships from THIS spec's PRs" <!-- tracked: CMT-1413 -->
  - "P17 Bounded Notification Surface: pool-merged attention engages the budget AT THE MERGE POINT; all new notices carry pool-deduped episode keys + burst-invariant tests"
  - "P19 No Unbounded Loops: this spec PATCHES the closeout reaper foundation (breaker added); every new loop declares backoff/breaker/cap in-component with sustained-failure tests"
  - "L8 Active Follow-Through: WS3 fails toward speech-with-dedup, never silence"
  - "L13 Zombie-cleanup lesson: drain/closeout act only on ownership signals, never blind ticks"
  - "L15 Authorization: every new mesh verb gets an explicit RBAC class; reach ≠ authority (receiver revalidates)"
review-convergence: "2026-06-12T20:55:25.113Z"
review-iterations: 3
review-completed-at: "2026-06-12T20:55:25.113Z"
review-report: "docs/specs/reports/multi-machine-seamlessness-convergence.md"
approved: true
approved-by: "operator pre-approval — Justin, topic 13481, 2026-06-12 13:16 PDT: 'You have my pre-approval for all decisions needed... proceed with implementing all of these and building them out' (exercised by Echo in the pre-approved autonomous run; operator may revoke)"
---

# Multi-Machine Seamlessness — Unified Gap-Closure Spec

**Status:** converged (3 iterations, 2026-06-12) — see `docs/specs/reports/multi-machine-seamlessness-convergence.md`
**Owner:** Echo (autonomous run, topic 13481, 2026-06-12 — operator pre-approved)
**Source audit:** `docs/research/multi-machine-ux-gap-audit-2026-06-12.md` (findings F1–F23)
**Parent project:** `org-ready-agent-employee` (Phase A item 1)

## The unifying goal (operator's words)

> "An agent having multiple machines it can run on should NOT affect the user
> experience. From the user's perspective interacting with the agent should still be
> an experience of interacting with a single, coherent being."

The operator's four-goal frame (2026-06-11): invisible to the user · one dashboard ·
intelligent secure syncing · all channels.

## Boundary with the Durable Inbound Message Queue spec (NO overlap)

`docs/specs/durable-inbound-message-queue.md` (converged, in flight) owns: durable
custody of inbound messages, the hold-for-stability policy, drain ordering, loss
reporting. This spec builds the layers AROUND that queue. **Hard dependency gate:**
WS1.1 attaches to that spec's `dispatchInbound()` seam and MUST NOT start until the
durable-queue implementation is merged to main and `dispatchInbound(msg, opts)` is the
canonical inbound entry point — if the seam's shape changes at merge, WS1.1 follows
the merged shape. A CI precondition (grep-gate for the seam symbol) guards the WS1.1
branch. WS1.1 extends the seam's verdict handling; it never re-implements routing in
`onTopicMessage`.

## Custody & identity invariants (cross-cutting, normative)

These bind every workstream:

1. **Single custody.** At every instant, exactly one machine holds durable custody of
   an inbound message. A forward is an acknowledged custody transfer: the sender
   retains its durable copy until the receiver durably accepts (queue-write or
   inject-receipt), then deletes. A receiver that is releasing ownership REJECTS
   custody (bounce to sender's queue) — never a silent swallow.
2. **One logical message id.** The platform event id threads the entire custody chain
   — ingress ledger, forward, queue, drain, spawn-inject — and EVERY domain dedups on
   that same id. Idempotency is asserted end-to-end (one test drives a message through
   forward→queue→transfer→drain→inject and asserts exactly-once delivery).
3. **Exactly one owner.** After any reconcile/transfer/release sequence, every topic
   with queued or pending messages has exactly one owner (or a tombstone with a named
   adopter — see WS1.3). Invariant test required.
4. **Epoch fencing.** Every cross-machine ownership-bearing operation (forward, drain,
   release, ack-route) carries the ownership epoch; receivers reject stale-epoch
   operations (bounce, never act).
5. **Pool flag coherence (WS1/WS3/WS4.3 + journal kinds).** Correctness-critical
   workstreams cannot be half-enabled across a pool. The capacity heartbeat
   (`MachineCapacity`) gains a bounded `seamlessnessFlags` summary field; **absent =
   the peer predates this spec = flag-state-off for every workstream** (a
   never-reporting peer is a non-participant, not a match). The advertisement rides
   the same authenticated (Ed25519) envelope as mesh RPC — a forged downgrade is not
   possible from an unauthenticated source — and every flag flip is audited (P7), so
   a pool-wide downgrade is detectable, never silent. A machine participates in
   mesh-forward/owner-gating ONLY with peers advertising the same flag state. Flag
   coherence ALSO gates replicated-journal-kind emission: the journal applier silently
   drops unknown kinds (forward-compat), so a new kind is emitted only to peers
   advertising the matching `stateSync.<store>` / `seamlessness.<ws>` flag — "silently
   dropped by an old peer" is the NAMED skew-failure mode these gates exist to
   prevent. Mixed pools degrade to the conservative side: durable queue where
   available, else today's exact behavior — never naive inject alongside forwarding
   and never gates without a speaker. A boot-time pool-flag-coherence check logs (and
   surfaces once) any mixed state.
6. **Single-machine strict no-op.** On an agent with no registered peers (pool dark or
   size 1), no workstream's code path is ENTERED (guard on pool membership, not just
   the flag). One no-op test per workstream proves zero behavior delta single-machine.

## Workstream 1 — The conversation follows ownership (correctness core)

**WS1.1 Dispatch-to-owner integration (closes F1, F20).**
At delivery time the inbound path consults topic placement BEFORE selecting a session:

- **Ownership resolution is a LOCAL read** (the journal-backed placement view) with a
  hot-path budget of sub-millisecond in-memory access — NEVER a synchronous mesh call.
  A placement record is usable only if fresh by epoch (within the current lease epoch
  or explicitly re-confirmed); an older record means "unknown".
- **owner == local** → inject locally (today's path). The local topic→session registry
  is consulted only AFTER ownership says local; auto-spawn fires only on the owner.
- **owner == another live machine** → async bounded forward over the mesh
  (transport decided: the mesh RPC lane the pool transfer planner uses — see Decisions)
  under the custody contract (invariant 1). The forward NEVER blocks the ingress loop:
  it is handed to an async forwarder with a per-forward timeout; on timeout or
  saturation the message spills to the durable queue (`queued`).
- **ownership unknown / mid-move / disputed** → durable queue. **Fail-safe is the
  QUEUE, not local inject.** "Classification failed" and "ownership says local" are
  distinct verdicts; only the latter injects. (Round-1 critical: the old fail-open
  default silently re-opened F1.)
- **Forward TTL:** every forwarded message carries a hop counter, max 2 hops. On
  exceeding it (placement ping-pong — two machines disagree), the message goes to the
  durable queue with reason `placement-disputed` and ONE deduped attention item is
  raised ("machines disagree on owner for topic N"). Never a third forward.
- **Custody bounce discipline:** a custody-rejection bounce (receiver is releasing)
  counts against the same hop budget, AND the bounced message is parked in the durable
  queue with reason `owner-releasing` — it is NOT re-forwarded until a NEW placement
  epoch is observed. Bounce↔forward cycling against the same epoch is impossible by
  construction.
- **Transport note:** the forward reuses the existing `deliverMessage` mesh verb
  (which already carries `ownershipEpoch`); no new verb for the forward itself.
- **Version skew:** forwards carry the mesh protocol version; if the owner peer does
  not advertise the WS1.1 receive capability (old version), the sender degrades to
  TODAY'S behavior (local inject) — the pre-WS1.1 pool-wide semantics, never a drop.
  The skew matrix (new→old, old→new, mixed-flag) is part of the test plan.

**WS1.2 Active-topic transfer completes (closes F2).**
Transfer of a topic with a live session becomes a planned handoff:

1. Pin + ownership move (today), 2. inbound redirects to the new owner (WS1.1) so the
old session stops accruing work, 3. the old session gets a **drain signal**, 4. the
new owner spawns on first delivered message with CONTINUATION context.

- **Drain is a barrier:** inbound arriving during drain is QUEUED (not delivered to
  the new owner) until the old session's final context flush is durably replicated;
  then the queue releases to the new owner. No stale-checkpoint continuation.
- **Drain authorization:** the drain signal is issued only by the transfer planner
  (router-authority), epoch-bound to the specific transfer; a stale or replayed drain
  (e.g. after a transfer-back) is rejected by epoch fencing. **Protocol surface:** the
  drain is a NEW mesh verb with its own router-only RBAC case (`drain-unauthorized`
  refusal reason) and bumps the seamlessness protocol version. Skew degrade: an old
  peer that 501s the unknown drain verb → the transfer falls back to today's
  idle-closeout-only behavior (the topic is never stranded; the WS1.2 guarantees
  simply wait for the pool to finish updating).
- **Drain terminal semantics:** the drain has a hard bound. If the old session reaches
  a turn boundary within it → clean close. If not (wedged, infinite tool chain): the
  session is force-closed at the next safe write boundary (hard-kill if wedged), the
  transfer COMPLETES, the partial state rides the carrier marked
  `interrupted-mid-task`, and ONE honest notice reports it. "Half-transferred forever"
  is not a terminal state.
- **Emergency stop during drain:** aborts the drain, the topic stays on the OLD
  machine (transfer marked failed-needs-retry), nothing is left split.
- **Closeout coupling + P19 foundation patch:** the old-session closeout fires on the
  ownership-moved signal gated on drain completion — not on an independent reaper-tick
  cadence. The existing closeout retry loop (SessionReaper) gets the missing P19
  breaker IN THIS WORKSTREAM: after N consecutive vetoed closeout attempts on the same
  session, retries stop and ONE degradation notice surfaces ("topic moved to X but the
  old session won't drain — still finishing Y"). Sustained-failure test required
  (permanently-vetoing session → bounded attempts + one escalation).

**WS1.3 Ownership reconcile + honest pending state (closes F3).**

- `GET /pool/placement` grows `pendingReplacement: true` + `reason` whenever pin and
  owner disagree.
- **Authenticated pin provenance:** a pin can trigger owner self-release ONLY when its
  provenance is the router/operator transfer path (the `transfer` verb is already
  router-only); a pin merely present in the replicated journal is NEVER sufficient.
  (Round-1 critical: forged-pin ownership theft.)
- **Reconcile rules:** only the CURRENT owner releases; it acts on the LATEST pin by
  lease-epoch/sequence with a debounce window (topic-profile debounce pattern); the
  release is CAS-conditional on still-being-owner. Release is a transfer-of-custody to
  the named successor (place→claim for the pinned machine), or — if the successor is
  unreachable — an explicit `unowned` tombstone that the LEASE-HOLDER is responsible
  for adopting within a bound. Exactly-one-owner invariant test (invariant 3).
- **Convergence deadline:** `pendingReplacement` carries `since`. The force-win path
  is tightly conditioned: it requires (a) the SAME authenticated pin provenance as
  self-release — an unauthenticated journal pin can never force-win, even after
  timeout — and (b) POSITIVE evidence of owner death: the owner's lease has lapsed /
  N missed heartbeats / a failed direct liveness probe. A reachable-but-slow owner
  (GC pause, heavy turn) is NEVER fenced out mid-turn — it gets the WS1.2 drain
  handoff instead. When force-win fires, the authority is the LEASE-HOLDER (the
  tombstone-adoption path), executed as a fenced epoch increment the stale owner
  cannot override on return. Tombstone adoption is CAS-conditional on an EPOCH-STABLE
  lease — adoption defers (bounded backoff) while the lease epoch is advancing or
  contested. If the lease-holder itself is partitioned away past the adoption
  deadline, a quorum member may attempt the fenced claim (arbitrated by the
  replicated journal under the exactly-one-owner invariant). Pin≠owner divergence
  cannot outlive the bound. Consumers that key on ownership (closeout) treat
  pin-conflict as "do not act" — bounded by the same deadline, after which they
  follow the converged owner.
- **"Next safe point"** is bounded: end of current turn or T seconds, whichever first.

**WS1.4 Autonomous runs survive (or veto) topic moves (closes F17).**

- **Precedence (decided):** the autonomous-run veto is evaluated FIRST, at
  transfer-request time, BEFORE any drain begins. Default = REFUSE with
  `needsConfirmation` ("autonomous run in flight on <machine>, N minutes remaining —
  move anyway?").
- Confirmed/forced move: the old machine's run stops at a turn boundary; the state
  file is captured ATOMICALLY (fsync'd snapshot + content hash — never a live
  mid-write file) and rides the working-set carrier. The receiving machine verifies
  hash + schema before resuming and REFUSES a torn file with an honest report
  ("resumed from last consistent checkpoint; final turn may be lost") rather than
  resuming corrupt state. Forced-move-while-wedged: kill + ship last consistent
  checkpoint with the same marker. Never strand a `.local.md` on a non-owner; never
  double-spawn (the run registry keys on topic ownership).

## Workstream 2 — One memory (the agent's mind follows the user)

One generic **replicated-store layer** on the coherence-journal replication, with
per-store merge semantics. SQLite stores replicate at record level via their JSONL
source-of-truth or an export feed — never file-level copy.

**Normative mechanics (all stores):**

- **Ordering: hybrid logical clocks (HLC), never raw wall-clock.** Merges order by
  HLC; any incoming record whose timestamp exceeds the receiver's clock by more than
  the pool's measured skew bound is flagged skew-suspicious and quarantined for the
  divergence surface. (Round-1 critical: a fast clock must not win every merge.)
- **Receiver-side validation gate:** every inbound replicated record passes
  schema/integrity validation BEFORE merge; failures are QUARANTINED. Replication
  carries reach, not authority: a peer can only replicate records IT authored for its
  own store (first-hop binding + receiver revalidation); a peer-supplied channel-uid
  remap or identity-bearing field is revalidated and NEVER accepted as authoritative
  on its own (L15).
- **Quarantine is itself bounded:** a ring store with max entries/bytes,
  oldest-eviction plus a loss counter; quarantined records COALESCE by
  (peer, failure-class) signature — a stuck clock produces one growing counter, not N
  rows — and surface as ONE rate-limited attention item per (peer, failure-class),
  never per record. A peer exceeding a quarantine-rate threshold trips the per-peer
  sustained-failure breaker (its replication stops being accepted) rather than
  accumulating forever.
- **Origin tags + rollback:** every merged record carries its origin machine id, and
  replicated records live in namespaced storage that local reads UNION. Disabling
  `multiMachine.stateSync.<store>` atomically drops the foreign namespace — a real
  un-merge, not a flag wish. (Round-1 critical: merged-store rollback.)
- **Divergence handling:** concurrent edits to the same record discovered at
  partition-heal are APPEND-BOTH-AND-FLAG for the high-impact stores (preferences,
  relationships) — both versions preserved, conflict marked, ONE deduped attention
  item raised (not a 24h-latent digest line). Lower-impact stores (scores, manifests)
  may use field-level HLC-wins with the divergence flag. Append-both is IDEMPOTENT on
  (record-key, version-pair) — re-discovering the same unresolved conflict never
  appends a third copy — and a conflict recurring past a threshold escalates to a
  forced operator resolution rather than re-appending. **Resolution path:** every
  flagged conflict carries a stable conflict id; an authenticated
  `POST /state/resolve-conflict` lets the operator designate a winner or supply a
  merged version, with a dashboard surface exposing open conflicts. Unresolved
  conflicts are bounded, visible, and resolvable — never an accumulating contradiction
  in the agent's identity.
- **Bounds (per store, in-component, tested):** max entries per sync batch, max bytes
  per store, replication rate cap with coalescing (replicate latest state per record
  per interval, not every intermediate write). **Journal-kind discipline:** each new
  replicated store/record class is a NEW JournalKind whose retention + rate-cap entry
  ships in the same PR — and this governs EVERY new replicated kind in this spec (WS2
  stores, WS4.1 ack records, WS4.3 claim leases, WS1.3 ownership/reconcile records,
  WS1.4 autonomous-run ownership), all counted inside ONE aggregate replicated-journal
  budget (config-declared ceiling) with a test enforcing the budget across kinds.
  Sustained-failure breaker when a peer rejects repeatedly.
- **Dark-peer accumulation:** replication to an unreachable peer does NOT buffer
  unbounded history; past the retention window the recovering peer re-syncs via
  snapshot-then-tail (pull a compacted snapshot from the live peer, then tail the
  journal). Snapshot build and replay run OFF the event loop (worker/chunked, bounded
  batches) — the instar#1069 lesson applied at design time. Snapshots are REUSED
  within a minimum-rebuild window (a flapping peer reconnecting repeatedly serves the
  cached snapshot) with a per-peer snapshot-build-frequency breaker.
- **Union-reader discipline:** the local+replicated UNION is implemented at the LOWEST
  store-access primitive for each store, so no existing caller can bypass it — per
  store, an audit confirms every read callsite routes through the union layer, locked
  by a wiring-integrity test (no direct-path reader remains). This is what makes the
  namespaced un-merge rollback real for every consumer.
- **Dry-run:** every store's merge path has a dry-run mode (log intended merges
  without writing) on the graduated rollout track.

**Stores:** WS2.1 preferences+corrections (F9; self-violation signals stay local) ·
WS2.2 learnings/semantic memory (F10) · WS2.3 relationships+user registry (F12 — see
PII note) · WS2.4 knowledge base (F11 — manifests replicate; bodies fetch on demand
via working-set pull, HOLDER-AUTHORIZED: the holder decides whether to serve each
body, same posture as WS4.4's holder-authorizes rule, inheriting the working-set
carrier's size/concurrency/credential-flag refusals — manifest visibility is NOT body
entitlement; a body whose holder is offline returns an honest "temporarily
unavailable from <machine>", never a silent miss) · WS2.5 evolution queue (F13 —
append-only, observe/merge ONLY: an action authored on machine A is NEVER auto-executed
on machine B; TaskFlow v2 sync out of scope) · WS2.6 playbook items (F15 — scores
merge by max).

**PII & content safety:** WS2.3 records ride the per-recipient e2e-encrypted
secret-sync transport. This is TRANSIT confidentiality only — at rest the replicated
records carry the same protection as locally-originated PII; replication widens the
number of machines holding PII and that exposure delta is accepted explicitly by the
operator (deferral note below). Replicated knowledge-base bodies and evolution-action <!-- tracked: CMT-1413 -->
text are quoted UNTRUSTED DATA on the receiving machine (cartographer-style
neutralization), never instructions.

**Phasing:** 2.1+2.3 first, then 2.2, then 2.4–2.6, each dark behind
`multiMachine.stateSync.<store>`.

## Workstream 3 — One voice (never two machines answering)

- **Exactly-one-speaks invariant (both directions).** The owner machine speaks for a
  topic. If ownership is unknown, orphaned, or mid-flip at emission time, the gate
  FAILS TOWARD SPEECH-WITH-DEDUP: the lease-holder speaks (deterministic tiebreak:
  lowest machineId if the lease is also ambiguous). "Unknown owner" never maps to
  pool-wide silence. **Lease-stability dwell:** while the lease epoch is advancing or
  contested (a flap), emission is DEFERRED with bounded backoff rather than spoken on <!-- tracked: CMT-1413 -->
  a transient lease read, and once a speaker is chosen its identity is HELD for a
  dwell window — a mid-flap flip cannot hand the microphone back and forth across
  successive emissions. Invariant test asserts ≥1 AND ≤1 speaker for every due
  commitment/presence emission, including under a flapping lease. (Round-1 critical:
  the silent-agent dual of double-voice.)
- **WS3.1 PresenceProxy machine gate (F18):** ownership filter at emission time, same
  pattern as PromiseBeacon, with the fail-toward-speech rule above. Single-machine
  no-op: gate inert when `currentMachineId` unset or pool size 1.
- **WS3.2 PromiseBeacon owner population (F19):** commitments record `ownerMachineId`
  at creation. Owner is RE-RESOLVED live at speak-time from placement (the stamp is
  the fallback when placement is unavailable), so a backfill racing a transfer cannot
  wedge the gate. The PostUpdateMigrator backfill (from topic placement at a stable
  epoch) ships IN THE SAME PR (P3), with a migration test and dry-run report mode.
- **WS3.3 Notification dedup family (F23):** rate-limit/recovery notices carry a
  pool-deduped episode key keyed on (topic, episode) — NOT (topic, machine) — so a
  cross-machine failover of one episode produces ONE notice. Burst-invariant test per
  notice path.

## Workstream 4 — One pane of glass

- **WS4.1 Attention queue pool scope (F5):** items grow `machineId`;
  `GET /attention?scope=pool` merges peers with per-peer timeout, partial-result
  degradation (`failed` markers, sessions-scope precedent), and a short-TTL cache so
  dashboard polling doesn't re-fan-out per request. **P17 at the merge point:** the
  merged surface applies a pool-wide coalesce key (the WS3.3 episode-key pattern) so N
  machines raising the same episode (e.g. each machine's tripwire for one pool-wide
  event) present as ONE item; the merge is read-only and per-machine budgets remain
  the write-side bound — the burst test drives N machines × budget and asserts the
  merged view stays within the pool bound. **/ack is durable and machine-independent:**
  the ack writes a replicated ack record (user intent survives the owner being dark);
  the owning machine reconciles on return. The ack record BINDS the authenticated
  OPERATOR principal that performed it (the same audience-bound assertion pattern as
  WS4.4 — never a bare peer-authored record), is epoch-fenced and idempotent, and the
  owner REVALIDATES that operator binding at reconcile before applying it. Reconcile
  precedence: the owner's CURRENT item state wins — a stale resolve against an item
  that has since escalated to HIGH/URGENT is rejected (and surfaced), never applied.
  Ack replication is governed by the WS2 replicated-store mechanics (HLC ordering,
  retention/rate-cap, the aggregate journal budget). Remote ack is a MUTATING mesh
  verb with its own RBAC class (authenticated same-operator peer + receiver
  revalidation); HIGH/URGENT items (split-brain demotion, guard tripwires) are never
  remotely resolvable without operator-authenticated action.
- **WS4.2 Idle vs broken machine empty-state (F7):** sessions view renders explicit
  per-machine states: "online — no active sessions" / "offline since <t>" /
  "unreachable (last seen <t>)". Mobile-responsive like the rest of the dashboard.
- **WS4.3 Jobs placement visibility + role guard (F8, F21):** `GET /jobs?scope=pool`
  (same Bearer auth as local `/jobs`) shows which machine runs each job. A
  machine-role check at spawn refuses state-writing jobs on a read-only standby — and
  a refusal is never the end of the story: the job re-routes to the writable owner
  when one exists, else ONE deduped attention item ("job X could not run — no writable
  machine"). The posture-style divergence detector ("machine X runs 0 jobs but its
  config declares N") closes the F8 blindness. Job claims upgrade from best-effort
  broadcast to a durable lease through the replicated journal (prevention, with
  partition behavior documented: claims are leases with fenced epochs; a partition
  double-run is structurally prevented when the journal is reachable and VISIBLY
  reported when partition forced independence). **Cutover discipline:** journal-lease
  claiming engages ONLY when invariant-5 flag coherence confirms EVERY pool peer
  advertises the WS4.3 capability; until then the machine stays on the legacy
  AgentBus broadcast path. There is never a window where one machine leases via the
  journal while a peer broadcasts via the bus for the same job set — two
  non-interoperating claim mechanisms running simultaneously is the named migration
  hazard this rule closes. Claim records store metadata only (machine, job id, epoch)
  — never job payloads.
- **WS4.4 Links that survive machine boundaries (F6):** the tunnel-fronting machine
  proxies `/view/:id` + dashboard asset routes to the content's HOLDER. Normative:
  (a) view-id ownership ≠ topic ownership — the proxy resolves the actual holder of
  the view id; (b) the END-USER credential (PIN session / view token) is enforced
  end-to-end and the HOLDER makes the authorization decision — the fronting machine is
  a dumb relay that never substitutes machine/mesh credentials for user credentials,
  never logs tokens, never caches private content; (c) responses are STREAMED with a
  concurrency cap on in-flight proxied requests; static dashboard assets may be cached
  at the fronting machine (they are not private), private bodies never; (d) a holder
  that is offline yields an honest "content temporarily unavailable — its machine is
  offline", never stale content or a bare 404; (e) PIN auth across the proxy: the
  user's PIN session is validated by the fronting machine AND the proxied request
  carries a short-lived assertion of that user authentication — not the raw PIN — so
  each machine's PIN secret never crosses the boundary. The assertion is
  AUDIENCE-BOUND (target holder fingerprint + the specific view-id + method) and
  SINGLE-USE (nonce/jti recorded by the holder within the TTL), signed by the
  fronting machine's mesh key and verified by the holder against the EXPECTED
  fronting machine — a captured assertion cannot be replayed against another
  resource, another holder, or reused within its window; (f) fronting-edge load
  posture: merged pool views (attention/jobs/sessions/guards) are served from ONE
  shared per-peer poll cache (one fan-out per interval feeds all pool-scope surfaces
  — never per-route, per-client re-fan-out), and when the fronting machine is over a
  CPU threshold, dashboard poll responses serve last-cached data with an explicit
  staleness tag instead of re-fanning (load-shed, honestly labeled).

## Workstream 5 — Account & model continuity

- **WS5.1 Subscription-pool awareness (F4 phase 1):** `GET
  /subscription-pool?scope=pool` reports each machine's enrolled-account DEPTH +
  quota. The capacity heartbeat carries only a small fixed-size summary (account
  count + blocked bool per provider) — the inventory is fetched on demand. Placement
  uses depth as a TIE-BREAKER only in v1 (never overriding load). **Honest
  disclosure with an agent-driven path:** when a machine's depth is low, the agent
  OFFERS to drive the existing enrollment flow itself (`POST /subscription-pool/enroll`
  — the public-code login wizard the agent initiates and walks the operator through)
  — never a bare "use the wizard" instruction to the user, and never implying an
  auto-sync exists (P8 no-dead-ends; B2 no CLI instructions to users).
- **WS5.2 Account follow-me (F4 phase 2 — deferred, boundary fixed here):** <!-- tracked: CMT-1413 -->
  cross-machine enrollment is OPERATOR-INITIATED and PIN/operator-authenticated
  (mandate-issuance precedent); a peer machine can NEVER initiate enrollment of an
  account onto itself via the mesh. Explicitly NOT login-file sync — OAuth
  config-homes never cross machines. The flag `multiMachine.accountFollowMe` is
  reserved-dark now; ALL design and build happens in its own convergence round
  (principal-approved deferral — no credential-bearing code ships from this spec). <!-- tracked: CMT-1413 -->
- **WS5.3 Escalation rides the topic (F22):** the topic-profile transfer carrier
  (already wired) carries live escalation/thinking state; `/tmp` severity files become
  per-topic state included in the carrier.

## Migration & Awareness (P3 + P5, per workstream)

- Every new config flag lands via `migrateConfig()` with existence checks; defaults
  preserve today's behavior exactly.
- The `MachineCapacity.seamlessnessFlags` heartbeat field follows the
  quotaState/guardPosture precedent: absent = unknown/pre-spec = non-participant; no
  wire-format migration needed beyond additive-field handling, locked by a skew test.
- WS3.2's commitment backfill ships as a PostUpdateMigrator migration in the same PR.
- Every agent-facing surface (`/attention?scope=pool`, `/jobs?scope=pool`,
  `pendingReplacement`, pool-stable view URLs, WS4.2 empty-state semantics, WS1.4
  transfer confirmation) ships `generateClaudeMd()` + `migrateClaudeMd()` entries with
  proactive triggers in the same PR.
- Idempotency required on every migration.

## Safety & rollout posture

Every workstream ships dark behind `multiMachine.seamlessness.<ws>` (graduated rollout
track), defaults preserving today's behavior exactly. Dry-run modes for EVERY
state-mutating path: WS1 (log intended forward/drain/reconcile), WS2 (log intended
merges), WS3.2 (backfill report mode), WS4.3 (log intended refusals/claims), WS5.3
(log intended carrier writes). WS2.3 (PII) and WS5.2 (credentials) are
principal-approved deferrals to their own security convergence rounds — nothing <!-- tracked: CMT-1413 -->
recurrence-risking ships before those rounds converge. All loops carry the three
brakes IN-COMPONENT with sustained-failure tests. Every new surface is observable
(feature metrics + audit lines per P7). New mesh verbs get explicit RBAC classes
(read/observe vs mutating) — named per verb in the build plan.

## Test plan (P4, per workstream)

Three tiers (unit / integration / E2E feature-alive) per workstream, PLUS the named
invariant tests: exactly-once delivery end-to-end across custody domains;
exactly-one-owner after any reconcile sequence; exactly-one-speaks (≥1 and ≤1);
single-machine strict no-op per workstream; burst-invariant for every new notice path
(N-machine episode storm → one notice); P19 sustained-failure for the closeout breaker
and every replication loop; version-skew matrix for WS1.1 (new→old, old→new,
mixed-flag); WS1.4 torn-state-file refusal; WS2 quarantine + rollback-unmerge; WS4.4
auth-preservation (user credential required end-to-end, machine credential never
substituted).

## Build order (highest leverage ÷ risk first)

1. WS4.2 (empty-state — tiny, immediate trust win)
2. WS3.1 + WS3.2 (one-voice gates + backfill migration)
3. WS1.3 (ownership reconcile + honest pending + convergence deadline). **Honesty
   note:** shipped before WS1.1, WS1.3 fixes the status surface and the placement
   RECORD convergence only — the user-visible conversation move still does not
   complete until WS1.1 is live (delivery is what honors the record). Ship messaging
   for WS1.3 must say so.
4. WS1.1 (dispatch-to-owner — AFTER the durable-queue merge gate)
5. WS1.2 + WS1.4 (transfer completion + closeout breaker + autonomous guard)
6. WS4.1, WS4.3, WS4.4 (pane-of-glass family)
7. WS2.1 + WS2.3, then rest of WS2 (memory family)
8. WS5.1, WS5.3, then WS5.2's own round (accounts family)

## Non-goals

Durable custody/queueing of inbound messages (owned by durable-inbound-message-queue);
TaskFlow v2 cross-machine sync; Slack-specific multi-machine verification (Phase A
item 4 of the parent project — separate spec after this lands); cross-machine custody
replication of queued messages; multi-agent (cross-AGENT) anything.

## Decision points touched

- WS1.1 inbound route decision (local-inject / mesh-forward / queue-handoff).
  **Fail-safe: ownership-unknown → durable queue.** Local inject happens ONLY on a
  resolved "owner == local"; degraded-version pools fall back to today's pool-wide
  local-inject semantics (never drop, never half-forward).
- WS1.4 transfer-time refusal (`needsConfirmation`) when an autonomous run is live —
  consent-shaped, never silent, evaluated before drain.
- WS3 gates sentinel SPEECH only, failing toward speech-with-dedup — never recovery
  actions, never silence.
- WS4.3 spawn-time refusal for state-writing jobs on read-only standby — refusal
  always pairs with re-route-or-attention, never a silent skip.
- No gate in this spec blocks a user-initiated action without a confirmation path.

## Decisions (formerly open questions — resolved for build)

1. **WS1.1 forward transport: mesh RPC lane** (the pool transfer planner's lane),
   inheriting its auth, breaker, and version-skew handling — with explicit
   backpressure: on saturation, forwards spill to the durable queue, never block
   ingress, never drop.
2. **WS2 divergent concurrent edits (high-impact stores): append-both-and-flag** with
   ONE deduped attention item; field-level HLC-wins only for low-impact stores.
3. **WS4.4: proxy through the fronting machine**, gated on the auth-preservation
   constraints above (revisit toward per-machine tunnels only if relay load proves
   prohibitive — the streamed+capped design bounds the risk).
4. **WS5.1 placement weight: tie-breaker only in v1.**
