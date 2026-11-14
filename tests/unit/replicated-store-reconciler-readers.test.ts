// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * Unit — the reconciler's read-side + delete-side helpers
 * (docs/specs/statesync-writer-agnostic-reconciler.md "Unit (readers)", "Unit (managers)",
 * "Unit (git check)"):
 *
 *   - strict readers (KnowledgeManager.readCatalogStrict, RelationshipManager.readAllFromDisk,
 *     UserManager.readProfilesFromDisk): throw on corrupt, present:false on missing,
 *     skipped counts, write nothing, log nothing per row.
 *   - DeletionIntentLog: two-phase lines, clock pointer, null floor on a missing/corrupt
 *     clock, a stale extra clock file ignored via the pointer.
 *   - manager delete paths: pending BEFORE removal, done AFTER, same deletedAt to the
 *     emitter hook, no identity, never failing the delete.
 *   - key-only tombstone builders == identity builders.
 *   - makeGitCarriedProbe verdicts via the injectable runGit.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { KnowledgeManager } from '../../src/knowledge/KnowledgeManager.js';
import { RelationshipManager } from '../../src/core/RelationshipManager.js';
import { UserManager } from '../../src/users/UserManager.js';
import { registryHighWaterPath } from '../../src/core/registryHighWater.js';
import {
  clockPointerPath,
  intentLogPath,
  readDeletionIntents,
  readPersistedClock,
  recordDeletionDone,
  recordDeletionPending,
  writeClockPointer,
  type DeletionIntentLine,
} from '../../src/core/DeletionIntentLog.js';
import {
  KNOWLEDGE_KIND_REGISTRATION,
  KNOWLEDGE_STORE_KEY,
  buildKnowledgeTombstoneData,
  buildKnowledgeTombstoneFromKey,
  deriveKnowledgeRecordKey,
} from '../../src/core/KnowledgeReplicatedStore.js';
import {
  RELATIONSHIP_KIND_REGISTRATION,
  RELATIONSHIP_STORE_KEY,
  buildRelationshipTombstoneData,
  buildRelationshipTombstoneFromKey,
  deriveRelationshipRecordKey,
} from '../../src/core/RelationshipsReplicatedStore.js';
import { validateReplicatedEnvelope } from '../../src/core/ReplicatedRecordEnvelope.js';
import { makeGitCarriedProbe } from '../../src/core/ReplicatedStoreReconcilerWiring.js';
import type { ReconcileStoreSeam } from '../../src/core/ReplicatedStoreReconciler.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import type { UserChannel } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const NOOP = { bumpSchemaReject: () => {}, bumpDroppedField: () => {}, bumpJailReject: () => {} };
const dirs: string[] = [];
function tmp(label: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `reconcile-readers-${label}-`));
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) {
    SafeFsExecutor.safeRmSync(dirs.pop()!, { recursive: true, force: true, operation: 'tests/unit/replicated-store-reconciler-readers.test.ts' });
  }
});

/** Every file under `dir` (relative), for no-write assertions. */
function listTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${path.relative(dir, p)}@${fs.statSync(p).mtimeMs}`);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

function intentLines(stateDir: string, store: string): DeletionIntentLine[] {
  const p = intentLogPath(stateDir, store);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// ─────────────────────────────────────────────────────────────────────────────

describe('KnowledgeManager.readCatalogStrict', () => {
  it('present:false for a missing catalog, without creating anything', () => {
    const dir = tmp('kb-missing');
    expect(KnowledgeManager.readCatalogStrict(dir)).toEqual({ sources: [], skipped: 0, present: false });
    expect(fs.existsSync(path.join(dir, 'knowledge'))).toBe(false);
  });

  it('throws on a corrupt catalog and on a catalog with no sources array (never reads as empty)', () => {
    const dir = tmp('kb-corrupt');
    fs.mkdirSync(path.join(dir, 'knowledge'));
    fs.writeFileSync(path.join(dir, 'knowledge', 'catalog.json'), '{"sources": [ {');
    expect(() => KnowledgeManager.readCatalogStrict(dir)).toThrow();
    fs.writeFileSync(path.join(dir, 'knowledge', 'catalog.json'), '{"items": []}');
    expect(() => KnowledgeManager.readCatalogStrict(dir)).toThrow(/sources/);
  });

  it('counts malformed rows as skipped, writes nothing, logs nothing per row', () => {
    const dir = tmp('kb-rows');
    fs.mkdirSync(path.join(dir, 'knowledge'));
    const good = { id: 'kb1', title: 'Good', url: null, type: 'doc', ingestedAt: '2026-10-01T00:00:00.000Z', filePath: 'docs/g.md', tags: [], summary: '', wordCount: 1 };
    fs.writeFileSync(path.join(dir, 'knowledge', 'catalog.json'), JSON.stringify({ sources: [good, { id: 'x', type: 'doc' }, null, { title: 'no type' }] }));
    const before = listTree(dir);
    const log = vi.spyOn(console, 'log');
    const warn = vi.spyOn(console, 'warn');
    const r = KnowledgeManager.readCatalogStrict(dir);
    expect(r.present).toBe(true);
    expect(r.sources.map((s) => s.title)).toEqual(['Good']);
    expect(r.skipped).toBe(3);
    expect(listTree(dir)).toEqual(before);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('RelationshipManager.readAllFromDisk', () => {
  it('present:false for a missing dir, without creating it', () => {
    const dir = path.join(tmp('rel-missing'), 'relationships');
    expect(RelationshipManager.readAllFromDisk(dir)).toEqual({ records: [], skipped: 0, present: false });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('skips corrupt, misnamed and invalid-id files; writes and logs nothing', () => {
    const dir = path.join(tmp('rel-rows'), 'relationships');
    fs.mkdirSync(dir);
    const rec = (id: string) => ({ id, name: 'N', channels: [{ type: 'telegram', identifier: '1' }] });
    fs.writeFileSync(path.join(dir, `${UUID(1)}.json`), JSON.stringify(rec(UUID(1))));
    fs.writeFileSync(path.join(dir, `${UUID(2)}.json`), '{ corrupt');
    fs.writeFileSync(path.join(dir, `${UUID(3)}.json`), JSON.stringify(rec(UUID(4)))); // filename ≠ id
    fs.writeFileSync(path.join(dir, 'not-a-uuid.json'), JSON.stringify(rec('not-a-uuid')));
    fs.writeFileSync(path.join(dir, 'README.txt'), 'ignored');
    const before = listTree(dir);
    const log = vi.spyOn(console, 'log');
    const warn = vi.spyOn(console, 'warn');
    const r = RelationshipManager.readAllFromDisk(dir);
    expect(r.present).toBe(true);
    expect(r.records.map((x) => x.id)).toEqual([UUID(1)]);
    expect(r.skipped).toBe(3);
    expect(listTree(dir)).toEqual(before);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('throws when the path is not a readable directory', () => {
    const file = path.join(tmp('rel-file'), 'relationships');
    fs.writeFileSync(file, 'not a dir');
    expect(() => RelationshipManager.readAllFromDisk(file)).toThrow();
  });
});

describe('UserManager.readProfilesFromDisk', () => {
  const user = (id: string, channels: UserChannel[] = [{ type: 'telegram', identifier: id }]) => ({ id, name: id, channels, permissions: ['user'], preferences: {} });

  it('present:false for a missing file; throws on corrupt or non-array', () => {
    const dir = tmp('users');
    expect(UserManager.readProfilesFromDisk(dir)).toEqual({ profiles: [], skipped: 0, present: false });
    fs.writeFileSync(path.join(dir, 'users.json'), '[{');
    expect(() => UserManager.readProfilesFromDisk(dir)).toThrow();
    fs.writeFileSync(path.join(dir, 'users.json'), '{"a":1}');
    expect(() => UserManager.readProfilesFromDisk(dir)).toThrow(/not an array/);
  });

  it('skips malformed and fixture rows, never writes the high-water marker, logs nothing', () => {
    const dir = tmp('users-rows');
    fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([
      user('justin'),
      { id: 'no-channels', permissions: [] },
      null,
      user('u-olivia'), // harness fixture id
      user('slacker', [{ type: 'slack', identifier: 'U0BA7QGPBQS' }]), // fixture slack id
    ]));
    const before = listTree(dir);
    const log = vi.spyOn(console, 'log');
    const warn = vi.spyOn(console, 'warn');
    const r = UserManager.readProfilesFromDisk(dir);
    expect(r.present).toBe(true);
    expect(r.profiles.map((p) => p.id)).toEqual(['justin']);
    expect(r.skipped).toBe(4);
    expect(fs.existsSync(registryHighWaterPath(dir))).toBe(false);
    expect(listTree(dir)).toEqual(before);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('DeletionIntentLog', () => {
  const H: HlcTimestamp = { physical: 1_800_000_000_123, logical: 4, node: 'm_self' };

  it('records pending then done, reads newest per key and pending-only lines', async () => {
    const dir = tmp('intents');
    expect(recordDeletionPending(dir, 'knowledge', 'k1', 'T1')).toBe(true);
    expect(recordDeletionDone(dir, 'knowledge', 'k1', 'T1')).toBe(true);
    expect(recordDeletionPending(dir, 'knowledge', 'k2', 'T2')).toBe(true);
    fs.appendFileSync(intentLogPath(dir, 'knowledge'), 'garbage-not-json\n{"recordKey":3}\n');
    const scan = await readDeletionIntents(dir, 'knowledge');
    expect(scan.newest.get('k1')).toMatchObject({ phase: 'done', deletedAt: 'T1', hlcFloor: null });
    expect(scan.newest.get('k2')).toMatchObject({ phase: 'pending' });
    expect(scan.pendingOnly.map((l) => l.recordKey)).toEqual(['k2']);
    expect(scan.bytes).toBe(fs.statSync(intentLogPath(dir, 'knowledge')).size);
    expect(scan.newest.size).toBe(2);
  });

  it('a missing log reads as empty', async () => {
    const scan = await readDeletionIntents(tmp('none'), 'knowledge');
    expect(scan.newest.size).toBe(0);
    expect(scan.pendingOnly).toEqual([]);
    expect(scan.bytes).toBe(0);
  });

  it('done carries the persisted HLC read through the clock pointer', async () => {
    const dir = tmp('clock');
    const clockFile = path.join(dir, 'state', 'hlc-m_self.json');
    fs.mkdirSync(path.dirname(clockFile), { recursive: true });
    fs.writeFileSync(clockFile, JSON.stringify(H));
    writeClockPointer(dir, clockFile);
    expect(JSON.parse(fs.readFileSync(clockPointerPath(dir), 'utf-8'))).toEqual({ path: clockFile });
    expect(readPersistedClock(dir)).toEqual(H);
    recordDeletionDone(dir, 'relationships', 'k', 'T');
    expect(intentLines(dir, 'relationships')[0].hlcFloor).toEqual(H);
  });

  it('a stale abandoned clock file beside the live one is ignored (the pointer decides)', () => {
    const dir = tmp('clock-stale');
    const stale = path.join(dir, 'state', 'hlc-m_old.json');
    const live = path.join(dir, 'state', 'hlc-m_self.json');
    fs.mkdirSync(path.dirname(live), { recursive: true });
    fs.writeFileSync(stale, JSON.stringify({ physical: 9_999_999_999_999, logical: 0, node: 'm_old' }));
    fs.writeFileSync(live, JSON.stringify(H));
    writeClockPointer(dir, live);
    expect(readPersistedClock(dir)).toEqual(H);
  });

  it('a missing pointer, missing clock file or corrupt clock gives a null floor (never throws)', () => {
    const dir = tmp('clock-null');
    expect(readPersistedClock(dir)).toBeNull();
    const live = path.join(dir, 'state', 'hlc.json');
    writeClockPointer(dir, live);
    expect(readPersistedClock(dir)).toBeNull(); // pointer → missing file
    fs.mkdirSync(path.dirname(live), { recursive: true });
    fs.writeFileSync(live, '{ torn');
    expect(readPersistedClock(dir)).toBeNull();
    fs.writeFileSync(live, JSON.stringify({ physical: 'x', logical: 0, node: 'n' }));
    expect(readPersistedClock(dir)).toBeNull();
    fs.writeFileSync(clockPointerPath(dir), '{"path": 7}');
    expect(readPersistedClock(dir)).toBeNull();
    recordDeletionDone(dir, 'knowledge', 'k', 'T');
    expect(intentLines(dir, 'knowledge')[0].hlcFloor).toBeNull();
  });

  it('an append failure returns false and never throws', () => {
    const dir = tmp('fail');
    fs.mkdirSync(path.join(dir, 'state'));
    fs.writeFileSync(path.join(dir, 'state', 'reconcile'), 'a file where a dir must go');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(recordDeletionPending(dir, 'knowledge', 'k', 'T')).toBe(false);
    expect(recordDeletionDone(dir, 'knowledge', 'k', 'T')).toBe(false);
  });
});

describe('KnowledgeManager.remove writes deletion intents', () => {
  function ingest(km: KnowledgeManager, title: string) {
    return km.ingest('body', { title, url: `https://example.com/${title}`, type: 'article' });
  }

  it('pending before the catalog removal, done after; same deletedAt to the hook; no identity field', () => {
    const dir = tmp('kb-del');
    const km = new KnowledgeManager(dir);
    const res = ingest(km, 'doomed');
    const key = deriveKnowledgeRecordKey('doomed', 'https://example.com/doomed', 'article')!;
    const deletes: string[] = [];
    km.setKnowledgeReplicationEmitter({ emitPut: () => {}, emitDelete: (_t, _u, _ty, at) => deletes.push(at) });

    const seenAtSave: DeletionIntentLine[][] = [];
    const proto = KnowledgeManager.prototype as unknown as { saveCatalog: (c: unknown) => void };
    const orig = proto.saveCatalog;
    vi.spyOn(proto, 'saveCatalog').mockImplementation(function (this: unknown, c: unknown) {
      seenAtSave.push(intentLines(dir, KNOWLEDGE_STORE_KEY));
      return orig.call(this, c);
    });

    expect(km.remove(res.sourceId)).toBe(true);
    expect(seenAtSave[0].map((l) => l.phase)).toEqual(['pending']); // pending BEFORE the removal
    const lines = intentLines(dir, KNOWLEDGE_STORE_KEY);
    expect(lines.map((l) => l.phase)).toEqual(['pending', 'done']);
    for (const l of lines) {
      expect(l.recordKey).toBe(key);
      expect(Object.keys(l).sort()).toEqual(l.phase === 'done' ? ['deletedAt', 'hlcFloor', 'phase', 'recordKey'] : ['deletedAt', 'phase', 'recordKey']);
    }
    expect(lines[0].deletedAt).toBe(lines[1].deletedAt);
    expect(deletes).toEqual([lines[0].deletedAt]);
  });

  it('works with no emitter attached (CLI-style instance)', () => {
    const dir = tmp('kb-cli');
    const id = ingest(new KnowledgeManager(dir), 'gone').sourceId;
    expect(new KnowledgeManager(dir).remove(id)).toBe(true);
    expect(intentLines(dir, KNOWLEDGE_STORE_KEY).map((l) => l.phase)).toEqual(['pending', 'done']);
  });

  it('a throw between the two phases leaves only `pending`', () => {
    const dir = tmp('kb-throw');
    const km = new KnowledgeManager(dir);
    const id = ingest(km, 'half').sourceId;
    vi.spyOn(KnowledgeManager.prototype as unknown as { saveCatalog: () => void }, 'saveCatalog').mockImplementation(() => { throw new Error('disk full'); });
    expect(() => km.remove(id)).toThrow(/disk full/);
    expect(intentLines(dir, KNOWLEDGE_STORE_KEY).map((l) => l.phase)).toEqual(['pending']);
  });

  it('never fails the delete when the intent append fails', () => {
    const dir = tmp('kb-appendfail');
    const km = new KnowledgeManager(dir);
    const id = ingest(km, 'x').sourceId;
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'reconcile'), 'blocker');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(km.remove(id)).toBe(true);
    expect(KnowledgeManager.readCatalogStrict(dir).sources).toHaveLength(0);
  });
});

describe('RelationshipManager.delete / mergeRelationships write deletion intents', () => {
  function mgr(stateDir: string | undefined, relDir: string) {
    return new RelationshipManager({ relationshipsDir: relDir, maxRecentInteractions: 20, ...(stateDir ? { deletionIntentStateDir: stateDir } : {}) });
  }

  it('delete: pending before the file removal, done after; same deletedAt to the hook; no identity', () => {
    const dir = tmp('rel-del');
    const relDir = path.join(dir, 'relationships');
    const rm = mgr(dir, relDir);
    const ch: UserChannel = { type: 'telegram', identifier: '424242' };
    const r = rm.findOrCreate('Ada', ch);
    const key = deriveRelationshipRecordKey([ch])!;
    const deletes: string[] = [];
    rm.setReplicationEmitter({ emitPut: () => {}, emitDelete: (_c, at) => deletes.push(at) });

    const seenAtRemoval: DeletionIntentLine[][] = [];
    const proto = RelationshipManager.prototype as unknown as { deleteFile: (id: string) => void };
    const orig = proto.deleteFile;
    vi.spyOn(proto, 'deleteFile').mockImplementation(function (this: unknown, id: string) {
      seenAtRemoval.push(intentLines(dir, RELATIONSHIP_STORE_KEY));
      return orig.call(this, id);
    });

    expect(rm.delete(r.id)).toBe(true);
    expect(seenAtRemoval[0].map((l) => l.phase)).toEqual(['pending']);
    const lines = intentLines(dir, RELATIONSHIP_STORE_KEY);
    expect(lines.map((l) => l.phase)).toEqual(['pending', 'done']);
    expect(lines.every((l) => l.recordKey === key)).toBe(true);
    expect(JSON.stringify(lines)).not.toContain('424242');
    expect(JSON.stringify(lines)).not.toContain('Ada');
    expect(deletes).toEqual([lines[0].deletedAt]);
    expect(lines[1].deletedAt).toBe(lines[0].deletedAt);
  });

  it('mergeRelationships: the merged record gets pending/done keyed on its OLD channel set', () => {
    const dir = tmp('rel-merge');
    const relDir = path.join(dir, 'relationships');
    const rm = mgr(dir, relDir);
    const a = rm.findOrCreate('Ada', { type: 'telegram', identifier: '1' });
    const mergedCh: UserChannel = { type: 'email', identifier: 'ada@example.com' };
    const b = rm.findOrCreate('Ada L', mergedCh);
    const deletes: string[] = [];
    rm.setReplicationEmitter({ emitPut: () => {}, emitDelete: (_c, at) => deletes.push(at) });
    rm.mergeRelationships(a.id, b.id);
    const lines = intentLines(dir, RELATIONSHIP_STORE_KEY);
    expect(lines.map((l) => l.phase)).toEqual(['pending', 'done']);
    expect(lines[0].recordKey).toBe(deriveRelationshipRecordKey([mergedCh]));
    expect(deletes).toEqual([lines[0].deletedAt]);
  });

  it('no intent when deletionIntentStateDir is absent; delete still works', () => {
    const dir = tmp('rel-nointent');
    const rm = mgr(undefined, path.join(dir, 'relationships'));
    const r = rm.findOrCreate('Bo', { type: 'telegram', identifier: '9' });
    expect(rm.delete(r.id)).toBe(true);
    expect(fs.existsSync(intentLogPath(dir, RELATIONSHIP_STORE_KEY))).toBe(false);
  });

  it('a failing append never fails the delete', () => {
    const dir = tmp('rel-appendfail');
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'reconcile'), 'blocker');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rm = mgr(dir, path.join(dir, 'relationships'));
    const r = rm.findOrCreate('Cy', { type: 'telegram', identifier: '7' });
    expect(rm.delete(r.id)).toBe(true);
    expect(rm.get(r.id)).toBeNull();
  });
});

describe('key-only tombstone builders', () => {
  const h: HlcTimestamp = { physical: 100, logical: 0, node: 'm' };
  const obs: HlcTimestamp = { physical: 90, logical: 0, node: 'p' };

  it('knowledge: FromKey output equals the identity builder and passes the delete schema', () => {
    for (const observed of [undefined, obs]) {
      const byId = buildKnowledgeTombstoneData({ title: 'T', url: 'https://x', type: 'doc', hlc: h, origin: 'm', deletedAt: 'D', observed })!;
      const byKey = buildKnowledgeTombstoneFromKey({ recordKey: deriveKnowledgeRecordKey('T', 'https://x', 'doc')!, hlc: h, origin: 'm', deletedAt: 'D', observed });
      expect(byKey).toEqual(byId);
      const v = validateReplicatedEnvelope(byKey as unknown as Record<string, unknown>, KNOWLEDGE_KIND_REGISTRATION.schema, NOOP);
      expect(v.ok).toBe(true);
      if (v.ok) expect(v.envelope.op).toBe('delete');
    }
  });

  it('relationships: FromKey output equals the identity builder and passes the delete schema', () => {
    const channels: UserChannel[] = [{ type: 'telegram', identifier: '5' }, { type: 'email', identifier: 'a@b.c' }];
    for (const observed of [undefined, obs]) {
      const byId = buildRelationshipTombstoneData({ channels, hlc: h, origin: 'm', deletedAt: '2026-10-02T00:00:00.000Z', observed })!;
      const byKey = buildRelationshipTombstoneFromKey({ recordKey: deriveRelationshipRecordKey(channels)!, hlc: h, origin: 'm', deletedAt: '2026-10-02T00:00:00.000Z', observed });
      expect(byKey).toEqual(byId);
      const v = validateReplicatedEnvelope(byKey as unknown as Record<string, unknown>, RELATIONSHIP_KIND_REGISTRATION.schema, NOOP);
      expect(v.ok).toBe(true);
    }
  });
});

describe('makeGitCarriedProbe', () => {
  const CWD = '/repo';
  const seam = (store: string, p = path.join(CWD, '.instar', 'knowledge', 'catalog.json')): ReconcileStoreSeam =>
    ({ store, paths: [p], snapshot: () => ({ rows: [], skipped: 0, present: true }) });

  function git(opts: { workTree?: boolean; tracked?: string; untracked?: string; failLsFiles?: boolean }) {
    const calls: string[][] = [];
    const runGit = async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'rev-parse') {
        if (opts.workTree === false) throw new Error('fatal: not a git repository');
        return 'true\n';
      }
      if (opts.failLsFiles) throw new Error('git exited 128');
      if (args.includes('--others')) return opts.untracked ?? '';
      return opts.tracked ?? '';
    };
    return { runGit, calls };
  }

  it('tracked ⇒ carried', async () => {
    const g = git({ tracked: '.instar/knowledge/catalog.json\n' });
    const probe = makeGitCarriedProbe({ cwd: CWD, gitSyncActive: () => false, runGit: g.runGit, watchFiles: [] });
    expect(await probe(seam('knowledge'))).toBe('carried');
  });

  it('untracked + not ignored + git-sync active ⇒ carried; with no git-sync ⇒ local', async () => {
    const g = git({ untracked: '.instar/knowledge/catalog.json\n' });
    let active = true;
    const probe = makeGitCarriedProbe({ cwd: CWD, gitSyncActive: () => active, runGit: g.runGit, watchFiles: [] });
    expect(await probe(seam('knowledge'))).toBe('carried');
    active = false; // the git-sync state is part of the cache signature
    expect(await probe(seam('knowledge'))).toBe('local');
  });

  it('untracked but ignored (no --others output) + git-sync ⇒ local', async () => {
    const g = git({ untracked: '' });
    const probe = makeGitCarriedProbe({ cwd: CWD, gitSyncActive: () => true, runGit: g.runGit, watchFiles: [] });
    expect(await probe(seam('knowledge'))).toBe('local');
  });

  it('not a work tree ⇒ local (and never runs ls-files)', async () => {
    const g = git({ workTree: false, tracked: 'x' });
    const probe = makeGitCarriedProbe({ cwd: CWD, gitSyncActive: () => true, runGit: g.runGit, watchFiles: [] });
    expect(await probe(seam('knowledge'))).toBe('local');
    expect(g.calls.some((c) => c[0] === 'ls-files')).toBe(false);
  });

  it('a path outside the work tree ⇒ local', async () => {
    const g = git({ tracked: 'x' });
    const probe = makeGitCarriedProbe({ cwd: CWD, gitSyncActive: () => true, runGit: g.runGit, watchFiles: [] });
    expect(await probe(seam('knowledge', '/elsewhere/catalog.json'))).toBe('local');
  });

  it('any other git error ⇒ probe-failed (the store is skipped and counted), and is not cached', async () => {
    const g = git({ failLsFiles: true });
    const probe = makeGitCarriedProbe({ cwd: CWD, gitSyncActive: () => false, runGit: g.runGit, watchFiles: [] });
    expect(await probe(seam('knowledge'))).toBe('probe-failed');
    const n = g.calls.length;
    expect(await probe(seam('knowledge'))).toBe('probe-failed');
    expect(g.calls.length).toBeGreaterThan(n);
  });

  it('caches a verdict until the watched files change (steady state spawns no git)', async () => {
    const dir = tmp('git-watch');
    const index = path.join(dir, 'index');
    fs.writeFileSync(index, 'a');
    const g = git({ tracked: 'yes' });
    const probe = makeGitCarriedProbe({ cwd: CWD, gitSyncActive: () => false, runGit: g.runGit, watchFiles: [index] });
    await probe(seam('knowledge'));
    const n = g.calls.length;
    await probe(seam('knowledge'));
    expect(g.calls.length).toBe(n);
    fs.utimesSync(index, new Date(), new Date(Date.now() + 10_000));
    await probe(seam('knowledge'));
    expect(g.calls.length).toBeGreaterThan(n);
  });
});
