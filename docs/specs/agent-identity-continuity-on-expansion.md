---
title: "Agent Identity Continuity on Expansion — one agent keeps one identity when it gains a machine"
slug: "agent-identity-continuity-on-expansion"
author: "echo"
status: "draft"
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
sibling-principles: "Verify the State, Not Its Symbol; No Silent Degradation; Know Your Principal — An Unverified Identity Is a Guess"
parent-spec: "docs/specs/threadline-duplicate-identity-resolution.md"
project: "multi-machine-coherence"
depends-on: "joinMesh (src/commands/machine.ts) — the expansion path; POST /api/pair (src/server/machineRoutes.ts) — the authenticated pairing exchange that already carries the joiner's encryption key; IdentityManager (src/threadline/client/IdentityManager.ts) — getOrCreate() is the minting site; CanonicalIdentityManager (src/identity/IdentityManager.ts) — holds the encrypted-at-rest identity and the unused recovery-phrase facility; ThreadlineBootstrap (src/threadline/ThreadlineBootstrap.ts) — already uses .get() not .getOrCreate(), deliberately"
review-convergence: "2026-08-20T01:41:25.960Z"
review-iterations: 7
review-completed-at: "2026-08-20T01:41:25.960Z"
review-report: "docs/specs/reports/agent-identity-continuity-on-expansion-convergence.md"
approved: true
approved-basis: "Justin (verified operator, topic 48000) replied 'approved' on 2026-08-19 after being sent the plain-English overview and the convergence report, including the post-tag amendment note and the three things deliberately left unfixed (the existing split needs an operator decision; stale relay rows are not cleaned up; every machine holds the same key)."
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 6
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Agent Identity Continuity on Expansion

## Problem

An agent that expands onto a new machine silently becomes **two agents with one name**.

Observed live (2026-08-19). The operator authorised echo's Mac Mini to extend echo onto a
Mac Studio, and ran the command the Mini produced. The expansion succeeded in every visible
respect — the Studio is a registered mesh member, holds the serving lease, and answers. But
it publishes routing fingerprint `ae6feac6…`, while the Mini and Laptop both publish
`63b1dbb2…`. The canonical value appears 57 times across echo's durable state, including the
provenance rule that stamps messages sent through the operator's account as agent-authored;
`ae6feac6…` appears only in files the Studio wrote about itself.

Nothing reported this. It surfaced four days later, while investigating an unrelated request.

### Why it happens (root cause, confirmed in code)

`joinMesh` (`src/commands/machine.ts:363`) provisions:

1. a clone of the mesh repo,
2. a machine-local `config.json` — deliberately scaffolded fresh, because it holds
   per-machine secrets (auth token, dashboard PIN),
3. a **machine** identity via `MachineIdentityManager.generateIdentity()` — machine id,
   signing key, encryption key,
4. a `POST /api/pair` exchange that registers the joiner and returns the awake machine's
   machine identity.

None of those is the **agent** identity. It is not in the cloned repo (gitignored — it holds
a private key), not in the scaffolded config, not in the pairing response, and not in the
cross-machine secret-sync key set.

So on first server boot the agent looks for an identity, finds none, and
`IdentityManager.getOrCreate()` (`src/threadline/client/IdentityManager.ts:49`) mints a fresh
keypair.

**The design error in one sentence: the agent's identity is treated as a per-machine secret,
when it is a shared-agent secret.** Machine keys are correctly per-machine — the agent is not.

### Why it is worse than a cosmetic mismatch

- **Messages disappear.** A stale registration survives on the relay keyed by public key, and
  the sender-side resolver cannot always tell the live row from the dead one. This is the
  exact July failure recorded in `threadline-duplicate-identity-resolution.md`: *"his replies
  aren't reaching me… there are two 'echo' identities on the relay, one of which silently
  drops."* That spec fixed the resolver and one orphan (`64cab8bc…`). It did not close the
  source. `ae6feac6…` is the next one.
- **Provenance breaks.** Anything signed on the diverged machine carries a fingerprint that
  does not match the agent's pinned signing identity, so it does not verify as that agent.
- **The agent-signature feature is inoperative from the diverged machine — measured, not
  inferred.** The operator asked whether the feature that stamps Telegram messages as
  agent-authored rather than operator-typed was affected. It reads the same identity, so a
  controlled test was run: a PLAIN-TEXT message signed on the Studio, verified on all three
  machines.

  | Verifier | Verdict |
  |---|---|
  | Studio (the signer) | `agent-verified` |
  | Laptop | `rejected` — `bad-signature` |
  | Mini | `rejected` — `bad-signature` |

  Plain text was used deliberately, because a known separate limitation rejects signed
  *markdown* (the Telegram send path rewrites the bytes the signature covers) and would have
  confounded the result. It did not apply here, and the message was still rejected on both
  peers. The verifiers resolve `echo` to `63b1dbb2…` while the Studio signs as `ae6feac6…`.

  The failure direction is safe — a Studio-signed message is `rejected`, not silently accepted
  as operator-typed — but the guarantee the feature exists to provide is simply absent from
  that machine. This is the sharpest available demonstration that the split is not cosmetic.

- **It is silent.** No guard compares the identity a machine publishes against its peers'.
  Every additional machine compounds it.

### The half-built mechanism

`CanonicalIdentityManager.create()` can emit a 24-word recovery phrase and stores a recovery
commitment. Nothing consumes it: there is no restore path and no CLI surface. The facility
that would let one identity be reconstituted elsewhere exists, is never used, and therefore
protects nothing today.

## Decision points touched

> *Local terms: an **invariant** decision point has an enumerable answer space and is
> deterministic by design; a **judgment-candidate** is one where several live signals can
> genuinely conflict, which requires a declared floor plus an arbiter.*

| Decision point | Classification | Justification |
|---|---|---|
| Whether a machine may MINT an agent identity | **invariant** | Two enumerable states with an objective discriminator: a machine that has joined an existing mesh must never mint; a genuinely standalone first machine must. The discriminator is the presence of mesh-join state on disk, not a heuristic. |
| Whether to accept an agent identity received during pairing | **invariant** | Accept only when it arrives sealed to this machine's own encryption key, in the response to a single-use pairing code this machine just presented. Anything else is refused. No weighing. |
| Whether a machine's published identity diverges from its peers' | **invariant** | A string comparison against peers reporting the same agent name. Enumerable: agree / disagree / cannot-tell (peer unreachable). `cannot-tell` never PAGES but is always REPORTED — absence of evidence must never render as agreement. |

> None of these is a judgment-candidate. Each is a deterministic function of bounded inputs,
> and no floor or arbiter is declared because there is nothing to arbitrate.

## Multi-machine posture

> *Local terms: a **unified** surface behaves identically on every machine; a
> **machine-local** surface is genuinely per-machine and must not be replicated.*

**Posture: `unified` — and that is the entire point of this spec.** The agent identity is the
canonical example of state that must be identical on every machine of one agent; the current
behaviour (per-machine) is the defect.

The **machine** identity stays `machine-local`.
`machine-local-justification: hardware-bound-resource` — the machine id, signing key and
encryption key identify one physical host to the mesh, are used to verify that host's own
signatures, and are meaningless on another. Replicating them would make two hosts
indistinguishable to the lease layer.

- **User-facing notices:** the divergence guard emits one. It is per-agent, not per-machine —
  a split is one condition about one agent, so exactly one machine raises it (the lease
  holder), deduped per (agent, observed-fingerprint-set) episode. This is the opposite of the
  process-ceiling case, where each machine needed its own action.
- **Durable state on topic transfer:** none introduced. The identity is written once at join
  and read thereafter.
- **Generated URLs:** none.

## Frontloaded Decisions

1. **The agent identity travels on the existing pairing exchange.** `POST /api/pair` already
   receives `ephemeralPublicKey` (the joiner's X25519 encryption public key) and today
   validates it and uses it for nothing. The identity is sealed to that key and returned in
   the same response. No new endpoint and no new operator step — the single-use pairing code
   the operator carried between machines is already the out-of-band human verification.

   **But "no new trust relationship" would be false, and that matters** (round-6 finding). This
   changes what pairing IS: today a pairing code registers a machine, and a leaked one gets an
   attacker a registry row. After this change the same code provisions the agent's private
   identity, so a leaked code is a path to the agent's signing key. The consequence of
   compromise goes up by an order of magnitude even though the mechanism looks unchanged.

   So pairing is reclassified as **identity provisioning**, and carries the ceremony that
   warrants: a short expiry measured in minutes rather than hours, a hard cap on failed
   redemption attempts per session after which it is void, one-at-a-time sessions per agent,
   and an audit record for every mint, redemption, failure and expiry. The operator is told at
   mint time what the code now grants, in those words — the value of a secret must be legible
   to the person carrying it.

   **The envelope is bound to this exchange, not merely encrypted to a key** (round-1
   finding — encryption to the joiner prevents passive disclosure but does not by itself
   resist substitution or replay). The sealed payload carries a transcript: the pairing
   session id, the joiner's machine id, the joiner's encryption public key, the agent name,
   and an expiry. The whole envelope is signed with the awake machine's machine **signing**
   key — the key the joiner receives in the same response and pins as the awake machine's
   identity. The joiner verifies the signature, then checks every transcript field against
   what it actually sent and who it believes it is talking to, and refuses on any mismatch.

   **What authenticates the responder is the pairing code, not the signature** (round-2
   finding — worth stating because the signing key arrives in the same response, so on its own
   the signature proves the response is internally consistent, not that it came from the right
   machine). The operator carried a single-use code from the awake machine to the joiner
   out-of-band; possession of a code that machine minted is what identifies it. The signature
   then binds the envelope to that same responder and to this exchange's transcript, so the
   payload cannot be lifted from one exchange into another. Where the joiner already knows the
   awake machine's identity from the pairing challenge, it pins and checks against that too,
   rather than accepting whatever the response asserts.

   **What each layer actually closes** (round-3 correction — an earlier draft claimed
   substitution by a hostile responder "fails because the signature fails", which is false: an
   attacker who controls the response supplies its own signing key alongside it, and the
   signature verifies perfectly against the key it shipped with):

   - **Wrong-joiner envelope** — closed by the transcript: the machine id and encryption
     public key inside the envelope must equal what THIS joiner sent, and it cannot decrypt an
     envelope sealed to anyone else's key.
   - **Replayed earlier envelope** — closed by the session id and expiry.
   - **Hostile responder substituting itself** — closed ONLY by the pairing code binding, not
     by the signature. The code was minted by the intended awake machine and carried
     out-of-band by the operator; the response must be bound to that server-side session, and
     the joiner verifies the returned identity against the session it presented the code to.
     A responder that cannot produce a response bound to that session is rejected regardless
     of what it signs.

2. **Fail closed, loudly.** A machine that has joined a mesh and cannot obtain the agent
   identity does NOT mint one and does NOT register on the relay under the agent's name. It
   reports the failure and stops. A silent twin is worse than a machine that plainly says it
   could not join properly.
3. **Never mint on a joined machine — enforced at the minting site**, not at the call sites.
   `getOrCreate()` is the single chokepoint; guarding the callers would leave the next caller
   free to reintroduce it.
4. **Already-diverged machines are reconciled, not left.** A migration detects the split and
   repairs it through the same sealed path. It does not delete anything: the superseded
   identity is retained on disk so the change is reversible.
5. **The orphan relay registration is a NAMED DEPENDENCY, not something this spec can
   quietly claim.** Repairing the local file leaves the stale row registered on the relay.
   Round 2 asked how such a row is retired and by what authority, and the honest answer is
   that this spec cannot specify it: retirement is a relay-side operation with its own
   authorization model (who may retire a registration, and how the relay knows the requester
   owns it), and that design does not exist yet.

   What IS true today, and is why local repair is still worth shipping alone: the July fix
   made the sender-side resolver prefer the LIVE registration, so an orphan row is far less
   able to absorb messages than it was during the original incident. That mitigates; it does
   not remove. Until relay-side retirement exists, a repaired agent still has a dead row
   bearing its name on the relay, and this spec says so rather than implying the split is
   fully cleaned up.
   <!-- tracked: CMT-026 -->
6. **The recovery phrase stays unused by this change.** It is a real facility and a plausible
   second route, but building a restore path is a separate design with its own threat model
   (a phrase is a bearer credential for the whole identity). This spec uses the channel that
   already exists and is already authenticated.
   <!-- tracked: CMT-026 -->

## Non-goals — and one architectural boundary

This change preserves the current meaning of a routing fingerprint. It is NOT a licence to
build further on shared-key assumptions (round-5 finding — a spec that normalises a pattern
invites the next feature to depend on it).

**The boundary: new capabilities must prefer an account identity plus per-device keys, not the
shared agent private key this change propagates.** Every additional dependency on "any machine
of this agent can sign as the agent" widens the blast radius of a single compromised host and
raises the cost of the migration that eventually fixes it. This spec exists solely to stop an
agent silently becoming several agents; it is a bridge, and it should not be cited as a
precedent.

Also out of scope, deliberately and named rather than implied: relay-side retirement of stale
registrations (Frontloaded Decision 5), and any restore-from-recovery-phrase path
(Frontloaded Decision 6).

## Open questions

*(none)*

## Proposal

### 1. Carry the identity on join

The joiner already sends its encryption public key. The awake machine seals the agent
identity to it and returns it alongside the machine identity it already returns. The joiner
decrypts and writes it to the canonical path **before the server first boots**, so the boot
finds an identity and never reaches the minting branch.

Refusals are explicit and typed: an invalid or burnt pairing code, a malformed or absent
encryption key, or an awake machine too old to carry the payload each produce a named failure
rather than a partial join.

#### The pairing session contract (round-4 finding — "bound to the session" needs to be an invariant, not a phrase)

`instar pair` mints a session and stores, server-side: a session id, the pairing code, the
minting (awake) machine's id, an expiry, a consumed flag, and — once first redeemed — the
redeeming joiner's machine id and encryption public key.

`POST /api/pair` accepts a request only when the code resolves to a session that is unexpired
and either unredeemed, or already redeemed BY THIS SAME joiner (matching machine id AND
encryption public key). It then returns the identity envelope sealed to that joiner's key,
with the transcript naming the session id, the joiner's machine id and key, the agent name,
and the expiry. Any other combination is refused with a named reason and provisions nothing.

The joiner accepts an envelope only when it verifies against the session it presented the code
to and every transcript field matches what it sent.

**What the joiner knows BEFORE it posts, and why a hostile listener cannot exploit it**
(round-5 finding — the joiner has a URL and a code, and nothing so far authenticated the URL).
A machine that posts a valid code to the wrong listener learns nothing about the agent, because
that listener does not hold the identity. The real risk is the reverse: the listener returns a
FABRICATED identity and the joiner adopts it.

So the pairing artefact the operator carries includes the agent's **fingerprint** alongside the
code. A fingerprint is public by construction — it is what the agent already advertises — so
carrying it costs nothing and discloses nothing. The joiner pins it before posting and refuses
any envelope whose identity does not hash to it. A hostile listener cannot produce a keypair
matching a fingerprint it does not hold the private key for, so the worst it achieves is
learning a code that is useless without the identity, and a join that fails loudly.

This also gives the operator a visible cross-check: the value shown on the awake machine is the
one the agent publishes, and it is the same value the divergence detector compares.

#### Version skew, both directions (round-4 finding)

- **New joiner, old awake machine** — the response carries no identity envelope. The joiner
  refuses to mint, reports "this machine's mesh cannot yet provide an agent identity — update
  it and re-pair", and provisions nothing. Loud, and it names the machine to update.
- **Old joiner, new awake machine** — the awake machine still returns the envelope; the old
  joiner ignores the unknown field and mints as it always did. That is today's defect, not a
  new one, and the new awake machine's divergence detector will flag the split it produces.
  A new awake machine therefore records that it served an envelope to a joiner that did not
  acknowledge it, so the case is visible rather than inferred later.

#### Installing the key: atomic, restrictive, crash-safe (round-6 finding)

A half-written identity is worse than none — it is an agent that starts with a corrupt or
partial key.

The identity is written to a temporary file in the destination directory with owner-only
permissions, synced, then atomically renamed into place; the directory is synced after. A
repair writes the superseded identity to a timestamped backup beside it BEFORE the rename, so
no window exists in which neither the old nor the new file is recoverable.

Provisioning is ordered so that a crash at any point leaves a state that is either complete or
plainly incomplete, never silently wrong: identity written and verified readable → mesh
registration → server start. A crash after the identity lands but before registration leaves a
machine that has the right identity and is not yet registered — which the next join or boot
completes, and which the divergence detector reads as agreement rather than a split.

Permissions are checked on read as well as write: an identity file that is group- or
world-readable is refused with a named error rather than loaded, because a private key that
the rest of the machine can read has already failed its one job.

### 2. Refuse to mint on a joined machine

`getOrCreate()` gains one precondition: if this home has mesh-join state, minting is refused
and the caller receives an explicit "identity not provisioned" failure.

A genuinely standalone first machine is unaffected — it has no join state, so it mints as it
does today. This is what makes the guard safe to enforce rather than dark-ship: the two cases
are distinguished by an on-disk fact, not by a guess.

### 3. Reconcile the machines already split

A migration compares this machine's published identity against the peers reporting the same
agent name. On a confirmed divergence it repairs through the sealed path and retains the superseded
identity file. It does NOT retire the stale relay registration — see Frontloaded Decision 5;
that is relay-side work this spec deliberately does not claim.

**Which identity is canonical is decided by declared PROVENANCE, not by weighing evidence and
not by "who did I join".**

The first draft said "the machine this one joined". Round 2 broke that: in a chain — A joins
B, C joins a diverged B, B later repairs from A — C's parent held the wrong identity at the
time C asked, so following the immediate parent preserves the error.

So each identity records how it came to exist, and the record travels with it:

- `minted-standalone` — created on a machine with no mesh-join state. This is the ROOT, and
  it is the only legitimate way an agent identity is ever created.
- `received-on-join` — obtained through a pairing exchange, carrying the fingerprint of the
  root it descends from.

Canonical is then decidable **for identities carrying post-guard provenance**: the identity
whose lineage terminates in a `minted-standalone` root wins. Where any candidate lacks such a
record the rule does not apply at all and operator selection is required — see below; the
qualification is repeated there because an over-strong reading of "decidable" is precisely how
a repair path talks itself into guessing. A diverged machine's identity terminates in a mint that happened
ON a joined machine — the state §2 makes impossible going forward, and the exact signature of
this defect. It is identifiable as wrong without consulting any peer, and a chain repairs
correctly regardless of the order the repairs happen in, because every machine is comparing
against the same root rather than against its neighbour.

The record is **self-signed by the identity it describes at mint time** and travels inside the
sealed payload, so it cannot be attached to a different keypair in transit or rewritten by an
intermediary.

It is a small fixed shape stored beside the identity and backed up with it: a schema version,
the origin (`minted-standalone` | `received-on-join`), the root fingerprint, the minting or
receiving machine id, the creation timestamp, the instar version that produced it, and the
self-signature over those fields. The version field is what lets a mixed fleet be classified
rather than guessed at: an identity file with no record present is `unknown-origin`, and a
record whose schema version is newer than the reader understands is also treated as
`unknown-origin` rather than partially parsed — both route to operator selection.

**What that does and does not establish, stated plainly** (round-3 finding). A signature binds
the claim to the keypair; it does not make the claim true — a machine that mints while joined
could self-sign `minted-standalone` just as easily. What makes the claim trustworthy going
FORWARD is §2: minting on a machine with join state becomes impossible, so a
`minted-standalone` record can only be produced where it is accurate.

**And only for honest, current code** (round-6 finding). A compromised host or an older binary
can self-sign false provenance, and this spec itself keeps old joiners minting during skew. So
lineage is **operational evidence, not cryptographic authority** — good enough to order a set
of cooperating machines running current code, not a defence against a machine that lies. Any
candidate set containing an unsupported or unattested version falls back to operator selection,
exactly as an `unknown-origin` set does. Treating lineage as proof would be the same
over-trust this spec was written to correct.

**So the split that already exists cannot be resolved by lineage at all**, and this spec does
not pretend otherwise. Identities predating the record are `unknown-origin`; an
`unknown-origin` set — which is exactly today's situation on this agent — REFUSES and requires
an explicit operator decision naming the canonical fingerprint. That is one confirmation from
the person who authorised the expansion, on evidence that is already overwhelming, and it is
the honest alternative to inferring lineage that was never recorded.

**The operator-selection path is a defined protocol, not a conversation** (round-4 finding —
choosing wrong takes the agent off the network, so it cannot rest on prose).

**The operator chooses between DESCRIPTIONS, not between hex strings.** An earlier draft made
the operator return a full fingerprint, copied character for character; the conformance gate
rejected that against the Operator-Surface Quality standard, and it was right. A 32-character
hex string is not a decision object a person can weigh — asking someone to eyeball two of them
is how the wrong one gets picked, which is the exact harm the ceremony was meant to prevent.

So the agent renders each candidate in human terms: which machines publish it, since when, and
what it has been used for — "the identity your Mini and Laptop have both used since May" versus
"the one this Studio created for itself on Monday". The fingerprint appears as supporting
detail beneath each option, never as the thing being read. The operator picks an option.

The commitment step still cannot be a bare yes: before anything changes, the agent restates in
plain words which machine will be altered and what happens to the machine that is not chosen,
and the operator confirms THAT. The audit record keeps the full candidate set, the fingerprints,
the chosen value, the operator identity and the timestamp — the precision belongs in the record,
where it is checkable, not in the question. The decision is
written to an audit record with the candidate set, the chosen value, the operator identity and
the timestamp, and repair proceeds only for that value. Cancellation, a mismatched fingerprint,
or no answer leaves every machine exactly as it is — the split persists, which is the current
state and is recoverable, whereas a wrong repair may not be.

Deliberately NOT the authority, though each is suggestive: durable prevalence (this agent's
57-vs-5 file counts are evidence the split happened, not a rule — a long-running wrong
identity would accumulate the same weight), peer majority (two machines cloned from the same
mistake would outvote the correct one), and the lease holder (whoever happens to hold it may
be the diverged machine, which is the case here).

Repair REFUSES, reports, and changes nothing when: no reachable machine presents a
`minted-standalone` lineage, more than one distinct root is presented, every candidate is
`unknown-origin`, or the sealed exchange fails. Choosing wrong takes the agent off the network, so every uncertain
branch stops rather than guessing.

**Alternatives considered** (round-1 finding). *Cross-machine secret sync* — the sync set is
enrolled per machine and a machine cannot receive its enrolment before it has an identity, so
it is chicken-and-egg for exactly the case that matters; it remains a sensible carrier for
KEEPING identities aligned once established. *Recovery-phrase restore* — a real second route,
but a phrase is a bearer credential for the whole identity and needs its own threat model and
an operator ceremony; it is also unbuilt. *A signed identity record agreed across machines* —
solves a harder problem (consensus) than the one here, where one machine authoritatively has
the identity and one demonstrably lacks it. Pairing wins because the channel, the
authentication, and the operator's out-of-band step already exist and are already trusted for
provisioning this machine.

**This is device enrolment, and it is worth naming the pattern** (round-2 finding). The shape
is standard: an account identity is transferred to a new device over a channel authenticated
by a short human-carried code, with the payload bound to a handshake transcript. The two
industry alternatives were weighed. *Per-device certificates* — each device keeps its own key
and the account is a separate signed record they all present — is the better long-term shape,
and instar already has its machine layer sitting exactly there; adopting it for the AGENT
identity would mean changing what a routing fingerprint MEANS across every peer that has one
pinned, which is a migration of the whole network rather than of this agent. *A durable signed
identity record agreed across machines* solves consensus, which is not the problem here: one
machine authoritatively has the identity and one demonstrably lacks it. The transcript binding
in §1 is the Noise-style protection those patterns supply, applied to the channel that already
exists.

**This is explicitly a compatibility bridge, and it carries a real cost** (round-4 finding). A
shared agent private key means every machine of the agent can sign as the agent, so
compromising ONE host compromises the agent's identity everywhere, and there is no per-machine
revocation short of rotating the identity for the whole fleet. The per-device-certificate model
does not have that property. It is accepted here because the alternative is to change what a
routing fingerprint means for every peer holding one, and because the status quo — silently
minting a second identity per machine — is worse on every axis including this one. The
migration toward an account identity plus per-device keys is tracked, not implied.

**One operational consequence must be surfaced, not left to be discovered** (round-7 finding):
removing a machine from the mesh does NOT revoke its copy of the agent identity. That host can
still sign as the agent until the identity is rotated for the whole fleet. So machine removal
emits a plain notice saying exactly that, and naming rotation as the only actual revocation. A
capability whose limits are only visible to whoever reads the spec is a trap for whoever
doesn't.
<!-- tracked: CMT-026 -->

### 4. Notice the split at all

A boot-time comparison of the identity this machine publishes against its peers'. Signal
only — it raises one deduped operator notice and changes nothing. It exists because the live
incident went four days unreported, and because a repair path with no detector only fixes the
splits someone happens to notice.

**Every machine observes; the notice is deduped, not the observation** (round-1 finding). The
first draft had only the lease holder observe, which fails in the two cases that matter most:
the lease holder may BE the diverged machine (it is, in the live incident), and it may be the
isolated one. So each machine compares independently, and the single-notice property comes
from deduping on the (agent, observed-fingerprint-set) episode rather than from restricting
who is allowed to look.

**`cannot-tell` is visible even though it never pages.** An unreachable peer means the check
did not run, which is not the same as agreement — and a detector that renders those
identically is how a silent split survives. It pages on `disagree` only, but the diagnostic
surface reports agree / disagree / cannot-tell with the peer and the reason, so "quiet"
cannot be mistaken for "checked and fine".

### 5. Observability

Each of the four behaviours emits an auditable record, because a guard whose firing rate
cannot be read cannot be tuned or trusted:

- **Join**: whether the identity payload was carried, and on failure the named refusal
  reason. A rising "not carried" rate means an older awake machine is in the fleet.
- **Mint refusal**: every refusal, with whether join state was present. A non-zero count on a
  machine that should be standalone is itself the alarm.
- **Reconcile**: attempted / repaired / refused with the refusal reason, and the superseded
  fingerprint. The refusal-reason distribution is what says whether the repair path is usable
  in the field or merely correct on paper.
- **Divergence detection**: the agree / disagree / cannot-tell counts per peer. A `cannot-tell`
  rate that never falls means the detector is not actually checking anything.

No agent private key or sealed payload appears in any of these records — only fingerprints,
which are public by construction.

## Acceptance criteria

1. A machine joining an existing mesh ends up publishing the same routing fingerprint as the
   machine it joined — verified against the **live published value** on both, not against the
   file either one wrote.
2. `getOrCreate()` refuses to mint when mesh-join state is present, and still mints for a
   standalone first machine.
3. A join whose identity payload is missing, malformed, or undecryptable fails with a named
   error, provisions no identity, and leaves nothing registered under the agent's name.
4. The sealed payload is decryptable only by the holder of the joiner's encryption private
   key: a payload captured in transit and replayed by a third machine does not decrypt.
5. A burnt or expired pairing code yields no identity payload.
6. The reconcile migration repairs a divergent machine, retains the superseded identity, and
   is a no-op on a machine already in agreement.
6b. Canonical selection follows LINEAGE: an identity descending from a `minted-standalone`
   root wins; a chain (A→B, C→diverged-B, B repaired from A) converges on the root regardless
   of repair order; an all-`unknown-origin` set refuses and reports rather than picking.
6c. A join whose response is lost may be retried by the SAME joiner (matching machine id and
   encryption public key) until the session expires, receiving an envelope resealed to the same
   key; any other machine presenting that code is refused, and no redemption is possible after
   expiry. (This supersedes an earlier draft of this criterion, which said the code was burnt
   at response construction with no retry — that contradicted the pairing contract in §1 and
   was an availability failure on any unlucky network.)
7. The divergence detector reports agree / disagree / cannot-tell, raises on disagree only,
   and surfaces cannot-tell in diagnostics with the peer and reason.
7b. Operator selection: candidates are rendered as human descriptions (which machines, since
   when, used for what) with the fingerprint as supporting detail only; the operator picks an
   option rather than transcribing a hex string; a bare affirmative is refused — the
   confirmation is against a plain restatement of what will change on which machine; the
   decision is audited with the full candidate set, fingerprints, choice, operator and
   timestamp; and cancellation or mismatch changes nothing on any machine.
7c. Version skew: a new joiner against an old awake machine provisions nothing and names the
   machine to update; a new awake machine records serving an envelope that was not
   acknowledged.
8. No agent private key appears in any log line, error message, audit row, or HTTP response
   body other than the sealed payload itself.
9. Installation is atomic (temp file → fsync → rename), owner-only, and the superseded identity
   is backed up before the rename. A crash at any step leaves a complete or plainly-incomplete
   state, never a partially-written key.
10. An identity file readable beyond its owner is refused with a named error rather than loaded.
11. Pairing sessions expire in minutes, void after a capped number of failed redemptions, are
   one-at-a-time per agent, and every mint / redemption / failure / expiry is audited.

## Rollback

**Rollback is not behaviourally safe for further expansion, and saying otherwise would be the
same optimism that produced this defect** (round-1 finding — the first draft called it
harmless).

Reverting restores today's behaviour: the next machine to join mints its own identity and the
split recurs, silently, exactly as it did here. So a rollback must be paired with an
operational freeze on joins, or with provisioning the identity by hand on any machine added
while reverted.

What IS safe: machines already reconciled keep the canonical identity, which is what the rest
of the mesh already expects, so no reconciled machine is left worse off. The superseded
identity files retained by the migration make an individual repair reversible.

One interaction to be explicit about: this change retires no relay registration (Frontloaded
Decision 5), so relay state is unchanged by shipping it and unchanged by reverting it. A
machine reverted to a minted identity would, however, register as yet another row — which is
the recurrence described above, seen from the relay's side.


> **Carrier (frozen excerpt — the work the markers above point at):** <!-- tracked: CMT-026 -->
>
> **CMT-026** — "(1) RELAY-SIDE RETIREMENT of stale agent registrations. Local repair leaves the orphan row registered; the July resolver fix mitigates it but does not remove it. Retirement is a relay operation needing its own authorization model (who may retire a registration, how the relay knows the requester owns it) — that design does not exist. Until it does, a repaired agent still has a dead row bearing its "

## Maturation plan

- **test-agent-live:** live from the first build; the sealed-payload and refusal paths are
  unit-testable without a second machine.
- **dev-agent-live:** the join-path change and the mint refusal ship live — a dark identity
  fix fixes nothing. The reconcile migration ships dry-run first, because it rewrites an
  identity and a wrong repair takes the agent off the network.
- **fleet:** with the release, after the reconcile migration has run non-dry on this agent's
  own split and been verified live on both machines.
- **graduation criterion:** the two machines of one agent publish one fingerprint, confirmed
  by reading both live; and a fresh join produces no new fingerprint.
- **dark-window:** none for the join fix and the mint refusal. The reconcile migration's
  dry-run window ends when its report on this agent's real split is inspected and correct.
