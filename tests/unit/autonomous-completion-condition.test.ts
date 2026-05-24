// safe-git-allow: test-tmpdir-cleanup — afterEach removes per-test mkdtempSync tmpdir; SafeFsExecutor migration tracked separately.
/**
 * Autonomous stop hook — completion CONDITION via independent evaluator (mirrors /goal).
 *
 * When `completion_condition` is set, the hook asks the evaluator endpoint each turn
 * instead of trusting the self-declared <promise>. met → exit; not-met → block + feed
 * the reason back. Fail-SAFE: if the evaluator is unreachable, keep working (never a
 * false "done"). Uses the INSTAR_HOOK_EVAL_OVERRIDE test seam for the met/not-met paths.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOOK = path.join(process.cwd(), '.claude', 'skills', 'autonomous', 'hooks', 'autonomous-stop-hook.sh');
const UUID = '04db2de7-8e82-4baf-9136-7a067bb2ec53';
let tmp: string;

function writeState(opts: { condition?: string; promise?: string; goalMode?: string; durationSeconds?: number; startedAt?: string }) {
  const started = opts.startedAt ?? new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  fs.writeFileSync(path.join(tmp, '.instar', 'autonomous-state.local.md'),
    `---\nactive: true\niteration: 2\nsession_id: "${UUID}"\nduration_seconds: ${opts.durationSeconds ?? 0}\nstarted_at: "${started}"\nreport_topic: "9984"\ngoal_mode: "${opts.goalMode ?? ''}"\ncompletion_promise: "${opts.promise ?? ''}"\ncompletion_condition: "${opts.condition ?? ''}"\n---\n\nKeep going.\n`);
}
function writeTranscript(): string {
  const p = path.join(tmp, 'transcript.jsonl');
  fs.writeFileSync(p, JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'working on it' }] } }) + '\n');
  return p;
}
function statePresent() { return fs.existsSync(path.join(tmp, '.instar', 'autonomous-state.local.md')); }

function runHook(evalOverride?: string): { decision: string | null; exit: number } {
  const env: NodeJS.ProcessEnv = { ...process.env, INSTAR_HOOK_NO_TMUX: '1', INSTAR_HOOK_TMUX_SESSION: '' };
  if (evalOverride !== undefined) env.INSTAR_HOOK_EVAL_OVERRIDE = evalOverride;
  let stdout = ''; let exit = 0;
  try {
    stdout = execFileSync('bash', [HOOK], {
      cwd: tmp, input: JSON.stringify({ session_id: UUID, transcript_path: writeTranscript() }),
      env, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e: any) { exit = e.status ?? 1; stdout = e.stdout?.toString() ?? ''; }
  let decision: string | null = null;
  try { decision = JSON.parse(stdout.trim()).decision ?? null; } catch { /* allow-exit */ }
  return { decision, exit };
}

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-cond-')); fs.mkdirSync(path.join(tmp, '.instar'), { recursive: true }); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('completion condition — independent evaluator', () => {
  it('evaluator says MET → allows exit and clears state', () => {
    writeState({ condition: 'all tests pass' });
    const r = runHook('met');
    expect(r.decision).not.toBe('block');
    expect(r.exit).toBe(0);
    expect(statePresent()).toBe(false); // state cleared on completion
  });

  it('evaluator says NOT-MET → blocks (keeps working), state retained', () => {
    writeState({ condition: 'all tests pass' });
    const r = runHook('not-met');
    expect(r.decision).toBe('block');
    expect(statePresent()).toBe(true);
  });

  it('FAIL-SAFE: condition set but evaluator unreachable → keeps working (never premature exit)', () => {
    // No override → the hook curls the evaluator endpoint; no server is running in the
    // test, so the call fails. The job must NOT exit — it blocks and keeps working.
    writeState({ condition: 'all tests pass' });
    const r = runHook(); // no override, no server
    expect(r.decision).toBe('block');
    expect(statePresent()).toBe(true);
  });

  it('legacy: no condition, self-declared promise path still works (blocks until promised)', () => {
    writeState({ promise: 'ALL_DONE' }); // no condition
    const r = runHook();
    expect(r.decision).toBe('block'); // promise not in transcript → keep working
  });
});

describe('native /goal delegation (goal_mode: native)', () => {
  it('defers to native /goal — approves/exits (no block) so native /goal stays in control', () => {
    // goal_mode:native means the framework's own /goal hook owns completion. instar must
    // NOT block (block would override native /goal); it approves and lets native decide.
    writeState({ condition: 'all tests pass', goalMode: 'native' });
    const r = runHook(); // even with the instar evaluator unreachable, native mode defers
    expect(r.decision).not.toBe('block');
    expect(r.exit).toBe(0);
    expect(statePresent()).toBe(true); // job continues (native /goal enforces)
  });

  it('still enforces emergency-stop in native mode (clears state + exits)', () => {
    writeState({ condition: 'x', goalMode: 'native' });
    fs.writeFileSync(path.join(tmp, '.instar', 'autonomous-emergency-stop'), 'stop\n');
    const r = runHook();
    expect(r.exit).toBe(0);
    expect(statePresent()).toBe(false); // instar cleared its state (+ best-effort native clear)
  });

  it('still enforces duration expiry in native mode (clears state + exits)', () => {
    const past = new Date(Date.now() - 3600_000).toISOString().replace(/\.\d+Z$/, 'Z');
    writeState({ condition: 'x', goalMode: 'native', durationSeconds: 10, startedAt: past });
    const r = runHook();
    expect(r.exit).toBe(0);
    expect(statePresent()).toBe(false);
  });
});
