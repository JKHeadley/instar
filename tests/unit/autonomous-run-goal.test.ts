/**
 * liveAutonomousRunGoal — names the run in a notify-on-stop notice. Only a
 * LIVE run (active, not paused) counts; a leftover `active: false` file does not.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { liveAutonomousRunGoal } from '../../src/core/AutonomousSessions.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let stateDir: string;

function writeRun(topic: string, fields: Record<string, string>): void {
  const dir = path.join(stateDir, 'autonomous');
  fs.mkdirSync(dir, { recursive: true });
  const body = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n');
  fs.writeFileSync(path.join(dir, `${topic}.local.md`), `---\n${body}\n---\n`);
}

beforeEach(() => { stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-goal-')); });
afterEach(() => { SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/autonomous-run-goal.test.ts:cleanup' }); });

describe('liveAutonomousRunGoal', () => {
  it('returns the goal of an active run', () => {
    writeRun('77', { active: 'true', goal: '"Fix the Lifeline noise"' });
    expect(liveAutonomousRunGoal(stateDir, '77')).toBe('Fix the Lifeline noise');
    expect(liveAutonomousRunGoal(stateDir, 77)).toBe('Fix the Lifeline noise');
  });

  it('returns null for a file that says active: false', () => {
    writeRun('78', { active: 'false', goal: '"Old run"' });
    expect(liveAutonomousRunGoal(stateDir, '78')).toBeNull();
  });

  it('returns null for a paused run', () => {
    writeRun('79', { active: 'true', paused: 'true', goal: '"Paused run"' });
    expect(liveAutonomousRunGoal(stateDir, '79')).toBeNull();
  });

  it('returns null when there is no run file or no goal', () => {
    expect(liveAutonomousRunGoal(stateDir, '80')).toBeNull();
    writeRun('81', { active: 'true' });
    expect(liveAutonomousRunGoal(stateDir, '81')).toBeNull();
  });

  it('refuses a topic id that is not a plain token (no path traversal)', () => {
    writeRun('82', { active: 'true', goal: '"x"' });
    expect(liveAutonomousRunGoal(stateDir, '../autonomous/82')).toBeNull();
  });
});
