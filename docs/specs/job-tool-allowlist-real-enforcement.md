---
title: "Job Tool-Allowlist Real Enforcement — the clamp authorizes but does not restrict; make it real behind a dark flag, and stop claiming otherwise until it is"
slug: job-tool-allowlist-real-enforcement
author: "echo"
parent-principle: "A Safety Control That Logs Enforcement While Enforcing Nothing Is Worse Than an Absent One"
sibling-principles: "Verify at the Consumer, Not the Producer (the clamp was verified at the manifest and the log line, never at the spawned argv); Structure > Willpower; Maturation Path — Every Feature Ships Enabled on Developer Agents (the real clamp must soak dark before the fleet); Bounded Blast Radius; Testing Integrity (a wiring-integrity test is the thing whose absence let this live)"
eli16-overview: job-tool-allowlist-real-enforcement.eli16.md
source-proposal: "EVO-008 (approved 2026-08-23)"
status: draft
review-convergence: pending
approved: false
depends-on: "claudeCodeHeadlessBuilder (src/core/frameworkSessionLaunch.ts:982 — unconditionally emits --dangerously-skip-permissions); claudeHeadlessExtraFlags (src/core/frameworkSessionLaunch.ts:1340-1354 — splices --allowedTools); headless splice site (src/core/SessionManager.ts:2982-2992, argv-shape comment at :2973); the CORRECT pattern already in-tree at spawnTriageSession (src/core/SessionManager.ts:5746-5750, docstring :5657-5658); JobScheduler.resolveAllowlist (src/core/../scheduler/JobScheduler.ts:2332-2400); emitAllowlistSignals (src/scheduler/JobScheduler.ts:2513-2535, clamp message :2518-2521); run-record flags (src/scheduler/JobRunHistory.ts:89-92, 202-222)"
---

# Job Tool-Allowlist Real Enforcement

## 0. One-paragraph summary

Every scheduled job — including one whose manifest declares a Read-only
`toolAllowlist` — runs with full unrestricted tools. `--allowedTools` is spliced
into an argv that already carries `--dangerously-skip-permissions`, and
skip-permissions bypasses the very permission system the allowlist feeds. The
flag authorizes; it does not restrict. Meanwhile the scheduler emits a
`job_allowlist_clamped` event telling the reader the job was "clamped to [Read]"
and offering `unrestrictedTools:true` as the way to "authorize full tools" —
framing an inert flag as an authorization control. This spec (A) corrects the
false assurance immediately, (B) adds the wiring-integrity test whose absence
let this live, and (C) makes enforcement genuinely real behind a
dark-by-default flag, using a correct pattern that already exists 2,700 lines
away in the same file.

## 1. The defect, verified at the consumer

`claudeCodeHeadlessBuilder` (`src/core/frameworkSessionLaunch.ts:982`) opens
every headless Claude argv with:

```ts
const argv: string[] = [options.binaryPath, '--dangerously-skip-permissions'];
```

`claudeHeadlessExtraFlags` (`:1340`) then contributes `--allowedTools <list>`,
spliced before the `-p` positional at `src/core/SessionManager.ts:2982`. The
resulting shape is documented in the tree's own comment at `SessionManager.ts:2973`:

```
[binary, --dangerously-skip-permissions, (--model X)?, --allowedTools <list>, -p, prompt]
```

`--dangerously-skip-permissions` disables the permission system that
`--allowedTools` configures. **The allowlist is inert on this path.**

### 1.1 Consumer-side evidence (two independent observations)

Per this repo's own "verify at the consumer" standard, the claim is not made
from the manifest or the log line — both of which were what produced the
original false conclusion (LRN-001).

1. **Live process argv.** LRN-007 read the tmux pane argv of a running job whose
   manifest declared `toolAllowlist: [Read]` and found it holding
   Bash/Write/Edit/Agent/MCP, then executing dozens of `curl`, `python3` and
   `tmux` calls.
2. **The durable run ledger.** `.instar/ledger/job-runs.jsonl` (2,795 rows) shows
   six `origin:instar` builtins recorded with `clampedAllowlist: true` and
   `toolAllowlist: ["Read"]` — `health-check` (458 runs), `evolution-overdue-check`
   (11), `insight-harvest` (5), `evolution-proposal-evaluate` (5),
   `evolution-proposal-implement` (5), `relationship-maintenance` (3) — with the
   most recent health-check row at `2026-08-23T08:05:00Z`. Those runs completed
   real work requiring exactly the tools they were "clamped" out of.

### 1.2 A second finding surfaced while gathering that evidence

The on-disk manifests at `.instar/jobs/instar/*.md` currently read
`toolAllowlist: "*"` with `unrestrictedTools: true` for all six of those slugs —
which `resolveAllowlist` maps to `kind:'unrestricted'`, **not** clamped. Yet the
running scheduler recorded `clampedAllowlist: true` for a health-check run
minutes before this spec was written. **The manifest on disk is not the manifest
in effect.** This is the same producer/consumer gap one layer up and must be
resolved before §4's enforcement flip, or the flip will restrict a set of jobs
nobody can enumerate from the files. §4.3 makes that a gating precondition.

## 2. The acute risk is false assurance, not lost capability

Nothing is currently under-permissioned, so no capability is missing. The harm
is the reverse: **the system reports enforcement it is not performing.**

`emitAllowlistSignals` (`src/scheduler/JobScheduler.ts:2518-2521`) writes a
dashboard event reading:

> Job "<slug>" requested toolAllowlist:"\*" without unrestrictedTools:true —
> clamped to [Read]. Set unrestrictedTools:true in the manifest to authorize
> full tools.

and a DegradationReporter entry whose `impact` reads "Job will run with Read-only
tools until the manifest sets unrestrictedTools:true". Both statements are false
on the current spawn path. A control that manufactures assurance is worse than an
absent one — an absent control is at least correctly modelled by its readers.

The cost is already measurable: three days of remediation (eight jobs forked into
`.instar/jobs/user/` with explicit Read-only allowlists) aimed at a capability
loss that never occurred. That remediation silenced the warning and changed
behavior in neither direction.

## 3. The correct pattern already exists in the same file

`spawnTriageSession` (`src/core/SessionManager.ts:5746-5750`) does it right:

```ts
// Scoped permissions: allowedTools + permissionMode (NOT --dangerously-skip-permissions)
if (options.allowedTools.length > 0) {
  tmuxArgs.push('--allowedTools', options.allowedTools.join(','));
}
tmuxArgs.push('--permission-mode', options.permissionMode);
```

with a docstring at `:5657-5658` stating exactly why: *"triage sessions use
--allowedTools + --permission-mode dontAsk instead of
--dangerously-skip-permissions. This gives them read-only access."*

Two spawn paths, one file, one of them correct. **This is not new machinery — it
is applying the pattern proven next door.**

## 4. Design — three increments, shipped in order

### 4.1 Increment A — stop claiming what is not true (immediate, always on)

Correct both message surfaces in `emitAllowlistSignals` so they describe what
actually happens. While `scheduler.toolAllowlistEnforcement` is off, the clamp
message states plainly that the allowlist is recorded and **not enforced on the
spawn path**, and points at the enforcement flag rather than offering
`unrestrictedTools:true` as an authorization control.

The `clampedAllowlist` run-record flag (`JobRunHistory.ts:92`) keeps its name and
meaning — *the resolver clamped* — which was always accurate. Only the prose
claiming a runtime effect changes.

This increment alone removes the false assurance and is independently shippable.

### 4.2 Increment B — the test whose absence let this live

A **wiring-integrity test** (required for every dependency-injected component by
the Testing Integrity Standard) asserting the argv actually produced:

- With enforcement OFF: the built argv contains `--dangerously-skip-permissions`,
  and the test carries an explicit comment recording that `--allowedTools` is
  therefore inert. The current behavior becomes *documented and pinned*, so it
  cannot silently drift back into being believed.
- With enforcement ON for a job carrying an array `toolAllowlist`: the argv
  contains `--allowedTools <list>` **and** `--permission-mode`, and does **not**
  contain `--dangerously-skip-permissions`.

Plus an integration-tier test that spawns a genuinely-clamped job and asserts a
supposedly-denied tool actually fails. **Asserting the flag is present is what
produced this bug; the test must assert the denial.**

### 4.3 Increment C — real enforcement, dark by default

A new config block:

```
scheduler.toolAllowlistEnforcement: {
  enabled: false,          // dark on the fleet
  dryRun: true,            // even when enabled, log the would-be argv only
  permissionMode: 'dontAsk'
}
```

When `enabled && !dryRun` **and** the resolved allowlist is a concrete array
(`kind` ∈ `array` | `clamped` | `default-user` | `lock-untrusted-clamped`), the
headless builder omits `--dangerously-skip-permissions` and emits
`--allowedTools` + `--permission-mode`, exactly as `spawnTriageSession` does.

`kind:'unrestricted'` and `kind:'legacy'` are untouched in every mode — an
authorized-full-tools job and a non-agentmd job keep today's argv byte-for-byte.

**Blast radius, stated honestly.** Flipping this on today would make six
`origin:instar` builtins genuinely Read-only — including `health-check` and
`evolution-proposal-implement`, *the job that authored this spec*. Each does
real work through Bash. Enforcement is therefore gated on two preconditions,
both of which must be satisfied before `dryRun:false`:

1. **§1.2 resolved** — the manifest-on-disk vs manifest-in-effect discrepancy is
   explained, so the affected set is enumerable from the files.
2. **Each affected builtin's effective manifest declares the tools it genuinely
   needs.** A job that needs Bash declares Bash. The clamp becomes real only
   after the declarations are true.

Ordering matters and is not negotiable: **fix the declarations, then enforce.**
Enforcing first converts an inert-but-harmless control into a live outage across
the scheduler.

### 4.4 Increment D — re-examine what LRN-001 concluded downstream

LRN-001 claimed health-check "produces nothing BECAUSE it cannot curl /health."
The causal half is false — it can, and does. Any remaining health-check silence
therefore needs a different explanation. Note the strong candidate: health-check's
contract is *only speak if something is wrong*, so **silence may simply be
correct**, and 458 quiet runs may be 458 healthy ones. This is exactly the
"absence of output read as health" pattern inverted — the earlier reading treated
silence as failure on a false premise. Resolve it by reading the job's actual
output, not by inferring from either direction.

## 5. Signal vs authority

Increment A is pure message correction — no decision surface. Increment B is
tests. Increment C **adds real blocking authority** (a spawned job genuinely
loses tools), which is why it ships dark, dryRun-first, gated on §4.3's two
preconditions, and is reversible by a single config flag read at the spawn
chokepoint. The authority added is the authority the system already *claimed* to
have; this makes the claim true rather than widening it.

## 6. Acceptance criteria

1. With enforcement off, every job's argv is byte-for-byte identical to today.
2. The clamp event and DegradationReporter entry no longer assert a runtime
   restriction while enforcement is off.
3. The wiring-integrity test fails if `--dangerously-skip-permissions` and
   `--allowedTools` are ever both emitted under enforcement-on.
4. Under enforcement-on, a clamped job is genuinely denied a non-allowlisted
   tool — asserted by observing the denial, not the flag.
5. `unrestricted` and `legacy` resolutions are untouched in all modes.
6. `GET /guards` reports the enforcement flag's real posture (`dark-default`
   while off), so the control's own state is never invisible.

## 7. Testing

- **Unit** — `claudeHeadlessExtraFlags` / builder argv under each resolution
  kind × each enforcement mode.
- **Integration** — full spawn path; a clamped job denied a non-allowlisted tool.
- **E2E** — production init path: scheduler boots, a clamped builtin runs, its
  run record and the resulting argv agree with the configured mode.
- **Wiring integrity** — §4.2, both directions.

## 8. Rollback

`scheduler.toolAllowlistEnforcement.enabled: false` restores today's spawn shape
at the next spawn (read at the chokepoint, no restart). Increment A's message
correction is prose and needs no rollback. Nothing persists that a revert must
undo.

## 9. Decided defaults (not open questions)

| Decision | Value | Why |
|---|---|---|
| Ship enforcement dark | Yes — `enabled:false`, `dryRun:true` | Flipping it today breaks six builtins including this job |
| Fix declarations before enforcing | Mandatory precondition | Enforcing first converts an inert control into an outage |
| Correct the message before enforcement lands | Yes, Increment A ships alone | False assurance is the acute harm and is independently fixable |
| Keep `clampedAllowlist` flag name | Yes | It accurately describes the resolver; only the runtime prose was false |
| `permissionMode` default | `dontAsk` | Matches the proven `spawnTriageSession` pattern |
| Enforce for `unrestricted`/`legacy` | Never | Out of scope; those declare no restriction to enforce |
