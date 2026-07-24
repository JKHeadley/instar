import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import DatabaseCtor from 'better-sqlite3';
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

  /** A minimal valid operator-seat UX block (the 2026-06-05 gate). */
  function ux(over: Record<string, unknown> = {}) {
    return {
      dupNotices: 0,
      infraNoiseMsgs: 0,
      asksOfUser: 0,
      contentFreeUpdates: 0,
      modalitiesExercised: ['text'],
      duringRestartChurn: false,
      ...over,
    };
  }

  /** A minimal valid transcript-audit attachment (the #864 follow-through gate). */
  function audit(over: Record<string, unknown> = {}) {
    return {
      topicIds: [1052],
      window: { start: '2026-06-03T07:00:00.000Z', end: '2026-06-03T08:00:00.000Z' },
      summary: { 'asks-of-user': 0, total: 0 },
      findingDedupKeys: [],
      generatedAt: '2026-06-03T08:01:00.000Z',
      ledger: 'dry-run',
      ...over,
    };
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
      operatorSeatUx: ux({ asksOfUser: 1, modalitiesExercised: ['text', 'photo'], notes: 'one resend ask' }),
    });

    expect(recorded.operatorSeatUx).toEqual({
      dupNotices: 0,
      infraNoiseMsgs: 0,
      asksOfUser: 1,
      contentFreeUpdates: 0,
      modalitiesExercised: ['text', 'photo'],
      duringRestartChurn: false,
      notes: 'one resend ask',
    });
    expect(store.get('cycle-1')?.operatorSeatUx?.asksOfUser).toBe(1);

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
    const current = store.record({ id: 'current', instanceId: 'i', cycleNumber: 1, task: 't', menteeOutput: 'm', operatorSeatUx: ux() });
    const legacy = store.record({ id: 'legacy', instanceId: 'i', cycleNumber: 2, task: 't', menteeOutput: 'm', kind: 'differential-cycle', operatorSeatUx: ux() });

    expect(current.kind).toBe('mentor-mentee-differential');
    expect(legacy.kind).toBe('unknown');
    expect(store.get('legacy')?.kind).toBe('unknown');
    expect(() => store.record({ id: 'bad', instanceId: 'i', cycleNumber: 3, task: 't', menteeOutput: 'm', kind: 'mentorship', operatorSeatUx: ux() })).toThrow(/kind must be one of/);
    store.close();
  });

  it('keeps a legacy bad-kind row readable while retaining strict write validation', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apprenticeship-cycles-legacy-kind-'));
    tmpDirs.push(tmp);
    const dbPath = path.join(tmp, 'cycles.db');
    let store = new ApprenticeshipCycleStore({ dbPath });
    store.record({ id: 'legacy-bad-kind', instanceId: 'phantom', cycleNumber: 1, task: 'legacy', menteeOutput: 'kept', operatorSeatUx: ux() });
    store.close();

    const db = new DatabaseCtor(dbPath);
    db.prepare(`UPDATE apprenticeship_cycles SET kind = 'mentorship' WHERE id = ?`).run('legacy-bad-kind');
    db.close();

    store = new ApprenticeshipCycleStore({ dbPath });
    expect(store.list()).toMatchObject([{ id: 'legacy-bad-kind', kind: 'unknown' }]);
    expect(store.get('legacy-bad-kind')).toMatchObject({ kind: 'unknown' });
    expect(store.roleCoverage('phantom').unknown).toMatchObject({ fired: true, cycleCount: 1 });
    expect(() => store.record({ id: 'new-bad-kind', instanceId: 'i', cycleNumber: 2, task: 't', menteeOutput: 'm', kind: 'mentorship', operatorSeatUx: ux() })).toThrow(/kind must be one of/);
    store.close();
  });

  it('roleCoverage warns when mentor-mentee is dormant while overseer-apprentice has multiple cycles', () => {
    const store = makeStore();
    store.record({ id: 'review-1', instanceId: 'i', cycleNumber: 1, createdAt: '2026-06-03T08:00:00.000Z', task: 't', menteeOutput: 'm', kind: 'overseer-apprentice-devreview', operatorSeatUx: ux() });
    store.record({ id: 'review-2', instanceId: 'i', cycleNumber: 2, createdAt: '2026-06-03T09:00:00.000Z', task: 't', menteeOutput: 'm', kind: 'overseer-apprentice-devreview', operatorSeatUx: ux() });
    store.record({ id: 'unknown', instanceId: 'i', cycleNumber: 3, createdAt: '2026-06-03T10:00:00.000Z', task: 't', menteeOutput: 'm', kind: 'unknown', operatorSeatUx: ux() });

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
    store.record({ id: 'mentor-1', instanceId: 'healthy', cycleNumber: 1, createdAt: '2026-06-03T08:00:00.000Z', task: 't', menteeOutput: 'm', kind: 'mentor-mentee-differential', operatorSeatUx: ux() });
    store.record({ id: 'review-1', instanceId: 'healthy', cycleNumber: 2, createdAt: '2026-06-03T09:00:00.000Z', task: 't', menteeOutput: 'm', kind: 'overseer-apprentice-devreview', operatorSeatUx: ux() });
    store.record({ id: 'direct-1', instanceId: 'healthy', cycleNumber: 3, createdAt: '2026-06-03T10:00:00.000Z', task: 't', menteeOutput: 'm', kind: 'overseer-mentee-direct', operatorSeatUx: ux() });

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

  describe('keystoneBalance — observe-only deepest-layer health (2026-06-06 mentor/mentee balance)', () => {
    it('folds peer-agent cycle evidence into the instance coverage without double-counting mirrored ids', () => {
      const store = makeStore();
      const remote = {
        id: 'remote-keystone', instanceId: 'i', cycleNumber: 1,
        createdAt: '2026-06-03T07:00:00.000Z', task: 'peer drive', menteeOutput: 'output',
        mentorFlagged: [], overseerDifferential: [], coaching: '', infraItems: [],
        kind: 'mentor-mentee-differential' as const, status: 'open', channel: 'threadline-backup' as const,
        operatorSeatUx: null, transcriptAudit: null,
      };
      const coverage = store.roleCoverage('i', {}, [remote, remote]);
      expect(coverage.axes['mentor-mentee-differential']).toMatchObject({ fired: true, cycleCount: 1 });
      expect(coverage.keystoneBalance.starved).toBe(false);
      expect(coverage.coverageConflictingCycleIds).toEqual([]);
      store.close();
    });

    it('flags a duplicate UUID whose peer copy changes coverage-relevant evidence', () => {
      const store = makeStore();
      const base = {
        id: 'conflicted', instanceId: 'i', cycleNumber: 1,
        createdAt: '2026-06-03T07:00:00.000Z', task: 'peer drive', menteeOutput: 'output',
        mentorFlagged: [], overseerDifferential: [], coaching: '', infraItems: [], status: 'open',
        operatorSeatUx: null, transcriptAudit: null,
      };
      const coverage = store.roleCoverage('i', {}, [
        { ...base, kind: 'mentor-mentee-differential', channel: 'threadline-backup' },
        { ...base, kind: 'overseer-apprentice-devreview', channel: 'threadline-backup' },
      ] as never);
      expect(coverage.coverageConflictingCycleIds).toEqual(['conflicted']);
      store.close();
    });

    const rec = (store: ApprenticeshipCycleStore, id: string, n: number, kind: string, at: string, inst = 'i') =>
      store.record({ id, instanceId: inst, cycleNumber: n, createdAt: at, task: 't', menteeOutput: 'm', kind, operatorSeatUx: ux() });

    it('STARVED: keystone never fired while oversight ran (the assessment case)', () => {
      const store = makeStore();
      rec(store, 'r1', 1, 'overseer-apprentice-devreview', '2026-06-03T08:00:00.000Z');
      rec(store, 'r2', 2, 'overseer-apprentice-devreview', '2026-06-03T09:00:00.000Z');
      const kb = store.roleCoverage('i').keystoneBalance;
      expect(kb.keystoneAxis).toBe('mentor-mentee-differential');
      expect(kb.keystoneCycleCount).toBe(0);
      expect(kb.lastKeystoneAt).toBeNull();
      expect(kb.oversightCycleCount).toBe(2);
      expect(kb.oversightSinceKeystone).toBe(2);
      expect(kb.starved).toBe(true);
      expect(kb.reason).toMatch(/never fired/i);
      store.close();
    });

    it('STARVED: keystone fired but enough oversight piled up SINCE (fired-but-stale)', () => {
      const store = makeStore();
      rec(store, 'k1', 1, 'mentor-mentee-differential', '2026-06-03T08:00:00.000Z');
      rec(store, 'r1', 2, 'overseer-apprentice-devreview', '2026-06-03T09:00:00.000Z');
      rec(store, 'r2', 3, 'overseer-apprentice-devreview', '2026-06-03T10:00:00.000Z');
      rec(store, 'r3', 4, 'overseer-mentee-direct', '2026-06-03T11:00:00.000Z');
      const kb = store.roleCoverage('i').keystoneBalance;
      expect(kb.keystoneCycleCount).toBe(1);
      expect(kb.lastKeystoneAt).toBe('2026-06-03T08:00:00.000Z');
      expect(kb.oversightSinceKeystone).toBe(3); // all 3 oversight rows are AFTER the keystone
      expect(kb.starved).toBe(true);
      expect(kb.reason).toMatch(/drifted/i);
      store.close();
    });

    it('HEALTHY: oversight that happened BEFORE the last keystone does not count as drift', () => {
      const store = makeStore();
      rec(store, 'r1', 1, 'overseer-apprentice-devreview', '2026-06-03T08:00:00.000Z');
      rec(store, 'r2', 2, 'overseer-apprentice-devreview', '2026-06-03T09:00:00.000Z');
      rec(store, 'k1', 3, 'mentor-mentee-differential', '2026-06-03T10:00:00.000Z'); // keystone is the LATEST
      const kb = store.roleCoverage('i').keystoneBalance;
      expect(kb.oversightCycleCount).toBe(2);
      expect(kb.oversightSinceKeystone).toBe(0); // both oversight rows predate the keystone
      expect(kb.starved).toBe(false);
      expect(kb.reason).toMatch(/healthy/i);
      store.close();
    });

    it('NOT starved: empty instance / keystone-not-started has nothing to drift against', () => {
      const store = makeStore();
      const empty = store.roleCoverage('empty').keystoneBalance;
      expect(empty.starved).toBe(false);
      expect(empty.oversightCycleCount).toBe(0);
      expect(empty.reason).toMatch(/just hasn't started|not fired yet/i);
      store.close();
    });

    it('exactly AT threshold starves; one below does not (both sides of the boundary)', () => {
      const store = makeStore();
      rec(store, 'k1', 1, 'mentor-mentee-differential', '2026-06-03T08:00:00.000Z');
      rec(store, 'r1', 2, 'overseer-apprentice-devreview', '2026-06-03T09:00:00.000Z');
      rec(store, 'r2', 3, 'overseer-apprentice-devreview', '2026-06-03T10:00:00.000Z');
      // 2 oversight-since with threshold 3 → not starved
      expect(store.roleCoverage('i', { oversightStarvationThreshold: 3 }).keystoneBalance.starved).toBe(false);
      // same data, threshold 2 → exactly at → starved
      const atThreshold = store.roleCoverage('i', { oversightStarvationThreshold: 2 }).keystoneBalance;
      expect(atThreshold.starved).toBe(true);
      expect(atThreshold.starvationThreshold).toBe(2);
      store.close();
    });

    it('a direct-shortcut keystone does NOT count — starvation still sees the layer as un-driven', () => {
      const store = makeStore();
      store.record({ id: 'sc', instanceId: 'i', cycleNumber: 1, createdAt: '2026-06-03T08:00:00.000Z', task: 't', menteeOutput: 'm', kind: 'mentor-mentee-differential', channel: 'direct-shortcut', operatorSeatUx: ux() });
      rec(store, 'r1', 2, 'overseer-apprentice-devreview', '2026-06-03T09:00:00.000Z');
      const kb = store.roleCoverage('i').keystoneBalance;
      expect(kb.keystoneCycleCount).toBe(0); // shortcut excluded from the keystone axis
      expect(kb.starved).toBe(true); // so the layer reads as never-driven
      store.close();
    });
  });

  describe('keystoneBalance — dormancy (wall-clock staleness; the 24h-idle-reads-healthy gap)', () => {
    // makeStore() fixes now() at 2026-06-03T08:00:00Z; record the keystone with an
    // explicit past createdAt to control its age relative to that fixed clock.
    const recAt = (store: ApprenticeshipCycleStore, id: string, n: number, kind: string, at: string, inst = 'i') =>
      store.record({ id, instanceId: inst, cycleNumber: n, createdAt: at, task: 't', menteeOutput: 'm', kind, operatorSeatUx: ux() });

    it('DORMANT: keystone fired but last drive older than the threshold with NO oversight since (the exact masked-as-healthy case)', () => {
      const store = makeStore();
      // keystone 8h before now (08:00); default dormancy 6h; zero oversight after it
      recAt(store, 'k1', 1, 'mentor-mentee-differential', '2026-06-03T00:00:00.000Z');
      const kb = store.roleCoverage('i').keystoneBalance;
      expect(kb.starved).toBe(false); // nothing piled up since → NOT starved...
      expect(kb.dormant).toBe(true); // ...but 8h of silence → dormant
      expect(kb.lastKeystoneAgeMs).toBe(8 * 60 * 60 * 1000);
      expect(kb.dormancyThresholdMs).toBe(6 * 60 * 60 * 1000);
      expect(kb.reason).toMatch(/dormant/i);
      store.close();
    });

    it('NOT dormant: a recent keystone drive reads healthy', () => {
      const store = makeStore();
      recAt(store, 'k1', 1, 'mentor-mentee-differential', '2026-06-03T05:00:00.000Z'); // 3h ago < 6h
      const kb = store.roleCoverage('i').keystoneBalance;
      expect(kb.dormant).toBe(false);
      expect(kb.starved).toBe(false);
      expect(kb.lastKeystoneAgeMs).toBe(3 * 60 * 60 * 1000);
      expect(kb.reason).toMatch(/healthy/i);
      store.close();
    });

    it('dormancy boundary: exactly AT the threshold is dormant; one ms under is not', () => {
      const store = makeStore();
      recAt(store, 'k1', 1, 'mentor-mentee-differential', '2026-06-03T06:00:00.000Z'); // 2h ago
      const at = store.roleCoverage('i', { keystoneDormancyMs: 2 * 60 * 60 * 1000 }).keystoneBalance;
      expect(at.dormant).toBe(true); // age === threshold → dormant
      expect(at.dormancyThresholdMs).toBe(2 * 60 * 60 * 1000);
      const under = store.roleCoverage('i', { keystoneDormancyMs: 2 * 60 * 60 * 1000 + 1 }).keystoneBalance;
      expect(under.dormant).toBe(false); // threshold 1ms past the age → not dormant
      store.close();
    });

    it('ORTHOGONAL: a layer can be BOTH starved and dormant (reason names both)', () => {
      const store = makeStore();
      recAt(store, 'k1', 1, 'mentor-mentee-differential', '2026-06-03T00:00:00.000Z'); // 8h ago
      recAt(store, 'r1', 2, 'overseer-apprentice-devreview', '2026-06-03T01:00:00.000Z');
      recAt(store, 'r2', 3, 'overseer-apprentice-devreview', '2026-06-03T02:00:00.000Z');
      recAt(store, 'r3', 4, 'overseer-mentee-direct', '2026-06-03T03:00:00.000Z');
      const kb = store.roleCoverage('i').keystoneBalance; // 3 oversight-since ≥ default 3 → starved
      expect(kb.starved).toBe(true);
      expect(kb.dormant).toBe(true);
      expect(kb.reason).toMatch(/drifted/i);
      expect(kb.reason).toMatch(/dormant/i);
      store.close();
    });

    it('never-fired keystone is NOT dormant (null age — nothing to be stale)', () => {
      const store = makeStore();
      recAt(store, 'r1', 1, 'overseer-apprentice-devreview', '2026-06-03T07:00:00.000Z');
      const kb = store.roleCoverage('i').keystoneBalance;
      expect(kb.lastKeystoneAt).toBeNull();
      expect(kb.lastKeystoneAgeMs).toBeNull();
      expect(kb.dormant).toBe(false);
      store.close();
    });

    it('a future-stamped keystone clamps age to 0 (no false dormancy from clock skew)', () => {
      const store = makeStore();
      recAt(store, 'k1', 1, 'mentor-mentee-differential', '2026-06-03T10:00:00.000Z'); // 2h AFTER now
      const kb = store.roleCoverage('i').keystoneBalance;
      expect(kb.lastKeystoneAgeMs).toBe(0);
      expect(kb.dormant).toBe(false);
      store.close();
    });
  });

  it('filters list results by instanceId and applies the limit', () => {
    const store = makeStore();
    store.record({ id: 'a1', instanceId: 'a', cycleNumber: 1, task: 'a1', menteeOutput: 'out', operatorSeatUx: ux() });
    store.record({ id: 'b1', instanceId: 'b', cycleNumber: 1, task: 'b1', menteeOutput: 'out', operatorSeatUx: ux() });
    store.record({ id: 'a2', instanceId: 'a', cycleNumber: 2, task: 'a2', menteeOutput: 'out', operatorSeatUx: ux() });

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

  describe('dogfooded-channel enforcement (§4a keystone gating)', () => {
    const diff = (over: Record<string, unknown> = {}) => ({
      instanceId: 'codey-to-gemini',
      cycleNumber: 1,
      task: 't',
      menteeOutput: 'm',
      kind: 'mentor-mentee-differential',
      operatorSeatUx: ux(),
      ...over,
    });

    it('a telegram-playwright differential FIRES the keystone axis', () => {
      const store = makeStore();
      store.record(diff({ channel: 'telegram-playwright', transcriptAudit: audit() }));
      const cov = store.roleCoverage('codey-to-gemini');
      expect(cov.axes['mentor-mentee-differential'].fired).toBe(true);
      expect(cov.shortcutDifferentialCount).toBe(0);
      store.close();
    });

    it('a direct-shortcut differential is RECORDED but does NOT fire the keystone', () => {
      const store = makeStore();
      store.record(diff({ channel: 'direct-shortcut' }));
      const cov = store.roleCoverage('codey-to-gemini');
      expect(cov.axes['mentor-mentee-differential'].fired).toBe(false);
      expect(cov.axes['mentor-mentee-differential'].cycleCount).toBe(0);
      expect(cov.shortcutDifferentialCount).toBe(1);
      // still stored (honesty) — visible via list()
      expect(store.list({ instanceId: 'codey-to-gemini' })).toHaveLength(1);
      store.close();
    });

    it('an unset (grandfathered) channel FIRES the keystone — never un-fires an earned one', () => {
      const store = makeStore();
      store.record(diff()); // no channel → normalizeChannel → 'unknown' → counts
      const cov = store.roleCoverage('codey-to-gemini');
      expect(cov.axes['mentor-mentee-differential'].fired).toBe(true);
      const id = store.list({ instanceId: 'codey-to-gemini' })[0].id;
      expect(store.get(id)!.channel).toBe('unknown');
      store.close();
    });

    it('threadline-backup counts toward the keystone (legit backup channel)', () => {
      const store = makeStore();
      store.record(diff({ channel: 'threadline-backup' }));
      expect(store.roleCoverage('codey-to-gemini').axes['mentor-mentee-differential'].fired).toBe(true);
      store.close();
    });

    it('the channel round-trips through record/get and normalizes garbage to unknown', () => {
      const store = makeStore();
      const r = store.record(diff({ channel: 'not-a-real-channel' }));
      expect(r.channel).toBe('unknown');
      expect(store.get(r.id)!.channel).toBe('unknown');
      store.close();
    });
  });

  describe('operator-seat UX gate (2026-06-05 UX-blindspot directive)', () => {
    const base = (over: Record<string, unknown> = {}) => ({
      instanceId: 'echo-to-codey',
      cycleNumber: 1,
      task: 't',
      menteeOutput: 'm',
      ...over,
    });

    it('REFUSES a record without the block, naming the required shape', () => {
      const store = makeStore();
      expect(() => store.record(base())).toThrow(/operatorSeatUx is required/);
      expect(() => store.record(base())).toThrow(/dupNotices: int>=0/); // self-describing
      expect(store.list()).toHaveLength(0); // nothing persisted on refusal
      store.close();
    });

    it('REFUSES malformed blocks on both sides of each boundary', () => {
      const store = makeStore();
      expect(() => store.record(base({ operatorSeatUx: ux({ asksOfUser: -1 }) }))).toThrow(/asksOfUser must be a non-negative integer/);
      expect(() => store.record(base({ operatorSeatUx: ux({ dupNotices: 1.5 }) }))).toThrow(/dupNotices/);
      expect(() => store.record(base({ operatorSeatUx: ux({ modalitiesExercised: [] }) }))).toThrow(/modalitiesExercised must be a non-empty/);
      expect(() => store.record(base({ operatorSeatUx: ux({ duringRestartChurn: 'yes' }) }))).toThrow(/duringRestartChurn must be a boolean/);
      expect(() => store.record(base({ operatorSeatUx: 'looked fine' }))).toThrow(/must be an object/);
      store.close();
    });

    it('ACCEPTS a valid block and persists it through close/reopen semantics (get)', () => {
      const store = makeStore();
      const r = store.record(base({
        operatorSeatUx: ux({ dupNotices: 2, infraNoiseMsgs: 3, duringRestartChurn: true }),
      }));
      const read = store.get(r.id)!.operatorSeatUx!;
      expect(read.dupNotices).toBe(2);
      expect(read.infraNoiseMsgs).toBe(3);
      expect(read.duringRestartChurn).toBe(true);
      store.close();
    });

    it('legacy rows (pre-gate, empty column) read as operatorSeatUx: null — grandfathered like channel=unknown', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apprenticeship-cycles-'));
      tmpDirs.push(tmp);
      const dbPath = path.join(tmp, 'cycles.db');

      // Simulate a pre-gate database: same table WITHOUT the UX column, one legacy row.
      const legacy = new DatabaseCtor(dbPath);
      legacy.exec(`CREATE TABLE apprenticeship_cycles (
        id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, cycle_number INTEGER NOT NULL,
        created_at TEXT NOT NULL, task TEXT NOT NULL, mentee_output TEXT NOT NULL,
        mentor_flagged_json TEXT NOT NULL, overseer_diff_json TEXT NOT NULL,
        coaching TEXT NOT NULL, infra_items_json TEXT NOT NULL,
        kind TEXT NOT NULL, status TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'unknown'
      )`);
      legacy.prepare(`INSERT INTO apprenticeship_cycles VALUES
        ('old-1','i',1,'2026-06-01T00:00:00.000Z','t','m','[]','[]','','[]','unknown','open','unknown')`).run();
      legacy.close();

      // Opening the store migrates (ALTER ... DEFAULT '') and the legacy row reads as null.
      const store = new ApprenticeshipCycleStore({ dbPath, now: () => new Date('2026-06-03T08:00:00.000Z') });
      expect(store.get('old-1')!.operatorSeatUx).toBeNull();
      // And NEW writes through the migrated store are still gated.
      expect(() => store.record(base())).toThrow(/operatorSeatUx is required/);
      store.close();
    });
  });

  describe('transcript-audit artifact gate (#864 follow-through — Observation Needs Structure)', () => {
    const tp = (over: Record<string, unknown> = {}) => ({
      instanceId: 'echo-to-codey',
      cycleNumber: 1,
      task: 't',
      menteeOutput: 'm',
      channel: 'telegram-playwright',
      operatorSeatUx: ux(),
      ...over,
    });

    it('REFUSES a telegram-playwright cycle without the audit, teaching the exact CLI', () => {
      const store = makeStore();
      expect(() => store.record(tp())).toThrow(/transcriptAudit is required for telegram-playwright cycles/);
      expect(() => store.record(tp())).toThrow(/dev:post-drive-transcript-audit/); // names the producing command
      expect(() => store.record(tp())).toThrow(/--history-base-url/); // and the cross-agent read path
      expect(store.list()).toHaveLength(0); // nothing persisted on refusal
      store.close();
    });

    it('the audit stays OPTIONAL on non-dogfooded channels (null when not supplied)', () => {
      const store = makeStore();
      for (const channel of ['direct-shortcut', 'threadline-backup', undefined]) {
        const r = store.record(tp({ channel, id: `c-${channel ?? 'none'}` }));
        expect(r.transcriptAudit).toBeNull();
      }
      store.close();
    });

    it('a supplied block is validated on ANY channel (malformed never persists silently)', () => {
      const store = makeStore();
      expect(() => store.record(tp({ channel: 'direct-shortcut', transcriptAudit: 'ran it, trust me' })))
        .toThrow(/transcriptAudit must be an object/);
      store.close();
    });

    it('REFUSES malformed blocks on both sides of each boundary', () => {
      const store = makeStore();
      expect(() => store.record(tp({ transcriptAudit: audit({ topicIds: [] }) }))).toThrow(/topicIds must be a non-empty array/);
      expect(() => store.record(tp({ transcriptAudit: audit({ topicIds: [0] }) }))).toThrow(/positive integers/);
      expect(() => store.record(tp({ transcriptAudit: audit({ window: { start: 'nope', end: '2026-06-03T08:00:00.000Z' } }) }))).toThrow(/window must be/);
      expect(() => store.record(tp({ transcriptAudit: audit({ window: { start: '2026-06-03T09:00:00.000Z', end: '2026-06-03T08:00:00.000Z' } }) }))).toThrow(/end must be at or after/);
      expect(() => store.record(tp({ transcriptAudit: audit({ summary: { total: -1 } }) }))).toThrow(/non-negative integer counts/);
      expect(() => store.record(tp({ transcriptAudit: audit({ summary: { total: 1.5 } }) }))).toThrow(/non-negative integer counts/);
      expect(() => store.record(tp({ transcriptAudit: audit({ findingDedupKeys: [''] }) }))).toThrow(/findingDedupKeys must be a string array/);
      expect(() => store.record(tp({ transcriptAudit: audit({ generatedAt: 'whenever' }) }))).toThrow(/generatedAt must be a parseable/);
      expect(() => store.record(tp({ transcriptAudit: audit({ ledger: 'verbal' }) }))).toThrow(/ledger must be one of local\|remote\|dry-run\|failed/);
      expect(() => store.record(tp({ transcriptAudit: audit({ notes: 42 }) }))).toThrow(/notes must be a string/);
      store.close();
    });

    it('ACCEPTS a valid block and round-trips it through get()', () => {
      const store = makeStore();
      const r = store.record(tp({
        transcriptAudit: audit({
          summary: { 'asks-of-user': 1, 'infra-noise': 2, total: 3 },
          findingDedupKeys: ['post-drive-transcript-audit::asks-of-user::topic-1052::abc123'],
          ledger: 'local',
          notes: 'filed during the 13435 run-2 drive',
        }),
      }));
      const read = store.get(r.id)!.transcriptAudit!;
      expect(read.summary.total).toBe(3);
      expect(read.findingDedupKeys).toHaveLength(1);
      expect(read.ledger).toBe('local');
      expect(read.window.start).toBe('2026-06-03T07:00:00.000Z');
      store.close();
    });

    it('legacy rows (pre-gate DB) migrate and read as transcriptAudit: null; new writes are gated', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apprenticeship-cycles-'));
      tmpDirs.push(tmp);
      const dbPath = path.join(tmp, 'cycles.db');

      // Pre-#856-era table: no UX column AND no audit column.
      const legacy = new DatabaseCtor(dbPath);
      legacy.exec(`CREATE TABLE apprenticeship_cycles (
        id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, cycle_number INTEGER NOT NULL,
        created_at TEXT NOT NULL, task TEXT NOT NULL, mentee_output TEXT NOT NULL,
        mentor_flagged_json TEXT NOT NULL, overseer_diff_json TEXT NOT NULL,
        coaching TEXT NOT NULL, infra_items_json TEXT NOT NULL,
        kind TEXT NOT NULL, status TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'unknown'
      )`);
      legacy.prepare(`INSERT INTO apprenticeship_cycles VALUES
        ('old-tp','i',1,'2026-06-01T00:00:00.000Z','t','m','[]','[]','','[]','unknown','open','telegram-playwright')`).run();
      legacy.close();

      const store = new ApprenticeshipCycleStore({ dbPath, now: () => new Date('2026-06-03T08:00:00.000Z') });
      // Grandfathered: the old telegram-playwright row reads honestly as "no audit".
      expect(store.get('old-tp')!.transcriptAudit).toBeNull();
      // The migration is idempotent across reopen.
      store.close();
      const reopened = new ApprenticeshipCycleStore({ dbPath, now: () => new Date('2026-06-03T08:00:00.000Z') });
      expect(reopened.get('old-tp')!.transcriptAudit).toBeNull();
      // New telegram-playwright writes through the migrated store are gated.
      expect(() => reopened.record(tp())).toThrow(/transcriptAudit is required/);
      reopened.close();
    });
  });
});
