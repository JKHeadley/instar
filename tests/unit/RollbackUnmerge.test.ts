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

import { RollbackUnmerge, DroppedOriginRegistry, DroppedOriginRegistryDamagedError, MAX_UNMERGE_RETAIN } from '../../src/core/RollbackUnmerge.js';
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
  it('physical proof refuses stale same-root state and corrupt physical documents', () => {
    const first=new DroppedOriginRegistry({stateDir:dir}),second=new DroppedOriginRegistry({stateDir:dir});
    expect(first.physicalSnapshot(fs.realpathSync(dir))).toMatch(/^[a-f0-9]{64}$/);
    second.add('conversationGraph','B',new Date().toISOString());
    expect(()=>first.physicalSnapshot(fs.realpathSync(dir))).toThrow('dropped-origin-physical-state-changed');
    expect(second.physicalSnapshot(fs.realpathSync(dir))).toMatch(/^[a-f0-9]{64}$/);
    fs.writeFileSync(path.join(dir,'state','state-sync','dropped-origins.json'),'{broken');
    expect(()=>second.physicalSnapshot(fs.realpathSync(dir))).toThrow();
  });

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

describe('DroppedOriginRegistry — fail-safe on a damaged file (fb-26f128ae-7fa)', () => {
  const docPath = () => path.join(dir, 'state', 'state-sync', 'dropped-origins.json');
  const writeRaw = (text: string) => {
    fs.mkdirSync(path.dirname(docPath()), { recursive: true });
    fs.writeFileSync(docPath(), text, 'utf-8');
  };
  const asideFiles = () => fs.readdirSync(path.dirname(docPath())).filter((n) => n.startsWith('dropped-origins.json.damaged-'));
  const mk = (reports: unknown[] = []) => new DroppedOriginRegistry({ stateDir: dir, reportDegradation: (d) => { reports.push(d); } });

  it('healthy file: loads as healthy, mutates and persists normally, no degradation', () => {
    const reports: unknown[] = [];
    const r1 = mk(reports);
    r1.add('pref', 'A', '2026-01-01T00:00:00.000Z');
    r1.add('pairing', 'B', '2026-01-01T00:00:00.000Z');
    const r2 = mk(reports);
    expect(r2.health().status).toBe('healthy');
    r2.remove('pref', 'A');
    r2.add('pref', 'C', '2026-01-02T00:00:00.000Z');
    const r3 = mk(reports);
    expect(r3.isDropped('pref', 'A')).toBe(false);
    expect(r3.isDropped('pairing', 'B')).toBe(true);
    expect(r3.isDropped('pref', 'C')).toBe(true);
    expect(reports).toHaveLength(0);
    expect(asideFiles()).toHaveLength(0);
  });

  it('absent file is healthy (nothing dropped) and the first add writes it', () => {
    const r = mk();
    expect(r.health().status).toBe('healthy');
    r.add('pref', 'A', 'x');
    expect(fs.existsSync(docPath())).toBe(true);
  });

  it('truncated JSON: recovers parseable entries, keeps them excluded, preserves the bytes aside, reports once', () => {
    const good = JSON.stringify({ version: 1, dropped: [
      { store: 'pairing', origin: 'revoked-peer', droppedAt: 't1' },
      { store: 'pref', origin: 'B', droppedAt: 't2' },
      { store: 'pref', origin: 'C', droppedAt: 't3' },
    ] }, null, 2);
    const damaged = good.slice(0, good.indexOf('"C"') + 3); // cut mid third entry
    writeRaw(damaged);
    const reports: Array<{ reason: string; preservedAt: string | null; salvagedCount: number }> = [];
    const r = mk(reports as unknown[]);
    expect(r.health().status).toBe('damaged');
    expect(r.isDropped('pairing', 'revoked-peer')).toBe(true);
    expect(r.isDropped('pref', 'B')).toBe(true);
    expect(r.health().salvagedCount).toBe(2);
    expect(reports).toHaveLength(1);
    expect(reports[0].reason).toContain('JSON');
    const aside = asideFiles();
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(docPath()), aside[0]), 'utf-8')).toBe(damaged);
    expect(reports[0].preservedAt).toBe(path.join(path.dirname(docPath()), aside[0]));
  });

  it('corrupt file is NEVER overwritten by a mutation; exclusions are not lost across restart', () => {
    const damaged = '{"version":1,"dropped":[{"store":"pairing","origin":"revoked-peer","droppedAt":"t1"},{"store":"pref","origin":"B","dro';
    writeRaw(damaged);
    const r = mk();
    // add: applied live (safe direction) but refused durably.
    expect(() => r.add('pref', 'NEW', 't9')).toThrow(DroppedOriginRegistryDamagedError);
    expect(r.isDropped('pref', 'NEW')).toBe(true);
    // remove: refused entirely; the exclusion stays.
    expect(() => r.remove('pairing', 'revoked-peer')).toThrow(DroppedOriginRegistryDamagedError);
    expect(r.isDropped('pairing', 'revoked-peer')).toBe(true);
    // The on-disk bytes are untouched.
    expect(fs.readFileSync(docPath(), 'utf-8')).toBe(damaged);
    // A restart still sees the damage (not a falsely healthy partial file) and still excludes the known drop.
    const again = mk();
    expect(again.health().status).toBe('damaged');
    expect(again.isDropped('pairing', 'revoked-peer')).toBe(true);
    // Preserving aside is idempotent by content.
    expect(asideFiles()).toHaveLength(1);
  });

  it('entries naming another machine are kept, not ignored (revocations must not be hidden)', () => {
    writeRaw(JSON.stringify({ version: 1, dropped: [
      { store: 'pairing', origin: 'other-machine-revoked', droppedAt: 't' },
      { store: 'pairing', origin: 42 },
    ] }));
    const r = mk();
    expect(r.health().status).toBe('damaged');
    expect(r.health().reason).toContain('malformed');
    expect(r.droppedOrigins('pairing').has('other-machine-revoked')).toBe(true);
  });

  it.each([
    ['not an object', '[1,2,3]'],
    ['dropped not a list', '{"version":1,"dropped":"oops"}'],
    ['unknown version', '{"version":2,"dropped":[]}'],
    ['empty file', ''],
  ])('schema-invalid (%s) is damaged and refuses mutation', (_label, text) => {
    writeRaw(text);
    const r = mk();
    expect(r.health().status).toBe('damaged');
    expect(() => r.add('pref', 'X', 't')).toThrow(DroppedOriginRegistryDamagedError);
    expect(fs.readFileSync(docPath(), 'utf-8')).toBe(text);
  });

  it('unreadable file is damaged with no aside copy, and nothing is written', () => {
    writeRaw('{"version":1,"dropped":[]}');
    const r = new DroppedOriginRegistry({
      stateDir: dir,
      readFileSync: () => { throw new Error('EIO'); },
      reportDegradation: () => {},
    });
    expect(r.health()).toMatchObject({ status: 'damaged', preservedAt: null });
    expect(() => r.remove('pref', 'A')).toThrow(DroppedOriginRegistryDamagedError);
  });

  it('unmerge/re-merge on a damaged registry: unmerge excludes live but moves nothing; re-merge restores nothing', () => {
    writeRaw('{"version":1,"dropped":[{"store":"pref","origin":"B","droppedAt":"t"},');
    writePeerFiles('C', 'pref-record');
    const registry = new DroppedOriginRegistry({ stateDir: dir, reportDegradation: () => {} });
    const engine = new RollbackUnmerge(registry, {
      peersDir: () => peers,
      kindsForStore: () => ['pref-record'],
      now: () => new Date(),
      dropSnapshotCacheForOrigin: () => {},
      autoResolveConflicts: () => [],
    });
    expect(() => engine.unmergeOrigin('pref', 'C')).toThrow(DroppedOriginRegistryDamagedError);
    expect(registry.isDropped('pref', 'C')).toBe(true);
    expect(fs.existsSync(path.join(peers, `${sanitizeMachineId('C')}.pref-record.jsonl`))).toBe(true);
    expect(() => engine.reMerge('pref', 'B')).toThrow(DroppedOriginRegistryDamagedError);
    expect(registry.isDropped('pref', 'B')).toBe(true);
  });
});
