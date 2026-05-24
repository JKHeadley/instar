// safe-git-allow: test-tmpdir-cleanup — afterAll removes the per-test mkdtempSync home; SafeFsExecutor migration tracked separately.
/**
 * E2E — Autonomous restart-resume full lifecycle.
 *
 * Drives the REAL autonomous-stop-hook.sh through a production-shaped sequence
 * against a temp agent home, with state PERSISTING across hook fires (unlike the
 * per-scenario unit tests). This is the "feature alive" tier-3 check: it proves
 * autonomy survives a memory-limit restart end to end.
 *
 *   1. session A fires (topic-owned)            → blocks, no recovery note
 *   2. session A fires again                     → blocks, still no note
 *   3. RESTART: session B (new UUID, same tmux)  → blocks + exactly ONE recovery note
 *   4. session B fires again                     → blocks, no second note (dedup)
 *   5. session B emits the completion promise    → exits, removes state file
 *
 * The whole point: between steps 2 and 3 the session UUID rotates (a restart),
 * and the OLD hook would have allowed exit at step 3 — autonomy dies. Here it
 * survives because ownership is keyed on the topic, and the user gets one note.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOOK_PATH = path.join(
  process.cwd(), '.claude', 'skills', 'autonomous', 'hooks', 'autonomous-stop-hook.sh',
);
const TMUX = 'echo-claude-agent-sdk';
const TOPIC = '9984';
const SESSION_A = '04db2de7-8e82-4baf-9136-7a067bb2ec53';
const SESSION_B = 'a13495fb-bbb5-4a90-8c72-aa1e0e9e395e';

let home: string;
let transcriptsDir: string;

function statePath() {
  // Multi-session: the job lives in its per-topic state file.
  return path.join(home, '.instar', 'autonomous', `${TOPIC}.local.md`);
}
function auditPath() {
  return path.join(home, '.instar', 'autonomous-recovery.jsonl');
}
function recordedSessionId(): string {
  const m = fs.readFileSync(statePath(), 'utf-8').match(/^session_id:\s*"([^"]*)"/m);
  return m ? m[1] : '';
}
function auditCount(): number {
  if (!fs.existsSync(auditPath())) return 0;
  return fs.readFileSync(auditPath(), 'utf-8').trim().split('\n').filter(Boolean).length;
}

/** Write a transcript for a session; lastText lets us inject the completion promise. */
function transcript(uuid: string, lastText = ''): string {
  const p = path.join(transcriptsDir, `${uuid}.jsonl`);
  fs.writeFileSync(
    p,
    JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: lastText }] } }) + '\n',
  );
  return p;
}

function fire(sessionId: string, lastText = ''): { decision: string | null; exit: number } {
  const input = JSON.stringify({ session_id: sessionId, transcript_path: transcript(sessionId, lastText) });
  let stdout = '';
  let exit = 0;
  try {
    stdout = execFileSync('bash', [HOOK_PATH], {
      cwd: home,
      input,
      env: { ...process.env, INSTAR_HOOK_TMUX_SESSION: TMUX },
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    exit = err.status ?? 1;
    stdout = err.stdout?.toString() ?? '';
  }
  let decision: string | null = null;
  try { decision = JSON.parse(stdout.trim()).decision ?? null; } catch { /* allow-exit path */ }
  return { decision, exit };
}

describe('E2E: autonomous restart-resume lifecycle', () => {
  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-restart-e2e-'));
    fs.mkdirSync(path.join(home, '.instar', 'autonomous'), { recursive: true });
    transcriptsDir = path.join(home, 'transcripts');
    fs.mkdirSync(transcriptsDir, { recursive: true });
    // Topic 9984 is served by the TMUX session — the stable address.
    fs.writeFileSync(
      path.join(home, '.instar', 'topic-session-registry.json'),
      JSON.stringify({ topicToSession: { [TOPIC]: TMUX }, topicToName: {} }),
    );
    // A live autonomous job, no time limit, recorded under session A.
    const started = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    fs.writeFileSync(
      statePath(),
      `---
active: true
iteration: 3
session_id: "${SESSION_A}"
goal: "ship the thing"
duration_seconds: 0
started_at: "${started}"
report_topic: "${TOPIC}"
report_interval: "2h"
completion_promise: "SHIPPED_IT"
---

Keep shipping until done.
`,
    );
  });

  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('survives a restart end-to-end with exactly one recovery note, then completes', () => {
    // 1 + 2: session A owns via topic, no restart → blocks, no recovery note.
    expect(fire(SESSION_A).decision).toBe('block');
    expect(fire(SESSION_A).decision).toBe('block');
    expect(auditCount()).toBe(0);

    // 3: RESTART — new UUID, same tmux/topic. Must block AND record one note.
    const restart = fire(SESSION_B);
    expect(restart.decision).toBe('block');
    expect(auditCount()).toBe(1);
    // State now reconciled to the live session.
    expect(recordedSessionId()).toBe(SESSION_B);

    // 4: session B fires again → blocks, NO second note (dedup).
    expect(fire(SESSION_B).decision).toBe('block');
    expect(auditCount()).toBe(1);

    // 5: completion promise → hook lets the session exit and removes state.
    const done = fire(SESSION_B, 'All finished. <promise>SHIPPED_IT</promise>');
    expect(done.decision).not.toBe('block');
    expect(done.exit).toBe(0);
    expect(fs.existsSync(statePath())).toBe(false);
  });
});
