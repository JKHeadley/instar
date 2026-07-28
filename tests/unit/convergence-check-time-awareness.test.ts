/**
 * Component 4 of the Robust Session Time Awareness spec (#681 / #682) — the
 * SIGNAL-ONLY accurate-reporting nudge baked into the pre-messaging
 * convergence-check.sh gate.
 *
 * Guards the exact wind-down-early incident class: an outbound message that
 * asserts the SESSION/RUN is done/over while a live autonomous record still has
 * >10% of its time-box remaining emits a one-line SIGNAL (operator log + stderr)
 * — but NEVER blocks/rewrites the message (P2 Signal vs Authority) and NEVER
 * quotes the agent's phrase (carries the computed %-remaining fact only).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'src', 'templates', 'scripts', 'convergence-check.sh');

/** Run convergence-check.sh with `content` on stdin + CLAUDE_PROJECT_DIR=projectDir.
 *  Captures stderr to a file (execFileSync does not return stderr on exit 0, and
 *  the Component-4 signal is emitted to stderr with exit 0). Never throws. */
function runCheck(content: string, projectDir: string): { exitCode: number; stderr: string } {
  const errFile = path.join(projectDir, '_stderr.txt');
  let exitCode = 0;
  try {
    execFileSync('bash', ['-c', `bash "${SCRIPT}" 2> "${errFile}"`], {
      input: content,
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: unknown) {
    exitCode = (err as { status?: number }).status ?? -1;
  }
  const stderr = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8') : '';
  return { exitCode, stderr };
}

function writeRecord(projectDir: string, name: string, opts: { active: boolean; remainingHours: number; durationSeconds?: number }): void {
  const dir = path.join(projectDir, '.instar', 'autonomous');
  fs.mkdirSync(dir, { recursive: true });
  const end = new Date(Date.now() + opts.remainingHours * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const fm = [
    '---',
    `active: ${opts.active}`,
    `duration_seconds: ${opts.durationSeconds ?? 43200}`,
    'started_at: "x"',
    `end_at: "${end}"`,
    '---',
    '# rec',
  ].join('\n');
  fs.writeFileSync(path.join(dir, name), fm);
}

function signalLogLines(projectDir: string): string[] {
  const p = path.join(projectDir, 'logs', 'time-awareness-signals.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
}

describe('convergence-check Component 4 — time-awareness signal (signal-only)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ta-')); });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/convergence-check-time-awareness.test.ts' }); } catch { /* ignore */ }
  });

  it('SIGNALS (log + stderr) on a session-done assertion while >10% of the time-box remains — but does NOT block', () => {
    writeRecord(dir, 'run.local.md', { active: true, remainingHours: 10 }); // 10h of 12h ≈ 83% > 10%
    const { exitCode, stderr } = runCheck('Great progress — the 12 hour session is done, wrapping up now.', dir);

    expect(exitCode).toBe(0); // SIGNAL-ONLY — never blocks
    expect(stderr).toMatch(/\[time-awareness\] SIGNAL/);
    expect(stderr).toMatch(/~83% of the active autonomous time-box/);
    expect(stderr).not.toMatch(/wrapping up/); // never quotes the agent's phrase
    const log = signalLogLines(dir);
    expect(log.length).toBe(1);
    expect(JSON.parse(log[0])).toMatchObject({ signal: 'premature-completion-assertion', remainingPct: 83, record: 'run.local.md' });
  });

  it('does NOT signal when there is no completion assertion', () => {
    writeRecord(dir, 'run.local.md', { active: true, remainingHours: 10 });
    const { exitCode, stderr } = runCheck('Working the next task now — here is a status update.', dir);
    expect(exitCode).toBe(0);
    expect(stderr).not.toMatch(/time-awareness/);
    expect(signalLogLines(dir).length).toBe(0);
  });

  it('does NOT signal when <10% of the time-box remains (a genuine near-end wrap-up)', () => {
    writeRecord(dir, 'run.local.md', { active: true, remainingHours: 0.1 }); // ~0.8% of 12h
    const { exitCode, stderr } = runCheck('The session is done now, all wrapped up.', dir);
    expect(exitCode).toBe(0);
    expect(stderr).not.toMatch(/time-awareness/);
    expect(signalLogLines(dir).length).toBe(0);
  });

  it('does NOT signal when no autonomous record is active', () => {
    writeRecord(dir, 'run.local.md', { active: false, remainingHours: 10 });
    const { exitCode, stderr } = runCheck('The session is done, wrapping up.', dir);
    expect(exitCode).toBe(0);
    expect(stderr).not.toMatch(/time-awareness/);
    expect(signalLogLines(dir).length).toBe(0);
  });

  it('does NOT signal when there is no autonomous record at all (normal non-autonomous messaging)', () => {
    const { exitCode, stderr } = runCheck('The session is done, wrapping up.', dir);
    expect(exitCode).toBe(0);
    expect(stderr).not.toMatch(/time-awareness/);
  });
});
