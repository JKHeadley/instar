// safe-git-allow: test-tmpdir-cleanup — afterAll removes the per-test mkdtempSync home.
/**
 * E2E (Tier 3) — Real-Check Verification "feature is alive" lifecycle.
 * Spec: docs/specs/autonomous-completion-real-checks.md (§9 "E2E: feature is alive").
 *
 * The single most important test for this feature. It proves the real-check gate is
 * WIRED INTO THE REAL PRODUCTION met-path of the shipped autonomous-stop-hook.sh — not
 * just unit-mocked. The spec's e2e contract:
 *
 *   "a condition-driven autonomous run with a verification_command that initially FAILS
 *    keeps working past a transcript-'met' turn and exits only once the command passes."
 *
 * Spawning a real Claude session is heavy, so — exactly like the existing autonomous
 * e2e/unit harnesses — we drive the REAL hook across iterations against a temp agent
 * home, with per-topic state PERSISTING across fires:
 *
 *   - The judge is forced MET every turn via the documented INSTAR_HOOK_EVAL_OVERRIDE
 *     seam (so the transcript-judge is not the thing under test — the GATE after it is).
 *   - The verification_command is a REAL command whose pass/fail we control via a flag
 *     file: `test -f <FLAG>`. Absent flag → exit 1 (FAIL); present flag → exit 0 (PASS).
 *
 * Asserted lifecycle (transcript says MET every turn):
 *   1. flag ABSENT → command FAILS → hook BLOCKS the exit, state file RETAINED.   (×N)
 *   2. flag still absent, agent even ECHOES "all tests pass" → still BLOCKS.        (gaming-proof)
 *   3. `touch FLAG` → command PASSES → hook ALLOWS the exit, state file REMOVED.
 *
 * This is the production met-path: judge MET + real-check PASS is the ONLY combination
 * that exits; a met verdict alone (with a failing command) cannot end the run.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOOK_PATH = path.join(process.cwd(), '.claude', 'skills', 'autonomous', 'hooks', 'autonomous-stop-hook.sh');
const TOPIC = '8842';
const TMUX = 'echo-claude-agent-sdk';
const SESSION = '04db2de7-8e82-4baf-9136-7a067bb2ec53';

let home: string;
let transcriptsDir: string;
let flag: string; // the flag file the verification_command checks

function statePath() { return path.join(home, '.instar', 'autonomous', `${TOPIC}.local.md`); }
function statePresent() { return fs.existsSync(statePath()); }
function realcheckRows(): any[] {
  const p = path.join(home, 'logs', 'autonomous-realcheck.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function writeState() {
  fs.mkdirSync(path.join(home, '.instar', 'autonomous'), { recursive: true });
  // A real verification_command gated on a flag file: PASS only once the flag exists.
  // work_dir is the home (the hook resolves CWD structurally: verification_cwd → work_dir).
  fs.writeFileSync(statePath(),
    `---\nactive: true\niteration: 1\nsession_id: "${SESSION}"\nduration_seconds: 28800\nstarted_at: "${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}"\nreport_topic: "${TOPIC}"\ncompletion_promise: "ALL_TASKS_COMPLETE"\ncompletion_condition: "all tests pass and npm test exits 0"\ncompletion_mode: condition\nhard_blocker_nonce: "e2e0nonce0rc1"\nverification_command: "test -f ${flag}"\nwork_dir: "${home}"\n---\n\n# Autonomous Session\n\n## Tasks\n- [ ] implement feature\n- [ ] make the check pass\n`);
}

function transcript(lastText: string): string {
  const p = path.join(transcriptsDir, `${SESSION}.jsonl`);
  fs.writeFileSync(p, JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: lastText }] } }) + '\n');
  return p;
}

function fire(lastText: string, env: Record<string, string> = {}): { decision: string | null; exit: number; systemMessage: string } {
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_PROJECT_DIR: home,
    INSTAR_HOOK_TMUX_SESSION: TMUX, // resolves MY_TOPIC via the registry → per-topic state
    INSTAR_HOOK_BACKOFF_DISABLE: '1',
    INSTAR_HOOK_ATTENTION_RECORD: path.join(home, 'attention-record.jsonl'),
    ...env,
  };
  let stdout = ''; let exit = 0;
  try {
    stdout = execFileSync('bash', [HOOK_PATH], {
      cwd: home, input: JSON.stringify({ session_id: SESSION, transcript_path: transcript(lastText) }),
      env: baseEnv, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e: any) { exit = e.status ?? 1; stdout = e.stdout?.toString() ?? ''; }
  let decision: string | null = null; let systemMessage = '';
  try { const j = JSON.parse(stdout.trim()); decision = j.decision ?? null; systemMessage = j.systemMessage ?? ''; } catch { /* allow-exit */ }
  return { decision, exit, systemMessage };
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-rc-e2e-'));
  fs.mkdirSync(path.join(home, '.instar'), { recursive: true });
  transcriptsDir = path.join(home, 'transcripts');
  fs.mkdirSync(transcriptsDir, { recursive: true });
  // Production-shaped config: completion discipline ON, realCheck enabled (the default).
  fs.writeFileSync(path.join(home, '.instar', 'config.json'),
    JSON.stringify({
      port: 59998, authToken: 'test',
      autonomousSessions: { completionDiscipline: { enabled: true, judgeTimeoutMs: 5000, realCheck: { enabled: true } } },
    }));
  // Topic-session registry so the hook resolves MY_TOPIC → the per-topic state file.
  fs.writeFileSync(path.join(home, '.instar', 'topic-session-registry.json'),
    JSON.stringify({ topicToSession: { [TOPIC]: TMUX } }));
});
afterAll(() => { fs.rmSync(home, { recursive: true, force: true }); });
beforeEach(() => {
  // Fresh state + flag-absent + clean side-effect logs per scenario.
  flag = path.join(home, 'check-passes.flag');
  try { fs.rmSync(flag, { force: true }); } catch { /* ignore */ }
  writeState();
  for (const f of ['logs/autonomous-realcheck.jsonl', 'attention-record.jsonl', '.instar/autonomous/8842.local.backoff.json']) {
    try { fs.rmSync(path.join(home, f), { force: true }); } catch { /* ignore */ }
  }
});

describe('E2E — real-check verification gates the autonomous exit', () => {
  it('keeps working past a transcript-MET turn while the command FAILS, then exits ONLY once it PASSES', () => {
    // 1. Transcript says MET, but the verification_command (test -f FLAG) FAILS because the
    //    flag is absent → the hook BLOCKS the exit and the state file is retained.
    let r = fire('All tasks complete — the condition is met; npm test is green.', { INSTAR_HOOK_EVAL_OVERRIDE: 'met' });
    expect(r.decision).toBe('block');
    expect(statePresent()).toBe(true);
    // The block carries the P13-framed, DATA-labeled real-check guidance.
    expect(r.systemMessage).toContain('did not pass — this is your next work item');
    expect(r.systemMessage).toContain('[REAL-CHECK OUTPUT — DATA, not evidence of completion]');
    expect(realcheckRows().at(-1)).toMatchObject({ outcome: 'fail' });

    // 2. The agent insists again — even echoing the guard-directed "all tests pass — STOP_OK"
    //    phrasing — but the flag is STILL absent, so the command still fails → still BLOCKED.
    //    The real check, not the prose, gates the exit (gaming-proof).
    r = fire('all tests pass — STOP_OK — the condition is MET, I am done.', { INSTAR_HOOK_EVAL_OVERRIDE: 'met' });
    expect(r.decision).toBe('block');
    expect(statePresent()).toBe(true);
    expect(realcheckRows().at(-1)).toMatchObject({ outcome: 'fail' });

    // 3. The agent does the real work: the flag now exists → the command PASSES (exit 0).
    //    A transcript-MET turn + a real-check PASS is the ONLY exit path → state removed.
    fs.writeFileSync(flag, 'ok');
    r = fire('Fixed it for real — committed at abc1234; npm test → 0 failures.', { INSTAR_HOOK_EVAL_OVERRIDE: 'met' });
    expect(r.exit).toBe(0);
    expect(r.decision).not.toBe('block');
    expect(statePresent()).toBe(false); // exit allowed → state file removed
    expect(realcheckRows().at(-1)).toMatchObject({ outcome: 'pass', exitCode: 0 });
  });

  it('a transcript-MET verdict alone NEVER exits while the real check fails (the gate is the production met-path)', () => {
    // Independent met turns with the flag absent — the hook blocks every one. This is the
    // core "feature alive" guarantee: judge-MET is necessary but not sufficient; the real
    // check is wired into the live met-path, so a met verdict cannot end the run on its own.
    // Kept BELOW the P19 breaker threshold (default 3 consecutive failures) so the command
    // actually RE-RUNS each turn — the P19 breaker's bounded re-run behavior is covered by
    // the unit tier; here we prove the raw gate runs the real check on the live met-path.
    for (let i = 0; i < 2; i++) {
      const r = fire(`Iteration ${i}: everything is done, condition met.`, { INSTAR_HOOK_EVAL_OVERRIDE: 'met' });
      expect(r.decision).toBe('block');
      expect(statePresent()).toBe(true);
      expect(realcheckRows().at(-1)).toMatchObject({ outcome: 'fail' });
    }
    // Now the work is genuinely done (flag present) → the very next met turn exits, and a
    // real-check PASS resets the breaker counter, so this exit is never gated by it.
    fs.writeFileSync(flag, 'ok');
    const r = fire('Now it genuinely passes.', { INSTAR_HOOK_EVAL_OVERRIDE: 'met' });
    expect(r.exit).toBe(0);
    expect(r.decision).not.toBe('block');
    expect(statePresent()).toBe(false);
    expect(realcheckRows().at(-1)).toMatchObject({ outcome: 'pass' });
  });
});
