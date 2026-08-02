import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ActionItem } from '../../src/core/types.js';
import {
  UndatedActionResurfacer,
  resolveUndatedActionStateAuthority,
  selectUndatedAction,
  type UndatedActionProjection,
} from '../../src/monitoring/UndatedActionResurfacer.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/UndatedActionResurfacer.test.ts' });
});

function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'undated-actions-'));
  made.push(dir);
  return dir;
}

function action(id: string, priority: ActionItem['priority'], createdAt: string, extra: Partial<ActionItem> = {}): ActionItem {
  return { id, title: `title ${id}`, description: `description ${id}`, priority, status: 'pending', createdAt, ...extra };
}

function projection(id: string, lastEngagedAt: string): UndatedActionProjection {
  return {
    actionId: id, series: 1, firstRaisedAt: lastEngagedAt, lastRaisedAt: lastEngagedAt, lastEngagedAt,
    raiseCount: 1, disposition: null, observed: null, pendingClaim: null,
    failedClaim: false, retired: false, outcomeObservedClaims: new Set(),
  };
}

describe('selectUndatedAction', () => {
  const now = Date.parse('2026-08-01T00:00:00.000Z');

  it('uses 3 critical lanes then 1 high lane, with stable age/id ordering', () => {
    const rows = [
      action('ACT-003', 'critical', '2026-07-20T00:00:00.000Z'),
      action('ACT-002', 'critical', '2026-07-20T00:00:00.000Z'),
      action('ACT-001', 'high', '2026-07-21T00:00:00.000Z'),
    ];
    expect(selectUndatedAction(rows, new Map(), 1, now).selected?.id).toBe('ACT-002');
    expect(selectUndatedAction(rows, new Map(), 2, now).selected?.id).toBe('ACT-002');
    expect(selectUndatedAction(rows, new Map(), 3, now).selected?.id).toBe('ACT-002');
    expect(selectUndatedAction(rows, new Map(), 4, now).selected?.id).toBe('ACT-001');
  });

  it('promotes a high action older than 30 days into the critical lane', () => {
    const rows = [
      action('ACT-001', 'critical', '2026-07-20T00:00:00.000Z'),
      action('ACT-002', 'high', '2026-06-01T00:00:00.000Z'),
    ];
    expect(selectUndatedAction(rows, new Map(), 1, now).selected?.id).toBe('ACT-002');
  });

  it('keeps an explicit follow-through opt-out reachable', () => {
    const row = action('ACT-001', 'critical', '2026-07-20T00:00:00.000Z', {
      followThroughOptOutReason: 'No honest due date was available at filing time.',
    });
    expect(selectUndatedAction([row], new Map(), 1, now).selected?.id).toBe('ACT-001');
  });

  it('excludes dated, non-pending, low/medium, terminal, pending-claim, and cooldown rows', () => {
    const recent = new Map<string, UndatedActionProjection>([['ACT-001', projection('ACT-001', '2026-07-31T00:00:00.000Z')]]);
    const rows = [
      action('ACT-001', 'critical', '2026-07-01T00:00:00.000Z'),
      action('ACT-002', 'critical', '2026-07-01T00:00:00.000Z', { dueBy: '2026-09-01T00:00:00.000Z' }),
      action('ACT-003', 'critical', '2026-07-01T00:00:00.000Z', { status: 'completed' }),
      action('ACT-004', 'medium', '2026-07-01T00:00:00.000Z'),
    ];
    const out = selectUndatedAction(rows, recent, 1, now);
    expect(out.selected).toBeNull();
    expect(out.skippedCooldown).toBe(1);
  });
});

describe('UndatedActionResurfacer durable lifecycle', () => {
  it('binds multi-machine state to one pool-agreed stable owner across a serving-lease handoff', async () => {
    let now = Date.parse('2026-08-01T00:00:00.000Z');
    let aHoldsLease = true;
    const emitted: string[] = [];
    const dirA = temp();
    const dirB = temp();
    const rows = [action('ACT-001', 'critical', '2026-06-01T00:00:00.000Z')];
    const owner = new UndatedActionResurfacer(
      { enabled: true, dryRun: false, runIntervalMs: 60_000, cooldownMs: 120_000 },
      {
        stateDir: dirA, listActions: () => rows, emitAttention: async (item) => { emitted.push(item.id); },
        holdsLease: () => aHoldsLease, now: () => now,
        stateAuthority: () => ({ mode: 'stable-owner', selfMachineId: 'machine-a', ownerMachineId: 'machine-a', ownsState: true }),
      },
    );
    const newHolder = new UndatedActionResurfacer(
      { enabled: true, dryRun: false, runIntervalMs: 60_000, cooldownMs: 120_000 },
      {
        stateDir: dirB, listActions: () => rows, emitAttention: async (item) => { emitted.push(item.id); },
        holdsLease: () => !aHoldsLease, now: () => now,
        stateAuthority: () => ({ mode: 'stable-owner', selfMachineId: 'machine-b', ownerMachineId: 'machine-a', ownsState: false }),
      },
    );

    expect((await owner.run()).reason).toBe('emitted');
    aHoldsLease = false;
    now += 61_000;
    expect((await newHolder.run()).reason).toBe('not-state-owner');
    expect(newHolder.status().totalRuns).toBe(0);
    aHoldsLease = true;
    expect((await owner.run()).reason).toBe('no-eligible');
    expect(owner.status().lastRun?.skippedCooldown).toBe(1);
    expect(emitted).toEqual(['resurface:ACT-001:s1:1']);
  });

  it('fails closed through handoff and handback when local owner proposals diverge', async () => {
    let holder: 'machine-a' | 'machine-b' = 'machine-a';
    const emitted: string[] = [];
    const rows = [action('ACT-001', 'critical', '2026-06-01T00:00:00.000Z')];
    const adverts = [
      { machineId: 'machine-a', online: true, proposedOwnerMachineId: 'machine-a' },
      { machineId: 'machine-b', online: true, proposedOwnerMachineId: 'machine-b' },
    ];
    const machine = (selfMachineId: string, proposedOwnerMachineId: string) => new UndatedActionResurfacer(
      { enabled: true, dryRun: false },
      {
        stateDir: temp(), listActions: () => rows,
        emitAttention: async (item) => { emitted.push(item.id); },
        holdsLease: () => holder === selfMachineId,
        stateAuthority: () => resolveUndatedActionStateAuthority(selfMachineId, proposedOwnerMachineId, adverts),
      },
    );
    const a = machine('machine-a', 'machine-a');
    const b = machine('machine-b', 'machine-b');

    expect((await a.run()).reason).toBe('state-owner-unconfigured');
    holder = 'machine-b';
    expect((await b.run()).reason).toBe('state-owner-unconfigured');
    holder = 'machine-a';
    expect((await a.run()).reason).toBe('state-owner-unconfigured');
    expect(a.status().stateAuthority).toMatchObject({ agreement: 'disagreed', disagreeingMachineIds: ['machine-b'] });
    expect(b.status().stateAuthority).toMatchObject({ agreement: 'disagreed', disagreeingMachineIds: ['machine-a'] });
    expect(emitted).toEqual([]);
  });

  it('accepts a stable owner only after every registered pool member advertises agreement', () => {
    const pool = [
      { machineId: 'machine-a', online: true, proposedOwnerMachineId: 'machine-a' },
      { machineId: 'machine-b', online: true, proposedOwnerMachineId: 'machine-a' },
    ];
    expect(resolveUndatedActionStateAuthority('machine-a', 'machine-a', pool)).toMatchObject({
      mode: 'stable-owner', agreement: 'pool-agreed', ownsState: true,
    });
    expect(resolveUndatedActionStateAuthority('machine-b', 'machine-a', pool)).toMatchObject({
      mode: 'stable-owner', agreement: 'pool-agreed', ownsState: false,
    });
    expect(resolveUndatedActionStateAuthority('machine-a', 'machine-a', [
      pool[0], { machineId: 'machine-b', online: true, proposedOwnerMachineId: null },
    ])).toMatchObject({ mode: 'unconfigured', agreement: 'missing' });
    expect(resolveUndatedActionStateAuthority('machine-a', 'machine-a', [
      pool[0], { machineId: 'machine-b', online: false, proposedOwnerMachineId: 'machine-b' },
    ])).toMatchObject({ mode: 'unconfigured', agreement: 'disagreed' });
  });

  it('refuses a multi-machine run with no stable state owner configured', async () => {
    const r = new UndatedActionResurfacer(
      { enabled: true, dryRun: false },
      {
        stateDir: temp(), listActions: () => [action('ACT-001', 'critical', '2026-06-01T00:00:00.000Z')],
        emitAttention: async () => undefined, holdsLease: () => true,
        stateAuthority: () => ({ mode: 'unconfigured', selfMachineId: 'machine-a', ownerMachineId: null, ownsState: false }),
      },
    );
    expect((await r.run()).reason).toBe('state-owner-unconfigured');
    expect(r.status()).toMatchObject({ operational: false, blockedReason: 'state-owner-unconfigured', totalRuns: 0 });
  });

  it('keeps an unexpected run failure visible in status', async () => {
    const r = new UndatedActionResurfacer(
      { enabled: true, dryRun: false },
      {
        stateDir: temp(),
        listActions: () => { throw new Error('action store unavailable'); },
        emitAttention: async () => undefined,
        holdsLease: () => true,
      },
    );
    await expect(r.run()).rejects.toThrow('action store unavailable');
    expect(r.status()).toMatchObject({
      lastRunError: 'action store unavailable',
      lastAttempt: { ran: false, reason: 'run-error' },
    });
  });

  it('re-checks state ownership and lease immediately before external emission', async () => {
    let ownsState = true;
    let called = false;
    const r = new UndatedActionResurfacer(
      { enabled: true, dryRun: false },
      {
        stateDir: temp(),
        listActions: () => {
          ownsState = false; // simulates authority changing after the entry check
          return [action('ACT-001', 'critical', '2026-06-01T00:00:00.000Z')];
        },
        emitAttention: async () => { called = true; }, holdsLease: () => true,
        stateAuthority: () => ({ mode: 'stable-owner', selfMachineId: 'machine-a', ownerMachineId: 'machine-a', ownsState }),
      },
    );
    expect((await r.run()).reason).toBe('authority-lost');
    expect(called).toBe(false);
    expect(r.status().pendingClaims).toBe(1);
  });

  it('emits at most one row, records cooldown, and reaches needs-disposition on the third unchanged raise', async () => {
    let now = Date.parse('2026-08-01T00:00:00.000Z');
    const rows = [
      action('ACT-001', 'critical', '2026-06-01T00:00:00.000Z'),
      action('ACT-002', 'critical', '2026-06-02T00:00:00.000Z'),
    ];
    const emitted: string[] = [];
    const r = new UndatedActionResurfacer(
      { enabled: true, dryRun: false, cooldownMs: 120_000, runIntervalMs: 60_000, maxRaises: 3 },
      { stateDir: temp(), listActions: () => rows, emitAttention: async (i) => { emitted.push(i.id); }, holdsLease: () => true, now: () => now },
    );

    expect((await r.run()).selectedActionId).toBe('ACT-001');
    expect(emitted).toEqual(['resurface:ACT-001:s1:1']);
    // The next critical candidate can move, but the first row is cooling down.
    now += 61_000;
    expect((await r.run()).selectedActionId).toBe('ACT-002');
    expect(emitted).toHaveLength(2);
    now += 61_000;
    await r.run(); // ACT-001 raise 2
    now += 61_000;
    await r.run(); // ACT-002 raise 2
    now += 61_000;
    await r.run(); // ACT-001 raise 3
    expect(emitted.filter((id) => id.startsWith('resurface:ACT-001:'))).toEqual([
      'resurface:ACT-001:s1:1', 'resurface:ACT-001:s1:2', 'resurface:ACT-001:s1:3',
    ]);
    expect(r.status().needsDisposition).toBe(1);
  });

  it('two instances sharing the ledger cannot emit two rows during an overlapping run', async () => {
    const dir = temp();
    const rows = [action('ACT-001', 'critical', '2026-06-01T00:00:00.000Z')];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const emitted: string[] = [];
    const deps = { stateDir: dir, listActions: () => rows, holdsLease: () => true, now: () => Date.parse('2026-08-01T00:00:00.000Z') };
    const first = new UndatedActionResurfacer({ enabled: true, dryRun: false }, { ...deps, emitAttention: async (i) => { emitted.push(i.id); await held; } });
    const second = new UndatedActionResurfacer({ enabled: true, dryRun: false }, { ...deps, emitAttention: async (i) => { emitted.push(i.id); } });
    const p1 = first.run();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const p2 = await second.run();
    expect(p2.reason).toBe('cadence');
    expect(emitted).toEqual(['resurface:ACT-001:s1:1']);
    release();
    await p1;
  });

  it('keeps the global cadence floor across reconstruction', async () => {
    const dir = temp();
    const emitted: string[] = [];
    const deps = {
      stateDir: dir,
      listActions: () => [
        action('ACT-001', 'critical', '2026-06-01T00:00:00.000Z'),
        action('ACT-002', 'critical', '2026-06-02T00:00:00.000Z'),
      ],
      holdsLease: () => true,
      now: () => Date.parse('2026-08-01T00:00:00.000Z'),
      emitAttention: async (i: { id: string }) => { emitted.push(i.id); },
    };
    const first = new UndatedActionResurfacer({ enabled: true, dryRun: false, runIntervalMs: 60_000 }, deps);
    expect((await first.run()).reason).toBe('emitted');
    const reconstructed = new UndatedActionResurfacer({ enabled: true, dryRun: false, runIntervalMs: 60_000 }, deps);
    expect((await reconstructed.run()).reason).toBe('cadence');
    expect(emitted).toEqual(['resurface:ACT-001:s1:1']);
  });

  it('replays a failed pending emit with the same idempotency key after one interval', async () => {
    let now = Date.parse('2026-08-01T00:00:00.000Z');
    const ids: string[] = [];
    let fail = true;
    const r = new UndatedActionResurfacer(
      { enabled: true, dryRun: false, runIntervalMs: 60_000 },
      {
        stateDir: temp(), listActions: () => [action('ACT-001', 'critical', '2026-06-01T00:00:00.000Z')], holdsLease: () => true, now: () => now,
        emitAttention: async (i) => { ids.push(i.id); if (fail) throw new Error('simulated transport crash'); },
      },
    );
    expect((await r.run()).reason).toBe('emit-failed');
    fail = false;
    now += 61_000;
    expect((await r.run()).reason).toBe('replayed');
    expect(ids).toEqual(['resurface:ACT-001:s1:1', 'resurface:ACT-001:s1:1']);
    expect(r.status().pendingClaims).toBe(0);
  });

  it('abandons a stale pending claim instead of emitting after the action changes', async () => {
    let now = Date.parse('2026-08-01T00:00:00.000Z');
    const row = action('ACT-001', 'critical', '2026-06-01T00:00:00.000Z');
    const ids: string[] = [];
    let fail = true;
    const r = new UndatedActionResurfacer(
      { enabled: true, dryRun: false, runIntervalMs: 60_000 },
      {
        stateDir: temp(), listActions: () => [row], holdsLease: () => true, now: () => now,
        emitAttention: async (item) => { ids.push(item.id); if (fail) throw new Error('first transport failure'); },
      },
    );
    expect((await r.run()).reason).toBe('emit-failed');
    row.title = 'meaningfully revised before retry';
    fail = false;
    now += 61_000;
    expect((await r.run()).reason).toBe('no-eligible');
    expect(ids).toEqual(['resurface:ACT-001:s1:1']);
    expect(r.status()).toMatchObject({ pendingClaims: 0, abandonedClaims: 1 });
  });

  it('bounds a persistently failing delivery at three attempts', async () => {
    let now = Date.parse('2026-08-01T00:00:00.000Z');
    const ids: string[] = [];
    const r = new UndatedActionResurfacer(
      { enabled: true, dryRun: false, runIntervalMs: 60_000 },
      {
        stateDir: temp(), listActions: () => [action('ACT-001', 'critical', '2026-06-01T00:00:00.000Z')], holdsLease: () => true, now: () => now,
        emitAttention: async (i) => { ids.push(i.id); throw new Error('still unavailable'); },
      },
    );
    expect((await r.run()).reason).toBe('emit-failed');
    now += 61_000;
    expect((await r.run()).reason).toBe('emit-failed');
    now += 61_000;
    expect((await r.run()).reason).toBe('emit-failed');
    expect(ids).toEqual(['resurface:ACT-001:s1:1', 'resurface:ACT-001:s1:1', 'resurface:ACT-001:s1:1']);
    expect(r.status().pendingClaims).toBe(0);
    expect((await r.run()).reason).toBe('no-eligible');
  });

  it('resets the raise series after a meaningful content change', async () => {
    let now = Date.parse('2026-08-01T00:00:00.000Z');
    const row = action('ACT-001', 'critical', '2026-06-01T00:00:00.000Z');
    const ids: string[] = [];
    const r = new UndatedActionResurfacer(
      { enabled: true, dryRun: false, cooldownMs: 60_000, runIntervalMs: 60_000 },
      { stateDir: temp(), listActions: () => [row], holdsLease: () => true, now: () => now, emitAttention: async (i) => { ids.push(i.id); } },
    );
    await r.run();
    row.title = 'materially revised action';
    now += 61_000;
    expect((await r.run()).reason).toBe('no-eligible');
    now += 61_000;
    expect((await r.run()).reason).toBe('emitted');
    expect(ids).toEqual(['resurface:ACT-001:s1:1', 'resurface:ACT-001:s2:1']);
  });

  it('keeps a prior emitted claim scheduled for outcome observation across a meaningful edit', async () => {
    let now = Date.parse('2026-08-01T00:00:00.000Z');
    const row = action('ACT-001', 'critical', '2026-06-01T00:00:00.000Z');
    const r = new UndatedActionResurfacer(
      { enabled: true, dryRun: false, cooldownMs: 120_000, runIntervalMs: 60_000 },
      { stateDir: temp(), listActions: () => [row], holdsLease: () => true, now: () => now, emitAttention: async () => undefined },
    );
    await r.run();
    row.title = 'meaningful edit before the outcome window';
    now += 61_000;
    await r.run();
    expect(r.status().outcomesObserved).toBe(0);

    now += 61_000;
    await r.run();
    expect(r.status()).toMatchObject({
      outcomesObserved: 1,
      lastOutcome: { actionId: 'ACT-001', statusAt14d: 'pending' },
    });
  });

  it('records the delayed outcome before retiring an action that left pending', async () => {
    let now = Date.parse('2026-08-01T00:00:00.000Z');
    const row = action('ACT-001', 'critical', '2026-06-01T00:00:00.000Z');
    const r = new UndatedActionResurfacer(
      { enabled: true, dryRun: false, cooldownMs: 60_000, runIntervalMs: 60_000 },
      { stateDir: temp(), listActions: () => [row], holdsLease: () => true, now: () => now, emitAttention: async () => undefined },
    );
    await r.run();
    row.status = 'completed';
    now += 61_000;
    expect((await r.run()).reason).toBe('no-eligible');
    expect(r.status()).toMatchObject({
      outcomesObserved: 1,
      outcomesByStatus: { completed: 1 },
      lastOutcome: { actionId: 'ACT-001', statusAt14d: 'completed' },
      actionStates: [{ actionId: 'ACT-001', ageAtFirstRaiseDays: 61, lastOutcomeStatus: 'completed', retired: true }],
    });
  });

  it('observes the delayed outcome even when the action retired before the observation window', async () => {
    let now = Date.parse('2026-08-01T00:00:00.000Z');
    const row = action('ACT-001', 'critical', '2026-06-01T00:00:00.000Z');
    const r = new UndatedActionResurfacer(
      { enabled: true, dryRun: false, cooldownMs: 120_000, runIntervalMs: 60_000 },
      { stateDir: temp(), listActions: () => [row], holdsLease: () => true, now: () => now, emitAttention: async () => undefined },
    );
    await r.run();
    row.status = 'completed';
    now += 61_000;
    await r.run();
    expect(r.status()).toMatchObject({ outcomesObserved: 0, actionStates: [{ retired: true }] });

    now += 61_000;
    await r.run();
    expect(r.status()).toMatchObject({
      outcomesObserved: 1,
      outcomesByStatus: { completed: 1 },
      lastOutcome: { actionId: 'ACT-001', statusAt14d: 'completed' },
      actionStates: [{ retired: true, lastOutcomeStatus: 'completed' }],
    });
  });

  it('retires a raised row when it gains a due date', async () => {
    let now = Date.parse('2026-08-01T00:00:00.000Z');
    const row = action('ACT-001', 'critical', '2026-06-01T00:00:00.000Z');
    const ids: string[] = [];
    const r = new UndatedActionResurfacer(
      { enabled: true, dryRun: false, cooldownMs: 60_000, runIntervalMs: 60_000 },
      { stateDir: temp(), listActions: () => [row], holdsLease: () => true, now: () => now, emitAttention: async (i) => { ids.push(i.id); } },
    );
    await r.run();
    row.dueBy = '2026-08-05T00:00:00.000Z';
    now += 61_000;
    expect((await r.run()).reason).toBe('no-eligible');
    now += 61_000;
    expect((await r.run()).reason).toBe('no-eligible');
    expect(ids).toEqual(['resurface:ACT-001:s1:1']);
  });

  it('emits one bounded aggregate alert when the disposition threshold is exceeded', async () => {
    let now = Date.parse('2026-08-01T00:00:00.000Z');
    const ids: string[] = [];
    const r = new UndatedActionResurfacer(
      { enabled: true, dryRun: false, runIntervalMs: 60_000, maxRaises: 1, dispositionThreshold: 1 },
      {
        stateDir: temp(),
        listActions: () => [
          action('ACT-001', 'critical', '2026-06-01T00:00:00.000Z'),
          action('ACT-002', 'critical', '2026-06-02T00:00:00.000Z'),
        ],
        holdsLease: () => true,
        now: () => now,
        emitAttention: async (i) => { ids.push(i.id); },
      },
    );
    await r.run();
    now += 61_000;
    await r.run();
    now += 61_000;
    expect((await r.run()).reason).toBe('disposition-alert');
    expect(ids).toHaveLength(3);
    expect(ids[2]).toMatch(/^undated-actions:needs-disposition:/);
  });

  it('claims and retries the aggregate disposition alert with one stable identity', async () => {
    let now = Date.parse('2026-08-01T00:00:00.000Z');
    let failAggregate = true;
    const ids: string[] = [];
    const r = new UndatedActionResurfacer(
      { enabled: true, dryRun: false, runIntervalMs: 60_000, maxRaises: 1, dispositionThreshold: 1 },
      {
        stateDir: temp(),
        listActions: () => [
          action('ACT-001', 'critical', '2026-06-01T00:00:00.000Z'),
          action('ACT-002', 'critical', '2026-06-02T00:00:00.000Z'),
        ],
        holdsLease: () => true,
        now: () => now,
        emitAttention: async (item) => {
          ids.push(item.id);
          if (item.id.startsWith('undated-actions:needs-disposition:') && failAggregate) throw new Error('aggregate transport failure');
        },
      },
    );
    await r.run();
    now += 61_000;
    await r.run();
    now += 61_000;
    expect((await r.run()).reason).toBe('emit-failed');
    expect(r.status().pendingDispositionAlerts).toBe(1);
    failAggregate = false;
    now += 61_000;
    expect((await r.run()).reason).toBe('replayed');
    const aggregateIds = ids.filter((id) => id.startsWith('undated-actions:needs-disposition:'));
    expect(aggregateIds).toHaveLength(2);
    expect(new Set(aggregateIds).size).toBe(1);
    expect(r.status()).toMatchObject({ pendingDispositionAlerts: 0, failedDispositionAlerts: 0 });
  });

  it('does not mint a fresh aggregate claim immediately after terminal retry failure', async () => {
    let now = Date.parse('2026-08-01T00:00:00.000Z');
    const aggregateIds: string[] = [];
    const r = new UndatedActionResurfacer(
      { enabled: true, dryRun: false, runIntervalMs: 60_000, cooldownMs: 86_400_000, maxRaises: 1, dispositionThreshold: 1 },
      {
        stateDir: temp(),
        listActions: () => [
          action('ACT-001', 'critical', '2026-06-01T00:00:00.000Z'),
          action('ACT-002', 'critical', '2026-06-02T00:00:00.000Z'),
        ],
        holdsLease: () => true,
        now: () => now,
        emitAttention: async (item) => {
          if (item.id.startsWith('undated-actions:needs-disposition:')) {
            aggregateIds.push(item.id);
            throw new Error('persistent aggregate transport failure');
          }
        },
      },
    );
    await r.run();
    now += 61_000;
    await r.run();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      now += 61_000;
      expect((await r.run()).reason).toBe('emit-failed');
    }
    expect(aggregateIds).toHaveLength(3);
    expect(new Set(aggregateIds).size).toBe(1);
    expect(r.status()).toMatchObject({ pendingDispositionAlerts: 0, failedDispositionAlerts: 1 });

    now += 61_000;
    expect((await r.run()).reason).not.toBe('emit-failed');
    expect(aggregateIds).toHaveLength(3);
  });

  it('dry-run exercises real selection without writing a claim or calling Attention', async () => {
    let called = false;
    const r = new UndatedActionResurfacer(
      { enabled: true, dryRun: true },
      { stateDir: temp(), listActions: () => [action('ACT-009', 'high', '2026-06-01T00:00:00.000Z')], emitAttention: async () => { called = true; }, holdsLease: () => true, now: () => Date.parse('2026-08-01T00:00:00.000Z') },
    );
    const out = await r.run();
    expect(out.reason).toBe('dry-run');
    expect(out.selectedActionId).toBe('ACT-009');
    expect(out.wouldEmit?.id).toBe('resurface:ACT-009:s1:1');
    expect(called).toBe(false);
    expect(r.status().pendingClaims).toBe(0);
  });
});
