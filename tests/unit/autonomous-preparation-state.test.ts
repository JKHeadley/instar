// safe-git-allow: test-tmpdir-cleanup — afterEach removes only the per-test mkdtemp directory.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  activeAutonomousJobs,
  listAutonomousJobs,
  setAutonomousPreparationState,
} from '../../src/core/AutonomousSessions.js';

const dirs: string[] = [];

function stateWithJob(active: boolean): string {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-preparation-state-'));
  dirs.push(stateDir);
  fs.mkdirSync(path.join(stateDir, 'autonomous'), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'autonomous', '36966.local.md'),
    `---\nactive: ${active}\npaused: false\nreport_topic: "36966"\ngoal: "Window 32"\n---\n`,
  );
  return stateDir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('autonomous preparation state', () => {
  it('records preparing/recovering without counting the record as active', () => {
    const stateDir = stateWithJob(false);
    expect(setAutonomousPreparationState(stateDir, '36966', 'preparing')).toBe(true);
    expect(listAutonomousJobs(stateDir)[0]).toMatchObject({ active: false, preparationState: 'preparing' });
    expect(activeAutonomousJobs(stateDir)).toEqual([]);

    expect(setAutonomousPreparationState(stateDir, '36966', 'recovering')).toBe(true);
    expect(listAutonomousJobs(stateDir)[0].preparationState).toBe('recovering');
  });

  it('enforces promotion and terminalization against independent active truth', () => {
    const inactiveDir = stateWithJob(false);
    expect(setAutonomousPreparationState(inactiveDir, '36966', 'promoted')).toBe(false);
    expect(setAutonomousPreparationState(inactiveDir, '36966', 'terminal')).toBe(true);

    const activeDir = stateWithJob(true);
    expect(setAutonomousPreparationState(activeDir, '36966', 'preparing')).toBe(false);
    expect(setAutonomousPreparationState(activeDir, '36966', 'recovering')).toBe(false);
    expect(setAutonomousPreparationState(activeDir, '36966', 'terminal')).toBe(false);
    expect(setAutonomousPreparationState(activeDir, '36966', 'promoted')).toBe(true);
    expect(activeAutonomousJobs(activeDir)).toHaveLength(1);
  });

  it('fails closed on a missing record', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-preparation-missing-'));
    dirs.push(stateDir);
    expect(setAutonomousPreparationState(stateDir, '36966', 'preparing')).toBe(false);
  });
});
