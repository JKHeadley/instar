/**
 * Migration telemetry ledger tests.
 *
 * Per INSTAR-JOBS-AS-AGENTMD spec §Seamless Migration Guarantee invariant 8.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  appendMigrationEvent,
  readMigrationEvents,
  findCompletedFor,
  normalizePerEntryAction,
  type MigrationEvent,
} from '../../../src/scheduler/MigrationLedger.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

describe('MigrationLedger', () => {
  let workspace: string;
  let stateDir: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-ml-'));
    stateDir = path.join(workspace, '.instar');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(workspace, { recursive: true, force: true, operation: 'MigrationLedger.test cleanup' });
  });

  const sampleCompleted: MigrationEvent = {
    kind: 'migration.completed',
    runId: '00000000-0000-0000-0000-000000000001',
    startedAt: '2026-05-13T13:00:00.000Z',
    completedAt: '2026-05-13T13:00:02.000Z',
    trigger: 'post-update',
    perEntry: [
      { slug: 'health-check', action: 'migrated' },
      { slug: 'user-job', action: 'forked', reason: 'slug not in shipped defaults' },
    ],
    backupPath: '.instar/jobs.json.pre-migrate-2026-05-13T13-00-00-000Z',
    instarVersion: '0.28.103',
  };

  it('appendMigrationEvent writes a parseable JSONL row to job-runs.jsonl', () => {
    const r = appendMigrationEvent(stateDir, sampleCompleted);
    expect(r.ok).toBe(true);
    const ledgerFile = path.join(stateDir, 'ledger', 'job-runs.jsonl');
    expect(fs.existsSync(ledgerFile)).toBe(true);
    const lines = fs.readFileSync(ledgerFile, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.kind).toBe('migration.completed');
    expect(parsed.runId).toBe(sampleCompleted.runId);
    expect(parsed.perEntry).toHaveLength(2);
  });

  it('readMigrationEvents returns appended events in order', () => {
    appendMigrationEvent(stateDir, sampleCompleted);
    appendMigrationEvent(stateDir, {
      ...sampleCompleted,
      runId: '00000000-0000-0000-0000-000000000002',
      kind: 'migration.aborted',
      abortReason: 'invariant 1 failed',
    });

    const events = readMigrationEvents(stateDir);
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe('migration.completed');
    expect(events[1].kind).toBe('migration.aborted');
  });

  it('readMigrationEvents skips non-migration JobRun rows', () => {
    appendMigrationEvent(stateDir, sampleCompleted);

    // Manually append a JobRun-shaped row.
    const ledgerFile = path.join(stateDir, 'ledger', 'job-runs.jsonl');
    fs.appendFileSync(
      ledgerFile,
      JSON.stringify({
        runId: 'job-run-1',
        slug: 'health-check',
        sessionId: 'sess-1',
        trigger: 'scheduled',
        startedAt: '2026-05-13T14:00:00.000Z',
        result: 'success',
      }) + '\n',
      'utf-8',
    );

    const events = readMigrationEvents(stateDir);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('migration.completed');
  });

  it('readMigrationEvents tolerates malformed lines', () => {
    appendMigrationEvent(stateDir, sampleCompleted);
    const ledgerFile = path.join(stateDir, 'ledger', 'job-runs.jsonl');
    fs.appendFileSync(ledgerFile, 'this is not json\n', 'utf-8');

    const events = readMigrationEvents(stateDir);
    expect(events).toHaveLength(1);
  });

  it('findCompletedFor returns the most recent completion for an instarVersion', () => {
    appendMigrationEvent(stateDir, sampleCompleted); // 0.28.103
    appendMigrationEvent(stateDir, {
      ...sampleCompleted,
      runId: '00000000-0000-0000-0000-000000000003',
      instarVersion: '0.28.104',
      completedAt: '2026-05-14T13:00:00.000Z',
    });

    const found = findCompletedFor(stateDir, '0.28.103');
    expect(found).not.toBeNull();
    expect(found!.instarVersion).toBe('0.28.103');

    const found2 = findCompletedFor(stateDir, '0.28.104');
    expect(found2!.instarVersion).toBe('0.28.104');

    expect(findCompletedFor(stateDir, '0.28.999')).toBeNull();
  });

  it('findCompletedFor returns null when only aborted events exist for that version', () => {
    appendMigrationEvent(stateDir, {
      ...sampleCompleted,
      kind: 'migration.aborted',
      abortReason: 'test',
    });
    expect(findCompletedFor(stateDir, '0.28.103')).toBeNull();
  });

  it('readMigrationEvents on empty/missing ledger returns []', () => {
    expect(readMigrationEvents(stateDir)).toEqual([]);
    fs.mkdirSync(path.join(stateDir, 'ledger'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'ledger', 'job-runs.jsonl'), '', 'utf-8');
    expect(readMigrationEvents(stateDir)).toEqual([]);
  });

  // ── normalizePerEntryAction ───────────────────────────────────────

  it('normalizePerEntryAction maps jobsMigrate vocabulary to the spec\'s outcome set', () => {
    expect(normalizePerEntryAction('migrated-instar')).toBe('migrated');
    expect(normalizePerEntryAction('forked-user')).toBe('forked');
    expect(normalizePerEntryAction('kept-user')).toBe('forked');
    expect(normalizePerEntryAction('renamed-user')).toBe('renamed');
    expect(normalizePerEntryAction('failed')).toBe('failed');
    expect(normalizePerEntryAction('deferred-in-flight')).toBe('deferred-in-flight');
    expect(normalizePerEntryAction('skipped')).toBe('skipped');
    // Unknown actions fall back to 'skipped' (defensive default).
    expect(normalizePerEntryAction('weird-new-action-from-future')).toBe('skipped');
  });
});
