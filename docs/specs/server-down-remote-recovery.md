---
title: "Server-down remote recovery on every agent machine"
slug: "server-down-remote-recovery"
author: "Echo"
status: draft
parent-principle: "The Agent Is Always Reachable — A Guaranteed Reachability Floor"
approved: true
approval-basis: "Justin's Echo Bugs directive, 2026-11-05 03:38 UTC; only constitution changes require a separate approval"
review-convergence: "2026-11-05T04:08:05.343Z"
review-iterations: 6
review-completed-at: "2026-11-05T04:08:05.343Z"
review-report: "docs/specs/reports/server-down-remote-recovery-convergence.md"
cross-model-review: "degraded-all-rounds"
cross-model-review-reason: "codex-cli timed out on four reviewable bodies (three gpt-5.5, one gpt-6-astra); gemini-cli unauthenticated"
single-run-completable: true
frontloaded-decisions: 6
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Server-down remote recovery on every agent machine

## Problem statement

At 01:41 UTC Echo's laptop server was repeatedly killed during slow boot. Other Echo machines could observe the outage but could not repair it. The existing Instar mutual SSH subsystem was dry-run and its restricted endpoint was in the server process; the standing real-sshd key was also dry-run. The peer HTTP and desktop paths require a live target server. Relay connectivity on another machine carries messages, not command execution on a down target. No pre-incident invariant established two independently working server-down routes, and no health alert showed that absence before the outage.

The requirement is agent-wide: each machine with a repair-capable peer must continuously retain two independently proven, least-privilege routes by which *that same agent's* other machines can diagnose and repair it with the main server stopped. A single-machine agent must truthfully report that peer recovery is unavailable; it cannot claim redundancy.

## Existing foundation and evidence

| Foundation | Already present | Gap for this requirement |
|---|---|---|
| `mutual-ssh-autobootstrap` | Per `(agent,machine)` Ed25519 identity, pinned host key, bidirectional proof, `MutualSshHealthController`, `/machines/ssh-health`; optional managed real-sshd key | Both `mutualSsh` and `peerExecution` default to dev-gated dry-run. The restricted endpoint is started by `src/commands/server.ts`, so it dies with the server. A standing sshd route is one candidate only. |
| Machine self-assertion | Signed machine identity and escrowed recovery design | Identity continuity does not itself grant a repair route. Its protected trust roots must remain local. |
| `/channels`, `/capability-registry` | Registry-first discoverability | `mutual-ssh` reports `working` when its runtime merely constructed; that is not a server-down repair proof. `peer-http` needs the target server. Neither endpoint counts independent recovery routes. |
| Machine self-maintenance and wedge probe | Pool health/read-only watch; wedge detection dry-run | They neither repair a remote machine nor observe a server that never finishes booting. |
| Cold-Start Lifeline Fallback | Deterministic notice when a topic session cannot start | Requires a running ingress/lifeline; it does not establish peer machine access. |
| Mesh Rope Health | Probe and partition-alert framework | Dev-gated; it measures mesh ropes, not two server-down repair paths. |
| Native remote desktop (#2564) | Desktop diagnostics, guided setup and routed input | The target's agent server and desktop helper path are required; it is not a server-down repair channel. |
| Self-Unblock Before Escalating | Existing blocker/attempt ladder | Reuse it to record attempted safe repair and missing human grants before operator escalation. |
| Mesh Self Heal G2/G3 | Poller failure detection and fenced spawn behavior | They address serving and duplicate sessions, not a stopped target's host repair. |

Source evidence: `src/config/ConfigDefaults.ts` mutualSsh/peerExecution; `src/commands/server.ts` mutualSshRuntime.start; `src/core/MutualSshRuntime.ts`; `src/core/instarChannels.ts`; `src/server/routes.ts` `/machines/ssh-health` and `/channels`; `docs/specs/MESH-SELF-HEAL-{SPEC,G2-BUILD,G3-BUILD}.md`.

## Proposed design

### 1. Recovery route contract

A route counts only after a *source peer* completes a time-bounded, target-bound, audited no-op against that target. Proof names source and target machine IDs, pairing epoch, **host** boot identity (not the main server's observer boot ID), credential generation, transport failure domain, supervisor identity, method allowed, observed time and expiry. At runtime health requires fresh no-op proof (at most five minutes old); missing proof is `unknown` until a failed probe establishes `broken`. Fleet release requires reversible repair proof on throwaway agents running on two real machines. Each production machine's admission uses only a non-disruptive target-specific status/diagnostics probe and managed-grant inventory. No destructive production repair is run merely to graduate it. A server's own assertion, constructed socket, key file, open port, ping, or advert does not count.

Two routes must have distinct target admission processes, supervisor lifecycles, authentication keys and transport failure domains. B's outbound relay subscription is its admission endpoint; it need not listen on a public port. They may use the same operating system and host network stack; shared host failure is reported as a common-mode limitation. A route that shares sshd, its key, its port, or the main server's process with another route cannot satisfy the pair invariant. A route is usable only from one of the same agent's currently paired machines. A relay or another agent is never a repair principal.

### 2. Extend the existing standing SSH route (A)

Prepare `multiMachine.peerExecution` on each eligible paired machine by migrating its managed grant, then prove execution **through the final forced-command wrapper with the target main server stopped on a throwaway agent**. **Before enabling route A**, migrate `PeerAuthorizedKeys` to parse managed lines with SSH options and atomically replace every old bare `instar-peer-access` key with a forced-command line; `has`, reconcile, revoke and revokeUnknown must recognize both formats, and an old bare grant makes readiness false until removed. Rollback revokes managed grants and never restores a bare grant. Constrain new `authorized_keys` entries to an Instar-owned forced-command wrapper that permits only `status`, `collect-diagnostics`, `stop-instar-server`, `hold-owned-instar-watchdog`, `start-instar-server`, and `restore`; refuse shell, PTY, port forwarding, file transfer, arbitrary command, arbitrary path and environment injection. Do not grant an unrestricted account shell. The wrapper authenticates a signed, one-time operation envelope, validates the same agent and paired machine from its own durable signed pairing/revocation snapshot, enforces expiry and idempotency, and logs principal, target, action and result without secrets. Existing operator lines are untouched. The separate host sshd stays up when Instar's server is stopped. If sshd is unavailable, route A is blocked, not assumed working. Route A uses direct host routing, preferring the local network and using an already enrolled Tailscale address when hosts are not on one LAN; it does not require the main server or cloud relay.

### 3. Add a separate recovery listener (B)

Run a minimal Instar recovery sidecar as a separately supervised login service, with its own executable entry point, process ID and per-machine key. It starts before the main server and is never killed by the main server's restart logic. It maintains its **own outbound HTTPS connection to the Threadline relay** under a recovery-only machine identity, separate from the main server's relay session and credential; the relay transports signed opaque frames and has no repair authority. A source peer sends through that relay, so B remains available if direct SSH routing, sshd or its network path is blocked. The relay must support target-machine routing, delivery acknowledgement and replay protection before this route can graduate; a generic agent message is insufficient. Use the existing MachineAuth pairing ledger for principal scope, but a **different** sidecar admission key and a pinned listener key. It accepts only authenticated paired machines of the *same agent*, only the fixed repair verbs above, and never executes a client-supplied command or path. Setup proves that A works with B's relay session disabled and B works with A's *network path* blocked, not merely its key or port. Network path independence is recorded from observed egress interface/next hop and relay route, not configuration labels.

Both wrapper and sidecar read a durable, target-local signed allowlist/revocation ledger maintained while the main server is healthy and also updated by the independently connected sidecar. An enrolled peer cannot sign its own admission. The source of new grants is a phone-confirmed operator grant or an existing verified pairing ceremony; the source of a revoke is the same authority, delivered through **either** working recovery route when the main server is down. A revoke is monotone and takes precedence over older grants.

The **operator control plane** is a new recovery-checkpoint service in the existing `src/threadline/relay/RelayServer.ts` deployment, with durable state in `RegistryStore`. It has a **distinct delegated signing key per agent**, each held in the relay host's secret manager and never in agent state or a wire payload. The signed Instar release pins a certification root that can attest a per-agent checkpoint public key but **cannot itself issue an admission checkpoint**. Existing agents receive that root through `PostUpdateMigrator`; new agents through `init`. Each machine stores only its own agent's certified key, checks the certificate's `agentId`, and refuses any checkpoint whose `agentId` differs. Per-agent key rotation/revocation is a monotone signed transition distributed to that agent's machines; global certification-root rotation requires a release carrying both roots and a dual-signed transition. No checkpoint key, grant or admission credential is shared between agents. A checkpoint is issued only for an owner-approved grant or previously enrolled same-agent machine principal, after the service has consumed owner-device-signed grant/revocation events and their monotone ledger sequence. Every renewal is a fresh signed checkpoint with `agentId`, monotone per-target version, authority-issued time, current revocation digest, target machine ID and target-supplied one-time challenge. The target accepts only a higher version and a fresh authority time within a bounded skew; replay of an old checkpoint, a peer's re-signature, or local self-signing cannot extend admission. A peer can carry the checkpoint over A or B but cannot mint it. A challenge response cannot add a new grant without the separate owner approval or pairing ceremony. Deployment and live verification of this service, root pinning, durable restart recovery and phone revoke ingestion are **hard prerequisites** for either route's graduation; a local stub or unsigned relay response cannot satisfy them.

The offline grant lease lasts 24 hours after the last accepted authority checkpoint. Both A and B reject admission after the same horizon; clock rollback or a stale local clock cannot lengthen it (persist the last monotonic wall/boot anchor and treat uncertainty as expired). A healthy sidecar may continue renewing while the main server is down by contacting that control plane over its independent relay connection. If the control plane is unreachable for 24 hours, admission fails closed even if peers can still reach the target; health reports `recovery-lease-expired`. The absolute-always goal has this explicit authority-partition limit. The phone UI shows an unacknowledged revoke as pending and its maximum remaining exposure (no longer than 24 hours), then escalates if no target receipt arrives. It never falsely claims immediate revocation under partition.

The sidecar does not require the target's main server, peer HTTP, the main server's Threadline session, Telegram, desktop or another agent. Its own supervisor has finite restart attempts, backoff and a fixed memory/CPU budget; repeated sidecar kills appear in host health and trigger the route A recovery path. Its supervisor reports start, exit and repeated kills to a small append-only local log. Its storage and identity remain agent/machine-local; no private key crosses machines.

### 4. Safe repair playbook

The caller first collects bounded boot and supervisor diagnostics. A detected kill loop pauses the offending *Instar-owned* watchdog/supervisor rule only through a reversible, expiry-bound hold, starts the server once, checks health, and automatically restores the exact original rule state after the server stays healthy or after a maximum hold. The hold is written as an atomic transaction naming the exact owned rule and original state; a separately supervised host timer restores it even if both the sidecar and main server die. It cannot modify another agent's or operator's watchdog. For an external watchdog, report its owner and exact observed kill evidence, then stop autonomous mutation and request the owner through a phone-completable action; no guessed `kill -9` source is disabled. Require target-side lock, fencing epoch, max attempts and cooldown so two peers cannot race or create another loop. Audit every transition. Route A and B invoke the same bounded playbook; neither has a broader action set.

### 5. Setup, proof and health

On pairing/enrollment and after updates, setup provisions both routes, verifies both directions from each source peer, records distinct failure domains, and refuses to label enrollment `recovery-ready` until two proofs exist. This does not block the agent from serving ordinary work during rollout; it creates an explicit degraded recovery posture. Reprove on a five-minute cadence, after reboot, key rotation, endpoint change and any failed probe. Probe scheduling must have bounded concurrency, jitter and a healthy reserve. A pair with zero/one fresh route is degraded before an incident; stale/unknown is never healthy. Pool health and the existing `/machines/ssh-health`, `/channels` and `/capability-registry` expose a per-machine `serverDownRecovery` summary, including route A/B states, proof age, tested source, common dependencies and plain missing-step reason. Do not expose keys, endpoint addresses or raw command output in an operator view.

Self-heal missing managed admissions, expired signed adverts, sidecar process drift and transient route errors before notifying. Use the existing hardware-local `SelfHealGate` for **target-local** sidecar drift. Source-peer route observations feed one pool episode keyed `(agent,target,route,paired-epoch,failure-class)` in the existing fenced pool coordinator; the lowest-ID live eligible peer owns the first repair attempt, and a bounded lease expiry hands it to the next live peer if the owner disappears. The same durable episode key governs notification at the send chokepoint, so handoff cannot create one notice per observer. For the target-local gate: severity `recoverable` for drift, `security` for key mismatch/foreign principal/revocation failure; at most four attempts in two minutes with 1/2/4 second backoff, then a 15-minute breaker; two heal/rebreak cycles in an hour exhaust the episode until an operator or fresh changed cause re-arms it; five-minute notification latency ceiling. Record each idempotent action, compensation and audit in `logs/server-down-recovery.jsonl`; use BlockerLedger/Self-Unblock to surface any human step.

The action table is closed: a missing managed SSH admission is reconciled by the target's `PeerAuthorizedKeys` from the signed grant; compensation restores only a previously validated restricted line, otherwise revokes the new managed line and leaves A degraded, **never** a legacy bare key. A stale advert is refreshed by its signing target through an existing authenticated route, with last known advert retained only as untrusted diagnostic; sidecar process drift is restarted by its host supervisor under the finite budget, with stop/rollback to the previous binary; a transient route failure is reprobed after backoff with no config mutation; a revocation failure refuses new admission on that route and retries delivery through the other route. If neither route works, no source peer acts on the target; the episode becomes attention. Security failures alert immediately and refuse admission. During an active outage, stale proof is marked `unknown` and the repair episode owns notification, preventing a second route-loss alert. If every peer is down, the surviving independent lifeline/host monitor surfaces the loss when it returns; do not claim an impossible immediate alert. A first key or host service grant has a guided, phone-completable approval card showing exact scope and a Revoke control, never a shell command. The operator can revoke either route separately from a phone. Revocation propagates through signed state, removes managed keys/listener admission, and is verified from a peer; the UI must say `pending on target` until target acknowledgement, never `revoked` merely because the request was submitted.

### 6. Update and rollout

Add defaults, config validation, sidecar install and supervisor migration, capability index, generated reference and agent-awareness text through `PostUpdateMigrator`, not `init` alone. Existing and new agents receive the same setup evaluator. Ship inert, then follow the test-agent → development-agent → fleet maturation ladder. Fleet release qualification requires the full destructive live matrix on throwaway agents on two real machines. Each production machine graduates only after its own non-disruptive route proof and managed-grant inventory; no destructive scenario is run on a production agent. Migrate one route at a time with explicit rollback and no mutation of existing operator SSH lines or other agents' accounts. A downgrade stops the sidecar, removes only Instar-managed grants and retains audit/proof history. A dry-run probe is never described as operational redundancy.

## Multi-machine posture

Proof summaries and route health are unified through signed pool state, with freshness and machine ID retained. Enrollment state is unified. Private keys, listener admission, host supervisor state and audit logs are machine-local.

machine-local-justification: physical-credential-locality — the private keys and local admission snapshot stay on their issuing machine.
machine-local-justification: hardware-bound-resource — supervisor process and host listener state are physically bound to their machine.

## Decision points touched

| Decision | Classification | Floor and authority |
|---|---|---|
| Count route as ready | invariant | Only fresh target-bound source proof with independent listener/key/path counts; missing evidence fails closed. |
| Admit repair command | invariant | Same-agent paired principal, signed one-time envelope, fixed verb, expiry, fencing and target lock; target sidecar/SSH wrapper is final authority. |
| Choose route A or B | invariant | This is finite transport failover over two equivalent fixed-action endpoints, with no semantic or competing human signals: choose a currently proven route, try the other on failure, and make no remote mutation when both fail. |
| Escalate to person | judgment-candidate | Try bounded automatic repair and wait through transient grace; human-only grants or exhausted routes create one deduplicated plain notice. BlockerLedger/Self-Unblock is arbiter; fallback is no risky mutation plus attention. |
| Pause a kill-loop source | invariant | Only an identified Instar-owned rule, expiry-bound and reversible; external/unknown owner is hold-and-escalate. |

## Testing and acceptance

1. Unit: key scope, forced-command parser, signed envelopes, expiry/replay, target lock, fencing, revocation, failure-domain validator, stale/unknown proof, audit scrubbing and external-watchdog refusal.
2. Integration: update existing and create new throwaway agents on two actual machines; verify two distinct listeners/keys/routes, current proof on both hosts, pool health, dark-to-live transitions, mobile approval/revoke and rollback.
3. Live destructive matrix, **throwaway agents only**: stop the target main server; diagnose and restore through A; repeat with A's direct network path blocked through B; run a target main-server kill loop and repair through A, then block A's direct network path and repair through B. Separately kill the target sidecar repeatedly and verify its finite supervisor/backoff, the host-timer watchdog hold restoration and A still working; block B's relay path and prove A still works. Use a real pair of machines with disposable agent identities and no production account or operator channel. Capture process IDs, probe receipts, before/after health, server logs, route audit, and exact rollback. A simulated second machine is insufficient. Repeat after update and reboot.
4. Security exercise: foreign-agent key, stale pairing epoch, changed host key, revoked principal, spoofed endpoint, old envelope, arbitrary command and port-forward requests all fail; a crash during hold restores the watchdog policy by deadline.

## Maturation plan

- **test-agent-live:** on two real machines with throwaway agent identities, pass the full server-stop, route-A-blocked, kill-loop, sidecar-kill, revoke and rollback matrix; record target-bound receipts and zero unauthorized admission.
- **dev-agent-live:** after the throwaway proof, enable non-disruptive setup and route probes on the development agent for 48 hours; no production server is stopped, and any host lacking two current proofs stays visibly degraded.
- **fleet:** graduate only after the control-plane signer, phone grant/revoke, update migration and both repair transports pass live qualification; then enroll each existing or new machine with its own non-disruptive proofs and managed-grant audit.
- **graduation criterion:** every eligible test-agent target has two distinct fresh server-down route proofs and succeeds through A and B with the other path blocked; no bare managed SSH key remains; revocation, timeout, watchdog restoration and per-agent isolation all pass. A count of zero tests is a failure.
- **dark-window:** 14 days from merge to a fleet decision. If criteria are unmet, record the failed evidence and a dated next review in the feature ladder; do not silently leave it dark.
- **ladder:** multiMachine.serverDownRecovery

## Open questions

*(none)*

## Frontloaded Decisions

1. Route A is a restricted real-sshd forced-command grant, with bare managed keys removed before readiness.
2. Route B is an independently supervised recovery sidecar using its own HTTPS connection and machine identity over the Threadline relay; the relay's new recovery frames have no execution authority.
3. A route requires source-observed, target-bound proof; the fleet's destructive qualification occurs only on throwaway identities, while each production host receives a non-disruptive admission probe.
4. Offline admission leases last 24 hours and fail closed afterward; pending revocation is visible on the phone until target acknowledgement, with the remaining exposure stated.
5. Only an exact Instar-owned watchdog rule can receive a bounded hold, restored by an independent host timer. Other agents' and operator rules are outside autonomous repair authority.
6. The control plane certifies a separate recovery-checkpoint key for every agent; no one key can mint access for multiple agents.
