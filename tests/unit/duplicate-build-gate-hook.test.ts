// safe-git-allow: test file — execFileSync('git', ...) builds sandbox repo
//   fixtures (init, add, commit). No production code path.
// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Unit tests — the duplicate-build guard's build-START PreToolUse gate
 * (.claude/hooks/duplicate-build-start-gate.js; spec §3.4, FD3).
 *
 * The hook is spawned exactly as Claude Code spawns it (stdin JSON, exit code
 * contract: 0=allow, 2=block) against sandbox roots. Covers:
 *  - BLOCK on a recorded likely-duplicate/verify verdict with no disposition;
 *  - the §3.4 disposition schema (likely-duplicate proceed needs a non-empty
 *    reason + ≥1 acknowledgedEvidenceId; abandon keeps blocking);
 *  - allow + run-once marker on clear / dispositioned verdicts (hot path);
 *  - trace/log/state paths and non-instar repos never trigger the gate;
 *  - fail-open: a hard check error writes the check-errored auto-stub and
 *    does NOT block; INSTAR_DUP_BUILD_CHECK=off is a total no-op;
 *  - Structure>Willpower: with NO stub, the hook runs the check itself once
 *    (the skill prose having been skipped must not disarm the guard).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK = path.join(REPO_ROOT, '.claude', 'hooks', 'duplicate-build-start-gate.js');

const STUB_REL = path.join('.instar', 'dup-build-check.json');
const MARKER_REL = path.join('.instar', 'dup-build-gate.marker.json');

interface RunResult { status: number | null; stdout: string; stderr: string; }

function runHook(root: string, toolInput: Record<string, unknown>, env: Record<string, string> = {}): RunResult {
  const res = spawnSync(process.execPath, [HOOK], {
    encoding: 'utf-8',
    input: JSON.stringify({ tool_name: 'Write', tool_input: toolInput }),
    env: {
      // Hermetic: no inherited guard flags / agent home; CI skips the gh scan
      // if the hook ever runs the full check.
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      CI: '1',
      CLAUDE_PROJECT_DIR: root,
      ...env,
    },
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function mkInstarSandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupgate-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'instar', version: '0.0.0' }));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
  return dir;
}

function writeStubFile(root: string, stub: Record<string, unknown>): void {
  fs.writeFileSync(path.join(root, STUB_REL), JSON.stringify(stub, null, 2));
}

const VERIFY_STUB = {
  verdict: 'verify',
  cause: 'fuzzy',
  causes: ['fuzzy'],
  evidence: [{ id: 'EV-1', source: 'open-pr', strength: 'fuzzy', detail: 'open PR #99 similarity 0.4', prNumber: 99 }],
  specSlug: 'demo',
};

const LIKELY_DUP_STUB = {
  verdict: 'likely-duplicate',
  cause: 'concurrency',
  causes: ['concurrency'],
  evidence: [{ id: 'EV-1', source: 'local-sibling', strength: 'strong', detail: 'live sibling build shares target(s)' }],
  specSlug: 'demo',
};

describe('duplicate-build-start-gate hook (§3.4)', () => {
  let root: string;
  const dirs: string[] = [];

  beforeEach(() => {
    root = mkInstarSandbox();
    dirs.push(root);
  });

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try {
        SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/duplicate-build-gate-hook.test.ts:cleanup' });
      } catch { /* ignore */ }
    }
  });

  it('BLOCKS (exit 2) the first implementation write on verify with no disposition', () => {
    writeStubFile(root, VERIFY_STUB);
    const r = runHook(root, { file_path: 'src/foo.ts' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('no disposition is recorded');
    expect(r.stderr).toContain('EV-1');
    expect(fs.existsSync(path.join(root, MARKER_REL))).toBe(false); // a block never arms the hot path
  });

  it('BLOCKS a likely-duplicate proceed that lacks acknowledgedEvidenceIds (checkbox defense)', () => {
    writeStubFile(root, {
      ...LIKELY_DUP_STUB,
      disposition: { decision: 'proceed', reason: 'looked at it', acknowledgedEvidenceIds: [] },
    });
    const r = runHook(root, { file_path: 'src/foo.ts' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('acknowledgedEvidenceId');
  });

  it('BLOCKS a likely-duplicate proceed with an empty reason', () => {
    writeStubFile(root, {
      ...LIKELY_DUP_STUB,
      disposition: { decision: 'proceed', reason: '   ', acknowledgedEvidenceIds: ['EV-1'] },
    });
    const r = runHook(root, { file_path: 'src/foo.ts' });
    expect(r.status).toBe(2);
  });

  it('ALLOWS a likely-duplicate proceed carrying a reason + a real evidence id, and arms the marker', () => {
    writeStubFile(root, {
      ...LIKELY_DUP_STUB,
      disposition: { decision: 'proceed', reason: 'EV-1 is my own earlier session, same build', acknowledgedEvidenceIds: ['EV-1'] },
    });
    const r = runHook(root, { file_path: 'src/foo.ts' });
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(root, MARKER_REL))).toBe(true);
  });

  it('an ABANDON disposition keeps implementation writes blocked', () => {
    writeStubFile(root, {
      ...VERIFY_STUB,
      disposition: { decision: 'abandon', reason: 'duplicate of PR #99', acknowledgedEvidenceIds: ['EV-1'] },
    });
    const r = runHook(root, { file_path: 'src/foo.ts' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('ABANDON');
  });

  it('a clear verdict allows and arms the run-once marker (hot path thereafter)', () => {
    writeStubFile(root, { verdict: 'clear', cause: null, evidence: [], specSlug: 'demo' });
    const first = runHook(root, { file_path: 'src/foo.ts' });
    expect(first.status).toBe(0);
    expect(fs.existsSync(path.join(root, MARKER_REL))).toBe(true);
    // hot path: stub can even disappear — the marker short-circuits
    fs.rmSync(path.join(root, STUB_REL));
    const second = runHook(root, { file_path: 'src/bar.ts' });
    expect(second.status).toBe(0);
  });

  it('trace/log/state paths never trigger the gate (spec §3.4 exclusions)', () => {
    writeStubFile(root, VERIFY_STUB); // would block an in-scope write
    for (const p of ['.instar/dup-build-check.json', 'logs/x.jsonl', 'node_modules/x/y.js', 'scratchpad/notes.md']) {
      const r = runHook(root, { file_path: p });
      expect(r.status, `${p} must not trigger the gate`).toBe(0);
    }
    expect(fs.existsSync(path.join(root, MARKER_REL))).toBe(false); // excluded paths must not consume run-once
  });

  it('a write OUTSIDE the repo never triggers the gate', () => {
    writeStubFile(root, VERIFY_STUB);
    const r = runHook(root, { file_path: '/tmp/elsewhere.txt' });
    expect(r.status).toBe(0);
  });

  it('a non-instar repo is out of scope', () => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'some-other-project' }));
    writeStubFile(root, VERIFY_STUB);
    const r = runHook(root, { file_path: 'src/foo.ts' });
    expect(r.status).toBe(0);
  });

  it('INSTAR_DUP_BUILD_CHECK=off is a total no-op (even on a blocking stub)', () => {
    writeStubFile(root, VERIFY_STUB);
    const r = runHook(root, { file_path: 'src/foo.ts' }, { INSTAR_DUP_BUILD_CHECK: 'off' });
    expect(r.status).toBe(0);
  });

  it('unreadable hook input fails open (never blocks)', () => {
    writeStubFile(root, VERIFY_STUB);
    const res = spawnSync(process.execPath, [HOOK], {
      encoding: 'utf-8',
      input: 'not json {{{',
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', CI: '1', CLAUDE_PROJECT_DIR: root },
    });
    expect(res.status).toBe(0);
  });

  it('with NO stub and no resolvable spec, allows + arms the marker (not a spec-driven build)', () => {
    const r = runHook(root, { file_path: 'src/foo.ts' });
    expect(r.status).toBe(0);
    const marker = JSON.parse(fs.readFileSync(path.join(root, MARKER_REL), 'utf-8'));
    expect(marker.via).toBe('no-spec-resolvable');
  });

  it('Structure>Willpower: with NO stub but a resolvable spec, the hook runs the check ONCE itself and blocks on the verdict', () => {
    // A git sandbox whose branch adds a substrate spec vs main — the exact
    // state after a skipped build-start step. No agent home resolvable →
    // degraded substrate scan → verify → block (no disposition yet).
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf-8' });
    git(['init', '-q']);
    git(['config', 'user.email', 't@example.com']);
    git(['config', 'user.name', 't']);
    fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
    git(['add', '-A']);
    git(['commit', '-qm', 'init']);
    git(['branch', '-M', 'main']);
    fs.mkdirSync(path.join(root, 'docs', 'specs'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'docs', 'specs', 'new-thing.md'),
      '# New Thing\n\n## Problem statement\n\nWidget refresh is unrecorded.\n\n## Scope\n\nShip `src/data/provenanceCoverage.ts`.\n',
    );
    const r = runHook(root, { file_path: 'src/foo.ts' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('verify');
    // the verdict it computed is durably recorded for the author to disposition
    const stub = JSON.parse(fs.readFileSync(path.join(root, STUB_REL), 'utf-8'));
    expect(stub.verdict).toBe('verify');
  });

  it('a HARD check error writes the §3.4 check-errored auto-stub and does NOT block', () => {
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf-8' });
    git(['init', '-q']);
    git(['config', 'user.email', 't@example.com']);
    git(['config', 'user.name', 't']);
    fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
    git(['add', '-A']);
    git(['commit', '-qm', 'init']);
    git(['branch', '-M', 'main']);
    fs.mkdirSync(path.join(root, 'docs', 'specs'), { recursive: true });
    const specPath = path.join(root, 'docs', 'specs', 'unreadable.md');
    fs.writeFileSync(specPath, '# Unreadable\n\nShips `src/data/provenanceCoverage.ts`.\n');
    fs.chmodSync(specPath, 0o000); // readFileSync will throw → hard check error
    const r = runHook(root, { file_path: 'src/foo.ts' });
    fs.chmodSync(specPath, 0o644); // restore for cleanup
    expect(r.status).toBe(0);
    const stub = JSON.parse(fs.readFileSync(path.join(root, STUB_REL), 'utf-8'));
    expect(stub.verdict).toBe('check-errored');
    expect(stub.disposition.reason).toBe('auto: check errored (fail-open)');
  });
});
