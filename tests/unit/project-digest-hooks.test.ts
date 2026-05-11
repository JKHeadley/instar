/**
 * Smoke test for the bash hooks that read .instar/projects-digest.cache.
 *
 * Both `.instar/hooks/instar/session-start.sh` (in the startup branch)
 * and `.instar/hooks/instar/compaction-recovery.sh` read the cache file
 * via an inline python heredoc. The hook must:
 *
 *   1. Exit 0 against a present, well-formed cache file
 *   2. Print sanitized digest lines from `digestLines[]`
 *   3. Print "+N more on dashboard." when `truncated: true`
 *   4. Re-sanitize control chars on read (defense in depth — direct
 *      cache poisoning that bypasses the TypeScript write path can't
 *      smuggle ANSI escapes into orientation output)
 *   5. Emit `Active projects: state unavailable — run /project status
 *      when ready` and exit 0 when the cache file is missing
 *   6. Emit the same fallback message on a malformed/unparseable cache
 *
 * The hooks shell out from a context-injection slot in Claude Code, so
 * "exit 0" is the only acceptable failure mode — a non-zero exit would
 * leak a hook error into the orientation block.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SESSION_START_HOOK = path.join(
  REPO_ROOT,
  '.instar',
  'hooks',
  'instar',
  'session-start.sh'
);
const COMPACTION_HOOK = path.join(
  REPO_ROOT,
  '.instar',
  'hooks',
  'instar',
  'compaction-recovery.sh'
);

let projectDir: string;
let instarDir: string;

beforeAll(() => {
  // The actual hook files must exist in the repo. If a refactor moves
  // them, this test surfaces the breakage immediately.
  expect(fs.existsSync(SESSION_START_HOOK)).toBe(true);
  expect(fs.existsSync(COMPACTION_HOOK)).toBe(true);
});

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-hook-test-'));
  instarDir = path.join(projectDir, '.instar');
  fs.mkdirSync(instarDir, { recursive: true });
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(projectDir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/project-digest-hooks.test.ts',
  });
});

function runHook(hookPath: string): { stdout: string; status: number } {
  try {
    const out = execFileSync('bash', [hookPath], {
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectDir,
        CLAUDE_HOOK_MATCHER: 'startup',
        // Strip variables that would make session-start.sh delegate elsewhere
        // or hit network paths: no Telegram, no upstream config.
        INSTAR_TELEGRAM_TOPIC: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout: out.toString('utf-8'), status: 0 };
  } catch (err: unknown) {
    // execFileSync throws on non-zero exit; surface what we got
    type ExecErr = { status?: number; stdout?: Buffer; stderr?: Buffer };
    const e = err as ExecErr;
    return {
      stdout: (e.stdout ?? Buffer.from('')).toString('utf-8'),
      status: typeof e.status === 'number' ? e.status : 1,
    };
  }
}

function writeCache(payload: unknown): void {
  fs.writeFileSync(
    path.join(instarDir, 'projects-digest.cache'),
    typeof payload === 'string' ? payload : JSON.stringify(payload),
    'utf-8'
  );
}

// ─── session-start.sh ──────────────────────────────────────────────────────

describe('session-start.sh — project digest block', () => {
  it('exits 0 against a missing cache file and emits the fallback', () => {
    const r = runHook(SESSION_START_HOOK);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Active projects: state unavailable');
  });

  it('exits 0 and emits sanitized digestLines against a present cache', () => {
    writeCache({
      generatedAt: '2026-05-11T00:00:00.000Z',
      digestLines: ['Project [a]: 0 of 1 done. Next round: R.'],
      totalActiveProjects: 1,
      truncated: false,
    });
    const r = runHook(SESSION_START_HOOK);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--- ACTIVE PROJECTS ---');
    expect(r.stdout).toContain('Project [a]: 0 of 1 done. Next round: R.');
    expect(r.stdout).toContain('--- END ACTIVE PROJECTS ---');
  });

  it('appends "+N more on dashboard." when truncated', () => {
    writeCache({
      generatedAt: '2026-05-11T00:00:00.000Z',
      digestLines: ['Project [a]: 0/1', 'P [b]: 0/1', 'P [c]: 0/1', 'P [d]: 0/1', 'P [e]: 0/1'],
      totalActiveProjects: 7,
      truncated: true,
    });
    const r = runHook(SESSION_START_HOOK);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('+2 more on dashboard.');
  });

  it('re-sanitizes control chars on read (defense in depth)', () => {
    writeCache({
      generatedAt: '2026-05-11T00:00:00.000Z',
      // Direct poisoning bypasses the TypeScript writer; reader must clean.
      digestLines: ['Project [evil]: \x00\x07\x1B[31mRED\x1B[0m\n\rinjection'],
      totalActiveProjects: 1,
      truncated: false,
    });
    const r = runHook(SESSION_START_HOOK);
    expect(r.status).toBe(0);
    // No ASCII control chars should appear in the orientation output.
    const projectDigestSection =
      r.stdout.split('--- ACTIVE PROJECTS ---')[1]?.split('--- END ACTIVE PROJECTS ---')[0] ?? '';
    expect(projectDigestSection).not.toMatch(/[\x00-\x08\x0B-\x1F\x7F]/);
  });

  it('emits fallback on malformed JSON cache', () => {
    writeCache('{not valid json');
    const r = runHook(SESSION_START_HOOK);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Active projects: state unavailable');
  });
});

// ─── compaction-recovery.sh ────────────────────────────────────────────────

describe('compaction-recovery.sh — project digest block', () => {
  it('exits 0 against a missing cache file', () => {
    const r = runHook(COMPACTION_HOOK);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Active projects: state unavailable');
  });

  it('emits the digest with post-compaction header against a present cache', () => {
    writeCache({
      generatedAt: '2026-05-11T00:00:00.000Z',
      digestLines: ['Project [x]: 1 of 2 done. Next round: R2.'],
      totalActiveProjects: 1,
      truncated: false,
    });
    const r = runHook(COMPACTION_HOOK);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--- ACTIVE PROJECTS (post-compaction) ---');
    expect(r.stdout).toContain('Project [x]: 1 of 2 done. Next round: R2.');
  });
});
