// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * WS2.5 — EvolutionManager evolution-action-record replication emit seam.
 *
 * Wiring-integrity + the spec-critical fork-#2 tests:
 *   - dark by default: with NO emitter injected, addAction/updateAction emit nothing (a
 *     strict single-machine no-op, byte-identical local behavior).
 *   - emit-on-add: an injected emitter receives a `put` for the added action.
 *   - STATUS-CHANGE RE-EMITS (fork #2, load-bearing): updateAction(status) re-fires a `put`
 *     carrying the NEW status — else a peer never learns an action was already completed and
 *     redoes the work. This is the whole point of replicating actions.
 *   - TERMINAL-IS-NOT-A-DELETE: marking an action completed/cancelled does NOT emit a
 *     tombstone — its record is retained (history). Only an actual queue-removal tombstones.
 *   - PRUNE EMITS TOMBSTONE: when the queue exceeds maxActions, the REMOVED actions emit
 *     `op:delete` tombstones — else a peer re-replicates a locally-removed action forever
 *     (resurrection). This is the named §3 gate.
 *   - emit is best-effort: a throwing emitter NEVER breaks the local write.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { EvolutionManager, type EvolutionActionReplicationEmitter } from '../../src/core/EvolutionManager.js';

function mkDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evo-action-repl-'));
}
function cleanup(dir: string) {
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/evolution-manager-action-replication.test.ts' });
}

interface Recorder extends EvolutionActionReplicationEmitter {
  puts: Array<{ title: string; status: string }>;
  deletes: Array<{ title: string; commitTo: string | null | undefined }>;
}
function recorder(over: Partial<EvolutionActionReplicationEmitter> = {}): Recorder {
  const r: Recorder = {
    puts: [],
    deletes: [],
    emitPut(record) { r.puts.push({ title: record.title, status: record.status }); },
    emitDelete(title, commitTo, _createdAt, _deletedAt) { r.deletes.push({ title, commitTo }); },
    ...over,
  };
  return r;
}

describe('EvolutionManager evolution-action-record replication emit', () => {
  it('auto-expiry removes only stale ordinary pending actions and emits tombstones', () => {
    const dir = mkDir();
    try {
      const stateDir = path.join(dir, 'state', 'evolution');
      fs.mkdirSync(stateDir, { recursive: true });
      const old = '2026-01-01T00:00:00.000Z';
      const recent = new Date().toISOString();
      const base = { description: 'd', priority: 'medium', status: 'pending', createdAt: old } as const;
      const actions = [
        { ...base, id: 'ACT-001', title: 'expire-me' },
        { ...base, id: 'ACT-002', title: 'critical', priority: 'critical' },
        { ...base, id: 'ACT-003', title: 'pinned', tags: ['pinned'] },
        { ...base, id: 'ACT-004', title: 'in-progress', status: 'in_progress' },
        { ...base, id: 'ACT-005', title: 'completed', status: 'completed' },
        { ...base, id: 'ACT-006', title: 'cancelled', status: 'cancelled' },
        { ...base, id: 'ACT-007', title: 'too-new', createdAt: recent },
        { ...base, id: 'ACT-008', title: 'future-deadline', dueBy: '2099-01-01T00:00:00.000Z' },
      ];
      fs.writeFileSync(path.join(stateDir, 'action-queue.json'), JSON.stringify({ actions, stats: {} }));
      const evo = new EvolutionManager({ stateDir: dir, autoExpiry: { enabled: false, maxAgeDays: 21, dryRun: false } });
      const rec = recorder();
      evo.setEvolutionActionReplicationEmitter(rec);
      const result = evo.runActionAutoExpirySweep();
      expect(result).toMatchObject({ eligible: 1, expired: 1, dryRun: false });
      expect(evo.listActions().map((a) => a.title)).not.toContain('expire-me');
      expect(evo.listActions()).toHaveLength(7);
      expect(rec.deletes.map((d) => d.title)).toEqual(['expire-me']);
    } finally { cleanup(dir); }
  });

  it('auto-expiry defaults to dry-run and writes nothing', () => {
    const dir = mkDir();
    try {
      const evo = new EvolutionManager({ stateDir: dir, autoExpiry: { enabled: false, maxAgeDays: 1 } });
      const action = evo.addAction({ title: 'kept', description: 'd' });
      const result = evo.runActionAutoExpirySweep();
      expect(result.dryRun).toBe(true);
      expect(evo.listActions().map((a) => a.id)).toContain(action.id);
    } finally { cleanup(dir); }
  });
  it('dark by default: NO emitter ⇒ addAction/updateAction emit nothing (strict no-op)', () => {
    const dir = mkDir();
    try {
      const evo = new EvolutionManager({ stateDir: dir });
      const a = evo.addAction({ title: 'fix bug', description: 'd', commitTo: 'Justin' });
      expect(a.id).toMatch(/^ACT-/);
      expect(evo.listActions()).toHaveLength(1);
      expect(evo.updateAction(a.id, { status: 'completed' })).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it('emit-on-add: an injected emitter receives a put for the added action', () => {
    const dir = mkDir();
    try {
      const evo = new EvolutionManager({ stateDir: dir });
      const rec = recorder();
      evo.setEvolutionActionReplicationEmitter(rec);
      evo.addAction({ title: 'fix dashboard streaming', description: 'd', commitTo: 'Justin' });
      expect(rec.puts.map((p) => p.title)).toContain('fix dashboard streaming');
      expect(rec.puts.find((p) => p.title === 'fix dashboard streaming')!.status).toBe('pending');
      expect(rec.deletes).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });

  it('STATUS-CHANGE RE-EMITS (fork #2): updateAction(status) re-fires a put carrying the NEW status', () => {
    const dir = mkDir();
    try {
      const evo = new EvolutionManager({ stateDir: dir });
      const rec = recorder();
      evo.setEvolutionActionReplicationEmitter(rec);
      const a = evo.addAction({ title: 'ship WS2.5', description: 'd', commitTo: 'Justin' });
      rec.puts.length = 0; rec.deletes.length = 0;
      // Mark in_progress, then completed — each must re-emit a put with the latest status.
      expect(evo.updateAction(a.id, { status: 'in_progress' })).toBe(true);
      expect(rec.puts.some((p) => p.title === 'ship WS2.5' && p.status === 'in_progress')).toBe(true);
      rec.puts.length = 0;
      expect(evo.updateAction(a.id, { status: 'completed' })).toBe(true);
      expect(rec.puts.some((p) => p.title === 'ship WS2.5' && p.status === 'completed')).toBe(true);
      // A peer that reads this sees status:completed and does not redo the work.
    } finally {
      cleanup(dir);
    }
  });

  it('TERMINAL-IS-NOT-A-DELETE: completing/cancelling an action emits a PUT, never a tombstone', () => {
    const dir = mkDir();
    try {
      const evo = new EvolutionManager({ stateDir: dir });
      const rec = recorder();
      evo.setEvolutionActionReplicationEmitter(rec);
      const a = evo.addAction({ title: 'terminal action', description: 'd', commitTo: 'Justin' });
      rec.puts.length = 0; rec.deletes.length = 0;
      evo.updateAction(a.id, { status: 'completed' });
      // The completed action is RETAINED in the queue and re-emitted as a put — NOT deleted.
      expect(evo.listActions().map((x) => x.title)).toContain('terminal action');
      expect(rec.deletes).toHaveLength(0);
      expect(rec.puts.some((p) => p.title === 'terminal action' && p.status === 'completed')).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it('PRUNE EMITS TOMBSTONE: an action REMOVED over maxActions emits op:delete (no resurrection)', () => {
    const dir = mkDir();
    try {
      // maxActions=3. saveActions prunes completed/cancelled when the queue exceeds max,
      // keeping active + the most-recent done. Add 3 completed, then a 4th completed tips it
      // over ⇒ the oldest completed is REMOVED from the queue ⇒ a tombstone fires.
      const evo = new EvolutionManager({ stateDir: dir, maxActions: 3 });
      const rec = recorder();
      evo.setEvolutionActionReplicationEmitter(rec);
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const a = evo.addAction({ title: `done-${i}`, description: 'd', commitTo: 'Justin' });
        ids.push(a.id);
        evo.updateAction(a.id, { status: 'completed' });
      }
      rec.puts.length = 0; rec.deletes.length = 0;
      const fourth = evo.addAction({ title: 'done-3', description: 'd', commitTo: 'Justin' });
      evo.updateAction(fourth.id, { status: 'completed' }); // tips over max=3 ⇒ prunes done-0
      const survivors = evo.listActions().map((a) => a.title);
      expect(survivors).not.toContain('done-0'); // it was REMOVED from the queue
      expect(rec.deletes.map((d) => d.title)).toContain('done-0'); // tombstone emitted (resurrection guard)
    } finally {
      cleanup(dir);
    }
  });

  it('emit is best-effort: a throwing emitter NEVER breaks the local write', () => {
    const dir = mkDir();
    try {
      const evo = new EvolutionManager({ stateDir: dir });
      evo.setEvolutionActionReplicationEmitter({
        emitPut() { throw new Error('replication down'); },
        emitDelete() { throw new Error('replication down'); },
      });
      const a = evo.addAction({ title: 'resilient', description: 'd', commitTo: 'Justin' });
      expect(a.id).toMatch(/^ACT-/);
      expect(evo.listActions().map((x) => x.title)).toContain('resilient');
      expect(evo.updateAction(a.id, { status: 'completed' })).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it('detach: passing undefined returns to single-machine no-op', () => {
    const dir = mkDir();
    try {
      const evo = new EvolutionManager({ stateDir: dir });
      const rec = recorder();
      evo.setEvolutionActionReplicationEmitter(rec);
      evo.setEvolutionActionReplicationEmitter(undefined);
      evo.addAction({ title: 'detached', description: 'd', commitTo: 'Justin' });
      expect(rec.puts).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });
});
