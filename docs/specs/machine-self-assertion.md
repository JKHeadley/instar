---
title: Machine self-assertion — how a machine states a fact about itself it cannot prove locally
slug: machine-self-assertion
status: draft
eli16-overview: docs/specs/machine-self-assertion.eli16.md
---

# Machine self-assertion

Glossary for outside readers: a **rope** is one transport between two of the agent's
machines (Tailscale / LAN / Cloudflare tunnel); the **attention queue** is the durable
operator-notification store; **Know Your Principal** is the house standard that an
unverified identity is a question, not a fact; topic ids (e.g. 62395) name Telegram
conversations where operator directives were given; a **fingerprint** is the short hash of
a machine's Ed25519 signing public key.

## 1. The problem, stated once

Two production failures in the same week share one shape.

**A. The lost key (2026-08-27 → 2026-08-29, two days of one-way mesh).** The Studio's
`.instar/machine/` identity files went missing. Its Ed25519 mesh keypair was regenerated;
`machineId` and public metadata were restored from the Mini's replicated copy. The three
peers still held the OLD `signingPublicKey`. Every outbound signed RPC from the Studio was
refused `401 auth-rejected:signature-invalid` (10,968 consecutive failures per rope).
Peer→Studio traffic kept working (the peers' keys were unchanged, so the Studio still
accepted them), so the mesh ran one-way and no layer noticed. **The Studio's Tailscale
address did NOT change** — this is load-bearing below.

**B. The invisible address (2026-08-29, one machine unreachable-by-registry).** A peer
whose agent runs inside WSL sees exactly one NIC: `eth0 172.22.96.135`, a virtual address
unreachable from anywhere but its own Windows host. Tailscale runs on the Windows side,
outside the VM. The agent advertises what it can see, so it advertises an address that
cannot work, and it can never advertise `100.101.95.10` — the address every other machine
actually reaches it on.

PR #1992 stopped the resulting data loss (peers no longer discard a proven rope because an
advertisement omitted it). PR #1995 closed the detection gap (a peer answering typed auth
refusals classifies `auth-rejected` — provably alive — never `peer-offline — expected`).
Neither gives the machine a way to state the true fact.

**The shared shape:** a machine must assert a fact about itself — *this is my key*, *this
is my address* — that it cannot prove from local evidence, to peers that have no
independent way to verify it from the claim alone.

## 2. The security boundary, corrected three times

The mesh has an authenticated channel between machines: the shared agent bearer token over
TLS/Tailscale. The tempting design is: *let a machine re-announce its identity over the
bearer channel.*

**Correction 1 (2026-08-29, verified live):** on DEFAULT-CONFIGURED deployments the
"bearer cannot forge identity" separation does not hold — the files API
(`POST /api/files/save`) accepts writes to `.instar/machines/<id>/identity.json`, exactly
how incident A was repaired.

**Correction 2 (round-1 review):** correction 1 does NOT license a proof-free automatic
path — proof-of-possession of a NEW key is tautologically satisfiable by any keypair the
attacker just minted. Auto-accept must be CORROBORATED, degrading to a human approval when
corroboration is absent.

**Correction 3 (round-2 review — the irreducible limit, stated honestly).** Round 2
established, with code references, that EVERY corroboration signal a peer can gather —
the 401s it issued, its outbound-probe results, an observed source address, replicated
metadata — is inducible or writable by a bearer-token holder, because AFTER TOTAL KEY LOSS
there is no pre-established secret that distinguishes the legitimate machine from a
token-holder. Two consequences the design now owns:

1. **The corroboration heuristics REDUCE the attack surface; they do not close it.** They
   are therefore used to decide whether a claim may auto-accept OR must go to the operator
   — never to manufacture certainty that isn't there.
2. **A cryptographic close exists only with a pre-established recovery secret** (§4.5,
   escrowed recovery key). Whether to adopt it is the one genuine operator decision this
   spec surfaces (Open questions), because it trades "manage recovery material" against
   "one tap in the rare double-fault case."

## 3. Constraints any accepted option must satisfy

1. **No silent multi-day outage.** A mesh refusing a peer's signatures becomes loudly
   visible within minutes (shipped: PR #1995).
2. **Least human dependence (operator directive, 2026-08-29, topic 62395), bounded by
   safety.** The common, legitimate case needs zero human action; a human action is
   acceptable exactly where the evidence cannot distinguish legitimate recovery from
   takeover; a human *discovery* is never acceptable.
3. **No new capability for an unauthenticated party.**
4. **Reversible.** Every mechanism ships behind a named flag whose absence is today's
   behaviour, dark on the fleet, dryRun-first on dev.
5. **Evidence over assertion.** Where anyone CAN verify from first-hand or unforgeable
   evidence, that evidence — not the claim — is accepted.

## 4. Design

### 4.0 The single serialized identity-store funnel (foundation for everything below)

ALL writers to a stored peer identity — `/api/pair`, re-announce accept, quarantine
approve, AND git-sync replication-apply — pass through ONE serialized mutation funnel
(`IdentityStore.apply`, single-writer per process). No writer touches
`.instar/machines/<id>/identity.json` directly. The funnel enforces, on EVERY write
including replication-apply:

- **keyEpoch monotonicity:** refuse any write whose `keyEpoch <= stored`.
- **Tombstone:** the superseded key's fingerprint is recorded; any future write (including
  a continuity-chained or replicated one) rooted at or below a tombstoned epoch is refused.
- **Sticky revocation:** a revoked machine cannot be written back to active except by an
  operator-minted pairing code (an operator action).

**Stored-key write-path closure (the round-2 critical).** The corroboration a peer relies
on is only as trustworthy as the files feeding it. The FIRST implementation PR makes ALL
of the following never-writable through any bearer-authenticated surface AND never-applied
from an unverified replication pull:

- `.instar/machine/**`, `.instar/machines/**` (identity files) — files-API never-editable
  + `FileClassifier` never-sync; git-sync applies identity changes ONLY through §4.0's
  funnel (epoch/tombstone/revocation checked), never file-level whole-file merge. A pulled
  commit that would change a stored `signingPublicKey` outside the funnel is refused and
  routed to quarantine + alert.
- `.instar/state/identity-epochs.json` (the dedicated epoch/tombstone store — NOT inside
  `identity.json`) — never-editable, never-served, never-sync, single-writer via the
  funnel.
- `state/rope-health.json` and the new issued-refusal counter store (§4.1 condition 4),
  and `logs/identity-changes.jsonl` (§4.3) — every file read by an auto-accept condition.

The rule, stated normatively: **the never-editable/never-sync set = the identity files ∪
the epoch store ∪ every file read by an auto-accept condition.** A corroboration input a
bearer token can still write is not corroboration.

**Honest scope note (round-2 finding):** a bearer token that can edit `.claude/settings.json`
hook commands, `.git/hooks/**`, or `.instar/hooks/**` still reaches code execution and thus
private-key theft. Closing those is pre-existing debt beyond this spec; §4.4's
boundary-restoration claim is therefore scoped to "restored with respect to DIRECT identity
writes," and the bearer→RCE surface is a tracked follow-up (Open questions).

### 4.1 Key rotation re-announce (incident A)

**Claimant-side trigger (deterministic, both-ways bounded):** an episode opens only when —

- Typed `auth-rejected:signature-invalid` (never transport failure; unreachability FREEZES
  the episode clock; the all-ropes conjunction skips ropes that are idle/never-observed
  rather than blocking on them) observed ≥K consecutive times spanning ≥M minutes with zero
  interleaved successes (K=10, M=15 — FD1).
- A LOCAL ROTATION RECORD (`keysRotatedAt` newer than failure onset, with reason) — this is
  claimant-side HYGIENE that gates the benign trigger, NOT peer-verifiable corroboration
  (an attacker speaks the challenge protocol directly and never needs it). 401s without a
  rotation record route to the loud `auth-rejected` alert, never to re-announce.
- Re-announce budget not exhausted (FD2; SelfActionGovernor class).

**Challenge protocol:** the accepting peer mints a 32-byte single-use nonce, 60s TTL. The
response signs the SIX-field binding `(nonce ‖ claimant machineId ‖ new signing pubkey ‖
new encryption pubkey ‖ challenger machineId ‖ keyEpoch)` with the NEW key — **keyEpoch is
inside the signature** (round-2 H2), so the monotonicity/tombstone value cannot be altered
in flight. Replay, cross-peer reuse, and any field mismatch are typed refusals; a refusal
NEVER discloses the stored epoch (no probing oracle). Challenge issuance is security-logged;
per-machineId and per-source attempt caps persist across restarts.

**Peer-side acceptance authority (a deterministic composite that only ever REFUSES on its
own authority; per `docs/signal-vs-authority.md` § "Safety guards on irreversible actions").**
Auto-accept requires ALL of:

1. Challenge signature verifies against the announced key (necessary, never sufficient).
2. The machineId has an EXISTING stored identity AND an active, non-revoked registry entry
   (rotation-not-enrollment; `/api/pair` remains the sole enrollment path; sticky
   revocation per §4.0).
3. `keyEpoch == stored + 1` EXACTLY (round-2 H3/F4 — not merely `>`; an unbounded forward
   jump would let one takeover tombstone the whole epoch space and permanently lock out the
   real machine). The claimant learns `stored` from the replicated public metadata it
   restores from (the same copy that restored the machineId in incident A), so a key-lost
   machine derives `stored+1` WITHOUT any refusal-oracle leak. Genesis: an absent stored
   epoch reads as 0; migration backfills `keyEpoch: 0` (FD12).
4. **The peer's OWN ISSUED inbound-refusal evidence** (round-2 F1, the direction fix): this
   peer has itself REFUSED ≥K inbound envelopes claiming that machineId as
   `signature-invalid` over ≥M minutes — a new durable per-machineId issued-refusal counter
   in `MeshRpc`'s verify path (NOT the prober's outbound `auth-rejected`, which the accepting
   peer does not hold in incident A because peer→claimant traffic kept working). Necessary,
   never sufficient — an attacker CAN induce it by sending new-key-signed traffic, which is
   why 4 never stands alone.
5. **Independent corroboration — the verified source address (5a is the SOLE automatic
   leg).** The re-announce arrived from an endpoint this peer VERIFIED under the INCUMBENT
   key within a tight window before failure onset, over an AUTHENTICATED transport class
   (Tailscale / tunnel-authenticated) — never a bare-LAN address (round-2 H4: closes
   DHCP/ARP endpoint-hijack of a dark machine). In incident A this holds (the Studio's
   Tailscale address was alive under the old key up to the rotation). **Replicated-metadata
   corroboration (former 5b) is DROPPED as an automatic leg** (round-2: it rides a
   replication channel whose `verifyPulledCommits()` is a stub, is itself the incident-A
   write path, and is circular in the legitimate case); it survives only as display/advisory
   in the §4.3 dashboard.
6. **Cross-peer fingerprint agreement** (round-2 F1/F3 — the quorum replacement): a
   read-time check over already-replicated PROMOTED identity. If any other LIVE peer holds a
   DIFFERENT signing fingerprint for this machineId at this epoch, the claim QUARANTINES
   (never last-writer-wins). An automated detector (§4.3) raises URGENT on such divergence
   rather than leaving it to a human reading dashboard rows.
7. Rate/breaker budget OK (FD2), and no unacked ACCEPTED rotation entry exists for this
   machineId (§4.3 — refusals/quarantines never arm the suspend).

**All met → automatic accept (zero human action).** Any of 4–7 unmet, OR 5a unsatisfiable
(a tunnel-only mesh with no verified direct address, OR incident A+B simultaneously where
the address ALSO changed) → the claim QUARANTINES: nothing is stored, and the operator gets
a single-use, content-hash-bound (machineId+keyEpoch+new-key fingerprint) dashboard-PIN
approve/deny (round-2 H7: TOCTOU-safe, mirroring the matrix-acceptance flow; a swapped claim
voids the approval). Two conflicting claims for one machineId within a 10-minute settle
window → BOTH quarantine, one URGENT item deduped per machineId per window (round-2 H8:
repeat conflicts fold into the standing item).

**Partial acceptance / version skew:** per-peer acceptance with a durable claimant-side
episode ledger (accepted/pending/refused, backoff 1m→5m→30m→6h, 72h horizon, P19
give-up-loudly). Route-absent peers classify typed `peer-lacks-accept-route`. The claimant
is the SINGLE notice raiser: one HIGH non-coalescing item per episode keyed
`machineId+keyEpoch`, posted on first acceptance and EDITED with per-peer outcomes.

### 4.2 Observed endpoints (incident B)

As round-1/round-2: observation only from FULL-`verifyEnvelope` inbound RPCs on direct
listeners (never bearer-only, never tunnel/proxy-fronted, never `X-Forwarded-For`);
in-memory bounded LRU (≤8/peer, decay); corroboration LOCAL-FIRST (≥3 obs / ≥30 min at this
peer); dial-back signed-handshake verification to the SAME machineId before promotion; raw
NAT source ports never persisted; an address observed for ≥2 machineIds (shared egress)
refused promotion; promotion-only persistence via `PeerEndpointRecorder` with
`origin: observed` and resolver precedence advertised-alive > observed-corroborated >
advertised-dead; `retainProvenOmitted` treats observed entries as their own class.

**Rotation quarantine — honest bound (round-2 F6):** after ANY rotation for a machineId,
observations for it are discarded and recording suspended for
`rotationQuarantineHours ≥ corroborationWindowMinutes + margin` (FD8). This prevents
WITHIN-WINDOW laundering only; it is a bounded delay, not durable protection. Durable
protection that an accepted-takeover's address cannot be laundered into the NEXT rotation
comes from §4.0's tombstone (an observation under a later-tombstoned key never corroborates)
plus §4.1(5a)'s incumbent-key binding — NOT from the cooldown. Once identity is taken over,
routing-to-attacker is downstream of that, not a new grant.

### 4.3 Identity-change ledger (visibility that cannot be buried)

Every identity write appends a durable row to `logs/identity-changes.jsonl` (machineId,
old/new fingerprints, keyEpoch, path, accepted-by, corroboration used). A small durable
UNACKED-ROTATION INDEX (bounded by pool size) is maintained at append time — the ack
cadence tick and §4.1(7) read the INDEX, never a full-ledger scan (round-2 scalability F2).
An unacked ACCEPTED rotation (only accepted — never a refusal/quarantine, round-2 F2)
suspends further AUTOMATIC accepts for that machineId; a fully-corroborated fresh rotation
OVERRIDES the suspend (so an operator who never taps cannot permanently strand recovery).
Re-surface follows the single-edited-item discipline with widening backoff (24h; priority
escalates after 72h), NOT a re-post stream.

**Ack locus (round-2 F4, resolved):** ONE operator dashboard ack, propagated to the
suspending peers as a signed operator-authenticated ack over the WS4.1 remote-ack route
(named, not an unnamed cross-machine write); each peer's suspend lifts when the propagated
ack lands. The accepting-peer ledger + must-ack is the ATTACK-VISIBILITY BACKSTOP (the
claimant notice is only the benign-case dedupe — in a takeover the "claimant" is the
attacker's script and posts nothing), and the must-ack re-surface rides the HIGH
non-coalescing lane.

**Automated divergence detector:** over the replicated promoted-identity merge, an
URGENT non-coalescing item when two LIVE peers hold different fingerprints for one machineId
at one epoch (§4.1(6)'s machinery) — divergence detection is NOT contingent on a human
reading rows. The dashboard/`GET /pool` fingerprint+epoch+last-write-source fields ride the
EXISTING capacity-heartbeat / shared poll-cache payload (round-2 scalability F6 — no new
fan-out); the ledger pool read is the named `GET /identity-changes?scope=pool`,
dark-peer-tolerant.

### 4.4 F1 — closing the files-API identity hole (sequenced, not deferred)

Interim never-editable/never-sync additions (§4.0's full set) ship in the SAME PR as the
accept route — closing the file hole alone would recreate incident A with no repair path.
Fleet sequencing (accept-route deployed → re-announce enabled → further hardening) is made
MECHANICAL, not willpower (round-2 integration F7): the enable flip / FD3 graduation checks
pool version coherence via the existing machine-coherence guard (every registered-online
machine ≥ the accept-route version; per-machine flag divergence joins that guard's
compared-flags set). Post-F1 the boundary is RESTORED with respect to DIRECT identity
writes (scoped per §4.0's honest note): an uncorroborated bearer claimant reaches only the
PIN quarantine.

### 4.5 Escrowed recovery key (the cryptographic close — ADOPTED, operator-approved 2026-08-29 topic 62395)

The mechanism that makes even the total-loss + address-change case zero-touch AND secure
against a token-holder. At pair time each machine mints a SECOND ("recovery") keypair. Its
PUBLIC half is stored by peers (replicated as identity metadata, applied only through the
§4.0 funnel). Its PRIVATE half is escrowed OUTSIDE `.instar/machine/**`, in a location the
bearer token / files API cannot read.

On rotation the machine signs the SIX-field binding of §4.1 with BOTH the new signing key
(proof-of-possession) AND the RECOVERY key (continuity signature). Peers verify the
continuity signature against the stored recovery public key → cryptographic legitimacy,
because only the real machine holds the recovery private key. A valid continuity signature
BECOMES §4.1's condition 5 (superseding the 5a source-address heuristic and, with it,
condition 4's issued-refusal requirement — a continuity signature is strictly stronger
first-hand evidence than either), giving a fully automatic, token-adversary-proof accept in
every case where the recovery key survived — including the double-fault case 5a cannot cover.

**Escrow location (operator-selectable at pair time; default the strongest available):**

1. **Operator vault (default when a vault backend is configured).** The recovery private
   key is sealed into the operator's SecretStore (AES-256-GCM, master key NOT derivable
   from the bearer token). Survives total loss of `.instar/machine/**`. The one setup cost
   Justin approved.
2. **Peer-sealed shares (fallback / additional copy).** The recovery private key is split
   (Shamir k-of-n over the pool) and each share sealed to a PEER machine's encryption key,
   so recovery needs a quorum of peers to co-sign a recovery-key-use authorization — no
   single compromised peer can wield it, and it survives as long as k peers survive.

**The recovery key's own lifecycle (review-critical — it is now the root of trust):**

- **Compromise / rotation of the recovery key itself** is an operator-only action (it
  cannot be self-service, or a token-holder who somehow obtained it could entrench). It
  goes through the §4.0 funnel with its own epoch, and rotating it re-seals fresh escrow.
- **Recovery key never signs ordinary traffic** — it is used ONLY to authorize a signing-key
  rotation, minimizing its exposure (it is offline/sealed except during a rotation event).
- **Loss of the recovery key** (both the escrow AND the live copy gone) is the ONLY residual
  case that falls back to §4.1's corroboration-or-PIN path — strictly no worse than the
  pre-escrow design, and now genuinely rare (it requires losing two independently-escrowed
  secrets at once).
- **At-rest honesty:** the vault-escrow option means the recovery private key exists sealed
  on this machine's disk (encrypted); the peer-shares option means k peers each hold a
  sealed share. Neither is readable by the bearer token, but both are stated plainly so the
  operator knows where the root-of-trust material physically lives.

## 5. Decision (operator directive 2026-08-29 + round-1/2 revision)

- **Zero-touch for the single-fault legitimate case (incident A):** local rotation record +
  the peer's own issued 401s + the re-announce arriving from the incumbent-verified
  authenticated address + cross-peer agreement → automatic, minutes. This is the common case.
- **Operator tap ONLY where evidence cannot distinguish recovery from takeover, AND the
  escrowed recovery key is unavailable:** with escrow (§4.5) the continuity signature makes
  the key-loss-AND-address-change double fault fully automatic, so the tap is reserved for
  the genuinely-rare case where the recovery key ITSELF is also lost, or a cross-peer
  fingerprint conflict, or (transitionally) a machine not yet carrying an escrowed recovery
  key whose 5a address evidence is unsatisfiable. Under an ACTIVE token-holding adversary,
  §4.1's conflict rule means a legitimate rotation can be FORCED to the tap by a racing
  claim — this fails SAFE (to a human) and is correct; a valid continuity signature
  short-circuits the conflict (cryptographic identity beats a racing bare claim).
- **Observed endpoints:** fully automatic (§4.2).
- **Escrow (§4.5): ADOPTED** (operator-approved 2026-08-29). The escrowed recovery key's
  continuity signature is the PRIMARY condition-5 evidence; it moves the double-fault case
  (key loss + address change) from tap to fully automatic, and is token-adversary-proof. The
  5a source-address heuristic remains as the fallback for the transitional window before
  every machine has an escrowed recovery key, and the PIN quarantine remains for the now-rare
  case where the recovery key itself is also lost.
- Option 3 (continuity-chained PLANNED rotation) is SUBSUMED by §4.5's continuity signature.

### 5b. History (non-normative)

Superseded: the original PIN-gated recommendation; the intermediate fully-automatic
proof-free decision (killed round 1); the round-1 corroboration design whose 5(b) replicated
leg and condition-4 direction were corrected in round 2. §4/§5 above govern.

## Multi-machine posture

Each machine-local surface carries a standalone closed-taxonomy marker (Amendment 3,
2026-08-22) on its own line, followed by the surface it justifies:

- machine-local-justification: physical-credential-locality impossible-because="the-ed25519-mesh-private-key-IS-this-machine-identity-relocating-it-merges-two-machines" permanence=permanent
  — **Re-announce episode state + the claimant's per-peer delivery ledger:** tracks THIS
  machine's own private key and its delivery progress; durable across restart so a crash
  mid-rotation cannot strand a half-converted mesh.
- machine-local-justification: physical-credential-locality impossible-because="a-trust-anchor-meaning-is-what-THIS-machine-verified-first-hand-a-replicated-copy-is-corroboration-not-an-anchor" permanence=permanent
  — **Stored peer identities (`.instar/machines/<id>/identity.json`) + the epoch/tombstone
  store:** machine-local trust anchors; replication is applied only through the §4.0 funnel,
  never as authority.
- machine-local-justification: hardware-bound-resource impossible-because="an-observation-is-this-machine-own-socket-level-network-vantage-the-connection-that-arrived-on-this-host-interface" permanence=permanent
  — **Observation ledger (§4.2, in-memory):** corroboration is local-first, so no new
  merged read or replication path exists.
- machine-local-justification: physical-credential-locality impossible-because="each-peer-records-ITS-OWN-accept-refuse-decisions-as-first-hand-evidence-a-shared-ledger-would-make-one-machine-decision-authoritative-over-another-trust-anchor" permanence=permanent
  — **Identity-change ledger + issued-refusal counter (§4.1(4)/§4.3):** machine-local per
  peer; the pool view is proxied-on-read (`GET /identity-changes?scope=pool`) and the
  operator ack propagates via the WS4.1 signed remote-ack route.

Rotation notice: single raiser — the claimant posts the one episode item; accepting peers
never post (prevents N-notices / zero-notices).

## Decision points touched

| Decision point | Class | Floor / justification |
|---|---|---|
| Peer accept/refuse of a re-announce | invariant | Deterministic composite (§4.1 conditions 1–7): enumerable inputs; per `docs/signal-vs-authority.md` § "Safety guards on irreversible actions" a deterministic guard may hard-REFUSE (false pass catastrophic, false block cheap). It never affirmatively grants in ambiguity — any unmet condition fails CLOSED to quarantine + the operator's PIN. Not an LLM judgment. |
| "Sustained signature-invalid" trigger | invariant | Counter ≥K over ≥M min, typed-401-only, rotation-record-gated (§4.1); triggers an announce attempt, blocks nothing. |
| `auth-rejected` ⇒ provably-alive classification | invariant | Typed HTTP response class (shipped, PR #1995); blocks stale-owner-release death evidence for that peer; distinct rope-health class, never `peer-offline`. |
| Issued inbound-refusal counter feeding condition 4 | invariant | Deterministic per-machineId count of THIS peer's `signature-invalid` refusals (§4.1(4)); an input, blocks nothing. |
| Cross-peer fingerprint agreement | invariant | Read-time equality check over replicated promoted identity (§4.1(6)); disagreement → quarantine, never a pick. |
| Observed-endpoint promotion | invariant | Declared floor (§4.2): ≥3 obs/≥30 min local + dial-back + not-shared-egress + rotation quarantine. Pre-commitment: any adaptive/scored element added later makes this a judgment-candidate requiring floor+arbiter. |
| One-notice raiser election | invariant | Claimant posts on first acceptance; episode-scoped dedupe on machineId+keyEpoch. |
| Continuity-signature verification (§4.5) | invariant | Deterministic Ed25519 verify of the rotation binding against the stored recovery public key; a valid signature is condition-5 evidence superseding the 5a heuristic. Recovery-key rotation is an operator action through the §4.0 funnel. |
| Quarantine approve/deny | invariant | Deterministic routing to the operator's single-use, content-hash-bound dashboard-PIN decision; the operator is the arbiter (Know Your Principal). The machine-side routing is deterministic; the human decision sits above the classified machine surface. |

## Frontloaded Decisions

1. **Detection threshold:** typed `auth-rejected:signature-invalid` only; ≥10 consecutive
   over ≥15 min, zero interleaved successes, all non-idle ropes; unreachability freezes the
   clock; local rotation record required.
2. **Re-announce brake:** SelfActionGovernor class, TARGET KEY = destination peer machineId,
   per-target ceiling 1/24h, max 3 per keyEpoch, census-scaled total ≥ peer count (round-2
   scalability F3 — a governor deny parks the per-peer entry in the pending ledger, never
   consumes an attempt); backoff 1m→5m→30m→6h; P19 breaker. A CAS refusal is a retryable
   per-peer attempt, NOT a new episode and NOT a keyEpoch-budget consumer.
3. **Rollout ladder:** `multiMachine.identityReannounce = {enabled, dryRun}` and
   `multiMachine.observedEndpoints = {enabled, dryRun, corroborationObservations: 3,
   corroborationWindowMinutes: 30, ttlDays: 7, rotationQuarantineHours: 1}`. Dev-gated dark
   on fleet, dryRun:true on dev (peer-side would-accept verdicts logged too). Graduation:
   ≥14 days dry-run with zero false would-accept verdicts PLUS required NEGATIVE rehearsals
   (round-2 lessons F5 — silence is not health): an injected uncorroborated claim MUST
   quarantine, a replayed/old-epoch claim MUST be refused, a cross-peer-conflict claim MUST
   quarantine, each verified from the ledger; and one benign live-pair rotation accepted.
   Flag absent = today's behaviour. Enable gated on machine-coherence version check (§4.4).
4. **Challenge protocol:** 32-byte single-use nonce, 60s TTL, SIX-field signed binding
   (incl. keyEpoch), CAS store via the §4.0 funnel, persisted attempt caps, issuance
   security-logged, refusals never disclose the stored epoch.
5. **Partial acceptance:** per-peer state machine + durable pending ledger, 72h horizon,
   typed `peer-lacks-accept-route`, single edited notice, HIGH escalation naming
   un-accepted peers with a dashboard action (CLI last resort).
6. **Conflict rule:** monotonic integer `keyEpoch == stored+1`; conflicting claims within a
   10-min settle window → both quarantine, keep last-verified, one URGENT deduped per
   machineId per window; old-key tombstone; replay state keyed by machineId, survives
   rotation.
7. **Notice channel:** one HIGH non-coalescing item per episode deduped on machineId+keyEpoch
   + a rope-health-digest line; the §4.3 must-ack ledger ALSO on the HIGH non-coalescing lane;
   explicitly not medium.
8. **Observed-endpoint corroboration:** §4.2 floor incl. `rotationQuarantineHours ≥
   corroborationWindowMinutes + margin`; LRU ≤8; promotion-only persistence with
   `origin: observed`; precedence advertised-alive > observed-corroborated > advertised-dead.
9. **Stored-key write-path closure + F1 boundary:** §4.0's full never-editable/never-sync
   set ships in the SAME PR as the accept route; git-sync applies identity changes only
   through the §4.0 funnel; fleet sequencing is machine-coherence-gated; the bearer→RCE
   surface (`.claude/settings.json`, `.git/`, `.instar/hooks/`) is a tracked follow-up.
10. **Escrow (§4.5) — ADOPTED:** recovery keypair minted at pair time; public half
    replicated (funnel-applied), private half escrowed to the operator vault (default) or
    Shamir k-of-n peer-sealed shares; continuity signature is the primary condition-5
    evidence; recovery-key rotation is operator-only through the §4.0 funnel; recovery key
    signs ONLY rotations, never ordinary traffic. A transitional machine without an escrowed
    recovery key uses the 5a fallback until it has one.
11. **Liveness propagation:** `auth-rejected` is proof-of-life for every liveness consumer;
    it blocks stale-owner-release death evidence for that peer.
12. **Migration & rollout parity:** `migrateConfig()` adds the two config blocks
    (existence-checked); `migrateClaudeMd()` adds the operator-facing "why did I get a
    key-rotation notice / what is a quarantined identity claim" section; the
    never-editable/never-sync additions ride `refreshHooksAndSettings`; keyEpoch genesis =
    absent-reads-as-0, migration backfills `keyEpoch: 0` into every existing stored identity
    and epoch-store row (round-2 integration F2); `/api/pair` on an existing machineId writes
    `stored+1` (never claimant-supplied) and MAY clear revocation (operator action), through
    the §4.0 funnel (round-2 integration F3).

## Open questions

*(none)*

> **Resolved operator decisions (were OQ1/OQ2, now settled — recorded for the reader):**
> Escrowed recovery key — ADOPTED (operator-approved 2026-08-29, topic 62395: "Approved"
> against the Option-A recommendation); folded in as §4.5's normative primary mechanism,
> default escrow location the operator vault, resolved into §4.5 / §5 / FD10.
> bearer→RCE surface (`.claude/settings.json` hook commands, `.git/hooks/**`,
> `.instar/hooks/**`) — tracked as SEPARATE pre-existing-debt hardening (it predates and is
> independent of this spec, which neither creates nor widens it); §4.4's boundary claim
> stays scoped to "restored with respect to DIRECT identity writes" and cites it as the
> named follow-up rather than blocking on it.

> <!-- tracked: CMT-211 -->
> **CMT-211** — Carry the machine-self-assertion decision to closure: (1) the operator's
> accept-or-decline on the PIN-gated key re-announce path, taken with the token/identity
> boundary-collapse cost stated (spec section 2); (2) classify a rope failing auth-rejected
> as a PROVABLY-ALIVE peer rather than 'offline - expected', since the heartbeat that
> grades it stopped because of the very fault; (3) scope the Tailscale key-expiry warning
> to nodes that actually back a mesh peer endpoint, so a dead unrelated tailnet node stops
> warning forever; (4) the externally-observed-endpoint path that lets peers record the
> address they OBSERVED, which is what a NAT'd or VM-hosted agent cannot assert about
> itself.
>
> Status against this spec: (2) shipped (PR #1995), (3) shipped (PR #1994). (1) and (4) are
> designed in §4–§5 here; the only decision still parked on the operator is OQ1 (escrow),
> which the immutable carrier text (written pre-review) does not capture — this annotation,
> not the carrier, reflects the standing state.

## 7. Evidence

- `logs/server.log` — 926 `[rope-probe] probe failed … auth-rejected:signature-invalid`.
- `.instar/machine/identity.json` — `keysRotatedAt: 2026-08-28T02:01:55Z`, recorded reason
  naming the lost private keys.
- Peers' stored copies read at `/api/files/read`: old `signingPublicKey` `MCowBQYDK2VwAyEAhPiJ…`
  vs current `MCowBQYDK2VwAyEAVfPs…`.
- Mama PC interface table: `platform: linux`, `eth0 172.22.96.135` only, no CGNAT address.
- Post-repair verification: signed mesh probes to all three peers returned typed `403
  not-router`.
- Code-verified round-2 findings: `GitSync.verifyPulledCommits()` returns `[]`
  (`src/core/GitSync.ts:735`); `NEVER_EDITABLE_PREFIXES` omits `state/` and identity files
  (`src/server/fileRoutes.ts:299`); PR #1995's `auth-rejected` is an OUTBOUND-probe
  classification (`src/core/ropeProbeContract.ts:57`), which the accepting peer does not hold
  in incident A.
- Round-1 review: standards gate (2), codex-cli:gpt-5.5 (6), claude-fable-5 clean-door (5),
  6 internal (security 12, adversarial 10, scalability 8, integration 11,
  decision-completeness 13, lessons-aware 8).
- Round-2 review: standards gate (1, fixed), codex-cli:gpt-5.5 (5, MINOR), claude-fable-5
  clean-door (5, MINOR), 6 internal (security 8, adversarial 6, scalability 6, integration
  8, decision-completeness 6, lessons-aware 6) — all convergent on the condition-4 direction
  fix, the replication-channel trust gap, and the escrow close.
