---
title: "Takeover-ready pool: losing any machine never silences a multi-machine agent"
slug: "takeover-ready-pool"
author: "echo"
parent-principle: "An Instar Agent Is Always a Multi-Machine Entity"
eli16-overview: "docs/specs/takeover-ready-pool.eli16.md"
review-convergence: "2026-11-20T19:47:14.411Z"
review-iterations: 6
review-completed-at: "2026-11-20T19:47:14.411Z"
review-report: "docs/specs/reports/takeover-ready-pool-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
single-run-completable: true
frontloaded-decisions: 9
cheap-to-change-tags: 0
contested-then-cleared: 5
clean-door-anthropic-review: "claude-code:claude-fable-5"
approved: true
approved-by: "echo, under the operator's standing rule (Justin, 2026-10-22 08:58 PDT: \"I should ONLY have to approve constitution changes\"); the design implements the owner-approved post-mortem v8 fix items 1-4, 14, 15, 17, 18 (Echo document 59c4af4d-1fd2-4885-b0ea-7205b3b1be74) and the run lead's 2026-11-20 scope additions; no constitution or CODEOWNERS path touched"
---

# Takeover-ready pool: losing any machine never silences a multi-machine agent

## Problem statement

On 2026-11-19 the Mac Studio, lead machine for Echo and Luna, failed a macOS upgrade. Three other Echo machines were
running and none took over. Echo was silent for 75 minutes, then mute in the owner's main conversation for 10.5
hours; Luna was silent for 11.2 hours. The owner-approved post-mortem (Echo document
59c4af4d-1fd2-4885-b0ea-7205b3b1be74, version 8; `docs/incidents/2026-11-19-studio-down-no-failover.md`) names the
causes. This spec covers issues A1, A2, A4, A6, A7 (failover notices), A8, A9, A10 and fix items 1, 2, 3, 4, 14, 15,
17, 18. Causes, as read in the code on origin/main at b61e7d3cd:

1. **Not polling means never taking over (A1, A6).** `MultiMachineCoordinator.resolvedLeaseRole()` derives
   `observe-only` from `multiMachine.telegramPolling: false` when no explicit `leaseSelfHeal.leaseRole` is set, and an
   observe-only machine never calls `acquireIfEligible`. `staleHolderTakeover.enabled` defaults to false and was off on
   the Mini. The same flag is a hard mute for the lifeline (`TelegramLifeline.reconcilePolling` → `force-mute`, a floor
   above the lease in `pollDecision.ts`; `holdPollAtBoot`) and the relay (`ThreadlineBootstrap` `relayStandby`,
   `connectEnable.ts`). The Laptop, the Mini and Luna's laptop were muted for day-to-day reasons; nothing told the owner
   that this gave up failover.
2. **The gap check counts the wrong thing (A1, A7).** `SingleMachineFailoverGapDetector` counts online peers, raises
   only while autonomous runs are active, and is dry-run.
3. **A machine that takes over can be mute (A2).** The owner's Telegram id and the private-group confirmation were
   per machine. On the Laptop and the rebuilt Studio every conversation ran in the fail-closed audience. With no owner
   recorded, `MemoryInboundTracker` (~line 123) treated each owner message as a non-operator and called
   `dropGroupConfirmation`. When the audience later became the owner's, the session restarted fresh.
4. **Boot claims from a stale own lease (A4, fb-2bf6ccd0-705).** A restarted Laptop read its `lease-local.json`
   ("holder=self, lapsed"), could not reach the Studio in its first ~10 s and claimed the Studio's epoch. The
   ask-peers-first branch in `LeaseCoordinator` (~934, `pullWithin`) requires `survivorMayHold()`, which `server.ts`
   ~6988 makes false whenever `preferredAwakeMachineId` is set; and the boot claim in `MultiMachineCoordinator`
   lease-init (~1377) runs before `startLeasePullLoop()` (~1390), against the stale local view.
5. **A holder loses the lease when a peer restarts (Luna, 2026-11-20 10:53 PST).** Restarting Luna's standby made the
   Studio log "lease renewal unconfirmed" for 60 s, then lapse its own lease; no sends for ~25 s. The hold that keeps it
   (`soloCaptainHold`) is disabled when a preferred machine is named.
6. **Role changes restart the server, and the takeover wait is shorter than a restart (A4, fb-f5578db3-495).**
   `roleFollowRestart` restarts on every role change. The Laptop took over after 48 s; its start takes ~4 minutes. Each
   restart moved the lead and caused another: ~19 moves overnight, 36 in six hours next morning. `churnDetector` is
   dry-run. PR #3521 withdraws a stale role restart; it does not stop the moves.
7. **A rebuilt machine split the pool (A9, fb-eaa44bee-fa5).** The rebuilt Studio (new id) was paired with two of four
   peers. The Mama PC and M5 Pro kept a pool listing the dead id; the Mama PC held every Telegram send from ~01:46 to
   09:32. `splitBrainState` compares leases, not memberships, and read `clear`; the Mini, in both pools, masked it.
8. **Conversations owned by a revoked machine never move (A10, fb-b3d47791-3fb).** `StaleOwnerReleaseEngine` needs
   death evidence a revoked machine never produces and is dry-run; on a two-machine git-less pool it passes quorum
   (`machines.length <= 2`, ~line 399) and then refuses with `two-machine-gitless` (~605).
9. **A session speaks only through a machine that can send (A8).** A non-holder's reply is forwarded to the holder by
   the existing ladder (`OriginForwardToHolder.ts`). On 2026-11-20 at 19:01 UTC (operation 51cd829e…) the Studio's
   forward was refused by the Mini (holder) with `credential-capacity-unavailable`, recorded `retryable: false` and
   held; the hold notice was not sent; the holder's recovery later refused it "by policy". Earlier (09:32–09:55 PST)
   replies queued on the dying Laptop while the healthy Studio held the lease.
10. **Nobody was told (A7).**

The standard: an Instar agent on more than one machine never becomes unreachable because one machine went down.
Acceptance is the post-mortem's Drill 1: stop the lead; within five minutes another machine answers a real owner
message in a real conversation, with tools; the lead returns once, without ping-pong; weekly, on its own.

**Parallel work this spec consumes, not duplicates.** `fix/unroutable-owner-release` (`src/core/unroutableOwner.ts`)
releases topics of revoked or unregistered-and-silent owners (R7 consumes it; its merge is part of this project's
completion). `echo/no-data-loss-on-machine-death` owns fix items 6–13, including the rebuild command and the local
emergency-patch register; R4's kit and R6's replacement record are written as kinds of its critical-state registry.
PR #3521 stays as R5's fallback. An external arbiter (a third-party lease service) would collapse much of R2 and R6;
it is rejected because these agents run with no shared medium and no paid service (the constraint of
lease-takeover-no-shared-medium), and for Telegram agents Telegram itself serves as one (R2).

## Proposed design

Ten requirements. Each says how the weekly drill (R9) proves it. All new behaviour sits behind the ladder
`multiMachine.takeoverReadyPool`. Terms: **W**, the takeover wait (R5); **posture row**, a machine's takeover record
(R3); **episode**, one continuous instance of a condition, keyed as stated; **lifeline**, the small supervisor process
that owns the Telegram poll and restarts the server; **Needs-you line**, an entry on the owner's list of things that
need them (`GET /needs`); **ladder/rung**, the staged rollout switch and its stage (test agent, development agent,
fleet).

### R1. Boot claim safety (build increment 1, standalone)

From process start until this machine's first successful pull from any peer (the *boot hold*), these rules apply to
every claim, whatever `survivorMayHold()`, `soloCaptainHold` or `preferredAwakeMachineId` say (fb-2bf6ccd0-705):

1. If `lease-local.json` says this machine held last, it pulls before any claim. Its own lapsed lease is never
   permission to re-take it.
2. A machine that is not the named preferred machine and has reached no peer since boot defers every claim.
3. While the named preferred machine answers at all, the deferring machine never claims. "Answers" means a signed
   liveness reply on any transport, or an HTTP response that carries Instar's own response marker (the server sets
   an `X-Instar-Machine` header on every response, including errors while starting) on an endpoint whose kind is
   Tailscale or named tunnel. A 52x or 530 status is the tunnel edge speaking for a dead origin and never counts, and
   a legacy dial with no endpoint kind counts only signed replies. An unsigned answer counts for at most the preferred
   machine's published restart time (`restartBudgetMs` p95, R5) plus 60 seconds, with a 45-second floor and a
   10-minute ceiling; until R5 publishes it, the interim window is 45 s plus 3 minutes. After the window only a signed
   reply counts, so a wedged preferred machine answering errors for ever cannot keep the pool silent.
4. The boot hold ends, and the normal acquisition rules apply, when a peer pull returns a lease view that names a
   live holder or an epoch strictly newer than this machine's own record (a standby holding the same stale view does
   not count; the probe round continues), or when the preferred
   machine has been silent on at least three probes spanning at least 45 seconds. With no preferred machine named, or
   when this machine is the preferred one, the same test applies to every known peer. A git-only lease store counts a
   refresh only when it fetched from a remote; a git store with no remote counts only a peer's HTTP reply, since a
   local write proves nothing about a peer.

After the hold, the normal rules still require the holder's lease to have lapsed. The preferred machine is not exempt
from rule 1: on return it adopts the current epoch and gets the lead back only through `LeaseHandbackReconciler`. Each
decision is logged `boot-hold: <rule> <verdict>`.

**What it changes.** Four places: `LeaseCoordinator` (rule 1 drops the `survivorMayHold()` and `soloCaptainHold`
conjuncts from the ask-peers branch and reuses `pullWithin`; rules 2–4), `HttpLeaseTransport` (a `responded` outcome
distinct from `confirmed`, read from the `X-Instar-Machine` marker and the endpoint's `kind`, and per-peer probe
history; today every non-2xx reply collapses to `{confirmed:false}`), the server's response middleware (the marker), and
`MultiMachineCoordinator` lease-init (the boot claim goes through the boot hold after the pull loop starts, not
before). Switch: `multiMachine.takeoverReadyPool.bootClaimSafety`, on for ladder agents.

**Retiring the interim hotpatch.** The same logic runs today as a local hotpatch on the Laptop (Echo and Luna) and the
Mini. An auto-update wiped an earlier one silently at 10:23 on 2026-11-20. Until increment 1 is live on those
machines, auto-apply is held there (a rollout step of increment 1, recorded in its PR). Increment 1's release lists fix
id `boot-claim-safety`; once a release carries it, overwriting the patched file installs the same logic, so nothing
needs retiring by hand. The general mechanism, in which a declared patch survives an update or the update refuses
loudly, is the rebuild work's local-patch register.

**Drill proof.** Phase B (R9): the returned machine's log shows `boot-hold` deferring and then adopting the survivor's
epoch; a same-epoch contest fails the drill.

### R2. A holder keeps the lease through a peer outage; Telegram breaks ties

**Holding.** A holder whose renewal cannot be confirmed because peers are unreachable keeps the same epoch in every
pool size and shape, until it sees a higher epoch, higher-epoch evidence, or the Telegram evidence below. A majority
rule for pools of three or more was rejected: Echo's five-machine pool routinely has two members off, so the Laptop
and Mini alone could not form a majority after a Studio loss, and a sole survivor cannot tell itself from a minority
side. A joiner without lasting-link proof keeps its `acquireHeldBack` rule.

**Telegram as tie-breaker.** Telegram admits one `getUpdates` caller per bot and ends the older request with a 409
when a newer one arrives, so two pollers knock each other off alternately; a 409 says another poller exists, not who.
The rule needs no message between the two sides:

- *Rank.* Eligible members are totally ordered: the named preferred machine first, then by machine id.
- *Persistent 409s* (the existing `hasRecent409`/`consecutive409s` test in `TelegramLifeline`, excluding 409s while
  its own lifeline hands over, and only after `getWebhookInfo` shows no webhook) are acted on by any holder, whether or
  not its renewal is confirmed, because a split can leave each side a peer to confirm with.
- *Who yields.* A holder that sees persistent 409s compares the highest-ranked member it can reach (itself included)
  with the highest-ranked *contender*: an eligible member it cannot reach whose last posture row was ready and fresher
  than `failoverThresholdMs` at the moment this machine lost reach to it. A machine that was already asleep, dead or
  "often off" before the cut is on neither side and never counts, and nor does one whose last posture row said its
  server was down (a dead server whose lifeline still polls). If the live unreachable one ranks higher, it yields: it stops polling, sending and its
  scheduler, and pulls peers. The decision is kept for the episode rather than re-evaluated as observations age. In a
  clean cut the two sides are complements and share the membership view, so exactly one yields. If no live member is
  unreachable, the poller is not one of ours.
- *Resuming.* A yielded machine probes once per backoff step (30 s doubling to 2 minutes, with random jitter): a
  single long-poll that processes nothing and does not advance the offset; an immediate return backs off rather than
  looping. It resumes on the first of:
  1. the contender it yielded to becomes reachable (normal lease rules then decide);
  2. a peer epoch showing that contender has gone, or a signed "poll released" record from the contender's lifeline, bound to its lease epoch and release time and
     valid for that episode only
     (sent to every member it can reach when it releases the poll because its server is down, R2 below), which covers
     a wedged server whose lifeline kept polling;
  3. two consecutive probes that each spanned a full long-poll timeout with no 409 (the winner retries at a flat
     interval, below, so a full silent long-poll means nobody is polling; this covers a contender that died at the cut),
     or, once the yield has lasted one W, two probes that returned at once with no 409 and the same head update id
     more than one flat-retry interval plus one long-poll apart (nobody is confirming updates);
  4. the yield reaching 2W.

  On resuming it serves for the rest of the episode and does not yield again in it. A contention episode runs from the
  first persistent 409s until the contender is reachable again (the cut heals) or is known gone. A confirmed renewal from a peer on
  its own side is not a reason to resume. The winning holder, while its trace reads "another machine of ours may be
  answering", retries an isolated 409 (one not followed by another within the next poll) at a flat interval of at most 5 s, and
  always under half the probe's long-poll timeout,
  instead of the lifeline's exponential backoff and skips the periodic poll reclaim, so probes never push it into a
  long backoff; 409s that persist for the winner itself return it to the lifeline's normal backoff, capped at 60 s, and to its own
  yield evaluation unless it has already resumed in this episode (a resumed side never yields again in it); the flat
  mode ends with the episode.
- *Defects, once per episode.* Persistent 409s with no contender may be a stray program holding the token, or one of
  our own machines on the wrong release (members' poll state in their posture rows is checked first and named if
  found): one "another program is using this bot" defect; the machine keeps serving. After a resume at 2W with a known
  contender, one recoverable notice names it ("The Studio was unreachable from 14:02 and may also be answering; each
  message still gets one reply in most cases"), never "another program". During a cut that resolves before 2W the
  condition stays in the decision trace only.

**What this does not fix.** If one side of a cut cannot reach Telegram it serves nobody. With reachability that is
neither symmetric nor transitive, both sides may keep serving; scheduled jobs then run on both sides until the link
heals, as lease-takeover-no-shared-medium accepted. Telegram hands each update to whichever poller asks, and keeps it
until a higher offset confirms it, so during such a cut an update fetched by both before confirmation can be answered
twice; replies are deduplicated by bot and update id within each side and, after the cut heals, across the pool. Agents without
Telegram keep that cost.

**Acquisition on a named git-less pair.** lease-takeover-no-shared-medium Change 1 (`localCommitIsFinal`) accepts an
exact local git write only when no preferred machine is named. On ladder agents the "no machine named preferred" conjunct (via
`survivorMayHold()`) is dropped from it; the "no git remote" condition stays. So a named pair whose git lease has no
remote to push to can complete a takeover at all.

**The lifeline never strands an owner message.** Telegram treats an update as received once any `getUpdates` call
asks for a higher offset. The lifeline calls it from four places (the main poll, the boot flush, its retry and the 409
reclaim), all reading one saved `lastUpdateId`. While its server is down, the lifeline derives `lastUpdateId + 1` (the
one value every call takes its offset from) only from the contiguous prefix of received updates that a second member
has acknowledged: a receipt for update 102 while 101 waits does not move the offset past 101. Each update it queues in
its `MessageQueue` is sent, signed, to one reachable member, which writes it to disk and returns a receipt signed by its
machine key and bound to the bot id, update id and a hash of the update; the lifeline accepts receipts only from active
members in its snapshot, and the member's route dedupes by bot and update id, so a resend after a lost receipt is
harmless. Updates awaiting a receipt are kept in a durable pending set, so a lifeline restart cannot confirm them.
While the head update lacks a receipt Telegram returns the same batch at once on every call, so the lifeline skips
refetched updates already pending and backs off between calls (doubling, up to 60 s) until a receipt or a reachability
change. If no member is reachable, the offset does not move and the update stays at Telegram for a survivor, for as long as
Telegram keeps it (about 24 hours). When the server has been down
longer than max(W − 30 s, 30 s), the lifeline stops calling `getUpdates`, releases the relay, and sends a signed "poll
released" record to every member it can reach. A member that
receives a handed-off update passes it to the holder, which answers it after the pooled-history check
(failover-reanswer); a receiver that cannot reach a serving holder keeps it and answers it itself when it becomes or
reaches the holder. When the server returns, it replays its own queue only after its pooled inbound history has
synced (up to 60 s) and drops any update already answered elsewhere. Polling resumes when the lease says awake.

New parts this needs: the lifeline reads the machine signing key from the same keystore as its server; it keeps an
on-disk snapshot of the member list and endpoints, refreshed by the server, for use while the server is dead; members
gain an authenticated receive-and-receipt route for handed-off updates; the pending set is capped to bound memory and handoff
fan-out (updates past the cap are not fetched yet and stay at Telegram); the snapshot file is mode 0600, and the server rewrites it on every
registry change, so a revoked member stops being a handoff target at once.

**Drill proof.** Phase S restarts each standby while probing the holder: `holdsLease` never goes false and every probe
is answered (Luna's failure). A canary on the throwaway pool runs two real pollers against Telegram and asserts the 409 behaviour this rule relies
on, so a change on Telegram's side is caught. Integration tests: a two-machine cut and a three-machine cut where each side keeps a peer, with 409s
delivered to each side; a probe that must not take over while the other side still polls; a wedged holder server whose lifeline keeps
polling, then releases; a clean cut longer than 2W; out-of-order receipts and a lifeline crash before a missing
receipt arrives.

### R3. Takeover eligibility is its own setting; a pool keeps two eligible machines

**Separate the meanings.** Under the ladder `telegramPolling: false` means only *do not poll or hold the relay while
standby*. Every consumer changes from hard mute to "standby-only, follows the lease":
`TelegramLifeline.reconcilePolling`, `holdPollAtBoot`, `shouldOwnTelegramPoll`, `ThreadlineBootstrap` `relayStandby`,
`connectEnable.ts`, `machine.ts` `leaseObserveOnly`. `pollFollowsLease` resolves `dryRun: false` on ladder agents.
`resolvedLeaseRole()` stops deriving `observe-only` from the flag. The hard exclusions are `pollOverride:
'force-mute'`, an explicit `leaseRole: 'observe-only'`, and the takeover setting below. On an eligible machine
`staleHolderTakeover.enabled` resolves true unless explicitly false, which makes it ineligible. R1 ships first because
it removes the boot epoch leapfrog that derived `observe-only` once guarded against (2026-05-31).

**The takeover setting is pool-wide.** `takeover-setting` is a replicated, signed record keyed by machine id
(`eligible: true | false`, setter, HLC), settable from any member, so the owner can keep a machine out while that
machine is off. A migration, `migrateTakeoverEligibility()`, runs only on ladder-rung agents, writes nothing to
`leaseRole`, and writes `eligible: true` for each machine with no record and no hard exclusion. It posts one note on
the Updates topic, without a push, listing every machine it made eligible, each with a one-tap "Keep this machine from
taking over" (a Needs-you line only if the change leaves the pool short of R3's invariant):
"The Laptop and the Mini can now take over if the lead machine stops. They still won't read Telegram day to day." For
Echo and Luna the owner approved this as post-mortem fix item 2.

**Posture rows.** Each machine publishes `{ machineId, release, eligible, ready, reasons[], restartBudgetMs,
claimToReplyMs, observedAt }`. `eligible` comes from the effective acquisition checks (lease role active, not
`acquireHeldBack`, `staleHolderTakeover` live, no hard exclusion); `reasons` from a fixed code enum. Rows are signed
(R4's record signing) and ride lease pull responses and heartbeats as a separately signed sibling field, outside the
lease signature, so older peers verify the lease unchanged (unknown-field tolerance tested both ways). `GET /pool`
serves them merged through the existing pool cache. Evaluation is async and reads only cached inputs.

**The invariant.** A pool of two or more active machines needs at least two eligible-and-ready members, counting the
holder. `GET /takeover/readiness` returns `ok | defect | unknown` with each row. A row older than the lease's
`failoverThresholdMs` (`FencedLease.ts`) counts as not ready ("could not check <machine>"). `ok` needs a fresh row from
a reachable spare. A member the owner marks "often off" whose row is stale makes the verdict `degraded-coverage`: shown
on the readiness page and in one Needs-you line ("If the Studio stops while the Laptop is asleep, nobody can take
over"), updated in place, never repeated. A
member on an older release that publishes no row is `version-skew`, not a defect, for 24 hours from when that member
was first seen lagging. The holder then asks that member to update itself through its authenticated update route, which installs
the latest release from the normal channel and accepts no version or artifact from the caller;
only if that fails or the member is unreachable does it become "update <machine>".

`SingleMachineFailoverGapDetector` gains mode `no-takeover-capable-peer`, not gated on autonomous runs, evaluated and
raised by the holder only, with a pool-wide dedupe key, live on ladder agents.

**Drill proof.** Preflight requires `ok`. When the pool has a machine with `telegramPolling: false` it is the expected
survivor, so a pass proves a quiet machine takes over and polls.

### R4. A machine may lead only if it can answer: the readiness gate

| Check | Reads | Corroboration | Cost |
|---|---|---|---|
| Conversation settings | bot token, Telegram group id, hub topic ids (Attention, Updates, Chief of Staff) | `getMe` ok within 30 min (refreshed every 10); topic ids equal the kit's; the origin egress capacity authority could issue a grant if promoted (account configured, credential present; "not the lease holder" is ignored on a standby), and an actual grant is required in the post-claim self-check | one HTTP call per 10 min |
| Owner recorded | owner-record chain (identity-security 2a/2b); the owner's Telegram id comes only from it | chain verifies; a conflicting id anywhere is a defect, never last-writer-wins | local |
| A working model | for the agent's framework: a subscription-pool account, or a configured local or API model | credential valid and not quota-walled by the existing quota read, or the local model's health check; no model call | local |
| Owner group confirmed | the replicated confirmed-private-group entry | no join since the baseline in the merged membership log, no polling gap longer than 24 h (Telegram keeps updates about a day), and the member count not above the baseline | one count per 10 min |

An unreadable input makes that check `unknown`, counted not ready.

**Record signing (new machinery, shared with R3, R6 and R9).** Each record of these kinds carries an end-to-end Ed25519
signature by its issuer over a canonical payload and an HLC version, checked against the issuer's registry key at
every hop, so a record relayed through a third member verifies (the journal's first-hop binding in
`JournalSyncApplier` is not relied on).

**The takeover kit.** `takeover-kit` replicates the owner-record reference, the confirmed private groups (baseline
count, membership log) and the hub topic ids. The membership log comes from `chat_member` updates, which the pollers
start requesting (`allowed_updates` today is `message` and `callback_query` only; the bot is a group admin because it
manages topics); it is merged across replicas as a union of events keyed by update id, so a join recorded by any poller
is never lost to a newer kit. A join, or a gap, disqualifies the group until it is reconfirmed. A poller records each `chat_member` event into the kit
before its next `getUpdates` call confirms the batch that held it, so a confirmed membership change is never missing
from the kit. What counts as a gap: any period with two pollers (R2), since one side may have confirmed a join the
other never saw, and polling interrupted for longer than Telegram keeps updates. Kit replication cannot reconfirm it; the owner does,
with one tap ("This group is still just you") on the existing Approve surface, offered by R10's can't-reply notice
with cause `group-unconfirmed`. A receiver applies the newest HLC version from an active member, and
owner fields only when they match the owner-record chain. `isOperator` resolves from the chain via the kit, so an owner
message never drops the confirmation; with no owner recorded the drop still happens and readiness reports
`owner-missing`. A session that ran in the fail-closed audience resumes, rather than starting fresh, when its place
becomes the owner's only if a signed confirmed-private entry exists for the place, the group check passes at that
moment (so the next reply's readers are the owner alone, as far as Telegram reports), and every inbound message in
the session came from the owner's id.

**Where the gate acts.**
- Continuously, from cached reads, published in the posture row.
- Before claiming: a not-ready machine does not claim while a ready eligible member is alive, for up to 2W of lapsed
  lease; after that it claims anyway and the stalled ready member is reported.
- No ready member at all: not-ready eligible members claim after one W, ranked by what they can still do: first
  conversation settings (it can send the notice), then owner recorded, then account, then group; ties by machine id.
  The winner sends R10's can't-reply notice.
- After claiming: within 2 minutes the holder self-checks (owner-audience dry evaluation of an owner message, `getMe`,
  a silent send to the drill topic). A failure marks it not ready.
- Degraded holder: a not-ready holder that sees a ready eligible member hands the lease to it through the existing
  relinquish path, at most once per 15 minutes per episode.
- Self-heal: a failing check pulls the kit from the holder and at most one other member and re-reads account state,
  under the brakes below.

**Drill proof.** The probe (R9) is answerable with tools only by a holder with the owner-equivalent audience; the
self-check and the dry evaluation are in the report.

### R5. A role change does not restart the server; W fits the five-minute bound

**No restart on role change.** Every eligible machine builds its scheduler at boot whatever its role, paused when
standby (no cron registration and no `paused` skip rows while paused). Promotion calls a new `scheduler.onPromoted()`
that re-reads the recent promotion and runs the missed-job sweep with each job's `catchUpPolicy` (today only `start()`
does). Demotion pauses at once. The other boot-role consumers follow `roleChange`: `CrashLoopPauser`,
`TelemetryCollector`, `IntegrationGate`, the boot git pull, the Telegram startup topology. A lint bans reads of
`coordinator.isAwake` in boot scope outside a `roleChange` handler, with an allowlist file; `roleFollowRestart` then
restarts only for listed consumers.

**W.** W = 300 s − the pool's p95 claim-to-reply time − the renewal interval − 15 s margin, with a 180 s ceiling, a
60 s floor (below it a brief stall would hand over the lead), and no more than the configured `staleHolderTakeover`
wait when that is smaller. If the floor wins, the five-minute budget cannot be met on that pool, and readiness reports
`slow-pool` with the measured time. Claim-to-reply time (lease claim to a
delivered tool-using reply: poll start ~35 s, session spawn, tool call, send) is measured by every drill and every real
takeover and published in posture rows; until five observations exist, 125 s is assumed, and with fewer than twenty the maximum is used instead of a p95, so W defaults to 140 s with a 20 s renewal
interval. There is no planned-restart extension: with no role restarts, a holder slower to restart than W (the Laptop,
~4 min) is taken over once and gets the lead back at most once through hand-back. Each holder publishes its restart
time (persisted wall-clock stamp at exit to first confirmed renewal) as `restartBudgetMs`; above W it is reported as
`slow-start`.

**Churn guard, one target.** `churnDetector` resolves `dryRun: false` on ladder agents. On a latch every machine
computes the same target from posture rows: the current holder if ready, else the preferred machine if ready, else the
lowest machine id among ready eligible members. Because rows can lag, a machine acts on the latch only after two
consecutive evaluations agree. Non-targets stop contending for the latch period; a latched machine is exempt while the
target is non-renewing for W. The pin is recorded on the Updates topic without a push and in the decision trace; a
repeat latch is the agent's own defect to diagnose, not an owner notice.

**Drill proof.** Phase P records zero server restarts on the survivor for the takeover and that its scheduler ran the
missed-job sweep and its next due job. Phase B allows at most two role flips in 30 minutes, with no latch.

### R6. A rebuilt machine replaces its old identity everywhere; split pools are detected

**Replacement record.** `instar join … --replaces <oldMachineId>` (offered automatically only when the joining
machine's hardware UUID matches a revoked or unreachable member) has the inviting member issue a signed
`machine-replacement` record `{ id, oldMachineId, newMachineId, newKeys, keyFingerprints, oldJournalWatermark,
issuedAt (HLC), issuer, ownerApproval }`. `ownerApproval` is the owner's tap on the existing Approve/Decline surface in
the authenticated operator topic; where the owner-record chain has an owner key, its countersignature is used. A
receiver refuses a record whose `oldMachineId` showed signed liveness within W or is the holder it sees.

**One winner, history kept.** If two valid records name the same `oldMachineId`, every member picks the same one:
lowest (HLC, issuer). The loser's new machine is not activated and the conflict is a `pool-diverged` defect. A member that already
activated a record and later learns of a lower-ranked winner revokes the machine it activated, removes its keys and
lease eligibility, and fences any lease epoch it held, so every member converges on the same active set. The old
key is retired, not deleted: it verifies only records at or below `oldJournalWatermark` (the last journal entry
accepted from the old machine), so its history still passes (fix item 7) and a stolen old key cannot backdate new
records. It is never accepted for forwarded replies (R8). Applied records are archived.

The new machine counts as eligible (R3) only once it is ready (R4), so it cannot lead before it can serve; restoring
its data is the rebuild work (fix item 12). A verifying member revokes the old id, adds the new one and forwards the record to every member it knows, directly or
through a member that reaches the target. Records are deduplicated by `id` and idempotent. No SSH or remote spawn.

**Membership digest.** `poolDigest = sha256(sorted (memberId, keyFingerprint) for active members, sorted revoked ids,
sorted applied replacement ids)`, in pull responses, heartbeats and `GET /pool`.

**Two states.**
- `pool-diverged` (a `splitBrainState` value): a reachable member's digest differs. Self-heal: exchange signed
  membership records and apply every verifiable one while the differing set shrinks; a defect when two exchanges in a
  row do not shrink it, or after ten. A member of both sides (the Mini) compares with each peer, so it reports the split.
- `member-unreachable`: an eligible member unreachable on every route for three days. One Needs-you line for the pool,
  listing such members, updated in place; "often off" members excluded.

A machine whose only known holder is revoked (the Mama PC case) reads `pool-diverged` and its held sends say so.

**Drill proof.** Preflight compares digests across reachable members. The replacement path is proven on a throwaway
pool: wipe a member, rejoin with `--replaces`, every digest converges, including a member reachable only through a
third; two competing records resolve to the same winner on every member.

### R7. Conversations owned by a revoked, replaced or absent machine move to a live one

- **Revoked or unregistered-and-silent owner:** `fix/unroutable-owner-release` (`assessOwnerRoutability`). This spec
  adds that an applied replacement makes `oldMachineId` revoked for this purpose, and that the lease holder claims.
- **The previous holder:** a machine that took the lease over from the topic's owner claims the owner's topics at
  takeover; the lapse and W already are the death evidence, so no further `deathEvidenceMs` wait applies and the
  five-minute budget holds.
- **Any other absent owner:** `StaleOwnerReleaseEngine` live (`dryRun: false`) on ladder agents, with the
  `two-machine-gitless` refusal lifted only when the claimant holds the serving lease at an epoch it took over, the
  owner has been unreachable on every transport for `deathEvidenceMs`, and its lease observation has lapsed.

Claims go through the reconciler's CAS funnel and bump `ownershipEpoch`. A router on a non-holder forwards inbound for
an unroutable owner to the holder. The send is gated on the local ownership record at fire time, and the new owner
reads pooled history (failover-reanswer) before answering a waiting message. During a cut with both sides online, R2's
409 rule makes one side yield, so it receives no new messages; one already in flight on both sides can be answered twice.

**Drill proof.** The drill topic is owned by the holder before phase P; the survivor's answer within the bound proves
the previous-holder path. The revoked path is proven on the throwaway pool during R6's check.

### R8. A session's reply gets out through whichever machine can send (A8, fix item 15)

This changes the existing forward ladder (`OriginForwardToHolder`, a2a-single-agent-identity §4,
standby-durable-forward-without-token) and adds no record kind:

- **Readiness covers egress.** R4's conversation-settings check includes the origin egress capacity authority. A holder
  that cannot issue a send grant is not ready, so R4 hands the lease to a ready member rather than holding it mute.
- **Capacity refusals name their cause.** `credential-capacity-unavailable` covers a full rate window or a fresh
  boot (transient: retried on the ladder's backoff, never final on the first refusal as at 19:01 UTC) and also "this
  machine does not hold the lease" or "account not configured here" (durable: these make the holder not ready under
  R4 instead of being retried for six hours). The hold row records which.
- **Every refusal names its cause.** A holder-side refusal (the 19:01 "by policy" verdict) records which policy in the
  hold row; tracing that verdict is the increment's first task. A hold whose notice was not sent (`notice-not-sent`)
  goes to R10's can't-reply path instead of being dropped.
- **The holder keeps what it was handed.** Held rows on the origin are machine-local and peers see only metadata
  (standby-durable-forward-without-token §9), so a holder cannot carry what it never received. Instead, a forward that
  reached the holder and could not be sent for a retryable cause stays in the holder's custody: it keeps the content
  in its own durable outbound queue, retries it itself, and settles the origin's row with its receipt, so a sick or
  dying origin (the Laptop at 09:32) no longer matters once the first forward got through. No new exposure: the holder
  already received the content in the forward. A reply that never reached any other machine still depends on its
  origin recovering; that residual is reported in the hold row and through R10.
- **Guarantee, stated honestly.** At most once per lease epoch. A duplicate is possible if a holder dies between
  Telegram accepting a send and recording the receipt, during a dual hold, or when a lead move supersedes a row under a
  new operation id while the old holder's send is in flight.
- Rows keep the ladder's existing 6-hour deadline; retired keys (R6) are not accepted.

**Drill proof.** Phase P runs a probe session on the conductor that replies while the lead moves; phase B one on the
survivor while it moves back. Each reply is delivered within 60 seconds of being written, with no duplicate seen, by the machine holding
the lease at the time.

### R9. The weekly "pull the plug" drill, automated

**Roles.** `takeover-drill` is a built-in weekly job on the holder's scheduler. The holder writes a signed, replicated
`drill` record `{ drillId, holder, conductor, expectedSurvivor, windowStart, windowEnd (HLC) }`. The conductor is an
eligible, ready non-holder, preferring one that is not the expected survivor; in a two-machine pool it is the survivor.
The conductor acts on the replicated record, not its own scheduler, so it runs while standby. Reports are a replicated
record kind at `GET /takeover/drills`.

**Window.** The quietest hour of the past four weeks on the drill weekday, not within 24 hours of a real failover. A
preflight skip is retried next day; three consecutive skips are a defect. A skip because readiness is not `ok` is the
R3 defect, and the report says the round trip is unproven until fixed.

**Hold.** The holder exits only on a separate signed `start-hold` command from the conductor, sent after preflight and
phase S, only for a drill record it issued itself, at most once per seven days. It writes a sleep marker of a new kind
`drill` carrying `windowEnd`, under the existing sleep-marker contract honoured by `ServerSupervisor` and
`RecoveryEngine`, extended to `ForegroundRestartWatcher` and the planned-exit path. Inbound messages do not wake a
`drill` marker, and every reader ignores it past `windowEnd`. The lifeline releases the poll as in R2. Its own dead-man
timer restarts the server at the hold's end whatever the conductor does; the conductor can end it early with a signed
cancel.

| Phase | Action | Pass |
|---|---|---|
| P0 preflight | readiness on all members; digests over reachable members; no owner message in the last 10 min; no Local Verify run on the holder | readiness `ok`, digests equal; else skip with reason |
| S standby restart | the holder restarts each standby in turn through that standby's authenticated `POST /server/restart`, the conductor included and waited for, probing itself | holder `holdsLease` never false; every probe answered |
| P plug pull | `start-hold`; holder down 10 min; probes to the drill topic; an R8 session reply on the conductor | within 5 min of the hold a survivor holds the lease, polls, answers with a tool call, delivered the failover notice, ran the missed-job sweep, restarted nothing for the role change; the R8 reply delivered once |
| B return | dead-man restart | `boot-hold` deferral and epoch adoption; one return notice; an R8 reply on the survivor during the move back; then 30 non-disruptive minutes with at most two role flips and no latch |
| R report | signed report | pass or fail per requirement, with measured claim-to-reply time |

**Abort.** The conductor cancels the hold if no survivor holds the lease 5 minutes after it starts, if a real owner
message stays unanswered for 2 minutes, or if members disagree on the holder 2 minutes after a takeover.

**Probe.** Sent over the mesh, signed by the conductor named in the drill record, nonce single-use, accepted only in a
window present in the receiver's own copy. The receiver builds the text from a fixed template (read the nonce from the
drill file, reply with it). It comes from a `drill` principal, never attributed to the owner, and gets the
owner-equivalent audience in the drill topic for privacy only, never owner authority; learning, commitments, approvals
and failover-reanswer skip drill-marked messages.

**What it cannot prove.** It cannot type as the owner, so Telegram's inbound delivery of a person's message is proven
only when real owner traffic falls in the window; otherwise the report says "inbound from a person: not exercised".
After every real or drill failover, the first real owner message to the survivor is tracked with the times of lead
loss, claim, its arrival and the reply's delivery.

**Outcome.** A pass is recorded quietly; a fail is one Needs-you defect naming the requirement in plain words.

### R10. One plain owner notice: failover, return, can't reply, no takeover possible

One `PoolNoticeEmitter`, run only by the holder, sends at most one message per episode: takeover epoch, hand-back
epoch, can't-reply episode, invariant episode. A change in the failing codes within an open episode edits the existing
message and Needs-you line in place; at most two pushed messages per agent per day come from this emitter, except can't-reply on the holder, which
is never held back by the cap but is pushed at most once an hour; changes inside that hour edit the same message. The owner
asked for failover and return notices (fix item 14, approved); they go without a push sound (Telegram
`disable_notification`), failover to Attention and return to Updates. Can't-reply and no-takeover-possible are pushed.
Each says what happened, what it means and what to do, in plain words, with the cause from fixed text per reason code:

- Failover: "The Studio stopped answering at 14:22. It may be switched off or stuck. The Laptop took over at 14:26 and
  is answering your conversations."
- Return: "The Studio is back and has taken over again."
- Can't reply: "I can't reply in conversations right now because this machine has no record of who you are. I'm fixing
  it now." Only if the heal fails does a second message carry the one Approve link that settles it.
- No takeover possible: "If the Studio stops, no other machine can take over: the Laptop isn't signed in to an
  account, and the Mini is set never to take over." It ends with *What I need from you*, one line per fix with its link.

A holder that cannot send to Telegram itself (the last-resort claim of R4 when no member is ready) sends these through
the forward path of a member that can, and otherwise by app push; the episode is also a pool-wide Needs-you entry
(`GET /needs`), readable from any member. The drill records which route delivered.

During a drill owner topics get nothing; the same messages are delivered for real, silently, to the drill topic, and
their message ids recorded. The drill topic is a test surface: every drill and self-check message in it is deleted by
the bot once the report has recorded its id (Telegram lets a bot delete its own messages for 48 hours), and drill
records are excluded from learning, memory and history readers.

**Drill proof.** Phases P and B require one delivered failover and one delivered return message in the drill topic,
naming the machines and cause, from no other machine.

### Build increments (ordered)

1. **Boot claim safety (R1).** Standalone: `LeaseCoordinator`, `HttpLeaseTransport`, `MultiMachineCoordinator`
   lease-init. Unit tests for each rule and both sides of the three-probe/45-second and answer-window boundaries;
   integration tests of a restarted non-preferred machine that cannot reach the preferred for 10 s and must not claim,
   of a wedged preferred answering 503 that must not block past the window, of a dead preferred behind a tunnel
   whose edge answers 530, which must count as silent, and of a restarted former holder on a git store with no remote
   and stale local state while the current holder is briefly unreachable. Fix id `boot-claim-safety`.
2. **Hold, tie-break and poll release (R2).** Includes the lifeline's offset gating at its single offset derivation, signed receipts, the "poll released" record, the
   member-list snapshot, the handoff route, and a restart-between-queue-and-receipt test.
3. **Eligibility and the invariant (R3).**
4. **Record signing, readiness gate and kit (R4).**
5. **No restart on role change (R5).**
6. **Forward ladder changes (R8).**
7. **Owner notices (R10).**
8. **Conversations (R7)**, after `fix/unroutable-owner-release` merges.
9. **Replacement record and split detection (R6).**
10. **The drill (R9).** Run by hand on a throwaway pool after each earlier increment; weekly on Echo and Luna once merged.

## Decision points touched

| Decision point | Classification | Basis and justification |
|---|---|---|
| Boot hold: no claim from own stale lease; non-preferred defers until a peer answers; never while the preferred answers | invariant | basis: irreversible-consequence; evidence: a same-epoch boot claim caused 36 lease moves in six hours (fb-2bf6ccd0-705) |
| Boot hold ends after ≥3 silent probes over ≥45 s | judgment-candidate | floor: normal rules still need a lapsed lease; arbiter: the probes; values from the interim hotpatch (Laptop, Mini; no contest since 2026-11-20 10:35); config |
| An unsigned answer counts for restartBudget p95 + 60 s (45 s – 10 min), then only signed liveness | judgment-candidate | floor: signed liveness always counts; arbiter: the preferred machine's own measured restart; bounds a wedged machine; config |
| Holder keeps its epoch through an unconfirmed renewal in every pool size | invariant | basis: irreversible-consequence; evidence: dropping it silenced Luna on every standby restart; a majority rule would silence Echo after a Studio loss with two members routinely off |
| On persistent 409s, the side whose best reachable member ranks below the best live unreachable one yields; contenders are members that were ready when reach was lost; a yield lasts at most 2W without a peer epoch | invariant | basis: enumerable-domain; evidence: a total order over members and disjoint sides in a clean cut, so exactly one side yields with no message between them |
| A yielded machine probes once per step (30 s – 2 min, jittered) and resumes on the contender becoming reachable, a peer epoch or "poll released" record, two silent full long-poll probes, or 2W | judgment-candidate | floor: never silent beyond 2W; arbiter: reachability, signed records and probes; config |
| "Another program" defect only with no contender; a known contender after a 2W resume gets a notice naming it | invariant | basis: enumerable-domain; evidence: with no contender a persistent poller cannot be one of our serving machines, and naming our own machine as a stranger would be false |
| Lifeline confirms a queued update only after a second member has it; releases the poll after max(W − 30 s, 30 s) | invariant | basis: irreversible-consequence; evidence: a confirmed update on a machine that then dies is an owner message lost for good |
| `telegramPolling` no longer excludes takeover; hard exclusions are force-mute, explicit observe-only, the takeover setting | invariant | basis: enumerable-domain; evidence: three settings, each counted and shown; deriving exclusion from polling caused A1 |
| Pool needs ≥2 eligible-and-ready members | invariant | basis: irreversible-consequence; evidence: with one, its loss leaves no machine to answer (A1, 75 min); two is the least that survives one loss |
| Posture row older than `failoverThresholdMs` counts as not ready | invariant | basis: external-constraint; evidence: the lease's own presumed-gone threshold (`FencedLease.ts`) |
| Version skew is not a defect for 24 h from when that member was first seen lagging | judgment-candidate | floor: never counted ready; arbiter: the release field; a per-member clock so daily releases cannot reset it; config |
| Readiness blocks a claim while a ready member lives, for up to 2W | judgment-candidate | floor: after 2W the lease is served regardless; arbiter: posture rows and the lapsed lease |
| With no ready member, claim after one W ranked by capability (settings, owner, account, group) | invariant | basis: irreversible-consequence; evidence: on 2026-11-19 every survivor was not ready; the first-ranked check is the one needed to tell the owner why |
| Owner Telegram id only from the owner-record chain | invariant | basis: irreversible-consequence; evidence: that id gets the owner audience with tools on every machine |
| `getMe` freshness 30 min, refreshed every 10 | judgment-candidate | floor: stale or failed is `unknown`, not ready; arbiter: the call; config |
| Post-claim self-check within 2 min | judgment-candidate | floor: failure marks not ready; arbiter: the three checks; config |
| Degraded holder hands to a ready member at most once per 15 min | judgment-candidate | floor: never to a not-ready member; arbiter: posture rows; config |
| W = 300 s − p95 claim-to-reply − renewal interval − 15 s, ceiling 180 s, floor 60 s (`slow-pool` when the floor wins) | invariant | basis: external-constraint; evidence: the owner-set five-minute answer bound; the subtraction is measured by every drill, so the budget binds from loss of the lead to the reply |
| Churn latch target: ready holder, else ready preferred, else lowest id among ready; two agreeing evaluations | invariant | basis: enumerable-domain; evidence: a total order over shared rows; the existing per-machine latch could pick two |
| Replacement needs the owner's approval; refused while the old id is live or holding | invariant | basis: irreversible-consequence; evidence: a replacement revokes a machine pool-wide |
| Competing replacements: lowest (HLC, issuer) wins everywhere; old key verifies only up to the watermark | invariant | basis: irreversible-consequence; evidence: arrival-order winners diverge; an unbounded retired key lets a stolen key backdate records |
| `pool-diverged` escalates when two exchanges do not shrink the difference, or after ten | judgment-candidate | floor: detection never changes the lease; arbiter: the differing set; config |
| `member-unreachable` after three days, one pool line updated in place | judgment-candidate | floor: never called diverged; arbiter: reachability on every route; config |
| Revoked or unregistered-silent owner's topics claimed by the holder | invariant | basis: irreversible-consequence; evidence: such an owner can never answer (A10) |
| A machine that took over claims the previous holder's topics at takeover | invariant | basis: external-constraint; evidence: the five-minute bound leaves no room for a second death-evidence wait; the lapse and W are the evidence |
| Two-machine absent-owner claim with the gitless refusal lifted under three conditions | invariant | basis: irreversible-consequence; evidence: otherwise the topic is stranded for the outage |
| Capacity refusal split into transient (retry) and durable (not ready) causes | invariant | basis: enumerable-domain; evidence: `OriginEgressCapacity` returns null for exactly these listed causes |
| A forward the holder could not send stays in its custody | invariant | basis: irreversible-consequence; evidence: a reply handed back to a dying origin is lost (09:32–09:55) |
| Notices from the holder only, one per episode, edited in place, ≤2 pushes a day; failover and return silent | invariant | basis: enumerable-domain; evidence: four listed episode kinds; owner asked for them (fix item 14) |
| Drill aborts at 5 min (no holder) and 2 min (owner unanswered, disagreement) | invariant | basis: irreversible-consequence; evidence: 5 min is the owner's bound; an unanswered owner message is the harm the drill prevents |
| Drill hold 10 min | invariant | basis: external-constraint; evidence: must exceed W plus the five-minute answer window |
| Drill weekly | invariant | basis: external-constraint; evidence: the owner-approved post-mortem says "run weekly, on its own" |
| Drill not within 24 h of a real failover, quietest hour, no owner message in last 10 min | judgment-candidate | floor: never during owner activity; arbiter: activity history; config |
| Three consecutive drill skips are a defect | judgment-candidate | floor: a skip is never a pass; arbiter: skip reasons; config |

## Self-Heal Before Notify declarations

Watchers: no-takeover-possible, can't-reply, pool-diverged,
member-unreachable, foreign poller):

- *self-heal / remediation-actions:* pull `takeover-kit` from the holder and one other member; re-read account state
  and `getMe`; exchange membership records (R6); retry the poll (R2). Each is a read, an idempotent versioned apply of
  a signed record, or a retry; nothing to compensate.
- *brakes:* max-attempts 3 (membership exchanges progress-based, ceiling 10); max-wall-clock 240s; backoff 30s
  doubling; dedupe-key the episode key; breaker: three heal-then-fail cycles of the same check within 6 hours
  reclassify to critical; max-notification-latency 300s (`standards.selfHealBeforeNotify.recoverableLatencyCeiling`).
- *class:* no-takeover-possible, pool-diverged, member-unreachable and foreign poller are `recoverable` while a ready
  holder serves. Can't-reply on the holder is `critical`: it notifies on the same tick, says the fix is under way, and
  heals concurrently; the Approve link follows only if the heal fails.
- *audit-location:* the decision trace, mirrored into posture and drill records (metadata only).

## Evidence declaration

| Detector | Symbol | State claimed | Corroboration | Unmeasurable |
|---|---|---|---|---|
| Posture `ready` | signed row | the member could answer if it led | each check's own corroboration; the post-claim self-check; the drill | stale or unsigned → `unknown`, not ready |
| Posture `eligible` | effective acquisition checks | the member would claim if the holder died | the drill's expected survivor taking over | `unknown`, not eligible |
| Preferred "answers" | HTTP response on a machine-bound transport, or signed liveness | the preferred machine's process is alive | its published restart time bounds unsigned answers | silence counts toward the three-probe test |
| Persistent 409 | Telegram error code | another program is polling this bot | no webhook set; own lifeline excluded; peer epoch when seen | no 409 proves nothing; hold rules apply |
| Group confirmed | baseline count, join/leave log | only the owner reads the group | no join since baseline | count unreadable → `unknown` |
| `poolDigest` equal | hashes over ids and key fingerprints | members agree on membership and keys | the exchanged signed records | unreachable → `member-unreachable`, never `clear` |
| Drill pass | report rows | another machine answers within 5 min | message ids from real sends; epochs seen by every member | skip, never a pass; person-typed inbound marked not exercised |

## Multi-machine posture

- `takeover-setting`, `takeover-kit`, `machine-replacement`, `drill`, drill reports: replicated, signed record kinds.
- Posture rows, `poolDigest`: unified, proxied-on-read through `GET /pool` and `GET /takeover/readiness`.
- Held forward rows: machine-local on the origin, as today (peers see metadata only); a forward the holder accepted is
  in the holder's custody. Queued inbound updates on a lifeline whose server is down: copied to a second member before
  Telegram is told they were received.
- The `drill` sleep marker and the restart stamp: machine-local.
  machine-local-justification: hardware-bound-resource — they describe this machine's own server process and are read
  only by its own supervisors.
- Bot token, origin verifiers and account sign-ins: machine-local.
  machine-local-justification: physical-credential-locality — readiness reads their presence and never copies them;
  only signed records cross machines.
- Notices: one voice, the holder.

## Frontloaded Decisions

1. **Eligibility is on by default for ladder agents, with a one-tap opt-out per machine.** Every muted machine found on
   2026-11-19 was muted only to stop day-to-day polling; explicit exclusions are kept. Echo and Luna: owner-approved
   (fix item 2). Fleet: at the fleet rung, announced with the opt-out.
2. **The scheduler and other boot-role consumers follow the role in-process; role restarts go.**
3. **A not-ready machine claims when no ready member exists, or after 2W.** A holder that says why it can't reply
   beats silence.
4. **Holders keep the lease in every pool size; Telegram's one-poller rule and a fixed member ranking break ties.**
   During a cut that the rule does not resolve, both sides serve and run jobs until heal, each job keeping its existing
   idempotency guards. Pausing jobs on an unconfirmed holder was rejected: a sole
   survivor (Luna's Studio while her laptop is off) would then never run jobs.
5. **The automated drill uses a `drill` principal and states what it cannot prove;** real owner traffic after each
   failover covers person-typed inbound.
6. **Drill notices are delivered silently to the drill topic.**
7. **A slow-restarting holder is taken over once rather than waited for,** because W must fit the five-minute bound.
8. **Machine replacement always needs the owner's tap,** because it removes a machine from the pool everywhere.
9. **One spec for the project.** Splitting into four was considered in round 2. The drill proves all requirements
   together and they share record signing, so one design is kept; each increment is built and reviewed separately
   under `/instar-dev`, and increment 1 needs nothing else here.

## Failure modes

| Case | Result |
|---|---|
| Clean cut, both sides online, Telegram agent | the side without the highest-ranked member yields; the other serves |
| Irregular cut, no 409, or agent without Telegram | both may serve and run jobs until heal; an update fetched by both before confirmation can be answered twice (accepted) |
| Preferred machine asleep, two others cut from each other | the asleep machine is not a contender, so only the lower-ranked side yields |
| Stray program polls while a member is unreachable for days | no contender, so no yield; one defect naming the cause |
| Whole pool down more than 24 h | the group check cannot pass from replicated data; the owner reconfirms with one tap |
| A stray program polls the bot with no contender | one defect naming the cause; the machine keeps serving |
| Holder's server wedges while its lifeline keeps polling | the lifeline releases the poll and sends "poll released" after max(W − 30 s, 30 s); the yielded survivor resumes on it |
| Clean cut longer than 2W | the yielded side resumes at 2W; both serve for the episode with 409 backoff capped at 60 s, one notice names the other machine (accepted) |
| Preferred machine dies at the same moment as a cut | both sides may yield to it; two silent full long-poll probes, or 2W at most, and they resume |
| A ready member is alive but stalled | not-ready members wait 2W, so the five-minute bound can be missed; a stale posture row usually ends the wait sooner (accepted double failure) |
| Every machine not ready | one claims after W, says why, and hands over when a ready member appears |
| Survivor cannot take over during the drill | abort at 5 min; hold bounded by the dead-man timer; one defect |
| Conductor dies mid-drill | the holder's dead-man timer restarts its server at the hold's end |
| Forged or competing replacement | refused (signature, approval, old id live) or resolved to the same winner everywhere |
| Member reachable by nobody (M5 Pro) | `member-unreachable` after three days, one pool line |
| Holder restarts slower than W | one takeover, no role restarts, at most one hand-back; `slow-start` shown |
| Older-release member | `version-skew` for 24 h, then "update <machine>" |

## Testing

Unit tests per increment for each decision row, both sides of each boundary, and the ladder off. Integration: two and
three real coordinators with local and git lease stores; one stopped, one restarted, one reachable only by relay; a
lifeline with a dead server releasing the poll without losing updates; stubbed Telegram returning 409s to each side,
and a webhook-set case; a holder crashing before and after Telegram accepts a carried reply. E2E: production wiring in
`server.ts` passes the new deps (wiring integrity); `GET /takeover/readiness` returns 200 on a booted multi-machine
test agent; every machine computes the same churn target. Live: R9 on a throwaway pool after each increment, then Echo
and Luna.

## Maturation plan

- **ladder:** multiMachine.takeoverReadyPool
- **dark-window:** none for Echo and Luna (the owner approved the change as post-mortem fix items 1–4); the fleet stays
  on today's behaviour until the graduation criterion is met.
- **test-agent-live:** each increment on a throwaway three-machine pool, drill run by hand.
- **dev-agent-live:** Echo and Luna, weekly drill.
- **fleet:** every multi-machine agent whose conversations are on Telegram, after four consecutive weekly passes on
  Echo and Luna. Agents whose only channel is Slack or the app need channel-specific readiness, promotion and probes
  (the Slack adapter does not follow the lease, per session-pool-takeover-at-pairing) and stay on their current
  behaviour until a follow-up spec covers them; that gap is listed on the readiness page.
- **graduation criterion:** four weekly passes on each of Echo and Luna, no fail in the last two, and on each of them
  at least one recorded real owner message, in a real conversation, answered with tools by a survivor within five
  minutes of the lead's loss (R9's tracker records loss, claim, message arrival and delivery times separately). It counts toward
  acceptance only when the reply is delivered within five minutes of the lead's loss; a later message still shows the
  recovered conversation works and is reported separately. Synthetic and owner-message results are reported separately.

## Migration

`migrateTakeoverEligibility()` (R3), rung-gated, idempotent. `churnDetector.dryRun`, `pollFollowsLease.dryRun` and
`staleOwnerRelease.dryRun` resolve false only on ladder agents. `takeover-drill` is added through the built-in jobs
path.

## Rollback

Set `multiMachine.takeoverReadyPool.enabled: false` and restart each machine once (the boot-built scheduler and
consumers need it). Everything else reads the switch live. Records stay and are ignored.

## Agent awareness

`src/data/awareness/takeover-ready-pool.md`: Registry First for "can another machine take over?" (`GET
/takeover/readiness`) and "did the drill pass?" (`GET /takeover/drills`), and that a takeover defect on the Needs-you
list is told to the owner in plain words with its one link. `/takeover/*` routes require the bearer token.

## Open questions

None.
