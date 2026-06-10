/**
 * Layer A of notify-on-stop (docs/specs/NOTIFY-ON-STOP-SPEC.md, Task 2 of the
 * 2026-05-27 silent-stalls postmortem).
 *
 * The autonomous-stop-hook's terminal exits (completion / duration / emergency)
 * previously only echoed to stderr — the terminal the user can't see — so an
 * autonomous run could end in silence. This verifies:
 *   (1) the bundled hook defines notify_terminal_stop + calls it at EVERY
 *       terminal exit (static wiring);
 *   (2) the helper actually delivers via telegram-reply.sh, gated on topic +
 *       channel, best-effort (functional — runs the REAL extracted function);
 *   (3) existing agents receive the notify-enabled hook on update (migration).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const rmrf = (p: string) => {
  try {
    SafeFsExecutor.safeRmSync(p, { recursive: true, force: true, operation: 'tests/unit/autonomous-stop-hook-notify.test.ts' });
  } catch { /* ignore */ }
};

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const HOOK_REL = path.join('.claude', 'skills', 'autonomous', 'hooks', 'autonomous-stop-hook.sh');
const HOOK_PATH = path.join(REPO_ROOT, HOOK_REL);

function readHook(): string {
  return fs.readFileSync(HOOK_PATH, 'utf8');
}

/** Extract the goal_snippet()+notify_terminal_stop() function block from the
 *  real hook so the test exercises the shipped code, not a copy. */
function extractNotifyFns(src: string): string {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.includes('goal_snippet() {'));
  expect(start).toBeGreaterThanOrEqual(0);
  // find the close of notify_terminal_stop: the first standalone `}` AFTER the
  // notify_terminal_stop() opening line.
  const notifyOpen = lines.findIndex((l, i) => i > start && l.includes('notify_terminal_stop() {'));
  expect(notifyOpen).toBeGreaterThan(start);
  let end = -1;
  for (let i = notifyOpen + 1; i < lines.length; i++) {
    if (lines[i] === '}') { end = i; break; }
  }
  expect(end).toBeGreaterThan(notifyOpen);
  return lines.slice(start, end + 1).join('\n');
}

describe('Layer A — notify_terminal_stop wiring in the bundled hook', () => {
  it('defines the notify_terminal_stop + goal_snippet helpers', () => {
    const src = readHook();
    expect(src).toMatch(/notify_terminal_stop\(\)\s*\{/);
    expect(src).toMatch(/goal_snippet\(\)\s*\{/);
  });

  it('the helper is gated on report topic + telegram channel and is best-effort', () => {
    const block = extractNotifyFns(readHook());
    expect(block).toContain('[[ -z "$REPORT_TOPIC" ]] && return 0');
    expect(block).toContain('!= "telegram" ]] && return 0');
    expect(block).toMatch(/telegram-reply\.sh/);
    expect(block).toContain('|| true'); // never blocks the exit
  });

  it('calls notify_terminal_stop at every terminal exit (duration/emergency/completion + native + hard-blocker)', () => {
    const src = readHook();
    const calls = src.split('\n').filter((l) => /^\s*notify_terminal_stop "/.test(l));
    // 2 native-mode (emergency, duration) + 4 legacy (duration, emergency,
    // completion-condition, completion-promise) + 1 idle-backoff emergency
    // re-check (the flag can arrive DURING the backoff sleep) = 7, PLUS the
    // completion-discipline additions: +1 the CD_ENABLED met-condition exit
    // (folded-judge path, distinct from the legacy P13 met-condition exit) and
    // +1 the (a) hard-blocker exit (AUTONOMOUS-COMPLETION-DISCIPLINE.md §2b.3) = 9.
    expect(calls.length).toBe(9);
    // Each terminal-exit message is plain-English and references the run.
    for (const c of calls) {
      expect(c).toMatch(/autonomous run/i);
    }
  });

  it('places a notify call before each terminal rm -f "$STATE_FILE"; exit pattern', () => {
    const src = readHook();
    // completion-promise block: notify precedes the state-file removal
    expect(src).toMatch(/notify_terminal_stop "[^\n]*finished — all the work is done\.[^\n]*"\n\s*rm -f "\$STATE_FILE"/);
    // duration block (legacy)
    expect(src).toMatch(/notify_terminal_stop "[^\n]*hit its time limit[^\n]*"\n\s*rm -f "\$STATE_FILE"/);
  });
});

describe('Layer A — notify_terminal_stop functional delivery (real extracted fn)', () => {
  let tmp: string;
  let recorded: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-stop-fn-'));
    fs.mkdirSync(path.join(tmp, '.instar', 'scripts'), { recursive: true });
    recorded = path.join(tmp, 'recorded.txt');
    // Stub telegram-reply.sh: record "<topicArg>\n<stdin>" then succeed.
    const stub = `#!/bin/bash\n{ echo "TOPIC=$1"; cat; } > "${recorded}"\n`;
    const stubPath = path.join(tmp, '.instar', 'scripts', 'telegram-reply.sh');
    fs.writeFileSync(stubPath, stub);
    fs.chmodSync(stubPath, 0o755);
  });

  afterEach(() => {
    rmrf(tmp);
  });

  function runHelper(env: Record<string, string>, msg: string): void {
    const block = extractNotifyFns(readHook());
    const harness = `set -euo pipefail\n${block}\nnotify_terminal_stop ${JSON.stringify(msg)}\n`;
    const harnessPath = path.join(tmp, 'harness.sh');
    fs.writeFileSync(harnessPath, harness);
    execFileSync('bash', [harnessPath], { cwd: tmp, env: { ...process.env, ...env } });
  }

  it('delivers the message to the report topic via telegram-reply.sh', () => {
    runHelper({ REPORT_TOPIC: '13481', REPORT_CHANNEL: 'telegram', RUN_GOAL: 'ship the thing' }, '✅ done');
    const out = fs.readFileSync(recorded, 'utf8');
    expect(out).toContain('TOPIC=13481');
    expect(out).toContain('✅ done');
  });

  it('is a no-op (no delivery) when there is no report topic', () => {
    runHelper({ REPORT_TOPIC: '', REPORT_CHANNEL: 'telegram', RUN_GOAL: 'x' }, 'should not send');
    expect(fs.existsSync(recorded)).toBe(false);
  });

  it('is a no-op for a non-telegram channel', () => {
    runHelper({ REPORT_TOPIC: '13481', REPORT_CHANNEL: 'slack', RUN_GOAL: 'x' }, 'should not send');
    expect(fs.existsSync(recorded)).toBe(false);
  });
});

describe('Layer A — existing agents receive the notify-enabled hook (migration)', () => {
  let projectDir: string;

  // Old stock hook: carries the fingerprint, lacks the notify_terminal_stop marker.
  const OLD_HOOK = [
    '#!/bin/bash',
    '# Autonomous Mode Stop Hook',
    '# TOPIC-KEYED OWNERSHIP + MULTI-SESSION (per-topic state)',
    '# Native /goal delegation',
    'REGISTRY_FILE=".instar/topic-session-registry.json"',
    'exit 0',
    '',
  ].join('\n');

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-stop-mig-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
  });

  afterEach(() => {
    rmrf(projectDir);
  });

  it('upgrades a pre-notify stock hook so it gains notify_terminal_stop', () => {
    const dst = path.join(projectDir, HOOK_REL);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, OLD_HOOK);
    expect(fs.readFileSync(dst, 'utf8')).not.toContain('notify_terminal_stop');

    const migrator = new PostUpdateMigrator({
      projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test',
    });
    const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
    (migrator as unknown as { migrateAutonomousStopHookTopicKeyed(r: typeof result): void })
      .migrateAutonomousStopHookTopicKeyed(result);

    expect(fs.readFileSync(dst, 'utf8')).toContain('notify_terminal_stop');
    expect(result.errors).toEqual([]);
  });

  it('uses the latest-capability marker for the autonomous-stop-hook migration', () => {
    // The marker is bumped each time the bundled hook gains a feature, so prior installs
    // re-deploy. It advanced `notify_terminal_stop` → `CODEX_LOOP_ENABLED` (#28 codex
    // autonomous-loop driver) → `codex-stdout-json-safe` (codex Stop hook stdout JSON-only)
    // → `p13_stop_allowed` (P13 stop-reason guard) → `CLOCK_SEG` (SESSION CLOCK injection)
    // → `RESTART_NOTE_SILENT` (the restart-resume note is no longer delivered to the
    // user's topic — self-lifecycle narration is housekeeping/default-silent; the
    // recovery-audit JSONL remains the durable record) → `IDLE_BACKOFF` (consecutive
    // quick stops pace frame re-injection — the 2026-06-06 rapid-idle-refire waste)
    // → `COMPLETION_DISCIPLINE` (structural enforcement of "don't stop a pre-approved
    // autonomous run early" — AUTONOMOUS-COMPLETION-DISCIPLINE.md).
    // The bundled hook still contains
    // notify_terminal_stop — asserted above — so that capability is not lost on upgrade.
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'core', 'PostUpdateMigrator.ts'), 'utf8');
    expect(src).toMatch(/upgrade\(\s*'\.claude\/skills\/autonomous\/hooks\/autonomous-stop-hook\.sh',\s*'COMPLETION_DISCIPLINE'/);
  });

  it('restart-resume note is SILENT to the user — audit + stderr only (RESTART_NOTE_SILENT)', () => {
    // Self-lifecycle narration is housekeeping (the note's own text says "No action
    // needed") — under restart churn the per-iteration notes flooded user topics
    // (2026-06-06). The block must keep the RECOVERY_AUDIT write but must NOT call
    // deliver_recovery_note. notify_terminal_stop (run finished / time limit — a real
    // lifecycle consequence the user should see) is unaffected.
    const src = fs.readFileSync(HOOK_PATH, 'utf8');
    expect(src).toContain('RESTART_NOTE_SILENT');
    // the restart-resume block keeps its audit write…
    expect(src).toMatch(/"event":"restart-resume"/);
    // …but no longer composes/delivers the user-facing note
    expect(src).not.toMatch(/Heads up — my session restarted mid-run/);
    const restartBlock = src.split('RESTART_NOTE_SILENT')[1]?.split('# Reconcile recorded session_id')[0] ?? '';
    expect(restartBlock).not.toContain('deliver_recovery_note ');
  });
});
