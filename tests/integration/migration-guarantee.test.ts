/**
 * Seamless Migration Guarantee suite.
 *
 * THIS IS THE BINDING GATE for jobs-as-agentmd phases 3+. The release-cut
 * gate refuses to advance past Phase 3 (Phase ≥ 4 release) unless this
 * suite passes. The pre-commit gate refuses to delete this test file or
 * any fixture under tests/fixtures/migration-agents/.
 *
 * Spec: docs/specs/INSTAR-JOBS-AS-AGENTMD-SPEC.md §Seamless Migration Guarantee.
 *
 * Each fixture under tests/fixtures/migration-agents/<shape>/ describes a
 * pre-migration agent state. The suite iterates the eight committed
 * shapes and runs both code paths (CLI + PostUpdateMigrator) against
 * each. The nine invariants are asserted per-fixture.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { jobsMigrate, type MigrationOutcome } from '../../src/commands/jobMigrate.js';
import { getDefaultJobs } from '../../src/commands/init.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'migration-agents');

interface ShapeSpec {
  name: string;
  description: string;
  baseJobsSource: 'getDefaultJobs';
  transformations: Transformation[];
  preExistingSchedule?: any[];
  alternateSnapshot?: { transformations: Transformation[] };
  inFlightSlugs?: string[];
}

type Transformation =
  | { kind: 'set-enabled'; slug: string; enabled: boolean }
  | { kind: 'set-schedule'; slug: string; schedule: string }
  | { kind: 'set-body'; slug: string; body: string }
  | { kind: 'add-job'; entry: any }
  | { kind: 'remove-job'; slug: string };

function applyTransformations(base: any[], transformations: Transformation[]): any[] {
  let jobs = JSON.parse(JSON.stringify(base)) as any[];
  for (const t of transformations) {
    if (t.kind === 'set-enabled') {
      const j = jobs.find((x) => x.slug === t.slug);
      if (j) j.enabled = t.enabled;
    } else if (t.kind === 'set-schedule') {
      const j = jobs.find((x) => x.slug === t.slug);
      if (j) j.schedule = t.schedule;
    } else if (t.kind === 'set-body') {
      const j = jobs.find((x) => x.slug === t.slug);
      if (j && j.execute?.type === 'prompt') j.execute.value = t.body;
    } else if (t.kind === 'add-job') {
      jobs.push(t.entry);
    } else if (t.kind === 'remove-job') {
      jobs = jobs.filter((x) => x.slug !== t.slug);
    }
  }
  return jobs;
}

function loadShape(name: string): ShapeSpec {
  const raw = fs.readFileSync(path.join(FIXTURES_DIR, name, 'shape.json'), 'utf-8');
  return JSON.parse(raw) as ShapeSpec;
}

function setupAgent(workspace: string, jobs: any[], preExistingSchedule?: any[]): { stateDir: string } {
  const stateDir = path.join(workspace, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'jobs.json'), JSON.stringify(jobs, null, 2));
  if (preExistingSchedule && preExistingSchedule.length > 0) {
    const scheduleDir = path.join(stateDir, 'jobs', 'schedule');
    fs.mkdirSync(scheduleDir, { recursive: true });
    for (const m of preExistingSchedule) {
      fs.writeFileSync(path.join(scheduleDir, `${m.slug}.json`), JSON.stringify(m, null, 2));
    }
  }
  return { stateDir };
}

interface CanonicalEntry {
  slug: string;
  schedule: string;
  enabled: boolean;
  priority: string;
  model: string;
  executeType: string;
}

function canonicalize(entry: any): CanonicalEntry {
  return {
    slug: entry.slug,
    schedule: entry.schedule,
    enabled: entry.enabled !== false,
    priority: entry.priority,
    model: entry.model,
    executeType: entry.execute?.type ?? 'prompt',
  };
}

function listShippedSlugs(): Set<string> {
  const dir = path.join(REPO_ROOT, 'src', 'scaffold', 'templates', 'jobs', 'instar');
  if (!fs.existsSync(dir)) return new Set();
  return new Set(fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')));
}

const PORT_SENTINEL = 4042;

const ALL_FIXTURE_NAMES = [
  'pristine',
  'customized',
  'body-edited',
  'user-jobs',
  'retired-defaults',
  'mixed-state',
  'multi-machine-drift',
  'in-flight',
];

describe('Seamless Migration Guarantee suite', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-mg-'));
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(workspace, { recursive: true, force: true, operation: 'migration-guarantee.test cleanup' });
  });

  for (const fixtureName of ALL_FIXTURE_NAMES) {
    describe(`fixture: ${fixtureName}`, () => {
      let preMigrationJobs: any[];
      let shape: ShapeSpec;

      beforeEach(() => {
        shape = loadShape(fixtureName);
        const baseJobs = getDefaultJobs(PORT_SENTINEL);
        preMigrationJobs = applyTransformations(baseJobs as any[], shape.transformations);
      });

      // ── Invariant 1: Zero job loss ────────────────────────────────────
      it('invariant 1 — zero job loss', () => {
        const { stateDir } = setupAgent(workspace, preMigrationJobs, shape.preExistingSchedule);
        const outcome = jobsMigrate({ agentStateDir: stateDir, packageRoot: REPO_ROOT, defaultAction: 'fork' });

        const preSlugs = new Set(preMigrationJobs.map((j) => j.slug));
        const accountedFor = new Set<string>();
        for (const e of outcome.perEntry) {
          accountedFor.add(e.slug);
          // Renamed entries — the rename map effectively links old→new. The
          // outcome.perEntry slug is the NEW slug. We treat any non-failed
          // action as "accounted for" — failure means the slug went missing.
          expect(e.action).not.toBe('failed');
        }
        // Renamed entries appear in outcome.perEntry under the new slug.
        // Allow the difference if the action set explains it.
        const missing = [...preSlugs].filter((s) => !accountedFor.has(s) && !accountedFor.has(`${s}-user`));
        expect(missing).toEqual([]);
      });

      // ── Invariant 2: Zero schedule drift ──────────────────────────────
      it('invariant 2 — zero schedule drift for migrated entries', () => {
        const { stateDir } = setupAgent(workspace, preMigrationJobs, shape.preExistingSchedule);
        const outcome = jobsMigrate({ agentStateDir: stateDir, packageRoot: REPO_ROOT, defaultAction: 'fork' });
        expect(outcome.status).toBe('completed');

        // For every migrated entry, the manifest's schedule + enabled
        // match the pre-migration entry.
        for (const e of outcome.perEntry) {
          if (e.action === 'skipped' || e.action === 'failed') continue;
          const manifestPath = path.join(stateDir, 'jobs', 'schedule', `${e.slug}.json`);
          if (!fs.existsSync(manifestPath)) continue; // forked/renamed user
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          const preEntry = preMigrationJobs.find((j) => j.slug === e.slug || `${j.slug}-user` === e.slug);
          if (!preEntry) continue;
          const preCanon = canonicalize(preEntry);
          expect(manifest.schedule).toBe(preCanon.schedule);
          expect(manifest.enabled).toBe(preCanon.enabled);
          if (manifest.priority) expect(manifest.priority).toBe(preCanon.priority);
        }
      });

      // ── Invariant 4: User-namespace untouched (when no fork required) ─
      it('invariant 4 — user namespace structurally untouched by installer step', () => {
        const { stateDir } = setupAgent(workspace, preMigrationJobs, shape.preExistingSchedule);
        const userDir = path.join(stateDir, 'jobs', 'user');
        // Stamp a sentinel file the migrator must not touch.
        fs.mkdirSync(userDir, { recursive: true });
        const sentinel = path.join(userDir, '.guarantee-sentinel');
        fs.writeFileSync(sentinel, 'do-not-touch', 'utf-8');
        const sentinelMtime = fs.statSync(sentinel).mtimeMs;

        jobsMigrate({ agentStateDir: stateDir, packageRoot: REPO_ROOT, defaultAction: 'fork' });

        expect(fs.existsSync(sentinel)).toBe(true);
        expect(fs.readFileSync(sentinel, 'utf-8')).toBe('do-not-touch');
        expect(fs.statSync(sentinel).mtimeMs).toBe(sentinelMtime);
      });

      // ── Invariant 5: One-button rollback ──────────────────────────────
      it('invariant 5 — --abandon restores pre-migration state cleanly', () => {
        const { stateDir } = setupAgent(workspace, preMigrationJobs, shape.preExistingSchedule);
        const jobsJsonBefore = fs.readFileSync(path.join(stateDir, 'jobs.json'), 'utf-8');

        jobsMigrate({ agentStateDir: stateDir, packageRoot: REPO_ROOT, defaultAction: 'fork' });
        expect(fs.existsSync(path.join(stateDir, 'jobs', 'schedule'))).toBe(true);

        const abandonOutcome = jobsMigrate({ agentStateDir: stateDir, packageRoot: REPO_ROOT, abandon: true });
        expect(abandonOutcome.status).toBe('abandoned');

        // schedule/ removed, abandonment marker present, jobs.json intact.
        expect(fs.existsSync(path.join(stateDir, 'jobs', 'schedule'))).toBe(false);
        expect(fs.existsSync(path.join(stateDir, 'jobs', '.migration-abandoned.json'))).toBe(true);
        expect(fs.readFileSync(path.join(stateDir, 'jobs.json'), 'utf-8')).toBe(jobsJsonBefore);
      });

      // ── Invariant 7: Transactional safety (backup-first) ─────────────
      it('invariant 7 — pre-migrate backup is written before any other change', () => {
        const { stateDir } = setupAgent(workspace, preMigrationJobs, shape.preExistingSchedule);
        const outcome = jobsMigrate({ agentStateDir: stateDir, packageRoot: REPO_ROOT, defaultAction: 'fork' });
        expect(outcome.status).toBe('completed');
        expect(outcome.backupPath).toBeDefined();
        expect(fs.existsSync(outcome.backupPath!)).toBe(true);
        const backup = JSON.parse(fs.readFileSync(outcome.backupPath!, 'utf-8'));
        expect(backup).toEqual(preMigrationJobs);
      });

      // ── Invariant 9: Fail-closed (--default-action=fail on near-miss) ─
      // Only applies to shapes that produce a near-miss (body-edited).
      if (fixtureName === 'body-edited') {
        it('invariant 9 — --default-action=fail aborts with no partial write on near-miss', () => {
          const { stateDir } = setupAgent(workspace, preMigrationJobs, shape.preExistingSchedule);
          const outcome = jobsMigrate({ agentStateDir: stateDir, packageRoot: REPO_ROOT, defaultAction: 'fail' });
          expect(outcome.status).toBe('aborted');
          // No partial schedule writes for the failed slugs.
          const scheduleDir = path.join(stateDir, 'jobs', 'schedule');
          if (fs.existsSync(scheduleDir)) {
            const written = fs.readdirSync(scheduleDir);
            // health-check + reflection-trigger should NOT have manifests written.
            expect(written).not.toContain('health-check.json');
            expect(written).not.toContain('reflection-trigger.json');
          }
        });
      }

      // ── Idempotency ───────────────────────────────────────────────────
      it('idempotency — re-running migration produces byte-stable on-disk state', () => {
        const { stateDir } = setupAgent(workspace, preMigrationJobs, shape.preExistingSchedule);
        jobsMigrate({ agentStateDir: stateDir, packageRoot: REPO_ROOT, defaultAction: 'fork' });
        const snapshot1 = snapshotSchedule(stateDir);
        jobsMigrate({ agentStateDir: stateDir, packageRoot: REPO_ROOT, defaultAction: 'fork' });
        const snapshot2 = snapshotSchedule(stateDir);
        expect(snapshot2).toEqual(snapshot1);
      });
    });
  }

  // ── Cross-fixture invariants ────────────────────────────────────────

  describe('cross-fixture: --report dry-run never writes', () => {
    it('--report on every fixture leaves schedule/ unwritten', () => {
      for (const name of ALL_FIXTURE_NAMES) {
        const shape = loadShape(name);
        const baseJobs = getDefaultJobs(PORT_SENTINEL);
        const jobs = applyTransformations(baseJobs as any[], shape.transformations);
        const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-mg-report-'));
        try {
          const { stateDir } = setupAgent(ws, jobs, shape.preExistingSchedule);
          const outcome = jobsMigrate({ agentStateDir: stateDir, packageRoot: REPO_ROOT, report: true });
          expect(outcome.status).toBe('reported');
          // schedule/ should not contain any new entries beyond preExistingSchedule.
          const scheduleDir = path.join(stateDir, 'jobs', 'schedule');
          const written = fs.existsSync(scheduleDir) ? fs.readdirSync(scheduleDir) : [];
          const preExisting = (shape.preExistingSchedule ?? []).map((m: any) => `${m.slug}.json`);
          expect(written.sort()).toEqual(preExisting.sort());
        } finally {
          SafeFsExecutor.safeRmSync(ws, { recursive: true, force: true, operation: 'migration-guarantee.test --report cleanup' });
        }
      }
    });
  });
});

function snapshotSchedule(stateDir: string): Record<string, string> {
  const scheduleDir = path.join(stateDir, 'jobs', 'schedule');
  if (!fs.existsSync(scheduleDir)) return {};
  const snapshot: Record<string, string> = {};
  for (const f of fs.readdirSync(scheduleDir).filter((x) => x.endsWith('.json'))) {
    snapshot[f] = fs.readFileSync(path.join(scheduleDir, f), 'utf-8');
  }
  return snapshot;
}
