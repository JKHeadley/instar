// safe-fs-allow: test fixture temp directories are removed in afterEach.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  AutonomousHeartbeatRunStateStore,
  type AutonomousHeartbeatRunState,
} from '../../src/monitoring/AutonomousHeartbeatRunStateStore.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    SafeFsExecutor.safeRmSync(dir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/AutonomousHeartbeatRunStateStore.test.ts',
    });
  }
});

function fixture(): { file: string; state: AutonomousHeartbeatRunState } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomous-heartbeat-store-'));
  dirs.push(dir);
  return {
    file: path.join(dir, 'state', 'autonomous-heartbeat.json'),
    state: {
      runId: '2026-07-31T12:00:00.000Z:42',
      topicId: 42,
      runStartedAtMs: Date.parse('2026-07-31T12:00:00.000Z'),
      lastHeartbeatAt: Date.parse('2026-07-31T13:00:00.000Z'),
      count: 3,
    },
  };
}

describe('AutonomousHeartbeatRunStateStore', () => {
  it('survives a new store instance (server restart) with the same per-run count and backoff anchor', () => {
    const { file, state } = fixture();
    new AutonomousHeartbeatRunStateStore(file, () => 1).write(state);

    const restarted = new AutonomousHeartbeatRunStateStore(file, () => 2);
    expect(restarted.read(state.runId)).toEqual(state);
  });

  it('atomically replaces a run reservation', () => {
    const { file, state } = fixture();
    const store = new AutonomousHeartbeatRunStateStore(file, () => 1);
    store.write(state);
    store.write({ ...state, count: 4, lastHeartbeatAt: state.lastHeartbeatAt + 90 * 60_000 });

    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(parsed.runs[state.runId]).toMatchObject({ count: 4, lastHeartbeatAt: state.lastHeartbeatAt + 90 * 60_000 });
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('prunes records that no longer correspond to active autonomous runs', () => {
    const { file, state } = fixture();
    let now = 1;
    const store = new AutonomousHeartbeatRunStateStore(file, () => now);
    store.write(state);
    now += 8 * 24 * 60 * 60_000;
    store.retain(new Set());

    expect(new AutonomousHeartbeatRunStateStore(file).read(state.runId)).toBeNull();
  });

  it('fails closed on corrupt durable state instead of resetting the budget to zero', () => {
    const { file, state } = fixture();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not-json');

    const store = new AutonomousHeartbeatRunStateStore(file);
    expect(() => store.read(state.runId)).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('{not-json');
  });
});
