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
conversations where operator directives were given.

## 1. The problem, stated once

Two production failures in the same week share one shape.

**A. The lost key (2026-08-27 → 2026-08-29, two days of one-way mesh).** The Studio's
`.instar/machine/` identity files went missing. Its Ed25519 mesh keypair was regenerated;
`machineId` and public metadata were restored from the Mini's replicated copy. The three
peers still held the OLD `signingPublicKey`. Every outbound signed RPC from the Studio was
refused `401 auth-rejected:signature-invalid` (10,968 consecutive failures per rope).
Peer→Studio traffic kept working, so the mesh ran one-way and no layer noticed.

The repair required a human with filesystem access to write the new public identity onto
each peer. There is no in-product path: `POST /api/pair` is the only route that stores a
remote identity, and it requires a pairing code minted by `instar pair` on the awake
machine — which is the machine that cannot be trusted by its peers, because its key just
changed.

**B. The invisible address (2026-08-29, one machine unreachable-by-registry).** A peer
whose agent runs inside WSL sees exactly one NIC: `eth0 172.22.96.135`, a virtual address
unreachable from anywhere but its own Windows host. Tailscale runs on the Windows side,
outside the VM. The agent advertises what it can see, so it advertises an address that
cannot work, and it can never advertise `100.101.95.10` — the address every other machine
actually reaches it on — because that address does not exist in its world.

PR #1992 stopped the resulting data loss (peers no longer discard a proven rope because an
advertisement omitted it). PR #1995 closed the detection gap (a peer answering typed auth
refusals classifies `auth-rejected` — provably alive — never `peer-offline — expected`).
Neither gives the machine a way to state the true fact.

**The shared shape:** a machine must assert a fact about itself — *this is my key*, *this
is my address* — that it cannot prove from local evidence, to peers that have no
independent way to verify it from the claim alone.

## 2. The security boundary, corrected twice

The mesh has an authenticated channel between machines: the shared agent bearer token over
TLS/Tailscale. The tempting design is: *let a machine re-announce its identity over the
bearer channel.* The cost as originally analyzed: today a leaked bearer token grants broad
API access but cannot forge a machine identity — signature verification is a separate,
stronger boundary. Making identity assertable over the token collapses those two
boundaries into one.

**Correction 1 (2026-08-29, verified live):** on DEFAULT-CONFIGURED deployments that
separation does not hold. The dashboard files API (`POST /api/files/save`,
bearer-token-authenticated, default-editable over the whole project directory) accepts
writes to `.instar/machines/<id>/identity.json` — exactly how incident A was repaired.

**Correction 2 (round-1 review):** correction 1 does NOT license a proof-free automatic
path, for four independently sufficient reasons:

1. **Deployment-dependence.** A deployment with narrowed files-API `allowedPaths` still
   has the two-lock separation; for it, a bearer-gated re-announce is a genuine widening
   today.
2. **Temporal contingency.** F1 (closing the files-API identity hole) destroys the
   "already collapsed" justification the moment it lands, leaving the auto path as the
   designed-in collapse.
3. **Proof-of-possession is liveness, not legitimacy.** Signing a challenge with the NEW
   key is tautologically satisfiable by any attacker who just minted a keypair. Against
   the leaked-token adversary — the threat this spec is about — bare PoP constrains
   nothing.
4. **The notice channel is proven insufficient as the sole compensating control.** The
   2026-08-28 alert for incident A fired correctly and drowned in a 237-item attention
   queue. Post-hoc visibility through that surface cannot backstop an identity rewrite.

The design below therefore requires INDEPENDENT CORROBORATION for any automatic accept,
and degrades to a human approval — never to a proof-free accept — when corroboration is
absent.

## 3. Constraints any accepted option must satisfy

1. **No silent multi-day outage.** A mesh refusing a peer's signatures becomes loudly
   visible within minutes (shipped: PR #1995's `auth-rejected` classification + alert).
2. **Least human dependence (operator directive, 2026-08-29, topic 62395), bounded by
   safety.** The common, legitimate case must need zero human action. A human action is
   acceptable exactly where the evidence cannot distinguish legitimate recovery from
   takeover; a human *discovery* is never acceptable.
3. **No new capability for an unauthenticated party.** Everything requires existing
   authentication.
4. **Reversible.** Every mechanism ships behind a named flag whose absence is today's
   behaviour, dark on the fleet, dryRun-first on dev (concrete flags in
   `## Frontloaded Decisions`).
5. **Evidence over assertion.** Where anyone — the claimant or the accepting peer — CAN
   verify from first-hand or otherwise-unforgeable evidence, that evidence, not the
   claim, is what is accepted.

## 4. Design

### 4.1 Key rotation re-announce (incident A)

**Claimant-side trigger (deterministic, both-ways bounded):** a re-announce episode opens
only when ALL of the following hold —

- The typed classification `auth-rejected:signature-invalid` (never transport failure;
  unreachability FREEZES the episode clock) has been observed ≥K consecutive times
  spanning ≥M minutes with zero interleaved successes, on every rope to that peer
  (defaults: K=10, M=15 — Frontloaded Decision 1).
- The machine holds a LOCAL ROTATION RECORD: `identity.json.keysRotatedAt` newer than the
  failure onset, with a recorded reason. **Sustained 401s WITHOUT a local rotation record
  are an attack/corruption signal** (a peer's stored copy was tampered, or this machine's
  identity file was) — they route to the loud `auth-rejected` alert and NEVER to
  re-announce. (P20: the 401 stream is the symbol; the rotation record is the
  corroboration; no-signal-at-all is `unknown` and fails toward not-announcing.)
- The per-machine re-announce budget is not exhausted (Frontloaded Decision 2; registered
  as a SelfActionGovernor class).

**Challenge protocol:** the accepting peer mints a 32-byte single-use nonce, 60s TTL. The
claimant's response signs `(nonce ‖ claimant machineId ‖ new signing pubkey ‖ new
encryption pubkey ‖ challenger machineId)` with the NEW key. Replay, cross-peer reuse,
and any field mismatch are typed refusals. The identity-store write is CAS-guarded
against the identity version read at challenge issuance — a concurrent write between
verify and store refuses rather than silently retrying. Challenge ISSUANCE (not just
acceptance) is security-logged; per-machineId and per-source attempt caps persist across
restarts (mirroring `/api/pair`'s brute-force discipline).

**Peer-side acceptance authority (the named authority — deterministic composite, an
irreversible-action guard in Signal-vs-Authority's carve-out).** The 401-detector and the
challenge check are SIGNALS. Acceptance requires ALL of:

1. Challenge signature verifies against the announced key (proof of possession —
   necessary, never sufficient).
2. The machineId has an EXISTING stored identity AND an active, non-revoked registry
   entry. Re-announce is rotation-of-existing, NEVER enrollment; `/api/pair` remains the
   sole enrollment path. A revoked machine cannot re-announce itself back into trust
   (sticky revocation extends to this path explicitly).
3. `keyEpoch` monotonicity: announcements carry an integer per-machine key epoch;
   `epoch <= stored` is refused and logged. Wall-clock (`keysRotatedAt`) is displayed to
   humans but never the ordering key. On accept, the OLD key is tombstoned at the stored
   epoch — any future announcement (including a later continuity-chained one) rooted at
   or below the tombstoned epoch is refused. Replay state stays keyed by machineId and
   survives rotation; old-key envelopes are refused post-rotation regardless of nonce
   freshness.
4. **The peer's OWN first-hand evidence**: this peer has itself observed sustained
   `auth-rejected` failures from the incumbent identity (its rope-health `auth-rejected`
   classification, PR #1995). A takeover attempt against a peer whose stored key is
   working is refused — an attacker cannot make a healthy peer accept without first
   breaking that peer's view, which is itself loud.
5. **Independent corroboration** (at least one):
   - the re-announce arrived from a source address this peer has VERIFIED for that
     machineId (an advertised-and-recently-alive endpoint, or a §4.2
     observed-and-dial-back-verified one), OR
   - the replicated public identity metadata (the same replication that restored the
     Studio's record from the Mini) carries a rotation record consistent with the claim
     (same keyEpoch, `keysRotatedAt` within skew bounds).
6. Rate/breaker budget OK (Frontloaded Decision 2), and NO unacknowledged prior rotation
   entry exists for this machineId in the identity-change ledger (§4.3).

**All conditions met → automatic accept (zero human action — the legitimate-recovery
case).** Any of 4–6 unmet → the claim is QUARANTINED, nothing is stored, and the operator
gets a dashboard-PIN approve/deny action (Mobile-Complete: a tap, never a terminal
command; the raw repair command appears only as the documented filesystem last resort).
Two conflicting claims for one machineId inside a 10-minute settle window → BOTH
quarantined, the peer keeps the last-verified identity, one URGENT non-coalescing item —
never last-writer-wins on identity.

**Partial acceptance / version skew:** acceptance is per-peer with a durable claimant-side
episode ledger (per-peer accepted/pending/refused, exponential backoff 1m→5m→30m→6h
ceiling, 72h retry horizon, P19 give-up-loudly breaker). A route-absent peer classifies
`peer-lacks-accept-route` (typed — a v-old peer, not a failure loop). The claimant is the
SINGLE notice raiser: one HIGH, non-coalescing attention item per rotation episode keyed
`machineId+keyEpoch`, posted on first acceptance and EDITED with per-peer outcomes
(`accepted: mini, laptop · pending: mama-pc`), never re-posted per attempt. No re-announce
is ever queued for delivery while a peer is dark — the next successful contact re-runs
detection from live evidence.

### 4.2 Observed endpoints (incident B)

Peers record the address they OBSERVE a machine's authenticated traffic arriving from —
evidence held by the observer, replacing an unprovable self-assertion. Prior art:
WireGuard/Tailscale endpoint roaming and STUN reflexive addressing; their load-bearing
rule is imported: **update only on authenticated inbound traffic**.

- An observation is recorded ONLY from an inbound RPC whose envelope passed the FULL
  `verifyEnvelope` chain (recipient-bound, registered key, fresh nonce) — never
  bearer-only requests — and ONLY on direct listeners (Tailscale/LAN) where the socket
  peer address is meaningful; never tunnel/proxy-fronted listeners, never
  `X-Forwarded-For`.
- Observations accumulate IN MEMORY per peer (bounded LRU, ≤8 candidate addresses, decay
  window) — NEVER a per-request registry write. Only a corroborated, PROMOTED endpoint is
  persisted, on change only, through the existing `PeerEndpointRecorder` chokepoint.
- **Corroboration is local-first** (no new cross-machine merged read): ≥3 observations of
  the same address spanning ≥30 minutes at THIS peer. Multi-peer agreement is a read-time
  comparison over already-replicated promoted endpoints, never write-time observation
  replication.
- **Dial-back verification before promotion:** the recording peer dials the candidate and
  completes a signed handshake to the SAME machineId. A raw NAT source port is never
  persisted as a durable route; an address observed for ≥2 distinct machineIds (shared
  NAT/exit-node egress) is refused promotion.
- Promoted observations are provenance-tagged (`origin: observed`) and kept distinct from
  advertised endpoints; resolver precedence: advertised-and-alive > observed-corroborated
  > advertised-dead. `PeerEndpointRecorder.retainProvenOmitted` (invariant 2b) treats
  observed entries as its own class so an advertisement can never wipe a verified
  observation and vice versa.
- **Rotation quarantine (anti-laundering):** all observations for a machineId are
  discarded and observation-recording for it suspended for a cooldown window after ANY
  identity rotation for that machineId — an accepted takeover must not be able to convert
  itself into corroborated routing within the window; and per §4.1(5), an observation
  recorded under a key later tombstoned never counts as corroboration for the NEXT
  rotation.

### 4.3 Identity-change ledger (visibility that cannot be buried)

Every identity write — pair, re-announce, quarantine, refusal, files-API (pre-F1, best
effort) — appends a durable audit row (`logs/identity-changes.jsonl`: machineId, old/new
key fingerprints, keyEpoch, path, accepted-by, corroboration used). Rotation entries carry
an ACKNOWLEDGEMENT state: an unacked entry re-surfaces on a cadence until the operator
acks (dashboard tap), and an unacked rotation SUSPENDS further automatic accepts for that
machineId (they quarantine to the approval path instead). This is the structural answer
to the buried-notice failure: if the operator will not approve before the change, they are
structurally guaranteed to see it after. The Machines dashboard tab and `GET /pool`
machine rows gain: signing-key fingerprint, `keysRotatedAt`, keyEpoch, and
last-identity-write source, so stored-copy skew between peers is a read, not a forensic
dig.

### 4.4 F1 — closing the files-API identity hole (sequenced, not deferred)

- **Interim mitigation ships in the FIRST implementation PR of this spec, in the same PR
  as the accept route:** `.instar/machine/**` and `.instar/machines/**` join the
  files-API always-read-only list. Same-PR coupling guarantees an in-product repair path
  exists at every instant the file hole is closed (closing it alone would recreate
  incident A with NO repair path).
- Fleet sequencing (hard constraint): accept-route deployed fleet-wide → re-announce
  enabled → any further F1 hardening. A v-next claimant against a v-old peer is the typed
  `peer-lacks-accept-route` case in §4.1 until migration completes.
- Post-F1 the compensating controls ARE §4.1's corroboration + quarantine + ack-suspend
  (this section IS the §2 re-run, done now rather than promised): with the files hole
  closed, an uncorroborated bearer-token claimant can reach only the quarantine path,
  which requires the operator's PIN — i.e. post-F1 the boundary is RESTORED to two locks
  for the adversarial case while staying zero-touch for the corroborated one.

## 5. Decision (operator directive 2026-08-29 + round-1 revision)

The operator directed: *"I want the solution that takes the least amount of time/effort
from the humans"* (topic 62395). Round-1 review (8 reviewers, ~75 findings) established
that a proof-free automatic accept is an identity mint for any bearer-token holder — it
does not survive its own threat model. The decision as revised:

- **Zero-touch for the legitimate case:** a real rotation (local rotation record +
  peer-observed 401s + corroboration) is accepted automatically — no tap, no approval.
  Incident A under this design: automatic recovery in minutes.
- **A tap ONLY for the suspicious case:** an uncorroborated or conflicting claim
  quarantines to a dashboard-PIN approve — the case where "least human effort" would
  otherwise mean "attacker's least effort."
- **Observed endpoints:** fully automatic (§4.2) — evidence-based, no human action ever.
- Option 3 (continuity-chained planned rotation) is OUT OF SCOPE — its own follow-up,
  with the §4.1(3) tombstone rule recorded as a hard requirement on its design.

### 5b. History (non-normative)

Superseded positions, kept for the record: the original recommendation (Option 1 +
Option 4 + PIN-gated Option 2, pre-directive) and the intermediate fully-automatic
decision (2026-08-29, pre-review). Neither is normative; §4/§5 above govern.

## Multi-machine posture

| Surface | Posture | Justification |
|---|---|---|
| Stored peer identities (`.instar/machines/<id>/identity.json`) | machine-local | machine-local-justification: physical-credential-locality — each machine's stored copy of a peer's public key is that machine's own trust anchor; replicating trust anchors would let one compromised machine rewrite every machine's roots. Consequence owned in §4.1: per-peer delivery + per-peer acceptance ledger. The pre-existing public-metadata replication (which restored the Studio's record) is read-side corroboration input only — never authority. |
| Observation ledger (§4.2, in-memory) | machine-local | machine-local-justification: physical-credential-locality — an observation is one observer's socket-level evidence, meaningful only at the machine that held the connection; corroboration is deliberately local-first so no new merged read or replication path exists. Promoted endpoints ride the EXISTING registry/lease replication unchanged. |
| Re-announce episode state (claimant-side per-peer ledger) | machine-local | machine-local-justification: hardware-bound-resource — it describes THIS machine's key and its per-peer delivery progress; durable across restart so a crash mid-rotation cannot strand a half-converted mesh. |
| Identity-change ledger + ack state (§4.3) | machine-local (per accepting peer) with a proxied-on-read pool view | Each peer's ledger records ITS OWN acceptance decisions (evidence, not shared truth); the dashboard machine rows merge fingerprint/epoch per machine at read time so skew is visible. Ack state lives with the raising side (claimant's episode item). |
| Rotation notice | single raiser | The claimant posts the ONE episode item (first acceptance) and edits it; accepting peers never post (prevents N-notices / zero-notices). |

## Decision points touched

| Decision point | Class | Floor / justification |
|---|---|---|
| Peer accept/refuse of a re-announce | invariant | Deterministic composite (§4.1 conditions 1–6): enumerable inputs, irreversible-action guard per Signal-vs-Authority's carve-out; explicitly not an LLM judgment. Any unmet condition fails CLOSED to quarantine + human approval. |
| "Sustained signature-invalid" trigger | invariant | Counter ≥K over ≥M min, typed-401-only, rotation-record-gated (§4.1); triggers an announce attempt, blocks nothing. |
| `auth-rejected` ⇒ provably-alive classification | invariant | Typed HTTP response class (shipped, PR #1995); feeds liveness consumers: it BLOCKS stale-owner-release death evidence for that peer (a 401-answering machine is alive on every transport that answers) and is a distinct rope-health class, never `peer-offline`. |
| Observed-endpoint promotion | invariant | Declared floor: ≥3 observations ≥30 min local + dial-back signed handshake + not-shared-egress + rotation quarantine (§4.2). Pre-commitment: if any adaptive/scored element is ever added, this becomes a judgment-candidate and must then declare floor + arbiter. |
| One-notice raiser election | invariant | Claimant posts on first acceptance; episode-scoped dedupe on machineId+keyEpoch. |
| Quarantine approve/deny | human (operator) | Dashboard-PIN action; the one deliberate human decision point, reserved for evidence-ambiguous claims (Know Your Principal). |

## Frontloaded Decisions

1. **Detection threshold:** typed `auth-rejected:signature-invalid` only; ≥10 consecutive
   spanning ≥15 min, zero interleaved successes, on all ropes to the peer; unreachability
   freezes the episode clock; local rotation record required (§4.1).
2. **Re-announce brake:** max 1 automatic re-announce episode per peer per 24h, max 3 per
   keyEpoch; budget exhausted → HIGH item, no further attempts; registered as a
   SelfActionGovernor class; per-peer backoff 1m→5m→30m→6h; P19 breaker with
   sustained-failure test (permanently-refusing peer + contested machineId → bounded
   attempts, bounded notices).
3. **Rollout ladder:** `multiMachine.identityReannounce = {enabled, dryRun}` and
   `multiMachine.observedEndpoints = {enabled, dryRun, corroborationObservations: 3,
   corroborationWindowMinutes: 30, ttlDays: 7}`. Both dev-gated dark on the fleet,
   dryRun:true even on dev (peer-side would-accept verdicts logged too). Graduation:
   ≥14 days dry-run with zero false would-accept verdicts on the dev pair + one live-pair
   rotation rehearsal with per-peer acceptance verified. Flag absent = today's behaviour.
4. **Challenge protocol:** as §4.1 (32-byte single-use nonce, 60s TTL, five-field signed
   binding, CAS store, persisted attempt caps, issuance security-logged).
5. **Partial acceptance:** per-peer state machine + durable pending ledger, 72h horizon,
   typed `peer-lacks-accept-route`, single edited notice enumerating outcomes, HIGH
   escalation naming un-accepted peers with a dashboard action (CLI repair as documented
   last resort).
6. **Conflict rule:** monotonic integer `keyEpoch`; conflicting claims within a 10-min
   settle window → both quarantined, keep last-verified, one URGENT non-coalescing item;
   never last-writer-wins; old-key tombstone at accepted rotation; replay state keyed by
   machineId, survives rotation.
7. **Notice channel:** one HIGH, non-coalescing attention item per episode, deduped on
   machineId+keyEpoch, plus a rope-health-digest line; explicitly not medium (the
   2026-08-28 alert died at normal priority in a 237-item queue). Plus the §4.3 must-ack
   ledger with unacked-suspends-auto-accept semantics.
8. **Observed-endpoint corroboration:** the §4.2 floor (3 obs / 30 min / dial-back /
   not-shared / rotation-quarantine); in-memory LRU ≤8 candidates/peer; promotion-only
   persistence via `PeerEndpointRecorder` with `origin: observed` provenance; resolver
   precedence advertised-alive > observed-corroborated > advertised-dead.
9. **F1 boundary:** interim never-editable entries for `.instar/machine/**` +
   `.instar/machines/**` ship in the SAME PR as the accept route; fleet sequencing
   accept-route → enable → further hardening; §4.4 records the post-F1 boundary analysis
   now (no deferred re-run).
10. **Option 3:** out of scope; its future design inherits the tombstone requirement.
11. **Liveness propagation:** `auth-rejected` is proof-of-life for every liveness
    consumer; it blocks stale-owner-release death evidence for that peer.
12. **Migration & rollout parity:** `migrateConfig()` adds the two config blocks
    (existence-checked); `migrateClaudeMd()` adds the operator-facing "why did I get a
    key-rotation notice / what is a quarantined identity claim" section; the files-API
    never-editable additions ride `refreshHooksAndSettings`. Fleet sequencing per §4.4.

## Open questions

*(none)*

<!-- tracked: CMT-211 -->

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
> Status against this spec: (2) shipped (PR #1995) and (3) shipped (PR #1994). (1) is
> RESOLVED by §5 as revised: the operator's directive selected least-human-effort; review
> reshaped that into auto-when-corroborated / PIN-only-when-suspicious, so the PIN surface
> survives solely as the quarantine approval (the immutable carrier text above predates
> the revision — this annotation, not the carrier, reflects the standing decision). (4) is
> §4.2 of this spec.

## 7. Evidence

- `logs/server.log` — 926 `[rope-probe] probe failed … auth-rejected:signature-invalid`.
- `.instar/machine/identity.json` — `keysRotatedAt: 2026-08-28T02:01:55Z`, with the
  recorded reason naming the lost private keys.
- Peers' stored copies read directly at `/api/files/read` on each machine: old
  `signingPublicKey` `MCowBQYDK2VwAyEAhPiJ…` vs current `MCowBQYDK2VwAyEAVfPs…`.
- Mama PC interface table captured on-machine: `platform: linux`, `eth0 172.22.96.135`
  only, no CGNAT address present.
- Post-repair verification: signed mesh probes to all three peers returned the typed
  `403 not-router` refusal (the exact success contract).
- Round-1 review inputs: standards-conformance gate (2 possible-violations: Know Your
  Principal; Verify the State, Not Its Symbol), codex-cli:gpt-5.5 external (6),
  claude-fable-5 clean-door (5), and six internal reviewers (security 12, adversarial 10,
  scalability 8, integration 11, decision-completeness 13, lessons-aware 8).
