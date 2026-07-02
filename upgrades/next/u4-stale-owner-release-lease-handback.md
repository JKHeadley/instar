<!-- bump: minor -->

## What Changed

Two mesh self-healing reconcilers land dark, on one shared lease seam
(specs: `docs/specs/u4-2-stale-owner-release.md` + `docs/specs/u4-4-lease-handback.md`,
both converged + approved).

**U4.2 — stale-owner release** (`multiMachine.sessionPool.staleOwnerRelease`,
dev-gated: live-in-dryRun on a development agent, dark on the fleet). The
CMT-1786 auto-failover, built as the evidence upgrade to the ownership
reconciler's Case C: when a topic's owner machine is provably dead/dark, the
serving-lease holder force-claims its topics behind a fail-closed five-evidence
bar (observer-stamped death staleness — the named `server.ts` rewire off the
self-reported clock; unreachability on every owner-authenticated transport;
quorum; a claimant self-connectivity proof; side-effect recency over a
provably-fresh replicated mirror). New replicated `topic-claim-annotation`
kind carries the pin suspension, the per-topic claim budget/backoff, and the
operator's declined-demote across lease movement (epoch-independent — never an
ownership CAS). Detection/escalation is quorum-hosted so a no-lease-holder mesh
still reaches the operator; claims stay lease-holder-only. Decision trace at
`logs/stale-owner-release.jsonl`; soak telemetry at
`GET /pool/stale-owner-release`.

**U4.4 — lease hand-back** (`multiMachine.leaseSelfHeal.preferredCaptainHandback`,
hard-dark everywhere: action-bearing lease authority, DARK_GATE_EXCLUSIONS like
its F2/F3/L3 siblings). The missing reconciler for the F4
`preferredAwakeMachineId` preference: after a failover the lease is handed BACK
to the preferred captain once continuously healthy (10m hysteresis), at a clean
boundary (bounded 2h deferral; queued inbound drained before step-down),
claim-before-release via a holder-signed, epoch-bound, TTL-bounded, single-use
consent token on the new `handback-offer` mesh verb (holder-only RBAC) — a
failed claim leaves the holder holding, so zero-holder states are impossible by
construction. The human always wins: the operator-flip latch
(`POST /pool/lease-handback/latch`, PIN-gated clear) holds the reconciler fully
inert. Post-hand-back delivery canary; episode cap counts offers; hand-backs
feed the churn breaker. Boot refuses `dryRun:false` unless pollFollowsLease is
live (the lease/ingress-split chokepoint).

## What to Tell Your User

Nothing yet — both features ship dark and change nothing on your setup today.
When they graduate: if one of your machines ever dies with conversations on it,
I'll be able to take those conversations over safely on another machine instead
of leaving them stranded until you notice — and after a failover, serving will
drift back to the machine you prefer once it's genuinely healthy again, without
you running the manual flip. Any move I make will be logged, bounded, and
honest, and your manual choices always override the automation.

## Summary of New Capabilities

- `GET /pool/stale-owner-release` — U4.2 soak telemetry (attempts, dry-run
  would-claims, refusals by reason, evidence classes, P19 give-ups, probe
  breaker, open episodes). 503 while dark.
- `GET /pool/lease-handback` — U4.4 reconciler status + operator-latch
  visibility (honest `enabled:false` while hard-dark).
- `POST /pool/lease-handback/latch` — the operator-flip latch marker (the
  captain-flip playbook's POST step; suppresses automated hand-back).
- `DELETE /pool/lease-handback/latch` — PIN-gated early clear (re-enabling
  automation against a human decision requires the dashboard PIN).
- New replicated journal kind `topic-claim-annotation` (additive — old peers
  never sync it); new `handback-offer` MeshCommand (holder-only RBAC,
  fail-closed on legacy peers).
- Config: `multiMachine.sessionPool.staleOwnerRelease` (dev-gated,
  `enabled` omitted) + `multiMachine.leaseSelfHeal.preferredCaptainHandback`
  (`enabled:false`, `dryRun:true`); both G3 `loadBearing` in the guard
  manifest so a stalled dark posture classifies loudly.

## Evidence

Both features are dark, so the evidence is the three-tier suite + ratchets, all
green locally: 28 unit tests on the U4.2 evidence bar (both sides of every
predicate: reachable-on-one-transport refuses, single-rope/stale-advert/stale-
mirror classify ambiguity, bootstrap rule converges after a claimant restart,
budgets + declined-demote read from the replicated view), 19 on the
`topic-claim-annotation` store (strict clamps, HLC-highest-wins, epoch
independence), 20 on the hand-back reconciler (hysteresis, boundary, deferral
ceiling drain-before-step-down, claim-before-release failure matrix, latch and
churn/split-brain suppression, episode cap counting offers), 14 on the
FencedLease consent branch with real Ed25519 keys (absent/expired/replayed/
reused/wrong-target/wrong-epoch/forged all refuse to the byte-identical legacy
`held-by-live-peer`), 5 on the LeaseCoordinator consent claim
(`failed-handback-never-leaves-zero-holders`), 8 reconciler-integration tests
(engine supersedes legacy Case C; the `case-c-staleness-input-is-observer-stamped`
wiring ratchet proves the `routerReceivedAt` rewire in server.ts), 5 on
quorum-hosted stranded escalation, 8 integration route tests (503-dark, §2.9
counters advancing, PIN-gated latch clear), and 5 feature-alive E2E tests
through the real AgentServer (200-not-503; dry-run counters advance on a
synthetic episode/transition; dark → 503).
