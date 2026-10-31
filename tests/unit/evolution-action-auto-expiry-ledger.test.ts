/**
 * CMT-1118 — evolution action auto-expiry: the tightened eligibility rule and
 * the durable review ledger the dry-run flip rule needs.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EvolutionManager } from '../../src/core/EvolutionManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

describe('evolution action auto-expiry (CMT-1118)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'evolution-action-auto-expiry-ledger.test.ts' });
    }
  });

  function setup(actions: Array<Record<string, unknown>>, dryRun = true): { dir: string; evo: EvolutionManager } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-expiry-ledger-'));
    dirs.push(dir);
    const evoDir = path.join(dir, 'state', 'evolution');
    fs.mkdirSync(evoDir, { recursive: true });
    fs.writeFileSync(path.join(evoDir, 'action-queue.json'), JSON.stringify({ actions, stats: {} }));
    return { dir, evo: new EvolutionManager({ stateDir: dir, autoExpiry: { enabled: false, maxAgeDays: 21, dryRun } }) };
  }

  function ledger(dir: string): any[] {
    const p = path.join(dir, 'logs', 'evolution-actions-auto-expiry.jsonl');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  }

  const base = { description: 'd', priority: 'medium', status: 'pending', createdAt: ago(60) };

  it('keeps high-priority actions and recently-overdue dated actions; expires long-overdue and undated ones', () => {
    const { dir, evo } = setup([
      { ...base, id: 'ACT-001', title: 'undated' },
      { ...base, id: 'ACT-002', title: 'high', priority: 'high' },
      { ...base, id: 'ACT-003', title: 'overdue-5d', dueBy: ago(5) },
      { ...base, id: 'ACT-004', title: 'overdue-30d', dueBy: ago(30) },
      { ...base, id: 'ACT-005', title: 'opted-out', followThroughOptOutReason: 'tracked elsewhere' },
      { ...base, id: 'ACT-006', title: 'low undated', priority: 'low' },
    ]);
    const result = evo.runActionAutoExpirySweep();
    expect(result).toMatchObject({ eligible: 4, expired: 0, dryRun: true });
    const [row] = ledger(dir);
    expect(row).toMatchObject({ dryRun: true, eligible: 4, expired: 0, maxAgeDays: 21 });
    const byId = Object.fromEntries(row.items.map((i: any) => [i.id, i]));
    expect(Object.keys(byId).sort()).toEqual(['ACT-001', 'ACT-004', 'ACT-005', 'ACT-006']);
    expect(byId['ACT-004'].class).toBe('long-overdue');
    expect(byId['ACT-001'].class).toBe('undated');
    expect(byId['ACT-005']).toMatchObject({ class: 'opted-out', reason: 'created with no follow-through needed ("tracked elsewhere")' });
    expect(byId['ACT-001'].ageDays).toBe(60);
    // Dry-run removed nothing.
    expect(evo.listActions()).toHaveLength(6);
  });

  it('records applied removals with their ids, and an unchanged dry-run set as a short row', () => {
    const { dir, evo } = setup([{ ...base, id: 'ACT-001', title: 'undated' }]);
    evo.runActionAutoExpirySweep();
    evo.runActionAutoExpirySweep();
    const rows = ledger(dir);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ unchanged: true, setHash: rows[0].setHash });

    const live = setup([{ ...base, id: 'ACT-009', title: 'go' }], false);
    expect(live.evo.runActionAutoExpirySweep()).toMatchObject({ expired: 1 });
    expect(ledger(live.dir)[0]).toMatchObject({ dryRun: false, expired: 1, items: [{ id: 'ACT-009', applied: true }] });
  });

  describe('CMT-1132 archive and hold', () => {
    const stale = { id: 'ACT-009', title: 'stale', description: 'the full body', priority: 'medium', status: 'pending', createdAt: ago(60), tags: ['keep-me'] };
    const archivePath = (dir: string) => path.join(dir, 'state', 'evolution', 'action-archive.json');

    it('dry-run archives nothing and the ledger names the title', () => {
      const { dir, evo } = setup([stale]);
      expect(evo.runActionAutoExpirySweep()).toMatchObject({ eligible: 1, expired: 0 });
      expect(evo.listArchivedActions()).toEqual([]);
      expect(fs.existsSync(archivePath(dir))).toBe(false);
      expect(ledger(dir)[0].items[0]).toMatchObject({ id: 'ACT-009', title: 'stale', applied: false });
    });

    it('keeps the whole record when it leaves the queue', () => {
      const { evo } = setup([stale], false);
      expect(evo.runActionAutoExpirySweep()).toMatchObject({ expired: 1 });
      expect(evo.listActions()).toEqual([]);
      expect(evo.listArchivedActions()[0]).toMatchObject({ action: stale, class: 'undated' });
    });

    it('restores a row held, so the next sweep leaves it alone', () => {
      const { evo } = setup([stale], false);
      evo.runActionAutoExpirySweep();
      expect(evo.restoreArchivedAction('ACT-009')).toMatchObject({ ...stale, autoExpiryHold: { reason: expect.any(String) } });
      expect(evo.runActionAutoExpirySweep()).toMatchObject({ eligible: 0, expired: 0 });
      expect(evo.listActions().map((a) => a.id)).toEqual(['ACT-009']);
      expect(evo.listArchivedActions()[0].restoredAt).toEqual(expect.any(String));
      expect(evo.restoreArchivedAction('ACT-009')).toBe('not-archived');
    });

    it('re-archives a restored row after its hold is cleared, keeping both entries', () => {
      const { evo } = setup([stale], false);
      evo.runActionAutoExpirySweep();
      evo.restoreArchivedAction('ACT-009');
      evo.updateAction('ACT-009', { autoExpiryHold: null });
      expect(evo.runActionAutoExpirySweep()).toMatchObject({ expired: 1 });
      expect(evo.listArchivedActions()).toHaveLength(2);
    });

    it('a damaged archive stops the sweep and the queue is untouched', () => {
      const { dir, evo } = setup([stale], false);
      fs.writeFileSync(archivePath(dir), '{ not json');
      expect(evo.runActionAutoExpirySweep()).toMatchObject({ eligible: 1, expired: 0 });
      expect(evo.listActions().map((a) => a.id)).toEqual(['ACT-009']);
      expect(fs.readFileSync(archivePath(dir), 'utf8')).toBe('{ not json');
      expect(ledger(dir)[0].items[0].applied).toBe(false);
    });

    it('a damaged archive does not stop new actions', () => {
      const { dir, evo } = setup([], false);
      fs.writeFileSync(archivePath(dir), '{ not json');
      expect(evo.addAction({ title: 'new', description: 'd' }).id).toBe('ACT-001');
    });

    it('a held row is skipped until the hold clears', () => {
      const { evo } = setup([{ ...stale, autoExpiryHold: { reason: 'review 10-30', setAt: ago(0) } }], false);
      expect(evo.runActionAutoExpirySweep()).toMatchObject({ eligible: 0 });
      evo.updateAction('ACT-009', { autoExpiryHold: null });
      expect(evo.runActionAutoExpirySweep()).toMatchObject({ expired: 1 });
    });

    it('never reissues an archived id to new work', () => {
      const { evo } = setup([{ ...stale, id: 'ACT-001' }], false);
      evo.runActionAutoExpirySweep();
      expect(evo.addAction({ title: 'new', description: 'd' }).id).toBe('ACT-002');
      expect(evo.restoreArchivedAction('ACT-001')).toMatchObject({ id: 'ACT-001' });
    });
  });
});
