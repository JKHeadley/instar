// safe-git-allow: test-tmpdir-cleanup — afterEach removes per-test mkdtempSync tmpdir; SafeFsExecutor migration tracked separately.
/**
 * IDLE_BACKOFF — consecutive quick stops pace frame re-injection.
 *
 * Every block-decision the autonomous stop-hook emits re-feeds the FULL frame +
 * context to the model. When the session is idle/holding, stops arrive back-to-back
 * (~4s apart) and the loop re-injects thousands of tokens ~15×/min all night — the
 * 2026-06-06 rapid-idle-refire waste. The hook now measures the agent's ACTIVE time
 * since the last re-injection (gap = stop arrival − last resume; slept time never
 * counts) and sleeps on a tier schedule (3+ quick stops → T1, 6+ → T2, 10+ → T3)
 * before emitting the block. Real work makes the gap long and resets the counter.
 *
 * Verified here (executing the REAL hook against a temp working dir):
 *   (1) first stops never sleep; the sidecar counter rises across quick stops;
 *   (2) the 3rd consecutive quick stop engages T1 (measured wall-time);
 *   (3) a long gap (real work) resets the counter to zero — no sleep;
 *   (4) a NEW run (different started_at) resets a stale sidecar;
 *   (5) a new inbound message for the topic breaks the sleep early (responsiveness);
 *   (6) the emergency-stop flag appearing mid-sleep exits 0 + clears state;
 *   (7) INSTAR_HOOK_BACKOFF_MAX_SLEEP clamps the tier; DISABLE skips everything;
 *   (8) existing agents receive the paced hook via the IDLE_BACKOFF marker bump.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';

const HOOK_REL = path.join('.claude', 'skills', 'autonomous', 'hooks', 'autonomous-stop-hook.sh');
const HOOK_PATH = path.join(process.cwd(), HOOK_REL);
const UUID_A = '04db2de7-8e82-4baf-9136-7a067bb2ec53';
const TOPIC = '13435';
const STARTED = '2026-06-06T10:00:00Z';

let tmp: string;

function stateFile(): string {
  return path.join(tmp, '.instar', 'autonomous', `${TOPIC}.local.md`);
}
function backoffFile(): string {
  return path.join(tmp, '.instar', 'autonomous', `${TOPIC}.local.backoff.json`);
}

function writeState(opts: { startedAt?: string } = {}) {
  fs.mkdirSync(path.join(tmp, '.instar', 'autonomous'), { recursive: true });
  fs.writeFileSync(stateFile(), `---
active: true
iteration: 1
session_id: "${UUID_A}"
goal: "idle-backoff test job"
duration_seconds: 0
started_at: "${opts.startedAt ?? STARTED}"
report_topic: "${TOPIC}"
report_channel: "telegram"
report_interval: "2h"
completion_promise: "DONE"
---

Keep working.
`);
}

function writeRegistry() {
  fs.writeFileSync(
    path.join(tmp, '.instar', 'topic-session-registry.json'),
    JSON.stringify({ topicToSession: { [TOPIC]: 'sess-A' }, topicToName: {} }),
  );
}

function writeSidecar(opts: { lastResumedAt: number; quickStops: number; runStartedAt?: string }) {
  fs.writeFileSync(backoffFile(), JSON.stringify({
    runStartedAt: opts.runStartedAt ?? STARTED,
    lastResumedAt: opts.lastResumedAt,
    quickStops: opts.quickStops,
    lastSleepSecs: 0,
  }));
}

function readSidecar(): { lastResumedAt: number; quickStops: number; lastSleepSecs: number; runStartedAt: string } {
  return JSON.parse(fs.readFileSync(backoffFile(), 'utf8'));
}

const FAST_ENV = {
  // 1s tiers + 1s polling keep the suite fast while exercising the real sleep path.
  INSTAR_HOOK_BACKOFF_T1: '2',
  INSTAR_HOOK_BACKOFF_T2: '3',
  INSTAR_HOOK_BACKOFF_T3: '4',
  INSTAR_HOOK_BACKOFF_POLL_SECS: '1',
  INSTAR_HOOK_BACKOFF_MAX_SLEEP: '10',
};

function runHook(extraEnv: Record<string, string> = {}): { decision: string | null; exitCode: number; elapsedMs: number } {
  const input = JSON.stringify({ session_id: UUID_A, transcript_path: '' });
  let stdout = '';
  let exitCode = 0;
  const t0 = Date.now();
  try {
    stdout = execFileSync('bash', [HOOK_PATH], {
      cwd: tmp,
      input,
      env: { ...process.env, INSTAR_HOOK_TMUX_SESSION: 'sess-A', ...FAST_ENV, ...extraEnv },
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    exitCode = err.status ?? 1;
    stdout = err.stdout?.toString() ?? '';
  }
  const elapsedMs = Date.now() - t0;
  let decision: string | null = null;
  try { decision = JSON.parse(stdout.trim()).decision ?? null; } catch { /* allow-exit */ }
  return { decision, exitCode, elapsedMs };
}

function runHookAsync(extraEnv: Record<string, string> = {}): Promise<{ exitCode: number; elapsedMs: number }> {
  const input = JSON.stringify({ session_id: UUID_A, transcript_path: '' });
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = execFile('bash', [HOOK_PATH], {
      cwd: tmp,
      env: { ...process.env, INSTAR_HOOK_TMUX_SESSION: 'sess-A', ...FAST_ENV, ...extraEnv },
      encoding: 'utf-8',
    }, (err: any) => {
      resolve({ exitCode: err?.code ?? 0, elapsedMs: Date.now() - t0 });
    });
    child.stdin?.write(input);
    child.stdin?.end();
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-backoff-'));
  fs.mkdirSync(path.join(tmp, '.instar'), { recursive: true });
  writeRegistry();
  writeState();
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('IDLE_BACKOFF — counter evolution without sleep', () => {
  it('first stop: no sidecar history → quickStops 0, no sleep, still blocks', () => {
    const r = runHook();
    expect(r.decision).toBe('block');
    expect(r.elapsedMs).toBeLessThan(1900); // no tier engaged (T1=2s)
    const sc = readSidecar();
    expect(sc.quickStops).toBe(0);
    expect(sc.lastSleepSecs).toBe(0);
    expect(sc.runStartedAt).toBe(STARTED);
  });

  it('quick consecutive stops raise the counter (0 → 1 → 2) without sleeping', () => {
    runHook();
    runHook();
    const r3 = runHook();
    expect(r3.decision).toBe('block');
    expect(readSidecar().quickStops).toBe(2); // 3rd run = 2nd quick gap; tier starts at 3
  });

  it('a long gap (real work) resets the counter to zero — no sleep', () => {
    const now = Math.floor(Date.now() / 1000);
    writeSidecar({ lastResumedAt: now - 3600, quickStops: 9 }); // long-idle history
    const r = runHook();
    expect(r.decision).toBe('block');
    expect(r.elapsedMs).toBeLessThan(1900);
    expect(readSidecar().quickStops).toBe(0);
  });

  it('a NEW run (different started_at) resets a stale sidecar', () => {
    const now = Math.floor(Date.now() / 1000);
    writeSidecar({ lastResumedAt: now, quickStops: 11, runStartedAt: '2026-01-01T00:00:00Z' });
    const r = runHook();
    expect(r.decision).toBe('block');
    expect(r.elapsedMs).toBeLessThan(1900); // would have slept T3 if the stale counter survived
    expect(readSidecar().quickStops).toBe(0);
  });
});

describe('IDLE_BACKOFF — tiered sleep engages', () => {
  it('the 3rd consecutive quick stop sleeps T1 before blocking', () => {
    const now = Math.floor(Date.now() / 1000);
    writeSidecar({ lastResumedAt: now, quickStops: 2 }); // this stop is quick #3
    const r = runHook();
    expect(r.decision).toBe('block');
    expect(r.elapsedMs).toBeGreaterThanOrEqual(1900); // slept ~T1 (2s, 1s poll chunks)
    const sc = readSidecar();
    expect(sc.quickStops).toBe(3);
    expect(sc.lastSleepSecs).toBeGreaterThanOrEqual(2);
  });

  it('MAX_SLEEP clamps the tier', () => {
    const now = Math.floor(Date.now() / 1000);
    writeSidecar({ lastResumedAt: now, quickStops: 10 }); // T3 territory (4s)
    const r = runHook({ INSTAR_HOOK_BACKOFF_MAX_SLEEP: '1' });
    expect(r.decision).toBe('block');
    expect(r.elapsedMs).toBeLessThan(2500); // clamped to 1s, not 4s
    expect(readSidecar().lastSleepSecs).toBe(1);
  });

  it('DISABLE skips the backoff machinery entirely (no sidecar, no sleep)', () => {
    const now = Math.floor(Date.now() / 1000);
    writeSidecar({ lastResumedAt: now, quickStops: 10 });
    const before = fs.readFileSync(backoffFile(), 'utf8');
    const r = runHook({ INSTAR_HOOK_BACKOFF_DISABLE: '1' });
    expect(r.decision).toBe('block');
    expect(r.elapsedMs).toBeLessThan(1900);
    expect(fs.readFileSync(backoffFile(), 'utf8')).toBe(before); // untouched
  });
});

describe('IDLE_BACKOFF — early breaks (responsiveness + safety)', () => {
  it('a new inbound message for the topic breaks the sleep early', async () => {
    fs.mkdirSync(path.join(tmp, '.instar', 'telegram-inbound'), { recursive: true });
    const now = Math.floor(Date.now() / 1000);
    writeSidecar({ lastResumedAt: now, quickStops: 12 }); // T3 = 4s
    const pending = runHookAsync();
    await new Promise((res) => setTimeout(res, 1200));
    fs.writeFileSync(path.join(tmp, '.instar', 'telegram-inbound', `msg-${TOPIC}-999-test.txt`), 'hi');
    const r = await pending;
    expect(r.exitCode).toBe(0);
    expect(r.elapsedMs).toBeLessThan(3800); // broke before the full 4s sleep
  });

  it('the emergency-stop flag appearing mid-sleep exits 0 and clears state', async () => {
    const now = Math.floor(Date.now() / 1000);
    writeSidecar({ lastResumedAt: now, quickStops: 12 }); // T3 = 4s
    const pending = runHookAsync();
    await new Promise((res) => setTimeout(res, 1200));
    fs.writeFileSync(path.join(tmp, '.instar', 'autonomous-emergency-stop'), '');
    const r = await pending;
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(stateFile())).toBe(false);   // job cleared
    expect(fs.existsSync(backoffFile())).toBe(false); // sidecar cleared
  });

  it('the state file vanishing mid-sleep (stop/stop-all) exits 0 without re-injecting', async () => {
    const now = Math.floor(Date.now() / 1000);
    writeSidecar({ lastResumedAt: now, quickStops: 12 });
    const pending = runHookAsync();
    await new Promise((res) => setTimeout(res, 1200));
    fs.rmSync(stateFile());
    const r = await pending;
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(backoffFile())).toBe(false);
  });
});

describe('IDLE_BACKOFF — safety properties (static)', () => {
  it('self-clamps to a third of the registered Stop timeout; conservative 20s when unreadable', () => {
    const src = fs.readFileSync(HOOK_PATH, 'utf8');
    expect(src).toContain('IDLE_BACKOFF');
    expect(src).toMatch(/BK_MAX=\$\(\( BK_REG_TIMEOUT \/ 3 \)\)/);
    expect(src).toMatch(/BK_MAX=20/); // the conservative fallback exists
  });

  it('the sidecar is invisible to the server (does not end in .local.md)', () => {
    expect(backoffFile().endsWith('.local.md')).toBe(false);
    expect(backoffFile().endsWith('.backoff.json')).toBe(true);
  });
});

describe('IDLE_BACKOFF — existing agents receive the paced hook (migration)', () => {
  it('upgrades a RESTART_NOTE_SILENT-era stock hook so it gains IDLE_BACKOFF', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backoff-mig-'));
    try {
      fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
      const dst = path.join(projectDir, HOOK_REL);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      // Prior-era stock hook: carries the fingerprint + the previous marker, lacks IDLE_BACKOFF.
      fs.writeFileSync(dst, [
        '#!/bin/bash',
        '# Autonomous Mode Stop Hook',
        '# RESTART_NOTE_SILENT — self-lifecycle narration is housekeeping; default-silent.',
        'exit 0',
        '',
      ].join('\n'));

      const migrator = new PostUpdateMigrator({
        projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test',
      });
      const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
      (migrator as unknown as { migrateAutonomousStopHookTopicKeyed(r: typeof result): void })
        .migrateAutonomousStopHookTopicKeyed(result);

      const upgraded = fs.readFileSync(dst, 'utf8');
      expect(upgraded).toContain('IDLE_BACKOFF');
      expect(upgraded).toContain('RESTART_NOTE_SILENT'); // prior capability not lost
      expect(result.errors).toEqual([]);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
