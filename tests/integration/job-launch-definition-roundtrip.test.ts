/**
 * T7 (frozen acceptance list, step3/acceptance-tests.md): `thinkingMode` survives every job
 * definition path (spec job-launch-intent-record §1). One fixture goes through legacy load,
 * jobMigrate, buildPerSlugManifest, install (a built-in-shaped fixture), agentmd load, and
 * private portable export + import, keeping the value throughout. An invalid value fails at
 * load on the legacy, manifest and frontmatter (install) paths.
 * The chain is CONTINUOUS: each step reads the previous step's output (file or loaded job).
 * Red on main: the field is dropped (or refused as unknown) on some path.
 *
 * Contract choices (the spec says "fails at load through the existing error path"):
 *   - legacy: validateJob throws naming "thinkingMode"; loadJobsDetailed withholds the entry.
 *   - manifest: validateManifest throws naming "thinkingMode".
 *   - frontmatter: installBuiltinJobs reports an error for that slug naming "thinkingMode"
 *     and does not install a job carrying the invalid value.
 *   - portable import is validatePortableBundle + writing its files into a fresh agent home.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { loadJobsDetailed, validateJob } from '../../src/scheduler/JobLoader.js';
import { validateManifest } from '../../src/scheduler/AgentMdJobLoader.js';
import { buildPerSlugManifest } from '../../src/scheduler/buildPerSlugManifest.js';
import { installBuiltinJobs } from '../../src/scheduler/InstallBuiltinJobs.js';
import { jobsMigrate } from '../../src/commands/jobMigrate.js';
import { collectPortableJob, validatePortableBundle } from '../../src/core/JobPortableBundle.js';

const SLUG = 'think-low-job';
const VALUE = 'low';
type Job = { slug: string; thinkingMode?: unknown };

const legacyEntry = (extra: Record<string, unknown> = {}) => ({
  slug: SLUG, name: 'Think low', description: 'A user job that thinks a little',
  schedule: '0 9 * * *', priority: 'medium', expectedDurationMinutes: 5, model: 'opus', enabled: true,
  execute: { type: 'prompt', value: 'Look over the open bugs.\n' }, thinkingMode: VALUE, ...extra,
});

const baseManifest = (extra: Record<string, unknown> = {}) => ({
  slug: SLUG, origin: 'user', schedule: '0 9 * * *', priority: 'medium', expectedDurationMinutes: 5,
  enabled: true, execute: { type: 'agentmd' }, ...extra,
});

function find(jobs: Job[], slug = SLUG): Job | undefined { return jobs.find((j) => j.slug === slug); }
function load(stateDir: string) { return loadJobsDetailed(path.join(stateDir, 'jobs.json'), { quiet: true }); }

describe('T7 thinkingMode definition round-trip', () => {
  let workspace: string;
  let stateDir: string;
  let packageRoot: string;
  let templatesDir: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'job-launch-roundtrip-'));
    stateDir = path.join(workspace, 'agent', '.instar');
    packageRoot = path.join(workspace, 'pkg');
    templatesDir = path.join(packageRoot, 'src', 'scaffold', 'templates', 'jobs', 'instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(templatesDir, { recursive: true });
  });
  afterEach(() => SafeFsExecutor.safeRmSync(workspace, { recursive: true, force: true, operation: 'tests/integration/job-launch-definition-roundtrip.test.ts:cleanup' }));

  it('one fixture, continuously: legacy load → jobMigrate → agentmd load → buildPerSlugManifest → install → portable export → import → load', () => {
    // Each step's INPUT is the previous step's OUTPUT, so the value is only ever carried, never re-typed.
    // 1. legacy jobs.json → legacy load
    fs.writeFileSync(path.join(stateDir, 'jobs.json'), JSON.stringify([legacyEntry()], null, 2));
    const legacy = find(load(stateDir).jobs as Job[]);
    expect(legacy, 'legacy loader withheld the job').toBeDefined();
    expect(legacy!.thinkingMode, 'legacy load dropped thinkingMode').toBe(VALUE);

    // 2. jobMigrate (picks fields explicitly) reads that same legacy file
    const outcome = jobsMigrate({ agentStateDir: stateDir, packageRoot, defaultAction: 'fork', interactive: false });
    expect(outcome.errors).toEqual([]);
    const manifestPath = path.join(stateDir, 'jobs', 'schedule', `${SLUG}.json`);
    expect(fs.existsSync(manifestPath)).toBe(true);
    const migratedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
    expect(migratedManifest.thinkingMode, 'jobMigrate dropped thinkingMode from the manifest').toBe(VALUE);

    // 3. agentmd load of the migrated manifest
    const migrated = find(load(stateDir).jobs as Job[]) as (Job & Record<string, unknown>) | undefined;
    expect(migrated, 'agentmd loader withheld the migrated job').toBeDefined();
    expect(migrated!.thinkingMode, 'agentmd load dropped thinkingMode').toBe(VALUE);

    // 4. buildPerSlugManifest, fed from the loaded job (step 3's output), then validated and loaded again
    const rebuilt = buildPerSlugManifest({
      slug: SLUG, origin: 'user', schedule: migrated!.schedule, priority: migrated!.priority,
      expectedDurationMinutes: migrated!.expectedDurationMinutes, enabled: migrated!.enabled,
      execute: migratedManifest.execute, ...(migrated!.model ? { model: migrated!.model } : {}),
      thinkingMode: migrated!.thinkingMode,
    } as Parameters<typeof buildPerSlugManifest>[0]) as unknown as Record<string, unknown>;
    expect(rebuilt.thinkingMode, 'buildPerSlugManifest dropped thinkingMode').toBe(VALUE);
    expect((validateManifest(rebuilt, SLUG) as unknown as Record<string, unknown>).thinkingMode).toBe(VALUE);
    fs.writeFileSync(manifestPath, JSON.stringify(rebuilt, null, 2));
    const rebuiltJob = find(load(stateDir).jobs as Job[]);
    expect(rebuiltJob?.thinkingMode, 'load of the rebuilt manifest dropped thinkingMode').toBe(VALUE);

    // 5. install: a built-in-shaped template whose frontmatter value is step 4's loaded value
    const BUILTIN = `${SLUG}-builtin`;
    fs.writeFileSync(path.join(templatesDir, `${BUILTIN}.md`),
      `---\nname: ${BUILTIN}\ndescription: d\nschedule: "*/5 * * * *"\npriority: low\nexpectedDurationMinutes: 1\nmodel: haiku\nenabled: true\ntoolAllowlist: "*"\nunrestrictedTools: true\nthinkingMode: ${String(rebuiltJob!.thinkingMode)}\n---\nbody\n`);
    const report = installBuiltinJobs({ agentStateDir: stateDir, packageRoot, port: 4042 });
    expect(report.errors).toEqual([]);
    expect(report.installed).toContain(BUILTIN);
    const installedManifest = JSON.parse(fs.readFileSync(path.join(stateDir, 'jobs', 'schedule', `${BUILTIN}.json`), 'utf-8'));
    expect(installedManifest.thinkingMode, 'install dropped thinkingMode from the manifest').toBe(VALUE);
    const afterInstall = load(stateDir);
    const installed = find(afterInstall.jobs as Job[], BUILTIN);
    expect(installed, `installed job withheld: ${JSON.stringify(afterInstall.problems)}`).toBeDefined();
    expect(installed!.thinkingMode, 'agentmd load of the installed job dropped thinkingMode').toBe(VALUE);

    // 6. portable export (closed MANIFEST_KEYS set) of the user job, carrying step 5's loaded value
    fs.writeFileSync(manifestPath, JSON.stringify({ ...rebuilt, thinkingMode: installed!.thinkingMode, portable: true, requiredPaths: [] }, null, 2));
    const projectRoot = path.dirname(stateDir);
    const bundle = collectPortableJob(projectRoot, stateDir, SLUG);

    // 7. portable import into a fresh agent home, then load there
    const validated = validatePortableBundle(JSON.parse(JSON.stringify(bundle)));
    const destRoot = path.join(workspace, 'peer');
    const destState = path.join(destRoot, '.instar');
    for (const f of validated.files) {
      const target = path.join(destRoot, f.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(f.content, 'base64'));
    }
    const imported = find(load(destState).jobs as Job[]);
    expect(imported, 'imported job did not load').toBeDefined();
    expect(imported!.thinkingMode, 'portable import dropped thinkingMode').toBe(VALUE);
  });

  it('buildPerSlugManifest omits the key when the field is absent', () => {
    expect('thinkingMode' in buildPerSlugManifest({ ...baseManifest(), origin: 'user', priority: 'medium', execute: { type: 'agentmd' } } as Parameters<typeof buildPerSlugManifest>[0])).toBe(false);
  });

  it('agentmd user job: manifest value is authority, frontmatter key is allowed (decorative)', () => {
    fs.mkdirSync(path.join(stateDir, 'jobs', 'schedule'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'jobs', 'user'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'jobs', 'schedule', `${SLUG}.json`), JSON.stringify(baseManifest({ thinkingMode: VALUE })));
    fs.writeFileSync(path.join(stateDir, 'jobs', 'user', `${SLUG}.md`), `---\nname: ${SLUG}\ndescription: d\nthinkingMode: high\n---\nbody\n`);
    const result = load(stateDir);
    const job = find(result.jobs as Job[]);
    expect(job, `agentmd job withheld: ${JSON.stringify(result.problems)}`).toBeDefined();
    expect(job!.thinkingMode).toBe(VALUE);
  });

  describe('an invalid value fails at load', () => {
    it('legacy: validateJob names the field; the loader withholds the entry', () => {
      expect(() => validateJob(legacyEntry())).not.toThrow();
      expect(() => validateJob(legacyEntry({ thinkingMode: 'ultra' }))).toThrow(/thinkingMode/);
      fs.writeFileSync(path.join(stateDir, 'jobs.json'), JSON.stringify([legacyEntry({ thinkingMode: 'ultra' })]));
      expect(find(load(stateDir).jobs as Job[])).toBeUndefined();
    });

    it('manifest: validateManifest names the field', () => {
      expect(() => validateManifest(baseManifest({ thinkingMode: VALUE }), SLUG)).not.toThrow();
      expect(() => validateManifest(baseManifest({ thinkingMode: 'ultra' }), SLUG)).toThrow(/thinkingMode/);
      expect(() => validateManifest(baseManifest({ thinkingMode: 3 }), SLUG)).toThrow(/thinkingMode/);
    });

    it('frontmatter (install): an invalid value is reported and never installed with that value', () => {
      fs.writeFileSync(path.join(templatesDir, `${SLUG}.md`),
        `---\nname: ${SLUG}\ndescription: d\nschedule: "*/5 * * * *"\npriority: low\nexpectedDurationMinutes: 1\nmodel: haiku\nenabled: true\ntoolAllowlist: "*"\nunrestrictedTools: true\nthinkingMode: ultra\n---\nbody\n`);
      const report = installBuiltinJobs({ agentStateDir: stateDir, packageRoot, port: 4042 });
      expect(report.errors.some((e) => e.slug === SLUG && /thinkingMode/.test(e.reason)), `no thinkingMode error: ${JSON.stringify(report.errors)}`).toBe(true);
      const job = find(load(stateDir).jobs as Job[]);
      expect(job?.thinkingMode).not.toBe('ultra');
    });
  });
});
