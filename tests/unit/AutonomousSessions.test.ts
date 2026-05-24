// safe-git-allow: test-tmpdir-cleanup — afterEach removes per-test mkdtempSync tmpdir; SafeFsExecutor migration tracked separately.
/**
 * AutonomousSessions — multi-session control surface (cap, quota, stop).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listAutonomousJobs,
  activeAutonomousJobs,
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
