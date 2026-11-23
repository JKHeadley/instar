/**
 * Every project has a plain state (owner, 2026-11-19, topic 134088): a check the judge could not call reads
 * "Quiet since …" or "Stalled since …" from what the checks did read, and "unknown" only when the newest check
 * could not read the project at all, with the reason in the words. Pure functions, then the real
 * ChiefOfStaffLoop.projectsOverview over an in-memory journal feeding the real composeProjects.
 */
import { describe, it, expect } from 'vitest';
import { composeProjects, settleState, dayWords, stalledAfterMs, PROJECT_STATE_WORDS, type CosProjectRow, type ProjectsContext } from '../../src/server/workProjectsRoutes.js';
import { ChiefOfStaffLoop, CHIEF_OF_STAFF_LOOP_DEFAULTS, clampLoopConfig, evidenceChange, type ChiefOfStaffLoopDeps } from '../../src/core/ChiefOfStaffLoop.js';
import { chiefOfStaffRecordStoreSchema, buildBindingPut, buildCheckEvent, type UnionEntry } from '../../src/core/ChiefOfStaffStore.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';

const NOW = Date.parse('2026-11-19T16:00:00.000Z');
const H = 3_600_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const ctx: ProjectsContext = { here: true, tickMs: 15 * 60_000, now: NOW, timeZone: 'America/Los_Angeles' };
const proj = (over: Partial<CosProjectRow> = {}): CosProjectRow => ({
  conversationKey: 'telegram:138345', title: 'Remote Desktop: Locked Screen', goal: 'Locked-screen support on every Mac.', lastVerdict: 'unknown', lastCheckAt: iso(1 * H), parked: false,
  doneDefinition: [{ id: 'a', text: 'The six in-person tests pass.', kind: 'deterministic' }], doneItems: { a: 'unknown' },
  lastProgressAt: null, lastEvidenceChangeAt: iso(6 * 24 * H), lastCheckUnreadable: false, cadenceHours: 24, ...over,
});
const row = (r: CosProjectRow) => composeProjects([r], null, ctx).projects[0]!;

describe('evidenceChange', () => {
  it('keeps the newest check whose evidence differed, skipping unread checks', () => {
    const c = (at: string, hash: string, note = 'no new evidence') => ({ at, hash, note });
    expect(evidenceChange([])).toEqual({ lastChangeAt: null, newestUnreadable: false });
    // First readable check counts (tracking began), identical later hashes do not move it.
    expect(evidenceChange([c('2026-11-13T00:00:00Z', 'h1', 'judged'), c('2026-11-14T00:00:00Z', 'h1'), c('2026-11-15T00:00:00Z', 'h1')]).lastChangeAt).toBe('2026-11-13T00:00:00Z');
    // A failed gather between two equal reads is not a change, and is not counted as one after it either.
    const fail = c('2026-11-14T00:00:00Z', 'x'.repeat(64), 'gather-failed');
    expect(evidenceChange([c('2026-11-13T00:00:00Z', 'h1', 'judged'), fail, c('2026-11-15T00:00:00Z', 'h1', 'judged')])).toEqual({ lastChangeAt: '2026-11-13T00:00:00Z', newestUnreadable: false });
    expect(evidenceChange([c('2026-11-13T00:00:00Z', 'h1', 'judged'), c('2026-11-15T00:00:00Z', 'h2', 'judged')]).lastChangeAt).toBe('2026-11-15T00:00:00Z');
    expect(evidenceChange([c('2026-11-13T00:00:00Z', 'h1', 'judged'), { ...fail, at: '2026-11-16T00:00:00Z' }])).toEqual({ lastChangeAt: '2026-11-13T00:00:00Z', newestUnreadable: true });
  });
});

describe('dayWords and the stalled threshold', () => {
  it('says today as a time, then yesterday, then a date, in the owner zone', () => {
    expect(dayWords(iso(2 * H), NOW, 'America/Los_Angeles')).toBe('6:00 AM');
    expect(dayWords(iso(24 * H), NOW, 'America/Los_Angeles')).toBe('yesterday');
    expect(dayWords('2026-11-13T16:29:18.532Z', NOW, 'America/Los_Angeles')).toBe('Nov 13');
    expect(dayWords('not a time', NOW)).toBe('an unknown time');
    // An invalid zone falls back to this machine's, never throws.
    expect(() => dayWords(iso(2 * H), NOW, 'Not/AZone')).not.toThrow();
  });
  it('is two cadences, never under two days', () => {
    expect(stalledAfterMs(24)).toBe(48 * H);
    expect(stalledAfterMs(6)).toBe(48 * H);
    expect(stalledAfterMs(72)).toBe(144 * H);
    expect(stalledAfterMs(undefined)).toBe(48 * H);
  });
});

describe('settleState: a verdict the judge could not call', () => {
  it('reads Stalled since … when nothing happened for the threshold and the done list is open', () => {
    const p = row(proj());
    expect(p.state).toBe('stalled');
    expect(p.stateWords).toBe('Stalled since Nov 13');
    expect(p.stateSince).toBe(iso(6 * 24 * H));
  });
  it('reads Quiet since … inside the threshold, and when nothing on the done list is open', () => {
    const recent = row(proj({ lastEvidenceChangeAt: iso(30 * H) }));
    expect(recent.state).toBe('quiet');
    expect(recent.stateWords).toBe('Quiet since yesterday');
    const allPass = row(proj({ doneItems: { a: 'pass' } }));
    expect(allPass.state).toBe('quiet');
    expect(allPass.stateWords).toBe('Quiet since Nov 13');
    // Just under vs at the threshold.
    expect(row(proj({ lastEvidenceChangeAt: iso(48 * H - 1) })).state).toBe('quiet');
    expect(row(proj({ lastEvidenceChangeAt: iso(48 * H) })).state).toBe('stalled');
  });
  it('dates quiet from the newer of progress and a change in evidence', () => {
    const p = row(proj({ lastProgressAt: iso(3 * H), lastEvidenceChangeAt: iso(6 * 24 * H) }));
    expect(p.state).toBe('quiet');
    expect(p.stateSince).toBe(iso(3 * H));
  });
  it('an item the owner checked is not open', () => {
    const r = proj({ doneDefinition: [{ id: 'j', text: 'Looks right', kind: 'judgment', certify: 'owner-confirms' }], doneItems: {}, ownerChecks: { j: { at: iso(H), who: 'owner' } } });
    expect(row(r).state).toBe('quiet');
    expect(row({ ...r, ownerChecks: {} }).state).toBe('stalled');
  });
  it('stays unknown only when the check could not read, and says why', () => {
    expect(row(proj({ lastCheckUnreadable: true }))).toMatchObject({ state: 'unknown', stateWords: "Couldn't check: the last check could not read the project's evidence", stateSince: null });
    expect(row(proj({ lastCheckAt: null }))).toMatchObject({ state: 'unknown', stateWords: 'Not checked yet: the first check runs on the next round' });
    expect(row(proj({ lastCheckAt: iso(47 * H) })).state).toBe('stalled');
    expect(row(proj({ lastCheckAt: iso(48 * H) }))).toMatchObject({ state: 'unknown', stateWords: "Couldn't check: no check has run since Nov 17" });
    expect(row(proj({ lastEvidenceChangeAt: null }))).toMatchObject({ state: 'unknown', stateWords: "Couldn't check: no check has been able to read the project's evidence" });
  });
  it('an older loop that sends none of the new facts keeps the old words', () => {
    const old = proj(); delete old.lastEvidenceChangeAt; delete old.lastProgressAt; delete old.lastCheckUnreadable; delete old.cadenceHours;
    expect(row(old)).toMatchObject({ state: 'unknown', stateWords: PROJECT_STATE_WORDS.unknown, stateSince: null });
  });
  it('leaves every other state as it was, and dates the judge\'s own stalled', () => {
    for (const [verdict, state] of [['moving', 'moving'], ['waiting-on-user', 'waiting-on-you'], ['claims-done', 'claims-done'], ['drifting', 'drifting'], ['done-verified', 'done']] as const) {
      expect(row(proj({ lastVerdict: verdict }))).toMatchObject({ state, stateWords: PROJECT_STATE_WORDS[state], stateSince: null });
    }
    expect(row(proj({ lastVerdict: 'unknown', pausedBy: { who: 'owner', at: iso(H), quote: 'hold it', messageRef: 'telegram:1:2' } })).state).toBe('paused');
    expect(row(proj({ lastVerdict: 'unknown', parked: true })).state).toBe('stopped-retrying');
    expect(row(proj({ lastVerdict: 'stalled' }))).toMatchObject({ state: 'stalled', stateWords: 'Stalled since Nov 13' });
    expect(settleState(proj({ lastVerdict: 'stalled', lastEvidenceChangeAt: null }), 'stalled', [], ctx).stateWords).toBe('Stalled');
  });
  it('sorts quiet after moving and before unknown', () => {
    const a = composeProjects([
      proj({ conversationKey: 'telegram:1', title: 'U', lastCheckUnreadable: true }),
      proj({ conversationKey: 'telegram:2', title: 'Q', lastEvidenceChangeAt: iso(H) }),
      proj({ conversationKey: 'telegram:3', title: 'M', lastVerdict: 'moving' }),
      proj({ conversationKey: 'telegram:4', title: 'S' }),
    ], null, ctx);
    expect(a.projects.map((p) => p.state)).toEqual(['stalled', 'moving', 'quiet', 'unknown']);
  });
});

describe('projectsOverview feeds the settled state (real loop, in-memory journal)', () => {
  const CK = 'telegram:138345';
  function setup() {
    const entries: UnionEntry[] = []; let clock = 1;
    const emit = (recordKey: string, build: (hlc: HlcTimestamp, origin: string) => Record<string, unknown> | null) => {
      const hlc: HlcTimestamp = { physical: ++clock, logical: 0, node: 'm_self' };
      const data = build(hlc, 'm_self'); if (!data) return { outcome: 'dropped' };
      const v = chiefOfStaffRecordStoreSchema.validate(data, { countDroppedField: () => {}, countJailReject: () => {} } as never);
      if (!v) throw new Error(`schema refused ${recordKey}`);
      entries.push({ data: { ...v, recordKey, hlc, op: 'put', origin: 'm_self' }, origin: 'm_self' }); return { outcome: 'emitted', seq: clock };
    };
    const cfg = clampLoopConfig({ ...CHIEF_OF_STAFF_LOOP_DEFAULTS });
    const loop = new ChiefOfStaffLoop({
      now: () => NOW, machineId: 'm_self', enabled: () => true, holdsLease: () => true, config: () => cfg,
      journal: { emit, loadUnion: () => entries.slice(), awaitDurable: async () => {} }, verifyRenewal: () => true,
      gather: async () => { throw new Error('not used'); }, judge: async () => null,
      protocol: {} as ChiefOfStaffLoopDeps['protocol'], mirrorInitiativeStatus: () => {}, sendNote: async () => {}, sendImmediate: async () => {}, statusUrl: () => null, localHour: () => 3, sign: (c) => `sig:${c.length}`,
    } as unknown as ChiefOfStaffLoopDeps);
    emit(`binding:${CK}`, buildBindingPut({ conversationKey: CK, goal: 'Locked-screen support on every Mac.', checkCadenceHours: 24, doneDefinition: [{ id: 'a', kind: 'deterministic', text: 'The six in-person tests pass.' }], linked: { repos: [], branches: [] }, confirmedBy: 'owner', confirmedAt: iso(7 * 24 * H) } as never));
    const check = (msAgo: number, hash: string, note: string) => emit(`check:${msAgo}`, buildCheckEvent({ conversationKey: CK, verdict: 'unknown', evidenceHash: hash, evidenceIds: ['run'], progressSeen: false, netDiffHighWater: 0, machine: 'm_self', at: iso(msAgo), note, doneItems: { a: 'unknown' } }));
    return { loop, check };
  }
  it('a check that read the same evidence for days reads Stalled since the day it last changed', () => {
    const { loop, check } = setup();
    check(6 * 24 * H, 'a'.repeat(64), 'Both completion checks are unreadable.');
    for (const d of [5, 4, 3, 2, 1]) check(d * 24 * H, 'a'.repeat(64), 'no new evidence');
    const o = loop.projectsOverview()!;
    expect(o[0]).toMatchObject({ lastEvidenceChangeAt: iso(6 * 24 * H), lastCheckUnreadable: false, lastProgressAt: null, cadenceHours: 24 });
    const p = composeProjects(o, null, ctx).projects[0]!;
    expect(p).toMatchObject({ state: 'stalled', stateWords: 'Stalled since Nov 13', stateSince: iso(6 * 24 * H) });
  });
  it('new evidence yesterday reads Quiet since yesterday', () => {
    const { loop, check } = setup();
    check(3 * 24 * H, 'a'.repeat(64), 'judged');
    check(24 * H, 'b'.repeat(64), 'The conversation reports a fix awaiting tests.');
    check(H, 'b'.repeat(64), 'no new evidence');
    expect(composeProjects(loop.projectsOverview()!, null, ctx).projects[0]).toMatchObject({ state: 'quiet', stateWords: 'Quiet since yesterday', stateSince: iso(24 * H) });
  });
  it('checks that stopped landing read Couldn\'t check, never Stalled from old reads', () => {
    const { loop, check } = setup();
    check(6 * 24 * H, 'a'.repeat(64), 'judged');
    check(3 * 24 * H, 'a'.repeat(64), 'no new evidence');
    expect(composeProjects(loop.projectsOverview()!, null, ctx).projects[0]).toMatchObject({ state: 'unknown', stateWords: "Couldn't check: no check has run since Nov 16" });
  });
});
