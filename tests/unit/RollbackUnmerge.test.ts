/**
 * Tier-1 unit tests for RollbackUnmerge + DroppedOriginRegistry (WS2 replicated-
 * store foundation, §7.4).
 *
 * Spec §12 #6: un-merge a peer ⇒ every surviving union read resolves with ZERO
 * references to the dropped origin; conflicts referencing it auto-resolve;
 * reversible (re-merge restores). Plus: quarantine-aside is rename (non-
 * destructive) + bounded-retain through SafeFsExecutor for the prune leg.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RollbackUnmerge, DroppedOriginRegistry, MAX_UNMERGE_RETAIN } from '../../src/core/RollbackUnmerge.js';
import { sanitizeMachineId } from '../../src/core/CoherenceJournal.js';

let dir: string;
let peers: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-'));
  peers = path.join(dir, 'state', 'coherence-journal', 'peers');
  fs.mkdirSync(peers, { recursive: true });
});

function writePeerFiles(origin: string, kind: string): void {
  const safe = sanitizeMachineId(origin);
  fs.writeFileSync(path.join(peers, `${safe}.${kind}.jsonl`), '{"seq":1}\n', 'utf-8');
  fs.writeFileSync(path.join(peers, `${safe}.meta.json`), '{"incarnation":"x"}', 'utf-8');
}

function mkEngine(opts: {
  kinds?: Record<string, string[]>;
  autoResolve?: (origin: string) => string[];
  cacheDrops?: string[];
  closed?: string[];
} = {}): { engine: RollbackUnmerge; registry: DroppedOriginRegistry } {
  const registry = new DroppedOriginRegistry({ stateDir: dir });
  const engine = new RollbackUnmerge(registry, {
    peersDir: () => peers,
    kindsForStore: (store) => opts.kinds?.[store] ?? ['pref-record'],
    now: () => new Date(),
    dropSnapshotCacheForOrigin: (o) => { (opts.cacheDrops ?? []).push(o); },
    autoResolveConflicts: opts.autoResolve ?? (() => []),
    closeAttention: (id) => { (opts.closed ?? []).push(id); },
  });
  return { engine, registry };
}

describe('DroppedOriginRegistry', () => {
  it('records + persists a drop, queryable live', () => {
    const r1 = new DroppedOriginRegistry({ stateDir: dir });
    r1.add('pref', 'B', new Date().toISOString());
    expect(r1.isDropped('pref', 'B')).toBe(true);
    expect(r1.droppedOrigins('pref').has('B')).toBe(true);
    // survives reload
    const r2 = new DroppedOriginRegistry({ stateDir: dir });
    expect(r2.isDropped('pref', 'B')).toBe(true);
  });

  it('remove un-drops', () => {
    const r = new DroppedOriginRegistry({ stateDir: dir });
    r.add('pref', 'B', new Date().toISOString());
    r.remove('pref', 'B');
    expect(r.isDropped('pref', 'B')).toBe(false);
  });
});

describe('unmergeOrigin (§7.4)', () => {
  it('registers the drop FIRST so the union excludes it live (zero dangling refs)', () => {
    writePeerFiles('B', 'pref-record');
    const { engine, registry } = mkEngine();
    const res = engine.unmergeOrigin('pref', 'B');
    expect(registry.isDropped('pref', 'B')).toBe(true);
    expect(res.movedStreams).toBe(1);
    expect(res.movedMeta).toBe(1);
    // The live stream + meta files are renamed aside (non-destructive), not deleted.
    const safe = sanitizeMachineId('B');
    expect(fs.existsSync(path.join(peers, `${safe}.pref-record.jsonl`))).toBe(false);
    const aside = fs.readdirSync(peers).filter((n) => n.includes('.unmerge.'));
    expect(aside.length).toBe(2); // stream + meta quarantined aside
  });

  it('auto-resolves conflicts referencing the dropped origin + closes attention', () => {
    writePeerFiles('B', 'pref-record');
    const closed: string[] = [];
    const { engine } = mkEngine({ autoResolve: () => ['c1', 'c2'], closed });
    const res = engine.unmergeOrigin('pref', 'B');
    expect(res.closedConflicts).toEqual(['c1', 'c2']);
    expect(closed).toEqual(['c1', 'c2']);
  });

  it('drops the snapshot cache for the origin', () => {
    writePeerFiles('B', 'pref-record');
    const cacheDrops: string[] = [];
    const { engine } = mkEngine({ cacheDrops });
    engine.unmergeOrigin('pref', 'B');
    expect(cacheDrops).toEqual(['B']);
  });

  it('does not touch OTHER origins (machine-local, surgical)', () => {
    writePeerFiles('B', 'pref-record');
    writePeerFiles('C', 'pref-record');
    const { engine } = mkEngine();
    engine.unmergeOrigin('pref', 'B');
    const safeC = sanitizeMachineId('C');
    expect(fs.existsSync(path.join(peers, `${safeC}.pref-record.jsonl`))).toBe(true); // C untouched
  });

  it('is reversible — reMerge restores the quarantined streams', () => {
    writePeerFiles('B', 'pref-record');
    const { engine, registry } = mkEngine();
    engine.unmergeOrigin('pref', 'B');
    const restored = engine.reMerge('pref', 'B');
    expect(restored.restored).toBeGreaterThan(0);
    expect(registry.isDropped('pref', 'B')).toBe(false);
    const safe = sanitizeMachineId('B');
    expect(fs.existsSync(path.join(peers, `${safe}.pref-record.jsonl`))).toBe(true);
  });

  it('bounded-retain: prunes the oldest un-merge sets past MAX_UNMERGE_RETAIN', () => {
    const { engine } = mkEngine();
    // Re-create + un-merge MAX+2 times to exceed the retain bound for the stream.
    for (let i = 0; i < MAX_UNMERGE_RETAIN + 2; i++) {
      writePeerFiles('B', 'pref-record');
      engine.unmergeOrigin('pref', 'B');
      // tiny delay to ensure distinct stamps
      const until = Date.now() + 2;
      while (Date.now() < until) { /* spin */ }
    }
    const safe = sanitizeMachineId('B');
    const asideStreams = fs.readdirSync(peers).filter((n) => n.startsWith(`${safe}.pref-record.jsonl.unmerge.`));
    expect(asideStreams.length).toBeLessThanOrEqual(MAX_UNMERGE_RETAIN);
  });
});
