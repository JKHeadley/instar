# Convergence Report — A planned restart keeps the lead: the lease outlives the boot while a restart is pending

**Spec:** [docs/specs/planned-restart-keeps-lead.md](../planned-restart-keeps-lead.md)
**Slug:** `planned-restart-keeps-lead`
**Converged at:** 2026-11-21, round 6 of 6 (the Tier 2 cap)
**Iterations:** 6
**Final-round design findings:** see the Convergence verdict (round 6 is recorded there with each remaining item's class and disposition).

## Cross-model review: codex-cli:gpt-6.2-astra

A real GPT-tier external pass ran through the agent's codex CLI in all six rounds (model `gpt-6.2-astra`, every round
`status: ok`). The Gemini CLI was installed but not signed in (`gemini-not-authed`), so no Gemini-family pass ran; the
remedy is to sign the Gemini CLI in. A clean-door Anthropic second read (`claude-code:claude-fable-5`, `crossFamily:
false`) also ran all six rounds; it is disclosed separately and does not count as cross-model review. The six internal
reviewers ran as subagents of the authoring session (Claude Fable 5.1) in every round. The Standards-Conformance Gate
ran every round (102 standards checked): 10, 8, 5, 6, 5, 7 advisory flags; each was folded into the round's synthesis.

## ELI10 Overview

An Instar agent that runs on several machines has one machine in charge at a time, holding a lease that lasts sixty
seconds and must be renewed constantly. When the machine in charge restarts its own server on purpose — for an update, a
role change, or because an operator asked — nobody renews the lease while the process is down, a restart takes one to
four minutes, so the lease runs out, another machine takes over, and when the restarted machine comes back it correctly
refuses to grab the lead from a live holder. Ten minutes later the lead is handed back to the preferred machine, which
restarts again to pick up its duties, and the whole thing repeats. On 21 November 2026 the Echo pool spent an hour and a
half in exactly this loop and its pre-merge test line never ran.

This spec makes a planned restart keep the lead. From the moment any part of the server asks for a restart — and
before the request file even becomes visible to the supervisor that will act on it — the holder's routine renewals
promise a few minutes instead of one, are made every ten seconds, and are saved to disk. Whenever the restart then
happens, even if the server is killed three seconds after an interrupt, the other machines already hold a promise that
outlives the reboot. On return the machine does not trust its own file: it waits until a neighbour has confirmed that
nothing changed, then renews and carries on in charge. No new lease number, no tug of war, no second restart.

The main trade-offs: while a restart request is waiting (which can be hours behind a running test run), a crash of the
holder makes the others wait a few minutes longer to step in than they would today; a machine that comes back to find
every neighbour dark keeps its seat on the same evidence boot claim safety already accepts for taking one; and the fix
covers restarts asked for through the request file, not a kill or a lifeline-level kickstart, which a later build (no
restart on a role change) owns.

## Original vs Converged

- **Originally** the lease was extended in the server's shutdown handler. **Now** it is extended by the holder's ordinary
  renewals while a restart request is pending, started before the request is visible. **Why:** review against the code
  showed the supervisor deletes the request files before it signals the server and kills it three seconds later, so an
  exit-time step would almost never run on the path Echo uses.
- **Originally** the booting machine renewed an unexpired own lease at once, as today's code does. **Now** it holds
  nothing until a neighbour has given an identity-verified answer with no newer epoch and the renewal is confirmed, with
  the self-fence left "never confirmed" (a `null`, not a zero, which `process.hrtime` could satisfy at OS boot) and the
  rule keyed on an explicit pending marker on disk so a rollback cannot reopen the gap. **Why:** every reviewer found that
  the primed fence let a machine serve from a local file for a minute with no peer consulted.
- **Originally** the extension ended when the request file disappeared. **Now** the pending state is latched: a
  consumer's deletion never ends it (both consumers write a ledger row before they unlink; a file gone sixty seconds with
  no row was withdrawn or discarded), and only withdrawal, a four-hour cap, exit, or a consumed request whose process is
  still alive ends it. **Why:** a renewal in the three seconds between the consumer's unlink and the kill would have
  replaced the long promise with a short one on every peer and re-run the loop about one restart in ten.
- **Originally** the window had a 180-second ceiling to honour the owner's five-minute reply bound. **Now** the ceiling is
  what peers enforce (the stale-holder and presumed-dead thresholds, 352 s on Echo), the window is measured from this
  machine's own boots, and the five-minute bound is stated as exceeded only while a restart is pending and the holder
  then crashes — an accepted, recorded cost. **Why:** the Studio's measured 150-second boot cannot fit under a window
  that honours the bound once the margins are counted, and a window that fits the bound recreates the loop.
- **Originally** the three writers that cause nearly every holder restart published their request and announced it
  afterwards. **Now** they wait until a neighbour has confirmed the longer promise (or eight seconds) before the request
  becomes visible, the one in-process consumer waits the same way before it acts, and the other writers announce first and
  publish at once. **Why:** the supervisor can see a request within ten seconds and kill three seconds later; the
  broadcast must already have landed.
- **Originally** a machine returning to a dark pool waited out the window, then took today's lapsed path and its role
  restart, every fifteen minutes. **Now** once every known peer has been silent on boot claim safety's own three probes
  over forty-five seconds, it renews its own epoch as a survivor hold on exactly that evidence. **Why:** that is no more
  authority than boot claim safety already grants (a claim of the next epoch at that moment), and it ends the survivor's
  loop instead of renaming it.
- **Originally** the local-store window test was a timestamp shape. **Now** it is a pending marker written with every
  pending renewal and cleared by the confirmed boot renewal, by relinquish and at an episode's end. **Why:** the
  confirmed renewal written back to the store satisfied the shape test too, so the next restart within a minute would have
  taken the wrong path, and a relinquished epoch could have been renewed from the file.
- **Originally** the "no live peer" branch relied on the solo-captain hold's presumed-gone leg. **Now** that leg is not
  consulted. **Why:** under the default liveness derivation no peer is presumed dead inside a boot, so the leg could never
  fire; it was dead code with a test that could only pass with a fake.
- **Originally** the problem statement reconstructed the night from the feedback records alone. **Now** it carries the
  Studio's own restart ledger, shows the role-restart stamp held, names PR #2783's widening of the role-restart condition
  as the proximate cause with the trade-off that keeps it, and labels the rest as a reconstruction. **Why:** a causal
  record, not an inference, is what the lessons require.

## Experience fit

Source: the owner's approval of the post-mortem fix program (topic 145840, 2026-11-20), and the agent's own incident
filings fb-135e3043-add and fb-fdb55c1c-a79, which ask that the hand-back stick so the merge line runs. Ordinary journey:
the Studio receives the lead back, a role restart is requested, the lease is renewed with the window before the request
is visible, the supervisor consumes and kills, the Studio boots in 70 to 150 seconds, the Mini answers its pull, it
renews and is awake before the boot role is read, the scheduler and Local Verify start; the owner notices nothing,
decides nothing, and is told nothing (Near-Silent: nothing is theirs to decide). Contrasting cases: the same restart
asked for in different words (app button, API, Telegram fix command, update, role change) all write the request and are
covered; a different act with the same label (a lifeline-level kickstart, a kill) is not, and the release note and
awareness entry say so; a Laptop holding the lead is taken over once on its first planned restart and then measured; a
sole survivor keeps its seat on boot claim safety's evidence; a request held hours behind a verify run stretches the
pending exposure, stated as the one accepted cost and readable on `/health`. Evidence limits: boot durations are one
night's reading on one pool; the boot-to-lease-init timeline was not measured (filed); the graduation criterion reads the
state (epoch unchanged in the ledger, the holder's own evidence rows) and requires one hand-back-driven restart, not
only updates. Trust and approval surfaces: none added or widened. Disposition: the design delivers the stated outcome
for every restart that writes the request; the residual (unplanned restarts) is named and owned by the parent's R5.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | security 7, scalability 6, adversarial 10, integration 6, decision-completeness 6, lessons 6; codex 4, clean-door 3; gate 10 flags | 48 | 27 | Redesign: extension moved from the shutdown handler to pending-restart renewals; local persistence; boot reclaim gated on a peer answer; the fence unprimed; parent amended in four places; registry rows |
| 2 | security 6, scalability 8, adversarial 7, integration 3, decision-completeness 5, lessons 4; codex 5, clean-door 1; gate 8 flags | 39 | 36 | Shared announce signal before the write; latched episode; 10 s pending cadence; margin from config; ceiling = peer caps; `null` fence; "confirmed" by medium only; rule 1b split across ticks and keyed on disk; composed ladder entry; backup exclusions; two foundation defects filed |
| 3 | security 4, scalability 5, adversarial 7, integration 3, decision-completeness 2, lessons 4; codex 4, clean-door 0; gate 5 flags | 29 | 30 | Episode bound mirrors the consumers' deliverability predicate with a 4 h cap; identity-verified answers only; hot writers await confirmation; episode end deletes the file; rule 1b scoped to a window lease; local store refreshed; `relinquish()` deletes the file; survivor path; slack 25 s |
| 4 | security 5, scalability 5, adversarial 6, integration 3, decision-completeness 1, lessons 4; codex 3, clean-door 0; gate 6 flags | 27 | 32 | One state-based episode rule (ledger row before unlink); equal-and-identical fold on any store; R1's silence test removes dark peers; evaluation in every boot branch; `/health pendingRestart`; consumers listed; legacy dial named; `bypassHolds` on the fix-command; `reconcileRole` single-flight; three foundation defects |
| 5 | security 1, scalability 5, adversarial 3, integration 1, decision-completeness 1, lessons 3; codex 5, clean-door 0; gate 5 flags | 19 | 36 | Evaluable round judged at the 10 s deadline; explicit pending marker; survivor hold on R1's evidence (solo-captain leg dropped); every renewal in an open episode carries the window; watcher guard and re-check; exit (e); unpublished close waits for the promise; test-only labels for no-tunnel paths; fleet rung intersected with the parent's; Work Board cards for filed items; marker key corrected |
| 6 | security 1, scalability 1, adversarial 1, integration 0, decision-completeness 0, lessons 0; codex 4, clean-door 0; gate 7 flags | 4 distinct (two reviewers each on the dark-pool boot wait and the survivor claim; codex on the late-promotion termination, the capped request reopening, and the rollback caveat's store) | 38 | Post-cap targeted edits: the boot wait runs to a verdict for up to 120 s whatever the window's remaining time and the sample is taken at the verdict; the survivor claim narrowed to "no role restart at boot"; a boot after a late promotion waits the full window (`afterLatePromotion`); a capped request is remembered; the rollback caveat covers both stores; the 120 s derivation corrected; a targeted check confirmed each fix |

## Proportion

Tier 2 (a lease safety invariant touching the exit path, the boot path and every restart writer); the spec is about 620
lines and the build touches roughly a dozen source files. Six rounds, the Tier 2 cap, were used. That is at the limit,
and the proportion is honest: the first design (exit-time extension) was refuted by the code in round 1, the second
(pending renewals) was right in shape but needed four rounds of boundary and failure-mode work because it sits where two
restart consumers, a 3-second kill, a 20-second deadline, a 60-second lease and a 4-hour deferral all meet. Each round
after the second shrank: 39, 29, 27, 19 design-class items.

## Left behind

Precision findings not iterated on (each a wording, caveat or example change; none changes what is built), with the
queue where one is worth doing later:

- Line-number anchors in the writers' consumer list were replaced by symbol names; any that remain are for the builder.
- The continuity file's signature defends against corruption, not an attacker on the disk; stated, not strengthened.
- "Studio updates first" was dropped: no mechanism orders updates across the pool; one extra hand-back round during
  rollout is accepted.
- The Terms block is dense; a term table was suggested and not made (no content change).
- The `confirmed` field in the continuity file means "epoch N acknowledged by a peer" (zero peers or a key-less 2xx
  included); stated honestly; the boot gate is what makes the boot renewal sound.
- The ledger tail used by the 60-second check is bounded; if it does not reach the episode's start the result is unknown
  and reads as "row present" (the safe side); stated in the build's reader.
- The two-second poll keeps running at the renew cadence after a filesystem error rather than stopping entirely; the
  renew tick is the fallback; a breaker was not added (constant cost).
- Successive episodes can keep a holder pending across a multi-hour hold (the role check re-requests while the role
  differs); bounded per episode, visible hourly and on `/health`; the parent's R5 removes the re-request.
- The ten-second pending cadence is not derived from the window; any cadence is safe because the margin resolves from it.
- The owner-facing explanation of a longer hand-over while a restart was pending waits for the parent's R10 failover
  notice; until then the restart ledger joined to the lease epochs is the record (CMT-2118 carries the decision).
- Peer-side `syncStatus` has no pool merge; `pendingRestart` is machine-local like role and epoch; the dashboard is
  unchanged.
- The boot-to-lease-init measurement and an earlier lease in the boot order: feedback queue, bound to the parent's
  increment 5, with a Work Board card under the post-mortem project.
- Four foundation gaps (the supervisor's 3-second kill, two consumers racing for one file, the role-restart spec's drift
  from PR #2783, the primed fence for an ordinary unexpired acquisition): feedback queue plus Work Board cards; the third
  is also corrected in text in this change.

## Full Findings Catalog

Each round lists the reviewers that raised findings, the design-class findings that changed the spec, and the resolution.
Precision findings are summarised per round; the per-reviewer reports are in the session record.

### Round 1 (exit-time design)

- **Security** (7 design): the supervisor deletes both request files before signalling and kills 3 s after the
  interrupt, so exit-time detection and the 5 s step cannot run; the renew timer races an exit-time extension; `renew()`
  returns true in grace; the stale-holder cap read the wrong machine's config; the presumed-dead threshold was missing
  from the caps; the record signature left fields unsigned. **Resolution:** redesign to pending renewals; both caps added;
  the record signs every field.
- **Scalability** (6): the exit step is killed on the supervised path; `GitLeaseStore.refresh` is a synchronous
  pull-and-push; `holdsLease()` is true at boot from the primed fence with no 5 s retry; `confirmed` from one peer;
  5 s vs 8 s deadlines. **Resolution:** as above; boot fence unprimed; retries defined.
- **Adversarial** (10): the same two exit-path facts; rule 1b did not withhold authority; one-peer `confirmed`;
  `lease-local.json` never receives renewals on a tunnel so the disk state assumed did not exist; "no two holders" false
  under a cut; no 5 s retry existed; a late reclaim re-triggered a role restart; the exit precondition was spuriously true.
  **Resolution:** persistence added; R2's conditional guarantee adopted explicitly; the wait and the late-verdict cost
  defined.
- **Integration** (6): detection impossible from four writers (no coordinator in scope); rollback hole with a persisted
  window; widening the ladder flag path breaks the coverage test; `superseded` must not be `error`; registry rows
  required; config path names. **Resolution:** a shared signal module; rule 1b keyed on disk; composed ladder entry;
  evidence reasons; registry rows.
- **Decision-completeness** (6): the planned-exit domain claim was false on the supervisor path; rule 1b depended on
  `bootClaimSafety`; the cap read the wrong machine; the CMT-2118 handoff had no route; explicit `windowMs` clamping was
  unstated; five samples cannot seed R5's p95. **Resolution:** all adopted (twenty samples; route named).
- **Lessons-aware** (6): the same detection failure; `fix-command` wrote no `plannedRestart`; the boot role was decided
  from a local file; "confirmation required" misdescribed `renew()`; the night's cadence needed a causal account; the
  5 s/8 s deadlines. **Resolution:** the restart ledger put in the problem statement (the stamp held); the fix-command
  normalised; confirmation defined.
- **Codex (GPT-6.2 Astra)** (4): partitioned renewal; restart-budget sampling only on success; the 10-minute ceiling
  against the five-minute budget; the stale-holder cap on the holder's settings. **Clean-door** (3): the same sampling
  gap, the cap, and an unaddressed lifeline-renews alternative. **Resolution:** measurement on every outcome; ceiling
  moved to peer caps; the alternative rejected in text.

### Round 2 (pending renewals)

- **Security** (6): a zero fence sentinel passes under one TTL of OS uptime; the solo-hold path primes the fence
  without a peer; a late reclaim costs a role restart; an expired request kept the window for ever; signed answers need the
  mesh dial; the no-live-peer clause with liveness off. **Resolution:** `null` sentinel; confirmation by medium only;
  episode bounds; identity-verified answers; liveness-off wording.
- **Scalability** (8): the note after the write loses the race; 180 s cannot cover a 150 s boot with margins; the zero
  sentinel; ask plus broadcast in one tick overran the tick timeout; the pull loop started after the acquire with
  `bootClaimSafety` off; solo-hold `markRenewOk`; routing through the guarded tick; `refreshLocal` dirtying the git tree.
  **Resolution:** announce before the rename; ceiling = peer caps; two steps across ticks; pull loop first; git write
  dropped.
- **Adversarial** (7): rollback hole; episode ending on file deletion; file-poll race for other writers; pull loop
  ordering; "live peer" collapsing at boot; late verdict; note after write. **Resolution:** as above.
- **Integration** (3): coordinator unreachable from four writers; rollback; ladder widening. **Resolution:** signal
  module; disk-keyed rule 1b; composed entry.
- **Decision-completeness** (5): episode ending on deletion; 180 s circular; the 30 s wait's basis; the fixed +60 s;
  rollback. **Resolution:** latched episode; margin from config; 120 s wait with the fallback named.
- **Lessons-aware** (4): the unprimed zero fence thrashes the suspend branch; the no-live-peer branch cannot confirm on a
  tunnel; the feedback's third ask was dropped; the 3 s kill vs 20 s deadline built around. **Resolution:** `null` state
  with the suspend branch disarmed; honesty about confirmation; the third ask routed; the defect filed.
- **Codex** (5): the request visible before the renewal lands; the five-minute arithmetic; expired records discarded
  before measurement; expiry straddling the ask; rollback with an extended lease on disk. **Clean-door** (1): the
  pending state ended when the consumer deleted the file.

### Round 3

- **Security** (4): the episode ended at the file's `expiresAt` while the supervisor acts on a deferred expired request
  for up to four hours; a bare 2xx counted as a qualifying answer; a hand-written `expiresAt` was unbounded; a binary
  rollback on a git store. **Resolution:** the consumers' deliverability bound with a 4 h cap; identity-verified acks; the
  residual named.
- **Scalability** (5): the same episode bound; the announce did not broadcast the persisted renewal; subscriber errors
  could abort a writer; the 10 s cadence on a git store means a synchronous push every 10 s; slack below the observed
  stall. **Resolution:** the subscriber broadcasts the exact renewal; errors isolated; tunnel-only cadence; slack 25 s.
- **Adversarial** (7): episode closing before the consumer acts; the sole survivor loops and is slower than today;
  the announce not broadcast; a relinquished lease resurrected from the file; the nonce floor after a backward clock
  step; the subscriber unguarded by `holdsLease()`; the hand-written expiry. **Resolution:** all adopted.
- **Integration** (3): two writers lacked `expiresAt` and atomic publish; "Studio updates first" had no mechanism;
  hourly `held` rows flattered the ladder's ratio. **Resolution:** writers normalised; the sentence dropped; one row per
  episode.
- **Decision-completeness** (2): the episode bound; the 10 s slack below its evidence. **Lessons-aware** (4): the
  episode's third disagreeing copy; a dark-but-live peer waits the window; the hold verdict unrecorded; no read surface.
  **Resolution:** one rule; R1's silence test removes dark peers; the `held` row carries the hold verdict;
  `/health pendingRestart`.
- **Codex** (4): the writer waited only for local persistence; ending an episode left a stale window copy; rule 1b
  covered every unexpired own lease; a lost continuity file on a tunnel holder. **Clean-door** (0 design).

### Round 4

- **Security** (5): the file-gone clause of the episode rule contradicted the latch; the equal-nonce fold refused a
  local store's identical record; a relinquished lease could still be resurrected on a git store; the unnamed-pool solo
  hold skipped its gates; the announce promise's resolution rules were unstated. **Resolution:** ledger-row rule;
  identical records accepted on any store; `relinquish()` deletes the file; named-pool gates (later superseded by the
  survivor hold); promise semantics stated.
- **Scalability** (5): `reconcileRole` re-entrancy once it awaits; the unpublished-episode close raced the hot writers'
  await; rule 1b's own ask duplicated the pull loop; the local-store window test matched the confirmed boot renewal;
  return-type consumers unnamed. **Resolution:** single-flight; close after the promise settles; rule 1b evaluates the
  pull loop's rounds; the test fixed (round 5 marker); consumers listed.
- **Adversarial** (6): the same file-gone contradiction; the same equal-nonce fold; the unpublished close; "no live
  peer" unreachable at boot under the default liveness derivation; superseded measurement skipped in the defer branch; a
  standby's announce awaited 8 s. **Resolution:** all adopted.
- **Integration** (3): posture markers mid-sentence failed the lint; normalising the fix-command put an operator's
  restart under the verify hold; `reconcileRole` re-entrancy. **Resolution:** standalone markers; `bypassHolds: true`;
  single-flight.
- **Decision-completeness** (1): the unpublished close. **Lessons-aware** (4): the episode rule's third copy; a live
  but silent peer waited the window; the consumers' hold verdict unrecorded; no read surface.
- **Codex** (3): the same fold issue; the same episode race; a consumer-side handshake alternative. **Clean-door** (0
  design).

### Round 5

- **Security** (1): a timer cannot bound a synchronous git push. **Resolution:** no-tunnel paths labelled test-only; the
  writer resolves at once on a git store. Precision: the presumed-gone leg unreachable at boot; the authed `/health`
  branch; the watcher awaits once; the legacy dial records `signed` on a verified ack; ledger lookup by `requestedAt`;
  the unsigned extension capped against R1's ceiling.
- **Scalability** (5): settledness read from the tick's `finally` is not settled; the margin's 10 s ask no longer matched
  anything; the step-6 store write made every post-confirmation minute a window lease; the timer vs push; no pool merge of
  `syncStatus`. **Resolution:** evaluable round at the 10 s deadline; explicit pending marker; test-only label;
  machine-local field.
- **Adversarial** (3): the boot renewal in an open episode carried a TTL; the watcher's await opened a double-consumption
  window; a failed kill latched the episode for four hours. **Resolution:** every renewal in an open episode carries the
  window; guard and re-check; exit (e).
- **Integration** (1): the `/health` posture claim. **Decision-completeness** (1): the settled-pull definition vs the
  10 s ask. **Lessons-aware** (3): the same settledness point; the window-lease shape test; the dead solo-captain leg.
- **Codex** (5): the shape test; the unpublished timeout vs consumption; the synchronous push; the sole survivor's
  loop; the fleet rung wider than the parent's. **Resolution:** marker; ledger check before declaring a failed publish;
  test-only label; the survivor hold; the fleet intersection. **Clean-door** (0 design).

### Round 6 (the cap)

- **Security** (1 design): the survivor hold primes the fence once, so "the loop does not recur" overstated what the
  later ordinary renewals do. **Resolution:** narrowed to "no role restart at boot"; the after-state stated as today's
  dark-peer rules. Precision: the Verify table still named the solo-captain leg (fixed); the unsigned pending marker's
  forge/clear consequences (stated: strictly safer / foundation gap 4); the capped file reopening (fixed); non-finite
  samples (fixed); a keyed peer on the legacy dial mid-rollout (stated).
- **Scalability** (1): the same survivor claim. Precision: the `pendingRestart` posture row claimed a pool merge that
  does not exist (fixed: machine-local); the probe-landed evaluation under the tick guard and the round timers' lifetime
  (stated).
- **Adversarial** (1, high): the dark-pool boot arithmetic — probes against sleeping peers land only when dials time
  out, R1's silence verdict arrives at about 90 s, and a wait that ended at the window's expiry left a 150 s boot standby.
  **Resolution:** the wait runs to a verdict for up to 120 s whatever the window's remaining time; the sample is taken at
  the verdict. Precision: the boot renewal carries the window when an episode is open; the survivor hold's code path
  named; the watcher's withdrawn-during-await case; (e) in the deletion sentence and the store rewritten without the
  marker; the two-boot sample and the boot-ledger sentence; the unattributed ledger match; an observe-only boot with a
  window lease relinquishes with the tombstone.
- **Integration** (0 design): precision — posture row, `peerRestartBudgetMs` unwired, retention baseline wording, the
  legacy-dial consequence for R1, the marker through `casWrite`, `basis` on the evidence and the graduation criterion,
  Work Board card fields, ELI16 consistency, the awareness entry's 202 timing.
- **Decision-completeness** (0 design): precision — exit (e)'s deadline knob, FD 4's missing (e), the legacy-dial
  parenthetical, the "exactly R1's authority" wording, the wait's mechanics, a discriminator clause, an ELI16 duplicate.
- **Lessons-aware** (0 design): precision — the Verify-table remnant, FD 4, ELI16, evidence sequencing (the throwaway-pool
  restart before the fragment), the legacy-dial label, a sixth foundation observation (a returning expired record above a
  live lower epoch acquires over it — filed as gap 5), the poll's P19 shape, the ledger tail's bound, the owner's reach
  gap measured in the live proof, the authority wording.
- **Codex (GPT-6.2 Astra)** (4): the survivor hold's authority after one TTL; the late-promotion path's termination; a
  capped request reopening an episode; the rollback caveat omitting the local store. **Resolution:** all four edited as
  above. **Clean-door** (0 design): the margin's first term per store; "nobody else can hold" overstatement; the
  all-key-less-peer edge; terminology density.
- **Targeted check after the edits:** all four design items resolved in substance; four precision residuals (the 120 s
  derivation's arithmetic, an over-strong "no role restart follows" clause, the late-promotion trigger unnamed, the
  rollback wording in the release note and the ELI16's wait length) were fixed in the same sitting.

## Convergence verdict

Converged at round 6 of 6, the Tier 2 cap. The final round raised four distinct design-class items, none of them a
safety, security or data-loss finding: one timing property of the boot wait against dark peers (fixed so the wait runs to
a verdict), one over-strong claim about a survivor after its first lease TTL (narrowed to what the code does), one
termination condition for a boot that follows a late promotion (added), and the rollback caveat's scope (widened to both
stores). Each was fixed by a targeted edit after the round and confirmed by a targeted check; no full seventh round was
run. Thirty-eight precision items are left behind above. Cross-model review ran in every round. The decision-completeness
counts for the tag are: frontloaded decisions 16, cheap-to-change tags surviving 0, contested-then-cleared 15, open user
decisions 0. The spec is ready to approve and build.
