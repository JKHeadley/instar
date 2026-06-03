import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApprenticeshipCycleStore } from '../../src/monitoring/ApprenticeshipCycleStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('ApprenticeshipCycleStore', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true,
        force: true,
        operation: 'tests/unit/apprenticeship-cycle-store.test.ts:afterEach',
      });
    }
  });

  function makeStore(): ApprenticeshipCycleStore {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apprenticeship-cycles-'));
    tmpDirs.push(tmp);
    return new ApprenticeshipCycleStore({
      dbPath: path.join(tmp, 'cycles.db'),
      now: () => new Date('2026-06-03T08:00:00.000Z'),
    });
  }

  it('records, lists, gets, and closes a cycle with JSON fields intact', () => {
    const store = makeStore();
    const recorded = store.record({
      id: 'cycle-1',
      instanceId: 'echo-to-codey',
      cycleNumber: 1,
      task: 'Read Gemini identity and report five bullets',
      menteeOutput: 'raw mentee answer',
      mentorFlagged: ['compressed implementation principle'],
      overseerDifferential: ['surface environment note separately'],
      coaching: 'Separate reasoning findings from tooling anomalies.',
      infraItems: ['ripgrep missing', 'TERM=dumb'],
      kind: 'mentor-mentee-differential',
    });

    expect(recorded.createdAt).toBe('2026-06-03T08:00:00.000Z');
    expect(recorded.status).toBe('open');
    expect(recorded.kind).toBe('mentor-mentee-differential');
    expect(recorded.mentorFlagged).toEqual(['compressed implementation principle']);
    expect(recorded.overseerDifferential).toEqual(['surface environment note separately']);
    expect(recorded.infraItems).toEqual(['ripgrep missing', 'TERM=dumb']);

    expect(store.list()).toHaveLength(1);
    expect(store.get('cycle-1')?.menteeOutput).toBe('raw mentee answer');

    const closed = store.closeCycle('cycle-1');
    expect(closed?.status).toBe('closed');
    expect(store.get('cycle-1')?.status).toBe('closed');
    store.close();
  });

  it('defaults new writes to mentor-mentee differential and maps legacy rows to unknown', () => {
    const store = makeStore();
    const current = store.record({ id: 'current', instanceId: 'i', cycleNumber: 1, task: 't', menteeOutput: 'm' });
    const legacy = store.record({ id: 'legacy', instanceId: 'i', cycleNumber: 2, task: 't', menteeOutput: 'm', kind: 'differential-cycle' });

    expect(current.kind).toBe('mentor-mentee-differential');
    expect(legacy.kind).toBe('unknown');
    expect(store.get('legacy')?.kind).toBe('unknown');
    expect(() => store.record({ id: 'bad', instanceId: 'i', cycleNumber: 3, task: 't', menteeOutput: 'm', kind: 'mentorship' })).toThrow(/kind must be one of/);
    store.close();
  });

  it('roleCoverage warns when mentor-mentee is dormant while overseer-apprentice has multiple cycles', () => {
    const store = makeStore();
    store.record({ id: 'review-1', instanceId: 'i', cycleNumber: 1, createdAt: '2026-06-03T08:00:00.000Z', task: 't', menteeOutput: 'm', kind: 'overseer-apprentice-devreview' });
    store.record({ id: 'review-2', instanceId: 'i', cycleNumber: 2, createdAt: '2026-06-03T09:00:00.000Z', task: 't', menteeOutput: 'm', kind: 'overseer-apprentice-devreview' });
    store.record({ id: 'unknown', instanceId: 'i', cycleNumber: 3, createdAt: '2026-06-03T10:00:00.000Z', task: 't', menteeOutput: 'm', kind: 'unknown' });

    const coverage = store.roleCoverage('i');
    expect(coverage.axes['overseer-apprentice-devreview']).toEqual({ fired: true, cycleCount: 2, lastAt: '2026-06-03T09:00:00.000Z' });
    expect(coverage.axes['mentor-mentee-differential']).toEqual({ fired: false, cycleCount: 0, lastAt: null });
    expect(coverage.unknown).toEqual({ fired: true, cycleCount: 1, lastAt: '2026-06-03T10:00:00.000Z' });
    expect(coverage.dormantAxes).toContain('mentor-mentee-differential');
    expect(coverage.driftWarning).toBe(true);
    store.close();
  });

  it('roleCoverage does not warn for a healthy mix or an empty instance', () => {
    const store = makeStore();
    store.record({ id: 'mentor-1', instanceId: 'healthy', cycleNumber: 1, createdAt: '2026-06-03T08:00:00.000Z', task: 't', menteeOutput: 'm', kind: 'mentor-mentee-differential' });
    store.record({ id: 'review-1', instanceId: 'healthy', cycleNumber: 2, createdAt: '2026-06-03T09:00:00.000Z', task: 't', menteeOutput: 'm', kind: 'overseer-apprentice-devreview' });
    store.record({ id: 'direct-1', instanceId: 'healthy', cycleNumber: 3, createdAt: '2026-06-03T10:00:00.000Z', task: 't', menteeOutput: 'm', kind: 'overseer-mentee-direct' });

    const healthy = store.roleCoverage('healthy');
    expect(healthy.driftWarning).toBe(false);
    expect(healthy.dormantAxes).toEqual([]);

    const empty = store.roleCoverage('empty');
    expect(empty.driftWarning).toBe(false);
    expect(empty.axes['mentor-mentee-differential']).toEqual({ fired: false, cycleCount: 0, lastAt: null });
    expect(empty.dormantAxes).toEqual([
      'mentor-mentee-differential',
      'overseer-apprentice-devreview',
      'overseer-mentee-direct',
    ]);
    store.close();
  });

  it('filters list results by instanceId and applies the limit', () => {
    const store = makeStore();
    store.record({ id: 'a1', instanceId: 'a', cycleNumber: 1, task: 'a1', menteeOutput: 'out' });
    store.record({ id: 'b1', instanceId: 'b', cycleNumber: 1, task: 'b1', menteeOutput: 'out' });
    store.record({ id: 'a2', instanceId: 'a', cycleNumber: 2, task: 'a2', menteeOutput: 'out' });

    expect(store.list({ instanceId: 'a' }).map((c) => c.id)).toEqual(['a2', 'a1']);
    expect(store.list({ limit: 2 })).toHaveLength(2);
    expect(store.get('missing')).toBeNull();
    expect(store.closeCycle('missing')).toBeNull();
    store.close();
  });

  it('rejects malformed required fields and non-string array fields', () => {
    const store = makeStore();
    expect(() => store.record({ instanceId: '', cycleNumber: 1, task: 't', menteeOutput: 'm' })).toThrow(/instanceId/);
    expect(() => store.record({ instanceId: 'i', cycleNumber: 0, task: 't', menteeOutput: 'm' })).toThrow(/cycleNumber/);
    expect(() => store.record({
      instanceId: 'i',
      cycleNumber: 1,
      task: 't',
      menteeOutput: 'm',
      mentorFlagged: ['ok', 1] as unknown as string[],
    })).toThrow(/mentorFlagged/);
    store.close();
  });
});
