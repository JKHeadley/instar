// CompactionSentinel — one carrier of post-compaction context
// (context-budget-layered-summaries §9.1). With the switch on, the sentinel waits
// for the SessionStart(compact) hook's seeded marker and stands down when the
// hook already seeded; with no marker in the bound, today's server path runs.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CompactionSentinel } from '../../src/monitoring/CompactionSentinel.js';
import { readSeedMarkerFile, seedMarkerPath } from '../../src/monitoring/compactionSeedMarker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const UUID = '11111111-2222-3333-4444-555555555555';

describe('CompactionSentinel seed carrier', () => {
  let root: string;
  let recoverFn: ReturnType<typeof vi.fn>;
  let marker: { seededAt: number; epoch: string } | null;
  let enabled: boolean;
  let framework: string | undefined;
  let events: string[];

  const make = () => {
    const s = new CompactionSentinel(
      {
        recoverFn: recoverFn as any,
        projectDir: '/fake/project',
        jsonlRoot: root,
        getClaudeSessionId: () => UUID,
        getSessionFramework: () => framework,
        isCompactionRecoveryEnabled: () => enabled,
        readSeedMarker: () => marker,
      },
      { seedWaitMs: 30_000, seedMaxWaitMs: 180_000, seedPollMs: 2_000, verifyWindowMs: 25_000 },
    );
    for (const e of ['compaction:seeded', 'compaction:inject-attempted']) s.on(e as any, () => events.push(e));
    return s;
  };

  const writeTranscript = (lines: object[]) => {
    fs.writeFileSync(path.join(root, `${UUID}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  };

  let sentinel: CompactionSentinel;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-10T03:00:00Z'));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-carrier-'));
    writeTranscript([{ type: 'user', timestamp: '2026-11-10T02:59:00Z' }]);
    recoverFn = vi.fn().mockResolvedValue(true);
    marker = null;
    enabled = true;
    framework = 'claude-code';
    events = [];
    sentinel = make();
  });

  afterEach(() => {
    sentinel.stop();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/CompactionSentinel-seed-carrier.test.ts' });
    vi.useRealTimers();
  });

  it('stands down without injecting when the hook seed marker appears', async () => {
    sentinel.report('s1', 'PreCompact');
    expect(sentinel.getState('s1')?.status).toBe('awaiting-seed');
    expect(sentinel.isRecoveryActive('s1')).toBe(true); // zombie veto held while waiting
    await vi.advanceTimersByTimeAsync(10_000);
    marker = { seededAt: Date.now(), epoch: 'boundary-1' };
    await vi.advanceTimersByTimeAsync(2_000);
    expect(recoverFn).not.toHaveBeenCalled();
    expect(events).toContain('compaction:seeded');
    expect(sentinel.getState('s1')?.status).toBe('recovered');
  });

  it('runs the server path 30 s after the compact boundary when no seed arrives', async () => {
    sentinel.report('s1', 'PreCompact');
    await vi.advanceTimersByTimeAsync(5_000);
    writeTranscript([{ type: 'system', subtype: 'compact_boundary', timestamp: new Date(Date.now()).toISOString(), uuid: 'b1' }]);
    // Baseline path was captured at report time; the boundary entry is read from it.
    await vi.advanceTimersByTimeAsync(28_000);
    expect(recoverFn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(recoverFn).toHaveBeenCalledTimes(1);
  });

  it('falls back after the max wait when no compaction boundary is ever seen', async () => {
    sentinel.report('s1', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(170_000);
    expect(recoverFn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(recoverFn).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale marker from before this compaction', async () => {
    marker = { seededAt: Date.now() - 10 * 60_000, epoch: 'old' };
    sentinel.report('s1', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(182_000);
    expect(recoverFn).toHaveBeenCalledTimes(1);
    expect(events).not.toContain('compaction:seeded');
  });

  it('does not let one epoch marker cover a second compaction', async () => {
    marker = { seededAt: Date.now(), epoch: 'e1' };
    sentinel.report('s1', 'PreCompact');
    await vi.advanceTimersByTimeAsync(0);
    expect(events.filter(e => e === 'compaction:seeded')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000); // finalize cleanup
    sentinel.report('s1', 'PreCompact');
    await vi.advanceTimersByTimeAsync(182_000);
    expect(recoverFn).toHaveBeenCalledTimes(1);
  });

  it('binds an empty hook epoch to the transcript\'s compact-boundary id', async () => {
    // The hook ran before the engine flushed the boundary entry (measured on 2.1.321).
    writeTranscript([{ type: 'system', subtype: 'compact_boundary', timestamp: new Date(Date.now()).toISOString(), uuid: 'b-42' }]);
    let seededEpoch = '';
    sentinel.on('compaction:seeded', (p: any) => { seededEpoch = p.epoch; });
    marker = { seededAt: Date.now(), epoch: '' };
    sentinel.report('s1', 'PreCompact');
    await vi.advanceTimersByTimeAsync(0);
    expect(seededEpoch).toBe('b-42');
    expect(recoverFn).not.toHaveBeenCalled();
  });

  it('does not accept an older compaction\'s empty-epoch marker for a new boundary', async () => {
    marker = { seededAt: Date.now() - 60_000, epoch: '' }; // seeded a minute ago, previous compaction
    writeTranscript([{ type: 'system', subtype: 'compact_boundary', timestamp: new Date(Date.now()).toISOString(), uuid: 'new' }]);
    sentinel.report('s1', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(32_000);
    expect(events).not.toContain('compaction:seeded');
    expect(recoverFn).toHaveBeenCalledTimes(1);
  });

  it('two compactions in one session each stand down on their own marker (review concern 1)', async () => {
    let seeded: string[] = [];
    sentinel.on('compaction:seeded', (p: any) => { seeded.push(p.epoch); });
    // Compaction A
    sentinel.report('s1', 'PreCompact');
    await vi.advanceTimersByTimeAsync(3_000);
    writeTranscript([{ type: 'system', subtype: 'compact_boundary', timestamp: new Date(Date.now()).toISOString(), uuid: 'A' }]);
    marker = { seededAt: Date.now() + 100, epoch: '' };
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(10_000); // finalize cleanup
    // Compaction B, 5 minutes later; the hook again writes an empty epoch.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    sentinel.report('s1', 'PreCompact');
    await vi.advanceTimersByTimeAsync(3_000);
    writeTranscript([
      { type: 'system', subtype: 'compact_boundary', timestamp: new Date(Date.now() - 5 * 60_000).toISOString(), uuid: 'A' },
      { type: 'system', subtype: 'compact_boundary', timestamp: new Date(Date.now()).toISOString(), uuid: 'B' },
    ]);
    marker = { seededAt: Date.now() + 100, epoch: '' };
    await vi.advanceTimersByTimeAsync(2_000);
    expect(seeded).toEqual(['A', 'B']);
    expect(recoverFn).not.toHaveBeenCalled();
  });

  it('a previous unconsumed marker never stands in for a PreCompact report (review concern 2)', async () => {
    // Compaction A happened 60 s ago with no sentinel report; its marker is on disk.
    writeTranscript([{ type: 'system', subtype: 'compact_boundary', timestamp: new Date(Date.now() - 60_000).toISOString(), uuid: 'A' }]);
    marker = { seededAt: Date.now() - 59_900, epoch: '' };
    sentinel.report('s1', 'PreCompact'); // B is about to compact
    await vi.advanceTimersByTimeAsync(4_000);
    expect(events).not.toContain('compaction:seeded');
    // B's hook fails: no new marker. The server path must run.
    writeTranscript([
      { type: 'system', subtype: 'compact_boundary', timestamp: new Date(Date.now() - 64_000).toISOString(), uuid: 'A' },
      { type: 'system', subtype: 'compact_boundary', timestamp: new Date(Date.now()).toISOString(), uuid: 'B' },
    ]);
    await vi.advanceTimersByTimeAsync(32_000);
    expect(events).not.toContain('compaction:seeded');
    expect(recoverFn).toHaveBeenCalledTimes(1);
  });

  it('switch off: today\'s path, immediate inject, no seed wait', async () => {
    enabled = false;
    marker = { seededAt: Date.now(), epoch: 'e1' };
    sentinel.report('s1', 'PreCompact');
    await vi.advanceTimersByTimeAsync(0);
    expect(recoverFn).toHaveBeenCalledTimes(1);
    expect(events).not.toContain('compaction:seeded');
  });

  it('non-Claude engine: today\'s path, no seed wait', async () => {
    framework = 'codex-cli';
    sentinel.report('s1', 'PreCompact');
    await vi.advanceTimersByTimeAsync(0);
    expect(recoverFn).toHaveBeenCalledTimes(1);
  });

  it('deps absent: today\'s path', async () => {
    sentinel.stop();
    sentinel = new CompactionSentinel({ recoverFn: recoverFn as any, projectDir: '/fake/project', jsonlRoot: root });
    sentinel.report('s1', 'PreCompact');
    await vi.advanceTimersByTimeAsync(0);
    expect(recoverFn).toHaveBeenCalledTimes(1);
  });
});

describe('readSeedMarkerFile', () => {
  let stateDir: string;
  beforeEach(() => { stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-marker-')); });
  afterEach(() => SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/CompactionSentinel-seed-carrier.test.ts' }));

  const write = (id: string, body: string) => {
    const p = seedMarkerPath(stateDir, id)!;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };

  it('reads a well-formed marker', () => {
    write(UUID, JSON.stringify({ sessionId: UUID, epoch: 'b1', seededAt: 123 }));
    expect(readSeedMarkerFile(stateDir, UUID)).toEqual({ seededAt: 123, epoch: 'b1' });
  });

  it('returns null for missing, malformed, mismatched, or unsafe ids', () => {
    expect(readSeedMarkerFile(stateDir, UUID)).toBeNull();
    expect(readSeedMarkerFile(stateDir, undefined)).toBeNull();
    write(UUID, '{nope');
    expect(readSeedMarkerFile(stateDir, UUID)).toBeNull();
    write(UUID, JSON.stringify({ sessionId: 'other', seededAt: 1 }));
    expect(readSeedMarkerFile(stateDir, UUID)).toBeNull();
    expect(seedMarkerPath(stateDir, '../escape')).toBeNull();
  });
});
