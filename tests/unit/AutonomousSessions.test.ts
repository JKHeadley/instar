// safe-git-allow: test-tmpdir-cleanup — afterEach removes per-test mkdtempSync tmpdir; SafeFsExecutor migration tracked separately.
/**
 * AutonomousSessions — multi-session control surface (cap, quota, stop).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  suspendAutonomousTopicForMove,
  listAutonomousJobs,
  activeAutonomousJobs,
  autonomousRunRemainingForTopic,
  canStartAutonomousJob,
  stopAutonomousTopic,
  stopAllAutonomousJobs,
  pauseAutonomousTopic,
  DEFAULT_MAX_CONCURRENT_AUTONOMOUS,
} from '../../src/core/AutonomousSessions.js';

let stateDir: string;

function writeJob(topic: string, opts: { active?: boolean; paused?: boolean; goal?: string } = {}) {
  const { active = true, paused = false, goal = `job ${topic}` } = opts;
  fs.mkdirSync(path.join(stateDir, 'autonomous'), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'autonomous', `${topic}.local.md`),
    `---\nactive: ${active}\npaused: ${paused}\niteration: 3\nsession_id: "x"\ngoal: "${goal}"\nstarted_at: "2026-05-23T18:00:00Z"\nreport_topic: "${topic}"\nreport_channel: "telegram"\n---\n\ntask\n`,
  );
}
function writeLegacy(topic: string) {
  fs.writeFileSync(
    path.join(stateDir, 'autonomous-state.local.md'),
    `---\nactive: true\niteration: 1\nreport_topic: "${topic}"\n---\n\ntask\n`,
  );
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-autosess-'));
});
afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('listing', () => {
  it('lists per-topic jobs and a legacy job', () => {
    writeJob('9984');
    writeJob('12143', { paused: true });
    writeLegacy('555');
    const jobs = listAutonomousJobs(stateDir);
    expect(jobs.map((j) => j.topic).sort()).toEqual(['12143', '555', '9984']);
    // active = active && !paused → excludes the paused one and... legacy is active too
    const active = activeAutonomousJobs(stateDir);
    expect(active.map((j) => j.topic).sort()).toEqual(['555', '9984']);
  });

  it('returns empty when no jobs', () => {
    expect(listAutonomousJobs(stateDir)).toEqual([]);
    expect(activeAutonomousJobs(stateDir)).toEqual([]);
  });
});

describe('canStartAutonomousJob — cap', () => {
  it('allows under the cap', () => {
    writeJob('a'); writeJob('b');
    const r = canStartAutonomousJob({ stateDir, maxConcurrent: 5 });
    expect(r.allowed).toBe(true);
    expect(r.activeCount).toBe(2);
  });

  it('refuses at the cap (and names running topics)', () => {
    writeJob('a'); writeJob('b'); writeJob('c');
    const r = canStartAutonomousJob({ stateDir, maxConcurrent: 3 });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('concurrency cap');
    expect(r.reason).toMatch(/a|b|c/);
  });

  it('paused jobs do not count against the cap', () => {
    writeJob('a'); writeJob('b', { paused: true });
    const r = canStartAutonomousJob({ stateDir, maxConcurrent: 2 });
    expect(r.allowed).toBe(true); // only 1 active (b is paused)
  });

  it('default cap constant is 5', () => {
    expect(DEFAULT_MAX_CONCURRENT_AUTONOMOUS).toBe(5);
  });
});

describe('canStartAutonomousJob — quota (refuse-new)', () => {
  it('refuses when quota says no', () => {
    writeJob('a');
    const r = canStartAutonomousJob({
      stateDir, maxConcurrent: 5,
      quotaCanStart: () => ({ allowed: false, reason: '5-hour rate limit at 96%' }),
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('quota');
  });

  it('allows when quota says yes and under cap', () => {
    const r = canStartAutonomousJob({
      stateDir, maxConcurrent: 5,
      quotaCanStart: () => ({ allowed: true, reason: 'ok' }),
    });
    expect(r.allowed).toBe(true);
  });

  it('cap is checked before quota (cap refusal wins)', () => {
    writeJob('a'); writeJob('b');
    const r = canStartAutonomousJob({
      stateDir, maxConcurrent: 2,
      quotaCanStart: () => ({ allowed: true, reason: 'ok' }),
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('concurrency cap');
  });
});

describe('stopping', () => {
  it('stopAutonomousTopic removes exactly one', () => {
    writeJob('a'); writeJob('b');
    expect(stopAutonomousTopic(stateDir, 'a')).toBe(true);
    const jobs = listAutonomousJobs(stateDir);
    expect(jobs.map((j) => j.topic)).toEqual(['b']);
  });

  it('stopAutonomousTopic returns false for unknown topic', () => {
    writeJob('a');
    expect(stopAutonomousTopic(stateDir, 'nope')).toBe(false);
    expect(listAutonomousJobs(stateDir).length).toBe(1);
  });

  it('stopAllAutonomousJobs clears every file + legacy and writes the emergency flag', () => {
    writeJob('a'); writeJob('b'); writeLegacy('555');
    const res = stopAllAutonomousJobs(stateDir);
    expect(res.stoppedTopics.sort()).toEqual(['a', 'b']);
    expect(res.stoppedLegacy).toBe(true);
    expect(listAutonomousJobs(stateDir)).toEqual([]);
    expect(fs.existsSync(path.join(stateDir, 'autonomous-emergency-stop'))).toBe(true);
  });
});

describe('pause', () => {
  it('pauseAutonomousTopic flags the job paused (drops it from active)', () => {
    writeJob('a');
    expect(activeAutonomousJobs(stateDir).length).toBe(1);
    expect(pauseAutonomousTopic(stateDir, 'a')).toBe(true);
    expect(activeAutonomousJobs(stateDir).length).toBe(0); // paused → not active
    expect(listAutonomousJobs(stateDir).length).toBe(1);   // still present
  });
});

describe('WS1.4 — suspendAutonomousTopicForMove (MULTI-MACHINE-SEAMLESSNESS-SPEC)', () => {
  it('suspends the run (active:false) but the state file SURVIVES with the move markers', () => {
    writeJob('13481');
    const r = suspendAutonomousTopicForMove(stateDir, '13481', 'm_mini');
    expect(r.suspended).toBe(true);
    const f = path.join(stateDir, 'autonomous', '13481.local.md');
    expect(fs.existsSync(f)).toBe(true); // NOT deleted — it rides the working-set carrier
    const content = fs.readFileSync(f, 'utf8');
    expect(content).toMatch(/^active: false$/m);
    expect(content).toMatch(/^moved_to: "m_mini"$/m);
    expect(content).toMatch(/^move_suspended_at: "/m);
    // The body (tasks) is preserved verbatim.
    expect(content).toContain('task');
    // No torn temp file left behind (atomic rename).
    expect(fs.existsSync(`${f}.tmp-move`)).toBe(false);
    // The job drops out of the active set — the stop hook releases the session.
    expect(activeAutonomousJobs(stateDir).find((j) => j.topic === '13481')).toBeUndefined();
  });

  it('is idempotent — a re-suspend refreshes the markers without duplicating lines', () => {
    writeJob('7');
    expect(suspendAutonomousTopicForMove(stateDir, '7', 'm_mini').suspended).toBe(true);
    expect(suspendAutonomousTopicForMove(stateDir, '7', 'm_ws').suspended).toBe(true);
    const content = fs.readFileSync(path.join(stateDir, 'autonomous', '7.local.md'), 'utf8');
    expect(content.match(/^moved_to:/gm)).toHaveLength(1);
    expect(content.match(/^move_suspended_at:/gm)).toHaveLength(1);
    expect(content).toMatch(/^moved_to: "m_ws"$/m); // latest target wins
  });

  it('returns suspended:false for a topic with no run (never creates a file)', () => {
    const r = suspendAutonomousTopicForMove(stateDir, '999', 'm_mini');
    expect(r.suspended).toBe(false);
    expect(fs.existsSync(path.join(stateDir, 'autonomous', '999.local.md'))).toBe(false);
  });

  it('flips a QUOTED active: "true" line too (reader/rewrite tolerance agree — second-pass fix)', () => {
    fs.mkdirSync(path.join(stateDir, 'autonomous'), { recursive: true });
    const f = path.join(stateDir, 'autonomous', '88.local.md');
    fs.writeFileSync(f, '---\nactive: "true"\niteration: 1\nreport_topic: "88"\nstarted_at: "2026-06-13T00:00:00Z"\n---\n\ntask\n');
    expect(suspendAutonomousTopicForMove(stateDir, '88', 'm_mini').suspended).toBe(true);
    const content = fs.readFileSync(f, 'utf8');
    expect(content).toMatch(/^active: false$/m);
    expect(content).toMatch(/^moved_to: "m_mini"$/m);
    expect(activeAutonomousJobs(stateDir).find((j) => j.topic === '88')).toBeUndefined();
  });

  it('NEVER reports false success: an inactive file with no move markers is an honest no-op', () => {
    writeJob('77', { active: false });
    const before = fs.readFileSync(path.join(stateDir, 'autonomous', '77.local.md'), 'utf8');
    const emitted: unknown[] = [];
    const r = suspendAutonomousTopicForMove(stateDir, '77', 'm_mini', {
      emitAutonomousRun: (...args) => emitted.push(args),
    });
    expect(r.suspended).toBe(false);
    expect(emitted).toHaveLength(0); // no stopped emit for a run that was not live
    expect(fs.readFileSync(path.join(stateDir, 'autonomous', '77.local.md'), 'utf8')).toBe(before); // untouched
  });

  it('emits the journal stopped event (the carrier re-fire trigger) with the run artifact path', () => {
    writeJob('42');
    const emitted: Array<{ topic: number; data: Record<string, unknown> }> = [];
    suspendAutonomousTopicForMove(stateDir, '42', 'm_mini', {
      emitAutonomousRun: (topic, data) => emitted.push({ topic, data: data as unknown as Record<string, unknown> }),
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].topic).toBe(42);
    expect(emitted[0].data.action).toBe('stopped');
    expect(String((emitted[0].data.artifactPaths as string[])[0])).toContain('42.local.md');
  });
});

describe('autonomousRunRemainingForTopic (honest-recycle helper)', () => {
  function writeRun(
    topic: string,
    opts: { active?: boolean; paused?: boolean; startedAt?: string; durationSeconds?: number | null } = {},
  ) {
    const {
      active = true,
      paused = false,
      startedAt = '2026-06-13T18:40:00Z',
      durationSeconds = 86400,
    } = opts;
    fs.mkdirSync(path.join(stateDir, 'autonomous'), { recursive: true });
    const dur = durationSeconds == null ? '' : `\nduration_seconds: ${durationSeconds}`;
    fs.writeFileSync(
      path.join(stateDir, 'autonomous', `${topic}.local.md`),
      `---\nactive: ${active}\npaused: ${paused}\niteration: 3\ngoal: "run ${topic}"\nstarted_at: "${startedAt}"${dur}\nreport_topic: "${topic}"\n---\n\ntask\n`,
    );
  }

  it('returns active + remaining for an in-flight run (the topic-13481 case)', () => {
    writeRun('13481', { startedAt: '2026-06-13T18:40:00Z', durationSeconds: 86400 });
    // 12h17m after start → ~11h43m remaining.
    const now = new Date('2026-06-14T06:57:00Z').getTime();
    const r = autonomousRunRemainingForTopic(stateDir, 13481, now);
    expect(r).not.toBeNull();
    expect(r!.active).toBe(true);
    // ~42180s remaining; allow a small rounding window.
    expect(r!.remainingSeconds).toBeGreaterThan(42000);
    expect(r!.remainingSeconds).toBeLessThan(42300);
  });

  it('accepts a numeric OR string topic', () => {
    writeRun('77');
    const now = new Date('2026-06-13T19:00:00Z').getTime();
    expect(autonomousRunRemainingForTopic(stateDir, 77, now)).not.toBeNull();
    expect(autonomousRunRemainingForTopic(stateDir, '77', now)).not.toBeNull();
  });

  it('returns null when the run window is already OVER (not a continuation)', () => {
    writeRun('5', { startedAt: '2026-06-13T18:40:00Z', durationSeconds: 3600 });
    const now = new Date('2026-06-13T20:00:00Z').getTime(); // 80m later, cap 60m
    expect(autonomousRunRemainingForTopic(stateDir, 5, now)).toBeNull();
  });

  it('returns null for a topic with no active run, a paused run, or a missing duration', () => {
    const now = new Date('2026-06-13T19:00:00Z').getTime();
    expect(autonomousRunRemainingForTopic(stateDir, 999, now)).toBeNull(); // no file
    writeRun('inactive', { active: false });
    expect(autonomousRunRemainingForTopic(stateDir, 'inactive', now)).toBeNull();
    writeRun('paused', { paused: true });
    expect(autonomousRunRemainingForTopic(stateDir, 'paused', now)).toBeNull();
    writeRun('nodur', { durationSeconds: null });
    expect(autonomousRunRemainingForTopic(stateDir, 'nodur', now)).toBeNull();
  });
});
