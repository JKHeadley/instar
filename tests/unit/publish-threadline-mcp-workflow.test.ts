// safe-git-allow: test fixture cleanup uses fs.rmSync on its own mkdtemp dir only.
/**
 * publish-threadline-mcp.yml must never publish a patch nobody asked for (#2243).
 *
 * WHY THIS TEST EXISTS. The publish job used to run `npm version patch` whenever
 * package.json matched npm, then publish and push the bump to main. Any merge under
 * packages/threadline-mcp/ (a README edit, server.json) would therefore ship an
 * unplanned 0.6.1 -> 0.6.2. The only thing holding it back was a Test job that could
 * not pass, because its packed-consumer step asserted on the terminal `pair` CLI that
 * 0.5.1 (32ee7e3be) removed. Fixing either half alone is wrong: fixing the test arms
 * the bump. This file pins both halves.
 *
 * The version check is exercised by RUNNING the workflow's own `check` step script
 * under bash with a stub `npm` on PATH, so the assertion is on behavior, not wording.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

const ROOT = process.cwd();
const WORKFLOW_PATH = join(ROOT, '.github/workflows/publish-threadline-mcp.yml');
const PKG_SRC = join(ROOT, 'packages/threadline-mcp/src');

interface Step {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
}
interface Job {
  steps: Step[];
}

function loadWorkflow(): { on: Record<string, unknown>; jobs: Record<string, Job> } {
  const parsed = yaml.load(readFileSync(WORKFLOW_PATH, 'utf8'));
  expect(parsed).toBeTypeOf('object');
  return parsed as { on: Record<string, unknown>; jobs: Record<string, Job> };
}

function allSteps(): Array<{ job: string; step: Step }> {
  const wf = loadWorkflow();
  return Object.entries(wf.jobs).flatMap(([job, j]) => j.steps.map((step) => ({ job, step })));
}

function checkStep(): Step {
  const step = loadWorkflow().jobs.publish.steps.find((s) => s.id === 'check');
  expect(step?.run, 'publish job must keep a `check` step that decides whether to publish').toBeTruthy();
  return step!;
}

describe('publish-threadline-mcp.yml: no CI-made version bump', () => {
  it('no step bumps the version or pushes to main', () => {
    for (const { job, step } of allSteps()) {
      const run = step.run ?? '';
      expect(run, `${job} / ${step.name}`).not.toMatch(/npm\s+version\b/);
      expect(run, `${job} / ${step.name}`).not.toMatch(/git\s+push\b/);
      expect(JSON.stringify(step.env ?? {}), `${job} / ${step.name}`).not.toContain('RELEASE_TOKEN');
    }
  });

  it('every publishing step is gated on the check deciding to publish', () => {
    const steps = loadWorkflow().jobs.publish.steps;
    const publishing = steps.filter((s) => /npm\s+publish\b/.test(s.run ?? ''));
    expect(publishing.length).toBe(1);
    for (const s of publishing) {
      expect(s.if, `${s.name} must only run when the check says publish`).toBe("steps.check.outputs.publish == 'true'");
    }
  });

  it('only build-affecting package paths trigger the workflow', () => {
    const push = loadWorkflow().on.push as { paths?: string[] };
    expect(push.paths).toBeDefined();
    expect(push.paths).not.toContain('packages/threadline-mcp/**');
    expect(push.paths).toContain('packages/threadline-mcp/src/**');
    expect(push.paths).toContain('packages/threadline-mcp/package.json');
  });
});

describe('publish-threadline-mcp.yml: the check step decides correctly', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tlmcp-publish-check-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Runs the real `check` script with package.json at `local` and a stub npm. */
  function runCheck(local: string, npm: { version?: string; error?: string }) {
    const bin = join(dir, 'bin');
    const work = join(dir, 'work');
    for (const d of [bin, work]) spawnSync('mkdir', ['-p', d]);
    writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'threadline-mcp', version: local }));
    // The stub logs every call so a `npm version` (the old bump) is visible even if it "succeeds".
    const stub = [
      '#!/usr/bin/env bash',
      `echo "$*" >> "${join(dir, 'npm-calls.log')}"`,
      'if [ "$1" = "view" ]; then',
      npm.error ? `  echo "${npm.error}" >&2; exit 1` : `  echo "${npm.version}"; exit 0`,
      'fi',
      'exit 0',
    ].join('\n');
    writeFileSync(join(bin, 'npm'), stub);
    chmodSync(join(bin, 'npm'), 0o755);
    const out = join(dir, 'gh-output');
    writeFileSync(out, '');
    // GitHub's default `run` shell is `bash -e {0}`.
    const res = spawnSync('bash', ['-e', '-c', checkStep().run!], {
      cwd: work,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: out },
    });
    const outputs = Object.fromEntries(
      readFileSync(out, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => l.split('=') as [string, string]),
    );
    const calls = existsSync(join(dir, 'npm-calls.log')) ? readFileSync(join(dir, 'npm-calls.log'), 'utf8') : '';
    const finalVersion = JSON.parse(readFileSync(join(work, 'package.json'), 'utf8')).version;
    return { status: res.status, stdout: res.stdout, outputs, calls, finalVersion };
  }

  it('same version as npm: publishes nothing and leaves package.json alone', () => {
    const r = runCheck('0.6.1', { version: '0.6.1' });
    expect(r.status).toBe(0);
    expect(r.outputs.publish).toBe('false');
    expect(r.calls).not.toMatch(/^version\b/m);
    expect(r.finalVersion).toBe('0.6.1');
    expect(r.stdout).toContain('::notice::');
  });

  it('older than npm: publishes nothing', () => {
    const r = runCheck('0.6.0', { version: '0.6.1' });
    expect(r.status).toBe(0);
    expect(r.outputs.publish).toBe('false');
  });

  it('newer than npm: publishes that exact version', () => {
    // Numeric, not string, order: 0.6.10 is newer than 0.6.9.
    for (const [local, remote] of [['0.6.2', '0.6.1'], ['0.7.0', '0.6.9'], ['1.0.0', '0.9.9'], ['0.6.10', '0.6.9']]) {
      const r = runCheck(local, { version: remote });
      expect(r.status, local).toBe(0);
      expect(r.outputs.publish, local).toBe('true');
      expect(r.outputs.version, local).toBe(local);
      expect(r.finalVersion, local).toBe(local);
    }
  });

  it('not on npm yet (404): publishes', () => {
    const r = runCheck('0.1.0', { error: 'npm error code E404' });
    expect(r.status).toBe(0);
    expect(r.outputs.publish).toBe('true');
  });

  it('registry unreadable for another reason: fails instead of guessing', () => {
    const r = runCheck('0.6.2', { error: 'npm error code ETIMEDOUT' });
    expect(r.status).not.toBe(0);
    expect(r.outputs.publish).toBeUndefined();
  });
});

describe('publish-threadline-mcp.yml: smoke tests match the current CLI', () => {
  it('no step drives the removed `pair` CLI', () => {
    for (const { job, step } of allSteps()) {
      expect(step.run ?? '', `${job} / ${step.name}`).not.toMatch(/\bpair\s+(status|open|finish)\b/);
    }
  });

  it('every message a smoke step requires is one the package source can print', () => {
    const src = readdirSync(PKG_SRC)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => readFileSync(join(PKG_SRC, f), 'utf8'))
      .join('\n');
    const required = allSteps()
      .filter(({ step }) => /smoke/i.test(step.name ?? ''))
      .flatMap(({ step }) =>
        [...(step.run ?? '').matchAll(/grep -q "([^"]+)"/g)].map((m) => m[1]),
      );
    expect(required.length).toBeGreaterThan(0);
    for (const text of required) {
      // Anything after ": Error:" is the runtime error the server interpolates, not source text.
      const ownText = text.split(': Error:')[0];
      expect(src, `smoke step expects "${text}"`).toContain(ownText);
    }
  });
});
