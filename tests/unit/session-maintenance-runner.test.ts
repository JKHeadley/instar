import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionMaintenanceRunner } from '../../src/core/SessionMaintenanceRunner.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('SessionMaintenanceRunner', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-maint-'));
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/session-maintenance-runner.test.ts:16' });
  });

  it('returns empty result when nothing needs maintenance', async () => {
    const runner = new SessionMaintenanceRunner({ stateDir: tmpDir });
    const result = await runner.run();

    expect(result.tasksRun).toEqual([]);
    expect(result.itemsProcessed).toBe(0);
    expect(result.summary).toContain('nothing needed');
  });

  it('trims stale execution journal entries', async () => {
    const journalPath = path.join(tmpDir, 'execution-journal.jsonl');
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 days ago
    const recent = new Date().toISOString();

    fs.writeFileSync(journalPath, [
      JSON.stringify({ timestamp: old, job: 'old-job' }),
      JSON.stringify({ timestamp: recent, job: 'recent-job' }),
    ].join('\n') + '\n');

    const runner = new SessionMaintenanceRunner({
      stateDir: tmpDir,
      executionJournalRetentionDays: 30,
    });
    const result = await runner.run();

    expect(result.tasksRun).toContain('journal-trim(1)');
    expect(result.itemsProcessed).toBe(1);

    // Verify the old entry was removed but recent was kept
    const remaining = fs.readFileSync(journalPath, 'utf-8').trim().split('\n');
    expect(remaining).toHaveLength(1);
    expect(JSON.parse(remaining[0]).job).toBe('recent-job');
  });

  it('respects timeout', async () => {
    const runner = new SessionMaintenanceRunner({
      stateDir: tmpDir,
      timeoutMs: 50,
    });
    const result = await runner.run();

    // Should complete without error even with tight timeout
    expect(result.durationMs).toBeDefined();
  });

  it('does not fail on missing journal file', async () => {
    const runner = new SessionMaintenanceRunner({ stateDir: tmpDir });
    const result = await runner.run();

    expect(result.tasksRun).toEqual([]);
  });
});

describe('SessionMaintenanceRunner — skill-telemetry rotation (skill-learning slice 0, decision 18)', () => {
  let tmpDir: string;
  const maxBytes = 2_000;
  /** ~100 bytes a row; `rows` rows → well above/below the 2 KB threshold. */
  const fill = (file: string, rows: number) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Array.from({ length: rows }, (_v, i) => JSON.stringify({ ts: i, skill: 'build', pad: 'x'.repeat(70) })).join('\n') + '\n');
  };
  const lines = (file: string) => fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).length;

  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-maint-telemetry-')); });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/session-maintenance-runner.test.ts:telemetry' });
  });

  it('rotates every *.jsonl under skill-telemetry/ that exceeds the threshold, and still the legacy flat file', async () => {
    const legacy = path.join(tmpDir, 'skill-telemetry.jsonl');
    const dir = path.join(tmpDir, 'skill-telemetry');
    const big1 = path.join(dir, 'machine-aaa.jsonl');
    const big2 = path.join(dir, 'machine-bbb.jsonl');
    const small = path.join(dir, 'machine-ccc.jsonl');
    const notJsonl = path.join(dir, 'README.txt');
    fill(legacy, 100); fill(big1, 100); fill(big2, 100); fill(small, 3);
    fs.writeFileSync(notJsonl, 'x'.repeat(5_000));
    const before = { legacy: lines(legacy), big1: lines(big1), big2: lines(big2), small: lines(small) };

    const runner = new SessionMaintenanceRunner({ stateDir: tmpDir, jsonlMaxBytes: maxBytes });
    const result = await runner.run();

    expect(result.tasksRun).toContain('jsonl-rotation(3)');
    // Rotation keeps the newest 75% of lines in place (maybeRotateJsonl's default,
    // the same trim the flat list gets), never deletes the file.
    for (const [f, was] of [[legacy, before.legacy], [big1, before.big1], [big2, before.big2]] as const) {
      expect(fs.existsSync(f)).toBe(true);
      expect(lines(f)).toBe(Math.ceil(was * 0.75));
      expect(lines(f)).toBeLessThan(was);
    }
    expect(lines(small)).toBe(before.small);
    expect(fs.statSync(notJsonl).size).toBe(5_000);
  });

  it('rotates nothing when the per-machine files sit at or below the threshold', async () => {
    fill(path.join(tmpDir, 'skill-telemetry', 'm1.jsonl'), 5);
    const runner = new SessionMaintenanceRunner({ stateDir: tmpDir, jsonlMaxBytes: maxBytes });
    const result = await runner.run();
    expect(result.tasksRun.filter((t) => t.startsWith('jsonl-rotation'))).toEqual([]);
  });

  it('tolerates a missing skill-telemetry/ directory', async () => {
    const runner = new SessionMaintenanceRunner({ stateDir: tmpDir, jsonlMaxBytes: maxBytes });
    const result = await runner.run();
    expect(result.tasksRun).toEqual([]);
  });
});
