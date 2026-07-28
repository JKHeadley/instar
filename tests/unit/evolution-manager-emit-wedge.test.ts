// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Standby-write-wedge fix (2026-07-10) — EvolutionManager must re-emit ONLY records whose
 * content CHANGED, never every surviving record on every write.
 *
 * THE BUG: saveActions/saveLearnings re-emitted EVERY surviving record on EVERY write, and
 * each emit's `loadWitness` re-scans the whole journal. That made one write cost
 * O(records × journalBytes) SYNCHRONOUS fs — on a real agent the evolution-action journal
 * had bloated to ~53MB / 61k records over 632 keys (each key re-emitted ~112×), so ONE
 * `POST /evolution/actions` did tens of GB of synchronous reads and starved the event loop
 * until the supervisor killed the process. It also fed itself: re-emit-all bloats the
 * journal, which makes the next write's scan slower — a doom loop.
 *
 * These tests pin the emit COUNT (the wedge multiplier), not timing, so they are
 * deterministic. Each FAILS against the pre-fix "re-emit every survivor" behavior and PASSES
 * after the "re-emit only changed" fix. They also assert the load-bearing correctness
 * property is preserved: a status change STILL re-emits (a peer must see the latest status).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  EvolutionManager,
  type EvolutionActionReplicationEmitter,
  type LearningReplicationEmitter,
} from '../../src/core/EvolutionManager.js';

function mkDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evo-emit-wedge-'));
}
function cleanup(dir: string) {
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/evolution-manager-emit-wedge.test.ts' });
}

interface ActionCounter extends EvolutionActionReplicationEmitter {
  putCount: number;
  puts: Array<{ title: string; status: string }>;
}
function actionCounter(): ActionCounter {
  const r: ActionCounter = {
    putCount: 0,
    puts: [],
    emitPut(record) { r.putCount++; r.puts.push({ title: record.title, status: record.status }); },
    emitDelete() { /* deletes are not the wedge path */ },
  };
  return r;
}

describe('EvolutionManager emit wedge fix — actions re-emit only what changed', () => {
  it('each addAction emits O(1), NOT O(N): 40 adds ⇒ 40 puts, not 40·41/2 = 820', () => {
    const dir = mkDir();
    try {
      const evo = new EvolutionManager({ stateDir: dir });
      const rec = actionCounter();
      evo.setEvolutionActionReplicationEmitter(rec);
      const N = 40;
      for (let i = 0; i < N; i++) {
        evo.addAction({ title: `task-${i}`, description: 'd', commitTo: 'Justin' });
      }
      // Pre-fix (re-emit every survivor): 1+2+…+40 = 820 emits. Post-fix: exactly one emit
      // per add (only the newly added record changed) ⇒ 40.
      expect(rec.putCount).toBe(N);
    } finally {
      cleanup(dir);
    }
  });

  it('updateAction re-emits ONLY the changed action (not every survivor), carrying the new status', () => {
    const dir = mkDir();
    try {
      const evo = new EvolutionManager({ stateDir: dir });
      const rec = actionCounter();
      evo.setEvolutionActionReplicationEmitter(rec);
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(evo.addAction({ title: `a-${i}`, description: 'd', commitTo: 'Justin' }).id);
      }
      rec.putCount = 0; rec.puts.length = 0;
      expect(evo.updateAction(ids[2], { status: 'in_progress' })).toBe(true);
      // Pre-fix: all 5 survivors re-emit. Post-fix: only the one that changed.
      expect(rec.putCount).toBe(1);
      expect(rec.puts).toEqual([{ title: 'a-2', status: 'in_progress' }]);
    } finally {
      cleanup(dir);
    }
  });

  it('an unchanged record is never re-emitted: re-persisting the same state emits nothing', () => {
    const dir = mkDir();
    try {
      const evo = new EvolutionManager({ stateDir: dir });
      const rec = actionCounter();
      evo.setEvolutionActionReplicationEmitter(rec);
      const id = evo.addAction({ title: 'stable', description: 'd', commitTo: 'Justin' }).id;
      rec.putCount = 0;
      // A no-op update (same status it already has) must not re-emit — its content is unchanged.
      expect(evo.updateAction(id, { status: 'pending' })).toBe(true);
      expect(rec.putCount).toBe(0);
    } finally {
      cleanup(dir);
    }
  });

  it('cold start (restart with a populated queue) does NOT re-emit every action on the first write', () => {
    const dir = mkDir();
    try {
      // Session 1: build a 30-action queue on disk (no emitter needed to persist).
      const s1 = new EvolutionManager({ stateDir: dir });
      for (let i = 0; i < 30; i++) {
        s1.addAction({ title: `pre-${i}`, description: 'd', commitTo: 'Justin' });
      }
      // Session 2 (simulated restart): fresh manager over the SAME dir. Attaching the emitter
      // seeds the change-detector from the on-disk queue, so the first write does not
      // re-emit the 30 pre-existing actions.
      const s2 = new EvolutionManager({ stateDir: dir });
      const rec = actionCounter();
      s2.setEvolutionActionReplicationEmitter(rec);
      s2.addAction({ title: 'new-after-restart', description: 'd', commitTo: 'Justin' });
      // Pre-fix (no seeding + re-emit-all): 31 emits on the first write. Post-fix: 1.
      expect(rec.putCount).toBe(1);
      expect(rec.puts).toEqual([{ title: 'new-after-restart', status: 'pending' }]);
    } finally {
      cleanup(dir);
    }
  });
});

interface LearningCounter extends LearningReplicationEmitter {
  putCount: number;
}
function learningCounter(): LearningCounter {
  const r: LearningCounter = {
    putCount: 0,
    emitPut() { r.putCount++; },
    emitDelete() { /* not the wedge path */ },
  };
  return r;
}

describe('EvolutionManager emit wedge fix — learnings re-emit only what changed', () => {
  it('each registerLearning emits O(1), NOT O(N): 25 learnings ⇒ 25 puts, not 325', () => {
    const dir = mkDir();
    try {
      const evo = new EvolutionManager({ stateDir: dir });
      const rec = learningCounter();
      evo.setLearningReplicationEmitter(rec);
      const N = 25;
      for (let i = 0; i < N; i++) {
        evo.addLearning({
          title: `lesson-${i}`,
          category: 'process',
          description: 'd',
          source: { discoveredAt: new Date().toISOString() },
        });
      }
      // Pre-fix: 1+2+…+25 = 325 emits. Post-fix: one per registration ⇒ 25.
      expect(rec.putCount).toBe(N);
    } finally {
      cleanup(dir);
    }
  });
});
