# PROP-780 — Core-job manifest + dead-man's switch (brainstem-job liveness guard)

**Source:** Dawn `instar-feature-parity` job (run 43, 2026-06-22)
**Domain:** instar · **Type:** infrastructure · **Impact:** high · **Effort:** small
**Dawn pattern ported:** `core-job-guard` + `core-jobs.json` brainstem manifest + revived dead-man's switch (Dawn's "Heal-the-Healers / Anti-Decay" infra)

## Problem

Dawn learned the hard way that a self-healing system needs a *declared expectation*
of which jobs MUST exist and run — otherwise a brainstem-critical job that is
**deleted from the manifest, flipped to `enabled: false`, un-scheduled, or that
silently stops firing** disappears with zero alert. A monitor that only watches
the jobs that *happen to be loaded* cannot detect the absence of a job that
*should* be loaded. Dawn's answer is `core-jobs.json` (a manifest of brainstem
jobs) + a guard that cross-references it and a dead-man's switch on liveness.

Instar has every adjacent piece but not this one:

- `scheduler/JobScheduler.ts:1304 checkMissedJobs()` iterates **only `enabledJobs`**
  and only re-triggers jobs overdue by >1.5× their interval. A job absent from
  `jobs.json`, disabled, or with no `cronTask` is invisible to it.
- `scheduler/JobScheduler.ts:1229 alertOnConsecutiveFailures()` fires only on
  **execution** failures of jobs that still run. A job that never fires never
  "fails," so it never alerts.
- `monitoring/probes/SchedulerProbe.ts` verifies the scheduler is running and that
  loaded-job counts match `jobs.json` — but **`jobs.json` is the source of truth**,
  so it structurally cannot detect a *missing expected* job.

Net: there is no declared set of "these jobs MUST be present and alive," and no
dead-man's switch. This is the canonical Heal-the-Healers gap — the healers can
silently die and nothing notices.

**Why it matters for every agent:** the scheduler is the brainstem. If
`system-reviewer`, `git-sync`, or any liveness-critical job silently vanishes, the
whole self-healing loop degrades invisibly until a human notices something else
broke downstream. The manifest makes the expectation explicit and the guard makes
it enforced.

## Proposed patch

Three surfaces: a new optional manifest file, a guard method wired into scheduler
startup, and a Tier-1 probe. The manifest is **optional** — when absent, the guard
auto-seeds the expected set from jobs flagged `priority: 'critical'`, so it
delivers value with zero config.

```diff
--- /dev/null
+++ b/core-jobs.json
@@
+{
+  "_comment": "Brainstem manifest — jobs that MUST exist, be enabled, scheduled, and fire. Ported from Dawn's core-jobs.json (Heal-the-Healers). If this file is absent, the scheduler auto-seeds the expected set from jobs with priority:'critical'.",
+  "coreJobs": [
+    { "slug": "system-reviewer", "maxSilenceHours": 26, "reason": "Canonical end-to-end health check — sessions stuck, scheduler down, Telegram broken." }
+  ]
+}
```

```diff
--- a/src/scheduler/JobScheduler.ts
+++ b/src/scheduler/JobScheduler.ts
@@ interface for the manifest (near top-level types, after SchedulerStatus)
+interface CoreJobEntry {
+  slug: string;
+  /** Max hours a core job may go without a successful run before the dead-man's
+   *  switch fires. Defaults to 26h when omitted. */
+  maxSilenceHours?: number;
+  reason?: string;
+}
+
@@ start(): inside the grace-timer block where checkMissedJobs is scheduled (~242-251)
     const graceMs = this.config.startupGraceMs ?? 5000;
     if (graceMs > 0) {
       console.log(`[scheduler] Startup grace period: ${graceMs}ms before missed-job evaluation`);
-      setTimeout(() => this.checkMissedJobs(scopedJobs), graceMs);
+      setTimeout(() => {
+        this.checkMissedJobs(scopedJobs);
+        this.checkCoreJobManifest(scopedJobs).catch(err =>
+          console.error(`[scheduler] core-job manifest check failed: ${err}`));
+      }, graceMs);
     } else {
       this.checkMissedJobs(scopedJobs);
+      this.checkCoreJobManifest(scopedJobs).catch(err =>
+        console.error(`[scheduler] core-job manifest check failed: ${err}`));
     }
@@ new method, placed adjacent to checkMissedJobs (~line 1304)
+  /**
+   * Dead-man's switch over a declared manifest of brainstem-critical jobs.
+   * Unlike checkMissedJobs (which only sees enabled, loaded jobs), this guard
+   * starts from an EXPECTATION and alerts on any divergence: a core job that is
+   * missing from jobs.json, disabled, unscheduled, or silent past its liveness
+   * deadline. Ported from Dawn's core-job-guard + core-jobs.json.
+   */
+  private async checkCoreJobManifest(loadedJobs: JobDefinition[]): Promise<void> {
+    const manifest = this.loadCoreJobManifest(loadedJobs);
+    if (manifest.length === 0) return; // nothing declared critical — nothing to guard
+
+    const now = Date.now();
+    const bySlug = new Map(this.jobs.map(j => [j.slug, j]));
+    const problems: string[] = [];
+
+    for (const entry of manifest) {
+      const job = bySlug.get(entry.slug);
+      if (!job) {
+        problems.push(`• \`${entry.slug}\` — ABSENT from jobs.json (core job deleted?)`);
+        continue;
+      }
+      if (!job.enabled) {
+        problems.push(`• \`${entry.slug}\` — DISABLED (enabled:false)`);
+        continue;
+      }
+      if (!this.cronTasks.get(entry.slug)) {
+        problems.push(`• \`${entry.slug}\` — NOT SCHEDULED (no cron task)`);
+        continue;
+      }
+      const maxSilenceMs = (entry.maxSilenceHours ?? 26) * 3600_000;
+      const jobState = this.state.getJobState(entry.slug);
+      const lastRun = jobState?.lastRun ? new Date(jobState.lastRun).getTime() : null;
+      if (lastRun === null) {
+        // Never run since state began — only flag if the deadline has already passed
+        // since startup is handled by checkMissedJobs; here we treat prolonged
+        // never-run as a liveness concern.
+        problems.push(`• \`${entry.slug}\` — has NEVER run (no recorded lastRun)`);
+      } else if (now - lastRun > maxSilenceMs) {
+        const hrs = Math.round((now - lastRun) / 3600_000);
+        problems.push(`• \`${entry.slug}\` — SILENT for ${hrs}h (deadline ${entry.maxSilenceHours ?? 26}h)`);
+      }
+    }
+
+    if (problems.length === 0) return;
+
+    const alertText =
+      `*Core Job Guard — brainstem liveness alert*\n\n` +
+      `${problems.length} core job(s) failing the manifest:\n${problems.join('\n')}\n\n` +
+      `These jobs are declared brainstem-critical. A silently-dead core job degrades ` +
+      `the self-healing loop invisibly. Restore the job (re-enable / re-add / unblock).`;
+
+    if (this.telegram) {
+      this.telegram.send(alertText).catch(err =>
+        console.error(`[scheduler] Failed to send core-job alert: ${err}`));
+    } else if (this.messenger) {
+      this.messenger.send({ userId: 'system', content: alertText }).catch(err =>
+        console.error(`[scheduler] Failed to send core-job alert: ${err}`));
+    }
+    // Feed the enforcement spine too — advisory-only is a trap (see PROP-774).
+    try {
+      const { DegradationReporter } = await import('../monitoring/DegradationReporter.js');
+      DegradationReporter.getInstance?.()?.report?.(
+        'scheduler.core_job_missing', alertText, { severity: 'high' });
+    } catch { /* @silent-fallback-ok — reporter optional in some setups */ }
+  }
+
+  /** Load the brainstem manifest from core-jobs.json (sibling of jobs.json).
+   *  When the file is absent, auto-seed from jobs flagged priority:'critical'. */
+  private loadCoreJobManifest(loadedJobs: JobDefinition[]): CoreJobEntry[] {
+    try {
+      const manifestPath = path.join(path.dirname(this.config.jobsFile), 'core-jobs.json');
+      if (fs.existsSync(manifestPath)) {
+        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
+        if (Array.isArray(parsed?.coreJobs)) return parsed.coreJobs as CoreJobEntry[];
+      }
+    } catch (err) { // @silent-fallback-ok — fall through to priority-seed
+      console.error(`[scheduler] core-jobs.json parse failed, seeding from priority: ${err}`);
+    }
+    return loadedJobs
+      .filter(j => j.priority === 'critical')
+      .map(j => ({ slug: j.slug, maxSilenceHours: 26 }));
+  }
```

```diff
--- a/src/monitoring/probes/SchedulerProbe.ts
+++ b/src/monitoring/probes/SchedulerProbe.ts
@@ inside the returned Probe[] array, after the 'instar.scheduler.loaded' probe
+    {
+      id: 'instar.scheduler.core_jobs_present',
+      name: 'Core Jobs Present & Enabled',
+      tier,
+      feature,
+      timeoutMs,
+      prerequisites,
+      async run(): Promise<ProbeResult> {
+        const base = { probeId: this.id, name: this.name, tier, durationMs: 0 };
+        try {
+          const jobs = deps.getJobs();
+          const present = new Map(jobs.map(j => [j.id, j]));
+          // Manifest sibling of jobs.json; fall back to empty (probe passes) when absent.
+          let coreSlugs: string[] = [];
+          try {
+            const manifestPath = deps.jobsFilePath.replace(/jobs\.json$/, 'core-jobs.json');
+            if (fs.existsSync(manifestPath)) {
+              const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
+              if (Array.isArray(parsed?.coreJobs)) {
+                coreSlugs = parsed.coreJobs.map((c: { slug: string }) => c.slug);
+              }
+            }
+          } catch { /* @silent-fallback-ok — no manifest → nothing to assert */ }
+
+          const missing = coreSlugs.filter(slug => {
+            const j = present.get(slug);
+            return !j || j.enabled === false;
+          });
+          if (missing.length > 0) {
+            return {
+              ...base,
+              passed: false,
+              description: `${missing.length} core job(s) missing/disabled`,
+              error: `Core jobs absent or disabled: ${missing.join(', ')}`,
+              remediation: ['Restore the job in jobs.json and ensure enabled:true', 'See core-jobs.json manifest'],
+            };
+          }
+          return { ...base, passed: true, description: `All ${coreSlugs.length} core jobs present & enabled` };
+        } catch (err) {
+          return { ...base, passed: false, description: 'Core-job presence check threw', error: String(err) };
+        }
+      },
+    },
```

## Test evidence

Not run from this job (Dawn's `instar-feature-parity` runs OUTSIDE Instar's
`/instar-dev` flow and cannot produce a valid pre-commit trace — PROP-379). The
diff is written against verified signatures read 2026-06-22:
- `JobDefinition` carries `slug`, `name`, `priority: JobPriority`, `enabled: boolean`
  (`src/core/types.ts:64-101`).
- `JobState` carries optional `lastRun?: string` (`src/core/types.ts:188-198`).
- `JobScheduler` already imports `fs` (`:14`) and `path` (`:17`); has
  `this.config.jobsFile` (`:214`), `this.jobs`, `this.cronTasks`,
  `this.state.getJobState(slug)` (`:1313`), `this.telegram`, `this.messenger`
  (alert plumbing at `:1248-1253`).
- `SchedulerProbeDeps` exposes `getJobs()` (`{id,name,enabled?}`) and
  `jobsFilePath` (`src/monitoring/probes/SchedulerProbe.ts:11-26`).

`/instar-dev` should run `pnpm tsc --noEmit` + the scheduler test suite to confirm.

## Typecheck status

Not run (out-of-flow). Expected clean: no new imports at module scope (dynamic
`import()` for the optional DegradationReporter mirrors existing optional-subsystem
patterns), and all referenced members verified present above. The one item for
`/instar-dev` to confirm: `DegradationReporter.getInstance()` accessor name — if the
singleton accessor differs, adjust the dynamic-import block (it is wrapped in
try/catch and `?.` so a name mismatch degrades to "alert sent, not fed back" rather
than throwing).

## Files touched

- `core-jobs.json` (new) — brainstem manifest; optional, auto-seeded from
  `priority:'critical'` when absent.
- `src/scheduler/JobScheduler.ts` — `CoreJobEntry` type; `checkCoreJobManifest()` +
  `loadCoreJobManifest()`; wired into the startup grace-timer block (~242-251).
- `src/monitoring/probes/SchedulerProbe.ts` — new Tier-1 probe
  `instar.scheduler.core_jobs_present`.

## Adoption steps for /instar-dev

1. Open a spec scaffold for "core-job manifest + dead-man's switch"; run
   `/spec-converge`.
2. Apply the diff above. Confirm the `DegradationReporter` singleton accessor name
   (`getInstance` vs alternative) and the `telegram.send` signature against the
   live `Telegram` type (the alert uses the broadcast form, not `sendToTopic`,
   since a missing/disabled core job may have no topic).
3. Decide the real brainstem set: replace the seed `system-reviewer` entry in
   `core-jobs.json` with Instar's actual liveness-critical jobs (likely the system
   reviewer + git-sync + any heartbeat). Per-job `maxSilenceHours` from each job's
   cadence (≈ 1.5–2× interval).
4. Run `/instar-dev` to produce the trace + side-effects artifact; add a scheduler
   test asserting: (a) absent core slug → alert/problem, (b) disabled core job →
   problem, (c) silent-past-deadline → problem, (d) all healthy → no alert.
5. Commit through the normal gate.

## Why this respects the boundary

Dawn supplies the hard-won pattern and a real diff; Instar's `/instar-dev` +
`/spec-converge` flow owns the landing decision and the gate. No `src/` commit is
made from this job.
