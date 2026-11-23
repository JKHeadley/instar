---
title: "The minimum-build fence: machines too old to follow the identity rules are waited for, then refused"
slug: identity-security-piece2c-minimum-build-fence
author: Echo
tier: 2
status: approved
eli16-overview: identity-security-piece2c-minimum-build-fence.eli16.md
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
sibling-principles: "An Instar Agent Is Always a Multi-Machine Entity; Bounded Blast Radius; Verify the State, Not Its Symbol"
parent-spec: "identity-security-levels.md (approved 2026-11-17 19:34 PST, Justin, topic 144636), line 360 (older machines) and line 456 (minimum-build fence); piece 2b §7"
depends-on: "identity-security-piece2b-owner-record-store"
lessons-engaged: "a-dark-guard-is-worse-than-no-guard, verify-the-state-not-its-symbol, cut-the-sequence-not-just-the-scope"
review-convergence: "2026-11-18T17:12:00Z"
review-iterations: 6
review-completed-at: "2026-11-18T17:12:00Z"
review-report: "reports/identity-security-piece2c-minimum-build-fence-convergence.md"
cross-model-review: "codex-cli gpt-6.2-astra (headley.justin) round 1"
approved: true
approved-by: "Under the approved umbrella identity-security-levels.md (Justin, topic 144636, 2026-11-17 19:34 PST: \"great! approved, please enter a 24 hour autonomous session in gpt 6.2 astra to build this\"), line 360, and Justin's standing guidance that only constitution changes need his approval (2026-10-22). No constitution text changes here. Lease and routing refusal is built as piece 2d (its spec is approved alongside), and Phone-level enrolment waits for it, so the umbrella's line 360 is met in full before it matters."
---
# The minimum-build fence: machines too old to follow the identity rules are waited for, then refused

## Problem statement

The umbrella (line 360) says: "the record carries a minimum build. Updated machines refuse leases, proxying and the record to a machine below it, and enrolment at Phone or above waits until every registered machine is at the build or retired."

A machine on an older build doesn't read the owner record, so it applies today's rules. Before enrolment that is harmless: today's rules are Basic, and every machine is at Basic. After the owner enrols at Phone or above, an older build could act on rules the owner has left behind. 2c does three things:
- it keeps machines from **becoming** below the fence after enrolment: enrolment waits for every machine; a join on an older build is refused; a downgrade below the fence is refused;
- it shares the owner record only with machines confirmed to follow it (refusing others the lease and routing is piece 2d, §4);
- it **tells** the owner which machine to update or retire.

**What it can't do.** A machine that is below the fence anyway (an older build installed by hand, outside Instar's updater) still acts on its own direct inbound: its dashboard, its tunnel, its scheduler, its own Telegram polling. The fence can't reach code that doesn't contain it. The other machines withhold the owner record from it (and, once piece 2d ships, the lease and routing), and the owner is told plainly to update or retire it. This is the same class of residual as a machine its operator controls directly, below Locked box.

## Proposed design

2c supports consistent enforcement of the owner's decisions across machines. It is not itself identity: a signed build statement identifies the registered machine making the claim. It is no human approval, and it can't attest what a compromised machine really runs (that machine is the residual above).

### 1. The floor: per level, in code, raised only by the owner

- **A floor table in code**, `IDENTITY_LEVEL_MIN_BUILD`: for each level, the earliest release whose tests prove it enforces that level's rules. Each piece that adds rules for a level updates its row in the same change, with the test that proves it. Basic's row is empty: no fence at Basic.
- **`minimumBuild` in the record** is an ordinary policy, read exactly as 2a evaluates it. Piece 3 writes it at enrolment as the table's floor for the level being enrolled. The owner may set it higher, never below the table's floor for the active level. Going lower means lowering the level first, which is an approved level change.
- **The fence in force** is the record's value, or the last verified fence. The table never raises it by itself: when a newer build carries a higher floor for the active level, `GET /owner-record` reports that a raise is due, and piece 3 offers it to the owner once `fenceStatus(target)` holds. So a rolling update never moves the fence on some machines and not others.
- **The table validates writes.** A write below the active level's floor is refused.
- **A bad value never relaxes the fence.** A value `versionAtLeast()` can't parse is ignored (a parseable value below a newer build's floor stays in force, and a raise is reported as due): this machine keeps the last verified fence (saved in `state/owner-record/fence.json`) and reports a degradation once. An enrolled machine with no usable fence at all holds Sensitive and Serious actions (gate reason `fence-unusable`), while status and repair keep working.

### 2. Evidence of each peer's build, kept apart from the access decision

- **Each pull carries the peer's statement.** 2b's `owner-record-pull` command gains `build` and `guards`, inside the signed, replay-protected mesh envelope:
  - `build` is its release;
  - `guards` lists the identity enforcement this build runs live, for example `fence-lease` and `fence-routing` from piece 2d.

  The pull reply carries the same for the replier, recorded before the reply is judged.
- **Saved per registration.** Observations are saved in `state/owner-record/peer-builds.json`, keyed by machine id and signing-key fingerprint. An observation older (by its envelope time) than the one saved never overwrites it. So a delayed report from an earlier registration can't clear a newer verdict, and a re-paired machine starts fresh.
- **Four states per peer:**
  - **confirmed:** a statement at or above the fence, observed within the last 24 hours. Peers pull every 15 minutes, and a silent peer's retries back off to at most 6 hours, so 24 hours is four full backoff cycles: a peer that is up has spoken many times by then.
  - **below:** a statement under the fence, or a pull with no `build` (a 2b-only build). It stays below until a newer statement at or above the fence arrives.
  - **unconfirmed:** a statement older than 24 hours, or nothing since this machine's records began. This is missing evidence, not a verdict.
  - **retired:** removed from the registry. It doesn't count.
- **Recorded before judged.** A pull's statement is saved before the sender is judged, so a just-updated peer qualifies in that same exchange.

### 3. Readiness: one view, on the lease holder

- **The lease holder computes readiness from its own first-hand observations.** Every peer pulls the lease holder every 15 minutes, so it holds a signed statement from each one, with no second-hand reports. A new lease holder starts from its own saved observations and is complete within one pull cycle. Until then it reports `ready: false`.
- **`fenceStatus(target)`** (on the lease holder) returns `{ target, confirmed, below, unconfirmed, ready }` over every registered machine. `ready` means every registered machine is confirmed at or above `target`.
- **Piece 3 checks it twice:** when it offers enrolment, and again at commit on the lease holder. Joins, downgrades, retirements and the policy write are serialized there, so a join, downgrade, retirement or lease move between offer and commit makes the commit fail cleanly. Retiring a machine follows the umbrella's Serious procedure, credential withdrawal included. These requirements are written into piece 3.
- **Phone-level activation checks live guards, not a release number.** Piece 3 activates Phone or above only when every registered machine is confirmed and reports the guards that level requires in `guards`, 2d's lease and routing refusal among them. A mixed fleet with any guard dark stays at its prior level, and ordinary access continues.
- **`GET /owner-record`** gains a `fence` section: the fence in force and its source, each peer's state, and `fenceStatus` against this machine's build.

### 4. After enrolment

These apply only when the record is enrolled at a level with a floor.

- **No join below the fence.** The machine join handshake, serialized on the lease holder, refuses a joiner whose advertised build is below the fence, naming the build needed. This follows the existing version check on machine adverts (`MachineIdentityActivationGate`).
- **No downgrade below the fence.** The updater refuses to install a version below the fence and says why. An automatic rollback that the fence refuses sends one notice and is not retried in a loop.
- **The record goes only to confirmed peers.** While enrolled, owner-record data is sent to, and accepted from, confirmed peers only: pushes, pull replies, the first exchange included.
  - A below or unconfirmed peer's pull is answered `build-not-confirmed` with no entries. Its statement in that same pull is recorded first, so an updated peer qualifies at once.
  - Liveness, lease and every other traffic keep flowing, so no machine is made to look dead.
- **One aggregated notice, from the lease holder.** When machines are below, or unconfirmed for more than 24 hours, after enrolment, the lease holder sends one notice listing them:
  - below: "update or retire";
  - unconfirmed: "hasn't confirmed its version: check it's running".

  The notice is raised once per distinct list and never repeated while the list is unchanged. The time of the last notice is saved with the observations, so a lease move adds at most one repeat. Other machines record and report but don't notify.

**How a machine can still be below after enrolment.** Enrolment waits for every machine, and joins and downgrades are refused. That leaves a hand-installed older build, outside Instar's updater. Switching Node versions can start a different global instar, so this is not rare. Such a machine applies today's rules to its own direct inbound. Refusing it the lease and routing is **piece 2d**. It needs its own design, because cutting a machine off at the network level makes it look dead and invites a lease fight, and the dark-owner path that would move its work still runs in dry-run.

**Phone-level enrolment waits for 2d as well as 2c,** through the live-guard check in §3.

### 5. What it changes today

- **No refusal runs:** no record is enrolled until piece 3, and §4 applies only after enrolment.
- **What 2c adds now:**
  - the floor table (Basic's row empty);
  - `build` and `guards` on pulls and pull replies (an older build ignores unknown fields, which the review checked);
  - the saved observations;
  - the `fence` report.
- **Tests** cover §4 both ways: off at Basic, on after enrolment.

## Decision points touched

- **Who gets the owner record while enrolled:** confirmed peers only — invariant; basis: irreversible-consequence; evidence: umbrella line 360; Astra finding 1.
- **The floor per level and the owner's raise** — invariant; basis: external-constraint; evidence: umbrella line 360; Astra finding 2.
- **Join and downgrade refusal** — invariant; basis: irreversible-consequence; evidence: umbrella line 360.
- **Readiness on the lease holder, rechecked at commit** — invariant; basis: external-constraint; evidence: umbrella line 233; Astra finding 3.
- **The 24-hour confirmation window** — judgment-candidate; floor: four full backoff cycles of a pulling peer; arbiter: Echo.

## Multi-machine posture

Every machine records its own first-hand observations and applies §4 with them: while enrolled, it shares the record only with peers it has confirmed itself. Readiness and notices come from the lease holder alone.

## Verify the state, not its symbol

| Detector | Symbol | State | Corroboration | Unmeasurable |
| --- | --- | --- | --- | --- |
| A peer's build | its signed statement | the release it runs | fresh within 24 hours, per registration, never overwritten by an older one | a compromised machine lying about its build (the residual) |
| A guard is live | the `guards` list | the enforcement it runs | piece 3 checks every machine before activating Phone | the same |

## Rollout

| Stage | What happens | Fallback |
| --- | --- | --- |
| test-agent-live | A throwaway pair reports builds; a stub enrolled record exercises refusals both ways. | revert |
| dev-agent-live | Echo's machines report their builds and readiness in `GET /owner-record`. | revert |
| fleet | Ships with nothing refused until piece 3 enrols someone. | revert |

## Tests and evidence

- **Unit:**
  - the four peer states and their transitions;
  - per-registration observations surviving a restart, and never overwritten by an older one;
  - `fenceStatus` with a target;
  - the floor table and the owner's raise;
  - a bad value keeping the last fence, or holding;
  - join and downgrade refusal;
  - the record going to confirmed peers only;
  - one aggregated notice.
- **Integration:** the `fence` section of `GET /owner-record`.
- **E2E lifecycle:** the pull carries build and guards through the production wiring.

## Maturation plan

- **ladder:** not applicable: ships on with no staged switch (it grants nothing until piece 3 reads the gate); the stages below are evidence steps.
- **test-agent-live:** the throwaway pair, with a stub enrolled record.
- **dev-agent-live:** Echo's machines report builds and readiness.
- **fleet:** with the release; it refuses nothing before enrolment.
- **graduation criterion:** every machine of a multi-machine agent is confirmed in the fence report within one pull cycle of an update.
- **dark-window:** none.

## Open questions

None.

## Left behind

- Piece 3's enrolment itself (it calls `fenceStatus()` and writes a valid `minimumBuild`).
- **Piece 2d:** refusing a below machine the lease and routing, without making it look dead, and moving its owned work once the dark-owner path runs live. Tracked in the build plan. Phone-level enrolment (piece 3) waits for it.
- Retiring a machine (existing machine removal).

## Review history

- **Round 1 (6 design, 1 precision), applied:**
  1. Peer builds are saved and also carried in pull replies; three states, and "unknown" never refuses.
  2. Readiness is checked against the value about to be written, for every raise.
  3. No writes at Basic; the fence is 2a's policy, and the owner can raise or lower it.
  4. Joins and downgrades below the fence are refused, and the residual is stated honestly.
  5. Refusal happens at two choke points (the mesh in both directions, and peer addresses); the dark-owner path moves owned work.
  6. A separate `belowFenceHolders` acquire input; a below captain doesn't block; takeovers are counted in the churn breaker.
- **Round 2 (5 design, 1 precision), applied by cutting the sequence:**
  - Lease and routing refusal move to piece 2d: findings 8, 9 and 10 showed that network-level refusal invites a lease fight and strands work while the dark-owner path is dry-run.
  - 2c keeps readiness, join and downgrade refusal, and keeping the record from a below machine, with all other traffic flowing.
  - "Below" is sticky, and an alive machine silent for 24 hours after enrolment counts as below (finding 11).
  - A fence value that can't be parsed means no fence plus a degradation report (finding 12).
  - Readiness counts every registered machine (precision).
- **Round 3 (1 design, 4 precision), applied:**
  - Phone-level enrolment in piece 3 waits for 2d as well as 2c (written into piece 3).
  - Stale wording fixed.
  - A pull's build is recorded before the sender is judged.
  - A refused automatic rollback sends one notice and is not retried.
- **Constitution check and GPT-6.2 Astra (5 design findings applied to 2c; its other findings re-reviewed piece 1, already built and reviewed):**
  1. Evidence is kept apart from the access decision. While enrolled, only confirmed peers get the record. Silence makes a peer unconfirmed, never below (this also resolves the constitution's "Verify the State, Not Its Symbol" finding).
  2. A per-level floor table in code; the owner may only raise above it; a bad value keeps the last verified fence or holds, never relaxes ("Judgment Within Floors").
  3. Readiness is computed on the lease holder and rechecked at commit; changes there are serialized.
  4. Phone activation checks every machine's live `guards`, not a release number.
  5. One merged view on the lease holder, and one aggregated notice.
  - Precision: 2c is described as consistent enforcement of the owner's decisions, not identity (the parent fit), and the plain-language summary is expanded.
- **Round 5 (1 design, 4 precision), applied:**
  - The fence in force is the record's value or the last verified one; the code table only validates writes and reports a due raise, so a rolling update never moves it on some machines only.
  - Pull replies are recorded before they are judged.
  - Readiness uses the lease holder's own first-hand observations, with no relaying.
  - The notice time survives a lease move.
  - The multi-machine wording is fixed.
