// safe-git-allow: test-tmpdir-cleanup — afterEach removes per-test mkdtempSync tmpdir; SafeFsExecutor migration tracked separately.
/**
 * Autonomous stop hook — topic-keyed ownership (behavioral tests).
 *
 * Root cause of the bug this fixes: the hook keyed autonomous-session ownership
 * on the Claude session UUID. A memory-limit restart rotates the UUID but the
 * state file keeps the old one, so the hook saw a mismatch, failed open, and let
 * the (still-running) restarted session exit. Autonomy died silently for hours.
 *
 * The fix keys ownership on the TOPIC the session is serving (resolved from the
 * tmux session name via the topic-session registry — a stable "address" that
 * survives restarts), demotes session-id matching to a liveness-gated backstop,
 * and emits a one-line recovery note exactly once when a restart-resume happens.
 *
 * These tests EXECUTE the hook (unlike the older source-analysis test) against a
 * temp working dir, driving it with crafted state, registry, and hook input.
 *
 * Test seam: the hook resolves its own tmux session name from
 * `INSTAR_HOOK_TMUX_SESSION` when set, falling back to `tmux display-message`.
 * This lets us simulate "which session am I" deterministically.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOOK_PATH = path.join(
  process.cwd(),
  '.claude',
  'skills',
  'autonomous',
  'hooks',
  'autonomous-stop-hook.sh',
);

const OLD_UUID = '04db2de7-8e82-4baf-9136-7a067bb2ec53';
const NEW_UUID = 'a13495fb-bbb5-4a90-8c72-aa1e0e9e395e';

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  decision: string | null;
}

let tmpDir: string;

function writeState(opts: {
  active?: boolean;
  sessionId?: string;
  reportTopic?: string;
  reportChannel?: string;
  iteration?: number;
  durationSeconds?: number;
  startedAt?: string;
  completionPromise?: string;
  extraFrontmatter?: string;
  task?: string;
}): void {
  const {
    active = true,
    sessionId = OLD_UUID,
    reportTopic = '9984',
    reportChannel,
    iteration = 1,
    durationSeconds = 0,
    startedAt,
    completionPromise = 'ALL_DONE',
    extraFrontmatter = '',
    task = 'Keep building the thing until done.',
  } = opts;
  const started = startedAt ?? new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const channelLine = reportChannel ? `\nreport_channel: "${reportChannel}"` : '';
  const content = `---
active: ${active}
iteration: ${iteration}
session_id: "${sessionId}"
goal: "test goal"
duration_seconds: ${durationSeconds}
started_at: "${started}"
report_topic: "${reportTopic}"${channelLine}
report_interval: "2h"
completion_promise: "${completionPromise}"${extraFrontmatter ? '\n' + extraFrontmatter : ''}
---

${task}
`;
  fs.writeFileSync(path.join(tmpDir, '.instar', 'autonomous-state.local.md'), content);
}

function writeRegistry(topicToSession: Record<string, string>): void {
  fs.writeFileSync(
    path.join(tmpDir, '.instar', 'topic-session-registry.json'),
    JSON.stringify({ topicToSession, topicToName: {} }, null, 2),
  );
}

/** Create a fake transcript jsonl for a given UUID under the claude projects layout
 *  mirrored inside tmpDir, with a controllable mtime (seconds-ago). */
function writeTranscript(uuid: string, secondsAgo: number, lastText = ''): string {
  const projDir = path.join(tmpDir, 'claude-projects');
  fs.mkdirSync(projDir, { recursive: true });
  const p = path.join(projDir, `${uuid}.jsonl`);
  const line = JSON.stringify({
    role: 'assistant',
    message: { content: [{ type: 'text', text: lastText }] },
  });
  fs.writeFileSync(p, line + '\n');
  const when = Date.now() - secondsAgo * 1000;
  fs.utimesSync(p, when / 1000, when / 1000);
  return p;
}

function runHook(opts: {
  sessionId: string;
  transcriptPath?: string;
  tmuxSession?: string;
}): RunResult {
  const input = JSON.stringify({
    session_id: opts.sessionId,
    transcript_path: opts.transcriptPath ?? '',
  });
  const env: NodeJS.ProcessEnv = { ...process.env, INSTAR_HOOK_BACKOFF_DISABLE: '1' };
  if (opts.tmuxSession !== undefined) {
    env.INSTAR_HOOK_TMUX_SESSION = opts.tmuxSession;
  } else {
    // Force "no tmux" so tests don't accidentally resolve the real session.
    env.INSTAR_HOOK_TMUX_SESSION = '';
    env.INSTAR_HOOK_NO_TMUX = '1';
  }
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  try {
    stdout = execFileSync('bash', [HOOK_PATH], {
      cwd: tmpDir,
      input,
      env,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    exitCode = err.status ?? 1;
    stdout = err.stdout?.toString() ?? '';
    stderr = err.stderr?.toString() ?? '';
  }
  let decision: string | null = null;
  try {
    const parsed = JSON.parse(stdout.trim());
    decision = parsed.decision ?? null;
  } catch {
    decision = null;
  }
  return { exitCode, stdout, stderr, decision };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-topic-hook-'));
  fs.mkdirSync(path.join(tmpDir, '.instar'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('T1 — restart survives (the core regression)', () => {
  it('BLOCKS exit when a restarted session (new UUID) still serves the job topic', () => {
    // State recorded under the OLD uuid; registry maps topic 9984 -> our tmux name.
    writeState({ sessionId: OLD_UUID, reportTopic: '9984' });
    writeRegistry({ '9984': 'echo-claude-agent-sdk' });
    // The hook fires with the NEW uuid but is running in the SAME tmux session.
    const r = runHook({
      sessionId: NEW_UUID,
      tmuxSession: 'echo-claude-agent-sdk',
      transcriptPath: writeTranscript(NEW_UUID, 0),
    });
    expect(r.decision).toBe('block');
  });
});

describe('T2 — foreign topic is never trapped', () => {
  it('ALLOWS exit when the session serves a different topic than the job', () => {
    writeState({ sessionId: OLD_UUID, reportTopic: '9984' });
    writeRegistry({ '9984': 'echo-claude-agent-sdk', '12143': 'echo-autonomous-mode-redesign' });
    const r = runHook({
      sessionId: NEW_UUID,
      tmuxSession: 'echo-autonomous-mode-redesign', // topic 12143, not the job's 9984
      transcriptPath: writeTranscript(NEW_UUID, 0),
    });
    expect(r.decision).not.toBe('block');
    expect(r.exitCode).toBe(0);
  });
});

describe('T4 — one-line recovery note, exactly once', () => {
  it('writes a recovery audit entry on restart-resume and dedupes on repeat', () => {
    writeState({ sessionId: OLD_UUID, reportTopic: '9984' });
    writeRegistry({ '9984': 'echo-claude-agent-sdk' });
    const auditPath = path.join(tmpDir, '.instar', 'autonomous-recovery.jsonl');

    // First fire after restart: should block AND record one recovery note.
    const r1 = runHook({
      sessionId: NEW_UUID,
      tmuxSession: 'echo-claude-agent-sdk',
      transcriptPath: writeTranscript(NEW_UUID, 0),
    });
    expect(r1.decision).toBe('block');
    expect(fs.existsSync(auditPath)).toBe(true);
    const after1 = fs.readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean);
    expect(after1.length).toBe(1);

    // Second fire, SAME (new) session id: still blocks, but NO new recovery note.
    const r2 = runHook({
      sessionId: NEW_UUID,
      tmuxSession: 'echo-claude-agent-sdk',
      transcriptPath: writeTranscript(NEW_UUID, 0),
    });
    expect(r2.decision).toBe('block');
    const after2 = fs.readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean);
    expect(after2.length).toBe(1);
  });
});

describe('Channel-neutral delivery seam (recovery note routes by channel)', () => {
  function readAudit(): any[] {
    const p = path.join(tmpDir, '.instar', 'autonomous-recovery.jsonl');
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  it('records channel=telegram by default (back-compat, no report_channel)', () => {
    writeState({ sessionId: OLD_UUID, reportTopic: '9984' }); // no report_channel
    writeRegistry({ '9984': 'echo-claude-agent-sdk' });
    const r = runHook({
      sessionId: NEW_UUID, tmuxSession: 'echo-claude-agent-sdk',
      transcriptPath: writeTranscript(NEW_UUID, 0),
    });
    expect(r.decision).toBe('block');
    const audit = readAudit();
    expect(audit.length).toBe(1);
    expect(audit[0].channel).toBe('telegram');
  });

  it('routes a non-Telegram channel without erroring and records that channel', () => {
    // A Slack-owned job: the hook must NOT assume Telegram. It records channel=slack
    // and continues (live Slack delivery is owned by the Channel Parity initiative).
    writeState({ sessionId: OLD_UUID, reportTopic: 'C123', reportChannel: 'slack' });
    writeRegistry({ C123: 'echo-claude-agent-sdk' });
    const r = runHook({
      sessionId: NEW_UUID, tmuxSession: 'echo-claude-agent-sdk',
      transcriptPath: writeTranscript(NEW_UUID, 0),
    });
    expect(r.decision).toBe('block'); // autonomy still survives the restart
    const audit = readAudit();
    expect(audit.length).toBe(1);
    expect(audit[0].channel).toBe('slack');
    expect(audit[0].topic).toBe('C123');
  });
});

describe('T5 — existing exit paths preserved', () => {
  it('ALLOWS exit when autonomous mode is inactive', () => {
    writeState({ active: false });
    writeRegistry({ '9984': 'echo-claude-agent-sdk' });
    const r = runHook({ sessionId: NEW_UUID, tmuxSession: 'echo-claude-agent-sdk' });
    expect(r.decision).not.toBe('block');
    expect(r.exitCode).toBe(0);
  });

  it('ALLOWS exit when there is no state file at all', () => {
    writeRegistry({ '9984': 'echo-claude-agent-sdk' });
    const r = runHook({ sessionId: NEW_UUID, tmuxSession: 'echo-claude-agent-sdk' });
    expect(r.decision).not.toBe('block');
    expect(r.exitCode).toBe(0);
  });

  it('ALLOWS exit when duration has expired', () => {
    // started_at is "now" but duration is 1s and we backdate via a long-past start.
    const past = new Date(Date.now() - 3600 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
    fs.writeFileSync(
      path.join(tmpDir, '.instar', 'autonomous-state.local.md'),
      `---\nactive: true\niteration: 1\nsession_id: "${OLD_UUID}"\nduration_seconds: 10\nstarted_at: "${past}"\nreport_topic: "9984"\ncompletion_promise: "X"\n---\n\ntask\n`,
    );
    writeRegistry({ '9984': 'echo-claude-agent-sdk' });
    const r = runHook({ sessionId: NEW_UUID, tmuxSession: 'echo-claude-agent-sdk' });
    expect(r.decision).not.toBe('block');
  });

  it('parses a millisecond timestamp to a non-zero epoch', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    expect(future).toMatch(/\.\d{3}Z$/);
    writeState({
      sessionId: OLD_UUID,
      reportTopic: '9984',
      durationSeconds: 7200,
      startedAt: future,
    });
    writeRegistry({ '9984': 'echo-claude-agent-sdk' });

    const r = runHook({ sessionId: OLD_UUID, tmuxSession: 'echo-claude-agent-sdk' });

    expect(r.decision).toBe('block');
    expect(r.stderr).not.toContain('started_at unparseable');
  });

  it('expires a run whose millisecond timestamp is past its duration', () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect(past).toMatch(/\.\d{3}Z$/);
    writeState({
      sessionId: OLD_UUID,
      reportTopic: '9984',
      durationSeconds: 10,
      startedAt: past,
    });
    writeRegistry({ '9984': 'echo-claude-agent-sdk' });

    const r = runHook({ sessionId: OLD_UUID, tmuxSession: 'echo-claude-agent-sdk' });

    expect(r.decision).not.toBe('block');
    expect(fs.existsSync(path.join(tmpDir, '.instar', 'autonomous-state.local.md'))).toBe(false);
  });
});

describe('T3 — liveness-gated backstop when topic resolution unavailable', () => {
  it('matching session id (no tmux) still BLOCKS', () => {
    writeState({ sessionId: OLD_UUID, reportTopic: '9984' });
    writeRegistry({ '9984': 'echo-claude-agent-sdk' });
    const r = runHook({ sessionId: OLD_UUID }); // no tmux; session id matches state
    expect(r.decision).toBe('block');
  });

  it('mismatched session id with a DEAD recorded owner adopts + BLOCKS', () => {
    writeState({ sessionId: OLD_UUID, reportTopic: '9984' });
    writeRegistry({}); // topic not resolvable
    writeTranscript(OLD_UUID, 600); // recorded owner's transcript stale (10 min) => dead
    const r = runHook({
      sessionId: NEW_UUID,
      transcriptPath: writeTranscript(NEW_UUID, 0),
    });
    expect(r.decision).toBe('block');
  });

  it('mismatched session id with a LIVE recorded owner allows exit (no steal)', () => {
    writeState({ sessionId: OLD_UUID, reportTopic: '9984' });
    writeRegistry({});
    writeTranscript(OLD_UUID, 1); // recorded owner's transcript fresh => alive
    const r = runHook({
      sessionId: NEW_UUID,
      transcriptPath: writeTranscript(NEW_UUID, 0),
    });
    expect(r.decision).not.toBe('block');
    expect(r.exitCode).toBe(0);
  });

  it('topic set but ABSENT from the registry degrades to the session backstop', () => {
    // Registry exists with a tmux name but no entry for our report_topic.
    writeState({ sessionId: OLD_UUID, reportTopic: '9984' });
    writeRegistry({ '5555': 'some-other-session' }); // 9984 not present
    // Same session id → backstop session-match → block (not a foreign exit).
    const r = runHook({ sessionId: OLD_UUID, tmuxSession: 'echo-claude-agent-sdk' });
    expect(r.decision).toBe('block');
  });
});

describe('Robustness — fail-safe on bad inputs (review-driven)', () => {
  it('does NOT prematurely expire when started_at is unparseable', () => {
    // Malformed started_at must never cause a premature exit (review finding).
    fs.writeFileSync(
      path.join(tmpDir, '.instar', 'autonomous-state.local.md'),
      `---\nactive: true\niteration: 1\nsession_id: "${OLD_UUID}"\nduration_seconds: 10\nstarted_at: "not-a-timestamp"\nreport_topic: "9984"\ncompletion_promise: "X"\n---\n\ntask\n`,
    );
    writeRegistry({ '9984': 'echo-claude-agent-sdk' });
    const r = runHook({ sessionId: OLD_UUID, tmuxSession: 'echo-claude-agent-sdk' });
    expect(r.decision).toBe('block'); // keeps running, not a false expiry
  });

  it('degrades to the backstop when the registry is malformed JSON', () => {
    writeState({ sessionId: OLD_UUID, reportTopic: '9984' });
    fs.writeFileSync(
      path.join(tmpDir, '.instar', 'topic-session-registry.json'),
      '{ this is not valid json',
    );
    // Topic unresolved → backstop; same session id → block (no crash, no foreign exit).
    const r = runHook({ sessionId: OLD_UUID, tmuxSession: 'echo-claude-agent-sdk' });
    expect(r.decision).toBe('block');
    expect(r.exitCode).toBe(0);
  });
});
