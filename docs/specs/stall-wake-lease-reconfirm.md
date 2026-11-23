---
title: "A machine back from a stall re-asks before it takes the lead"
slug: "stall-wake-lease-reconfirm"
author: "echo"
parent-principle: "An Instar Agent Is Always a Multi-Machine Entity"
parent-spec: "docs/specs/takeover-ready-pool.md"
eli16-overview: "docs/specs/stall-wake-lease-reconfirm.eli16.md"
lessons-engaged: "fb-fdb55c1c-a79, fb-2bf6ccd0-705 (boot race), incident_role_restart_lease_loop_1121, sleepwake-false-fire-under-load, P19, P20, Signal vs Authority"
review-convergence: "2026-11-21T16:59:54.274Z"
review-iterations: 6
review-completed-at: "2026-11-21T16:59:54.274Z"
review-report: "docs/specs/reports/stall-wake-lease-reconfirm-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
single-run-completable: true
frontloaded-decisions: 9
cheap-to-change-tags: 0
contested-then-cleared: 0
clean-door-anthropic-review: "claude-code:claude-fable-5"
approved: true
approved-by: "echo, under the operator's standing rule (Justin, 2026-10-22 08:58 PDT: \"I should ONLY have to approve constitution changes\") and Approval Only Where Required; the fix was approved as its own PR by the Chief of Staff and assigned by the run lead (2026-11-21, topic 145840 post-mortem program); no constitution or CODEOWNERS path touched; the convergence report (docs/specs/reports/stall-wake-lease-reconfirm-convergence.md) was read before approval"
---

# A machine back from a stall re-asks before it takes the lead

## Problem statement

Feedback fb-fdb55c1c-a79 (Echo's own filing, 2026-11-21): a machine whose own server is stalling can take the lead
from a healthy preferred machine. Two observed cases on the Echo pool (Studio `m_9a4a7b73` named preferred, Laptop
`m_cc2ec651` standby, Mini):

1. **00:27 PST.** The Laptop was starved by a runaway desktop app (one core, 17 GB). Its server logged SleepWakeDetector
   drift bursts of 11 to 21 s; it logged `acquire skipped: held-by-live-peer`, then two minutes later acquired the
   lease from the healthy Studio (epoch 23749). The merge line was down about 13 minutes.
2. **08:05 to 08:10 PST (16:05 to 16:10Z), instar 1.3.1949.** Last normal Laptop line 16:05:46Z
   (`acquire skipped: held-by-live-peer`), then 16:09:47Z `[SleepWakeDetector] Drift ~226s under load ratio 4.46
   (> 1.5) — treating as CPU starvation, suppressing wake`, then 16:09:48Z `lease epoch 23761 committed locally` /
   `acquired lease at epoch 23761`. The Studio was up 3.5 h and renewing epoch 23760 throughout. One wrong claim forced
   a lead change and two restarts. Likely trigger, not proven: a notarized Mac app build (`xcodebuild`) started on the
   Laptop at about 08:03 to 08:05 and overlapped the stall. Recorded as a likely repeatable trigger (observed once, not
   reproduced): **a heavy build on a lead candidate can starve its server for minutes.**

Terms used below: the **view** is this machine's current belief about who holds the lease (`effectiveView()`); to
**fold** a lease is to verify a received lease record and merge it into the view; **R1** is takeover-ready-pool's boot
claim safety rule set; a **probe** is one recorded outcome (`signed`, `unsigned` or `silent`) of a lease pull to one
peer (`probeHistory()`).

**Why the claim happened (code on origin/main at 61bfe8f2f; a mechanism consistent with the logs, which show the claim
one second after the drift report but carry no callback trace).** While a process is stalled it folds nothing, so its copy
of the holder's lease (`effectiveView()`, fed by pushed renewals and the 5 s pull loop) ages. At wake, libuv runs the
overdue timers phase before it reads buffered sockets. The 2-minute heartbeat tick (`checkHeartbeatAndAct` →
`tickLease` → `LeaseCoordinator.acquireIfEligible`) is one of those timers. In `acquireIfEligible`, `canAcquire` sees
the Studio's lease past `expiresAt` (`current-lease-expired`); the only "ask the peers first" branch is for an own
lapsed lease, no lease, or the boot hold (takeover-ready-pool R1), and the boot hold ended hours earlier; so the loop
goes straight to `casWrite` with no await in between, and the claim lands before the buffered renewals and the pull
replies are read. The same holds for F2 (`holder-not-renewing`) and the liveness path (`holder-presumed-dead`): all
three measure the holder's silence on a clock that kept running while this process did not.

The SleepWakeDetector is no help as a trigger: it classified the 226 s drift as CPU starvation and **emitted nothing**
(the suppression path returns without an event), and its 'stall' event fires only for a proven event-loop block.

## Proposed design

One rule: **after this machine has lost a large share of a lease TTL of running time, a claim on a lease another
machine holds needs evidence gathered after the loss.**

### 1. Detecting the loss: the lease coordinator's own awake clock

`LeaseCoordinator` keeps an awake stamp `{ wallMs, monoMs }` (the coordinator's injected `now()` and
`monotonicNow()`). It is stamped on a 2 s unref'd interval (started the first time the switch reads on, stopped and
cleared when it reads off), at the entry of `acquireIfEligible`, and at the start of every `pullFromPeers`. The gap
between consecutive stamps is `max(wall delta, monotonic delta, 0)`: the wall clock moves through a sleep the macOS
monotonic clock skips, and the monotonic clock is immune to a wall step backward (a forward step reads as a gap, the
safe side). Because whichever of the three runs first after the stall sees the gap, the order libuv runs overdue timers
at wake decides nothing.

A gap of 6 s or more (three stamp intervals) counts as lost time, **whole** (the folded lease ages by the whole gap);
shorter gaps are scheduling jitter, and the loop keeps folding between them, which is what makes ignoring them safe.
Lost time is summed over a sliding window of one TTL. When the sum exceeds the threshold, an **episode** opens (or
re-opens, moving its start to now while keeping the chain's first start for the long-hold record) and the samples are
cleared so only new losses re-open it. Threshold: `stallGapMs` if configured (any positive value, clamped to 1 s ..
TTL/2 against the live TTL, never ignored), else 30 % of
the TTL with a 5 s floor, never above TTL/2 (18 s at Echo's 60 s TTL). Basis: a renewing holder signs every TTL/2, so at the moment a
pull or push is folded a live holder's copy has at least TTL/2 left; between pulls it keeps ageing (5 s at the default
cadence) and loses the delivery time, so a loss of about TTL/2 − 5 s − delivery (about 25 s at a 60 s TTL) can make a
live holder look expired. 30 % sits below that with a margin. The sum catches case 2 (one 226 s gap) and the 08:30:23
repeat (243 s) always, and case 1 (bursts of 11 to 21 s drifts) whenever the bursts lose more than 18 s inside one
minute; the 00:27 log has no per-drift timestamps fine enough to prove which, so case 1's coverage is stated as
conditional. With a long `leasePullIntervalMs` the basis needs that interval to stay well under TTL/2.

The timer's lifecycle: `LeaseCoordinator.dispose()` clears it (tests call it; it is unref'd, so it never holds the
process open), and an episode whose holder stayed live **ages out** quietly at the first stamp after one TTL awake
with a completed round (rule C's conditions) **while the view shows a live lease** (the holder stayed live, or this
machine holds it), so a later ordinary takeover is never mistaken for a stall-confirmed one; when the view shows a
lapsed lease the episode is left for the claim path, so a claim C allows is recorded as `fired` and arms the overlap
watch.

### 2. The rule while an episode is open

In `acquireIfEligible`, after `canAcquire` allows a claim and after the existing boot-hold block, for **every** view
while an episode is open (another machine's lease, this machine's own lapsed one, a released tombstone, an empty view),
the coordinator evaluates `evaluateStallReconfirm` (pure, `src/core/StallReconfirm.ts`). The claim may go ahead only
when:

- **C. One TTL awake with a completed fresh round.** At least one TTL of **awake** time has passed since the episode
  opened (elapsed time less the running time lost in smaller gaps inside the episode, which do not re-open it) **and**
  a pull round that **started** after the episode opened and after the latest such gap has **completed**
  (`pullFromPeers` records each round's start and, when `pullAllPeers` resolves, that every dial of the round has
  ended and its replies are folded). The lease's expiry is then measured entirely on an awake clock, which is exactly
  what today's rule assumes: a live holder reaches this machine at least twice in one TTL by push and on every
  completed pull, and its folded renewal makes `canAcquire` refuse before this rule is consulted. A dead holder is
  taken over one TTL (60 s at Echo's TTL) after the stall. A completed round may consist of failed dials; C is then
  the point where ordinary acquisition resumes despite unresolved reachability, which is today's rule and the parent
  spec's accepted partition risk (R2), never something new.
- **The availability bound (chain cap).** A machine that keeps stalling re-opens its episode and so never reaches C.
  Once the chain of re-opens has lasted ten TTLs of **monotonic** time (a wall-clock step cannot age it; ten minutes at
  Echo's TTL) and a round started after the latest loss has completed, the claim may go ahead (`chain-cap`); that round
  has folded any live holder's renewal it received, so `canAcquire` refuses a live holder whose renewal arrived. This
  bounds the cost of Frontloaded 4 conditionally: a two-machine pool whose only other candidate is starved is without a
  lead for about ten minutes, unless that candidate cannot complete one pull round between its losses, in which case it
  is no usable holder either. This exceeds the parent spec's five-minute target only for a candidate that keeps
  stalling, and is accepted as such. A re-open that finds the prior episode already past C's conditions (judged before
  the new loss is applied) starts a new chain.

**Two shortcuts were rejected in review.** "The holder answered after the stall and said it holds nothing", and "the
holder was silent on post-stall probes by R1's test". Both read a probe, and a probe records only when a dial **ended**:
a reply or a timeout from a dial sent before the stall, buffered or overdue during it and processed at wake, passes
for fresh evidence, and no reply carries a binding to the request that produced it. Making them sound needs dial-start
generation tagging in `HttpLeaseTransport.pullPeer`, which open PR #3604 rewrites; the only evidence this change trusts
is a round that this coordinator **started** after the stall and saw **complete**. The cost is that a dead holder is
taken over at one TTL after the stall rather than about 45 s. Because nothing here reads a silence as death, #3604's
rule that a silence this machine caused is unknown is honoured trivially.

If C does not hold, the claim is held. If no pull round has started (after the episode opened and after the latest
loss) and completed, and the episode's extra pull has not been attempted yet, the coordinator first makes **one** fresh
pull (`pullWithin`, the existing 10 s-bounded pull over every peer and every route the transport has, the path R1 uses)
and re-runs its loop, so a live holder's renewal lands in the view and `canAcquire` refuses with `held-by-live-peer`.
Otherwise (or after that pull) `acquireIfEligible` returns false; the next tick (the 5 s pull loop nudges `tickLease`
while `peerTakeoverEligible()` is true) evaluates again on the pull loop's own rounds, so a machine nudged every 5 s does
not add a pull per nudge. The extra pull is skipped when the boot-hold ask already ran in the same call, so two 10 s
pulls never stack against the tick's 20 s timeout. The episode is **not** closed by an allowing verdict: it closes only
when the claim it allowed lands (`casWrite` ok), so a CAS loss that re-runs the loop against a different holder is
judged again.

**Released, empty and own lapsed views** are gated the same way: a third machine may have taken a newer epoch during
the stall and the first pull after wake can fail, so a newer holder that answers on any round is adopted, and with every
pull failing the claim waits one TTL awake. This holds independently of the boot claim safety switch. **Not gated, on
purpose:** consented paths (`acquireOnConsent`, hand-back, owner decommission), renewals and the holder side, and a
git-only mesh with no pull-capable transport (nothing can be asked; the episode closes with a log line and today's rule
applies). A pull-capable machine with no dialable peer is gated like any other (its rounds complete at once).

**What the coordinator logs and records.** `stall-reconfirm: opened — this machine lost N s of running time in the
last 60 s (largest gap G s; threshold T s); …`, then once per verdict change `stall-reconfirm: claim held (waiting) —
holder X not yet re-confirmed after the stall (…)` or `stall-reconfirm: claim allowed (<rule>) — …`, and
`stall-reconfirm: closed — …`. Feature evidence on the existing `multiMachine.takeoverReadyPool` ladder entry, chosen so
an outcome, not only a decision, is visible:

- `held` once per episode when a claim is first held (holder, epoch, lost time);
- `fired` when a claim the rule allowed lands (rule, holder, from and to epoch, lost time, wait);
- `error` "suspected overlap" when the holder taken over after a stall signs a newer renewal that this machine folds
  within 10 minutes of the claim (the same outcome check the stale-holder takeover already has). It shows when the
  evidence was received, not proof the holder was alive at the takeover (a dead holder may restart inside the window),
  and zero rows means zero detected cases, not zero cases;
- `error` when a claim is still held two TTLs after the first episode of a chain of re-opens, which means no pull round
  completed or this machine keeps stalling (the pool may be without a lead; C would otherwise have allowed the claim at
  one TTL). `held` is recorded once per chain. Note for the ladder: `held` rows enlarge the denominator of the shared
  `error-rate` metric; Rung 1 reads stall-reconfirm `error` rows by reason, not that ratio.

### 3. Switch and rollback

`multiMachine.takeoverReadyPool.stallReconfirm: { enabled?: boolean, stallGapMs?: number }`, resolved live by
`resolveStallReconfirm(config)` in `src/commands/server.ts` and handed to the coordinator as `stallReconfirm`. **Dark
everywhere:** only an explicit `enabled: true` turns it on; `takeoverReadyPool.enabled: false` (the project rollback)
turns it off. No config default is written, so no migration is needed and nothing changes on update. Off is
byte-for-byte today's acquisition: no timer, no stamp, no episode, no extra pull.

## Decision points touched

| Decision point | Classification | Basis and justification |
|---|---|---|
| While an episode is open, every claim needs C (one TTL awake with a completed fresh round) or the chain cap; otherwise one fresh pull per episode (attempted at most once) and no claim | invariant | basis: irreversible-consequence; evidence: a claim on a live holder's epoch forces a lead change and role restarts on two machines (16:09:48Z, two restarts); the rule only withholds a claim the normal rules would make, and C bounds the wait at one TTL awake |
| An episode opens when running time lost within one TTL exceeds 30 % of the TTL (floor 5 s; `stallGapMs` overrides, clamped to 1 s .. TTL/2) | invariant | basis: external-constraint; evidence: a live holder's folded copy has at least TTL/2 left at the fold (renewal cadence TTL/2) and then ages by the pull interval (5 s) and delivery, so the smallest loss that can make it look expired is about TTL/2 − 5 s − delivery (≈ 25 s at 60 s); 30 % (18 s) is below it with a margin; above TTL/2 an override could never fire in time |
| A gap counts as lost only at 6 s or more (three stamp intervals), and then whole | invariant | basis: external-constraint; evidence: the stamp runs every 2 s, so a 6 s gap means the loop ran nothing for at least 4 s; shorter gaps are scheduling jitter on a busy machine and, while the loop still runs between them, folding continues; the Laptop's starvation drifts were 11 to 21 s and the stall 226 s, all above it |
| No reply-content shortcut (a holder saying "I hold nothing" waits for C) | invariant | basis: irreversible-consequence; evidence: a pull reply carries no binding to the request that produced it, so a pre-stall "nothing" read at wake is indistinguishable from a fresh one; a wrong claim costs a lead change and two restarts, the wait costs at most one TTL |
| C: one TTL awake with a round started after the stall and completed | invariant | basis: external-constraint; evidence: it is today's expiry rule measured on an awake clock; a renewing holder reaches this machine at least twice in one TTL by push, and a completed round has folded whatever the holder returned |
| The gate's own fresh pull at most once per episode | invariant | basis: external-constraint; evidence: the 5 s pull loop already supplies rounds and nudges the tick every 5 s while a takeover looks eligible; a pull per nudge would double the pull rate of a machine that is already starved |
| The chain cap: ten TTLs | judgment-candidate | floor: the claim still needs a completed fresh round and the normal rules; arbiter: none; static because it only bounds how long a starving machine withholds a claim the normal rules allow, trading a wrong claim (one lead move) against a leaderless pool, and ten minutes is the outage the 00:27 incident already showed to be tolerable once |
| Gate inert on a git-only mesh (no pull-capable transport) | invariant | basis: enumerable-domain; evidence: with no pull path there is nothing to ask and C's completed round can never happen, so holding would make a git-only pool leaderless |

## Frontloaded Decisions

1. **Dark switch, not the development-agent ladder.** The brief asks for a dark switch; turning it on for Echo is a
   config flip the run lead makes after merge, never a side effect of an update.
2. **The coordinator measures its own lost time; SleepWakeDetector is not wired.** The detector suppressed tonight's
   226 s drift without an event, its classification is about wake recovery, not lease evidence, and wiring it adds a
   dependency whose event order at wake is not defined. The coordinator's stamp sees the same gap, every time.
3. **Own lapse, released and empty views are gated by C.** R1's ask can be switched off separately and can fail at
   wake, and a third machine may have taken a newer epoch during the stall; the cost is that a former holder (or a
   machine facing a released or empty view) waits one TTL awake after its own stall before claiming.
4. **A sustained starvation that re-opens episodes every few seconds blocks this machine's takeover of a dead holder
   until it stops losing time.** Stated and accepted: the feedback asks that a stalling machine never claim, a machine
   losing more than 30 % of its running time is a poor holder, and another machine in the pool takes over on its normal
   rules. On a two-machine pool the takeover waits until the starved machine recovers for one TTL, or at most ten
   TTLs (the chain cap).
5. **The holder side is unchanged.** This spec gates claims, not renewals. A holder that slept longer than a TTL may
   find, on waking, that a peer took a newer epoch; its monotonic self-fence (`lastRenewOkMonoMs`) does not see a
   macOS sleep, so it relies on the existing paths that learn a newer epoch (a verified higher-epoch ack on its
   renewal broadcast, `higherEpochEvidence`, and the pull loop's `peerLeaseSupersedes()` demotion). Whether those fence
   it before any holder work resumes is not established here; it is filed as an instar improvement in the feedback queue
   (fb-54f9ae11-2ca, the triage rule's third kind), not built over silently.
6. **The role-change restart that turns one wrong claim into two moves** (the feedback's last sentence) is not changed
   here: it is takeover-ready-pool R5 and PR #3604's subject, and this change removes the wrong claim that starts it.
7. **No owner notice.** Log lines and feature evidence are the record; nothing here needs the owner.
8. **Why not simply always pull once before claiming another machine's expired lease.** It fixes tonight's case when
   the pull succeeds, but a pull made in the first second after a stall often fails for reasons on this machine's side
   (its own network or the peer's reply not yet processed), and a failed pull then claims on the aged view, which is the
   incident. The episode keeps the claim held until positive evidence exists (C, or the chain cap), and it costs nothing when no
   stall happened.
9. **Shipping dark is accepted for now.** The brief (the run lead, with the Chief of Staff's approval of this fix as its
   own PR, 2026-11-21) asks for a dark switch. While dark, every pool keeps today's behaviour, including the wrong claim
   this spec describes; that fallback is named and accepted until the run lead's enable decision on the Echo pool. The
   run lead has made this the program's most urgent item (the Laptop grabbed the lead again at 08:30:23 PST), so the
   build run hands the exact config line back in its report for enabling on the Echo machines as soon as it merges.

## Multi-machine posture

- **The rule itself:** unified in effect. Every machine runs the same code on its own claims; the evidence it reads
  (probes, disclosed views, folded leases) arrives over the existing lease channel from the peers.
- **The awake stamp, lost-time samples and episode:** machine-local by design. They measure this process's own running
  time; on another machine they would describe a different process. In memory only, never persisted, never replicated.
  - machine-local-justification: hardware-bound-resource
  - The measurement is this host's own CPU run time and clocks, held in memory only; a peer's run time says nothing
    about this process, so unifying it would be meaningless.
- **Notices:** none.

## Verify the state, not its symbol

- **Symbol:** a gap between this process's stamps. **State claimed:** this process did not run, so what it folded is
  older than its clock says. **Corroboration:** both clocks (wall and monotonic) read independently; the evidence rules
  then require the holder's own silence after the gap, or a completed round and one full TTL awake, read from the transport. **Unmeasurable:** an
  unreadable switch reads off (today's behaviour); a fault reading the evidence holds the claim for that tick and logs
  the reason.
- **Symbol:** the holder's lease past `expiresAt` in this machine's view. **State claimed (today):** the holder stopped
  renewing. **Why it fails after a stall:** the view stopped being updated, not the holder. The rule replaces it, only
  while an episode is open, with C (or the chain cap), gathered after the gap.

## Failure modes

| Case | Outcome |
|---|---|
| Tonight: holder renewing, standby loses 226 s | episode opens; the claim triggers one fresh pull; the fresh renewal folds; `held-by-live-peer`; no claim |
| Holder renewing but unreachable for the first seconds after wake | held (waiting); the next renewal arriving by push or pull is folded and refuses the claim |
| Holder dead after the stall | C: taken over one TTL awake after the stall, once a fresh round has completed (60 s at Echo's TTL) |
| Holder released, a third machine took a newer epoch during the stall | held under C; the newer holder is adopted on the first round that reaches it, even if the first pull fails |
| Wall clock stepped backward during an episode | new rounds look older than the cutoff, so C and the cap wait out the step (safe side, bounded by the step) |
| Holder stayed live; hours later it dies | the episode aged out after one TTL awake; an ordinary takeover, recorded as such |
| Holder's server up but holding nothing | C, one TTL after the stall |
| A CAS loss after an allowed claim, the retry seeing another holder | the episode is still open; the claim is judged again under C |
| Holder silent only because this machine's own routes fail (#3604 cause) | silence is never read as death here; C after one TTL awake (today's rule on an awake clock) |
| Holder not dialable, or no dialable peer at all | C after one TTL awake with a completed round |
| This machine was the holder and stalled; a peer took over meanwhile; the first pull after wake fails | held (C); the next completed round brings the newer epoch, adopted, never contested |
| A second, smaller gap inside the episode, just before C's deadline | C's awake time excludes it and needs a round completed after it |
| Burst of 11 to 21 s stalls | sums inside one TTL, opens an episode like one long stall |
| Chain cap reached while the holder is live | the cap's fresh round folds the renewal; `canAcquire` refuses; no claim |
| Sustained starvation | episodes keep re-opening; no takeover by this machine while it keeps losing time, at most ten TTLs (the chain cap), then a completed fresh round decides (Frontloaded 4) |
| Wall clock stepped forward by NTP | a false episode: claims wait for C (safe side) |
| Switch flipped off mid-episode | the next stamp tick clears the clock and the episode; today's rule from then on |

## Testing

- **Unit, pure** (`tests/unit/StallReconfirm.test.ts`): threshold, floor and override clamps; wall/monotonic gap;
  lost time and its window; the dark resolution and the project rollback; C on both sides (one ms short, no completed
  round, awake-only time after a smaller loss); the chain cap on both sides and its completed-round requirement; own,
  released and empty views.
- **Unit, coordinator** (`tests/unit/LeaseCoordinator-stallReconfirm.test.ts`, real Ed25519 and `LocalLeaseStore`):
  tonight reproduced with the switch off (claims 23761) and fixed with it on (one fresh pull, holder re-confirmed,
  20 further ticks without a claim); holder unreachable for 20 s after wake then answering; holder dead (claim at
  exactly one TTL, `awake-ttl`); a former holder whose lead was taken during its stall, first pull failing, adopting the
  newer epoch, with boot claim safety on and off; a released view after the stall with one fresh pull adopting a newer
  holder, and with the first pulls failing then the newer holder adopted; an episode whose holder stayed live aging out;
  holder up and holding nothing (claim at one TTL); one fresh pull per episode, later held ticks adding none;
  local-refusal silence (claim at one TTL); no stall with the switch on and off (claim at the same tick, no extra pull,
  no log line); threshold boundary (18 s gap opens nothing, 19 s opens); a burst summing past the threshold; the same
  stalls spread past a TTL.
- **Integration over real HTTP** (`tests/integration/stall-wake-lease-reconfirm.test.ts`): a real `HttpLeaseTransport`
  dialling a real HTTP server serving the Studio's signed lease: switch off claims after the 226 s jump, switch on
  re-asks over HTTP and adopts the fresh renewal; Studio dead after the stall is taken over at one TTL (60 s); no stall, on
  and off, claims at the same moment.
- **E2E on the real boot path** (`tests/e2e/stall-wake-lease-reconfirm-boot-path.test.ts`): the real
  `MultiMachineCoordinator.initializeLease`, the production `resolveStallReconfirm`, fake timers; after a 226 s jump the
  heartbeat tick runs first: live, no claim and no promotion through three more minutes; dark, the claim at once; plus a
  wiring check that `server.ts` hands the coordinator `stallReconfirm: () => resolveStallReconfirm(config)`.
- Adjacent suites run as single files: `LeaseCoordinator-bootClaimSafety`, `boot-claim-safety` (integration),
  `boot-claim-safety-boot-path` (e2e).

## Maturation plan

Ships dark (Frontloaded 9).

- **ladder:** multiMachine.takeoverReadyPool
- **dark-window:** from merge until the run lead enables it on the Echo pool's machines by config (read live, no
  restart), which the run lead has made the program's most urgent item; the fleet stays on today's behaviour until the
  graduation criterion is met.
- **test-agent-live:** the three test tiers in this change (unit with real Ed25519 leases, integration over real HTTP,
  e2e on the real `initializeLease` and `tickLease` path), which reproduce the incident with the switch off and its fix
  with it on, on throwaway state.
- **dev-agent-live:** Echo's machines with `multiMachine.takeoverReadyPool.stallReconfirm.enabled: true`; evidence rows
  on `multiMachine.takeoverReadyPool` in `logs/feature-evidence.jsonl`: `held` once per chain, `fired` per stall-confirmed
  claim, `error` for a suspected overlap or a two-TTL hold.
- **fleet:** the default moves to the development-agent gate and then to the fleet in their own changes, each on the
  graduation criterion, through the existing ladder entry.
- **graduation criterion:** fourteen days on Echo with at least one stall-reconfirm `held` or `fired` row, zero
  stall-reconfirm `error` rows (no detected overlap after a stall-confirmed takeover, no lead-less two-TTL hold), no
  lead change caused by a machine that had just logged a SleepWakeDetector drift of 18 s or more, and the weekly
  takeover drill (takeover-ready-pool R9) passing its dead-holder phase on every run in the window.

## Rollback

Set `enabled: false` (or remove the block), or `takeoverReadyPool.enabled: false`: read live, no restart, today's
acquisition from the next tick. Nothing is persisted, so there is no state to repair. A code revert removes one module,
one coordinator block and one dependency line.

## Agent awareness

One entry, `src/data/awareness/stall-wake-lease-reconfirm.md`: what the switch does and that the `stall-reconfirm:` log
lines are where to look before explaining why a machine did or did not take the lead after a stall. No new route or
command.

## Open questions

*(none)*
