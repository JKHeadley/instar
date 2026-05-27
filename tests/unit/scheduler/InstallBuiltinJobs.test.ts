/**
 * Phase 2 — installBuiltinJobs() unit tests.
 *
 * Asserts the Seamless Migration Guarantee invariants that apply at the
 * installer layer (PR #180 §Seamless Migration Guarantee):
 *
 *   #4 User-namespace untouched — no file under `.instar/jobs/user/` is
 *      created, modified, or removed by the installer.
 *   #1 Zero job loss — every shipped template appears in the installer
 *      output and corresponds to a manifest in `.instar/jobs/schedule/`.
 *   Retired-defaults flow — a slug no longer in the shipped templates is
 *      removed from `.instar/jobs/instar/` and its manifest is marked
 *      retired+disabled (Phase 4 Dashboard surface).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { installBuiltinJobs } from '../../../src/scheduler/InstallBuiltinJobs.js';
import { validateManifest } from '../../../src/scheduler/AgentMdJobLoader.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

describe('installBuiltinJobs', () => {
  let workspace: string;
  let agentStateDir: string;
  let packageRoot: string;
  let templatesDir: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-installBJ-'));
    agentStateDir = path.join(workspace, 'agent', '.instar');
    packageRoot = path.join(workspace, 'pkg');
    templatesDir = path.join(packageRoot, 'src', 'scaffold', 'templates', 'jobs', 'instar');
    fs.mkdirSync(templatesDir, { recursive: true });
    fs.mkdirSync(agentStateDir, { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(workspace, { recursive: true, force: true, operation: 'InstallBuiltinJobs.test cleanup' });
  });

  function writeTemplate(slug: string, body: string, frontmatter: Record<string, unknown> = {}) {
    const fm = {
      name: frontmatter.name ?? slug,
      description: frontmatter.description ?? `${slug} desc`,
      schedule: frontmatter.schedule ?? '*/5 * * * *',
      priority: frontmatter.priority ?? 'low',
      expectedDurationMinutes: frontmatter.expectedDurationMinutes ?? '1',
      model: frontmatter.model ?? 'haiku',
      enabled: frontmatter.enabled ?? 'true',
      toolAllowlist: frontmatter.toolAllowlist ?? '*',
      unrestrictedTools: frontmatter.unrestrictedTools ?? 'true',
    };
    const fmYaml = Object.entries(fm)
      .map(([k, v]) => {
        if (Array.isArray(v)) return `${k}: [${v.map((x) => `"${x}"`).join(', ')}]`;
        return `${k}: "${v}"`;
      })
      .join('\n');
    fs.writeFileSync(path.join(templatesDir, `${slug}.md`), `---\n${fmYaml}\n---\n${body}`, 'utf-8');
  }

  it('installs each shipped template into .instar/jobs/instar/ and writes the per-slug manifest', () => {
    writeTemplate('alpha', 'alpha body\n');
    writeTemplate('beta', 'beta body\n');

    const report = installBuiltinJobs({ agentStateDir, packageRoot, port: 4042 });

    expect(report.installed.sort()).toEqual(['alpha', 'beta']);
    expect(report.retired).toEqual([]);
    expect(report.errors).toEqual([]);

    expect(fs.existsSync(path.join(agentStateDir, 'jobs', 'instar', 'alpha.md'))).toBe(true);
    expect(fs.existsSync(path.join(agentStateDir, 'jobs', 'instar', 'beta.md'))).toBe(true);

    const alphaManifest = JSON.parse(
      fs.readFileSync(path.join(agentStateDir, 'jobs', 'schedule', 'alpha.json'), 'utf-8'),
    );
    expect(alphaManifest.slug).toBe('alpha');
    expect(alphaManifest.origin).toBe('instar');
    expect(alphaManifest.execute.type).toBe('agentmd');
    expect(alphaManifest.enabled).toBe(true);
  });

  it('REGRESSION: EVERY real shipped built-in template produces a manifest the loader accepts', () => {
    // The fleet-wide check: install the ACTUAL shipped templates and assert every
    // generated manifest passes validateManifest (jobCount would be 0 otherwise).
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const realAgentDir = path.join(workspace, 'real-agent', '.instar');
    fs.mkdirSync(realAgentDir, { recursive: true });
    const report = installBuiltinJobs({ agentStateDir: realAgentDir, packageRoot: repoRoot, port: 4042 });
    expect(report.errors).toEqual([]);
    expect(report.installed.length).toBeGreaterThanOrEqual(10); // the shipped built-in set
    const scheduleDir = path.join(realAgentDir, 'jobs', 'schedule');
    for (const slug of report.installed) {
      const m = JSON.parse(fs.readFileSync(path.join(scheduleDir, `${slug}.json`), 'utf-8'));
      expect(() => validateManifest(m, slug), `manifest for "${slug}" must pass the loader`).not.toThrow();
    }
  });

  it('REGRESSION: generated manifest carries priority/expectedDurationMinutes/model and PASSES the loader validator (round-trip)', () => {
    // The bug: built-in manifests omitted priority/expectedDurationMinutes/model
    // that the loader REQUIRES → jobCount=0 fleet-wide. The strongest guard is to
    // round-trip the producer's output through the consumer's validator.
    writeTemplate('gamma', 'gamma body\n', { priority: 'high', expectedDurationMinutes: '7', model: 'sonnet' });
    const report = installBuiltinJobs({ agentStateDir, packageRoot, port: 4042 });
    expect(report.errors).toEqual([]);

    const m = JSON.parse(fs.readFileSync(path.join(agentStateDir, 'jobs', 'schedule', 'gamma.json'), 'utf-8'));
    expect(m.priority).toBe('high');
    expect(m.expectedDurationMinutes).toBe(7); // coerced string "7" → number
    expect(typeof m.expectedDurationMinutes).toBe('number');
    expect(m.model).toBe('sonnet');
    // The actual anti-regression assertion: the loader accepts our output.
    expect(() => validateManifest(m, 'gamma')).not.toThrow();
  });

  it('carries the manifest pass-throughs the loader reads (unrestrictedTools, tags)', () => {
    // Write the template directly so it carries a tags sequence + unrestrictedTools.
    fs.writeFileSync(
      path.join(templatesDir, 'delta.md'),
      `---\nname: "delta"\ndescription: "d"\nschedule: "*/5 * * * *"\npriority: "medium"\nexpectedDurationMinutes: "2"\nmodel: "haiku"\nenabled: "true"\nunrestrictedTools: "true"\ntags:\n  - cat:learning\n  - audit\n---\ndelta body\n`,
      'utf-8',
    );
    installBuiltinJobs({ agentStateDir, packageRoot, port: 4042 });
    const m = JSON.parse(fs.readFileSync(path.join(agentStateDir, 'jobs', 'schedule', 'delta.json'), 'utf-8'));
    expect(m.unrestrictedTools).toBe(true); // coerced "true" → boolean
    expect(m.tags).toEqual(['cat:learning', 'audit']);
  });

  it('FAILS LOUD (report.errors, no manifest) when expectedDurationMinutes is missing/invalid — not a silent broken manifest', () => {
    // Write a template whose duration is non-numeric.
    fs.writeFileSync(
      path.join(templatesDir, 'broken.md'),
      `---\nname: "broken"\ndescription: "d"\nschedule: "*/5 * * * *"\npriority: "low"\nexpectedDurationMinutes: "soon"\nmodel: "haiku"\nenabled: "true"\n---\nbody\n`,
      'utf-8',
    );
    const report = installBuiltinJobs({ agentStateDir, packageRoot, port: 4042 });
    expect(report.errors.some((e) => e.slug === 'broken')).toBe(true);
    // No half-baked manifest written.
    expect(fs.existsSync(path.join(agentStateDir, 'jobs', 'schedule', 'broken.json'))).toBe(false);
  });

  it('substitutes the port sentinel 4042 → the agent\'s configured port in body content', () => {
    writeTemplate('port-test', 'curl http://localhost:${INSTAR_PORT:-4042}/health\n');

    installBuiltinJobs({ agentStateDir, packageRoot, port: 4099 });

    const onDisk = fs.readFileSync(path.join(agentStateDir, 'jobs', 'instar', 'port-test.md'), 'utf-8');
    expect(onDisk).toContain(':-4099}/health');
    expect(onDisk).not.toContain(':-4042}/health');
  });

  it('preserves operator-disabled state on update (does not re-enable a disabled default)', () => {
    writeTemplate('toggle-test', 'body v1\n', { enabled: 'true' });
    installBuiltinJobs({ agentStateDir, packageRoot, port: 4042 });

    // Operator disables the job.
    const manifestPath = path.join(agentStateDir, 'jobs', 'schedule', 'toggle-test.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    manifest.enabled = false;
    manifest.disabledAtBodyHash = 'sha256:fake-hash';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    // Update: same default with different body.
    writeTemplate('toggle-test', 'body v2\n', { enabled: 'true' });
    installBuiltinJobs({ agentStateDir, packageRoot, port: 4042 });

    const reread = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(reread.enabled).toBe(false); // preserved
    expect(reread.disabledAtBodyHash).toBe('sha256:fake-hash'); // preserved
    // Body refreshed:
    const newBody = fs.readFileSync(path.join(agentStateDir, 'jobs', 'instar', 'toggle-test.md'), 'utf-8');
    expect(newBody).toContain('body v2');
  });

  it('retires a default that is removed from the shipped templates', () => {
    writeTemplate('alpha', 'a\n');
    writeTemplate('to-be-retired', 'r\n');
    installBuiltinJobs({ agentStateDir, packageRoot, port: 4042 });

    expect(fs.existsSync(path.join(agentStateDir, 'jobs', 'instar', 'to-be-retired.md'))).toBe(true);

    // Update: to-be-retired is no longer shipped.
    SafeFsExecutor.safeUnlinkSync(path.join(templatesDir, 'to-be-retired.md'), { operation: 'InstallBuiltinJobs.test simulate template removal' });
    const report = installBuiltinJobs({ agentStateDir, packageRoot, port: 4042 });

    expect(report.retired).toEqual(['to-be-retired']);
    expect(fs.existsSync(path.join(agentStateDir, 'jobs', 'instar', 'to-be-retired.md'))).toBe(false);

    // Manifest remains but is marked retired + disabled.
    const retiredManifest = JSON.parse(
      fs.readFileSync(path.join(agentStateDir, 'jobs', 'schedule', 'to-be-retired.json'), 'utf-8'),
    );
    expect(retiredManifest.enabled).toBe(false);
    expect(retiredManifest.retiredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(retiredManifest.retiredReason).toBe('instar-default-removed');
  });

  it('NEVER touches .instar/jobs/user/ (Seamless Migration Guarantee invariant 4)', () => {
    writeTemplate('alpha', 'a\n');
    const userDir = path.join(agentStateDir, 'jobs', 'user');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'my-job.md'), '---\nname: My Job\n---\nbody', 'utf-8');
    const userMtimeBefore = fs.statSync(path.join(userDir, 'my-job.md')).mtimeMs;

    installBuiltinJobs({ agentStateDir, packageRoot, port: 4042 });

    expect(fs.existsSync(path.join(userDir, 'my-job.md'))).toBe(true);
    const userMtimeAfter = fs.statSync(path.join(userDir, 'my-job.md')).mtimeMs;
    expect(userMtimeAfter).toBe(userMtimeBefore);
    // No new files created under user/.
    expect(fs.readdirSync(userDir)).toEqual(['my-job.md']);
  });

  it('refuses to install if .instar/jobs/user/ is a symlink (security check)', () => {
    writeTemplate('alpha', 'a\n');
    const userDir = path.join(agentStateDir, 'jobs', 'user');
    const decoy = path.join(workspace, 'attacker-target');
    fs.mkdirSync(decoy, { recursive: true });
    fs.mkdirSync(path.dirname(userDir), { recursive: true });
    fs.symlinkSync(decoy, userDir);

    const report = installBuiltinJobs({ agentStateDir, packageRoot, port: 4042 });

    expect(report.installed).toEqual([]);
    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.errors[0].reason).toContain('not a regular directory');
  });

  it('copies the signed lock-file and public key when present in packageRoot/dist', () => {
    writeTemplate('alpha', 'a\n');
    const distJobs = path.join(packageRoot, 'dist', 'jobs');
    const distKeys = path.join(packageRoot, 'dist', 'keys');
    fs.mkdirSync(distJobs, { recursive: true });
    fs.mkdirSync(distKeys, { recursive: true });
    fs.writeFileSync(path.join(distJobs, 'instar.lock.json'), '{"signed":"yes"}', 'utf-8');
    fs.writeFileSync(path.join(distKeys, 'instar-release-pub.pem'), 'pubkey', 'utf-8');

    installBuiltinJobs({ agentStateDir, packageRoot, port: 4042 });

    expect(fs.readFileSync(path.join(agentStateDir, 'jobs', 'instar.lock.json'), 'utf-8')).toBe('{"signed":"yes"}');
    expect(fs.readFileSync(path.join(agentStateDir, 'keys', 'instar-release-pub.pem'), 'utf-8')).toBe('pubkey');
  });

  it('removes a stale lock-file when no signed file ships', () => {
    writeTemplate('alpha', 'a\n');
    const jobsDir = path.join(agentStateDir, 'jobs');
    fs.mkdirSync(jobsDir, { recursive: true });
    const staleLock = path.join(jobsDir, 'instar.lock.json');
    fs.writeFileSync(staleLock, '{"stale":"yes"}', 'utf-8');

    installBuiltinJobs({ agentStateDir, packageRoot, port: 4042 });

    expect(fs.existsSync(staleLock)).toBe(false);
  });

  it('returns an error when the templates directory is absent or empty', () => {
    // Templates dir exists (created by beforeEach) but has no .md files.
    const report = installBuiltinJobs({ agentStateDir, packageRoot, port: 4042 });
    expect(report.installed).toEqual([]);
    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.errors[0].reason).toContain('No agentmd templates directory');
  });

  it('is idempotent — running twice produces the same on-disk state', () => {
    writeTemplate('alpha', 'a\n');
    writeTemplate('beta', 'b\n');

    installBuiltinJobs({ agentStateDir, packageRoot, port: 4042 });
    const snapshot1 = snapshotInstallTree(agentStateDir);

    installBuiltinJobs({ agentStateDir, packageRoot, port: 4042 });
    const snapshot2 = snapshotInstallTree(agentStateDir);

    // Body content + manifest content stable; mtimes will differ (each call
    // overwrites), but the textual content is what the spec asserts.
    expect(snapshot2.bodies).toEqual(snapshot1.bodies);
    expect(snapshot2.manifests).toEqual(snapshot1.manifests);
  });
});

function snapshotInstallTree(agentStateDir: string): { bodies: Record<string, string>; manifests: Record<string, string> } {
  const bodies: Record<string, string> = {};
  const manifests: Record<string, string> = {};
  const installedDir = path.join(agentStateDir, 'jobs', 'instar');
  const scheduleDir = path.join(agentStateDir, 'jobs', 'schedule');
  for (const f of fs.readdirSync(installedDir).filter((x) => x.endsWith('.md'))) {
    bodies[f] = fs.readFileSync(path.join(installedDir, f), 'utf-8');
  }
  for (const f of fs.readdirSync(scheduleDir).filter((x) => x.endsWith('.json'))) {
    manifests[f] = fs.readFileSync(path.join(scheduleDir, f), 'utf-8');
  }
  return { bodies, manifests };
}
