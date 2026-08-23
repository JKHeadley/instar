import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  recordSessionsReadDiscrepancy,
  SESSIONS_READ_PROBE_MAX_BYTES,
} from '../../src/monitoring/SessionsReadDiscrepancyProbe.js';

describe('SessionsReadDiscrepancyProbe', () => {
  const roots: string[] = [];
  const makeStateDir = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-read-probe-'));
    roots.push(root);
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(stateDir);
    return stateDir;
  };

  afterEach(() => {
    for (const root of roots.splice(0)) {
      SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'sessions-read-probe-test-cleanup' });
    }
  });

  it('stays silent when the independent counts agree (control)', () => {
    const stateDir = makeStateDir();
    expect(recordSessionsReadDiscrepancy(stateDir, {
      sessionsCount: 1, reaperCount: 1, sessionIds: ['a'], reaperSessionIds: ['a'],
    })).toBe(false);
    expect(fs.existsSync(path.join(stateDir, 'logs', 'sessions-read-discrepancies.jsonl'))).toBe(false);
  });

  it('records a timestamped, machine-named row when the counts disagree', () => {
    const stateDir = makeStateDir();
    expect(recordSessionsReadDiscrepancy(stateDir, {
      sessionsCount: 0, reaperCount: 1, sessionIds: [], reaperSessionIds: ['live-1'],
    }, () => new Date('2026-08-23T06:20:00.000Z'), () => 'test-machine')).toBe(true);
    const row = JSON.parse(fs.readFileSync(path.join(stateDir, 'logs', 'sessions-read-discrepancies.jsonl'), 'utf8'));
    expect(row).toMatchObject({
      ts: '2026-08-23T06:20:00.000Z', hostname: 'test-machine', sessionsCount: 0,
      reaperCount: 1, sessionIds: [], reaperSessionIds: ['live-1'],
    });
  });

  it('resets the file before an append could exceed the hard byte cap', () => {
    const stateDir = makeStateDir();
    const logPath = path.join(stateDir, 'logs', 'sessions-read-discrepancies.jsonl');
    fs.mkdirSync(path.dirname(logPath));
    fs.writeFileSync(logPath, 'x'.repeat(SESSIONS_READ_PROBE_MAX_BYTES));
    recordSessionsReadDiscrepancy(stateDir, {
      sessionsCount: 0, reaperCount: 1, sessionIds: [], reaperSessionIds: ['live-1'],
    });
    expect(fs.statSync(logPath).size).toBeLessThan(SESSIONS_READ_PROBE_MAX_BYTES);
    expect(JSON.parse(fs.readFileSync(logPath, 'utf8')).reaperCount).toBe(1);
  });
});
