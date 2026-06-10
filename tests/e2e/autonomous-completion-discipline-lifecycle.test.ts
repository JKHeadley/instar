// safe-git-allow: test-tmpdir-cleanup — afterAll removes the per-test mkdtempSync home.
/**
 * E2E (Tier 3) — Autonomous Completion Discipline full lifecycle ("feature alive").
 * Spec: docs/specs/AUTONOMOUS-COMPLETION-DISCIPLINE.md.
 *
 * Drives the REAL autonomous-stop-hook.sh through a production-shaped sequence
 * against a temp agent home, with per-topic state PERSISTING across hook fires.
 * Proves the structural enforcement is actually wired end to end:
 *
 *   Scenario A (condition-met exit):
 *     1. condition unmet, milestone-flavored exit  → BLOCKED (re-fed)
 *     2. condition unmet again                      → BLOCKED
 *     3. condition independently confirmed MET      → EXITS, removes state
 *
 *   Scenario B (honest (a) hard-blocker exit):
 *     1. condition unmet, milestone exit            → BLOCKED
 *     2. nonce-valid <hard-blocker>, P13 external   → EXITS + writes the JSONL row
 *        + raises the /ack-able Attention item
 *     3. (negative) a BUILDABLE hard-blocker        → BLOCKED (no exit, no row)
 *
 * The completion judge + P13 are driven through the documented test seams
 * (INSTAR_HOOK_EVAL_OVERRIDE / INSTAR_HOOK_P13_OVERRIDE) because a live localhost
 * curl cannot run in this sandbox; the route side of the protocol stamp is covered
 * by the Tier-2 integration test.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOOK_PATH = path.join(process.cwd(), '.claude', 'skills', 'autonomous', 'hooks', 'autonomous-stop-hook.sh');
const TOPIC = '9984';
const TMUX = 'echo-claude-agent-sdk';
const SESSION = '04db2de7-8e82-4baf-9136-7a067bb2ec53';
const NONCE = 'e2e0nonce0abc';

let home: string;
let transcriptsDir: string;

function statePath() { return path.join(home, '.instar', 'autonomous', `${TOPIC}.local.md`); }
function statePresent() { return fs.existsSync(statePath()); }
function hardBlockerLog(): string {
  const p = path.join(home, 'logs', 'autonomous-hard-blocker.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}
function attentionRecord(): string {
  const p = path.join(home, 'attention-record.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

function writeState() {
  fs.mkdirSync(path.join(home, '.instar', 'autonomous'), { recursive: true });
  fs.writeFileSync(statePath(),
    `---\nactive: true\niteration: 1\nsession_id: "${SESSION}"\nduration_seconds: 28800\nstarted_at: "${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}"\nreport_topic: "${TOPIC}"\ncompletion_promise: "ALL_TASKS_COMPLETE"\ncompletion_condition: "all tests in tests/auth pass and npm test exits 0"\ncompletion_mode: condition\nhard_blocker_nonce: "${NONCE}"\n---\n\n# Autonomous Session\n\n## Tasks\n- [ ] implement auth\n- [ ] write tests\n`);
}

function transcript(lastText: string): string {
  const p = path.join(transcriptsDir, `${SESSION}.jsonl`);
  fs.writeFileSync(p, JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: lastText }] } }) + '\n');
  return p;
}

function fire(lastText: string, env: Record<string, string> = {}): { decision: string | null; exit: number } {
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
  let decision: string | null = null;
  try { decision = JSON.parse(stdout.trim()).decision ?? null; } catch { /* allow-exit */ }
  return { decision, exit };
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-cd-e2e-'));
  fs.mkdirSync(path.join(home, '.instar'), { recursive: true });
  transcriptsDir = path.join(home, 'transcripts');
  fs.mkdirSync(transcriptsDir, { recursive: true });
  // Production-shaped config with completion discipline enabled.
  fs.writeFileSync(path.join(home, '.instar', 'config.json'),
    JSON.stringify({ port: 59997, authToken: 'test', autonomousSessions: { completionDiscipline: { enabled: true, judgeTimeoutMs: 5000 } } }));
  // Topic-session registry so the hook resolves MY_TOPIC → per-topic state file.
  fs.writeFileSync(path.join(home, '.instar', 'topic-session-registry.json'),
    JSON.stringify({ topicToSession: { [TOPIC]: TMUX } }));
});
afterAll(() => { fs.rmSync(home, { recursive: true, force: true }); });
beforeEach(() => {
  // Fresh state + clean side-effect logs per scenario.
  writeState();
  for (const f of ['logs/autonomous-hard-blocker.jsonl', 'attention-record.jsonl', '.instar/autonomous/9984.local.backoff.json']) {
    try { fs.rmSync(path.join(home, f), { force: true }); } catch { /* ignore */ }
  }
});

describe('E2E — condition-met exit lifecycle', () => {
  it('blocks a milestone-flavored exit while the condition is unmet, then exits when it is confirmed MET', () => {
    // 1. milestone exit, condition not-met → BLOCKED
    let r = fire('This is a clean milestone — a good stopping point. I will pick this up next session.', { INSTAR_HOOK_EVAL_OVERRIDE: 'not-met' });
    expect(r.decision).toBe('block');
    expect(statePresent()).toBe(true);

    // 2. another not-met turn → BLOCKED
    r = fire('Still wiring auth; tests not green yet.', { INSTAR_HOOK_EVAL_OVERRIDE: 'not-met' });
    expect(r.decision).toBe('block');
    expect(statePresent()).toBe(true);

    // 3. independent evaluator confirms MET → EXITS, state cleared
    r = fire('npm test → 412 passed, 0 failed in tests/auth; committed at abc1234.', { INSTAR_HOOK_EVAL_OVERRIDE: 'met' });
    expect(r.exit).toBe(0);
    expect(r.decision).not.toBe('block');
    expect(statePresent()).toBe(false);
  });
});

describe('E2E — honest (a) hard-blocker exit lifecycle', () => {
  it('exits ONLY on a nonce-valid, P13-external hard-blocker — and the row + Attention item land', () => {
    // 1. milestone exit while unmet → BLOCKED
    let r = fire('Good stopping point — it is late. Continue tomorrow?', { INSTAR_HOOK_EVAL_OVERRIDE: 'not-met' });
    expect(r.decision).toBe('block');
    expect(statePresent()).toBe(true);

    // 2. genuine external hard-blocker, P13 classifies external → EXIT + row + attention
    const marker = `<hard-blocker nonce="${NONCE}">\n  what I tried: requested the staging DB credential from the vault and the operator's accounts\n  why I am stuck: the credential does not exist anywhere I can reach\n  what I would need to proceed: a staging DB credential that does not exist yet\n</hard-blocker>`;
    r = fire(marker, { INSTAR_HOOK_P13_OVERRIDE: 'external' });
    expect(r.exit).toBe(0);
    expect(r.decision).not.toBe('block');
    expect(statePresent()).toBe(false);

    const row = hardBlockerLog();
    expect(row).toContain('"needed"');
    expect(row).toContain('does not exist');
    expect(row).toContain('"completionConditionMet":false');
    expect(attentionRecord()).toContain('autonomous-hard-blocker');
  });

  it('does NOT exit on a BUILDABLE hard-blocker (P13 re-feeds it) — no row, state retained', () => {
    const marker = `<hard-blocker nonce="${NONCE}">\n  what I tried: paused on the design\n  why I am stuck: I need a coding standard before proceeding\n  what I would need to proceed: a derivable coding standard I could write myself\n</hard-blocker>`;
    const r = fire(marker, { INSTAR_HOOK_P13_OVERRIDE: 'buildable' });
    expect(r.decision).toBe('block');
    expect(statePresent()).toBe(true);
    expect(hardBlockerLog()).toBe('');
    expect(attentionRecord()).toBe('');
  });
});
