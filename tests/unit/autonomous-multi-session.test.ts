// safe-git-allow: test-tmpdir-cleanup — afterEach removes per-test mkdtempSync tmpdir; SafeFsExecutor migration tracked separately.
/**
 * Multi-session autonomy — per-topic state files (behavioral tests).
 *
 * Each topic gets its own state file at .instar/autonomous/<topicId>.local.md, so
 * multiple topics run autonomous jobs concurrently without colliding. The stop
 * hook resolves its own topic (tmux name → topic-session registry) and reads THAT
 * topic's file. A legacy single .instar/autonomous-state.local.md is still honored
 * and migrated to the per-topic path on first touch.
 *
 * These execute the real hook against a temp working dir.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOOK_PATH = path.join(
  process.cwd(), '.claude', 'skills', 'autonomous', 'hooks', 'autonomous-stop-hook.sh',
);
const UUID_A = '04db2de7-8e82-4baf-9136-7a067bb2ec53';
const UUID_B = 'a13495fb-bbb5-4a90-8c72-aa1e0e9e395e';

let tmp: string;

function stateBody(opts: { sessionId?: string; topic: string; promise?: string } ) {
  const started = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return `---
active: true
iteration: 1
session_id: "${opts.sessionId ?? UUID_A}"
goal: "job for ${opts.topic}"
duration_seconds: 0
started_at: "${started}"
report_topic: "${opts.topic}"
report_channel: "telegram"
report_interval: "2h"
completion_promise: "${opts.promise ?? 'DONE'}"
---

Keep working on ${opts.topic}.
`;
}

function writePerTopic(topic: string, opts: { sessionId?: string; promise?: string } = {}) {
  fs.mkdirSync(path.join(tmp, '.instar', 'autonomous'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.instar', 'autonomous', `${topic}.local.md`), stateBody({ topic, ...opts }));
}
function writeLegacy(topic: string, opts: { sessionId?: string } = {}) {
  fs.writeFileSync(path.join(tmp, '.instar', 'autonomous-state.local.md'), stateBody({ topic, ...opts }));
}
function writeRegistry(topicToSession: Record<string, string>) {
  fs.writeFileSync(
    path.join(tmp, '.instar', 'topic-session-registry.json'),
    JSON.stringify({ topicToSession, topicToName: {} }),
  );
}
function perTopicExists(topic: string) {
  return fs.existsSync(path.join(tmp, '.instar', 'autonomous', `${topic}.local.md`));
}
function legacyExists() {
  return fs.existsSync(path.join(tmp, '.instar', 'autonomous-state.local.md'));
}

function runHook(opts: { sessionId: string; tmuxSession: string }): { decision: string | null; exitCode: number } {
  const input = JSON.stringify({ session_id: opts.sessionId, transcript_path: '' });
  let stdout = '';
  let exitCode = 0;
  try {
    stdout = execFileSync('bash', [HOOK_PATH], {
      cwd: tmp,
      input,
      env: { ...process.env, INSTAR_HOOK_TMUX_SESSION: opts.tmuxSession },
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    exitCode = err.status ?? 1;
    stdout = err.stdout?.toString() ?? '';
  }
  let decision: string | null = null;
  try { decision = JSON.parse(stdout.trim()).decision ?? null; } catch { /* allow-exit */ }
  return { decision, exitCode };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-multi-'));
  fs.mkdirSync(path.join(tmp, '.instar'), { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Multi-session — per-topic isolation', () => {
  it('two topics each run their own job; each hook blocks for its own topic', () => {
    writeRegistry({ '9984': 'sess-A', '12143': 'sess-B' });
    writePerTopic('9984');
    writePerTopic('12143');

    // Session in tmux sess-A serves topic 9984 → blocks on 9984's file.
    expect(runHook({ sessionId: UUID_A, tmuxSession: 'sess-A' }).decision).toBe('block');
    // Session in tmux sess-B serves topic 12143 → blocks on 12143's file.
    expect(runHook({ sessionId: UUID_B, tmuxSession: 'sess-B' }).decision).toBe('block');

    // Both files still present (neither touched the other).
    expect(perTopicExists('9984')).toBe(true);
    expect(perTopicExists('12143')).toBe(true);
  });

  it('a session whose topic has no job file allows exit (not trapped by another topic)', () => {
    writeRegistry({ '9984': 'sess-A', '12143': 'sess-B' });
    writePerTopic('9984'); // only topic 9984 has a job
    // Session in sess-B (topic 12143) has no job file → allow exit.
    const r = runHook({ sessionId: UUID_B, tmuxSession: 'sess-B' });
    expect(r.decision).not.toBe('block');
    expect(r.exitCode).toBe(0);
    expect(perTopicExists('9984')).toBe(true); // untouched
  });

  it('a restarted session (new UUID, same topic) still blocks on its per-topic file', () => {
    writeRegistry({ '9984': 'sess-A' });
    writePerTopic('9984', { sessionId: UUID_A });
    // Restart: new UUID, same tmux/topic.
    expect(runHook({ sessionId: UUID_B, tmuxSession: 'sess-A' }).decision).toBe('block');
  });
});

describe('Multi-session — legacy fallback + migration', () => {
  it('honors a legacy single-file job when no per-topic file exists', () => {
    writeRegistry({ '9984': 'sess-A' });
    writeLegacy('9984', { sessionId: UUID_A });
    // Same session id → legacy topic-match (sess-A serves 9984) → blocks.
    expect(runHook({ sessionId: UUID_A, tmuxSession: 'sess-A' }).decision).toBe('block');
  });

  it('migrates a legacy file belonging to my topic into the per-topic path', () => {
    writeRegistry({ '9984': 'sess-A' });
    writeLegacy('9984', { sessionId: UUID_A });
    expect(legacyExists()).toBe(true);
    expect(perTopicExists('9984')).toBe(false);

    const r = runHook({ sessionId: UUID_A, tmuxSession: 'sess-A' });
    expect(r.decision).toBe('block');
    // Legacy file migrated to per-topic.
    expect(perTopicExists('9984')).toBe(true);
    expect(legacyExists()).toBe(false);
  });

  it('no job anywhere → allow exit', () => {
    writeRegistry({ '9984': 'sess-A' });
    const r = runHook({ sessionId: UUID_A, tmuxSession: 'sess-A' });
    expect(r.decision).not.toBe('block');
    expect(r.exitCode).toBe(0);
  });
});
