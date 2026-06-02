// safe-fs-allow: test file — tmpdir cleanup only.
/**
 * Autonomous stop hook — SESSION CLOCK injection (Step 2 wiring integrity).
 *
 * When the hook blocks a continuation on a time-boxed run, it must feed back a
 * rich "SESSION CLOCK: Nh elapsed · Mh remaining (NN%)" line, rendered by
 * emit-session-clock.sh from the hook's OWN computed elapsed/remaining. This is
 * the fix for the wind-down-early-with-hours-left incident: the autonomous agent
 * now SEES how much time remains on every continuation.
 *
 * Fail-safe: if emit-session-clock.sh isn't installed, the continuation still
 * fires (the clock segment is simply omitted) — verified here too.
 * Spec: docs/specs/ROBUST-SESSION-TIME-AWARENESS-SPEC.md.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOOK = path.join(process.cwd(), '.claude', 'skills', 'autonomous', 'hooks', 'autonomous-stop-hook.sh');
const SCRIPT_SRC = path.join(process.cwd(), 'src', 'templates', 'scripts', 'emit-session-clock.sh');
const UUID = '04db2de7-8e82-4baf-9136-7a067bb2ec53';
let tmp: string;

function writeState(durationSeconds: number, startedAt: string) {
  fs.writeFileSync(
    path.join(tmp, '.instar', 'autonomous-state.local.md'),
    `---\nactive: true\niteration: 2\nsession_id: "${UUID}"\nduration_seconds: ${durationSeconds}\nstarted_at: "${startedAt}"\nreport_topic: "9984"\ncompletion_promise: "ALL_DONE"\ngoal: "build the time clock"\n---\n\nKeep going.\n`,
  );
}
function installClock() {
  const dir = path.join(tmp, '.instar', 'scripts');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(SCRIPT_SRC, path.join(dir, 'emit-session-clock.sh'));
  fs.chmodSync(path.join(dir, 'emit-session-clock.sh'), 0o755);
}
function writeTranscript(): string {
  const p = path.join(tmp, 'transcript.jsonl');
  fs.writeFileSync(p, JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }) + '\n');
  return p;
}
function runHook(): { decision: string | null; reason: string; exit: number } {
  const env: NodeJS.ProcessEnv = { ...process.env, INSTAR_HOOK_NO_TMUX: '1', INSTAR_HOOK_TMUX_SESSION: '' };
  let stdout = ''; let exit = 0;
  try {
    stdout = execFileSync('bash', [HOOK], {
      cwd: tmp, input: JSON.stringify({ session_id: UUID, transcript_path: writeTranscript() }),
      env, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e: any) { exit = e.status ?? 1; stdout = e.stdout?.toString() ?? ''; }
  let decision: string | null = null; let reason = '';
  try { const j = JSON.parse(stdout.trim()); decision = j.decision ?? null; reason = (j.systemMessage ?? j.reason ?? '') as string; } catch { /* allow-exit */ }
  return { decision, reason, exit };
}

// started ~4h ago, 12h box → ~33% elapsed, ~8h remaining
const FOUR_H_AGO = new Date(Date.now() - 4 * 3600 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-clock-hook-')); fs.mkdirSync(path.join(tmp, '.instar'), { recursive: true }); });
afterEach(() => { SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/autonomous-stop-hook-session-clock.test.ts:cleanup' }); });

describe('autonomous stop-hook — SESSION CLOCK injection', () => {
  it('feeds back the rich SESSION CLOCK line on a blocked continuation of a timed run', () => {
    writeState(43200, FOUR_H_AGO);
    installClock();
    const r = runHook();
    expect(r.decision).toBe('block'); // not expired → keeps working
    expect(r.reason).toContain('SESSION CLOCK');
    expect(r.reason).toMatch(/\d+h \d+m elapsed/);
    expect(r.reason).toContain('remaining');
  });

  it('fail-safe: with emit-session-clock.sh absent, the continuation still fires (clock segment omitted)', () => {
    writeState(43200, FOUR_H_AGO);
    // do NOT installClock()
    const r = runHook();
    expect(r.decision).toBe('block');
    expect(r.reason).not.toContain('SESSION CLOCK');
    expect(r.reason).toContain('Autonomous iteration'); // continuation still built
  });
});
