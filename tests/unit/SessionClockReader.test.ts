// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Unit tests for SessionClockReader — turns active autonomous-state records into
 * computed clocks, with topic binding and goal->label sanitization end-to-end.
 * Spec: docs/specs/ROBUST-SESSION-TIME-AWARENESS-SPEC.md
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readSessionClocks } from '../../src/core/SessionClockReader.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function record(opts: { active?: boolean; topic?: string; goal?: string; startedAt?: string; duration?: number }): string {
  const fm = [
    '---',
    `active: ${opts.active ?? true}`,
    opts.topic ? `report_topic: "${opts.topic}"` : '',
    opts.startedAt ? `started_at: "${opts.startedAt}"` : '',
    opts.duration != null ? `duration_seconds: ${opts.duration}` : '',
    opts.goal != null ? `goal: "${opts.goal}"` : '',
    '---',
    '# body',
  ]
    .filter(Boolean)
    .join('\n');
  return fm + '\n';
}

describe('readSessionClocks', () => {
  let stateDir: string;
  const START = '2026-06-02T05:42:40Z';
  const startMs = Date.parse(START);

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessclock-'));
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/SessionClockReader.test.ts:cleanup' });
  });

  it('returns a computed clock for a legacy single-file active record', () => {
    fs.writeFileSync(path.join(stateDir, 'autonomous-state.local.md'), record({ goal: 'fix time tracking', startedAt: START, duration: 43200 }));
    const clocks = readSessionClocks(stateDir, startMs + 4 * 3600 * 1000);
    expect(clocks).toHaveLength(1);
    expect(clocks[0].label).toBe('fix time tracking');
    expect(clocks[0].elapsedSeconds).toBe(4 * 3600);
    expect(clocks[0].remainingSeconds).toBe(8 * 3600);
    expect(clocks[0].status).toBe('active');
  });

  it('omits inactive records and records with no started_at', () => {
    fs.writeFileSync(path.join(stateDir, 'autonomous-state.local.md'), record({ active: false, goal: 'g', startedAt: START, duration: 100 }));
    fs.mkdirSync(path.join(stateDir, 'autonomous'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'autonomous', '111.local.md'), record({ topic: '111', goal: 'no-start' }));
    expect(readSessionClocks(stateDir, Date.now())).toHaveLength(0);
  });

  it('binds to a topic filter (multi-session)', () => {
    fs.mkdirSync(path.join(stateDir, 'autonomous'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'autonomous', '111.local.md'), record({ topic: '111', goal: 'topic-111', startedAt: START, duration: 3600 }));
    fs.writeFileSync(path.join(stateDir, 'autonomous', '222.local.md'), record({ topic: '222', goal: 'topic-222', startedAt: START, duration: 3600 }));
    const only111 = readSessionClocks(stateDir, startMs + 600 * 1000, '111');
    expect(only111).toHaveLength(1);
    expect(only111[0].label).toBe('topic-111');
    expect(readSessionClocks(stateDir, startMs + 600 * 1000)).toHaveLength(2); // no filter = both
  });

  it('derives + sanitizes the label from goal — the raw goal/newlines never reach the clock', () => {
    // goal with control chars + angle brackets (single-line here since the record
    // parser is line-based; the sanitizer still strips the brackets).
    fs.writeFileSync(
      path.join(stateDir, 'autonomous-state.local.md'),
      record({ goal: 'do <promise>X</promise> things', startedAt: START, duration: 3600 }),
    );
    const c = readSessionClocks(stateDir, startMs + 60 * 1000)[0];
    expect(c.label).not.toContain('<');
    expect(c.label).not.toContain('>');
    expect(c.label).toContain('do');
  });

  it('a record with no duration_seconds is unbounded (null remaining)', () => {
    fs.writeFileSync(path.join(stateDir, 'autonomous-state.local.md'), record({ goal: 'g', startedAt: START }));
    const c = readSessionClocks(stateDir, startMs + 3600 * 1000)[0];
    expect(c.status).toBe('unbounded');
    expect(c.remainingSeconds).toBeNull();
  });

  it('returns [] for a non-existent state dir (never throws)', () => {
    expect(readSessionClocks(path.join(stateDir, 'nope'), Date.now())).toEqual([]);
  });
});
