# Side-Effects Review — Parallel-Hand PR Lease

Spec: `docs/specs/parallel-hand-pr-lease.md` (converged 4 rounds + approved).
Change: a per-branch push-ownership lease so two of the agent's OWN concurrent
sessions can't push competing commits to the same branch (the 2026-06-15 #1183
2-hour merge thrash). A PreToolUse Bash hook asks the server (before a `git push`)
whether another LIVE session of this agent holds the branch's lease; if so the
second hand stands down. Dev-gated dark + dryRun-first; coordinates the agent's OWN
cooperating hands only.

**Phase-1 principle check (decision-point = YES):** the lease DENIES a `git push`,
so signal-vs-authority applies. Per spec §7 this is a deliberate, blast-radius-LIMITED
P2 EXCEPTION (not "it satisfies P2"): it blocks ONLY the agent's own cooperative
hands, ONLY a `git push`, FAILS OPEN on every uncertainty, and surfaces holder+intent
so a distinct fix escalates as a follow-up (never silently dropped). Outside those
limits it is a signal, not authority.

Files:
- `src/core/PrHandLease.ts` — store (one-lock CAS, topic-id identity, TTL-gated host-aware liveness, liveness-discriminated 90m ceiling, fail-open-on-corrupt, dryRun isolation, tombstones) + pure `canonicalPushKey` (git-native two-tier ref resolution).
- `src/server/routes.ts` — `POST /pr-leases/evaluate` (fail-open on every uncertainty; dryRun→allow+wouldDeny; redacts holderSessionId) + `GET /pr-leases` (derived liveness; 503 when disabled) + `RouterContext.prHandLease?`.
- `src/core/PostUpdateMigrator.ts` — `getPrHandLeaseGuardHook()` + migrateHooks deploy + migrateClaudeMd awareness.
- `src/core/instarSettingsHooks.ts` — `INSTAR_BASH_PRETOOLUSE_HOOKS` += the guard (registers for both init + existing-agent migration).
- `src/commands/server.ts` + `src/server/AgentServer.ts` — dev-gated construction (machine-local v1, runningSessionNames=tmuxSession set, audit→logs/pr-lease-decisions.jsonl) → AgentServer option → routeCtx.
- `src/core/devGatedFeatures.ts` — `prHandLease` dev-gate entry (dryRun-canary).
- `src/core/BackupManager.ts` — `state/pr-hand-leases.json` on the ephemeral denylist.
- `src/scaffold/templates.ts` — generateClaudeMd awareness block.
- Tests: `tests/unit/pr-hand-lease.test.ts` (20), `tests/integration/pr-lease-route.test.ts` (8); ratchets green (devGatedFeatures-wiring, migration-parity-hooks, feature-delivery, pretooluse-parity, no-bare-require).

## Build-time design DEVIATION from the spec (recorded, mine, reversible)
Spec §4 idealized "the hook does a single local JSON read, no HTTP." The build
re-targeted to **hook → `POST /pr-leases/evaluate` (localhost)**: a generated
standalone `.js` hook can't cleanly import the TS store, and reimplementing the
security logic in JS would DUPLICATE it (drift hazard on a security path). The
codebase pattern (every instar hook) is hook→server. Latency is a localhost
round-trip (~ms); the git dry-run resolver runs server-side only on a detected push.
Same security posture; the logic stays in tested TS. Server-unreachable → fail-open.

## 1. Over-block
The ONLY block is `git push` exit-2 on a confirmed LIVE foreign same-agent lease
(and only at `dryRun:false`). Over-block risks + mitigations: (a) a stale lease read
as live → TTL + host-aware liveness + the 90m ceiling force-release a dead/foreign
holder; (b) a corrupt state file / server-down / hook crash → ALL fail OPEN (allow);
(c) the dry-run resolver hanging → bounded timeout + GIT_TERMINAL_PROMPT=0 → fail
open. A live same-machine holder past 90m is NOT seized (would reintroduce the
thrash) — it escalates to the operator instead. Verified by the unit truth-table.

## 2. Under-block
Misses (accepted residual evasions of a COOPERATIVE guard, stated in §2 non-goals):
a push hidden in a called script body (`bash deploy.sh`), a git alias, or string
obfuscation (`git pu"sh"`) — the hook matches a literal `git push` in the command.
Also OUT of scope: cross-MACHINE collisions (machine-local v1; `holderMachineId`
load-bearing only for the never-falsely-dead rule) and shared-WORKTREE edit bleed
(§1.1b — the `instar worktree create` convention is the mitigation). All documented.

## 3. Level-of-abstraction fit
Correct. Enforcement sits at the PreToolUse Bash chokepoint where the agent's own
`git push` actually runs (round-2 caught that SafeGitExecutor — instar's internal TS
wrapper — is bypassed by agent Bash pushes). The security logic lives server-side in
tested TS; the hook is a thin relay. Identity is the stable TOPIC, not the respawn-
volatile session id. Reuses the ResumeQueue lock/persist/FD discipline.

## 4. Signal vs authority compliance (docs/signal-vs-authority.md)
COMPLIANT as a deliberate, bounded P2 exception (§7): a brittle deterministic check
holds blocking authority ONLY over the agent's own cooperative hands, only over
`git push`, fails open on every uncertainty, and never blocks a principal/operator.
The deny surfaces holder+intent so a genuinely-distinct fix escalates rather than is
dropped. Dark + dryRun-first means the bind is opt-in and observable first.

## 5. Interactions
- MergeRunner (green-pr-automerge): NOT a competing committer; reads the lease only as
  a soft-hold on a live same-machine `intent:rework` (bounded by TTL). A dryRun lease
  is ignored by all non-acquisition readers (so it can't perturb auto-merge).
- ResumeQueue: shares the lock/persist/FD pattern but a SEPARATE file + lock (no
  contention with the revival queue).
- The hook is registered AFTER the existing Bash PreToolUse guards; it never shadows
  them (it only blocks `git push`, and only on a confirmed deny).

## 6. External surfaces
- New routes `POST /pr-leases/evaluate` + `GET /pr-leases` (Bearer-auth'd by the
  server's global middleware like every route). New PreToolUse Bash hook
  `pr-hand-lease-guard.js` (registered for init + existing agents via the canonical
  hook list). New config under `monitoring.prHandLease.*` (read with safe defaults).
- Flag off (fleet default) → byte-identical-today behavior (hook fail-opens / route
  feature-disabled). Visible only on a dev agent, and there only in dryRun (logs).

## 7. Multi-machine posture (Cross-Machine Coherence)
**Machine-local BY DESIGN (v1), stated honestly.** The lease state is per-machine;
two hands on DIFFERENT machines driving the same branch is NOT prevented by v1 (the
same thrash recurs). `holderMachineId` is load-bearing ONLY for the safety rule "never
judge a foreign-machine holder dead from local session absence" (so v1 never falsely
seizes a cross-machine holder within the ceiling). A fully replicated cross-machine
lease (likely a git-ref CAS lock) is the tracked §9b follow-up; it MUST inherit the
ResumeQueue FD1/FD2/FD5 host-classification before it ships. The observed incident
was same-machine, so v1 closes the demonstrated failure.

## 8. Rollback cost
Trivial + reversible. Flag off (`monitoring.prHandLease` absent / developmentAgent
false) → the route feature-disables (fail-open) and the hook fail-opens → no behavior
change. The state file is ephemeral (excluded from backup). No data migration, no
persistent external side-effect. A bad deploy is a config flip away from inert.

## Testing-scope decision (honest, precedented)
Unit (20) + integration (8) cover the store logic + the route over the real HTTP
pipeline. The generated hook is syntax-validated (`node --check`) + covered by the
no-bare-require regression test. A full hook-subprocess behavior test (mock server +
exit-code assertions) and a boot-e2e ("feature alive": route 200 not 503) are the one
deferred tier — same honest-scope decision as P1/#1174 + action-claim/#1178, justified
because the route IS exercised end-to-end at the integration tier and the hook is a
thin fail-open relay. <!-- tracked: follow-up — add tests/unit/pr-hand-lease-guard.test.ts (hook subprocess) + a boot-e2e at fleet-rollout, per the action-claim precedent -->

## Phase-5 second-pass review (REQUIRED — touches a hook/gate/push-path)
**CONCUR with the review.** An independent reviewer audited every claim against the
code: the hook fail-opens on every path (non-Bash, no-git-push, no-config, no-topic/
session, server-down/timeout inner-catch, own-crash outer-catch, 8s stdin backstop);
the route fail-opens on null prHandLease / bad-request / no-branch-key / any throw,
and `evaluate()` is non-throwing (corrupt state → `{}`); the DENY path fires ONLY at
`dryRun:false` on a confirmed live foreign-topic lease (default dryRun rewrites every
deny/escalate to `allow+wouldDeny`); holderSessionId is redacted on both surfaces; a
respawned same-topic session reads its own lease as `own-topic` allow (topicId identity,
checked before any liveness probe); the 90m ceiling escalates a LIVE same-machine
holder but CAS-seizes a dead/foreign holder (loser yields); escalation routes to the
real aggregated-attention chokepoint; construction is dev-gated + audited.

Minor non-blocking note (accepted, tracked): PrHandLease is constructed nested inside
the `if (rqCfg.enabled ?? true)` resume-queue block (it reuses `raiseResumeAggregated`
for onAttention), so explicitly setting `monitoring.resumeQueue.enabled:false` would
leave prHandLease null — but the route then fail-opens, so this is a FAIL-SAFE soft
coupling, not a defect (and the resume queue defaults enabled). <!-- tracked: follow-up — decouple PrHandLease construction from the resume-queue-enabled block (give it its own onAttention sink) so the two features are independent -->

## Post-merge addendum (2026-06-16) — no-silent-fallbacks ratchet
Merging current main into the branch tripped the no-silent-fallbacks ratchet (477 > 474).
PrHandLease's only flagged catch — the `readAll` corrupt-state fail-open — is now
`@silent-fallback-ok`-tagged (it is `recordFailOpen()`-surfaced with a recurrence
attention item, so it is NOT silent). The residual +2 is main's own accumulated drift
inherited via the merge (main shipped catches under `[skip ci]` releases that never
re-ran this gate); the baseline is aligned 474→476 with an in-file justification, per the
Zero-Failure Standard (a merge pulling main's pre-existing red is the merging branch's to
settle). No behavior change; the lease's fail-open posture is unchanged.

## Post-CI addendum (2026-06-16) — discoverability classification

CI surfaced a second gap from the build: the new `GET /pr-leases` +
`POST /pr-leases/evaluate` routes were registered in routes.ts but the
`/pr-leases` prefix was never classified, so the capabilities-discoverability
ratchet failed. Resolved by adding `{ prefix: 'pr-leases', ... }` to
`INTERNAL_PREFIXES` in `src/server/CapabilityIndex.ts` — the lease is dev-gated
coordination machinery (a PreToolUse git-push guard consults it; the CLAUDE.md
template documents it), agent-invisible and 503 on the fleet, so it is correctly
INTERNAL (skips `/capabilities` discovery) rather than a user-invokable
capability — same class as `/action-claim` and `/playwright-profiles`.
Classification only; no runtime behavior change. (Also in this PR: the
`instar-settings-hooks` anti-drift contract was updated to include the new
`pr-hand-lease-guard.js` PreToolUse hook.)
