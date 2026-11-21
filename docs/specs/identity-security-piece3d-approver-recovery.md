---
title: "When every approving device is lost: recovery through the private chat (piece 3d)"
slug: identity-security-piece3d-approver-recovery
author: Echo
tier: 2
status: approved
eli16-overview: identity-security-piece3d-approver-recovery.eli16.md
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
sibling-principles: "An Instar Agent Is Always a Multi-Machine Entity; Bounded Blast Radius; Verify the State, Not Its Symbol"
parent-spec: "identity-security-levels.md (approved 2026-11-17 19:34 PST, Justin, topic 144636), §9 Recovery and §11 decision 3 (the 72-hour wait); mobile-approver-mark.md §3.8 (approved design this adapts to the owner record); owner-authentication.md §7 (veto brakes)"
depends-on: "identity-security-piece3a (the approver mark in the owner record), piece 3c (the apps)"
lessons-engaged: "verify-the-state-not-its-symbol, a-dark-guard-is-worse-than-no-guard, sent-count-can-be-a-quiet-hold"
review-convergence: "2026-11-18T20:45:09Z"
review-iterations: 5
review-completed-at: "2026-11-18T20:45:09Z"
review-report: "reports/identity-security-piece3d-approver-recovery-convergence.md"
cross-model-review: "codex-cli gpt-6.2-astra (headley.justin) rounds 1 and 2"
approved: true
approved-by: "Under the approved umbrella identity-security-levels.md (Justin, topic 144636, 2026-11-17 19:34 PST: \"great! approved, please enter a 24 hour autonomous session in gpt 6.2 astra to build this\"), §9 Recovery, §4.5a and decision 3, adapting the approved mobile-approver-mark.md §3.8, and Justin's standing guidance that only constitution changes need his approval (2026-10-22). No constitution text changes here."
---

# When every approving device is lost: recovery through the private chat (piece 3d)

## Problem statement

Piece 3a puts every approving device in the signed owner record. After the first one, only an approving device can add another, so an owner who loses every approving device has every risky action held. 3a refuses to remove the last approver for that reason.

The approved design has a way back (umbrella §9, mobile-approver-mark §3.8):
- the owner names the new device in their private chat;
- 72 hours pass, with notices;
- any sign of a living approver stops it;
- the new device proves itself again with a fresh chat code.

This piece builds that on the record, for agents that have a private chat, at today's only level (Basic).

## Proposed design

### 1. The steps

1. **Ask on the new device.**
   - The new phone, paired through the private chat (pairing at Basic needs no approver), makes an ordinary request (3a §4).
   - The phone shows the six-digit match code and its 64-bit key fingerprint (3c).
2. **Start, in the private chat, on the lease holder.** The owner types `/approver_reset <match code>`.
   - **Who may.** The adapter acts on it itself, before any routing, only when all of these hold:
     - it is a message read from Telegram's own updates, which proves its origin, with the owner's own id (`getOwnerUserId()`);
     - it is in the owner's private chat and not forwarded;
     - this machine holds the lease.
   - **The answer.** The bare command explains. With a code, the adapter answers with:
     - the device and its key fingerprint;
     - the devices that can approve, with what each can do;
     - mobile-approver-mark §3.8 step 2's sentences, including that any approving device stops it by approving anything.
   - It offers **Start** and **Never mind**. Start is a callback whose origin is verified (the mobile-pairing button path checks it): 30 minutes, single use, bound to the device id, request id and key hash shown.
   - **Start is refused when:**
     - any machine reports a recovery, can't be read, or lacks this piece's guard `approver-recovery` in its fresh signed build statement (the 2c ledger, as 3a's claim does);
     - a signed Stop locked recovery in the last 7 days;
     - the target isn't an active owner device paired through the private chat, or is a browser;
     - the candidate key is retired (3a).
3. **Record.** The lease holder becomes the recovery's **home** and writes `recovery` to its approver state file:
   - `recoveryId` (128 bits) and `startedAt`;
   - the target device id and request id, and the candidate presence key and its hash, all **frozen**;
   - **who counts for a signed Stop**, also frozen: the owner keys valid in the record now, less every key in any machine's retired list, each with when this machine first saw it;
   - **the lost keys:** every owner key valid at the start (the owner is recovering because they lost every approving device). The Start card lists them by device. Umbrella §4.5a: a recovery "adds the candidate; revokes the lost keys named at the start".

4. **Every machine sees it.**
   - Each machine reports its own home recovery in its pull reply (§4). Every machine records, durably, **when it first saw** each recovery and each notice in a peer's reply, on its own clock.
   - These first-seen times are what the arrival check measures from (§2). A home that claims an early `startedAt` gains nothing on any other machine.
5. **Notices.**
   - **Three,** on the original clock (umbrella §9): at the start, at the halfway mark (36 hours) and in the final hour (from 71 hours). A notice that isn't accepted is retried until it is. The wait is never compressed: ready needs all three, and at least an hour after the final one.
   - **Each goes out when due, day or night.** owner-authentication §7 escalates reset notices immediately. Umbrella §9's overnight hold of the first two is not used, because these are the owner's warning about a takeover.
   - **Each is also pushed** to every owner device paired before `startedAt` (umbrella §9, mobile-approver-mark §3.8). When a thief holds the chat, the push to a phone in a drawer is the owner's real chance to notice. Only the chat's acceptance counts toward readiness.
   - **Every machine also pushes** to the owner's devices on its own first sight of a recovery (code review), so a compromised home that sends no notices still can't run a silent recovery past the other machines.
   - **Each names:** who can stop it (the counted keys' devices, and "any device that can approve, by approving anything"), the time left, and whether any device has seen it (below).
   - **"Accepted"** means Telegram returned a message id for that exact send through the owner-DM path that is never held as a quiet notification (3a's `sendOwnerDMWithButton`). A "sent" stamp never counts. The adapter returns the id.
   - **Notices go only from the home while it holds the lease.** A home without the lease sends none, so the wait lengthens and never shortens. When the home loses the lease it tells the owner once, through the new lease holder, that the recovery is paused until that machine answers the chat again.
   - **Ready** comes when all of these hold:
     - 72 hours have passed since `startedAt`;
     - the three notices are accepted;
     - at least 1 hour has passed since the final one.
   - **"Seen" is shown, not required** (umbrella §9). It counts only when it is a device-signed acknowledgement (`POST /mobile/approver/recovery/seen`) from an owner device paired before `startedAt` that isn't the candidate. A phone paired after the start can't reassure anyone.
6. **Stop.** Any one of these:
   - **A signed Stop** (`POST /mobile/approver/recovery/stop` with a presence signature over `instar-approver-recovery-stop-v1\n<agentId>\n<recoveryId>`). It comes from a counted key added at least 24 hours before `startedAt`, and never from a retired key.
     - It is the only stop that **locks recovery for 7 days** (owner-authentication §7).
     - The 24-hour age follows owner-authentication §7. In practice any approval stops the recovery anyway (below), so the age matters only for the lock.
   - **The owner's Stop tap** on any notice. It ends this recovery, with no lock, because the same chat that started it can't be trusted to lock it out.
   - **Any verified presence signature by any approver other than the candidate,** on any machine, at or after `startedAt` minus 60 seconds (3a's `lastPresence`). This also needs no lock. Only owner devices can approve today (3a grants only to owner devices), so a team member's activity can't stop an owner's recovery.
   - **Recording.** Every stop is written to the receiving machine's `stops` before it answers. `stops` travel with every machine's facts (§4), and every machine keeps the union.
     - **Retention:** a stop is kept until its recovery has ended on every machine, then for 30 days, so the 7-day lock and late-stop answers can still read it.
     - **Cap:** at most 100 ended stops. A stop for a recovery that hasn't ended is never evicted.
   - **A Stop that arrives after Finish but before the recovered key has settled** (§2) still stops it. Every machine that sees that stop retires the recovered key, and the owner is told "Stopped in time".
   - **Only after settling** is the owner told "This already finished. Remove <device> under Devices that can approve" (mobile-approver-mark §3.8). The receiving machine asks the home which applies. When the home can't be asked, the stop is recorded and the owner is told it will be confirmed. The owner is never told a stop worked when it didn't.
7. **Finish,** on the home, while it holds the lease.
   - **The device asks.** `POST /mobile/approver/recovery/finish` sends a fresh code to the private chat: 30 minutes, three tries, accepted as above. The device returns it to `/finish/confirm`.
   - **The home checks,** within that request:
     1. it reads every machine's latest **signed** facts (§4), which must be at most 15 minutes old: one sync interval. The recovery is stopped if any machine shows a stop, or an approval by another device at or after `startedAt` minus 60 seconds, with clocks shifted by each machine's reported `now`. A machine whose latest signed facts are older than that counts as not answering: nothing changes, and the device can try again after the next sync. Anything the facts miss in those 15 minutes is caught by the provisional key and every machine's arrival check (§2), which only ever take rights away;
     2. the target's request still holds the frozen ids;
     3. it builds the unsigned entry (§2), without the proof.
   - **The device signs.** It checks the entry is its own frozen key, computes the id itself, and signs (`/finish/sign`).
   - **The home finishes.** It reads every machine's latest signed facts **again**, by the same rule, and only then ingests the entry.
     - The entry's id covers the proof and `finishedAt`, so the home signs the proof after the first read, and the device signs after that.
     - The device talks only to the home, so a completed entry never leaves the home unless the second read is clear and it is ingested.
     - A recovery stopped at the second read leaves nothing in any record, and the home discards the draft. Recovery takes nothing away from any device (mobile-approver-mark §3.8).
   - The owner is told the recovered device will be able to approve once every computer has accepted it (§2), usually within 15 minutes.
8. **Ends by itself.** A recovery not finished within 7 days of the wait ending (`startedAt` plus 72 hours plus 7 days) ends with a message, whatever the cause (a late notice or a chat outage included). So the slot is released on schedule, and a late readiness never extends the deadline (umbrella §9).

### 1b. Where the limits come from

| Limit | Source |
|---|---|
| 72 hours; 7 days to finish | umbrella §9 and decision 3 |
| Three notices at 0, 36 and 71 hours on the start's clock, the final one at least 1 hour before ready | umbrella §9 (start, halfway, final hour). A clock jump can't bunch them, because ready also needs 72 hours on every machine's own clock (§2) |
| A signed Stop needs a key 24 hours older than the start, and locks recovery for 7 days | owner-authentication §7. The record has no trusted time, so the age is when this machine first saw the key; a key of unknown age stops a recovery but never locks one |
| Start card 30 minutes; finish code 30 minutes, three tries | mobile-approver-mark §3.8, the pairing code's rules |
| 60 seconds before the start counts as during it | mobile-approver-mark §3.8 (the clock-shift rule) |
| Arrival: own clock 72 hours past this machine's first sight of the recovery | §2 below; no tolerance is needed, because each machine measures on its own clock from its own observation |
| 10 seconds per machine at Finish | twice the mesh client's 5-second default. A slower machine means "try again", never a refusal of the recovery, so the device simply retries |
| Stops kept until their recovery ends everywhere, then 30 days | so the 7-day lock and the late-stop answer can always read them. Nothing undecided is ever evicted |
| The 7-day end | umbrella §9 ("then 7 days to finish"), counted from the wait's end, so an outage can't hold the one slot. Ending changes nothing, and the owner can start again at once |

**Why fixed floors here, not judgment** (Judgment Within Floors): each number guards the one act that hands over ownership with no living approver. Each is an operator decision or an approved spec's floor, and a softer reading would be exactly the gap a thief with the owner's chat looks for. Every boundary is tested on both sides.

### 2. The record entry and its checks

- **The entry.** `add-owner-key` with `body.via: 'recovered'` and `body.recovery`, self-signed by the candidate key. `body.recovery` contains:
  - `recoveryId`, `startedAt`, `finishedAt`, `stopCheck: 'clear'`;
  - `proof`: `{ by: <home machine id>, sig }`, by the home machine's key, over `instar-owner-recovery-v1\n<agentId>\n<parentId>\n<recoveryId>\n<deviceId>\n<ownerKeyId>\n<presenceKey>\n<startedAt>\n<finishedAt>`.
- **2a's rule** (the only change to 2a). After enrolment, such an entry counts when all of these hold:
  - the proof verifies against a machine key valid in the record at the parent;
  - that machine key is not revoked anywhere in the entry's ancestry or by a revocation that precedes it (2a's revocation ordering applies to the attesting key's instance, as it does to signers);
  - `finishedAt − startedAt ≥ 72h`;
  - the key id matches the key.

  At Locked box 2a refuses it: there the guard holds the timer (umbrella §9).
- **Every machine checks on arrival.** 2b's ingest runs this for push, pull and local ingest alike, once per `recoveryId`, and the decision is recorded so a restart doesn't re-run it. The checks:
  - **This machine saw the recovery** in the home's reply, and at least 72 hours have passed on its own clock since it first did.
  - **It saw the final notice** at least 1 hour ago on its own clock.
  - **Its own facts show nothing during the wait:** no stop for that recovery, and no approval by another device since it first saw the recovery.
- **The outcomes:**
  - **All three hold:** accepted.
  - **The wait or the notice isn't yet satisfied,** or this machine never saw the recovery: the entry is **held**. It isn't ingested, it is checked again each tick, and anything built on it waits with it. A machine that was registered at `startedAt` and never saw the recovery never accepts its key. This is what stops a compromised or removed peer from minting an owner key by claiming an early start.
  - **A machine that never saw it** (joined later, lost its records, or a peer hid the recovery from it) treats the entry's own arrival as its first sight. It waits 72 hours on its own clock from then and checks its own approvals. It also requires every other machine in its own registry to report accepting that exact entry. A compromised peer can't skip the wait, even on a two-machine agent (code review).
  - **Only one entry per recovery.** A second or conflicting entry (another device or key than the frozen one, or a proof by a machine other than the home) is refused outright: never stored, and no stop is recorded.
  - **A recovery counts only from its own home's facts.** Another machine relaying it is ignored, and two homes claiming one id stop it.
  - **A stop or an approval during the wait:** this machine retires the recovered key (3a's retired list, shared with every machine), records a stop, and tells the owner once.
- **Provisional until settled** (mobile-approver-mark §3.8's provisional mark). The recovered key **approves nothing, signs no record change and grants nothing** until settled.
  - **Settled** means every machine in this machine's **own** registry at its first sight (on the home, at the start) has reported, in its signed facts, that it accepted that exact entry, and no stop for the recovery is known here. The home's list is never trusted for this.
  - **Once settled here, it stays settled.** A later stop gets "This already finished. Remove <device>". A machine that records a stop before settling withdraws its own acceptance.
  - **A stop that reaches a machine that hasn't settled yet** keeps the key provisional there, and that machine withdraws its acceptance, so the key never settles anywhere that still needs it. The lost keys are revoked only after a further clean round (§3).
  - **Enforced everywhere:** the one approver reader (3a §7) treats an unsettled recovered key as not approving, and 2b's ingest holds any entry signed by an unsettled recovered key, on every path.
  - **The effect:** nothing the key signs in its first seconds can outlive a stop that reaches another machine.
  - **A silent machine** keeps the key provisional. The owner can remove that machine with the CLI's machine removal (`instar machines remove`, `src/commands/machine.ts`), which the agent runs for them on its own computer and which needs no approving device.
  - **Until piece 4 makes retiring a machine a Serious act,** the CLI removal is how a gone machine stops blocking. After that, the route for an owner with no approving device is owner-authentication §7's administrator reset (Left behind).
  - **What removal changes:** only the set that has to accept before settling shrinks. Every stop and approval the removed machine already reported stays in every other machine's union. Settling then waits for one fresh round of signed facts from every remaining machine, so a removal can't race a stop that hasn't spread yet.

### 3. The lost devices

Umbrella §4.5a (approved) decides it: a recovery adds the candidate and revokes the lost keys named at the start. This piece does it at the one point where that can't hurt a living owner, which is **settling** (§2), never Finish:
- **The race.** A device that approves in the last seconds is caught. Every machine that sees the approval retires the recovered key, so it never settles, and nothing is revoked (review rounds 2 and 3).
- **When settled,** the home waits one further sync round with no stop anywhere. Then it retires the lost keys on every machine (3a's shared retired list), and the new device signs their `revoke-key` entries (3a §6) when the owner opens the app.
- **The thief case.** A thief who took over the owner's chat and went unnoticed by every device for 72 hours completes a recovery, including this revocation. That is the residual umbrella §9 and decision 3 accept, stated for everyone. Each notice names the devices that will be removed, so a device that sees one can stop it.

### 4. What every machine reports

**Facts that decide** travel in each machine's **signed pull request**, the one its 15-minute sync sends to every peer, which the mesh signs and the receiver verifies. Pull replies aren't signed, so they carry the same facts only as a hint for display, never for a decision.

This applies to 3a's retired-key list too. It moves from the pull reply into the signed facts, so a forged reply can't retire a key; 3d makes that change in 3a's sync.

During a mixed rollout, retired hashes are still merged from the replies of any machine whose signed build statement lacks the `approver-recovery` guard. They come only from signed facts once every machine carries it. A wrongly retired key only takes rights away, so the interim is safe. The `approver` facts gain:
- `recovery`: this machine's home recovery, with its id, `startedAt`, state, the notices with their acceptance times, and the target name;
- `stops`;
- `lastPresence`;
- `now`;
- `acceptedRecoveries`: `{ recoveryId, entryId }` pairs. An acceptance names the exact entry, so two different entries for one recovery can't share acceptances;
- `retired`: 3a's retired-key hashes, now merged only from signed facts.

A machine's first sight of a recovery is when a signed pull request from the home first carried it.

Each machine stores, per peer, the latest reply and its own first-seen times. The guard `approver-recovery` is added to this build's signed build statement.

### 5. The apps (3c)

- **On the candidate:** "Recovery started" with the time left, then Finish (the chat code, the entry check, then Face ID or the fingerprint).
- **On every owner device:** the running recovery at the top of Approve changes, with who can stop it, whether anyone has seen it, and Stop (a presence signature) on a device that can approve.
- **On a device that can't approve:** "I lost my approving device" explains the chat command.

## Decision points touched

- **Recovery start:** the owner's verified tap, in the private chat, on the lease holder — invariant; basis: irreversible-consequence; evidence: umbrella §9, mobile-approver-mark §3.8.
- **The wait:** 72 hours plus notices, measured on each machine's own clock from its own sighting — invariant; basis: operator-decision (umbrella decision 3); evidence: umbrella §9; review round 1 (a back-dated start).
- **What stops it, and what locks:** a signed Stop locks; a chat Stop or any approval ends it without a lock — invariant; basis: irreversible-consequence; evidence: owner-authentication §7, umbrella §9.
- **The recovered key:** provisional until every machine accepts it — invariant; basis: irreversible-consequence; evidence: mobile-approver-mark §3.8.

## Multi-machine posture

- **The home** holds the clock, the notices and the finish.
- **Every machine** sees the recovery, measures the wait on its own clock, keeps the union of stops, and holds or accepts the entry itself.
- **The key acts only** once every machine has accepted it.
- **Start and Finish** happen only on the lease holder, and only when every machine answers. A Stop works on any machine.

## Verify the state, not its symbol

| Detector | Symbol | State | Corroboration | Unmeasurable |
| --- | --- | --- | --- | --- |
| The wait happened | the home's signed `startedAt` | each machine's own first sight of the recovery, 72 hours ago on its own clock | the notices it saw, and its own approval log | an owner who ignores three notices and never approves anything for three days (umbrella §9's accepted residual) |

## Rollout

| Stage | What happens | Fallback |
| --- | --- | --- |
| test-agent-live | Throwaway two-machine agents with a test chat and a scripted phone. First a start, the notices, and a stop by an approval on the other machine. Then a **real 72-hour recovery** on a second throwaway pair, started during this build and finished through the real routes when its wait ends (2026-11-21). The 72-hour rule is never shortened in a running build. | revert; recoveries in flight end, nothing is granted |
| dev-agent-live | On Echo's agent, read-only: the build reports its guard, and the holders screen shows no recovery. Every live recovery runs on throwaway agents, never in a real agent's state. | revert |
| fleet | With the app release, after both stages above have passed. Start needs every machine on this build (its guard), so an older machine can't take part. | revert; a retired key stays retired (the list is never emptied by a downgrade) |

## Tests and evidence

- **Unit:**
  - 2a: the recovered entry, both ways, including a revoked attesting key and Locked box.
  - The arrival check: accepted, held, retired; recorded once.
  - Start's refusals; the frozen sets.
  - The notice spacing, the acceptance rule and the ready rule.
  - Every kind of stop, with and without a lock; a retired key's Stop refused.
  - Both reads at finish, and the proof signed only after the second.
  - Provisional until settled.
  - Nothing retired at Start or Finish; the lost devices are revoked through 3a §6 after settle.
  - Both 7-day ends.
  - The chat command's sender rules.
- **Integration:** the stop and finish routes.
- **E2E lifecycle:** the routes answer through the production wiring.

## Maturation plan

- **ladder:** not applicable: mobile-approver-mark decision 10 (approved) is "there is no switch and no dev gate" for the approver mark, and recovery is part of it. Without it, an owner who loses their only phone has every risky action held. The staged evidence still runs: each step is recorded in the build folder with its date and outcome, and the fleet waits on the first two:
- **test-agent-live:** the two-machine throwaway proofs, including the real 72-hour recovery finished through its live surface.
- **dev-agent-live:** the read-only check on Echo's agent.
- **fleet:** with the app release, after both.
- **graduation criterion:** both stages pass, including the real 72-hour finish on the throwaway pair.
- **dark-window:** none.

## Open questions

None.

## Left behind

- **The no-chat recovery,** built with 3b's attestation.
- **The administrator-prompt reset** of owner-authentication §7, which can't be vetoed.
- **The levels' checks at Start and Finish** (the candidate's role at the kept level, and a deciding signer after Finish), built with piece 8. Until then the only level is Basic, where any owner key decides.
- **Voiding standing permissions and sign-ins at Finish,** built with pieces 4 and 5, which create them.
- **A security-key-only owner's dashboard Stop,** built with the security-key enrolment.
- **The person acts of §3.9.**

## Review history

- **Round 1** (internal, plus GPT-6.2 Astra and the constitution check):
  - The wait is measured on each machine's own clock from its first sight of the recovery, so a back-dated start gains nothing.
  - An entry is held rather than retired when its wait isn't met.
  - The attesting key's revocation is checked.
  - Retired keys can't Stop, and only a signed Stop locks.
  - Notices are spaced and must be accepted; "seen" is a signed acknowledgement.
  - The proof is signed after the second read.
  - The recovered key is provisional until settled.
  - Every machine must carry the build guard.
- **Round 2:**
  - Nothing is retired at Finish.
  - A stop before settle retires the recovered key.
  - The rule for a machine that joined later.
  - Notices are pushed to devices too.
  - Facts that decide travel in signed requests.
  - Limits rationale; no test recovery in a real agent's state; a real 72-hour throwaway proof.
- **Round 3:**
  - The stolen marks are dropped (they would enlarge the accepted residual).
  - Finish reads use signed facts at most 15 minutes old.
  - Retired keys travel in signed facts.
  - Machine removal keeps a removed machine's reported stops.
- **Round 4** (GPT-6.2 Astra, second pass):
  - The lost keys follow umbrella §4.5a (named at the start, revoked), at settle plus a clean round, never at Finish.
  - The notices follow umbrella §9's schedule (0, 36 and 71 hours).
  - The deadline counts from the wait's end.
  - Acceptances name the exact entry.
  - A late stop re-provisions the key.
  - The machine-removal route is placed against piece 4.
  - Left for the later pieces that own them: binding Finish to a disputed migrated owner identity (umbrella §10, pieces 1 and 4), home hand-off to a successor, and team members' approval rights.
