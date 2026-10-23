import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DarkFlagMaturationRegistry,
  classifyDarkFlag,
  daysBetween,
  isDarkSubject,
  reconcileDarkFlagEntries,
  type DarkFlagEntry,
  type DarkFlagOwner,
} from '../../src/monitoring/DarkFlagMaturationRegistry.js';
import type { GuardEffectiveState, GuardOffClass, GuardRow } from '../../src/monitoring/guardPostureView.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const MACHINE = 'm_test_machine';

function row(
  key: string,
  effective: GuardEffectiveState,
  offClass: GuardOffClass = null,
  extra: Partial<GuardRow> = {},
): GuardRow {
  return {
    key,
    configEnabled: null,
    defaultEnabled: null,
    effective,
    offClass,
    divergence: 'none',
    runtime: null,
    process: 'server',
    ...extra,
  } as GuardRow;
}

const WINDOW = () => ({ tier: 'standard' as const, windowDays: 7 });
const NO_PROOF = () => undefined;
const PROVEN = () => 5;
const NO_OWNER: () => DarkFlagOwner = () => null;
const AGENT_OWNER: () => DarkFlagOwner = () => 'agent';

function reconcile(opts: {
  rows: GuardRow[];
  existing?: Record<string, DarkFlagEntry>;
  firstRegistration?: boolean;
  now: Date;
  proofCountFor?: () => number | undefined;
  ownerFor?: () => DarkFlagOwner;
  supersededBy?: Record<string, string>;
}) {
  return reconcileDarkFlagEntries({
    rows: opts.rows,
    existing: opts.existing ?? {},
    firstRegistration: opts.firstRegistration ?? false,
    now: opts.now,
    windowFor: WINDOW,
    proofCountFor: opts.proofCountFor ?? NO_PROOF,
    minProof: 1,
    ownerFor: opts.ownerFor ?? NO_OWNER,
    ...(opts.supersededBy ? { supersededBy: opts.supersededBy } : {}),
  });
}

describe('isDarkSubject — the dark set, both sides of every edge', () => {
  it('counts a dry-run guard as dark (on but toothless)', () => {
    expect(isDarkSubject(row('a', 'on-dry-run'))).toBe(true);
  });

  it('counts an off/dark-default guard as dark (ships dark)', () => {
    expect(isDarkSubject(row('a', 'off', 'dark-default'))).toBe(true);
  });

  it('counts an off/diverged-from-default guard as dark (the load-shed signature)', () => {
    expect(isDarkSubject(row('a', 'off', 'diverged-from-default'))).toBe(true);
  });

  it('does NOT count a confirmed-on guard', () => {
    expect(isDarkSubject(row('a', 'on-confirmed'))).toBe(false);
  });

  it('does NOT count states that merely fail to prove protection', () => {
    for (const s of ['missing', 'errored', 'diverged-pending-restart', 'off-runtime-divergent'] as GuardEffectiveState[]) {
      expect(isDarkSubject(row('a', s))).toBe(false);
    }
  });
});

describe('classifyDarkFlag — proof honesty', () => {
  const anchor = '2026-01-01T00:00:00.000Z';

  it('is incubating inside its window', () => {
    expect(classifyDarkFlag(anchor, 7, 'unknown', new Date('2026-01-04T00:00:00.000Z'), false)).toBe('incubating');
  });

  it('marks the window elapsed when it expired AND the flag is proved', () => {
    expect(classifyDarkFlag(anchor, 7, true, new Date('2026-01-09T00:00:00.000Z'), false)).toBe('window-elapsed');
  });

  it('is expired-unproven when the window expired and it is NOT proved', () => {
    expect(classifyDarkFlag(anchor, 7, false, new Date('2026-01-09T00:00:00.000Z'), false)).toBe('expired-unproven');
  });

  it("NEVER reaches window-elapsed on 'unknown' proof — unknown is not proved", () => {
    expect(classifyDarkFlag(anchor, 7, 'unknown', new Date('2026-06-01T00:00:00.000Z'), false)).toBe('expired-unproven');
  });

  it('expires exactly AT the window boundary, not after it', () => {
    expect(classifyDarkFlag(anchor, 7, false, new Date('2026-01-08T00:00:00.000Z'), false)).toBe('expired-unproven');
    expect(classifyDarkFlag(anchor, 7, false, new Date('2026-01-07T23:59:59.000Z'), false)).toBe('incubating');
  });

  it('a legacy entry is overdue immediately — never incubating', () => {
    expect(classifyDarkFlag(anchor, 7, 'unknown', new Date(anchor), true)).toBe('legacy-unproven');
  });

  it('a legacy entry can still reach window-elapsed once genuinely proved', () => {
    expect(classifyDarkFlag(anchor, 7, true, new Date(anchor), true)).toBe('window-elapsed');
  });
});

describe('daysBetween', () => {
  it('returns fractional days', () => {
    expect(daysBetween('2026-01-01T00:00:00.000Z', new Date('2026-01-02T12:00:00.000Z'))).toBeCloseTo(1.5, 5);
  });

  it('returns 0 for an unparseable instant rather than NaN', () => {
    expect(daysBetween('not-a-date', new Date('2026-01-02T00:00:00.000Z'))).toBe(0);
  });
});

describe('migration — a pre-existing dark flag is NOT handed a clean window', () => {
  const now = new Date('2026-03-01T00:00:00.000Z');

  it('classifies first-registration dark flags as legacy-unproven, un-owned and already overdue', () => {
    const { entries } = reconcile({
      rows: [row('monitoring.alpha.enabled', 'off', 'dark-default')],
      firstRegistration: true,
      now,
      ownerFor: AGENT_OWNER, // even with an owner source, legacy stays un-owned
    });
    const e = entries['monitoring.alpha.enabled'];
    expect(e.state).toBe('legacy-unproven');
    expect(e.legacyAtRegistration).toBe(true);
    expect(e.owner).toBeNull();
    expect(e.deadline).toBe(e.firstObservedDarkAt); // overdue by construction
    expect(e.history).toHaveLength(1);
    expect(e.history[0].reason).toMatch(/unanchorable/);
  });

  it('a flag first seen dark AFTER registration does get a real window and its derived owner', () => {
    const { entries } = reconcile({
      rows: [row('monitoring.beta.enabled', 'on-dry-run')],
      firstRegistration: false,
      now,
      ownerFor: AGENT_OWNER,
    });
    const e = entries['monitoring.beta.enabled'];
    expect(e.state).toBe('incubating');
    expect(e.legacyAtRegistration).toBeUndefined();
    expect(e.owner).toBe('agent');
    expect(new Date(e.deadline).getTime()).toBe(new Date(e.firstObservedDarkAt).getTime() + 7 * 86_400_000);
  });
});

describe('deadlines are monotonic — a flapping guard cannot escape its finding', () => {
  it('does not reset firstObservedDarkAt or deadline when a guard re-enters the dark set', () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const first = reconcile({ rows: [row('g', 'on-dry-run')], now: t0 });
    const anchor = first.entries.g.firstObservedDarkAt;
    const deadline = first.entries.g.deadline;

    // Graduates away from dark...
    const t1 = new Date('2026-01-03T00:00:00.000Z');
    const grad = reconcile({ rows: [row('g', 'on-confirmed')], existing: first.entries, now: t1 });
    expect(grad.entries.g.state).toBe('graduated');

    // ...then falls back to dark much later. The window CONTINUES.
    const t2 = new Date('2026-02-01T00:00:00.000Z');
    const back = reconcile({ rows: [row('g', 'on-dry-run')], existing: grad.entries, now: t2 });
    expect(back.entries.g.firstObservedDarkAt).toBe(anchor);
    expect(back.entries.g.deadline).toBe(deadline);
    expect(back.entries.g.state).toBe('expired-unproven'); // NOT incubating
    expect(back.entries.g.history.at(-1)!.reason).toMatch(/original window continues/);
  });

  it('a guard toggling repeatedly still expires on its ORIGINAL anchor', () => {
    let entries: Record<string, DarkFlagEntry> = {};
    let day = 1;
    const at = (d: number) => new Date(Date.UTC(2026, 0, d));
    entries = reconcile({ rows: [row('g', 'on-dry-run')], now: at(day) }).entries;
    const anchor = entries.g.firstObservedDarkAt;
    for (let i = 0; i < 6; i++) {
      day += 1;
      entries = reconcile({ rows: [row('g', 'on-confirmed')], existing: entries, now: at(day) }).entries;
      day += 1;
      entries = reconcile({ rows: [row('g', 'on-dry-run')], existing: entries, now: at(day) }).entries;
    }
    expect(entries.g.firstObservedDarkAt).toBe(anchor);
    expect(entries.g.state).toBe('expired-unproven');
  });
});

describe('the stored deadline never disagrees with the window the classifier uses', () => {
  const t0 = new Date('2026-01-01T00:00:00.000Z');

  it('extends the stored deadline when the window widens, and never shortens it', () => {
    const first = reconcileDarkFlagEntries({
      rows: [row('g', 'on-dry-run')],
      existing: {},
      firstRegistration: false,
      now: t0,
      windowFor: () => ({ tier: 'standard', windowDays: 7 }),
      proofCountFor: NO_PROOF,
      minProof: 1,
      ownerFor: NO_OWNER,
    });
    expect(first.entries.g.deadline).toBe('2026-01-08T00:00:00.000Z');

    // Window WIDENS (the guard became load-bearing → highRisk tier).
    const widened = reconcileDarkFlagEntries({
      rows: [row('g', 'on-dry-run', null, { loadBearing: true })],
      existing: first.entries,
      firstRegistration: false,
      now: new Date('2026-01-02T00:00:00.000Z'),
      windowFor: () => ({ tier: 'highRisk', windowDays: 30 }),
      proofCountFor: NO_PROOF,
      minProof: 1,
      ownerFor: NO_OWNER,
    });
    expect(widened.entries.g.deadline).toBe('2026-01-31T00:00:00.000Z');
    expect(widened.entries.g.windowDays).toBe(30);

    // Window NARROWS — the stored deadline must NOT move earlier.
    const narrowed = reconcileDarkFlagEntries({
      rows: [row('g', 'on-dry-run')],
      existing: widened.entries,
      firstRegistration: false,
      now: new Date('2026-01-03T00:00:00.000Z'),
      windowFor: () => ({ tier: 'standard', windowDays: 1 }),
      proofCountFor: NO_PROOF,
      minProof: 1,
      ownerFor: NO_OWNER,
    });
    expect(narrowed.entries.g.deadline).toBe('2026-01-31T00:00:00.000Z');
  });

  it('leaves a legacy entry\'s overdue deadline alone — it is overdue by construction', () => {
    const first = reconcileDarkFlagEntries({
      rows: [row('g', 'on-dry-run')],
      existing: {},
      firstRegistration: true,
      now: t0,
      windowFor: () => ({ tier: 'standard', windowDays: 7 }),
      proofCountFor: NO_PROOF,
      minProof: 1,
      ownerFor: NO_OWNER,
    });
    expect(first.entries.g.deadline).toBe(first.entries.g.firstObservedDarkAt);
    const again = reconcileDarkFlagEntries({
      rows: [row('g', 'on-dry-run')],
      existing: first.entries,
      firstRegistration: false,
      now: new Date('2026-01-05T00:00:00.000Z'),
      windowFor: () => ({ tier: 'highRisk', windowDays: 30 }),
      proofCountFor: NO_PROOF,
      minProof: 1,
      ownerFor: NO_OWNER,
    });
    expect(again.entries.g.deadline).toBe(first.entries.g.firstObservedDarkAt);
  });
});

describe('graduation is only claimed for a genuinely-on state', () => {
  const t0 = new Date('2026-01-01T00:00:00.000Z');
  const t1 = new Date('2026-01-02T00:00:00.000Z');

  it.each(['on-confirmed', 'on-unverified', 'on-stale', 'on-blind'] as GuardEffectiveState[])(
    'graduates on %s and records the exact state it left as',
    (state) => {
      const first = reconcile({ rows: [row('g', 'on-dry-run')], now: t0 });
      const next = reconcile({ rows: [row('g', state)], existing: first.entries, now: t1 });
      expect(next.entries.g.state).toBe('graduated');
      expect(next.entries.g.graduatedAtState).toBe(state);
    },
  );

  it.each(['missing', 'errored', 'diverged-pending-restart', 'off-runtime-divergent'] as GuardEffectiveState[])(
    'does NOT graduate on %s — it proves nothing',
    (state) => {
      const first = reconcile({ rows: [row('g', 'on-dry-run')], now: t0 });
      const next = reconcile({ rows: [row('g', state)], existing: first.entries, now: t1 });
      expect(next.entries.g.state).toBe('incubating'); // unchanged
      expect(next.entries.g.graduatedAtState).toBeUndefined();
      expect(next.entries.g.lastObservedState).toBe(state); // but the sighting IS recorded
    },
  );
});

describe('nothing is silently dropped', () => {
  const t0 = new Date('2026-01-01T00:00:00.000Z');
  const t1 = new Date('2026-01-10T00:00:00.000Z');

  it('tombstones a vanished guard as killed and RETAINS its history', () => {
    const first = reconcile({ rows: [row('gone', 'on-dry-run')], now: t0 });
    const next = reconcile({ rows: [], existing: first.entries, now: t1 });
    expect(next.entries.gone).toBeDefined();
    expect(next.entries.gone.state).toBe('killed');
    expect(next.entries.gone.lastObservedState).toBe('absent');
    expect(next.entries.gone.history.map((h) => h.to)).toEqual(['incubating', 'killed']);
  });

  it('tombstones a renamed guard as superseded and names its successor', () => {
    const first = reconcile({ rows: [row('old', 'on-dry-run')], now: t0 });
    const next = reconcile({ rows: [], existing: first.entries, now: t1, supersededBy: { old: 'new' } });
    expect(next.entries.old.state).toBe('superseded');
    expect(next.entries.old.history.at(-1)!.reason).toMatch(/superseded by new/);
  });

  it('does not re-tombstone an already-tombstoned entry on every tick', () => {
    const first = reconcile({ rows: [row('gone', 'on-dry-run')], now: t0 });
    const second = reconcile({ rows: [], existing: first.entries, now: t1 });
    const third = reconcile({ rows: [], existing: second.entries, now: new Date('2026-01-11T00:00:00.000Z') });
    expect(third.entries.gone.history).toHaveLength(2);
    expect(third.changed).toBe(false);
  });

  it('a guard that is not dark and was never tracked is simply not recorded', () => {
    const { entries } = reconcile({ rows: [row('healthy', 'on-confirmed')], now: t0 });
    expect(Object.keys(entries)).toHaveLength(0);
  });
});

describe('history appends only on real state changes', () => {
  it('re-running on an unchanged inventory appends nothing and reports no change', () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const first = reconcile({ rows: [row('g', 'on-dry-run')], now: t0 });
    const again = reconcile({
      rows: [row('g', 'on-dry-run')],
      existing: first.entries,
      now: new Date('2026-01-02T00:00:00.000Z'),
    });
    expect(again.entries.g.history).toHaveLength(1);
    expect(again.changed).toBe(false);
  });

  it('records the transition when the window closes', () => {
    const first = reconcile({ rows: [row('g', 'on-dry-run')], now: new Date('2026-01-01T00:00:00.000Z') });
    const later = reconcile({
      rows: [row('g', 'on-dry-run')],
      existing: first.entries,
      now: new Date('2026-01-20T00:00:00.000Z'),
    });
    expect(later.entries.g.state).toBe('expired-unproven');
    expect(later.entries.g.history.map((h) => h.to)).toEqual(['incubating', 'expired-unproven']);
    expect(later.changed).toBe(true);
  });
});

describe('proof-of-life is honest', () => {
  const now = new Date('2026-01-20T00:00:00.000Z');

  it("reports 'unknown' and omits proofCount when no evidence source is wired", () => {
    const { entries } = reconcile({ rows: [row('g', 'on-dry-run')], now, proofCountFor: NO_PROOF });
    expect(entries.g.proofOfLife).toBe('unknown');
    expect(entries.g.proofCount).toBeUndefined();
  });

  it('reports proved + the count when the feature genuinely fired', () => {
    const { entries } = reconcile({ rows: [row('g', 'on-dry-run')], now, proofCountFor: PROVEN });
    expect(entries.g.proofOfLife).toBe(true);
    expect(entries.g.proofCount).toBe(5);
  });

  it('reports NOT proved when the count is below the minimum', () => {
    const { entries } = reconcile({ rows: [row('g', 'on-dry-run')], now, proofCountFor: () => 0 });
    expect(entries.g.proofOfLife).toBe(false);
  });
});

describe('G3 composition — load-bearing metadata is mirrored, not re-derived', () => {
  it('carries loadBearing and criticalPath through from the guard row', () => {
    const { entries } = reconcile({
      rows: [row('g', 'on-dry-run', null, { loadBearing: true, criticalPath: 'operator inbound delivery' })],
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(entries.g.loadBearing).toBe(true);
    expect(entries.g.criticalPath).toBe('operator inbound delivery');
  });

  it('drops the flags when the manifest stops declaring them', () => {
    const first = reconcile({
      rows: [row('g', 'on-dry-run', null, { loadBearing: true, criticalPath: 'x' })],
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    const next = reconcile({
      rows: [row('g', 'on-dry-run')],
      existing: first.entries,
      now: new Date('2026-01-02T00:00:00.000Z'),
    });
    expect(next.entries.g.loadBearing).toBeUndefined();
    expect(next.entries.g.criticalPath).toBeUndefined();
  });
});

describe('an un-owned entry adopts an owner once one becomes derivable', () => {
  it('fills in a later-derivable owner for a non-legacy entry', () => {
    const first = reconcile({ rows: [row('g', 'on-dry-run')], now: new Date('2026-01-01T00:00:00.000Z'), ownerFor: NO_OWNER });
    expect(first.entries.g.owner).toBeNull();
    const next = reconcile({
      rows: [row('g', 'on-dry-run')],
      existing: first.entries,
      now: new Date('2026-01-02T00:00:00.000Z'),
      ownerFor: AGENT_OWNER,
    });
    expect(next.entries.g.owner).toBe('agent');
  });

  it('leaves a LEGACY entry un-owned so it stays a surfaced finding', () => {
    const first = reconcile({
      rows: [row('g', 'on-dry-run')],
      firstRegistration: true,
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    const next = reconcile({
      rows: [row('g', 'on-dry-run')],
      existing: first.entries,
      now: new Date('2026-01-02T00:00:00.000Z'),
      ownerFor: AGENT_OWNER,
    });
    expect(next.entries.g.owner).toBeNull();
  });
});

describe('DarkFlagMaturationRegistry — durability and machine locality', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dark-flag-reg-'));
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/DarkFlagMaturationRegistry.test.ts' });
  });

  const mk = (onError?: (w: string, e: unknown) => void) =>
    new DarkFlagMaturationRegistry({ stateDir: dir, machineId: MACHINE, ...(onError ? { onError } : {}) });

  it('reports first-run for a missing file', () => {
    const r = mk().load();
    expect(r.entries).toEqual({});
    expect(r.firstRegistration).toBe(true);
    expect(r.foreign).toBe(false);
  });

  it('round-trips entries through disk', () => {
    const reg = mk();
    const written = reg.reconcile({
      rows: [row('monitoring.x.enabled', 'on-dry-run')],
      now: new Date('2026-01-01T00:00:00.000Z'),
      windowFor: WINDOW,
      proofCountFor: NO_PROOF,
      minProof: 1,
      ownerFor: AGENT_OWNER,
    });
    expect(written).toHaveLength(1);
    expect(fs.existsSync(reg.path)).toBe(true);
    const reread = mk().load();
    expect(reread.firstRegistration).toBe(false);
    expect(reread.entries['monitoring.x.enabled'].guardKey).toBe('monitoring.x.enabled');
  });

  it('stamps the file with this machine id', () => {
    const reg = mk();
    reg.save({});
    expect(JSON.parse(fs.readFileSync(reg.path, 'utf-8')).machineId).toBe(MACHINE);
  });

  it("refuses to merge another machine's registry and says so", () => {
    const reg = mk();
    fs.writeFileSync(
      reg.path,
      JSON.stringify({ version: 1, machineId: 'm_someone_else', entries: { g: { guardKey: 'g' } } }),
    );
    const errs: string[] = [];
    const r = new DarkFlagMaturationRegistry({
      stateDir: dir,
      machineId: MACHINE,
      onError: (where, err) => errs.push(`${where}:${String(err)}`),
    }).load();
    expect(r.entries).toEqual({});
    expect(r.foreign).toBe(true);
    expect(r.firstRegistration).toBe(true);
    expect(errs.join()).toMatch(/m_someone_else/);
  });

  it('treats a corrupt file as empty (the safe direction) and reports it', () => {
    const reg = mk();
    fs.writeFileSync(reg.path, '{ not json');
    const errs: string[] = [];
    const r = new DarkFlagMaturationRegistry({
      stateDir: dir,
      machineId: MACHINE,
      onError: (where) => errs.push(where),
    }).load();
    expect(r.entries).toEqual({});
    expect(r.firstRegistration).toBe(true);
    expect(errs).toContain('parse');
  });

  it('a corrupt registry re-anchors as LEGACY rather than granting a fresh window', () => {
    const reg = mk();
    fs.writeFileSync(reg.path, '{ not json');
    const entries = reg.reconcile({
      rows: [row('monitoring.x.enabled', 'on-dry-run')],
      now: new Date('2026-01-01T00:00:00.000Z'),
      windowFor: WINDOW,
      proofCountFor: NO_PROOF,
      minProof: 1,
      ownerFor: AGENT_OWNER,
    });
    expect(entries[0].state).toBe('legacy-unproven');
  });

  it('a saved-but-EMPTY registry is not first-run — a flag appearing later is genuinely new', () => {
    const reg = mk();
    // Pass 1: we were watching, and nothing was dark. An empty registry is saved.
    reg.reconcile({
      rows: [],
      now: new Date('2026-01-01T00:00:00.000Z'),
      windowFor: WINDOW,
      proofCountFor: NO_PROOF,
      minProof: 1,
      ownerFor: AGENT_OWNER,
    });
    expect(fs.existsSync(reg.path)).toBe(true);
    expect(mk().load().firstRegistration).toBe(false);

    // Pass 2: a NEW flag ships dark. It must get a real incubation window and
    // its derived owner — NOT be stamped as pre-existing backlog.
    const entries = mk().reconcile({
      rows: [row('monitoring.brand-new.enabled', 'on-dry-run')],
      now: new Date('2026-01-02T00:00:00.000Z'),
      windowFor: WINDOW,
      proofCountFor: NO_PROOF,
      minProof: 1,
      ownerFor: AGENT_OWNER,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].state).toBe('incubating');
    expect(entries[0].legacyAtRegistration).toBeUndefined();
    expect(entries[0].owner).toBe('agent');
  });

  it('a file whose entries map is missing entirely IS treated as never-registered', () => {
    const reg = mk();
    fs.writeFileSync(reg.path, JSON.stringify({ version: 1, machineId: MACHINE }));
    expect(mk().load().firstRegistration).toBe(true);
  });

  it('persists on the first run even when nothing changed, so the anchor survives a restart', () => {
    const reg = mk();
    reg.reconcile({
      rows: [],
      now: new Date('2026-01-01T00:00:00.000Z'),
      windowFor: WINDOW,
      proofCountFor: NO_PROOF,
      minProof: 1,
      ownerFor: NO_OWNER,
    });
    expect(fs.existsSync(reg.path)).toBe(true);
  });
});
