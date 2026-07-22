---
title: "Instar Mutual SSH-Subsystem Autobootstrap and Continuous Proof"
slug: "mutual-ssh-autobootstrap"
author: "Instar-codey"
eli16-overview: "mutual-ssh-autobootstrap.eli16.md"
status: draft
approved: true
ships-staged: true
rollout-disposition: active
rollout-source-pr: 1539
rollout-flag-path: multiMachine.mutualSsh.enabled
rollout-criteria: "At least one registered peer pair has current bidirectional SSH readiness proof with no blocking reason."
rollout-evidence-type: endpoint
rollout-evidence-ref: /multi-machine/mutual-ssh
rollout-metrics-json: '{"cadenceHours":6,"evidenceMaxAgeHours":12,"metrics":[{"id":"ready-mutual-ssh-peers","source":"feature-summary","sourceRef":"mutual-ssh.ready-peers","direction":"at-least","threshold":1,"minSamples":1}]}'
review-convergence: "2026-07-19T21:27:13.671Z"
review-iterations: 4
review-completed-at: "2026-07-19T21:27:13.671Z"
review-report: "docs/specs/reports/mutual-ssh-autobootstrap-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
parent-principle: "Runtime End-to-End Proof — the canary standard"
single-run-completable: true
frontloaded-decisions: 5
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Instar Mutual SSH-Subsystem Autobootstrap and Continuous Proof

## Problem statement

The operator's paired machines can be cryptographically registered in Instar while
host-to-host SSH is asymmetric or absent. The July 19 incident had all three shapes:
laptop to mini worked, mini to laptop failed, and one host initially had no client
key. Existing pairing proves machine identity for Instar's signed HTTP mesh; it does
not establish or prove a bidirectional SSH path. The multi-transport mesh spec even
records SSH as a deliberately unbuilt future rope. As a result, setup and recovery
code can discover the missing direction only after it needs it.

The required outcome is a verified A→B and B→A **Instar SSH-subsystem** path for every active pair of the
operator's machines. Instar establishes it during machine enrollment/agent creation,
keeps proving both directions, repairs recoverable drift without operator work, and
never reports “mutual” from a one-sided observation.
The ordinary command `ssh user@host` may still fail; that is outside this contract
and is not a regression in the Instar SSH-subsystem health result.

## CLASS review (completed before design)

### What standard is missing or needs upgrading?

The multi-machine standard must distinguish **registered identity**, **advertised
reachability**, and **directionally proven transport**. A transport required by an
employee-role agent is not present merely because a peer key or endpoint exists. Its
contract must name every required direction, run a probe from the actual source
machine, bind the result to the expected peer identity, and define continuous
freshness. This becomes the reusable **Symmetric Transport Proof** standard: every
transport described as mutual carries fresh per-direction evidence; “A reached B”
can never stand in for “B reached A.”

### What development-process gap allowed the class?

The original multi-machine acceptance matrix tested cryptographic pairing and mesh
RPC but had no transport × direction × lifecycle matrix. SSH was explicitly omitted,
and no creation/enrollment gate enumerated required transports. A locally green
setup therefore passed without running anything on the second host. This change adds
a reusable conformance fixture that fails any future “mutual” transport unless it
proves A→B, B→A, keyless-first-boot, key drift, endpoint drift, and recovery.

## Goals

1. Generate a dedicated SSH key on every machine without operator prompts.
2. Exchange and install only authenticated peer keys over the existing verified
   Instar pairing channel.
3. Verify both directions from the machines that originate them before enrollment is
   called complete.
4. Re-probe continuously and self-heal missing keys, stale endpoint advertisements,
   and damaged peer admission entries.
5. Expose current, freshness-bounded evidence and a scrubbed audit trail.
6. Require no passwords, copied keys, shell commands, or manual file editing.

## Non-goals

- This does not make arbitrary Internet hosts SSH-accessible.
- This does not infer operator authorization from LAN proximity or hostname.
- This does not copy an operator's existing personal SSH private key.
- This does not replace the signed HTTP/Tailscale/Cloudflare mesh. SSH becomes an
  additional independently observed path; multi-rope routing belongs to the
  multi-transport subsystem.
- This does not silently claim success when the OS has no reachable SSH service.

## Security boundary and threat model

Only machines already mutually verified by Instar pairing may participate. The
MachineAuth signature and pinned machine fingerprint authorize key exchange; an SSH
host key independently binds the reached endpoint. An unpaired LAN host, a poisoned
hostname, a stale registry entry, or a peer presenting a changed host key must not
gain authorization or be treated as healthy.

Instar creates a dedicated Ed25519 SSH client key and SSH host key per
`(agent, machine)`. It never reads, copies, or modifies the operator's personal SSH
keys or `authorized_keys`. The mandatory zero-intervention path is an Instar-owned,
unprivileged SSH endpoint on a PortRegistry-assigned high port, implemented with the
audited `ssh2` protocol library. It authenticates only active paired-machine public
keys held in Instar state. Revocation invalidates fresh proof immediately and removes
reachable admissions; session admission expires everywhere within five minutes. A key is
accepted only when its signed pairing payload names the same machine fingerprint as
the MachineAuth principal.

The endpoint exposes one SSH subsystem, `instar-rpc`; it rejects shell, exec, PTY,
agent forwarding, TCP forwarding, environment injection, and file transfer. This is
a genuine SSH transport supporting Instar coordination without silently granting a
general interactive shell into the operator's account. General operator shell access
and the OS SSH daemon remain the operator's policy, outside Instar.

This proves **Instar SSH-subsystem transport**, not operator shell SSH. Human `ssh`
access is neither required nor implied. The verified fact is that both Instar
processes completed the SSH protocol, public-key authentication, pinned-host
verification, and restricted subsystem challenge.

### Alternatives considered

- A normal health RPC over the existing signed mesh would only restate the identity
  we already know; it cannot independently close the requested SSH asymmetry.
- Adding an `ssh` transport tag to MeshRpc would be metadata, not an SSH handshake;
  it would provide neither standard SSH diagnostics nor independent host-key semantics.
- mTLS or QUIC would add a secure RPC rope but would not establish an SSH key/path.
- Tailscale SSH and OS sshd require host policy, privileges, or shell-account setup,
  so cannot guarantee zero-intervention bootstrap.
- An embedded SSH subsystem supplies portable user-level SSH, separate host/client
  keys, audited protocol framing, and no shell privilege. Protocol compatibility is
  intentional: standard SSH packet analyzers, fingerprints, host-key pinning, and
  `ssh -s ... instar-rpc` diagnostics work across platforms. mTLS/Noise/QUIC would
  require a new client, trust store, wire-debugging path, and key lifecycle while not
  satisfying the explicit SSH-path requirement. Exact dependency pinning and the
  narrow rejection surface make the additional parser cost visible.
  The cost is real: the dependency adds parser/CVE/algorithm-churn and platform-
  networking response obligations. Exact pinning, SBOM/vulnerability gates, a narrow
  algorithm set, and subsystem-only fuzz/adversarial tests are the acceptance price.

## Proposed design

### 1. `MachineSshIdentity`

On server start and during agent creation, ensure dedicated client and host keypairs exist under
the machine-local encrypted state boundary. Generation uses `ssh-keygen -t ed25519`
with an empty key passphrase because the non-interactive agent process must use it;
the containing directory and private key are mode 0700/0600. The public comment is
`instar:<agentId>:<machineId>:<generation>`. Generation is idempotent. Corrupt,
wrong-mode, or mismatched pairs rotate to a new generation and retain the old public
key only for a bounded overlap until both directions prove the replacement. Client
and host generations are independent monotonic counters. Host keys move through
`advertised → quarantined → overlap → promoted → retired`; lower/equal unexpected
generations become `rollback-rejected`. The machine MachineAuth-signs
`{agentId,machineId,pairingEpoch,newGeneration,newHostPublicKey,previousGeneration,issuedAt}`
and cross-signs it with the old host key when available. A receiver accepts only
`current+1`, quarantines it, pins the new key, and runs a fresh signed challenge.
Old-key cross-signature moves it to overlap immediately; if the old key is corrupt,
the MachineAuth signature plus successful new-key challenge does so. Promotion
requires every peer's inbound proof to that host generation and never occurs from
advert receipt alone. Overlap lasts at most 10 minutes; incomplete promotion leaves
the new key quarantined and mutual false. Unadvertised changes remain quarantined.

| Current state | Accepted input | Result / idempotency |
|---|---|---|
| current N | signed proposal N+1 | quarantine once; identical replay is a no-op |
| quarantine N+1 | valid new-key challenge | overlap; duplicate challenge is a no-op |
| overlap N/N+1 | all required inbound proofs | promote N+1 and retire N |
| any | generation ≤ current or different key at same generation | rollback/conflict reject |
| quarantine/overlap N+1 | competing N+2 | reject until N+1 promotes or expires |

Concurrent observers converge on `(pairingEpoch, hostGeneration, keyFingerprint)`;
there is no last-writer-wins key selection.

This is physical credential locality, not replicated state. Only public material and
generation metadata cross the mesh.

### 2. Authenticated bootstrap exchange

Pairing completion and every later reconciliation tick exchange a signed
`SshBootstrapAdvert` over MeshRpc:

```ts
interface SshBootstrapAdvert {
  machineId: string;
  agentId: string;
  pairingEpoch: number;
  clientKeyGeneration: number;
  hostKeyGeneration: number;
  clientPublicKey: string;
  sshHostPublicKeys: string[];
  endpoints: Array<{ host: string; port: number; source: 'tailscale'|'lan'|'configured' }>;
  issuedAt: string;
  expiresAt: string;
}
```

The receiver validates bounds, expiry, MachineAuth principal equality, key format,
and endpoint allowlisting before installing the client key. Advert signatures do not
authorize arbitrary paths or commands. Endpoint candidates come from Tailscale
identity, the peer address on an authenticated control-plane session, and explicit existing config; public DNS
or message text is never trusted as an endpoint source.
Provenance supplies candidates only. Peer identity comes solely from the previously
MachineAuth-signed host-key pin plus fresh signed challenge; an address mismatch can
never update pins.
Each advert carries at most eight candidates: four Tailscale/configured and two
session-observed per address family. Observed candidates are peer+session scoped,
expire after five minutes, reject multicast/link-local addresses, and never trigger
subnet scanning.

### 3. Instar-owned SSH endpoint and admission store

`MachineSshEndpoint` binds an unprivileged PortRegistry allocation. It prefers a
Tailscale address, then a configured private interface; it never listens on a public
wildcard unless the configuration explicitly supplies an authenticated TCP front.
The signed advert carries the concrete bound endpoints and host public key.

The new `ssh2` dependency is exact-version pinned, included in lockfile/license/SBOM
checks, and must pass the existing production-dependency vulnerability gate. Server
algorithms are allowlisted to current Ed25519 host keys, modern key exchange, and
AEAD ciphers; password and keyboard-interactive authentication are not registered.

`SshPeerAdmissionStore` derives its desired set only from active paired machines'
signed adverts. It is atomic, symlink-refusing, generation-fenced, and rejects a
public-key fingerprint associated with another agent or machine. The endpoint maps
the authenticated SSH key back to the expected MachineAuth fingerprint and accepts
only bounded, schema-validated `instar-rpc` frames. It has no filesystem or arbitrary-
command verb. Protocol-level tests prove every other SSH channel request is rejected.

Every admission is a five-minute lease bound to agent id, pairing epoch, client-key
generation, `observerBootId`, and observer-local monotonic expiry. Authentication and subsystem-open
both revalidate it. Expiry/revocation closes active sessions and refuses reconnects.
A partitioned peer may retain a stale record on disk but cannot use it beyond the
lease ceiling; the honest maximum revocation exposure is five minutes, not global
instant removal.

Network brakes apply before authentication: 32 global and 4-per-source handshakes,
10-second handshake/auth deadlines, 3 auth attempts, 2 active sessions per peer,
64-KiB frames, 256-KiB responses, 30-second idle timeout, nonce replay rejection,
and token-bucket request limits. Excess work is shed before controller probe capacity;
metrics contain counts/error classes only. Flood, oversized-frame, replay, and slow-
handshake tests are mandatory.

Health probes have a distinct 8-second end-to-end deadline including connect,
handshake, authentication, subsystem open, challenge, and close. The general-session
idle timeout never extends a health probe.

Using an Instar endpoint removes the bootstrap dependency on OS Remote Login, sudo,
passwords, an operator's shell account, and mutations to `~/.ssh`. An optional
diagnostic may observe the OS daemon, but OS SSH health never satisfies or blocks this
feature's readiness contract.

### 4. Directional proof protocol

`MutualSshVerifier` executes a batch-mode SSH probe from the real source machine to
each candidate endpoint. It pins the advertised SSH host key in an Instar-owned
known-hosts file and sends a random challenge through `machine ssh-rpc`. The peer
returns the challenge, its MachineAuth fingerprint, `sourceClientKeyFingerprint`, and
current client and host generations, signed by its machine identity. Success therefore
proves network reachability, the SSH server host key, possession of the installed
client private key, and the expected Instar peer identity.
Challenge request and response both carry `pairingEpoch`, `observerBootId`, client
generation, host generation, and nonce. Admission lookup keys and proof predicates
use that same tuple. Revoke/re-pair increments the epoch and rejects every record from
all other epochs regardless of apparent generation or freshness.

Each source writes only its own directional record:

```ts
interface DirectionalSshProof {
  sourceMachineId: string;
  targetMachineId: string;
  pairingEpoch: number;
  observerBootId: string;
  endpointId: string;
  sourceClientKeyGeneration: number;
  targetHostKeyGeneration: number;
  targetHostKeyFingerprint: string;
  verifiedAt: string;
  expiresAt: string;
  challengeDigest: string;
}
```

Freshness uses dual clocks: signed wall-clock issuance/expiry capped to five minutes,
plus the origin's monotonic deadline while the same `observerBootId` is live. A local
restart invalidates all prior-boot admissions/proofs until re-observed. Replicated
readers validate the signed wall-clock window and current origin boot id from presence;
they never restart freshness from receipt time. Accepted skew is bounded by the
existing machine-skew signal, and uncertainty expires proof rather than extending it.

The pool reports `mutual: true` only when fresh A→B and B→A records exist for the
same active pair, pairing epoch, current generations, and live observer boot ids. A cannot mint B→A. Proofs replicate through
the coherence journal as signed observations, while the merged read re-validates
signatures and freshness.

### 5. Creation/enrollment integration

Agent creation ensures the local SSH identity immediately. When a new machine joins
an existing agent, pairing completion triggers key advert exchange, peer admission
reconciliation, and both directional probes. Enrollment has explicit substates
`paired → ssh-bootstrap → ssh-proving → ready`. For a declared multi-machine
employee-role agent, `ready` requires fresh proofs in both directions. The work runs
through the already authenticated mesh; the user never handles a key or command.

Single-machine creation remains ready after generating its local identity: there is
no peer direction to prove. When the second machine enrolls, both existing and new
machines enter the SSH bootstrap transaction.

Bootstrap explicitly rides the already-built, non-SSH signed MeshRpc delivery paths:
direct peer HTTP when reachable, otherwise the existing authenticated relay/proxy.
Both machines must first demonstrate bidirectional command delivery on one of those
paths. SSH is never used to bootstrap itself. If either control-plane direction is
unavailable, enrollment remains `ssh-bootstrap-blocked` and no admission is minted.

### 6. Continuous verification and bounded self-heal

`MutualSshHealthController` runs on the existing multi-machine health cadence with
jitter. It is a detector and remediator, not the authority for routing. Every 60
seconds it refreshes proofs nearing expiry; the default proof freshness is 5 minutes.

Recoverable failures first invoke these idempotent actions in order:

1. refresh signed endpoint/key adverts;
2. reconcile the target's peer admission lease through MeshRpc;
3. rotate the source's dedicated key if local integrity fails, using bounded overlap;
4. probe the next authenticated endpoint candidate.

Brakes: `max-attempts: 4`, `max-wall-clock: 120s`, exponential backoff with jitter,
dedupe key `(source,target,pairingEpoch,observerBootId,clientGeneration,hostGeneration,episode)`, circuit breaker after 3 failed
episodes in 15 minutes, and `max-notification-latency: 120s`. Audit entries contain
fingerprint suffixes and error classes, never keys, raw challenges, usernames, home
paths, or full addresses. A host-key change is security-critical: quarantine that
endpoint and notify immediately while other authenticated endpoints continue.

Key overlap is at most 10 minutes and at most two generations. The old generation is
removed when both new directional proofs exist or when the ceiling expires, whichever
comes first; expiry never restores the corrupt key, it leaves the direction unproved.
The controller evaluates only changed/unhealthy pairs on ordinary ticks, caps probe
concurrency at four, and sweeps all active pairs once per freshness window. This
bounds the unavoidable O(N²) pair matrix without skipping a direction.

Default support is 10 active machines (90 directed proofs). Configuration validation
requires `N×(N−1)×healthProbeDeadline/concurrency < freshnessWindow`; at defaults,
`10×9×8s/4 = 180s < 300s`. An impossible
required-role configuration fails startup, while optional mode disables mutual
claims. Pools above 10 must explicitly raise concurrency (maximum 32) or freshness
(maximum 15 minutes) while satisfying that bound. A global work bucket, round-robin
pair scheduler, and 25% healthy-probe reserve prevent a fleet outage from starving
refreshes; exhaustion reports degraded and mints no new proof.
The required-role error says the exact machine count, computed sweep time, freshness
budget, and safe automatically computed settings; the agent applies a valid setting
within published maxima without operator CLI work. If no valid setting exists,
readiness remains blocked while all previously ready single-machine behavior stays
available. Optional agents continue running with `mutual:false` and the same precise
diagnostic rather than failing startup.

If the endpoint cannot bind any authenticated/private address, the controller
reallocates one port and re-advertises once. After exhausting bounded repair, it
records `blocked: no-ssh-reachable-address`; it does not bind publicly, weaken host-
key checks, request a password, or fabricate readiness. The existing authenticated
mesh is the bootstrap/control plane, not proof of SSH health: an SSH proof succeeds
only after an actual SSH handshake and subsystem challenge traverses the advertised
endpoint.

### 7. Read and audit surfaces

`GET /machines/ssh-health?scope=pool` returns pair-level mutual status plus each
direction's freshness, generation, selected endpoint class, last failure class, and
self-heal state. It never returns key bodies or raw endpoint addresses. The Machines
dashboard renders “Instar SSH subsystem verified”, “repairing”, or a precise blocked reason.
Only the elected one-voice machine may raise a user-facing notice, and only after the
self-heal gate described above except for immediate host-key-change security alerts.

## Decision points touched

| Decision point | Classification | Floor / justification |
|---|---|---|
| Accept a bootstrap advert | `invariant` | Signature principal, schema, expiry, pairing membership, and allowlisted endpoint provenance are enumerable security invariants. Invalid input is rejected. |
| Admit/remove a peer public key | `invariant` | Desired leases are exactly active paired peers' current+bounded-overlap client generations and current pairing epoch. |
| Declare a direction verified | `invariant` | A fresh signed challenge response with pinned host key and matching identities either exists or does not. |
| Declare a pair mutual | `invariant` | Requires both fresh directional records for current pairing epoch, generations, and observer boot ids; no competing semantic signals. |
| Select probe endpoint | `invariant` | The finite candidate order is authenticated endpoint provenance, then observed health, with bounded attempts and no-proof fallback. There is no semantic tradeoff or irreversible action. |
| Escalate a recoverable failure | `invariant` | Self-heal must be attempted and exhausted or latency ceiling reached. Security-class host-key changes notify immediately. |

## Signal vs authority

Probe results are structured signals. They do not reroute sessions, grant pairing,
or change machine ownership. Existing transport selection consumes health signals.
Key admission and proof validity are narrow cryptographic invariants, valid
deterministic authorities under `docs/signal-vs-authority.md`.

## Multi-machine posture

- Dedicated client private key: **machine-local BY DESIGN**.
  `machine-local-justification: physical-credential-locality`
- Public adverts and directional proof records: **replicated** through signed
  coherence-journal records.
- Pool health: **proxied-on-read** by `?scope=pool`, merging signed records.
- SSH endpoint host key, peer admission store, and known-host pins: **machine-local BY DESIGN**.
  `machine-local-justification: physical-credential-locality`
- Audit: machine-local append log plus pool-scoped scrubbed summary.

Notices use one-voice gating. Replicated proofs survive conversation movement. No URL
is generated.

## Frontloaded Decisions

1. Instar's SSH endpoint exposes only a restricted Instar RPC subsystem rather than
   silently granting an interactive operator shell.
2. Bootstrap rides only an already verified Instar pairing; it cannot precede or
   replace pairing.
3. Instar owns an unprivileged restricted SSH endpoint, so OS Remote Login and sudo
   are not prerequisites; no reachable private/Tailscale address is an honest block.
4. A changed host key is security-critical and quarantined immediately.
5. The feature ships dark, then dry-run observation, then dev-agent live, and only
   becomes an employee-role readiness requirement after real two-machine proof.

## Open questions

*(none)*

## Acceptance criteria

1. Fresh-host test begins with neither machine having an Instar SSH key; creation
   generates both without input and never prints private material.
2. Real two-host test proves A→B and B→A from their respective processes.
3. One directional failure keeps `mutual:false`; one-sided evidence cannot promote it.
4. Deleting a peer admission entry is automatically repaired over MeshRpc and
   mutual status returns before the latency ceiling.
5. Local client-key corruption rotates its independent generation with bounded
   overlap and restores both proofs without an admission gap.
6. Host-key substitution quarantines the endpoint and immediately surfaces a
   security event; it never accepts `StrictHostKeyChecking=no`.
7. Revoking a machine invalidates its proofs immediately, terminates reachable active
   sessions, and refuses authentication on a peer disconnected during revocation no
   later than the five-minute admission lease expiry.
8. Existing personal SSH keys, config, known-hosts, and `authorized_keys` remain
   byte-identical through every reconcile and rollback case.
9. Tests cover transport × direction × lifecycle: first boot, healthy refresh,
   missing key, missing admission, endpoint drift, host-key drift, peer revoke,
   concurrent reconcile, and controller restart mid-rotation.
10. A real Mini+Laptop artifact records source-local proof logs for both directions,
    current generations, self-heal evidence, and zero operator action.
11. A peer clock jump cannot extend proof freshness; current-generation proofs expire
    by observer-local deadlines.
12. A ten-machine simulated-network test proves bounded concurrency, complete 90-
    direction coverage, global outage budgets, healthy-probe reserve, and no
    starvation across repeated refresh windows using measured worst-case probes.
13. Planned host rotation, corrupt-host recovery, replayed old adverts, and attacker
    substitution prove monotonic generation fencing and quarantine promotion rules.
14. Rollback during `ssh-proving` with active sessions restores pre-feature readiness,
    drains sessions, closes listeners, and leaves personal SSH state unchanged.
15. The real asymmetric-start test proves both bootstrap commands traverse the named
    non-SSH control plane before either SSH direction becomes healthy.
16. Revoke→re-pair replay, delayed coherence replay, and process restart tests prove
    old epochs/boot ids fail closed and receipt never refreshes a proof.
17. The ten-machine timeout-path test uses the full 8-second probe deadline and still
    completes its 90 directions inside the five-minute freshness window.
18. Sleep/wake, firewall-denied connect, VPN route churn, and port collision map to
    stable non-security blocked reasons and recover when the underlying path returns.

## Rollout

1. Land data types, atomic managers, proof protocol, conformance fixture, and read
   surface behind `multiMachine.mutualSsh.enabled` hard-dark.
2. Enable dry-run on the development agent: generate identities, allocate the bound
   endpoint, and report would-admit/would-probe without accepting peer sessions.
3. Enable reconciliation on the real Mini+Laptop pair and capture the acceptance
   artifact, including deliberate deletion and repair.
4. Promote to default-on for development agents.
5. In a separate audited flip, make fresh employee-role multi-machine enrollment
   require mutual Instar SSH-subsystem proof. Existing fleet installations migrate non-blockingly and
   become required only after a successful bootstrap epoch.

Rollback first disables the readiness requirement, then stops new subsystem work,
drains or terminates active sessions within 10 seconds, closes listeners, and finally
retires admission state. This ordering restores pre-feature enrollment before taking
the proof source away. Dedicated
keys and audit records may remain inert for forensic continuity; an explicit cleanup
migration can remove them after the rollback window. Existing operator SSH
configuration is untouched because it was never mutated.

## Build plan

- `src/core/MachineSshIdentity.ts`
- `src/core/MachineSshEndpoint.ts`
- `src/core/SshPeerAdmissionStore.ts`
- `src/core/MutualSshVerifier.ts`
- `src/core/MutualSshHealthController.ts`
- MeshRpc command schemas and server wiring
- coherence-journal proof kind and pool read
- creation/pairing lifecycle wiring
- configuration types, dev-gate registry, migration defaults
- Machines dashboard status
- unit, integration, adversarial, and real two-machine acceptance harness
- a lint/conformance ratchet requiring both directions for any transport labeled
  `mutual`

## Evidence required before merge

- Unit and integration suites green.
- Security/adversarial tests for key injection, forbidden SSH channel requests,
  stale/replayed adverts, host-key substitution, public-bind refusal, and cross-agent
  key confusion.
- Self-action convergence test proves bounded attempts, settled healthy state,
  flapping breaker, and latency backstop.
- Real two-machine run demonstrating keyless creation, mutual proof, injected
  asymmetric break, automatic repair, and renewed mutual proof.
