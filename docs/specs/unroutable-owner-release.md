---
title: "Unroutable-owner release: a conversation owned by a machine that left the pool moves to a live machine on its own"
slug: "unroutable-owner-release"
author: "echo"
status: "draft"
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
sibling-principles: "The Agent Is Always Reachable; Verify the State, Not Its Symbol; Bounded Blast Radius; A Refusal Stays a Refusal"
parent-spec: "docs/specs/u4-2-stale-owner-release.md; MULTI-MACHINE-SESSION-POOL-SPEC.md"
eli16-overview: "docs/specs/unroutable-owner-release.eli16.md"
feedback: "fb-b3d47791-3fb"
review-convergence: "2026-11-20T19:55:22.157Z"
review-iterations: 6
review-completed-at: "2026-11-20T19:55:22.157Z"
review-report: "docs/specs/reports/unroutable-owner-release-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
single-run-completable: true
frontloaded-decisions: 4
cheap-to-change-tags: 0
contested-then-cleared: 0
approved: true
approved-by: "echo (agent self-approval per 2.0 Rule 82: no constitution or CODEOWNERS-protected path; approved after reading the 6-round convergence report, outage repair run 2026-11-20)"
---

# Unroutable-owner release

## Problem statement

A topic whose recorded owner is a machine that left the pool (revoked, or never registered on this machine) is unroutable forever: no recovery path in the engine, the router or the transfer route can move it. §1 is the incident; §2–§3 are the proposed design.

## 1. The incident (2026-11-20)

Echo's Mac Studio was erased and rebuilt. It came back with a new machine id
(`m_9a4a7b…`); the old id (`m_03b30f…`) was revoked on the machines that still knew
it, and was simply absent from the rebuilt Studio's fresh registry. About 70 topic
ownership records on the Studio (and ~190 on the Laptop) still named the old id —
including the operator's Chief of Staff topic. Every inbound owner message in those
topics was stranded: only automatic "your message didn't reach the session" notices
went out. Three independent dead ends held them there:

1. **The stale-owner engine (U4.2)** opens an episode for the old id, but its
   evidence bar needs a fresh, owner-authenticated, multi-transport advert set and a
   probe verdict. A revoked or never-registered machine has no adverts, so the verdict
   is `ambiguity: transport-ambiguity` forever. It was also in dryRun.
2. **The session router's owner-dead path** re-places the topic with the FSM action
   `place`, which is refused on a live (`active`) record → `ownership-contention` →
   the message queues in durable custody (bounded by the queue's attempt limit) while
   the ownership record stays stranded indefinitely. (The existing `tryTakeOver`
   seam takes over a DEAD owner only in the dark-pool `routingOnly` mode, and a LIVE
   owner lacking durable receive from `forceReplace`; Echo's pool was live and the old
   id was dead, so the incident ran the normal mode — confirmed in the server log:
   `route topic 141385 → action=queued`, `(ownership-contention)`.)
3. **`POST /pool/transfer`** sets the pin but can only move the seat cooperatively
   (drain) or by `place` on a released record; against a live record owned by a dead
   id it reports `seatMoved:false` and the pin stays pending forever.

A fourth, latent defect surfaced while repairing it: the U4.2 evidence-5 mirror read
`streams[machineId]`, but `CoherenceJournalReader.query` keys streams
`<machineId>.<kind>`. The mirror therefore always reported "no side effects" for
every owner.

## 2. Definition: an unroutable owner

`src/core/unroutableOwner.ts → assessOwnerRoutability()` (pure, deterministic,
shared by every caller). An owner (≠ self) is **unroutable** when:

- **revoked** — the local machine registry marks it `status: revoked` or carries a
  `revokedAt` stamp. A revoked key no longer authenticates, cannot hold the lease, and
  its mesh traffic is refused; no evidence can change that. Unroutable immediately.
- **unregistered + silent** — the id is absent from a SANE local registry (readable,
  non-empty, and listing this machine itself — a missing `registry.json` loads as an
  empty map and is `unavailable`, never "absent") AND all of:
  - this process has CONTINUOUSLY observed the id as absent for at least 9 min,
    measured on a MONOTONIC clock; a gap between observations longer than 3 min
    (missed sampling, suspended process, clock jump) restarts the window
    (3 × the 180 s death-evidence bound). The clock starts at the first such
    observation (so it also covers boot) and resets on any registered or unavailable
    reading, so a registry entry that has just vanished never qualifies at once even
    when its last journal event is old (cross-model round 2). The router wiring keeps
    this clock running with one observation per minute for every distinct non-self
    owner AND every transfer target named in a live record (a frozen transfer's
    eligibility depends on its target's clock too);
  - this machine's own identity is known (unknown self ⇒ `registry-unavailable`); a
    registry read ERROR is an `unavailable` observation and resets the absence clock,
    so read errors can never bridge an absence window (cross-model round 3);

  Policy, stated explicitly (cross-model rounds 3 and 5): the 6 h is a JOURNAL-AGE
  threshold and the 9 min is the OBSERVED REGISTRY-ABSENCE window; neither measures
  unreachability directly. The two clocks are independent. An
  id whose journal was already ≥ 6 h silent when its registry entry disappeared
  qualifies after 9 min of continuous absence. The 6 h is the outage evidence (no
  activity from that machine reached this pool for 6 h); the 9 min only guards against
  a transient registry glitch on this machine. Tested both ways.
  - the owner's newest replicated side effect (topic-placement / session-lifecycle) is
    known AND older than the silence bound, **6 hours**.

  Why 6 h and why no mirror-freshness check (internal round 1): the pool view is built
  from the same registry, so "not in the pool view" adds nothing; and once an id leaves
  the registry this machine stops pulling its stream, so its journal goes quiet whether
  or not the machine is alive. The evidence is therefore only "this id has been
  unreachable from the lease holder, with no new journal data, for 6 h" — long enough to
  outlast a registry glitch an operator would notice (6 h with no activity from that
  machine reaching this pool's journal). The takeover restores service; see §4.

  An unregistered id with **no** journal evidence at all stays routable (no positive
  evidence of silence — e.g. a machine paired a moment ago whose registry entry has
  not arrived). Recent activity stays routable. These fall back to today's fail-closed
  behaviour.

An **unreadable** registry snapshot is its own standing (`unavailable`), never
"absent" — it reads as routable.

Every seam fault (unreadable registry, reader error) reads as **routable** — the
change can only ever add a takeover on positive evidence, never on missing evidence.

## 3. The three repairs

### 3.1 Stale-owner engine (proactive; covers idle topics)

New optional dep `ownerStanding(machineId)`, wired to the machine registry. For an
offline/absent owner the engine first runs the assessment. If unroutable (revoked, or
unregistered-silent while in quorum) the verdict is `expired` with evidence class
`unroutable-<reason>`; otherwise the full §2.2 bar runs unchanged.

Claims for a **revoked** owner land **even while the engine is in dryRun**, because the
dry-run soak exists to prove the death-evidence bar against peers that might still be
alive, and a revoked key cannot act. An unregistered-silent verdict rests on observed
absence, not on proof the machine stopped, so its engine claims follow dryRun like
every other claim (cross-model round 4); in dryRun those topics are recovered by the
router on the next inbound message. Opt-out: `multiMachine.sessionPool.
staleOwnerRelease.unroutableOwnerLive: false` restores dryRun for them. Everything else
is unchanged and still applies: lease-holder-only claims, `maxClaimsPerTick`, the
replicated per-topic budget + widening backoff, declined-demote, the fresh re-read
before the CAS, and the claim annotation + working-set pull. The claim trace carries
`reason: unroutable-owner:<reason>`.

Limitation by design: the engine itself is dev-gated (fleet-dark). 3.2 is therefore
what repairs the fleet.

Incident coverage (internal round 1): on the rebuilt Studio the old id was absent (not
revoked) and its replicated stream was a static copy whose last entry was ~20 h old, so
the unregistered-silent rule applies there; on the Laptop the id is revoked. Revocation
status is not propagated between registries by this change — each lease holder decides
from its own registry, and any holder reaching a takeover journals it for the others.

### 3.2 Session router (reactive; the user-facing path, every agent)

Scope: pool-placeable topics. App conversations (`app:` keys) keep their own policy —
their only takeover is the owner's "bring it back here" in the app.

New optional deps `isOwnerUnroutable(m)` and `forceClaimUnroutableForSelf(sk, prev)`.
Wiring: `isOwnerUnroutable` is true only when THIS machine holds the serving lease AND
the assessment says unroutable AND — for the unregistered-silent case only — most
registered machines are online in the pool view (≥2 entries, online × 2 > total). The
pool view is built from the same registry, so this is "an online majority of registered
peers", not an independent signal: it stops a holder that sees only itself from acting. Revoked owners need no quorum (their key cannot act).
Before claiming, the router runs its existing `localPlacementAllowed` check (workspace,
quota, refusing work, hard pin elsewhere — the same check the non-receiver takeover
uses); a failed forward's fallback goes through the same guarded takeover before
today's re-place (`failoverAfterForward`); a refusal (or a version/lease change) leaves the message in durable custody
with reason `unroutable-owner-not-taken` — it never falls through to a re-place path
that would skip the placement check. The drain's forced attempt (`forceReplace`) runs
the same guarded takeover before re-placement, through ONE eligibility definition
(`unroutableEligible`): a transfer toward a live target is ineligible at every entry
point, and an eligible-but-refused takeover returns custody at every entry point
(including the dark-pool `routingOnly` drain, which therefore never reaches its
`tryTakeOver` for that message).

No session is started by an ownership move alone: the engine's claim path has no spawn
seam (annotation, working-set pull and a log line only), and the router takes over only
while handling a real inbound message, which it then delivers. (During the 2026-11-20
manual repair two project sessions were started by a separate `/sessions/spawn` caller
once their topics became locally owned — not by the ownership move itself.) The claim callback is
version-conditioned: it receives the inspected `{owner, epoch, status}` and refuses if
the record changed since, and it re-checks `holdsLease()` immediately before the CAS
(read + CAS are synchronous in-process). Router takeovers are paced by inbound messages
(one per message for that topic) and each local session start is bounded by the
existing spawn cap (Bounded Blast Radius); no separate rate limit is added. The working
set and topic profile are not pulled from the dead owner (it cannot serve them); a
transferring record toward a live target is left to the target's Case-B claim, which
waits at most the drain-claim grace. When an inbound message arrives for:

- an **active** record whose owner is not alive and unroutable, or
- a **placing/transferring** record whose owner is unroutable and whose target is
  absent, the owner itself, or also unroutable AND not reported alive by the liveness
  view (target liveness takes precedence; frozen: nobody left to claim),

the router (after `localPlacementAllowed` and a version check — below) force-claims it for itself through the ownership CAS (`force-claim`,
`ownershipEpoch + 1`), journals the placement (`reason: failover`, `prevOwner`), and
handles the message locally. If an eligible takeover is refused (placement policy) or
its CAS does not land, the message is put in durable custody (`unroutable-owner-not-taken`)
and acknowledged only if custody succeeded; the drain retries.
A transferring record toward a LIVE target is left for that target's claim.

### 3.3 `POST /pool/transfer` (operator move)

New route-context dep `isOwnerUnroutable` (same lease-gated predicate). When the
current owner is unroutable:
- the autonomous-run probe of the dead owner is KEPT (cross-model round 5): revocation
  proves the holder refuses the old key, not that a run on that machine stopped, so
  the existing "run state could not be verified" confirmation stays and the operator
  answers it with the challenge;
- the seat repair force-claims the record straight to the target (one CAS, journaled
  as `user-move`) instead of the `place` that the FSM refuses on a live record. The
  response then reports `seatMoved: true` honestly.

### 3.4 Mirror stream-key fix

`newestSideEffectMs(reader, machineId)` reads `streams['<machineId>.<kind>']` (falling
back to the old key), used by the engine's evidence-5 mirror and by 3.2. A stream whose
`lastTs` is present but unparseable makes the result UNKNOWN (null) rather than letting
the other stream's older timestamp stand in. This makes the
U4.2 mirror check stricter (it now sees real recent activity and refuses a claim on a
machine that is still emitting) — the direction the original spec intended.

## Proposed design

§2 (the shared definition) and §3 (the three repairs plus the mirror fix) below.

## Decision points touched

| Decision point | Classification | Floor / arbiter / justification |
|---|---|---|
| Owner is unroutable because the registry marks it revoked | invariant; basis: irreversible-consequence; evidence: revocation is sticky (MachineIdentityManager refuses to re-register a revoked id as active), a revoked key fails mesh authentication and cannot hold the lease, so no later evidence can make that owner serve the topic | Lease-holder-only claim through the existing ownership CAS; per-tick cap and replicated per-topic budget unchanged in the engine. |
| Owner is unroutable because it is unregistered here AND silent past the bound | invariant; basis: enumerable-domain; evidence: the inputs are a closed set of structural facts (sane registry incl. self, registry membership, continuous-absence duration, owner's newest journal timestamp, online majority of registered peers); every unknown input reads as routable | Arbiter: the lease holder's ownership CAS. Conservative default: no journal evidence / recent activity / absence < 9 min / unknown self / no majority → today's fail-closed path. |
| Unregistered-silence bound = 6 h; boot window = 9 min | invariant; basis: irreversible-consequence; evidence: a topic whose owner is unreachable from the lease holder is already an outage; 6 h outlasts a registry glitch an operator would see and repair, while the incident case (old id silent ~20 h) is still covered; the 9 min boot window reuses the U4.2 bootstrap bound (bootstrapNonObservationMultiple × deathEvidenceMs) already validated against the self-fence TTL ordering | The boot window follows the existing U4.2 knobs; revoked owners need neither bound. |
| REVOKED-owner claims bypass the engine's dryRun (unregistered-silent ones do not) | invariant; basis: irreversible-consequence; evidence: dryRun exists to soak the death-evidence bar against peers that may still be alive; a revoked key cannot act, so dryRun only preserves a permanent outage (the 2026-11-20 incident); an unregistered verdict rests on observed absence only | Opt-out `unroutableOwnerLive: false`. |
| Router takes over an unroutable owner's topic on inbound | invariant; basis: irreversible-consequence; evidence: without it the FSM refuses `place` on the live record and the message waits in custody forever | Lease-gated; a refused or missed takeover keeps the message in durable custody (the drain retries; at its attempt limit the existing honest loss notice applies). |
| Transfer force-claims an unroutable owner's record to the target (run-state confirmation kept) | invariant; basis: irreversible-consequence; evidence: the owner can neither drain nor accept a place, so the cooperative path can never complete | Only on the holder (route proxies to the holder otherwise); the operator still answers the run-state confirmation; response reports the real post-state. |

## Multi-machine posture

Posture: **unified (replicated)**. Every takeover is an ownership CAS plus a coherence-journal placement entry that replicates to peers and is adopted by their OwnershipAppliers (highest epoch wins). The standing read is the lease holder's own registry, consumed only by the lease holder, the sole claimer — the decision it feeds is replicated, not the read. No notices are added (no one-voice concern); no durable state strands on transfer; no URLs generated.

## Open questions

*(none)*

## Frontloaded Decisions

1. Revoked owners are claimed immediately, unregistered ones only on positive silence evidence (not on absence of evidence).
2. The engine's dryRun does not hold REVOKED-owner claims (opt-out knob provided); unregistered-silent claims follow dryRun.
3. The fix ships in three layers (engine, router, transfer) because the engine is dev-gated fleet-dark; the router layer is what reaches every agent.
4. The pre-existing stream-key bug in the evidence-5 mirror is fixed in the same change because the new rule depends on that read.

## Maturation plan

- **test-agent-live:** a throwaway two-machine agent: register and revoke a machine id, place a topic on it, send an inbound message from a user-role session through the real Telegram surface and observe it answered on the lease holder; repeat with the id removed from the registry (no revocation) and verify no takeover before 6 h of journal age + 9 min of observed absence.
- **dev-agent-live:** live on Echo from the release that carries it (the router and transfer layers are not gated). First use: any topic still owned by the old Studio id on any of Echo's machines is answered on the lease holder; `/pool/transfer` of such a topic returns `seatMoved: true`.
- **fleet:** the router and transfer layers ship live fleet-wide (they act only where a topic was otherwise stuck forever); the engine layer follows `multiMachine.sessionPool.staleOwnerRelease.enabled` (development-agent gated today).
- **graduation criterion:** on Echo, within 14 days of release, zero inbound messages logged as `ownership-contention` for a topic whose owner is revoked or unregistered, and every `unroutable-owner-takeover` line followed by a delivered reply in that topic. A zero takeover count with no affected topics is recorded as "no occurrence", not as a pass.
- **dark-window:** none for the router and transfer layers; the engine layer rides its existing U4.2 gate.
- **ladder:** not applicable: it rides the session-pool gates (multiMachine.sessionPool.enabled and staleOwnerRelease.enabled)

## 4. Safety argument

- **Incident evidence** (observed 2026-11-20 on the rebuilt Studio): the old id's
  replicated placement stream's last entry was `2026-11-19T21:08:59Z` and its
  session-lifecycle stream's `2026-11-19T22:25:05Z` (read with CoherenceJournalReader),
  i.e. ~20 h of silence when the repair ran.
- **Partitioned unregistered owner** (cross-model round 1): journal silence alone does
  not prove the machine stopped. What it does establish, together with "not in this
  machine's registry", is that the owner cannot be routed to, cannot hold this pool's
  lease, and cannot have its mesh traffic accepted here — the conversation is already
  dead for the operator. The takeover therefore restores service; the residual risk is
  a duplicate turn on an orphan machine that this pool cannot hear from, never a split
  in this pool's ownership state (only the lease holder claims, via the epoch CAS). The
  quorum requirement (engine and router) and the positive-silence rule bound it further.
  Revoked owners carry no such risk.

- **Split-brain**: a revoked machine cannot hold the lease or authenticate mesh
  traffic, so there is no second claimer. An unregistered machine is unreachable from
  this machine by construction (no peer URL, no trust); it is claimed only on positive
  evidence of 6 h of journal silence and 9 min of continuous absence, and only by the lease holder. If such a
  machine later rejoins, the placement entries at a higher epoch replicate to it and its
  OwnershipApplier adopts them (the existing highest-epoch rule).
- **Equal-epoch race**: two machines that briefly both believe they hold the lease
  could each land `epoch+1` naming themselves. The OwnershipApplier only adopts a
  STRICTLY higher epoch, so each would keep its own record until the next ownership
  change (there is no equal-epoch tie-break today). This exposure is not new: it is
  identical for every existing force-claim path (router `takeOverFromPeer`, Case C,
  U4.2) and the lease fence makes the double-holder window short. This change narrows
  it further with the pre-CAS lease re-check; defining an equal-epoch tie-break for the
  ownership substrate is a substrate change owned by the session-pool spec; it is filed
  as feedback fb-cf44899b-73f rather than widened into this fix.
- **U4.2 soak evidence**: the mirror read was a no-op before this change, so earlier
  dry-run soak data never exercised evidence 5; the U4.2 soak restarts from this fix.
- **Blast radius**: per-tick caps, replicated claim budgets and backoff are unchanged
  for the engine; the router acts per inbound message only.
- **Signal vs authority**: the assessment is a deterministic structural fact (registry
  standing, journal timestamps), not a brittle heuristic over content; it gates only a
  recovery action through the existing CAS authority, and fails toward today's
  behaviour.

## 5. Rollback

Pure code change, no migration. Revert the PR. Operationally:
`unroutableOwnerLive: false` returns the engine to dryRun-only for these owners; the
router/transfer paths have no switch beyond the revert (they only act where the
system was permanently stuck before).

## 6. Tests

- Unit `tests/unit/unroutable-owner-release.test.ts`: the full assessment decision
  table (both sides of each boundary), registry standing mapping, assessor seam-fault,
  engine (revoked claims in dryRun, per-tick cap, not-lease-holder, opt-out,
  unregistered boot window / no evidence / recent activity, registered unchanged, no
  dep = today), router (before-shape, takeover, routable unchanged, CAS miss keeps custody,
  forceReplace eligibility, frozen transferring, transferring to live target), and the real
  CoherenceJournalReader stream-key read.
- Integration `tests/integration/unroutable-owner-transfer.test.ts`: transfer of a
  revoked owner's topic to self and to a peer, without the dep (honest
  `seatMoved:false`), and a registered owner never force-claimed.
- E2E `tests/e2e/unroutable-owner-transfer-alive.test.ts`: the AgentServer option
  reaches the route through the real stack; the revoked owner's topic actually moves.
