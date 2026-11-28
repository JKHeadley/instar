// safe-git-allow: test file — git init/commit/merge only inside throwaway fixture repositories.
// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// The direction guard's protected base must be the main commit the run actually tests.
// A pull_request run checks out the PR merged onto the base branch's tip at run time (HEAD^1),
// while github.event.pull_request.base.sha is the tip when the PR was last pushed. When main
// gained a registry change in between (PR #3387, 2026-11-27: two standards arrived with #3486),
// the old base made inherited standards look like the PR's own additions.
//
// This runs the REAL base-resolution step from .github/workflows/ci.yml in throwaway repositories.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'standards-direction-base-merge-parent.test.ts' }); });

/** The `run:` body of the "Resolve protected-base area ledger" step, read from the real workflow. */
function baseStepRun(): string {
  const yml = fs.readFileSync(path.resolve('.github/workflows/ci.yml'), 'utf8').split('\n');
  const start = yml.findIndex((l) => l.trim() === 'id: area-audit-base');
  expect(start).toBeGreaterThan(0);
  const runAt = yml.findIndex((l, i) => i > start && l.trim() === 'run: |');
  const indent = yml[runAt + 1].match(/^ */)![0].length;
  const body: string[] = [];
  for (let i = runAt + 1; i < yml.length; i++) {
    const l = yml[i];
    if (l.trim() !== '' && l.match(/^ */)![0].length < indent) break;
    body.push(l.slice(indent));
  }
  return body.join('\n');
}

function repo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'direction-base-')));
  dirs.push(root);
  const env = { PATH: process.env.PATH ?? '', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (...a: string[]) => {
    const r = spawnSync('git', a, { cwd: root, encoding: 'utf8', env });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  return { root, env, git, write };
}

/** main A -> main B (registry gains a standard); PR branched from A; merge ref = PR merged onto B. */
function staleBaseFixture() {
  const r = repo();
  r.git('init', '-q', '-b', 'main');
  r.write('docs/STANDARDS-REGISTRY.md', '# Standards\n\n### Old Article\n');
  r.write('.github/keyrings/telegram-principal-pub.pem', 'pin\n');
  r.git('add', '-A'); r.git('commit', '-q', '-m', 'A');
  const A = r.git('rev-parse', 'HEAD');
  r.git('checkout', '-q', '-b', 'pr');
  r.write('src/change.ts', 'export {};\n');
  r.git('add', '-A'); r.git('commit', '-q', '-m', 'PR');
  r.git('checkout', '-q', 'main');
  r.write('docs/STANDARDS-REGISTRY.md', '# Standards\n\n### Old Article\n\n### Inherited Article\n');
  r.git('add', '-A'); r.git('commit', '-q', '-m', 'B: main gains a standard');
  const B = r.git('rev-parse', 'HEAD');
  r.git('update-ref', 'refs/remotes/origin/main', B);
  r.git('checkout', '-q', '--detach', B);
  r.git('merge', '-q', '--no-ff', '--no-edit', 'pr'); // HEAD = merge commit, HEAD^1 = B, HEAD^2 = PR
  return { ...r, A, B };
}

function runStep(r: ReturnType<typeof repo>, env: Record<string, string>) {
  const out = path.join(r.root, 'gh-output');
  const tmp = fs.mkdtempSync(path.join(r.root, 'runner-'));
  fs.writeFileSync(out, '');
  const res = spawnSync('bash', ['-e', '-c', baseStepRun()], {
    cwd: r.root, encoding: 'utf8', env: { ...r.env, ...env, GITHUB_OUTPUT: out, RUNNER_TEMP: tmp },
  });
  const outputs = Object.fromEntries(fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split('=')));
  const registry = fs.existsSync(path.join(tmp, 'standards-registry-base.md')) ? fs.readFileSync(path.join(tmp, 'standards-registry-base.md'), 'utf8') : '';
  return { status: res.status, stderr: res.stderr, outputs, registry };
}

describe('direction guard protected base = the main commit the run tests', () => {
  it('a pull_request run whose event base is stale uses the merge commit\'s first parent', () => {
    const r = staleBaseFixture();
    const res = runStep(r, { BASE_SHA: r.A, EVENT_NAME: 'pull_request' });
    expect(res.status).toBe(0);
    expect(res.outputs.base).toBe(r.B);
    // The inherited standard is part of the base, so it is not counted as the PR's addition.
    expect(res.registry).toContain('### Inherited Article');
  });

  it('keeps the event base when the first parent is not on origin/main', () => {
    const r = staleBaseFixture();
    r.git('update-ref', 'refs/remotes/origin/main', r.A); // main does not contain B
    const res = runStep(r, { BASE_SHA: r.A, EVENT_NAME: 'pull_request' });
    expect(res.status).toBe(0);
    expect(res.outputs.base).toBe(r.A);
    expect(res.registry).not.toContain('### Inherited Article');
  });

  it('keeps the event base when the first parent does not descend from it (never moves backwards)', () => {
    const r = staleBaseFixture();
    // An event base that is NOT an ancestor of HEAD^1: the PR's own commit.
    const pr = r.git('rev-parse', 'HEAD^2');
    const res = runStep(r, { BASE_SHA: pr, EVENT_NAME: 'pull_request' });
    expect(res.status).toBe(0);
    expect(res.outputs.base).toBe(pr);
  });

  it('a pull_request_review run (same merge ref, same stale base) also uses the merge parent', () => {
    const r = staleBaseFixture();
    const res = runStep(r, { BASE_SHA: r.A, EVENT_NAME: 'pull_request_review' });
    expect(res.status).toBe(0);
    expect(res.outputs.base).toBe(r.B);
  });

  it('a push event keeps the event-derived base', () => {
    const r = staleBaseFixture();
    const res = runStep(r, { BASE_SHA: r.A, EVENT_NAME: 'push' });
    expect(res.status).toBe(0);
    expect(res.outputs.base).toBe(r.A);
  });

  it('with no origin/main ref, the event base stands and the step still succeeds', () => {
    const r = staleBaseFixture();
    r.git('update-ref', '-d', 'refs/remotes/origin/main');
    const res = runStep(r, { BASE_SHA: r.A, EVENT_NAME: 'pull_request' });
    expect(res.status).toBe(0);
    expect(res.outputs.base).toBe(r.A);
  });

  it('a non-merge checkout keeps the event base', () => {
    const r = staleBaseFixture();
    r.git('checkout', '-q', '--detach', r.B); // not a merge commit
    const res = runStep(r, { BASE_SHA: r.A, EVENT_NAME: 'pull_request' });
    expect(res.status).toBe(0);
    expect(res.outputs.base).toBe(r.A);
  });
});
