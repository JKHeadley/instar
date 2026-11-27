---
title: Machine Operations Reference
description: Source responsibilities and limits for machine evidence, ownership, transport, worktrees, backups, and maintenance.
---


This reference follows the source components that answer five operational questions: what was actually observed, who may act, how another machine can be reached, what work must be preserved, and what a recovery result proves. It covers implementations in this checkout, not a promise that every optional feature is enabled on every agent. Source links identify the implementation to consult before changing a live machine.

The coverage inventory calls PascalCase source files “classes.” Some entries below are function modules instead. Neither a filename nor a healthy status response establishes that a component's production dependencies, permissions, or rollout switches are ready.

## Evidence Before Action

### MachineEvidenceStore

[MachineEvidenceStore](https://github.com/JKHeadley/instar/blob/main/src/core/MachineEvidenceStore.ts) preserves the last direct contact with a peer, including the receiver's receipt time and optional reported load. This lets a restarted server display old evidence instead of implying it has never seen that machine. Saved evidence is display-only: loading it does not refresh its age, mark a peer online, or make that machine eligible for placement. Records use the registry identity rather than an identity claimed in the heartbeat body.

### MachineHeartbeat

[MachineHeartbeat](https://github.com/JKHeadley/instar/blob/main/src/core/MachineHeartbeat.ts) writes a machine-health record for project ownership and answers whether another owner's heartbeat is stale. Its defaults are a thirty-minute write interval and a forty-eight-hour staleness threshold. Git synchronization and the caller's ownership-transfer convergence wait are separate responsibilities. Do not substitute this relatively slow project-owner signal for the live pool's short-cadence health readings.

### PeerPresencePuller

[PeerPresencePuller](https://github.com/JKHeadley/instar/blob/main/src/core/PeerPresencePuller.ts) obtains peer capacity through the signed mesh `session-status` read, so a paired machine can be visible without permission to push the shared Git repository. A failed pull records no fresh capacity; existing evidence ages rather than becoming a fabricated offline or healthy reading. Optional journal and other state-advertisement handling depends on the corresponding injected replication dependencies.

### MachineLoadBroker

[MachineLoadBroker](https://github.com/JKHeadley/instar/blob/main/src/core/MachineLoadBroker.ts) is a pure accounting module, not a background sampler. It compares agents' claimed footprints with independently supplied operating-system measurements and computes load and isolation findings. An under-reported footprint can produce a suspect-overloaded result and reduced placement weight. The caller must supply measurements and consume the result; this module does not itself move sessions or inspect the operating system.

### MachineLoadAssessor

[MachineLoadAssessor](https://github.com/JKHeadley/instar/blob/main/src/core/MachineLoadAssessor.ts) labels disagreements between a machine's own load report and the outside view, then checks the later outcome for calibration. It uses bounded, structured evidence and attributed model calls under its live configuration, cooldown, and daily budget controls. Its result is advisory logging: it does not admit work, change placement, or restart a machine. Its model assessment is not a replacement for current operating-system evidence.

### PoolActivityView

[PoolActivityView](https://github.com/JKHeadley/instar/blob/main/src/core/PoolActivityView.ts) builds the pooled parallel-work view from local activity and remote journal observations. Local running state and replica-derived remote running state have different provenance; remote rows carry staleness and can carry low confidence when a read bound was reached. Possible overlap is a diagnostic signal, including recent-move context, not permission to terminate either instance. The module exports view-building functions rather than a controlling service.

### PeerVisibilityGuard

[PeerVisibilityGuard](https://github.com/JKHeadley/instar/blob/main/src/core/PeerVisibilityGuard.ts) reports incomplete revocation metadata and peers that remain missing beyond its disappearance grace period. It coalesces notices and bounds repeated flapping episodes. A populated revocation reason is only a hygiene field, not authenticated proof that revocation was authorized. The guard's warnings must not be used to justify silently restoring or revoking a peer.

### PeerFailureLogGate

[PeerFailureLogGate](https://github.com/JKHeadley/instar/blob/main/src/core/PeerFailureLogGate.ts) limits log amplification without slowing the underlying connection attempts. It emits the first failure, coarse reminders at a configurable failure count, and a recovery line when success ends the streak. Steady successes and intermediate failures remain quiet. Suppressed log lines do not mean probes stopped or that a peer recovered; retained counters are per peer and operation in this process.

## Leases, Placement, and Recovery Evidence

### FencedLease

[FencedLease](https://github.com/JKHeadley/instar/blob/main/src/core/FencedLease.ts) supplies signing, epoch arithmetic, acquisition checks, replay checks, and fencing decisions. Monotonic epochs establish authority; clock time helps decide when a different holder may attempt acquisition, but does not grant ownership by itself. A coordinator and transport must actually perform and persist the compare-and-swap. This pure logic does not stop an operating-system process or make a network partition disappear.

### KeyedLease

[KeyedLease](https://github.com/JKHeadley/instar/blob/main/src/core/KeyedLease.ts) provides a separate per-key lock for work such as a topic fold. The signed key, holder, role, and generation prevent one topic's lock from authorizing another topic's transaction. Local and Git-backed stores use compare-and-swap discipline and generation floors; handover advances the generation rather than reacquiring a still-held lock. This is not a replacement for the machine's serving lease, and damaged or missing lock data must not be interpreted as permission to reuse an old generation.

### LeaseAcquisitionTrigger

[LeaseAcquisitionTrigger](https://github.com/JKHeadley/instar/blob/main/src/core/LeaseAcquisitionTrigger.ts) detects the transition from not holding the serving lease to holding it, including the first held observation after boot. It invokes the existing reconciliation callback once for that acquisition. Unreadable lease state skips the immediate callback; it does not invent ownership. The ordinary reconciler cadence remains necessary, and the callback's own fenced operations still enforce authority.

### LeaseContinuity

[LeaseContinuity](https://github.com/JKHeadley/instar/blob/main/src/core/LeaseContinuity.ts) contains restart-window arithmetic, signed continuity-file handling, boot measurements, and restart-budget persistence. Its constants and helpers let the coordinator account for slow boots and define when a restart episode has ended. The module does not contact peers or decide that a machine may restart. A continuity record therefore documents an authorized coordination episode; it is not a standalone command to retain leadership.

### LeaseHandbackReconciler

[LeaseHandbackReconciler](https://github.com/JKHeadley/instar/blob/main/src/core/LeaseHandbackReconciler.ts) evaluates a configured preferred holder after failover. It requires sustained preferred-machine health and an appropriate work boundary before offering a holder-signed handback. Missing health defers the handback, and an unset preference preserves sticky ownership. The claim-before-release ordering matters: if the preferred machine never confirms the claim, the current holder keeps holding rather than creating a period with no holder.

### SessionPoolLocalClaim

[SessionPoolLocalClaim](https://github.com/JKHeadley/instar/blob/main/src/core/SessionPoolLocalClaim.ts) confirms a local placement only after the actual local-delivery tail succeeds. Its function acts on a `placing` row owned by this machine; active traffic and another machine's rows are no-ops. Routing fall-through alone is not evidence that injection or spawning succeeded. Callers must invoke confirmation at the successful delivery boundary, not merely when they select a local route.

### StaleOwnerReleaseEngine

[StaleOwnerReleaseEngine](https://github.com/JKHeadley/instar/blob/main/src/core/StaleOwnerReleaseEngine.ts) strengthens the existing reconciler's claim path with evidence that an owner is genuinely unavailable. The checks include observer-aged death evidence, authenticated and fresh multi-transport information, quorum, claimant connectivity, and a fresh owner-evidence mirror. Ambiguity refuses the takeover. It uses the reconciler's compare-and-swap funnel rather than introducing a second ownership writer; an annotation about a claim is not ownership state.

### SessionPoolE2EResultStore

[SessionPoolE2EResultStore](https://github.com/JKHeadley/instar/blob/main/src/core/SessionPoolE2EResultStore.ts) stores signed, append-only rollout outcomes tied to a stage and commit. Readers can distinguish a green result for today's code from a result earned by an older build. A new or reversed outcome adds a row instead of overwriting the history. The store records evidence supplied by a harness; its existence does not prove that a failover check ran on this deployment.

### SessionPoolFailoverRunner

[SessionPoolFailoverRunner](https://github.com/JKHeadley/instar/blob/main/src/core/SessionPoolFailoverRunner.ts) runs an injected failover check and records a genuine green or red outcome into the rollout evidence store. A thrown check records neither verdict: an infrastructure error is not proof of success or of a failover regression. The runner is inert when disabled and does not itself implement the two-machine check. Verify the injected check and evidence reference before treating a result as real-hardware proof.

### SessionPoolRolloutDriver

[SessionPoolRolloutDriver](https://github.com/JKHeadley/instar/blob/main/src/core/SessionPoolRolloutDriver.ts) drives the existing stage advancer on a cadence. An enabled tick reconciles regression first, then attempts at most one advance toward the configured operator ceiling, still subject to the existing commit-bound evidence gate. Disabled means no reconciliation or advance; an invalid ceiling resolves to dark. This component neither supplies missing failover evidence nor authorizes a rollout beyond the configured ceiling.

### SingleMachineFailoverGapDetector

[SingleMachineFailoverGapDetector](https://github.com/JKHeadley/instar/blob/main/src/monitoring/SingleMachineFailoverGapDetector.ts) raises a deduplicated diagnostic when active autonomous work has no online peer available to take over. It distinguishes an unconfigured multi-machine setup from a configured pool whose peers are offline. The detector is signal-only: it does not provision another machine, move a conversation, or block ongoing work. A warning means redundancy is missing, not that the current machine has failed.

### TelegramPollOwnerLease

[TelegramPollOwnerLease](https://github.com/JKHeadley/instar/blob/main/src/lifeline/TelegramPollOwnerLease.ts) coordinates the local lifeline and server pollers for one bot token. The lifeline refreshes a small file containing a token hash, process identity, and heartbeat; a server finding a matching live owner stays send-only. Missing, stale, or mismatched records permit the normal server behavior. This local record prevents the two local pollers competing; it is not the cross-machine serving lease and must not be treated as proof that another machine has stepped down.

### NativeLeaseDurability

[NativeLeaseDurability](https://github.com/JKHeadley/instar/blob/main/src/core/NativeLeaseDurability.ts) is a function module implementing the opt-in native administration durability barrier. It verifies a regular, non-symlink lease file, synchronizes the file and directory chain when needed, and checks that the reread lease matches the expected record. Failures throw instead of claiming persistence. Ordinary lease persistence is unchanged, and this barrier does not grant acquisition authority or create a lease.

### NativeDecommissionLeasePermit

[NativeDecommissionLeasePermit](https://github.com/JKHeadley/instar/blob/main/src/core/NativeDecommissionLeasePermit.ts) represents continuation of native administration after real durable revocations and survivor receipts exist. Construction verifies the supplied store, receipts, floors, membership, and writer scope; subsequent use rechecks current local evidence. It cannot revoke members, manufacture an operator's consent, or invent a fencing floor. Treat the permit as evidence-bound continuation, never as a reusable general administrative credential.

## Connections, Messages, and Private Views

### HttpLeaseTransport

[HttpLeaseTransport](https://github.com/JKHeadley/instar/blob/main/src/core/HttpLeaseTransport.ts) carries signed lease traffic over the existing machine-authenticated HTTP channel. It tracks observed records, replay-related nonce information, and recent reachability for the coordinator. The network path accelerates coordination while the durable store remains a separate concern. A reachable URL or unsigned successful HTTP response is not, by itself, an authenticated lease acknowledgment.

### RopeRecoveryProber

[RopeRecoveryProber](https://github.com/JKHeadley/instar/blob/main/src/core/RopeRecoveryProber.ts) gives a failed connection another chance even when ordinary traffic consistently selects a healthy alternative. It attaches bounded, signed canary probes to the existing lease-pull cadence and reports outcomes to the shared endpoint resolver. It owns probe scheduling, not a second health authority. Dry-run can still send harmless probes, but records shadow recovery without changing the resolver's health record; exhausted episodes keep probing at the bounded floor cadence.

### CrossMachineRelayQueue

[CrossMachineRelayQueue](https://github.com/JKHeadley/instar/blob/main/src/messaging/CrossMachineRelayQueue.ts) serializes a message's pass over one target machine's guarded addresses. A verified signed acknowledgment establishes receipt, and a verified negative acknowledgment establishes refusal. Unsigned responses and timeouts do not establish who answered or whether delivery occurred. This first-phase queue does one address pass without an away-machine retry service; a timeout can mean “may have arrived,” so a caller must inspect the outcome before resending.

### GitSyncTransport

[GitSyncTransport](https://github.com/JKHeadley/instar/blob/main/src/messaging/GitSyncTransport.ts) is the function module for the Git-synchronized message path: pick up incoming envelopes, verify signatures, deduplicate, inspect outbound queues, and clean up delivery records. It relies on Git synchronization to move the directories between machines; these helpers do not establish that a peer has received the newest repository state. Message pickup and cleanup must be judged against the message store's actual delivery state, not just the presence of a file.

### PeerAuthorizedKeys

[PeerAuthorizedKeys](https://github.com/JKHeadley/instar/blob/main/src/core/PeerAuthorizedKeys.ts) manages namespaced peer entries in the supplied account home's `.ssh/authorized_keys`. Reconciliation replaces the managed entry for that agent and machine while retaining other entries; revocation targets the same managed namespace. It uses locking and refuses symlinked write targets, and its dry-run computes a change without applying it. It does not authorize enrollment on its own or make an arbitrary supplied public key trustworthy.

### PoolLinkAssertion

[PoolLinkAssertion](https://github.com/JKHeadley/instar/blob/main/src/core/PoolLinkAssertion.ts) defines pure construction and verification of the signed user-authentication assertion used when a fronting machine proxies a private view. The signature binds issuer, expected holder, resource, method, and expiry. It attests that the user authenticated at the edge without forwarding the raw credential; the holder still applies its own authorization. Crypto, peer-key lookup, clock, and replay storage must be supplied by the caller.

### PoolLinkJtiStore

[PoolLinkJtiStore](https://github.com/JKHeadley/instar/blob/main/src/core/PoolLinkJtiStore.ts) holds consumed assertion identifiers on the content-holding machine so normal restarts need not reopen the replay window. Retention and entry limits bound storage. Persistence failure is logged while the in-memory set continues protecting the current process; durable replay protection is therefore degraded after such a failure. Capacity eviction and missing or damaged stored state are operational limits, not a reason to claim unlimited replay history.

### PoolViewProxy

[PoolViewProxy](https://github.com/JKHeadley/instar/blob/main/src/core/PoolViewProxy.ts) resolves which machine holds a private view and proxies through the injected transport. It briefly memoizes ownership, bounds concurrent proxy requests, and distinguishes unavailable holders from content not found. Private response bodies are not cached at the fronting machine. A view moved within the memo window can temporarily resolve to the old holder; load shedding and holder-offline outcomes should remain visible rather than being presented as a missing document.

## Workspaces and Stored Recovery Material

### InstarWorktreeManager

[InstarWorktreeManager](https://github.com/JKHeadley/instar/blob/main/src/core/InstarWorktreeManager.ts) is the creation module behind `instar worktree create`. It resolves the canonical repository and agent home, checks branch and path containment, creates an isolated worktree, sets agent identity, wires dependencies and hooks, and records the creation. A checkout that exists after a failed hook-setup step is not yet a successful setup. It does not decide that old branches or unfinished work are disposable.

### WorktreeManager

[WorktreeManager](https://github.com/JKHeadley/instar/blob/main/src/core/WorktreeManager.ts) manages topic bindings, exclusive session locks, fencing, signed commit trailers, and reconciliation for parallel development. Machine-local bindings and locks differ from the signed path-free records that can be synchronized. The local pre-commit checks, commit-message signature, and origin-side verification have distinct responsibilities. A missing local lock does not establish that the topic's work was merged or that another machine's state may be overwritten.

### WorktreeKeyVault

[WorktreeKeyVault](https://github.com/JKHeadley/instar/blob/main/src/core/WorktreeKeyVault.ts) stores the signing and HMAC material used by worktree isolation. It selects platform-backed storage where available and supports an explicitly allowed, passphrase-protected encrypted headless fallback. Headless access without the required passphrase is an error. Callers must handle unavailable storage and must not replace it with a plaintext key dump; the vault does not grant a session authority to use another agent's identity.

### AgentWorktreeDetector

[AgentWorktreeDetector](https://github.com/JKHeadley/instar/blob/main/src/core/AgentWorktreeDetector.ts) is a read-only startup detection module for worktrees outside registered agents' safe `.worktrees` locations. It emits one aggregated attention item, or a fallback record, rather than one notice per path. Path location is the detection rule; the creation ledger is not an authorization allowlist. Detection neither blocks use nor moves or deletes the worktree, so cleanup requires a separate evidence-based decision.

### WorktreeMonitor

[WorktreeMonitor](https://github.com/JKHeadley/instar/blob/main/src/monitoring/WorktreeMonitor.ts) discovers orphaned or stale worktrees through post-session and periodic scans. Its saved fingerprints and reminder interval prevent an unchanged set from causing a notice on every scan. Reports can include changed-file information, but a warning is not proof that the underlying branch is safe to remove. Inspect uncommitted work, unpushed commits, and actual users of a directory before any destructive cleanup.

### BackupManager

[BackupManager](https://github.com/JKHeadley/instar/blob/main/src/core/BackupManager.ts) creates timestamped agent-state snapshots, validates snapshot identifiers and manifest integrity, and enforces configured retention. Restore checks the active-session guard and takes a safety snapshot before copying selected data back. Secret-bearing configuration and protected paths are excluded; requested include paths do not override those exclusions. These snapshots cover selected agent state, not a complete clone of every repository, worktree, or machine, and a local snapshot is not proof of an independent off-machine copy.

### JobTriageBackupCheck

[JobTriageBackupCheck](https://github.com/JKHeadley/instar/blob/main/src/scheduler/JobTriageBackupCheck.ts) is a backup *reviewer* for script-job supervision, not a filesystem backup component. During a Jev outage it uses a separately bounded provider to reread a sample of routine classifications, tracks considered and unread runs, and can report disagreements. Healthy Jev or disabled triage means no backup-model call. Sample disagreements do not change calibration bands or prove that every routine run was reviewed.

## Desktop Access and Machine Maintenance

### DesktopHelperRetention

[DesktopHelperRetention](https://github.com/JKHeadley/instar/blob/main/src/core/DesktopHelperRetention.ts) keeps one protected Mac desktop-helper copy at a stable per-user path, separate from an agent's replaceable installation. Source and binary hashes distinguish a real source change from an unchanged-source rebuild; unsafe or unusable retained copies fall back to the packaged helper with a named reason. It reports permission-changing replacement rather than pretending the old grant follows new bytes. A retained binary cannot grant Screen Recording or Accessibility permission on behalf of the user.

### MachineLockStateReader

[MachineLockStateReader](https://github.com/JKHeadley/instar/blob/main/src/core/MachineLockStateReader.ts) gathers read-only lock inputs and delegates interpretation to the lock-state table. On macOS it uses the helper's probe and screen-lock policy, with a short cache and single in-flight read to avoid stacking probes. Linux is not applicable in this reader and Windows coverage remains unknown. Unknown or stale inputs are not proof that a screen is unlocked; the probe captures no screen image and sends no input.

### WindowsDesktopLocalTransport

[WindowsDesktopLocalTransport](https://github.com/JKHeadley/instar/blob/main/src/core/WindowsDesktopLocalTransport.ts) bridges WSL to the existing interactive Windows companion through bounded PowerShell-local requests. Separate serialized relay lanes keep screen capture from delaying input. The module validates the action, reply type, encoded body, and size bounds; it opens no new listener. It depends on a functioning Windows companion and interop path, and successful transport alone does not establish an unlocked desktop or permission to control it.

### MachineCoherenceSentinel

[MachineCoherenceSentinel](https://github.com/JKHeadley/instar/blob/main/src/monitoring/MachineCoherenceSentinel.ts) compares live pool advertisements for version, protocol, manifest, and resolved-flag differences. Its confirmation and episode state produce deduplicated effects for the elected reporting path; callers drain those effects. The implementation also exposes proposal approval and status entry points under their existing checks. Comparison is evidence, not a command to equalize configurations or restart machines: verify the feature's switches, episode state, and consuming wiring before expecting action.

### MachineWedgeJudge

[MachineWedgeJudge](https://github.com/JKHeadley/instar/blob/main/src/monitoring/MachineWedgeJudge.ts) is the module that builds and strictly parses a bounded maintenance judgment over structured evidence. The injected model sees fixed categories, ages, uptime, blockers, and session counts rather than window titles or raw command output. Missing providers, unusable answers, and timeout paths cannot establish that a restart happened. Its result is a proposal consumed by the monitor; available action implementations and live configuration still constrain what can happen.

### MachineWedgeNotice

[MachineWedgeNotice](https://github.com/JKHeadley/instar/blob/main/src/monitoring/MachineWedgeNotice.ts) builds the fixed-wording dry-run attention notice for a confirmed maintenance episode. Episode deduplication, self-action governor limits, and upstream monitor brakes bound emission. The control is off unless the caller enables the dry-run notice path. The notice describes the available behavior rather than exposing a nonfunctional restart button; seeing one does not mean maintenance actions ran.

## Applying the Reference During an Incident

Start with fresh direct evidence and retain its receipt time. Distinguish missing observations from a negative result, and distinguish a transport failure from a credential refusal. Check the owning lease and topic placement before moving work. Treat overlap, stale ownership, and worktree warnings as evidence for the existing authority, not as permission to kill processes or remove files.

For a proposed recovery, require the specific durable record and a result for the current deployment. Record separately what was observed, what was authorized, what was executed, and what was verified afterward. Keep unique work and recovery copies until their custody is established; neither a coverage entry nor this reference changes an installed machine's defaults or permissions.
