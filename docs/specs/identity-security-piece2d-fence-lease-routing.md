---
title: "The fence, part two: a machine below the minimum build doesn't hold the lease or get work"
slug: identity-security-piece2d-fence-lease-routing
author: Echo
tier: 2
status: approved
eli16-overview: identity-security-piece2d-fence-lease-routing.eli16.md
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
sibling-principles: "An Instar Agent Is Always a Multi-Machine Entity; Bounded Blast Radius; Verify the State, Not Its Symbol"
parent-spec: "identity-security-levels.md (approved 2026-11-17 19:34 PST, Justin, topic 144636), line 360 (refuse leases and proxying to a machine below the build), line 233 (Sensitive and Serious effects only on the lease holder); piece 2c §4 (its lease and routing part is built here)"
depends-on: "identity-security-piece2c-minimum-build-fence"
lessons-engaged: "a-dark-guard-is-worse-than-no-guard, verify-the-state-not-its-symbol, fix-the-class-not-the-instance"
review-convergence: "2026-11-18T17:50:00Z"
review-iterations: 7
review-completed-at: "2026-11-18T17:50:00Z"
review-report: "reports/identity-security-piece2d-fence-lease-routing-convergence.md"
cross-model-review: "codex-cli gpt-6.2-astra (headley.justin) round 1"
approved: true
approved-by: "Under the approved umbrella identity-security-levels.md (Justin, topic 144636, 2026-11-17 19:34 PST: \"great! approved, please enter a 24 hour autonomous session in gpt 6.2 astra to build this\"), lines 233 and 360, and Justin's standing guidance that only constitution changes need his approval (2026-10-22). No constitution text changes here. Interpretation of line 360's \"refuse proxying\": work and authority are refused by an exhaustive verb table, and existing conversations continue unmoved under an agent-wide hold (constitution check and Astra round 1)."
---
# The fence, part two: a machine below the minimum build doesn't hold the lease or get work

## Problem statement

Piece 2c keeps machines from becoming below the minimum build after enrolment, and withholds the owner record from one that is below anyway. One way remains for a machine to be below after enrolment: an older build installed by hand, outside Instar's updater. Switching Node versions can do it. The umbrella (line 360) says updated machines refuse such a machine leases and proxying. Sensitive and Serious effects run only on the lease holder (line 233), so the lease matters most.

2c's review found the trap. Cutting a machine off at the network level makes it look dead, so it fights for the lease. And the dark-owner path that would move its work still runs in dry-run. So 2d refuses **authority and work only**, and leaves liveness and lease traffic alone.

Everything here applies only when piece 2c's fence is in force: the record is enrolled above Basic with a usable fence. It uses only 2c's **below** state: a signed statement under the fence, sticky. An **unconfirmed** machine (missing evidence) is never treated as below here.

## Proposed design

### 0. Who counts as below

- **2c's "below" state:** a signed statement under the fence, sticky until a newer signed statement at or above the fence arrives from that machine's own pull.
- **Alive but silent is uncertainty, and uncertainty holds.** A pre-2b build never pulls, so it never makes a signed statement. Coherence adverts can't fill the gap: they ride the presence pull's reply, which is unsigned. So a registered machine counts as **unconfirmed-alive** when both hold:
  - a verified mesh envelope came from it within 24 hours;
  - it has made no signed build statement in that time.

  It is not called below. It is uncertainty, and §1's hold covers it with reason `machine-unconfirmed`, the safe answer to an unknown. A machine that is merely asleep sends nothing, so it doesn't trigger the hold.
- **Not the `MachineHeartbeat` file,** which is git-synced and unsigned.
- **An unconfirmed machine,** with no signed statement, is never treated as below.
- **Retired machines don't count.**

A signature identifies the reporting machine. The version is its own claim: honest older builds are what the fence is for.

### 1. One agent-wide decision: hold while any machine is below

- **The hold.** While the fence is in force and any registered machine is below, or unconfirmed-alive (§0), every updated machine's `ownerRecordGate()` answers `hold`, with reason `machine-below-fence` or `machine-unconfirmed`. Sensitive and Serious actions are held everywhere and viewing continues: the same hold a missing record produces. Updated machines are then safe whatever the old build does. Nothing on them depends on catching every path to it.
- **One actionable notice.** The lease holder raises one attention item that needs the owner. It names the machine and its version, says which version is needed, and gives the two ways out: update it, or retire it (the existing machine-removal path, a Serious action authorised at the umbrella's level). The item is updated in place as the list changes, survives lease moves by its fixed id, and closes when no machine is below. It is never repeated for an unchanged condition.
- **When it lifts.** The hold lifts as soon as the machine sends a signed statement at or above the fence (it was updated), or it is retired.
- **Retiring it passes through the hold.** Removing a machine is Serious, and Serious is held. So removing a machine that is itself below the fence is the one action exempt from a `machine-below-fence` hold. It still needs the owner's approval at the active level. Otherwise a below machine that is dead, lost or can't be updated would keep the hold on for ever.

### 2. The lease: a fixed budget of takeovers

- **Takeover.** Updated machines may take the lease from a below holder: `FencedLease.canAcquire` gains a separate input, `belowFenceHolders` (reason `holder-below-minimum-build`), never the shared presumed-dead set.
- **Never given the lease:**
  - no handback offer to it;
  - a below preferred captain counts as no preference;
  - no transfer to it.
- **A budget that settles.** Each updated machine takes the lease from a given below machine at most three times in 24 hours, counted in its own 2c ledger. With N updated machines that is at most 3×N a day, a small fixed number. Then they stop.
  - An old build retakes only when it believes the holder is dead or the lease expired, so three covers transient blips. Each attempt costs one lease write.
  - Sustained contention ends in a settled state: the agent-wide hold (§1) already holds every privileged effect, and the notice says the old machine is in charge until it is updated or retired.
  - The budget re-arms when that machine's state changes or after 24 hours.
- **Executing an effect** still requires the executor to hold the current lease epoch at execution time. That is the umbrella's existing rule for Sensitive and Serious effects (line 233, built with those effects in piece 4). 2d only decides who may take the lease.

### 2b. Work and authority, by direction

- **A table in code, `MESH_VERB_FENCE_CLASS`,** typed `Record<MeshCommand['type'], { cls, why }>`. The compiler refuses a verb with no row. The full table, one reason per row, is in `src/core/meshVerbFenceClass.ts` and is the review artefact.
- **To a below machine:** no `work` or `authority` verb is sent. That covers new placement, transfer, drain, credentials, slices and mandates.
- **The exception is `conversation`:** `deliverMessage` and `a2a-topic-reply-inject` for a topic it already owns. They are still sent (§2c).
  - "Already owns" is checked at send time: the ownership record must name that machine as the active owner at the current epoch. A `deliverMessage` from new placement (`spawnOnMachine`) fails this check and is not sent, so the placement filter is not the only guard.
- **A refused agent-to-agent message** (`a2a-inbox-deliver`, `a2a-relay-forward`) whose recipient session lives on a below machine goes back to the relay or the sender as undelivered. It never counts as a reason to fail over.
- **From a below machine:** `authority` verbs are refused, including `claim`, `telegram-origin` submits and `commitment-mutate`. Its `work` is accepted: work it routes to updated machines gives it nothing, and refusing it would make updated owners look dead to its old router.
- **`liveness` and `read` verbs** flow both ways.
- **Remote input** to a session on it is refused on the updated machine serving the dashboard. Viewing stays allowed.
- **Ownership arriving in the journal.** Ownership claims also cross between machines as signed journal entries in `journal-sync`, a `read` verb. When read in, an ownership entry written by a below machine is dropped, so a session it starts on its own can't pull a topic to it.

### 2c. Its existing conversations

- **Conversations it already owns keep running on it.** The updated router still delivers messages for them (`conversation` class, §2b). After a takeover the old machine no longer polls, so a refusal there would read as an unreachable owner and trigger failover, local handling or a force-claim: the double replies this avoids. A fence refusal never counts toward marking an owner suspect. Holding or moving these conversations gains nothing:
  - holding needs a sole-custody store, which the multi-machine rule forbids;
  - moving needs proof that its old session stopped posting, which a missed heartbeat can't give.
- **The agent-wide hold (§1) removes the risk that matters:** no Sensitive or Serious action runs on any updated machine.
- **The notice tells the owner** those conversations run on an older version until the machine is updated or retired.

## Decision points touched

- **An agent-wide hold of Sensitive and Serious actions while any machine is below** — invariant; basis: irreversible-consequence; evidence: constitution check and Astra round 1 (one shared decision instead of chasing every path).
- **Lease takeover from a below holder, three per 24 hours** — judgment-candidate; floor: the takeover count settles; the hold covers privileged effects; arbiter: Echo.
- **No work or authority verb to a below machine, no authority from it, by an exhaustive table** — invariant; basis: external-constraint; evidence: umbrella line 360 ("proxying").
- **Its existing conversations continue on it, unmoved** — invariant; basis: irreversible-consequence; evidence: moving a live old session's topics doubles replies; holding needs sole custody.
- **Unconfirmed is never treated as below** — invariant; basis: irreversible-consequence; evidence: 2c review rounds 1 and 2.

## Multi-machine posture

Each updated machine applies these rules from its own first-hand signed observations. The hold is computed on every updated machine. The lease holder keeps the one notice current, and keeps the takeover budget in the 2c ledger so it survives lease moves.

## Verify the state, not its symbol

| Detector | Symbol | State | Corroboration | Unmeasurable |
| --- | --- | --- | --- | --- |
| A machine is below | its signed build statement | it runs a build without the identity rules | sticky until a newer signed statement; an unconfirmed machine is never treated as below | a compromised machine lying about its build (the residual) |

## Rollout

| Stage | What happens | Fallback |
| --- | --- | --- |
| test-agent-live | Unit tests with a stub enrolled record and a stub below peer exercise each refusal both ways. | revert |
| dev-agent-live | No visible change (nothing is enrolled). | revert |
| fleet | Ships with nothing refused until piece 3. | revert |

## Tests and evidence

- **Unit:**
  - the agent-wide hold appearing and lifting (an update, a retirement);
  - `canAcquire` with `belowFenceHolders`;
  - the takeover budget (three, then stop, re-armed);
  - a below captain and handback;
  - the verb table's exhaustiveness and its enforcement by direction at the client and the dispatcher;
  - signed advert versions marking a machine below, never confirming it;
  - remote-input refusal;
  - the single notice updated in place and closed;
  - all of it off with no fence.
- **Dispatcher:** the real `MeshRpcDispatcher` with signed envelopes (in `tests/unit/MeshRpc.test.ts`) refuses an authority verb from a below peer after a valid signature, and still lets its work through.
- **E2E lifecycle:** the guards in pulls, and the gate holding through the production wiring.
- **E2E lifecycle:** the guards appear in pulls.

## Maturation plan

- **ladder:** not applicable: it ships with nothing reachable until piece 3 enrols an owner. Its live graduation is part of piece 3's live proof.
- **test-agent-live:** a throwaway pair at Phone, one on an older build, with every refusal and the hold recorded live (piece 3's proof, which this piece's code must pass).
- **dev-agent-live:** the same check on Echo's own machines once Echo enrols.
- **fleet:** with the release that makes Phone-level enrolment available.
- **graduation criterion:** piece 3's live proof shows the hold, the takeover budget and every refusal on a mixed-version pair.
- **dark-window:** none.

## Open questions

None yet.

## Left behind

- Piece 3's enrolment, which checks the guards.

## Review history

- **Round 1 (4 design, 3 precision), applied:**
  1. The lease brake is 2d's own: always live, widening backoff, never stopping. The churn breaker is dev-gated and dry-run.
  2. No topic moves: held messages and an owner notice; claims from a below machine refused; drain dropped (and with it the drain-order precision note).
  3. Signed heartbeat and advert versions classify a pre-2b build.
  4. Every mesh verb is classified, credentials and acting-for paths included, in an exhaustive table enforced at both ends with a ratchet test.
  - Precision: a below router's work and authority verbs are refused; remote input is blocked on the updated side.
- **Round 2 (2 design, 1 precision), applied:**
  - A dedicated fence hold (bounded, no expiry, no retry, never moves a topic; overflow gets a Never-Silent notice), instead of the general inbound queue, which is off by default and force-moves topics.
  - Direction matters: work from a below machine is accepted (it gains nothing); only work to it and authority from it are refused, so updated owners never look dead to its old router.
  - Version evidence comes only from signed mesh requests, and can mark a machine below but never confirm it; the unsigned heartbeat file is not used.
- **Round 3 (1 design, 2 precision), applied:** the fence hold's custody follows the lease (a signed handover from the previous lease holder; the new router keeps topic order meanwhile); a held message is written and synced before acknowledgement; a below machine presumed dead fails over normally and its held messages drain there.
- **Round 4: converged.** Precision applied: a handover is accepted from any former lease holder at a lower epoch; only entries a handover has named stall a topic, and late ones are delivered marked out of order.
- **Constitution check and GPT-6.2 Astra (8 standards, 7 findings): redesigned around one agent-wide decision.**
  - While any machine is below, Sensitive and Serious actions are held everywhere: Capacity Safety and the Astra "shared fence decision".
  - The takeover loop became a budget of three per day that settles: No Unbounded Loops.
  - The custom message hold and its custody handover are removed: the multi-machine rule, Verify the State.
  - Existing conversations continue on the old machine, unmoved.
  - One notice, updated in place and closed when resolved: Bounded Notification Surface, The Agent Carries the Loop.
  - Execution still needs the current epoch (umbrella line 233, piece 4).
  - Live graduation comes with piece 3's proof (Maturation Path).
  - The full verb table is in code (Astra finding 4).
  - Astra's findings 8 to 10 re-reviewed piece 1, which is already built.
- **Round 5 (3 design, 1 precision), applied:**
  - Retiring a below machine is exempt from its own hold, with the owner's approval at the active level.
  - `conversation`-class delivery to it continues for topics it owns, and a fence refusal never marks an owner suspect.
  - Ownership entries it writes into the journal are dropped on read.
  - The takeover budget is per updated machine.
- **Round 6: converged.** Precision applied: "already owns" is checked against the ownership record at send time; a refused agent-to-agent message is returned undelivered, never a failover reason.
- **Build note:** coherence adverts ride an unsigned reply, so they are not evidence. A machine that is alive but makes no signed statement for 24 hours triggers the hold as uncertainty (`machine-unconfirmed`) and is never called below. This closes the pre-2b gap without unsigned evidence.
