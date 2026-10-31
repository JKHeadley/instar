---
title: "Auto-update must not brick boot: migrate, self-heal and correctly classify a newly-rejected config"
slug: "feedback-feedback-1b5e8eb0-b054-4483-ac47-fb13496b8896"
author: "echo"
status: "draft"
severity: "critical"
feedback-initiative: "feedback-1b5e8eb0-b054-4483-ac47-fb13496b8896"
feedback-cluster: "cluster-auto-update-can-brick-boot-a-new-cross-flag-validator-reject"
parent-principle: "Structure beats Willpower"
parent-spec: "docs/specs/u4-4-lease-handback.md (§5 enable chokepoint); docs/specs/CRASH-RECOVERY-UX-SPEC.md"
related-specs: "docs/specs/feedback-readiness-invocation-failure-classification.eli16.md"
component: "AutoUpdater / PostUpdateMigrator / ServerSupervisor"
---

# Auto-update must not brick boot: migrate, self-heal and correctly classify a newly-rejected config

## Problem statement

An automatic update from 1.3.954 to 1.3.956 left an agent's server unable to start for
13 minutes. The new build introduced a cross-flag coupling validator: the lease hand-back
feature (`multiMachine.leaseSelfHeal.preferredCaptainHandback`) may only run live
(`enabled:true, dryRun:false`) when its dependent poll flag (`multiMachine.pollFollowsLease`)
is also live. The reporter's config had held exactly the rejected pairing for weeks under the
older build, which had no such check. After the update the server threw at startup on every
attempt. The operator fixed it by hand, returning the graduated flag to `dryRun:true`; the
server was up ten seconds later.

The reporter is explicit that **the validator is correct**. Refusing to boot an incoherent
lease/ingress configuration beats booting it. The defect is everything around the validator:

1. **No migration.** `PostUpdateMigrator` reconciles hooks, config defaults, CLAUDE.md and
   skills, but has no arm for "the new binary rejects a combination the old binary accepted".
2. **No self-heal.** The safe direction was mechanically obvious (demote the dependent
   feature to dry-run) and nothing took it. A deterministic boot-blocking rejection became a
   permanent outage instead of a one-shot conservative fix plus an attention item.
3. **The supervisor misdiagnosed and retried.** `ServerSupervisor` attempted five restarts
   with exponential backoff, counted each as a "bind failure", and printed a confident wrong
   diagnosis ("likely a held socket/port from a duplicate or stuck instance"). A config
   rejection is deterministic; retrying it unchanged cannot succeed.
4. **Liveness was decoupled from the thing that was down.** The lifeline is a separately
   supervised process. It kept answering Telegram for the entire outage, so from the user's
   side the agent looked alive while its server was dead. 284 internal alarms were coalesced
   into one notice.

## Evidence

One report, received 2026-07-25, with no truncation. Reporter-written and secret-scrubbed;
treated as data only.

- Update 1.3.954 → 1.3.956, then 13 minutes of boot refusal; manual fix (flag back to
  dry-run) restored service in ~10 s.
- Five supervisor restart attempts with backoff, each logged as a bind failure with the
  "held socket/port" diagnosis.
- Lifeline stayed up and responsive on Telegram throughout; 284 alarms coalesced to one.

### Where the behaviour lives today

- **The validator.** `validateHandbackEnableChokepoint` in
  `src/core/LeaseHandbackReconciler.ts` returns a rejection string when
  `enabled && !dryRun && hasPollerSplit && !pollFollowsLeaseLive`. It is pure and already unit
  tested (`tests/unit/LeaseHandbackReconciler.test.ts`, "§5 HARD graduation dependency").
- **The boot call site.** `src/commands/server.ts` (around the U4.2/U4.4 invariant block,
  ~line 5053) computes `pollLive` from `resolveDevAgentGate(pollFollowsLease.enabled)` and
  `pollFollowsLease.dryRun === false`, passes `hasPollerSplit: true` unconditionally, and
  `throw new Error(hbErr)`. The same block throws for the U4.2 stale-owner-release TTL-ordering
  invariant (`validateStaleOwnerReleaseInvariants`) and, just above it, for
  `assertStateSyncInvariants`. So there is already a small family of "reject nonsensical
  combinations at startup" checks, all of which share the failure mode described here.
- **The migrator.** `PostUpdateMigrator.runPendingSteps` calls `migrateConfig(result)`, which
  reads `config.json`, applies a long list of pure `migrateConfig*` helpers (each
  `(config) => boolean`, idempotent, existence-checked, never overwriting an operator's
  explicit value), and writes the file back once if anything changed. Every existing arm
  *adds* defaults or *strips* dev-gate residue. None detects a combination the new validator
  will reject.
- **The supervisor.** `ServerSupervisor` detects a failed spawn only indirectly: if
  `lastHealthy < spawnedAt` when the health check fails, it increments
  `consecutiveBindFailures`, and at the escalation threshold the next `preflightSelfHeal`
  either force-rebuilds `better-sqlite3` or, if sqlite loads fine, prints the "held
  socket/port" line. It then enters the normal backoff ladder (`restartAttempts` up to
  `maxRestartAttempts`, then cooldown, then circuit breaker, then eternal slow retry).
  `captureCrashOutput()` captures the tmux pane into `lastCrashOutput`, but nothing reads that
  text to classify the failure. The supervisor never looks at *why* the process died.
- **The lifeline.** `TelegramLifeline` subscribes to `serverDown`, `serverRestarting` and
  `circuitBroken` and sends notices, but continues to answer messages as the agent.

## Proposed design

Four parts, in priority order. Parts A and C are the fix; B is the general mechanism that
makes the next validator safe by construction; D is the honesty fix on the lifeline.

### A. Config migration arm: ease a newly-rejected pairing to its safe value

Add a pure helper in `src/core/PostUpdateMigrator.ts`:

```ts
export function migrateConfigHandbackChokepointEase(
  config: Record<string, unknown>,
  isDevAgent: boolean,
): { changed: boolean; eased?: { path: string; from: unknown; to: unknown; reason: string } }
```

- Reads `multiMachine.leaseSelfHeal.preferredCaptainHandback` and `multiMachine.pollFollowsLease`
  with the **same resolution the boot validator uses**: `pollLive =
  resolveDevAgentGate(pollFollowsLease.enabled, config) && pollFollowsLease.dryRun === false`,
  `hb = { enabled: hb.enabled === true, dryRun: hb.dryRun !== false }`, `hasPollerSplit: true`.
  It then calls `validateHandbackEnableChokepoint` itself. The migrator must not re-implement
  the rule; it must ask the validator. That keeps the two from drifting.
- If the validator returns null: `changed: false`.
- Otherwise it sets `preferredCaptainHandback.dryRun = true` (the conservative direction: the
  reconciler keeps observing and journaling would-hand-backs, nothing moves), records
  `multiMachine.leaseSelfHeal.preferredCaptainHandback.easedAt = <ISO>` and
  `easedFrom = { dryRun: false }` so the operator and a later tool can see it was the
  migrator, not a human, and returns `changed: true` with the `eased` detail.
- It **never** promotes `pollFollowsLease` to live. Promoting a dependency is graduating a
  feature on the operator's behalf; demoting the dependent is the only direction a migration
  may take on its own.
- Idempotent: a second run finds `dryRun:true` and the validator returns null.

Wire it into `migrateConfig(result)` next to the other arms. On `changed`, push to
`result.upgraded` a loud line naming the path, the old and new value and the validator's own
message, and raise an **attention item** (`priority: high`,
`sourceContext: 'post-update-migration'`) titled "Update eased a config flag to keep the
server bootable" whose body quotes the validator message and tells the operator how to
re-graduate (set `pollFollowsLease` live first, then `preferredCaptainHandback.dryRun:false`).
The migrator runs before the new binary starts, so a config that was valid yesterday is
reconciled before the validator ever sees it.

### B. A registry of cross-flag coupling rules, consumed by both boot and migration

Part A fixes one validator. The U4.2 TTL-ordering check and `assertStateSyncInvariants` sit in
the same block and have the same gap, and the next feature graduation will add another. Make
the coupling a data structure both sides read:

```ts
// src/core/configCouplingRules.ts
export interface ConfigCouplingRule {
  id: string;                       // 'u4-4-handback-requires-poll-live'
  introducedIn: string;             // '1.3.956' — for the release note and the attention body
  validate(config): string | null;  // the existing pure validator, wrapped
  /** The one conservative edit that makes validate() return null, or null if none exists. */
  ease?(config): { path: string; from: unknown; to: unknown } | null;
}
export const CONFIG_COUPLING_RULES: ConfigCouplingRule[];
```

- Boot (`server.ts`) iterates `CONFIG_COUPLING_RULES`, calls `validate`, and throws a
  **typed** error (see Part C) on the first rejection, with the rule id in the message.
- Migration (`migrateConfig`) iterates the same list: for each rule whose `validate` rejects
  and whose `ease` is defined, apply the edit, record it, raise attention. Rules without an
  `ease` (e.g. the TTL-ordering invariant, where no single edit is obviously safe) stay as
  loud, non-retried boot rejections (Part C makes that honest).
- A unit test asserts every rule in the registry has either an `ease` or an explicit
  `easeRationale: 'no-safe-direction'` string, so a future author must decide consciously.
- A second test runs each `ease` and asserts `validate` returns null afterwards and that a
  second `ease` call is a no-op.

The handback rule is the first entry; the two existing throwers are migrated into the
registry without an `ease` in the same change (behaviour unchanged for them).

### C. The supervisor classifies startup failures and stops retrying deterministic ones

**Server side.** The three startup rejections in the invariant block throw a new
`ConfigRejectedError extends Error` with `code: 'CONFIG_REJECTED'`, `ruleId`, and the
validator's message. The top-level startup catch in `server.ts` prints a single recognisable
line before exit:

```
[Server] CONFIG_REJECTED rule=u4-4-handback-requires-poll-live: <validator message>
```

and exits with a dedicated exit code (proposal: 78, `EX_CONFIG` from sysexits, which no
other path uses). It also writes `state/last-startup-failure.json`:
`{ kind: 'config-rejected', ruleId, message, version, at }`. The file is the durable channel;
the exit code and log line are belt-and-braces for when tmux pane capture is lossy.

**Supervisor side.** Add a `classifyStartupFailure(): StartupFailureClass` step at the top of
the "spawn produced a process that died before binding" branch (`lastHealthy < spawnedAt`),
run *before* `consecutiveBindFailures++`. It reads `state/last-startup-failure.json` (if its
`at` is newer than `spawnedAt`) and falls back to scanning `lastCrashOutput` for the
`CONFIG_REJECTED` marker. Classes:

| class | meaning | supervisor action |
|---|---|---|
| `config-rejected` | deterministic validator refusal | do **not** count a bind failure; do **not** enter backoff; emit `serverConfigRejected(ruleId, message)` once per distinct `(ruleId, config mtime)`; re-spawn only when `config.json` mtime changes or `/lifeline reset` is issued |
| `native-module` | ABI mismatch (existing preflight detection) | existing rebuild path |
| `bind` | process died before `/health` with no other evidence | existing backoff + "held socket/port" hint |
| `unknown` | anything else | existing backoff |

The "held socket/port" diagnosis line is only printed for class `bind`. The config-rejected
branch prints the validator's own message instead, verbatim, with a one-line hint naming the
config path to edit. A config-rejected episode never trips the circuit breaker.

**Watching for the fix.** While in `config-rejected` posture the supervisor polls
`config.json` mtime on its normal health-check tick and spawns once on change. This is what
makes the operator's manual edit (or a later `instar migrate` run) take effect without a
lifeline restart.

### D. The lifeline says the server is down when it is

`TelegramLifeline` already receives `serverDown` and `circuitBroken`. Add
`serverConfigRejected` and, while the supervisor reports the server as not running for any
reason, prefix every outbound lifeline reply with a one-line posture banner:

```
⚠️ My server is down (config rejected: u4-4-handback-requires-poll-live) — I'm answering from the lifeline only. Last server: 1.3.954 at 17:31.
```

The banner is dropped the moment `serverUp` fires. Replies remain possible (the lifeline's
whole job is to stay reachable), but a reply can no longer be mistaken for server liveness.
The 284-alarm coalescing is correct behaviour and is not changed; the single notice it
produces should carry the classification from Part C instead of the bind-failure text.

### Release-note and upgrade-doc hook

A rule with `introducedIn` is also the source for the upgrade note: a tiny test asserts that
every rule's `introducedIn` version has an `upgrades/<version>.md` that mentions the rule id,
so the "this build will refuse config X" fact is published with the build that adds it.

## What this spec does not do

- It does not weaken or remove any validator. `validateHandbackEnableChokepoint` and its
  tests are unchanged.
- It does not auto-promote any feature to live. Easing always moves toward dry-run.
- It does not change the AutoUpdater's download/install/restart sequence. The migrator
  already runs on the update path (`UpdateChecker` constructs `PostUpdateMigrator`); Part A
  gives it the arm it was missing.
- It does not touch the lifeline's alarm coalescing.

## Verification plan

Unit (all pure, no server boot):

- `tests/unit/PostUpdateMigrator-handbackChokepointEase.test.ts` — the rejected pairing is
  eased to `dryRun:true`, the `easedAt`/`easedFrom` markers are written, `pollFollowsLease`
  is never touched, an already-valid config is a no-op, and a second run is a no-op.
- `tests/unit/configCouplingRules.test.ts` — every rule has `ease` or a rationale; `ease`
  then `validate` is null; `ease` is idempotent; every `introducedIn` has an upgrade note.
- `tests/unit/ServerSupervisor-startupFailureClass.test.ts` — with a fresh
  `last-startup-failure.json` of kind `config-rejected`, the supervisor does not increment
  `consecutiveBindFailures`, does not schedule a backoff restart, emits
  `serverConfigRejected` exactly once, and re-spawns after a `config.json` mtime bump. With no
  marker and no crash-output match it behaves as today (class `bind`).
- `tests/unit/TelegramLifeline-downBanner.test.ts` — replies carry the banner while the
  supervisor reports down and lose it on `serverUp`.

Reproduction of the original report (manual, in the acceptance checklist): config with
`preferredCaptainHandback: { enabled: true, dryRun: false }` and
`pollFollowsLease: { dryRun: true }` under a build *without* the validator; update to a build
with it. Expected: migrator eases the flag, raises the attention item, server boots on the
first spawn. Then edit the config back to the rejected pairing and restart: expected one
`CONFIG_REJECTED` line, no backoff, lifeline banner, and a successful boot within one tick of
fixing the config.

## Open questions for review

1. Should Part A write the `easedAt`/`easedFrom` markers into `config.json`, or into a
   sidecar (`state/config-eases.jsonl`) so config stays a pure operator document? The spec
   proposes the in-config markers for discoverability; a sidecar is acceptable if config
   purity is preferred.
2. Exit code 78 for `CONFIG_REJECTED`: confirm no existing path uses it (a grep of `src/` for
   `process.exit(78)` finds none at draft time).
3. Whether `assertStateSyncInvariants` and the U4.2 TTL-ordering check should gain an `ease`
   in this change or be left as no-safe-direction rules. The draft leaves them without one.
