// safe-fs-allow: test file — SafeFsExecutor removes only the per-test tmpdir.
/**
 * Jev job-completion audit — WIRING-INTEGRITY tier
 * (spec: docs/specs/jev-job-supervision.md §Migration).
 *
 * The round-2 review caught `supervision` as forward vocabulary that never
 * reached runtime; these tests prove `completionAudit`/`declaredEffects`
 * actually reach `JobDefinition`, that the manifest validator jails paths at
 * load, that the built-in batch job excludes itself, and that the migrator
 * installs the dark config default + the CLAUDE.md card idempotently.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateManifest } from '../../src/scheduler/AgentMdJobLoader.js';
import { installBuiltinJobs } from '../../src/scheduler/InstallBuiltinJobs.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type Result = { upgraded: string[]; skipped: string[]; errors: string[] };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'jev-audit-wiring-test.cleanup' });
});

function baseManifest(over: Record<string, unknown> = {}) {
  return {
    slug: 'wiring-job',
    origin: 'user',
    schedule: '0 * * * *',
    priority: 'low',
    expectedDurationMinutes: 5,
    enabled: true,
    execute: { type: 'script', value: 'echo hi' },
    ...over,
  };
}

describe('manifest validation + jail (load-time)', () => {
  it('accepts completionAudit values and declaredEffects, and they survive validation', () => {
    const m = validateManifest(baseManifest({ completionAudit: 'priority', declaredEffects: ['out/report.md'] }));
    expect(m.completionAudit).toBe('priority');
    expect(m.declaredEffects).toEqual(['out/report.md']);
  });

  it('refuses a bad completionAudit value by name', () => {
    expect(() => validateManifest(baseManifest({ completionAudit: 'sometimes' }))).toThrow(/completionAudit/);
  });

  it('jails declaredEffects at load: absolute paths, traversal and oversize lists refused', () => {
    expect(() => validateManifest(baseManifest({ declaredEffects: ['/etc/passwd'] }))).toThrow(/repo-relative/);
    expect(() => validateManifest(baseManifest({ declaredEffects: ['a/../../b'] }))).toThrow(/repo-relative/);
    expect(() => validateManifest(baseManifest({ declaredEffects: ['C:secret'] }))).toThrow(/repo-relative/);
    expect(() => validateManifest(baseManifest({ declaredEffects: Array(9).fill('x.txt') }))).toThrow(/at most 8/);
  });
});

describe('the built-in batch job excludes itself (no self-audit recursion)', () => {
  it('template carries completionAudit: excluded and ships disabled', () => {
    const tpl = fs.readFileSync(
      path.resolve(__dirname, '../../src/scaffold/templates/jobs/instar/jev-completion-audit.md'),
      'utf8',
    );
    expect(tpl).toContain('completionAudit: excluded');
    expect(tpl).toContain('enabled: false');
    expect(tpl).toContain('/jev-audit/batch');
  });
});

describe('the INSTALLED manifest carries the audit vocabulary (the loader reads the manifest, not the frontmatter)', () => {
  it('buildPerSlugManifest carries completionAudit and declaredEffects', async () => {
    const { buildPerSlugManifest } = await import('../../src/scheduler/buildPerSlugManifest.js');
    const m = buildPerSlugManifest({
      slug: 'x', origin: 'instar', schedule: '0 * * * *', priority: 'low',
      expectedDurationMinutes: 5, enabled: true, execute: { type: 'agentmd' },
      completionAudit: 'excluded', declaredEffects: ['out/a.md'],
    } as never);
    // Without these the batch job's own self-exclusion is silently inert.
    expect(m.completionAudit).toBe('excluded');
    expect(m.declaredEffects).toEqual(['out/a.md']);
  });

  it('installBuiltinJobs writes the batch job manifest with completionAudit: excluded', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-audit-install-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
    const report = installBuiltinJobs({
      agentStateDir: path.join(dir, '.instar'),
      packageRoot: path.resolve(__dirname, '../..'),
      port: 4042,
    });
    expect(report.errors).toEqual([]);
    const manifestPath = path.join(dir, '.instar', 'jobs', 'schedule', 'jev-completion-audit.json');
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(manifest.completionAudit).toBe('excluded'); // the auditor never audits itself
  });
});

describe('PostUpdateMigrator — dark config default + CLAUDE.md card (Migration Parity)', () => {
  function project(): { dir: string; run: () => Result } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-audit-mig-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.instar', 'config.json'), JSON.stringify({ projectName: 'test', port: 4040 }));
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Existing agent\n');
    const run = (): Result => {
      const m = new PostUpdateMigrator({ port: 4040, stateDir: path.join(dir, '.instar'), projectDir: dir, hasTelegram: false, projectName: 'test' } as never);
      const result: Result = { upgraded: [], skipped: [], errors: [] };
      (m as unknown as { migrateConfig(r: Result): void }).migrateConfig(result);
      (m as unknown as { migrateClaudeMd(r: Result): void }).migrateClaudeMd(result);
      return result;
    };
    return { dir, run };
  }

  it('installs the dark default and the card, idempotently', () => {
    const p = project();
    const first = p.run();
    expect(first.errors).toEqual([]);
    const cfg = JSON.parse(fs.readFileSync(path.join(p.dir, '.instar', 'config.json'), 'utf8'));
    expect(cfg.intelligence.jevJobCompletionAudit).toEqual({
      enabled: false,
      model: 'jev-1.13.0',
      timeoutMs: 2500,
      soakEndsAt: null,
      dailyCallCap: 1500,
      batchIntervalHours: 6,
    });
    const md = fs.readFileSync(path.join(p.dir, 'CLAUDE.md'), 'utf8');
    expect(md).toContain('### Jev Job-Completion Audit');
    expect(md).toContain('an audit record, not supervision');

    // Idempotent: second run changes nothing and never overwrites operator edits.
    cfg.intelligence.jevJobCompletionAudit.enabled = true;
    fs.writeFileSync(path.join(p.dir, '.instar', 'config.json'), JSON.stringify(cfg));
    const second = p.run();
    expect(second.skipped.some((s) => s.includes('jevJobCompletionAudit already present'))).toBe(true);
    const cfg2 = JSON.parse(fs.readFileSync(path.join(p.dir, '.instar', 'config.json'), 'utf8'));
    expect(cfg2.intelligence.jevJobCompletionAudit.enabled).toBe(true); // operator value preserved
    expect(fs.readFileSync(path.join(p.dir, 'CLAUDE.md'), 'utf8').match(/### Jev Job-Completion Audit/g)).toHaveLength(1);
  });
});

describe('structural absence: the wake-reaper path never reaches the audit', () => {
  it('reapStuckRuns carries no jevAudit reference while both completion callsites do', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/scheduler/JobScheduler.ts'), 'utf8');
    const reaper = src.slice(src.indexOf('reapStuckRuns'), src.indexOf('reapStuckRuns') + 6000);
    expect(reaper).not.toContain('jevAudit');
    // Both live-output callsites are wired:
    expect(src.match(/this\.jevAudit\?\.capture\(/g)?.length).toBe(3); // model-session + script then/catch
  });
});

describe('conditionalEffects reaches the INSTALLED manifest (the loader reads the manifest, not the frontmatter)', () => {
  it('buildPerSlugManifest carries conditionalEffects', async () => {
    const { buildPerSlugManifest } = await import('../../src/scheduler/buildPerSlugManifest.js');
    const m = buildPerSlugManifest({
      slug: 'x', origin: 'instar', schedule: '0 * * * *', priority: 'low',
      expectedDurationMinutes: 5, enabled: true, execute: { type: 'agentmd' },
      conditionalEffects: ['.instar/MEMORY.md'],
    } as never);
    expect(m.conditionalEffects).toEqual(['.instar/MEMORY.md']);
  });

  it('installBuiltinJobs writes the two declaring jobs with their conditional effects — read from the installed artifact', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-cond-install-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
    const report = installBuiltinJobs({
      agentStateDir: path.join(dir, '.instar'),
      packageRoot: path.resolve(__dirname, '../..'),
      port: 4042,
    });
    expect(report.errors).toEqual([]);
    const read = (slug: string) => JSON.parse(fs.readFileSync(path.join(dir, '.instar', 'jobs', 'schedule', `${slug}.json`), 'utf8'));
    expect(read('reflection-trigger').conditionalEffects).toEqual(['.instar/MEMORY.md']);
    expect(read('commitment-detection').conditionalEffects).toEqual(['.instar/state/commitment-detection-bookmark.json']);
    // The templates instruct the run to print the claim marker for exactly those paths.
    const tpl = (slug: string) => fs.readFileSync(path.resolve(__dirname, `../../src/scaffold/templates/jobs/instar/${slug}.md`), 'utf8');
    expect(tpl('reflection-trigger')).toContain('EFFECT: .instar/MEMORY.md');
    expect(tpl('commitment-detection')).toContain('EFFECT: .instar/state/commitment-detection-bookmark.json');
  });
});

describe('conditionalEffects shares the declaredEffects jail at load', () => {
  it('accepts a repo-relative entry and refuses traversal/absolute by name', () => {
    const m = validateManifest(baseManifest({ conditionalEffects: ['.instar/MEMORY.md'] }));
    expect(m.conditionalEffects).toEqual(['.instar/MEMORY.md']);
    expect(() => validateManifest(baseManifest({ conditionalEffects: ['../escape.md'] }))).toThrow(/conditionalEffects.*repo-relative/);
    expect(() => validateManifest(baseManifest({ conditionalEffects: ['/etc/passwd'] }))).toThrow(/conditionalEffects.*repo-relative/);
    expect(() => validateManifest(baseManifest({ conditionalEffects: Array.from({ length: 9 }, (_, i) => `f${i}`) }))).toThrow(/at most 8/);
  });
});
