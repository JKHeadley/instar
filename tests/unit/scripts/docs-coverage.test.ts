// safe-git-allow: test-fixture-fs — spawns the script against a tmpdir mock-repo to verify coverage scoring.
/**
 * Tests for scripts/docs-coverage.mjs — Phase 1 of the docs-coverage
 * tooling that closes the manual-audit feedback loop on instar's docs.
 *
 * We build a tiny mock repo on disk (a src/ tree, a site/src/content/docs/
 * tree, a README.md, a skills/ tree), run the script against it via spawn
 * with cwd set to the mock root, and assert the JSON output matches what
 * the enumeration logic should produce.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SCRIPT = path.resolve(__dirname, '../../../scripts/docs-coverage.mjs');

function mkMockRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-coverage-test-'));
  // src/server/routes.ts with 3 routes
  fs.mkdirSync(path.join(root, 'src/server'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src/server/routes.ts'),
    `router.get('/foo', () => {});\nrouter.post('/bar', () => {});\nrouter.get('/baz/:id', () => {});\n`,
  );
  // src/commands with 2 commands
  fs.mkdirSync(path.join(root, 'src/commands'));
  fs.writeFileSync(path.join(root, 'src/commands/alpha.ts'), '// alpha');
  fs.writeFileSync(path.join(root, 'src/commands/beta.ts'), '// beta');
  // src/scaffold/templates/jobs/instar with 2 jobs
  fs.mkdirSync(path.join(root, 'src/scaffold/templates/jobs/instar'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/scaffold/templates/jobs/instar/job-one.md'), '# one');
  fs.writeFileSync(path.join(root, 'src/scaffold/templates/jobs/instar/job-two.md'), '# two');
  // src/templates/hooks with 1 hook
  fs.mkdirSync(path.join(root, 'src/templates/hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/templates/hooks/myhook.sh'), '#!/bin/sh');
  // skills with 2 skills, one user_invocable:false
  fs.mkdirSync(path.join(root, 'skills/normal-skill'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills/normal-skill/SKILL.md'), '---\nname: normal-skill\n---\nhello');
  fs.mkdirSync(path.join(root, 'skills/internal-skill'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills/internal-skill/SKILL.md'), '---\nname: internal-skill\nmetadata:\n  user_invocable: "false"\n---\ninternal');
  // src/monitoring class
  fs.mkdirSync(path.join(root, 'src/monitoring'));
  fs.writeFileSync(path.join(root, 'src/monitoring/MyClass.ts'), 'export class MyClass {}');
  // docs: README mentions /foo, alpha, job-one, normal-skill
  fs.writeFileSync(
    path.join(root, 'README.md'),
    `Endpoints: /foo\nCommands: instar alpha\nJobs: job-one\nSkills: normal-skill`,
  );
  // site doc mentions /bar
  fs.mkdirSync(path.join(root, 'site/src/content/docs/features'), { recursive: true });
  fs.writeFileSync(path.join(root, 'site/src/content/docs/features/foo.md'), 'See /foo and /bar.\nThe instar alpha command.');
  return root;
}

function runScript(cwd: string, args: string[] = []): { exitCode: number; stdout: string; stderr: string; jsonReport?: any } {
  const r = spawnSync('node', [SCRIPT, ...args], { cwd, encoding: 'utf-8' });
  const jsonPath = path.join(cwd, '.instar/docs-coverage.json');
  const jsonReport = fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) : undefined;
  return { exitCode: r.status ?? -1, stdout: r.stdout, stderr: r.stderr, jsonReport };
}

describe('docs-coverage script', () => {
  let repo: string;
  beforeEach(() => { repo = mkMockRepo(); });
  afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* */ } });

  it('enumerates every capability type', () => {
    const r = runScript(repo);
    expect(r.exitCode).toBe(0);
    expect(r.jsonReport).toBeDefined();
    const types = Object.keys(r.jsonReport.byType).sort();
    expect(types).toEqual(['class', 'command', 'hook', 'job', 'route', 'skill']);
  });

  it('counts the right number of each capability type', () => {
    const r = runScript(repo);
    expect(r.jsonReport.byType.route.total).toBe(3);
    expect(r.jsonReport.byType.command.total).toBe(2);
    expect(r.jsonReport.byType.job.total).toBe(2);
    expect(r.jsonReport.byType.hook.total).toBe(1);
    expect(r.jsonReport.byType.skill.total).toBe(2);
    expect(r.jsonReport.byType.class.total).toBe(1);
  });

  it('classifies coverage correctly: documented (2 mentions), partial (1 mention), undocumented (0)', () => {
    const r = runScript(repo);
    // /foo is in README + site doc → DOCUMENTED (2)
    // /bar is in site doc only → PARTIAL (1)
    // /baz/:id is in neither → UNDOCUMENTED (0)
    const routes = r.jsonReport.byType.route.items;
    const fooItem = routes.find((x: any) => x.path === '/foo');
    const barItem = routes.find((x: any) => x.path === '/bar');
    const bazItem = routes.find((x: any) => x.path === '/baz/:id');
    expect(fooItem.coverage).toBe('DOCUMENTED');
    expect(barItem.coverage).toBe('PARTIAL');
    expect(bazItem.coverage).toBe('UNDOCUMENTED');
  });

  it('--check passes when all category coverages meet the (loose) floors set via env', () => {
    const env = { ...process.env, INSTAR_DOCS_COVERAGE_MIN: '0', INSTAR_DOCS_COVERAGE_ROUTE_MIN: '0', INSTAR_DOCS_COVERAGE_COMMAND_MIN: '0', INSTAR_DOCS_COVERAGE_JOB_MIN: '0', INSTAR_DOCS_COVERAGE_HOOK_MIN: '0', INSTAR_DOCS_COVERAGE_SKILL_MIN: '0', INSTAR_DOCS_COVERAGE_CLASS_MIN: '0' };
    const r = spawnSync('node', [SCRIPT, '--check'], { cwd: repo, encoding: 'utf-8', env });
    expect(r.status).toBe(0);
  });

  it('--check fails when any category is below floor', () => {
    // Force a high floor that the mock-repo cannot meet.
    const env = { ...process.env, INSTAR_DOCS_COVERAGE_ROUTE_MIN: '99' };
    const r = spawnSync('node', [SCRIPT, '--check'], { cwd: repo, encoding: 'utf-8', env });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('route');
  });

  it('--json emits the JSON report to stdout', () => {
    const r = spawnSync('node', [SCRIPT, '--json'], { cwd: repo, encoding: 'utf-8' });
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.totals).toBeDefined();
    expect(parsed.byType).toBeDefined();
  });

  it('writes both JSON and markdown reports to .instar/', () => {
    runScript(repo);
    expect(fs.existsSync(path.join(repo, '.instar/docs-coverage.json'))).toBe(true);
    expect(fs.existsSync(path.join(repo, '.instar/docs-coverage.md'))).toBe(true);
    const md = fs.readFileSync(path.join(repo, '.instar/docs-coverage.md'), 'utf-8');
    expect(md).toContain('# Documentation Coverage Report');
  });
});
