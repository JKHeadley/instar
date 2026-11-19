/**
 * restart-lock-continuity part B: machine-away announcements.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MachineAwayBook, parseMachineAway, machineAwayReason, describeAway, restartRungDispatched, announceMachineAway, SAME_INSTANCE_CLEAR_MS, type MachineAwayCommand } from '../../src/core/MachineAway.js';
import { classifyMachineEmptyState } from '../../src/server/poolEmptyState.js';
import { checkCommandRBAC } from '../../src/core/MeshRpc.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const T0 = Date.parse('2026-11-18T17:00:00Z');
const cmd = (over: Partial<MachineAwayCommand> = {}): MachineAwayCommand => ({ type: 'machine-away', reason: 'server-restart', expectedBackInSec: 300, serverStartedAt: '2026-11-18T08:00:00.000Z', ...over });

describe('machine-away', () => {
  let clock: number;
  let book: MachineAwayBook;
  beforeEach(() => { clock = T0; book = new MachineAwayBook(() => clock); });

  it('reason comes only from records the machine wrote', () => {
    expect(machineAwayReason({ restartDispatched: true, restartRequestedRecently: true })).toEqual({ reason: 'machine-restart', expectedBackInSec: 1200 });
    expect(machineAwayReason({ restartDispatched: false, restartRequestedRecently: true })).toEqual({ reason: 'server-restart', expectedBackInSec: 300 });
    expect(machineAwayReason({ restartDispatched: false, restartRequestedRecently: false })).toEqual({ reason: 'stopping' });
  });

  it('parse refuses unknown reasons, missing instance, absurd expected time', () => {
    expect(parseMachineAway(cmd())).not.toBeNull();
    expect(parseMachineAway({ ...cmd(), reason: 'nap' })).toBeNull();
    expect(parseMachineAway({ ...cmd(), serverStartedAt: '' })).toBeNull();
    expect(parseMachineAway({ ...cmd(), expectedBackInSec: -1 })).toBeNull();
  });

  it('the deadline uses the receiver clock; a duplicate keeps the first deadline; an older instance is ignored', () => {
    const r = book.receive('m_peer', cmd());
    expect(r.expectedBackBy).toBe(T0 + 300_000);
    clock += 60_000;
    book.receive('m_peer', cmd());
    expect(book.get('m_peer')!.expectedBackBy).toBe(T0 + 300_000);
    book.receive('m_peer', cmd({ serverStartedAt: '2026-11-18T07:00:00.000Z' }));
    expect(book.get('m_peer')!.serverStartedAt).toBe('2026-11-18T08:00:00.000Z');
  });

  it('a pull answered by the same instance during the shutdown does not clear it', () => {
    book.receive('m_peer', cmd());
    clock += 30_000;
    book.observePresence('m_peer', true, '2026-11-18T08:00:00.000Z');
    expect(book.get('m_peer')).not.toBeNull();
  });

  it('a different instance clears it even if every pull missed the downtime', () => {
    book.receive('m_peer', cmd());
    clock += 60_000;
    book.observePresence('m_peer', true, '2026-11-18T17:01:00.000Z');
    expect(book.get('m_peer')).toBeNull();
  });

  it('the same instance still answering 15 minutes later clears it (the shutdown did not happen)', () => {
    book.receive('m_peer', cmd());
    clock += SAME_INSTANCE_CLEAR_MS;
    book.observePresence('m_peer', true, '2026-11-18T08:00:00.000Z');
    expect(book.get('m_peer')).toBeNull();
  });

  it('an older peer without an instance clears on success after a failed pull', () => {
    book.receive('m_peer', cmd());
    book.observePresence('m_peer', true, null);
    expect(book.get('m_peer')).not.toBeNull();
    book.observePresence('m_peer', false, null);
    book.observePresence('m_peer', true, null);
    expect(book.get('m_peer')).toBeNull();
  });

  it('pool reading: offline with the reason, and the overdue wording', () => {
    const rec = book.receive('m_peer', cmd({ reason: 'machine-restart', expectedBackInSec: 1200 }));
    const s = classifyMachineEmptyState({ online: false, failedReason: 'offline', awayText: describeAway(rec, clock) }, clock);
    expect(s.kind).toBe('offline');
    expect(s.text).toContain('restarting the machine');
    expect(describeAway(rec, clock + 31 * 60_000)).toContain("hasn't returned");
    expect(describeAway(book.receive('m_x', cmd({ reason: 'stopping', expectedBackInSec: undefined })), clock)).toBe('stopped on purpose, reason not recorded');
    const online = classifyMachineEmptyState({ online: true, failedReason: null, awayText: 'x' }, clock);
    expect(online.kind).toBe('online');
  });

  it('mesh RBAC lets a registered peer send machine-away', () => {
    const r = checkCommandRBAC(cmd(), 'm_peer' as never, { routerHolder: () => null, ownerOf: () => null, placementTargetOf: () => null } as never);
    expect(r.ok).toBe(true);
  });
});

describe('machine-away sending', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'away-')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/machine-away.test.ts' }); });

  it('a dispatched rung on this boot in the last 5 minutes counts; a reservation alone does not', () => {
    const ledger = path.join(dir, 'restarts.jsonl');
    const now = T0;
    fs.writeFileSync(ledger, JSON.stringify({ type: 'episode', state: 'reserved', bootAt: 1000, at: now - 1000 }) + '\n');
    expect(restartRungDispatched(ledger, 1000, now)).toBe(false);
    fs.appendFileSync(ledger, JSON.stringify({ type: 'episode', state: 'dispatched', rung: 1, bootAt: 1000, at: now - 1000 }) + '\n');
    expect(restartRungDispatched(ledger, 1000, now)).toBe(true);
    expect(restartRungDispatched(ledger, 1000, now + 10 * 60_000)).toBe(false);
    expect(restartRungDispatched(path.join(dir, 'missing'), 1000, now)).toBe(false);
  });

  it('sends to every peer within the budget; one hanging peer does not hold the shutdown', async () => {
    const seen: string[] = [];
    const started = Date.now();
    const r = await announceMachineAway({
      peers: ['a', 'b', 'hang'],
      send: (id) => { seen.push(id); return id === 'hang' ? new Promise(() => {}) : Promise.resolve({ ok: true }); },
      cmd: cmd(),
      budgetMs: 300,
    });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(seen.sort()).toEqual(['a', 'b', 'hang']);
    expect(r.sent).toBe(2);
  });

  it('a refusal that resolves (older peer, no address, handler said malformed) counts as not reached', async () => {
    const r = await announceMachineAway({
      peers: ['ok', 'old', 'noaddr', 'bad'],
      send: async (id) => id === 'ok' ? { ok: true, result: { ok: true } }
        : id === 'old' ? { ok: false, status: 403, reason: 'claim-unauthorized' }
        : id === 'noaddr' ? { ok: false, reason: 'no-url' }
        : { ok: true, result: { ok: false, reason: 'malformed' } },
      cmd: cmd(),
      budgetMs: 500,
    });
    expect(r).toEqual({ sent: 1, failed: 3 });
  });
});
