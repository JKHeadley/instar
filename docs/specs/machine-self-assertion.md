---
title: Machine self-assertion — how a machine states a fact about itself it cannot prove locally
slug: machine-self-assertion
status: draft
eli16-overview: docs/specs/machine-self-assertion.eli16.md
review-convergence: "2026-08-29T23:36:51.197Z"
review-iterations: 5
review-completed-at: "2026-08-29T23:36:51.197Z"
review-report: "docs/specs/reports/machine-self-assertion-convergence.md"
approved: true
approved-at: "2026-08-30T16:18:00.000Z"
approved-by: "verified-operator:telegram:7812716706"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 12
cheap-to-change-tags: 0
contested-then-cleared: 3
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
- **recoveryEpoch monotonicity (independent):** the recovery pubkey field carries its own
  monotonic `recoveryEpoch` + tombstone; refuse a write whose `recoveryEpoch <= stored`. A
  signing-key rotation write that ALSO mutates the recovery pubkey is REFUSED — replacing the
  recovery pubkey is a separate, dashboard-PIN-gated operator operation (§4.5).
- **Recovery-pubkey FIRST-establishment invariant (round-4 — Structure > Willpower):** a
  recovery-pubkey write from ABSENT/epoch-0 to a value (the retro-mint / initial-pair
  ingestion) is NOT merely a monotonic 0→1 write the funnel waves through — it REQUIRES
  dashboard-PIN operator authentication and is REFUSED from any bearer-authenticated or
  replication-apply writer. Without this the transitional-window `has-recovery-key:false`
  state is a poison point: whoever first lands a 0→1 recovery-pubkey write becomes the
  machine's root of trust. This is an enumerated funnel invariant with the same teeth as
  monotonicity, not a prose expectation on callers. The legitimate establishment/propagation
  channel is the operator-authenticated PAIRING-TRUST exchange (one operator action that
  propagates the new pubkey to peers) — NOT git-replication (which the invariant refuses).
  Authenticator class: the operator-minted pairing CODE for initial-pair ingestion; a
  dashboard-PIN for standalone establishment / retro-mint on an already-paired machine.
- **Tombstone:** the superseded key's fingerprint is recorded; any future write (including
  a continuity-chained or replicated one) rooted at or below a tombstoned epoch is refused.
- **Sticky revocation:** a revoked machine cannot be written back to active except by an
  operator-minted pairing code (an operator action).

**Stored-key write-path closure (the round-2 critical).** The corroboration a peer relies
on is only as trustworthy as the files feeding it. The FIRST implementation PR makes ALL
of the following never-writable through any bearer-authenticated surface AND never-applied
from an unverified replication pull:

- `.instar/machine/**`, `.instar/machines/**` (identity files) — files-API never-editable
  + `FileClassifier` never-sync + added to `NEVER_SERVED_PREFIXES` (round-3: today identity/
  key-file protection rides ONLY the `*.key` filename rule at `fileRoutes.ts:26`; the prefix
  set does not yet contain `.instar/machine/`, so the directory must be added explicitly); git-sync applies identity changes ONLY through §4.0's
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

**Acceptance state machine (read this first — the normative detail follows).**
```
detect sustained auth-rejected (typed 401, ≥K/≥M, local rotation record)  → open episode
  → peer mints challenge nonce
  → claimant signs six-field binding (+ recovery key if it has one)
  → PEER EVALUATES, in order:
       has-recovery-key(machineId)?  (non-tombstoned recovery pubkey on record)
         YES → continuity signature REQUIRED (5-primary). valid + recovery-pubkey
               cross-peer-consistent (or first-hand anchor) + keyEpoch==stored+1
               + not-revoked  → ACCEPT.  missing/invalid/superseded → QUARANTINE (PIN).
         NO  → 5a fallback: re-announce from an incumbent-verified authenticated
               address?  yes → ACCEPT.  no (double fault / tunnel-only) → QUARANTINE (PIN).
  → any cross-peer equal-epoch DIVERGENCE (signing bare-claim, or any recovery-pubkey)
       → QUARANTINE (PIN, URGENT).   epoch LAG → converge + retry, never quarantine.
  → ACCEPT writes through the §4.0 funnel; every outcome appends to the §4.3 ledger.
```
Every QUARANTINE is a single-use, content-hash-bound dashboard-PIN operator decision; ACCEPT
is zero-touch. The rest of this section is the exact conditions.


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
   real machine). The claimant learns `stored` as the MAX across live peers' replicated
   public metadata (round-3: under partial acceptance peers can legitimately hold different
   stored epochs; max-across-live-peers is the derivation, and condition 6 distinguishes a
   lagging peer — same fingerprint, lower epoch — from a genuine fingerprint DIVERGENCE at
   equal epoch: only the latter quarantines). A key-lost machine derives `stored+1` WITHOUT
   any refusal-oracle leak. Genesis: an absent stored epoch reads as 0; migration backfills
   `keyEpoch: 0` and `recoveryEpoch: 0` (FD12). (Refusals still never ECHO the stored epoch —
   not as a secrecy claim, since a bearer holder reads it from replicated public metadata
   anyway, but to avoid a convenient probing oracle in the refusal path itself.)
4. **The peer's OWN ISSUED inbound-refusal evidence** (round-2 F1, the direction fix): this
   peer has itself REFUSED ≥K inbound envelopes claiming that machineId as
   `signature-invalid` over ≥M minutes — a new durable per-machineId issued-refusal counter
   in `MeshRpc`'s verify path (NOT the prober's outbound `auth-rejected`, which the accepting
   peer does not hold in incident A because peer→claimant traffic kept working). Necessary,
   never sufficient — an attacker CAN induce it by sending new-key-signed traffic, which is
   why 4 never stands alone.
5. **Condition-5 evidence — two paths, continuity FIRST (round-3 restructure).**
   - **5-primary (continuity signature):** if the peer holds a non-tombstoned recovery
     pubkey for this machineId (the `has-recovery-key` state), a valid continuity signature
     (§4.5) against it is MANDATORY and sufficient for condition 5 — it supersedes 5a below,
     and 5a is FORBIDDEN for that machineId (closes the downgrade). Cryptographic legitimacy
     a token-holder cannot forge.
   - **5a-fallback (verified source address, ONLY when no recovery pubkey is on record —
     the transitional window):** the re-announce arrived from an endpoint this peer VERIFIED
     under the INCUMBENT key within a tight window before failure onset, over an
     AUTHENTICATED transport class (Tailscale / tunnel-authenticated) — never a bare-LAN
     address (round-2 H4: closes DHCP/ARP endpoint-hijack). Incident A satisfies it (the
     Studio's Tailscale address was alive under the old key up to the rotation).
   - Replicated-metadata corroboration (former 5b) remains DROPPED as an automatic leg
     (round-2); display/advisory only.
6. **Cross-peer fingerprint agreement** (round-2 F1/F3 — the quorum replacement; round-3:
   covers BOTH keys; round-4: precise continuity carve-out). A read-time check over
   already-replicated PROMOTED identity. Two divergence classes, treated differently:
   - **Recovery-pubkey divergence** (different recovery pubkey at equal `recoveryEpoch`
     across live peers): ALWAYS quarantines — a continuity-signature acceptance NEVER
     bypasses recovery-pubkey agreement (that is the poisoned-root case; one poisoned peer
     must not be takeable in isolation).
   - **Signing-fingerprint divergence** (different signing fp at equal `keyEpoch`): quarantines
     for a BARE claim; a VALID continuity signature (verified against a cross-peer-CONSISTENT
     recovery pubkey) MAY short-circuit it — cryptographic identity outranks a racing bare
     claim, which is the whole point of the recovery key. A lagging peer (same fp, lower
     epoch) is convergence, not divergence: it converges via funnel-applied replication and
     accepts on retry (never a quarantine).
   The §4.3 detector raises URGENT on a genuine (equal-epoch) divergence of either key.
   **Live-peer set:** a peer counts as live for max-epoch derivation and divergence checks iff
   it has produced a mesh-authenticated side-effect (a signed RPC this peer verified, or a
   fresh capacity heartbeat) within the liveness window; `auth-rejected` counts as proof-of-
   life (PR #1995) but a bare unreachable/dark peer does NOT participate (its stale copy is
   neither a divergence vote nor a max-epoch source).
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

**Why not a static `advertisedAddress` config override?** (round-3 external.) For incident B
specifically — one machine with a known, stable Tailscale address it cannot self-see — an
operator-set `advertisedAddress` is one config line and zero new machinery, and IS offered as
the immediate manual fix. The observed-endpoint machinery below is the AUTOMATIC path so a
NAT'd/VM machine recovers with no operator action at all (the least-human-effort directive);
the two coexist — a static override always wins when set.

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
PUBLIC half is bound into the operator-minted pairing exchange and stored by peers (never
introduced or replaced over the bearer re-announce path — that channel is the threat model).
Its PRIVATE half is escrowed in the machine's SecretStore.

On rotation the machine co-signs the SIX-field binding of §4.1 with BOTH the new signing key
(possession) AND the RECOVERY key (continuity). A valid continuity signature verified
against the peer's stored recovery public key is cryptographic legitimacy a token-holder
cannot forge.

**Escrow survival is VERIFIED, not assumed (round-3 critical — the load-bearing fix).** The
recovery private key is sealed under SecretStore's AES-256-GCM master key. That master key
is keychain-backed on machines with an OS keychain, but FILE-backed at
`.instar/machine/secrets-master.key` (`SecretStore.ts:112`) on a keychain-less machine
(headless Linux, WSL — incident B's Mama PC is `platform: linux`). A file-backed master key
lives INSIDE the exact directory whose disappearance is incident A, so vault-escrow there
does NOT survive the double-fault it exists for. Therefore:

- Vault-escrow is offered ONLY when `SecretStore.isKeychainBacked === true`, evaluated LIVE
  from the OS at pair time (`SecretStore.ts:446`) — never a persisted, bearer-writable flag
  (any cache of it joins §4.0's never-editable/never-sync set). The silent keychain→file
  degradation is surfaced LOUDLY at pair time, not left to a DegradationReporter note.
  Graduation rehearsals must also verify the keychain is UNLOCKABLE at recovery time (a
  freshly-rebooted headless machine may have a locked keychain pre-login — round-4 external),
  not merely keychain-backed at pair time.
- A machine WITHOUT a keychain-backed vault does NOT escrow a recovery key. It stays on the
  §4.1 corroboration path (5a where the address is stable — incident A — else the PIN
  quarantine), and its `has-recovery-key` state is explicitly FALSE and surfaced ("no
  recovery escrow — this machine's rare double-fault recovery needs an operator tap"), so
  the operator is never misled into believing protection exists.

**Shamir peer-sealed shares are OUT OF SCOPE of this spec** (round-3: lessons F3 /
adversarial #3 / security #2). They degenerate on a small mesh (a 2-machine pool forces
k=1, so one peer holds the whole key), do NOT raise the bar against THIS spec's shared-token
adversary (the token reaches RCE on every peer to steal shares), and their only use case —
the no-keychain machine — is already covered by the PIN fallback above. Replacing a rare
one-time tap with a permanent quorum-crypto subsystem is a net-negative trade. If ever
wanted, peer-shares is its own follow-on spec with its own convergence.

**Why "dashboard-PIN" is the superior trust class (round-5).** Every "operator-authenticated,
never bearer" gate here (first-establishment, recovery-key rotation, quarantine approval)
rests on the dashboard PIN being a factor a bearer-token holder does NOT possess: the PIN is
operator-held, is not derived from the bearer token, and the PIN-entry path authenticates the
operator independently of the token. (A bearer→RCE holder who could serve altered dashboard
assets is the OQ2 follow-up surface — out of this spec's closure scope, stated in §4.4.)

**The recovery pubkey is now the root of trust and gets the SAME rigor as the signing key
(round-3: adversarial #1/#2/#4, security #3, lessons F2).**

- **Own epoch + tombstone.** The recovery pubkey carries its own monotonic `recoveryEpoch`
  and tombstone in `.instar/state/identity-epochs.json`, independent of the signing
  `keyEpoch`. The §4.0 funnel REFUSES any signing-key rotation write that also mutates the
  recovery pubkey — replacing the recovery pubkey is a SEPARATE, dashboard-PIN-gated operator
  operation (never bearer-reachable), so a single signing-key takeover cannot install an
  attacker recovery pubkey and entrench.
- **Mandatory-when-present (closes the downgrade).** If a peer holds a non-tombstoned
  recovery pubkey for a machineId, a valid continuity signature is MANDATORY for auto-accept
  and the 5a heuristic is FORBIDDEN for that machineId. The stored recovery pubkey (in the
  funnel-protected never-editable identity store) IS the `has-recovery-key` flag — not
  spoofable — and its presence disables the weaker path, so a token-holder cannot omit the
  continuity signature to force 5a.
- **Cross-peer agreement extends to the recovery pubkey.** A continuity signature may accept
  (and short-circuit §4.1(6)'s signing-fingerprint conflict) ONLY if the recovery pubkey it
  verifies against is cross-peer-consistent at its `recoveryEpoch`; a recovery pubkey that
  diverges across live peers at equal `recoveryEpoch` QUARANTINES (URGENT), so one poisoned
  peer cannot be taken over in isolation. `recoveryEpoch` gets the SAME max-across-live-peers
  derivation and lag-vs-divergence distinction as `keyEpoch`: a recovery-KEY rotation
  propagating unevenly means peers still at the older `recoveryEpoch` cannot verify a
  new-recovery-key continuity signature and DEGRADE TO PIN (the safe direction — availability,
  never takeover). Recovery-key rotation is therefore expected rare and must be fully
  propagated before relied upon. Two hard rules close the partition exploit (round-4
  adversarial N2): (i) a continuity signature verified against a BELOW-MAX (superseded)
  `recoveryEpoch` is REFUSED, so a peer lagging at a rotated-away recovery key cannot honor a
  signature against the old key; (ii) a REPLICATED (non-anchor) recovery pubkey the peer
  cannot cross-check against any disagreeing live peer FAILS TO QUARANTINE — never accepted
  vacuously. Crucially, a recovery pubkey a peer established FIRST-HAND at pair time (its own
  trust anchor — see the Multi-machine posture note) is AUTHORITATIVE for continuity
  verification WITHOUT cross-peer corroboration: on a 2-machine mesh peer A holds B's recovery
  anchor directly and needs no third peer, so legitimate double-fault auto-recovery is NOT
  broken there. Rule (ii)'s quarantine scopes to replicated non-anchor pubkeys only.
- **Recovery-key use is bound + replay-safe.** Every recovery-key use (continuity signature,
  and any recovery-key rotation) is over a single-use nonce covering
  `(machineId ‖ keyEpoch ‖ new-signing-fp ‖ new-recovery-fp ‖ recoveryEpoch)`.

**The recovery key's own lifecycle:**

- Rotation is DASHBOARD-PIN-gated (never bearer), through the §4.0 funnel, with its own
  epoch; it re-seals fresh escrow.
- It signs ONLY signing-key rotations, never ordinary traffic — sealed/offline except during
  a rotation event.
- Loss of BOTH the escrow AND the live copy falls back to §4.1's corroboration-or-PIN path
  (strictly no worse than pre-escrow) AND raises URGENT "recovery escrow missing" so a forced
  downgrade (an attacker deleting the sealed blob) is loud, never silent.
- **At-rest honesty + blob survival (round-5).** The survival guarantee covers the MASTER KEY
  (keychain, above) AND the sealed CIPHERTEXT: the recovery-key blob is stored OUTSIDE the
  incident-A blast radius — in the OS keychain item itself, or under a sibling path the Studio
  defect provably does not touch — NEVER under `.instar/machine/**` (else a keychain-backed
  machine still loses the escrow in the double-fault: the keychain yields the master key but no
  ciphertext remains). The FD3 graduation rehearsal DELETES `.instar/machine/**` and proves
  recovery end-to-end, not merely "keychain unlockable." On a keychain-backed machine the
  recovery private key is then decryptable only via the OS keychain master key (survives
  `.instar/machine/**` loss, not bearer-derivable — `SecretStore.ts:297`, `*.key` read-blocked
  at `fileRoutes.ts:26`).

**Token-adversary-proof scope (honest, per §4.4).** The continuity signature is
token-adversary-proof under "bearer WITHOUT code execution." A bearer→RCE path
(`.claude/settings.json` hooks, `.git/hooks/**`, `.instar/hooks/**` — pre-existing debt,
tracked follow-up) reaches private-key theft on any machine and is out of this spec's closure
scope; §4.4's boundary claim and this one are both scoped to direct writes.

**Alternatives considered (round-4 external):**
- *Tailscale `whois` as corroboration* — the tailnet node key survives `.instar/machine/**`
  loss and is stronger than 5a's recency heuristic for incident A; it is adopted as an
  ADDITIONAL 5a-tier signal where the mesh runs over Tailscale (it cannot help incident B's
  WSL topology, where the node key lives outside the agent's namespace — the §4.2 case). It
  does NOT replace the recovery key, which is the only leg that closes the token-adversary
  gap after total loss.
- *Operator-held CA root (SSH-CA / SPIFFE-style)* — one pinned offline operator key signing
  all machine identities would replace per-machine recovery keys with one verify. Rejected as
  the default because it is a single escrow SPOF and a single operator-managed secret across
  the whole fleet; the per-machine recovery key keeps the blast radius to one machine and
  needs no always-available central signer. Recorded so the decentralized choice is explicit.

Prior art (for reviewers): monotonic epochs + exact-increment + tombstones + an offline
recovery key is TUF/DID root-key rotation; the `== stored+1` rule is TUF's fast-forward
defense.

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
- **Escrow (§4.5): ADOPTED** (operator-approved 2026-08-29), scoped to KEYCHAIN-BACKED
  vault-escrow only (round-3: a file-backed vault does not survive incident A; Shamir
  peer-shares dropped to a follow-on spec). On a keychain-backed machine the continuity
  signature is the PRIMARY, MANDATORY condition-5 evidence and makes the double-fault case
  fully automatic + token-adversary-proof; 5a is used ONLY for a machineId with no recovery
  pubkey on record. A machine without a keychain-backed vault carries no recovery key, is
  surfaced as such, and uses 5a (incident A) or the PIN (double fault) — never silently
  "protected".
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
| Cross-peer fingerprint agreement | invariant | Read-time check over replicated promoted identity (§4.1(6)). Equal-epoch RECOVERY-pubkey divergence always quarantines (a continuity signature never bypasses it). Equal-epoch SIGNING-fp divergence quarantines a bare claim but a valid continuity signature (against a cross-peer-consistent recovery pubkey) may short-circuit it. Epoch lag is convergence, not divergence. |
| Observed-endpoint promotion | invariant | Declared floor (§4.2): ≥3 obs/≥30 min local + dial-back + not-shared-egress + rotation quarantine. Pre-commitment: any adaptive/scored element added later makes this a judgment-candidate requiring floor+arbiter. |
| One-notice raiser election | invariant | Claimant posts on first acceptance; episode-scoped dedupe on machineId+keyEpoch. |
| has-recovery-key predicate + downgrade posture | invariant | The `has-recovery-key` state = a non-tombstoned recovery pubkey on record in the funnel-protected identity store (not spoofable). When TRUE, a continuity signature is MANDATORY and 5a is FORBIDDEN for that machineId; a re-announce lacking a valid continuity signature QUARANTINES (never falls to 5a) — closes the omit-the-signature downgrade. |
| Continuity-signature verification (§4.5) | invariant | Deterministic Ed25519 verify of the rotation binding against the stored recovery public key at its `recoveryEpoch`; a valid signature is condition-5 evidence, MANDATORY-when-present, and must still pass recovery-pubkey cross-peer agreement (§4.1(6)). Recovery-key rotation is dashboard-PIN-gated through the §4.0 funnel, never bearer. |
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
3. **Rollout ladder:** `multiMachine.identityReannounce = {enabled, dryRun}`,
   `multiMachine.observedEndpoints = {enabled, dryRun, corroborationObservations: 3,
   corroborationWindowMinutes: 30, ttlDays: 7, rotationQuarantineHours: 1}`, and
   `multiMachine.recoveryKeyEscrow = {enabled, dryRun}` (keychain-gated at pair time). All
   dev-gated dark on fleet, dryRun:true on dev (peer-side would-accept verdicts logged too).
   Graduation:
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
   set ships in the SAME PR as the accept route, enforced by a STATIC MANIFEST test that ties
   every file read by an auto-accept condition to a protected storage class (round-4 external:
   the "every file read by a condition" rule must be mechanically checked, not a denylist that
   silently drifts as conditions are added); git-sync applies identity changes only
   through the §4.0 funnel; fleet sequencing is machine-coherence-gated; the bearer→RCE
   surface (`.claude/settings.json`, `.git/`, `.instar/hooks/`) is a tracked follow-up.
10. **Escrow (§4.5) — ADOPTED, keychain-vault only.** Flag
    `multiMachine.recoveryKeyEscrow = {enabled, dryRun}` (dark-on-fleet, dryRun-on-dev; in
    the FD3 ladder + FD12 `migrateConfig`). Recovery keypair minted at pair time on a
    machine whose `SecretStore.isKeychainBacked === true`; public half bound into the
    operator-minted pairing exchange + replicated (funnel-applied with its own
    `recoveryEpoch`/tombstone); private half sealed in the keychain-backed vault. Continuity
    signature is the primary, MANDATORY condition-5 evidence when a recovery pubkey is on
    record; recovery-key rotation is dashboard-PIN-gated through the funnel; the recovery key
    signs ONLY rotations. A machine WITHOUT a keychain-backed vault mints no recovery key,
    surfaces `has-recovery-key:false`, and uses 5a/PIN — never silent. Shamir peer-shares
    are OUT OF SCOPE (own follow-on spec).
    - **Retro-mint (this FD10; migration mechanics in FD12):** existing already-paired
      machines have no recovery keypair; on first post-upgrade boot (idempotent — skipped once
      a recovery pubkey exists) a keychain-backed machine mints + escrows one and establishes
      its recovery pubkey via an operator-confirmed step (the pairing-trust channel, never
      the bearer re-announce path). Without this, "until it has one" is unreachable.
    - **De-pair teardown:** de-pair/revocation INITIATION is a dashboard-PIN operator op,
      never bearer-reachable. On de-pair, the machine destroys its sealed recovery key and
      peers tombstone its recovery pubkey; the recovery-pubkey tombstone is ATOMIC-WITH-
      REVOCATION per peer (a tombstoned-recovery entry MUST also read revoked, else the peer
      quarantines) — so a partial propagation cannot leave a peer with `has-recovery-key:false`
      AND an active registry entry, which would re-open 5a in isolation (round-4 adversarial
      N1). No peer-held shares to re-seal (Shamir dropped), so the round-2 k-of-n hazard does
      not arise.
    - **Transitional-window closure:** graduation adds "no active-paired machine's recovery
      pubkey remains UNESTABLISHED AT ITS PEERS past horizon H" as a tracked, alerting
      condition — keyed on the peer-observable `has-recovery-key` (recovery pubkey propagated
      to peers), NOT on the machine's own self-reported keychain status or local mint (round-4
      N3/integration: a machine that minted locally but never propagated, or spoofed
      keychain:false, must still trip the alert). Keychain status is advisory context, not the
      alert gate. A GENUINELY keychain-less machine (e.g. a headless Linux/WSL peer that can
      never escrow) is not a perpetual incident: once the operator ACKNOWLEDGES it, it becomes
      an accepted PIN-path state (the same accept-fallback discipline as a load-bearing-guard
      gap — acknowledged, visible, suppressed), distinguishing a supported keychain-less config
      from a stuck/spoofing one. So a stuck-transitional machine is an incident, an
      acknowledged keychain-less one is an accepted risk, and neither is a silent weak path.
11. **Liveness propagation:** `auth-rejected` is proof-of-life for every liveness consumer;
    it blocks stale-owner-release death evidence for that peer.
12. **Migration & rollout parity:** `migrateConfig()` adds the THREE config blocks
    (identityReannounce, observedEndpoints, recoveryKeyEscrow — existence-checked); the
    stored identity schema gains a `recoveryPublicKey` field and `.instar/state/identity-epochs.json`
    gains a `recoveryEpoch`/tombstone per machineId (backfilled absent-reads-as-0, no recovery
    pubkey ⇒ `has-recovery-key:false`); the retro-mint path (FD10) mints recovery keypairs for
    existing keychain-backed machines on first post-upgrade boot; `migrateClaudeMd()` adds the operator-facing "why did I get a
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
> designed in §4–§5. OQ1 (escrow) is RESOLVED — adopted, operator-approved 2026-08-29; only
> the bearer→RCE hardening (OQ2) remains a tracked follow-up. The immutable carrier text
> (written pre-review) predates all of this — this annotation, not the carrier, reflects the
> standing state.

## Maturation plan

- **test-agent-live:** live from the first build. The §4.0 funnel invariants (keyEpoch /
  recoveryEpoch monotonicity, tombstone, first-establishment PIN gate), the §4.1 acceptance
  composite, the challenge binding, and the observed-endpoint promotion floor are all
  unit-testable without a second machine, including the negative rehearsals (uncorroborated →
  quarantine, replayed/superseded → refuse).
- **dev-agent-live:** ships behind the three flags (FD3) in dryRun on a development agent —
  every accept path logs a would-accept/would-quarantine verdict (claimant AND peer side)
  while the legacy corroboration path stays authoritative. The keychain-backed vault-escrow
  and the recovery-key mint are exercised live on the dev pair; the recovery blob's survival
  is proven by the FD3 rehearsal that DELETES `.instar/machine/**` and recovers end-to-end.
- **fleet:** with a release, after: (a) ≥14 days dryRun on the dev pair with zero false
  would-accept verdicts, (b) the negative rehearsals pass from the ledger, (c) one live-pair
  rotation accepted, (d) the machine-coherence version gate confirms the accept route is
  fleet-wide before re-announce enables (FD4/§4.4 sequencing), and (e) the F1 never-editable/
  never-sync closure ships in the same PR as the accept route.
- **graduation criterion:** a real key rotation on one machine is auto-accepted by its peers
  in minutes with zero operator action (the incident-A replay); an injected uncorroborated /
  replayed / cross-peer-conflicting claim quarantines to the PIN; and no active-paired
  keychain-backed machine's recovery pubkey remains unestablished at its peers past horizon H.
- **dark-window:** the whole feature ships dark on the fleet and dryRun-first on dev; the
  window ends per-flag when its graduation criterion above is met and inspected. The
  bearer→RCE hardening (OQ2) and Shamir peer-shares are explicitly OUT of this window — their
  own follow-on specs.

## Reference (internal codes used above, for outside readers)

- **Round-1/2/3 H*/F*/OQ*** — finding ids from the convergence review rounds (this spec's own
  process); resolutions are folded into the sections they annotate.
- **FD*** — Frontloaded Decision N in the section above.
- **P19** — the constitution's "No Unbounded Loops" standard (brakes: max-attempts, backoff,
  breaker). **P20** — "Verify the State, Not Its Symbol."
- **WS4.1 remote-ack / WS4.4** — multi-machine-seamlessness spec increments (the signed
  operator-ack route; pool-stable reads).
- **Amendment 3** — the 2026-08-22 narrowing of the machine-local-justification taxonomy.
- **TUF / DID** — The Update Framework / Decentralized Identifiers; §4.5's epoch+tombstone+
  offline-recovery-key rotation mirrors their root-key rotation model.
- **5a / condition N** — the §4.1 acceptance-composite legs.

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
