# Server-down remote recovery: convergence report

## Outcome

The design converged after six internal review rounds. The final security and integration rounds found no change to what would be built. The 95-standard live conformance check returned zero findings on the final text. Cross-model review was attempted four times through codex-cli (three `gpt-5.5` attempts and one final `gpt-6-astra` attempt); each timed out, so outside-review assurance is degraded. This is a reviewed design, not a claim that either repair route works yet.

## ELI10 Overview

An agent's other machines need to repair one of its machines even when that machine's main Instar server is down. The plan uses two separate ways in: a restricted SSH command on the host, and a separately supervised recovery helper connected through a relay. Both are tested ahead of time. A machine with fewer than two working paths appears as degraded in health. The helper may briefly hold an Instar-owned watchdog rule; it cannot touch another agent's or the operator's watchdog.

Existing SSH pairing and health machinery is reused. The build must replace old unrestricted Instar-managed SSH grants, add the server-independent helper and grant control, and deliver phone controls for human grants and revocations. If the independent grant authority cannot issue a fresh checkpoint for 24 hours, both repair routes fail closed. That prevents an isolated target from accepting a key revoked elsewhere indefinitely.

## Original vs converged

The first draft named two routes but left security and deployment details open. Reviews made the direct SSH route a forced-command grant and required migration of existing bare keys before readiness. They made the second route a separately supervised relay client with a distinct key and network path. They added a per-agent checkpoint signer, replay-resistant grant renewal, bounded revocation exposure, a crash-safe timer for an Instar-owned watchdog hold, one pool-owned alert episode, and separate throwaway fleet qualification versus non-disruptive per-machine admission.

## Iteration Summary

| Round | Main design findings | Resolution |
|---|---|---|
| 1 | Unrestricted SSH grants; vague B transport; no offline revocation, repair bounds or crash-safe hold | Restricted grant, relay sidecar, lease, SelfHealGate bounds and host timer |
| 2 | Conflicting graduation tests; multiplied pool alerts; unsafe local lease renewal | Split qualification and host admission, fenced episode owner, external renewal |
| 3 | A peer could replay an old checkpoint | Monotone, challenge-bound checkpoint |
| 4 | Checkpoint authority unnamed; rollback could restore a bare key | Named relay service/trust bootstrap; restricted-only compensation |
| 5 | One checkpoint key could grant across agents | Per-agent delegated key and agent-bound verification |
| 6 | None from internal security or integration review | Converged |

Standards-Conformance Gate: the initial call returned 403 with the stale config token. A rerun using the active `INSTAR_AUTH_TOKEN` checked 95 standards and found two issues, then one issue on the next version. The final call checked 95 standards and found zero. Its parent-principle fit signal remained `weak` because host recovery extends beyond the session-focused reachability article. No constitution text is changed here.

Cross-model pass: `codex-cli:gpt-5.5` was detected as available. Three attempts with `gpt-5.5` and one on the tagged final body with `gpt-6-astra` each returned `degraded: timeout`. Gemini was detected as unauthenticated. The outside pass contributed no findings and is not counted as a successful review.

## Proportion

Tier 2+, security-sensitive, two new design files; six rounds used, at the tier cap. The review changed architecture and security behavior.

## Left behind

- Exact endpoint and schema names for the checkpoint service are build-level choices; signed fields and authority are fixed.
- Exact pool episode storage shape is a build-level choice; fenced owner, failover and send-time deduplication are fixed.
- The 24-hour authority-partition limit remains an accepted availability tradeoff against stale revoked access. Health and phone copy must surface it.

## Full findings catalog

Security/adversarial rounds found: unrestricted legacy managed SSH keys; forced-command parser/revocation mismatch; missing offline pairing and revoke rules; local self-renewal and peer replay; missing crash-independent watchdog restoration; insufficient network separation proof; compensation restoring a bare key; and a fleet-wide signing key. All changed the build and were resolved in the spec. The final security round was quiet.

Integration/scalability/decision rounds found: incomplete SelfHealGate bounds; vague route B transport and permissions; no sidecar-kill test; inconsistent fleet versus per-machine graduation; multiplied source-peer alert ownership; unspecified remediation actors; an SSH proof taken before the final wrapper; and undefined signer custody. All changed the build and were resolved in the spec. The final integration round was quiet.

The review used repository code and specs, notably PeerAuthorizedKeys, MutualSshRuntime, SelfHealGate, RelayServer, RegistryStore, ConfigDefaults, PostUpdateMigrator, machine reference notes, and existing SSH/bootstrap, mesh-self-heal and maintenance specs. No live repair was performed during convergence.

## Convergence verdict

Converged at round 6 under internal security and integration review and the live standards gate. Cross-model review was degraded by repeated timeouts. Working recovery still requires the build and throwaway-machine proof.
