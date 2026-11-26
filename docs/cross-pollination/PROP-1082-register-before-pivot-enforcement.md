# PROP-1082 — Register-Before-Pivot Enforcement

> **Source:** Dawn `instar-feature-parity` job (PROP-379, PROP-filing-only mode), authored 2026-08-24, session AUT-10954-wo.
> **Corrected and verified 2026-10-10** against live `JKHeadley/instar@main` — commit `258585e66`, `v1.3.1338`. The 2026-08-24 patch below has been **rewritten**: as drafted it would not have compiled. See *What changed in the 2026-10-10 revision*.
> **Domain:** instar · **Type:** infrastructure · **Impact:** high · **Effort:** small
> **Adoption owner:** `/instar-dev` (land through the normal spec-converge + pre-commit gate).
> **Portal-side tracking id:** PROP-1237 (this filing kept its original PROP-1082 name; the Portal queue renumbered the entry on 2026-09-30 after an id collision).

## Problem

Autonomous agents that build their own infrastructure (jobs, probes, reviewers, self-heal scripts, hooks) share a silent failure mode: an agent writes a new capability mid-session, the session ends, and nothing ever *registers* that capability into the system's own map. The code exists on disk but the system does not "know" it exists — the capability never appears in the manifest, is never surfaced, and any wiring it needs is never flagged as missing. The capacity was built and then structurally lost, because the **pivot moment** (session end / context switch) is exactly when undocumented new infra evaporates. For a self-evolving agent, "I built X" silently degrades to "X does nothing," and **no error ever fires**.

This is the same family as the already-filed stranded-branch problem (PROP-878) but **one layer earlier**: PROP-878 governs "built and committed but unmerged"; this governs "built but never *registered* at all." It is also distinct from PROP-946 (feature-rollout-registry), which governs rollout *flags*, not newly-built capabilities.

Instar already has the two pieces required to close this — they are just not connected. Both re-verified on `258585e66`:

- **The detector already exists.** `CapabilityMapper.detectDrift()` (`src/core/CapabilityMapper.ts:355`) computes `added` (capabilities present in a fresh scan but absent from the persisted manifest) and `unmapped` (capabilities whose provenance is unknown). It is a complete detector — and it has exactly **one** caller in all of `src/`: the on-demand HTTP route at `src/server/routes.ts:8277`. Nothing invokes it at a session boundary.
- **The boundary trigger already exists.** `SessionMaintenanceRunner` (`src/core/SessionMaintenanceRunner.ts`) runs at **every** `sessionComplete` (wired in `src/commands/server.ts:13896`). It was itself cross-pollinated from Dawn. Today its only tasks are JSONL rotation and execution-journal trimming.

So this is a **wiring + surfacing patch, not a new detector**: add one maintenance task that runs `detectDrift()` at the pivot and surfaces newly-built-but-unregistered capabilities via the existing `DegradationReporter`.

**Gap re-verified OPEN on 2026-10-10** against `258585e66`: `git grep detectDrift -- src/` returns the definition and the one route; `git grep '\.unmapped' -- src/` returns no capability-drift consumer outside `CapabilityMapper` itself; nothing named `unregistered` in `src/` concerns capabilities (the hits are unregistered *commitments*, *identities*, *stores*, and *ruleIds*).

## Dawn pattern this ports

`.claude/hooks/completion-before-pivot-check.py` — a Stop hook that, at every session pivot, finds NEW infra files and checks whether the system "knows" about each (scripts named in the territory map/a skill; **hooks wired into `settings*.json` else they never run**; agents in the registry). Unregistered new infra is surfaced as a "document-or-lose before pivot" list. Sibling: `.claude/hooks/uncommitted-critical-paths-guard.py` (the commit-layer twin).

## Why this is not advisory-only

The task reports; it does not block. In Dawn's terms that raises the enforcement-over-advisory question directly, so: in Instar, `DegradationReporter.report()` is **not** a dead end. Per `src/monitoring/DegradationReporter.ts`, a legacy `.report(...)` is normalized and either dispatched to the Remediator or (with none wired) routed as `no-matching-runbook`, which feeds NovelFailureReviewer's clustering pipeline. The signal therefore lands somewhere a machine consumes, which is the condition that distinguishes a fed-back detector from one whose only actuator is a human reading a log. Escalating to a *block* at session end would be wrong here regardless: `SessionMaintenanceRunner`'s stated contract is fire-and-forget, and session cleanup must always succeed.

`reportStructured()` (the §A33 go-forward normalized API) is deliberately **not** used: this condition has no canonical `errorCode`, and a hand-made `provenance` would be free-text anyway, so the normalized form would add required fields without adding routing. If Instar would rather every new emit-site be structured, the swap is local to one call.

## Proposed patch (verified — see *Verification*)

Advisory-mode by default: report, never block.

```diff
diff --git a/src/commands/server.ts b/src/commands/server.ts
index 72296c03c..aa03bdedd 100644
--- a/src/commands/server.ts
+++ b/src/commands/server.ts
@@ -13893,8 +13893,14 @@ export async function startServer(options: StartOptions): Promise<void> {
 
     // Session-end maintenance — lightweight housekeeping at session boundaries
     // Cross-pollinated from Dawn: distributes maintenance load across all sessions
+    // Forward ref: the capability mapper is built further down this same scope,
+    // after the maintenance runner, so the runner reads it through a getter.
+    let _capabilityMapperForMaintenance: CapabilityMapper | null = null;
     const { SessionMaintenanceRunner } = await import('../core/SessionMaintenanceRunner.js');
-    const sessionMaintenance = new SessionMaintenanceRunner({ stateDir: config.stateDir });
+    const sessionMaintenance = new SessionMaintenanceRunner({
+      stateDir: config.stateDir,
+      capabilityDriftSource: () => _capabilityMapperForMaintenance,
+    });
     sessionManager.on('sessionComplete', async () => {
       try {
         const result = await sessionMaintenance.run();
@@ -17006,6 +17012,9 @@ export async function startServer(options: StartOptions): Promise<void> {
       version: config.version || '0.0.0',
       port: config.port,
     });
+    // Hand the mapper to the session-end register-before-pivot task (declared
+    // above as a forward ref because that runner is wired up earlier).
+    _capabilityMapperForMaintenance = capabilityMapper;
     // Initial map generation (async, non-blocking)
     capabilityMapper.refresh().then(() => {
       console.log(pc.green('  Capability map generated'));
diff --git a/src/core/SessionMaintenanceRunner.ts b/src/core/SessionMaintenanceRunner.ts
index 9eaf65da8..9a891f5c8 100644
--- a/src/core/SessionMaintenanceRunner.ts
+++ b/src/core/SessionMaintenanceRunner.ts
@@ -14,6 +14,7 @@
  * Current tasks:
  * 1. JSONL rotation — rotate oversized log files
  * 2. Stale execution journal trim — archive old execution entries
+ * 3. Register-before-pivot — surface newly-built-but-unregistered capabilities
  *
  * Integration: SessionManager emits 'sessionComplete' → server wires this runner.
  */
@@ -22,6 +23,23 @@ import fs from 'node:fs';
 import path from 'node:path';
 import { maybeRotateJsonl } from '../utils/jsonl-rotation.js';
 
+/**
+ * The minimum a capability-drift detector must offer this runner.
+ *
+ * Structural on purpose, not a `CapabilityMapper` import: the mapper needs
+ * projectDir/projectName/version/port, which this runner has no business
+ * knowing (it only ever receives stateDir). Depending on the shape instead
+ * of the class keeps the task's type surface to two fields and keeps the
+ * runner free of the mapper's dependency tree.
+ *
+ * `CapabilityMapper` satisfies it as-is: `detectDrift(): Promise<DriftReport>`
+ * where `added: Capability[]` (and `Capability.id: string`) and
+ * `unmapped: string[]`.
+ */
+export interface CapabilityDriftSource {
+  detectDrift(): Promise<{ added: Array<{ id: string }>; unmapped: string[] }>;
+}
+
 export interface SessionMaintenanceConfig {
   /** The .instar state directory */
   stateDir: string;
@@ -31,6 +49,25 @@ export interface SessionMaintenanceConfig {
   jsonlMaxBytes?: number;
   /** Max age for execution journal entries (days). Default: 30 */
   executionJournalRetentionDays?: number;
+  /**
+   * Where the register-before-pivot task reads capability drift from.
+   *
+   * A getter is accepted because at the wiring site this runner is
+   * constructed BEFORE the CapabilityMapper exists (server.ts builds the
+   * runner at session-maintenance setup and the mapper several thousand
+   * lines later). Returning null/undefined skips the task — so an
+   * embedder that has no mapper loses nothing and pays nothing.
+   */
+  capabilityDriftSource?:
+    | CapabilityDriftSource
+    | (() => CapabilityDriftSource | null | undefined);
+  /**
+   * When true, run the capability-drift check at each pivot and surface
+   * newly-built-but-unregistered capabilities via DegradationReporter.
+   * Default: true (advisory-only — reports, never blocks session end).
+   * Has no effect without `capabilityDriftSource`.
+   */
+  checkUnregisteredCapabilities?: boolean;
 }
 
 export interface MaintenanceResult {
@@ -45,12 +82,18 @@ export class SessionMaintenanceRunner {
   private readonly timeoutMs: number;
   private readonly jsonlMaxBytes: number;
   private readonly retentionDays: number;
+  private readonly driftSource?:
+    | CapabilityDriftSource
+    | (() => CapabilityDriftSource | null | undefined);
+  private readonly checkUnregistered: boolean;
 
   constructor(config: SessionMaintenanceConfig) {
     this.stateDir = config.stateDir;
     this.timeoutMs = config.timeoutMs ?? 10_000;
     this.jsonlMaxBytes = config.jsonlMaxBytes ?? 5 * 1024 * 1024; // 5MB
     this.retentionDays = config.executionJournalRetentionDays ?? 30;
+    this.driftSource = config.capabilityDriftSource;
+    this.checkUnregistered = config.checkUnregisteredCapabilities ?? true;
   }
 
   /**
@@ -98,6 +141,58 @@ export class SessionMaintenanceRunner {
     } catch (err) {
       console.error('[SessionMaintenance] Journal trim failed:', err);
     }
+
+    // Task 3: Register-before-pivot — surface newly-built-but-unregistered
+    // capabilities so self-built infra cannot silently evaporate at the pivot.
+    if (this.checkUnregistered) {
+      try {
+        const flagged = await this.reportUnregisteredCapabilities();
+        if (flagged > 0) {
+          tasksRun.push(`unregistered-capabilities(${flagged})`);
+          for (let i = 0; i < flagged; i++) countItem();
+        }
+      } catch (err) {
+        console.error('[SessionMaintenance] Capability drift check failed:', err);
+      }
+    }
+  }
+
+  /** The drift source, resolving a getter if one was supplied. */
+  private resolveDriftSource(): CapabilityDriftSource | null {
+    const source = this.driftSource;
+    if (!source) return null;
+    const resolved = typeof source === 'function' ? source() : source;
+    return resolved ?? null;
+  }
+
+  /**
+   * Surface any capability that is present on disk but absent from the
+   * persisted manifest (`added`) or carries unknown provenance (`unmapped`).
+   *
+   * Advisory-only: reports via DegradationReporter, never throws past its
+   * caller's try/catch, never blocks session end. Returns the number flagged
+   * (0 when no drift source is configured, so the task is a no-op rather
+   * than a failure for embedders without a mapper).
+   */
+  private async reportUnregisteredCapabilities(): Promise<number> {
+    const source = this.resolveDriftSource();
+    if (!source) return 0;
+
+    const drift = await source.detectDrift();
+    const flagged = [...drift.added.map(c => c.id), ...drift.unmapped];
+    if (flagged.length === 0) return 0;
+
+    // Lazy import keeps the reporter off this module's import graph; the
+    // runner itself is lazily imported at its wiring site for the same reason.
+    const { DegradationReporter } = await import('../monitoring/DegradationReporter.js');
+    DegradationReporter.getInstance().report({
+      feature: 'SessionMaintenance.registerBeforePivot',
+      primary: 'Newly-built capabilities are registered in the manifest before session end',
+      fallback: 'Capabilities exist on disk but are unregistered — they may never wire in or be found',
+      reason: `Why: ${flagged.length} capability(ies) present on disk are not in the manifest: ${flagged.slice(0, 10).join(', ')}${flagged.length > 10 ? ' …' : ''}`,
+      impact: 'Self-built infra silently does nothing (unwired hook, unscheduled job, unmapped script) with no error',
+    });
+    return flagged.length;
   }
 
   /**
```

### Why the runner takes a drift *source* rather than constructing a mapper

The 2026-08-24 draft had the task do `new CapabilityMapper({ stateDir: this.stateDir })`. That cannot compile: `CapabilityMapperConfig` requires `projectDir`, `stateDir`, `projectName`, `version`, and `port` (`src/core/CapabilityMapper.ts:232`), and `SessionMaintenanceRunner` is only ever handed `stateDir`. Giving the runner the other four would mean teaching a housekeeping component the whole project identity, and constructing a second mapper would duplicate a scan the server already performs.

So the runner depends on a **structural interface** (`CapabilityDriftSource`) and the server hands it the mapper it already built. `CapabilityMapper` satisfies the interface as-is — no change to the mapper.

The source is accepted as *either* an instance or a getter because of an ordering fact at the wiring site: `SessionMaintenanceRunner` is constructed at `server.ts:13896`, and `capabilityMapper` at `server.ts:17002` — roughly 3,100 lines later in the same scope. A getter plus a forward-ref `let` (the idiom already used throughout that function, e.g. `_ropeProber`) resolves it at run time without reordering startup. If the source resolves to null the task is a silent no-op, so an embedder with no mapper pays nothing.

## Verification

Run on 2026-10-10 in a throwaway worktree of `JKHeadley/instar@main` at `258585e66` (`v1.3.1338`), with `node_modules` borrowed from a local clone.

**1. Typecheck — `tsc --noEmit`, baseline vs patched.**

| | total errors | errors in `SessionMaintenanceRunner.ts` | errors in `commands/server.ts` |
|---|---|---|---|
| before the patch | 42 | 0 | 0 |
| after the patch | 42 | 0 | 0 |

The error *set* is byte-identical before and after (diffed with line/column stripped). Those 42 pre-existing errors are fully attributable and are **not** masking anything: 19 are `TS2307 Cannot find module` for exactly `js-yaml`, `ssh2`, `telegram`, `telegram/sessions/index.js`, `undici`, and the other 23 are `TS7006` implicit-any cascades from those same unresolved imports. All of them come from the borrowed `node_modules` predating 11 dependencies added upstream since (no dependency's *version* differs; only additions). Neither patched file imports any of them.

**2. Unit tests — 7 tests, all passing.** Written against this patch and run with vitest 2.1.9 in the same worktree. The test file is below; it is the deliverable's second half.

**3. Mutation check — the tests are not vacuous.** With `if (this.checkUnregistered)` forced to `if (false)` (Task 3 never runs), **3 of the 7 fail**: the "reports once", "truncates at 10", and "lazy getter" cases. The other 4 are negative-case tests that *should* still pass with the task off. Restored, all 7 pass again. This is the step the PROP-1157 post-mortem said was missing from this family of filings: a green suite over a no-op reads exactly like a green suite over a fix.

**What was NOT run, and why.** The full Instar suite: its `build-dist.globalSetup` runs `npx tsc` to produce `dist/`, which fails in this worktree on the 5 unresolved modules above — a dependency-install artifact, unrelated to the patch. The verification above therefore used a minimal vitest config without that global setup, legitimate here only because this test imports from `src/`, never `dist/`. **No `/instar-dev` trace or side-effects artifact exists** for this patch, which is the whole reason this is a filing and not a PR (PROP-379). Treat the evidence above as "the patch compiles and its behaviour is pinned by passing, mutation-checked tests" — not as a substitute for the gate.

## Test file

Drop in at `tests/unit/SessionMaintenanceRunner-register-before-pivot.test.ts`:

```ts
/**
 * Register-before-pivot — the session-boundary task that surfaces capabilities
 * which exist on disk but were never registered in the manifest.
 *
 * The drift SOURCE is faked (it is an injected collaborator), but the
 * DegradationReporter is the real singleton: the question under test is
 * whether a report actually lands, so reading it back from the real reporter
 * is the evidence. A mocked reporter would pass whether or not the surfacing
 * works.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SessionMaintenanceRunner,
  type CapabilityDriftSource,
} from '../../src/core/SessionMaintenanceRunner.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';

const FEATURE = 'SessionMaintenance.registerBeforePivot';

let stateDir: string;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smr-rbp-'));
  DegradationReporter.resetForTesting();
  // report() always console.warns by design; keep the suite output readable.
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  fs.rmSync(stateDir, { recursive: true, force: true });
  DegradationReporter.resetForTesting();
});

const driftOf = (
  added: string[],
  unmapped: string[],
): CapabilityDriftSource => ({
  detectDrift: async () => ({
    added: added.map(id => ({ id })),
    unmapped,
  }),
});

const reported = () =>
  DegradationReporter.getInstance().getEvents().filter(e => e.feature === FEATURE);

describe('SessionMaintenanceRunner — register-before-pivot', () => {
  it('reports once, naming the ids, and counts the task', async () => {
    const runner = new SessionMaintenanceRunner({
      stateDir,
      capabilityDriftSource: driftOf(['job:new-probe'], ['scripts/orphan.py']),
    });

    const result = await runner.run();

    expect(result.tasksRun).toContain('unregistered-capabilities(2)');
    expect(result.itemsProcessed).toBe(2);

    const events = reported();
    expect(events).toHaveLength(1);
    expect(events[0].reason).toContain('job:new-probe');
    expect(events[0].reason).toContain('scripts/orphan.py');
    expect(events[0].reason).toContain('2 capability(ies)');
  });

  it('truncates the id list at 10 but keeps the true count', async () => {
    const ids = Array.from({ length: 14 }, (_, i) => `cap-${i}`);
    const runner = new SessionMaintenanceRunner({
      stateDir,
      capabilityDriftSource: driftOf(ids, []),
    });

    const result = await runner.run();

    expect(result.tasksRun).toContain('unregistered-capabilities(14)');
    const [event] = reported();
    expect(event.reason).toContain('14 capability(ies)');
    expect(event.reason).toContain('cap-9');
    expect(event.reason).not.toContain('cap-10');
    expect(event.reason).toContain('…');
  });

  it('stays silent when there is no drift', async () => {
    const runner = new SessionMaintenanceRunner({
      stateDir,
      capabilityDriftSource: driftOf([], []),
    });

    const result = await runner.run();

    expect(result.tasksRun.join(',')).not.toContain('unregistered-capabilities');
    expect(reported()).toHaveLength(0);
  });

  it('a throwing detector never breaks session end', async () => {
    const runner = new SessionMaintenanceRunner({
      stateDir,
      capabilityDriftSource: {
        detectDrift: async () => {
          throw new Error('manifest unreadable');
        },
      },
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runner.run()).resolves.toMatchObject({ tasksRun: expect.any(Array) });
    expect(reported()).toHaveLength(0);

    err.mockRestore();
  });

  it('checkUnregisteredCapabilities: false skips the detector entirely', async () => {
    const detectDrift = vi.fn(async () => ({ added: [{ id: 'cap-x' }], unmapped: [] }));
    const runner = new SessionMaintenanceRunner({
      stateDir,
      capabilityDriftSource: { detectDrift },
      checkUnregisteredCapabilities: false,
    });

    await runner.run();

    expect(detectDrift).not.toHaveBeenCalled();
    expect(reported()).toHaveLength(0);
  });

  it('no drift source is a no-op, not a failure (embedder without a mapper)', async () => {
    const runner = new SessionMaintenanceRunner({ stateDir });

    const result = await runner.run();

    expect(result.tasksRun.join(',')).not.toContain('unregistered-capabilities');
    expect(reported()).toHaveLength(0);
  });

  it('resolves a getter lazily, so a source attached after construction still works', async () => {
    // This is the wiring-site case: server.ts builds the runner before the
    // CapabilityMapper exists. A direct instance could not express it.
    let source: CapabilityDriftSource | null = null;
    const runner = new SessionMaintenanceRunner({
      stateDir,
      capabilityDriftSource: () => source,
    });

    const before = await runner.run();
    expect(before.tasksRun.join(',')).not.toContain('unregistered-capabilities');

    source = driftOf(['cap:late'], []);
    const after = await runner.run();

    expect(after.tasksRun).toContain('unregistered-capabilities(1)');
    expect(reported()).toHaveLength(1);
    expect(reported()[0].reason).toContain('cap:late');
  });
});
```

## Files touched

- `src/core/SessionMaintenanceRunner.ts` — one exported interface, two optional config fields, two private methods, one task in `runTasks`.
- `src/commands/server.ts` — a forward-ref `let`, two added lines at the runner construction, one assignment line after the mapper is built.
- `tests/unit/SessionMaintenanceRunner-register-before-pivot.test.ts` — new (above).

No change to `CapabilityMapper` or `DegradationReporter`.

## What changed in the 2026-10-10 revision

The gap and the design are unchanged. The patch is rewritten, and the honest reason matters more than the diff:

1. **The original patch would not have compiled — then or now.** It called `new CapabilityMapper({ stateDir: this.stateDir })`. Its stated evidence read *"Constructor takes `{ stateDir }`-bearing `CapabilityMapperConfig`"* — a sentence that is literally true (the config does bear a `stateDir`) and operationally wrong (four other fields are required). `CapabilityMapperConfig` has had all five required fields since before the draft was written, checked at `29afe2178` (2026-08-25). So this was not staleness; it was a verification sentence shaped to be true rather than to be a check. The replacement injects the mapper the server already owns.
2. **Stale references corrected**: `detectDrift` is at `CapabilityMapper.ts:355` (was cited :241); its single caller is `src/server/routes.ts:8277` (was cited `src/commands/server.ts`, since split); the runner's wiring site is `src/commands/server.ts:13896` (was cited :4606).
3. **Wiring is no longer "optional"**: the original said no change was needed at the wiring site. With injection it is required, and it is three lines.
4. **Evidence replaces intent.** The original listed four tests for `/instar-dev` to write and said "typecheck not run". The tests are now written, passing, and mutation-checked, and the typecheck was run with its baseline published above.

## Adoption steps for /instar-dev

1. Open a spec scaffold for "register-before-pivot capability-drift surfacing at session boundary"; run `/spec-converge`.
2. Apply the two `src/` diffs above and add the test file.
3. Run `/instar-dev` to produce the trace + side-effects artifact; full `tsc --noEmit` + suite green with a complete `node_modules`.
4. Commit through the normal pre-commit gate.

## Why this beats the runners-up (considered at authoring, 2026-08-24)

- **Correction-checklist compiler** (Dawn `correction-checklist-preflight.py`): absent in Instar, but downstream of already-filed PROP-864 (human-as-detector) — a close variant.
- **paired-audit-action / enforcement-over-advisory standard**: substantially covered by PROP-866 (advisory-audit-registry) + PROP-774 (SystemReviewer enforcement wiring).
- **iterative-audit-to-convergence**: originated *from* Instar/Echo per its own header — Instar is the source, not the gap.

Register-before-pivot wins: genuinely uncovered by any filed PROP, fully generalizable to any self-building agent, and the cheapest, lowest-risk patch — both the detector (`detectDrift`) and the boundary trigger (`SessionMaintenanceRunner`) already exist in `src/`, so it is wiring plus one surfacing call.
