---
title: "One wrong-PIN budget for the whole agent, not one per machine (SEC-170)"
slug: "pool-wide-pin-budget"
author: "echo"
date: 2026-11-22
tier: 2
parent-principle: "An Instar Agent Is Always a Multi-Machine Entity"
parent-principle-fit: "The dashboard PIN is one secret shared by every machine of the agent, but each machine counts wrong guesses on its own, so the agent's real guessing limit grows with every machine added. This spec makes the limit belong to the agent: one count, kept by the machine that leads; a machine that cannot get a grant from the lead refuses unknown browsers rather than counting on its own."
binding-standards:
  - "Security Fixes Keep the Experience Whole: a correct PIN from a browser that unlocked before, from the paired phone, or on the machine itself works exactly as today; only an unknown browser during a live attack waits, as it already does"
  - "Fail toward stricter, never looser: a machine that cannot get a grant from the lead refuses unknown browsers, so the agent-wide total never exceeds today's single-machine limit"
  - "Verify the State, Not Its Symbol: the lead's answer is a counted reservation, never an assumed allowance; an unanswered or malformed reply counts as no"
eli16-overview: pool-wide-pin-budget.eli16.md
approved: false
single-run-completable: true
---

# One wrong-PIN budget for the whole agent, not one per machine (SEC-170)

## 1. Problem statement

The dashboard PIN unlocks the agent's dashboard. A correct PIN entered on a public unlock page returns the agent's permanent key (SEC-150). To slow guessing, unknown browsers share one hard budget of 20 wrong guesses per 5 minutes (`GLOBAL_PIN_KEY` in `src/core/PinAttemptStore.ts`, `globalFailureBudget` in `src/core/PinThrottle.ts`).

That budget is kept per machine, in each machine's own `state/pin-attempts.json`. The PIN itself is the same on every machine (it is a synced secret). So a stranger who knows N of the agent's addresses gets N × 20 guesses per 5 minutes against the one PIN. `docs/specs/identity-security-piece1c-pin-policy.md` §4 names this residual and defers it. `docs/specs/dashboard-pin-throttle.md` records the per-machine count as an operator-ratified exception on the grounds that guesses at one machine's address are not information another machine should act on. That premise does not hold when every machine checks the same secret. SEC-169 (PR 3647) stopped a public page from listing every machine's address, but addresses can still be learned other ways, so the budget itself must be shared.

This spec replaces that one exception, for the global unknown-browser budget only.

## 2. What is shared, and what stays per machine

**Shared: the global unknown-browser failure budget, 20 per 5 minutes for the whole agent.** It covers every attempt that reaches `GLOBAL_PIN_KEY` today: an attempt that is not a genuinely local request and has no **honored** `instar_pin_ok` marker. A marker that is still valid but has passed its abuse cap is no longer honored (`PinThrottle`), so those attempts are charged to the shared budget like any unmarked attempt. The build defines the predicate as "not local and no honored marker", and tests the switch from an honored to an abused marker on all three consumers. There are three consumers:
- `POST /dashboard/unlock`, through `publicPinAdmit`, `publicPinFailure` and `publicPinSuccess` (`src/server/AgentServer.ts`);
- `POST /dashboard/session/step-up`, through the same helpers;
- the email-code confirm, through `publicCapPinCheck` (`src/server/routes.ts`, built by `createMandatePinCheck` with `clearOnSuccess: false`). The build makes this one consumer asynchronous. The per-request check that shares its factory (approval links) is left as it is.

**Unchanged and per machine:**
- A browser with an honored `instar_pin_ok` marker is admitted before any budget, as today. Its marker only travels to the hostname that set it, so its abuse cap (50 failures) is per machine and stays N-multiplied. That cap is a secondary brake on a stolen cookie, not the brute-force bound.
- The machine's own local budget (`local-direct-unmarked`, 10 per 5 minutes).
- Per-source backoff and the per-network brakes in `PinThrottle`. These are secondary brakes and stay per machine, so they are N-multiplied. The hard bound is the global budget.
- Approval links (5 wrong PINs per live request) and every signed-in check (session, passkey, device credential).
- The paired phone app, which never uses the PIN budget.

## 3. Who keeps the count: the lead machine

The machine holding the lease (`LeaseCoordinator.holdsLease()`) keeps the one count, in a new file beside the existing store: `<stateDir>/state/pin-lead.json`. It holds the count and the lead's own record together, `{ count, resetAt, holderId, epoch, pauseUntil, sealedAtEpoch }`, and is replaced whole by one atomic write (temporary file, then rename). The existing `PinAttemptStore` file is a flat map of counters, so it cannot carry this record without breaking an older build on rollback. An older build simply ignores the new file, and the existing `GLOBAL_PIN_KEY` counter keeps serving when the switch is off. The window is the lead's own: `resetAt`, first counted attempt plus 5 minutes. No caller supplies a window.

**A write must succeed before anything relies on it.** Unlike the existing store, which keeps enforcing in memory when a write fails, `pin-lead.json` fails toward stricter. A reserve is granted only after the incremented count is written. A takeover admits nothing until its record, the adopted count and any pause are written. A seal is answered only after the seal itself is written. If a write fails, the reserve is refused, the takeover pauses, and the seal is not acknowledged, so the claimant pauses. Each failure is reported as the degradation `PinBudget.persist`, once per episode. An unreadable, invalid or missing `pin-lead.json` on a paired machine is set aside (if present), and the machine treats itself as a new lead (§4), since a missing file could be a deletion or a restore. Each write is flushed to disk (`fsync` of the file and its folder) before it is relied on, so the guarantee holds across a power loss, not only a crash. That costs one flush per reserve, at most 20 per window, because refusals are cached.

The team access log, the coherence journal and git sync were considered and rejected for this. Each replicates in tens of seconds to minutes, so during that lag every machine could spend a full budget before seeing the others' attempts. A guessing bound has to be decided at the moment of the guess.

**Reserve, then compare, on every consumer.** Today the budget is checked, the PIN is compared and a wrong PIN is recorded, all synchronously with no wait in between, so one machine never overshoots. The cross-machine call adds a wait, which would let concurrent remote attempts pass the check before any is counted. So with the switch on, the order changes on every consumer: one step checks that the count is below 20 and adds one, and only then is the PIN compared. A correct PIN gives the one back. On the lead this stays a synchronous local step. On any other machine it is the reserve call below. A fault between the reserve and the compare leaves the one counted, which is the stricter result.

**On a machine that is not the lead:**
1. **Reserve.** `POST /api/pin-budget/reserve` to the lead, with an empty body, signed with the machine identity (`signRequest` in `src/server/machineAuth.ts`, checked by `machineAuthMiddleware`). The lead answers `{ granted: true, reservationId, ttlMs }`, where the reservation is already counted, or `{ granted: false, retryAfterMs, spent }`.
2. **Compare.** Only with a grant, and only while it is still live, does the machine compare the PIN. The deadline is the time the request was **sent** plus `ttlMs`, minus one second, by the machine's own monotonic clock, so time spent in transit is never given back. A grant whose deadline has passed when it arrives is discarded and the attempt refused. It stays counted.
3. **Settle.** On a correct PIN compared before the deadline, the machine sends `POST /api/pin-budget/settle { reservationId }`, signed, without waiting for the answer. The lead refunds the reservation only if the signer is the machine that reserved it, the id has not been settled before, and it has not expired. A wrong PIN needs no second call. A settle that is lost leaves the reservation counted, which is the stricter result.

**Grants.** A reservation id is random and single use. It is bound to the reserving `machineId`. Its `ttlMs` is 30 seconds, never past the row's `resetAt`. The lead keeps live reservations in memory. A settle for an unknown, used, expired or foreign id changes nothing.

**Finding the lead.** The machine uses the same holder resolution the relay forward and pool placement use (`_resolveRouterUrl` in `src/commands/server.ts`). It sends through `poolPeerFetch`, so the request takes whichever path to the lead works (tunnel or local network) with no new address logic. The reserve has a 1.5-second timeout.

**Where the routes live.** `/api/pin-budget/reserve`, `/settle` and `/state` are machine routes (`createMachineRoutes`). They exist only where machine routes are mounted. A machine without them answers 404, and the caller refuses (§4), which is safe. Whether every development machine mounts them is checked in test-agent-live, not assumed.

**Refusal codes.** A refusal says why: `spent` (the budget is used up, cached until `retryAfterMs`), `not-lead` (the caller's view of the lead is stale: it re-resolves the lead once and does not cache), or `pool-budget-off` (the lead's switch is off).

**A refused or spent budget is cached.** After a refusal, the machine refuses locally until `retryAfterMs` passes, so an attack does not turn into a stream of signed calls.

**Trust.** Only an active machine of this agent's pool can reserve, settle or ask for the state. Such a machine already holds the PIN, so a compromised one gains nothing it did not have. It could spend the budget, which only makes things stricter, or refund its own reservations, which it could equally have avoided making. As a previous lead at a handover, it could also report a lower count than it kept. That is a real weakening, but only by a machine that could already try the PIN directly. No machine can stop a healthy lead from granting by sending a lease record alone: the seal (§4) also needs the sealed holder's own view of the lease to agree.

## 4. When there is no grant: refuse

The rule is: fail toward stricter, never looser. A machine that is not the lead and does not get a well-formed grant **refuses the unknown-browser attempt**. That applies when:
- it cannot tell which machine leads (no current holder, or it has fenced itself);
- the reserve times out or fails to connect;
- the lead answers 404 (an older version, or no machine routes), 401, 409 (the lead's switch is off), or anything that is not a well-formed grant or refusal.

The refusal is the existing 429 with the existing words ("use a browser that signed in before, your phone, or this computer"). There is no fallback budget, so the agent-wide total stays at most 20 per window even while machines are cut off from each other. The machine reports the degradation `PinBudget.leadUnreachable` once per episode, through `DegradationReporter`. It is not an owner notice, because the owner's ways in are unaffected (§5).

**A new lead takes over the count when it can, with a seal.** On taking the lead, a machine sends the previous holder a signed `POST /api/pin-budget/state` carrying its own lease record. The previous holder runs a new check, `LeaseCoordinator.verifySealClaim(record, signerId)`, which passes only when all of these hold:
- `FencedLease.verifyLease(record)` accepts the record's signature;
- the record's holder is the machine that signed the request;
- the record is not expired;
- its epoch is higher than the previous holder's own;
- **the previous holder's own view agrees:** either its `holdsLease()` is already false, or its latest pulled lease view names the claimant as holder.

That last condition matters because a lease is signed only by its own holder, so a compromised machine could sign a record at any epoch it likes. Requiring the sealed holder's own view means a forged record cannot stop a healthy lead. The view is pulled every 5 seconds, so in a genuine handover the claimant retries the seal for up to 10 seconds before giving up.

When the check passes, the previous holder, in one step, stops granting and settling, records `sealedAtEpoch`, and returns its final snapshot. Every time in the snapshot is a remaining duration, measured at the moment of sealing, so a difference between the two machines' clocks cannot shorten anything: `{ count, resetInMs, pauseRemainingMs, live: [{ reservationId, machineId, remainingMs }] }`. The count already includes the live reservations. The new lead starts each duration from the moment it receives the snapshot, which can only make it longer. It **replaces** the count in its own `pin-lead.json` with the snapshot (never merges with a count from an earlier time as lead). It adopts the live reservation records, so it refunds a settle for one of them only from the machine bound to it and before it expires. It also adopts any pause still running, so a chain of handovers never skips a pause. With no pause in the snapshot, it goes on with no pause. This is the planned-handover case, such as a restart or a move, and the owner notices nothing.

A sealed holder stays sealed. It answers any later seal with a still higher epoch with the same final snapshot (durations re-measured), and answers anything else `sealed`. It unseals only when it moves into holding the lease again, through the check below. A seal that fails the check changes nothing. A seal that arrives while the holder is still renewing its lease successfully is reported as the degradation `PinBudget.sealRefused`. One residual is stated plainly. During a brief renewal lapse, when `holdsLease()` is false with no real handover, a compromised pool machine could seal the lead with a self-signed record. The cost is a short pause for new browsers, never extra guesses, and only from a machine that already holds the PIN.

**When it cannot, it grants nothing for one window plus one lease life.** If the previous holder does not answer (the usual reason for an unplanned handover), the new lead cannot know what was counted. It also cannot know exactly when the previous holder stopped granting. The lease gives the bound: a holder that has not confirmed a renewal within the lease's `ttlMs`, on its monotonic clock, stops acting (`LeaseCoordinator.holdsLease()`), and every reserve checks `holdsLease()`. So the previous holder's last grant is at most `ttlMs` after the new lead took over, and that grant's window ends at most 5 minutes later. The new lead therefore grants nothing for 5 minutes plus `ttlMs` from the moment it took the lead, and its own unknown-browser attempts are refused for that time. A marked browser, the phone and the machine itself still work on it. So a stranger gets at most 20 across the handover, even if the old lead granted until it fenced itself. **A lead that cannot prove it is the only lead grants only its share.** The lease layer has two paths where a holder marks its renewal confirmed without any peer confirming it: `confirmHoldOnPeerPull` and the solo-captain hold in `LeaseCoordinator`. In a pool with no named captain, both machines may then believe they hold the lease until they reconnect (a split lease). So the build records how each renewal was confirmed. While the lead's latest renewal was confirmed without a peer, it grants at most **`floor(20 / N)`** per window, with no minimum. N is every machine in its registry that has ever been paired and is not retired. This is a conserved allocation. Every machine that might believe it leads during a split is held to the same share, so together they stay at or below 20 even then. With N above 20 the share is 0 and such a lead refuses. Once a peer confirms a renewal again, the full budget applies, counted from the same `pin-lead.json` count. A two-machine agent whose laptop is asleep therefore still offers new browsers 10 tries per window on the machine that is awake. During the up-to-10-second seal retry, the new lead grants nothing and refuses unknown browsers with the same words. The windows are fixed, not sliding, so as today a burst at the very end of one window and the start of the next can reach 40 in a short span. That is the existing window design, not something this spec adds.

**Alternatives weighed for the cut-off and handover cases.** These costs fall only on a brand-new browser, and only while machines are cut off or in the pause after an unplanned handover (5 minutes plus one lease life). The owner's ways in (§5) are untouched. Two alternatives that would soften them were weighed:
- **A fixed local share for a cut-off machine** breaks the bound unless the lead holds that share back from its own 20 every window. Holding it back is a conserved reserve, an escrow: each machine draws a small allocation from the lead while connected, and the lead counts it as spent. That adds per-window state on every machine and a draw protocol. It also cuts the budget a connected agent offers new browsers, all to help a new browser on a cut-off machine during the window the cut began. It is left out of the first build. The trigger to build it is defined and tracked: if dev-agent-live records even one refused new browser that was not part of a counted attack (a cut-off refusal or an unplanned-handover pause), the security session builds the escrow before it raises the fleet packet. This is opened as a commitment when the build merges, due at the end of the dev-agent-live week. The escrow fits this design without changing the lead's count.
- **Handing over the count** is adopted where it can work: the planned handover above. It cannot work when the previous lead is gone, which is when the pause applies.

**Every move into the lead is checked against the lease record.** A stored label cannot prove that no one else led while this machine was away, whether it restarted or lost and regained the lease in-process. The lead's record lives in `pin-lead.json` with the count (§3). It is written whenever any part changes, not on every renewal. Taking over writes the holder record, the adopted count and any pause in one write, and that write must succeed before anything is admitted. So a crash or a failed write can never leave a new epoch beside an old count. **A saved seal wins:** a machine whose `pin-lead.json` records `sealedAtEpoch` never carries on from its count, even if the lease record still names it at the same epoch. Its count was handed over, so it is a new lead the next time it acquires the lease. Each time a machine moves into holding the lease, it carries on from its durable count with no pause only if the lease record it now holds names itself, and the record's epoch is the stored epoch or one more. The lease epoch rises by one on each of its own acquisitions (`FencedLease.buildAcquisition`), and any other holder in between raises it by at least two. Any other result, including a lease record that cannot be read, makes it a new lead: it seals the previous holder as above, or else pauses. A pause is written to the row (`pauseUntil`) before anything is admitted, so a restart during the pause keeps it.

**Alone means never paired.** A machine counts locally as the lead, with no network call and no pause, only when its machine registry has never held another machine: no other machine record, active or retired. Once a machine has been paired, it follows the pool rules for good. Missing or disagreeing roster information is never read as being alone. A once-paired machine that is the only active one and holds no lease refuses unknown browsers until it acquires the lease, which the lease layer does on its own. A pool with two or more active machines and no current holder refuses unknown browsers until a holder exists. That is safe, it is counted (§9), and it is reported as a degradation. If a machine refuses for lack of a grant for more than 30 minutes at a time, the pool view shows it as a standing problem.



## 5. Lockout and recovery for the owner

The owner's normal ways in never depend on the shared budget: a browser that unlocked before (on that machine's address), the paired phone app, and the machine itself. They work during an attack, during a handover, and when machines are cut off.

**What changes, said plainly:**
- An agent with several machines now has the protection it was meant to have: 20 guesses per 5 minutes in total, not 20 per machine.
- **Draining the budget now affects the whole agent.** Before, an attacker needed every machine's address to stop new browsers everywhere. Now one address is enough to make new browsers wait a few minutes on every machine. Browsers that unlocked before, the phone and the machine itself still work. This is the cost of a real bound, and it is the same cost the single-machine design already accepted.
- A new browser on a machine that cannot reach the lead, or in the pause after an unplanned handover (5 minutes plus one lease life), is refused with the same words. A planned handover, such as a restart or a move, carries the count over with no pause. The pool view counts these refusals, so it is measured how often they happen, and an escrow (§4) is the follow-up if they matter.

**Alerts.** The lead raises the existing brute-force alert (`DashboardPin.bruteForce`, with its 30-minute cooldown) when the shared count reaches 20. A refusal sent to another machine carries `spent: true`, so that machine does not raise its own alert. The owner gets one alert for the agent.

**Recovery.** No manual step. The count refills with its window. A damaged existing counter file still pauses the switch-off budget for one window, as today. A damaged or missing `pin-lead.json` on a paired machine makes it a new lead, so it seals the previous holder or pauses for 5 minutes plus one lease life. On a machine that was never paired, a missing file simply starts a fresh count, as the existing store does today.

## 6. Migration and mixed versions

- **Development agents first.** `security.pinBudget.poolWide` follows the development-agent gate: when it is omitted, it is on for a development agent and off on the fleet. An explicit true or false always wins. It is read from the settings file only, never patchable through the API (the same fence as the other security keys). Off means today's per-machine budget.
- **Every machine advertises its effective state** as `pinBudgetPoolWide: true|false` in its capacity flags, so the pool view shows which machines enforce the shared budget.
- **An older machine** keeps its own 20 until it updates. That is the residual during a rollout, and it is no worse than today.
- **A new machine with an older lead, or with a lead whose switch is off,** refuses unknown browsers (404 or 409, §4). Because the switch follows the agent's development flag, the machines of one agent agree unless someone sets it differently by hand.
- **No data migration.** One new file, `pin-lead.json`, which older builds ignore. The existing counter file is unchanged.

## 7. Multi-machine posture

This spec is the multi-machine posture for the global PIN budget, which becomes unified: the lead's authoritative count. It supersedes the `machine-local-justification` in `docs/specs/dashboard-pin-throttle.md` for that budget only. The per-source backoff, the per-network brakes and the marker abuse cap stay per machine under that spec's exception. With the switch on, it closes the residual named in `docs/specs/identity-security-piece1c-pin-policy.md` §4. With the switch off, that residual remains. The lead's count is not replicated. A planned handover seals the previous holder and carries the count over. A handover where the previous holder cannot be reached pauses grants for one window plus one lease life instead (§4).

## 8. Configuration and fixed limits

- `security.pinBudget.poolWide` (boolean, file-only; omitted means on for a development agent, off on the fleet, per `resolveDevAgentGate`).
- The budget stays at 20 per 5 minutes.
- The reserve timeout is 1.5 seconds, the grant life 30 seconds, the compare margin 1 second, and the new-lead pause 5 minutes plus the lease's `ttlMs`. Each is classified below.

## 9. Verify the State, Not Its Symbol

- **A grant** is the only thing that admits a remote attempt. Its symbol is a reply body. The state it claims is that one attempt was counted at the lead. The corroboration is the lead's reserve log entry for that id. Anything unmeasurable (no reply, a malformed body, an expired deadline) is treated as no grant.
- **The reserve log** is the lead's append-only `state/pin-budget-reserves.jsonl`. Each line records the time, the machine, the reservation id and the outcome (granted, refused, refunded, expired). It holds no PIN, no address and no request content. It is bounded by rotation at 5 MB.
- **Each machine counts** its own unknown-browser attempts by path: reserved, refused by the lead, and refused with no grant. Those counts appear in the pool view.
- **The graduation check** compares the lead's granted count with the sum of the machines' reserved counts for the same period. A difference beyond lost network calls is a finding. A machine whose counts cannot be read is reported as unmeasured, never as matching.

## Decision points touched

- Count the global unknown-browser budget once per agent, at the lead: invariant; basis: irreversible-consequence; evidence: a correct guess returns the permanent agent key (SEC-150), and per-machine counting multiplies the guessing rate by the machine count.
- Reserve and count before comparing, atomically, on every consumer: invariant; basis: irreversible-consequence; evidence: the cross-machine call adds a wait, and comparing first would let concurrent remote attempts learn the answer before any is counted.
- Write the lead's count and record successfully before granting, admitting after a takeover, or answering a seal; refuse on a failed write: invariant; basis: irreversible-consequence; evidence: a count or seal that exists only in memory is lost on restart, and a restart could then grant against a count that was already spent or handed over.
- Refuse an unknown-browser attempt without a well-formed, live grant: invariant; basis: irreversible-consequence; evidence: any local fallback budget adds to the lead's 20 (a cut-off machine plus a reachable lead, or a handover), and the owner's ways in do not depend on this budget.
- A new lead takes over the previous holder's count when it answers, and otherwise grants nothing for one window plus one lease life: invariant; basis: irreversible-consequence; evidence: the previous holder's count is the only record of what was spent, and a grant made without it could exceed 20 across the handover.
- Leave the escrow for cut-off machines out of the first build: judgment-candidate. Floor: a cut-off machine refuses unknown browsers, and the owner's ways in are unaffected. Arbiter: the security session, under the defined trigger (one refused new browser outside a counted attack during dev-agent-live means the escrow is built before the fleet packet). Fallback: build the escrow.
- A lead whose latest renewal was confirmed without a peer grants at most floor(20 / N), with no minimum: invariant; basis: irreversible-consequence; evidence: in a pool with no named captain, two machines can both believe they lead (confirmHoldOnPeerPull, the solo-captain hold), and only a share that every such machine respects keeps their total at or below 20.
- Charge a no-longer-honored (abused) marker to the shared budget: invariant; basis: enumerable-domain; evidence: an attempt is either local, from an honored marker, or neither, and only the first two are outside the shared budget today.
- Seal the previous holder only on a valid, newer lease record that the holder's own lease view agrees with: invariant; basis: irreversible-consequence; evidence: a lease is signed only by its own holder, so a record alone could be forged to stop a healthy lead, while sealing on a true handover is what keeps the count exact.
- Hand over the count, the live reservations and any running pause as remaining durations: invariant; basis: irreversible-consequence; evidence: a dropped pause or a clock-skewed deadline would let a new lead grant before the previous count could have reset.
- The seal timeout (1.5 seconds per try, retried for up to 10 seconds): judgment-candidate. Floor: no seal means a pause, never a fresh budget. Arbiter: the security session, from handover timings measured during dev-agent-live. Fallback: 1.5 and 10 seconds, two lease-pull periods.
- Refund only the reserving machine's own unexpired, unsettled reservation: invariant; basis: enumerable-domain; evidence: the reservation id, its bound machine id and its expiry are recorded at the lead, so each refund is checked against closed facts.
- Keep marked browsers, the local budget, the phone app and approval links outside the shared budget: invariant; basis: enumerable-domain; evidence: the owner's ways in are a closed list (§5) and none of them depends on the shared budget today.
- The reserve timeout (1.5 seconds): judgment-candidate. Floor: a timeout refuses the attempt, never admits it. Arbiter: the security session, from the reserve latencies measured during dev-agent-live. Fallback: 1.5 seconds, which is above the pool's observed round trips over a tunnel and short enough that a refused owner retries at once.
- The grant life (30 seconds) and compare margin (1 second): judgment-candidate. Floor: an expired grant refuses, and a grant never outlives the lead's window. Arbiter: the security session, from measured settle delays. Fallback: 30 seconds and 1 second.
- The 14-day ceiling from merge to the fleet packet: judgment-candidate. Floor: the packet is raised through a tracked commitment and the fleet stays off until Justin decides. Arbiter: the security session. Fallback: 14 days, the same ceiling SEC-164 used.
- Turn it on for the fleet: judgment-candidate. Floor: the graduation criterion in the maturation plan, met on the development agent. Arbiter: Justin, on an evidence packet from the security session through the Chief of Staff. Fallback: the fleet stays on the per-machine budget.

## Maturation plan

- **dark-window:** dark on the fleet from merge (the switch is dev-gated); at most 14 days from merge to the fleet packet. The security session raises the packet through a tracked commitment rather than letting it lapse.
- **test-agent-live:** on two throwaway agents paired as one pool, an unknown browser gets 20 wrong tries per window in total across both addresses, and the 21st is refused on either. With the lead stopped, the other machine refuses unknown browsers. A planned handover (the previous lead still running) carries the count over with no pause, and a handover with the previous lead stopped refuses for the whole of 5 minutes plus the lease's ttlMs, including after a final grant by the previous lead just before it fenced itself, and then counts afresh. A browser that unlocked before on each address still unlocks at once there.
- **dev-agent-live:** on the development agent's machines for one week. The reserve log and the machines' counts agree, no owner sign-in is refused except a new browser during a counted attack or a cut-off, and settle failures are only lost network calls.
- **fleet:** after the week on the development agent with the graduation criterion holding, the security session delivers the packet. On Justin's yes, a release makes the switch default to on for the fleet.
- **graduation criterion:** one week on the development agent with the lead's granted count matching the machines' reserved counts (§9), no owner lockout, and both the cut-off refusal and the new-lead pause exercised at least once in a test. Also either no refused new browser outside a counted attack, or the escrow (§4) built and covering that case.
- **ladder:** pinBudgetPoolWide
- **ladder note:** the entry is added to src/data/feature-ladders.json in the build pull request, with this switch as its flag and the graduation criterion as its metric.

## Frontloaded Decisions

- The lead keeps the count. Replicated logs were rejected because their lag lets each machine spend a full budget first.
- There is no fallback budget. A machine without a live grant refuses unknown browsers. A lead that cannot prove it is the only lead (its renewal was confirmed without a peer) grants only floor(20 / N). So the agent-wide total never goes over 20, even during a split lease.
- The escrow for cut-off machines is built before the fleet packet if dev-agent-live records any refused new browser outside a counted attack (a tracked commitment).
- Reserve before comparing, atomically, everywhere. Give the reservation back only on success, only to the machine that made it.
- A new lead seals the previous holder and takes over its final count when it answers (a planned handover, with no pause), and otherwise grants nothing for one window plus one lease life. Every move into the lead is checked against the lease record; a restart or re-acquire with no one else in between carries on.
- Only the global unknown-browser budget becomes shared. Every other brake and way in stays as it is.
- Live on development agents first (dev-gated, file-only switch). The fleet turn-on is Justin's decision on the evidence packet.

## Open questions

*(none)*

## Rollback

Set `security.pinBudget.poolWide` to false, or revert. Each machine then uses its own 20 again. The reserve log and `pin-lead.json` can stay or be deleted, since nothing reads them when the switch is off.

## Tests

- **Unit, the lead's count:** an atomic reserve grants until 20 and refuses after, using the lead's window only. Concurrent reserves never pass 20. A refund works only for the reserving machine's own live, unsettled id. Unknown, used, expired and foreign ids change nothing.
- **Unit, the consumer order:** on all three consumers the reserve happens before the compare. A wrong PIN stays counted, a correct PIN refunds, and an expired grant refuses without comparing. The deadline runs from the request's send time, so a slow reply loses the time it spent in transit. The email-code check becomes asynchronous while the approval-link check that shares its factory stays synchronous. The existing PIN tests are updated for reserve and refund, including mock stores.
- **Unit, no grant:** a timeout, a connection failure, 404, 401, 409, a malformed body and no known lead each refuse, report the degradation once per episode, and never compare the PIN.
- **Unit, moving into the lead:** on every acquisition, including an in-process re-acquire after a lapse, the machine carries on only when the lease record names it with its stored epoch or one more. A gap of two or more, another holder, or an unreadable record makes it a new lead.
- **Unit, the seal check:** `verifySealClaim` refuses a bad signature, a holder other than the signer, an expired record, an epoch that is not higher, a record the sealed holder's own view does not confirm while it still holds the lease, and a seal at a holder whose own lease pulls are stale. A sealed holder answers a higher-epoch seal with the same snapshot and anything else with `sealed`. A handover A to B to C during B's pause keeps the pause, including across restarts. Skewed clocks never shorten a handed-over duration.
- **Unit, handover:** a valid seal makes the previous holder stop granting before it answers. A reserve arriving after the seal is refused. The new lead adopts the count as given, with no additions, plus the live reservation records, and refunds a settle for one of them. A seal without a valid newer lease record is refused and changes nothing. With no answer, the new lead pauses for 5 minutes plus `ttlMs`, and a restart during the pause keeps it. A previous holder that grants until its self-fence cannot leave a window open past the pause. A crash injected between any two steps of a takeover never leaves a new epoch beside an old count, and a leftover temporary file on boot is ignored. A failed write refuses the reserve, pauses the takeover and leaves the seal unacknowledged. A holder whose seal was written never carries on from its count after a restart, even at the same epoch. An older build reading the state folder ignores `pin-lead.json`.
- **Unit, split lease:** while the lead's latest renewal was confirmed through `confirmHoldOnPeerPull` or the solo-captain hold, it grants at most floor(20 / N) per window, and two such leads together never pass 20. A peer-confirmed renewal restores the full budget from the same count. With N above 20 it refuses. The partition test exercises both renewal paths.
- **Unit, markers:** an honored marker never reserves. An abused marker on all three consumers is charged to the shared budget.
- **Unit, alone:** a machine whose registry never held another machine counts locally and never pauses. A machine that was ever paired follows the pool rules even when its roster looks empty. Two active machines with no holder refuse.
- **Integration, real routes:** an unknown browser's wrong PINs at a non-lead are counted at the lead, a correct PIN settles, and the reserve log records each. Marked browsers, local callers and approval links never call the lead. The 429 words are unchanged. A cached refusal makes no further calls until `retryAfterMs`.
- **Integration, signing:** an unsigned or non-pool reserve or settle is refused. A settle signed by a different machine refunds nothing.
- **End-to-end:** two real servers as a pool. 20 wrong tries across both addresses spend the budget, and the 21st is refused on either. Stopping the lead makes the other machine refuse unknown browsers, while a browser that unlocked before still works there.
