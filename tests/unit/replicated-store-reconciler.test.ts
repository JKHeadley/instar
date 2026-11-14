/**
 * Unit — ReplicatedStoreReconciler decision table (spec:
 * docs/specs/statesync-writer-agnostic-reconciler.md §4 + "## Testing").
 *
 * Drives the real class with: the REAL ReplicatedRecordEmitter over a fake journal
 * seam whose outcome is controllable (so observers fire exactly on `accepted`), a
 * deterministic monotonic HLC fake shared by emitter + reconciler, a fake own-stream
 * reader, a fake knowledge seam (rows / intents under test control), an injected
 * `now()` and `setTimer`. `tick()` is called directly.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';

import {
  ReplicatedStoreReconciler,
  type ReconcileConfig,
  type ReconcileRow,
  type ReconcileStoreSeam,
  type GitCarriedVerdict,
} from '../../src/core/ReplicatedStoreReconciler.js';
import { ReplicatedRecordEmitter } from '../../src/core/ReplicatedRecordEmitter.js';
import type { JournalEmitOutcome } from '../../src/core/CoherenceJournal.js';
import {
  ReplicatedKindRegistry,
  validateReplicatedEnvelope,
  type StateSyncStores,
} from '../../src/core/ReplicatedRecordEnvelope.js';
import {
  KNOWLEDGE_KIND_REGISTRATION,
  KNOWLEDGE_STORE_KEY,
  buildKnowledgeRecordData,
  buildKnowledgeTombstoneFromKey,
  deriveKnowledgeRecordKey,
} from '../../src/core/KnowledgeReplicatedStore.js';
import type { OwnOriginRecord } from '../../src/core/ReplicatedPeerStreamReader.js';
import type { DeletionIntentLine, DeletionIntentScan } from '../../src/core/DeletionIntentLog.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import type { KnowledgeSource } from '../../src/knowledge/KnowledgeManager.js';
import { stableJson } from '../../src/core/stableJson.js';

const ORIGIN = 'm_self';
const NOOP = { bumpSchemaReject: () => {}, bumpDroppedField: () => {}, bumpJailReject: () => {} };

function hlc(physical: number, logical = 0): HlcTimestamp {
  return { physical, logical, node: ORIGIN };
}

/** Monotonic deterministic HLC (tick only). */
class FakeClock {
  constructor(public physical = 1_000) {}
  tick(): HlcTimestamp {
    return hlc(this.physical++);
  }
}

function src(title: string, extra: Partial<KnowledgeSource> = {}): KnowledgeSource {
  return {
    id: `id-${title}`,
    title,
    url: `https://example.com/${encodeURIComponent(title)}`,
    type: 'article',
    ingestedAt: '2026-10-01T00:00:00.000Z',
    filePath: `articles/${title}.md`,
    tags: [],
    summary: '',
    wordCount: 1,
    ...extra,
  };
}

function keyOf(s: KnowledgeSource): string {
  return deriveKnowledgeRecordKey(s.title, s.url, s.type)!;
}

function rowOf(s: KnowledgeSource): ReconcileRow {
  return {
    recordKey: keyOf(s),
    sourceFp: createHash('sha256').update(stableJson(s)).digest('hex'),
    build: (h, o, observed) => buildKnowledgeRecordData({ record: s, hlc: h, origin: o, observed }),
  };
}

/** The validated store fields the own stream would hold for `s`. */
function fieldsOf(s: KnowledgeSource): Record<string, unknown> {
  const v = validateReplicatedEnvelope(
    buildKnowledgeRecordData({ record: s, hlc: hlc(1), origin: ORIGIN })!,
    KNOWLEDGE_KIND_REGISTRATION.schema,
    NOOP,
  );
  if (!v.ok) throw new Error('fixture does not validate');
  return v.storeFields;
}

function scanOf(lines: DeletionIntentLine[]): DeletionIntentScan {
  const newest = new Map<string, DeletionIntentLine>();
  const pending = new Map<string, DeletionIntentLine>();
  for (const l of lines) {
    newest.set(l.recordKey, l);
    const op = `${l.recordKey}\u0000${l.deletedAt}`;
    if (l.phase === 'pending') pending.set(op, l);
    else pending.delete(op);
  }
  return { newest, pendingOnly: [...pending.values()], bytes: 100 };
}

interface Harness {
  rec: ReplicatedStoreReconciler;
  emitter: ReplicatedRecordEmitter;
  clock: FakeClock;
  journal: { outcome: JournalEmitOutcome | undefined; appended: Record<string, unknown>[] };
  disk: { rows: ReconcileRow[]; skipped: number; present: boolean; throwSnapshot: boolean; intents: DeletionIntentLine[] };
  cfg: ReconcileConfig;
  flags: StateSyncStores;
  seed: Map<string, OwnOriginRecord>;
  setSeedLoader: (fn: () => Promise<Map<string, OwnOriginRecord>>) => void;
  snapshotCalls: () => number;
  gitCalls: () => number;
  git: { verdict: GitCarriedVerdict; impl?: () => Promise<GitCarriedVerdict> };
  nowRef: { t: number };
  degradations: Array<{ reason: string; impact: string }>;
  attention: Array<{ key: string; title: string; body: string }>;
  timers: Array<{ fn: () => void; ms: number }>;
  puts: () => Record<string, unknown>[];
  tombs: () => Record<string, unknown>[];
}

function harness(opts: {
  putsOnly?: boolean;
  cfg?: ReconcileConfig;
  flags?: StateSyncStores;
  snapshotHook?: () => void;
  buildEmitter?: boolean;
} = {}): Harness {
  const registry = new ReplicatedKindRegistry();
  registry.register(KNOWLEDGE_KIND_REGISTRATION);
  const clock = new FakeClock();
  const journal = { outcome: 'accepted' as JournalEmitOutcome | undefined, appended: [] as Record<string, unknown>[] };
  const flags: StateSyncStores = opts.flags ?? { knowledge: { enabled: true } };
  const emitter = new ReplicatedRecordEmitter({
    journal: {
      emitReplicatedRecord: (_kind, data) => {
        journal.appended.push(data);
        return journal.outcome;
      },
    },
    clock,
    registry,
    origin: ORIGIN,
    stores: () => flags,
    loadWitness: () => {
      throw new Error('the reconciler must never read the witness');
    },
  });
  const disk = { rows: [] as ReconcileRow[], skipped: 0, present: true, throwSnapshot: false, intents: [] as DeletionIntentLine[] };
  const seed = new Map<string, OwnOriginRecord>();
  let seedLoader: () => Promise<Map<string, OwnOriginRecord>> = async () => seed;
  let snapshotCalls = 0;
  let gitCalls = 0;
  const git: Harness['git'] = { verdict: 'local' };
  const seam: ReconcileStoreSeam = {
    store: KNOWLEDGE_STORE_KEY,
    paths: ['/tmp/knowledge/catalog.json'],
    snapshot: () => {
      snapshotCalls++;
      if (disk.throwSnapshot) throw new Error('corrupt');
      opts.snapshotHook?.();
      return { rows: [...disk.rows], skipped: disk.skipped, present: disk.present };
    },
    ...(opts.putsOnly
      ? {}
      : {
          deletionIntents: async () => scanOf(disk.intents),
          tombstoneFromKey: (recordKey: string, deletedAt: string) => (h: HlcTimestamp, o: string, observed?: HlcTimestamp) =>
            buildKnowledgeTombstoneFromKey({ recordKey, deletedAt, hlc: h, origin: o, observed }),
        }),
  };
  const cfg: ReconcileConfig = opts.cfg ?? {};
  const nowRef = { t: 1_800_000_000_000 };
  const degradations: Harness['degradations'] = [];
  const attention: Harness['attention'] = [];
  const timers: Harness['timers'] = [];
  const rec = new ReplicatedStoreReconciler({
    emitter,
    reader: { loadOwnOriginRecordsAsync: () => seedLoader() },
    registry,
    origin: ORIGIN,
    stores: () => flags,
    seams: [seam],
    gitCarried: () => {
      gitCalls++;
      return git.impl ? git.impl() : Promise.resolve(git.verdict);
    },
    config: () => cfg,
    attention: (key, title, body) => attention.push({ key, title, body }),
    degradation: (reason, impact) => degradations.push({ reason, impact }),
    now: () => nowRef.t,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return {};
    },
  });
  return {
    rec, emitter, clock, journal, disk, cfg, flags, seed,
    setSeedLoader: (fn) => { seedLoader = fn; },
    snapshotCalls: () => snapshotCalls,
    gitCalls: () => gitCalls,
    git, nowRef, degradations, attention, timers,
    puts: () => journal.appended.filter((d) => d.op === 'put'),
    tombs: () => journal.appended.filter((d) => d.op === 'delete'),
  };
}

function status(h: Harness): Record<string, any> {
  return (h.rec.getStatus().stores as Record<string, any>)[KNOWLEDGE_STORE_KEY];
}

function done(key: string, deletedAt: string, floor: HlcTimestamp | null): DeletionIntentLine {
  return { recordKey: key, deletedAt, phase: 'done', hlcFloor: floor };
}
function pending(key: string, deletedAt: string): DeletionIntentLine {
  return { recordKey: key, deletedAt, phase: 'pending' };
}

afterEach(() => {
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('construction (wiring integrity)', () => {
  it('refuses a seam with deletionIntents but no tombstoneFromKey, and an unregistered store', () => {
    const h = harness();
    const base = {
      emitter: h.emitter,
      reader: { loadOwnOriginRecordsAsync: async () => new Map() },
      registry: (() => { const r = new ReplicatedKindRegistry(); r.register(KNOWLEDGE_KIND_REGISTRATION); return r; })(),
      origin: ORIGIN,
      stores: () => ({}),
      gitCarried: async () => 'local' as const,
      config: () => ({}),
    };
    expect(() => new ReplicatedStoreReconciler({
      ...base,
      seams: [{ store: KNOWLEDGE_STORE_KEY, paths: [], snapshot: () => ({ rows: [], skipped: 0, present: false }), deletionIntents: async () => scanOf([]) }],
    })).toThrow(/tombstoneFromKey/);
    expect(() => new ReplicatedStoreReconciler({
      ...base,
      seams: [{ store: 'nope', paths: [], snapshot: () => ({ rows: [], skipped: 0, present: false }) }],
    })).toThrow(/not registered/);
    expect(() => new ReplicatedStoreReconciler({ ...base, reader: {} as never, seams: [] })).toThrow(/loadOwnOriginRecordsAsync/);
  });

  it('fences against the emitter clock (the same instance)', () => {
    const h = harness();
    expect(h.rec.clock).toBe(h.emitter.clock);
  });
});

describe('puts', () => {
  it('a key absent from the own stream emits with observed:null (no witness read), and only once', async () => {
    const h = harness();
    const s = src('alpha');
    h.disk.rows = [rowOf(s)];
    await h.rec.tick();
    expect(h.puts()).toHaveLength(1);
    expect(h.puts()[0].observed).toBeUndefined();
    expect(h.puts()[0].recordKey).toBe(keyOf(s));
    expect(status(h).emittedPuts).toBe(1);
    await h.rec.tick();
    await h.rec.tick();
    expect(h.puts()).toHaveLength(1);
    expect(status(h).unchanged).toBe(2);
  });

  it('an unchanged row skips after the seed', async () => {
    const h = harness();
    const s = src('alpha');
    h.seed.set(keyOf(s), { op: 'put', hlc: hlc(5), storeFields: fieldsOf(s) });
    h.disk.rows = [rowOf(s)];
    await h.rec.tick();
    await h.rec.tick();
    expect(h.journal.appended).toHaveLength(0);
    expect(status(h).unchanged).toBe(2);
    expect(status(h).seeded).toBe(true);
  });

  it('an in-process hook emit reported by the observer makes the row unchanged', async () => {
    const h = harness();
    const s = src('alpha');
    await h.rec.tick(); // seeds (empty)
    // The in-process manager hook emits through the same emitter.
    h.emitter.emit(KNOWLEDGE_STORE_KEY, keyOf(s), rowOf(s).build);
    expect(h.journal.appended).toHaveLength(1);
    h.disk.rows = [rowOf(s)];
    await h.rec.tick();
    expect(h.journal.appended).toHaveLength(1);
    expect(status(h).unchanged).toBe(1);
  });

  it('a changed row emits', async () => {
    const h = harness();
    const s = src('alpha');
    h.seed.set(keyOf(s), { op: 'put', hlc: hlc(5), storeFields: fieldsOf(s) });
    h.disk.rows = [rowOf({ ...s, summary: 'edited by the CLI' })];
    await h.rec.tick();
    expect(h.puts()).toHaveLength(1);
    expect(h.puts()[0].summary).toBe('edited by the CLI');
  });

  it('`unconfirmed` (void journal seam) is transient: nothing cached, retried next tick', async () => {
    const h = harness();
    h.journal.outcome = undefined;
    h.disk.rows = [rowOf(src('alpha'))];
    await h.rec.tick();
    expect(h.journal.appended).toHaveLength(1);
    expect(status(h).transient).toBe(1);
    expect(status(h).backlog).toBe(1);
    h.journal.outcome = 'accepted';
    await h.rec.tick();
    expect(h.journal.appended).toHaveLength(2);
    expect(status(h).emittedPuts).toBe(1);
    await h.rec.tick();
    expect(h.journal.appended).toHaveLength(2);
  });

  it.each(['rate-limited', 'locked-out', 'deduped'] as JournalEmitOutcome[])('transient outcome %s caches nothing and retries', async (outcome) => {
    const h = harness();
    h.journal.outcome = outcome;
    h.disk.rows = [rowOf(src('alpha'))];
    await h.rec.tick();
    await h.rec.tick();
    expect(h.journal.appended).toHaveLength(2);
    expect(status(h).transient).toBe(2);
    expect(status(h).lastError).toBe('emit-transient');
  });

  it('a content failure (schema/oversize) is not retried until the disk row changes', async () => {
    const h = harness();
    h.journal.outcome = 'schema-rejected';
    const s = src('alpha');
    h.disk.rows = [rowOf(s)];
    await h.rec.tick();
    await h.rec.tick();
    expect(h.journal.appended).toHaveLength(1);
    expect(status(h).rejected).toBe(1);
    h.journal.outcome = 'accepted';
    h.disk.rows = [rowOf({ ...s, summary: 'fixed' })];
    await h.rec.tick();
    expect(h.journal.appended).toHaveLength(2);
    expect(status(h).emittedPuts).toBe(1);
  });

  it('a builder throw (over-cap row) is a content failure; corrected row is retried at once with no restart', async () => {
    const h = harness();
    const s = src('alpha');
    const bad: ReconcileRow = { recordKey: keyOf(s), sourceFp: 'raw-oversize', build: () => { throw new Error('over cap'); } };
    h.disk.rows = [bad];
    await h.rec.tick();
    await h.rec.tick();
    expect(h.journal.appended).toHaveLength(0);
    expect(status(h).rejected).toBe(1);
    expect(h.degradations.filter((d) => /could not be built/.test(d.reason))).toHaveLength(1);
    h.disk.rows = [rowOf(s)];
    await h.rec.tick();
    expect(h.puts()).toHaveLength(1);
  });

  it('a post-emit fingerprint mismatch suppresses the key and writes one degradation row', async () => {
    const h = harness();
    const s = src('alpha');
    let n = 0;
    const flaky: ReconcileRow = {
      recordKey: keyOf(s),
      sourceFp: 'raw-a',
      build: (hh, o, obs) => buildKnowledgeRecordData({ record: { ...s, summary: `v${n++}` }, hlc: hh, origin: o, observed: obs }),
    };
    h.disk.rows = [flaky];
    await h.rec.tick();
    expect(h.puts()).toHaveLength(1);
    expect(status(h).fpMismatch).toBe(1);
    expect(status(h).suppressedKeys).toBe(1);
    await h.rec.tick();
    await h.rec.tick();
    expect(h.puts()).toHaveLength(1);
    expect(h.degradations.filter((d) => /fingerprint differs/.test(d.reason))).toHaveLength(1);
  });

  it('a duplicate key with different content is not emitted and still counts as present (no tombstone)', async () => {
    const h = harness();
    const s = src('alpha');
    h.seed.set(keyOf(s), { op: 'put', hlc: hlc(5), storeFields: fieldsOf(s) });
    h.disk.rows = [rowOf({ ...s, summary: 'one' }), rowOf({ ...s, summary: 'two' })];
    h.disk.intents = [done(keyOf(s), '2026-10-02T00:00:00.000Z', hlc(900))];
    await h.rec.tick();
    expect(h.journal.appended).toHaveLength(0);
    expect(status(h).duplicateKey).toBe(1);
    // Later the row is gone: the retired intent never fires.
    h.disk.rows = [];
    await h.rec.tick();
    expect(h.tombs()).toHaveLength(0);
  });

  it('a row whose cache entry is newer than the tick fence t0 is skipped', async () => {
    const h = harness();
    const s = src('alpha');
    h.seed.set(keyOf(s), { op: 'put', hlc: hlc(10_000_000), storeFields: fieldsOf(s) });
    h.disk.rows = [rowOf({ ...s, summary: 'older disk content' })];
    await h.rec.tick();
    expect(h.journal.appended).toHaveLength(0);
    expect(status(h).staleRowSkipped).toBe(1);
  });
});

describe('resurrection guard', () => {
  it('holds an identical re-appearance of a deleted row', async () => {
    const h = harness();
    const s = src('alpha');
    h.seed.set(keyOf(s), { op: 'delete', hlc: hlc(5), storeFields: { deletedAt: 'x' }, lastPutFields: fieldsOf(s) });
    h.disk.rows = [rowOf(s)];
    await h.rec.tick();
    expect(h.journal.appended).toHaveLength(0);
    expect(status(h).resurrectionHeld).toBe(1);
  });

  it('holds any re-appearance when the content at delete is unknown', async () => {
    const h = harness();
    const s = src('alpha');
    h.seed.set(keyOf(s), { op: 'delete', hlc: hlc(5), storeFields: { deletedAt: 'x' } });
    h.disk.rows = [rowOf({ ...s, summary: 'anything' })];
    await h.rec.tick();
    expect(h.journal.appended).toHaveLength(0);
    expect(status(h).resurrectionHeld).toBe(1);
  });

  it('lets a changed re-appearance through', async () => {
    const h = harness();
    const s = src('alpha');
    h.seed.set(keyOf(s), { op: 'delete', hlc: hlc(5), storeFields: { deletedAt: 'x' }, lastPutFields: fieldsOf(s) });
    h.disk.rows = [rowOf({ ...s, summary: 're-ingested, new content' })];
    await h.rec.tick();
    expect(h.puts()).toHaveLength(1);
  });

  it('an observer delete that lands during the seed survives the seed (older seed put does not overwrite it)', async () => {
    const h = harness();
    const s = src('alpha');
    let release!: (m: Map<string, OwnOriginRecord>) => void;
    h.setSeedLoader(() => new Promise((r) => { release = r; }));
    h.disk.rows = [rowOf(s)];
    const t = h.rec.tick();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    // The in-process hook deletes the record while the seed is reading.
    h.emitter.emit(KNOWLEDGE_STORE_KEY, keyOf(s), (hh, o, obs) =>
      buildKnowledgeTombstoneFromKey({ recordKey: keyOf(s), deletedAt: '2026-10-02T00:00:00.000Z', hlc: hh, origin: o, observed: obs }));
    release(new Map([[keyOf(s), { op: 'put', hlc: hlc(2), storeFields: fieldsOf(s) }]]));
    await t;
    expect(h.puts()).toHaveLength(0);
    expect(status(h).resurrectionHeld).toBe(1);
    expect(status(h).unchanged).toBe(0);
  });
});

describe('deletions (explicit intents only)', () => {
  const AT = '2026-10-02T00:00:00.000Z';

  it('a row that vanishes without an intent is never tombstoned (counted absentNoIntent)', async () => {
    const h = harness();
    const s = src('alpha');
    h.seed.set(keyOf(s), { op: 'put', hlc: hlc(5), storeFields: fieldsOf(s) });
    h.disk.rows = [];
    await h.rec.tick();
    await h.rec.tick();
    expect(h.tombs()).toHaveLength(0);
    expect(status(h).absentNoIntent).toBe(1);
  });

  it('done intent + older own put + complete absence ⇒ tombstone {recordKey, deletedAt} observed:null; then inert', async () => {
    const h = harness();
    const s = src('alpha');
    h.seed.set(keyOf(s), { op: 'put', hlc: hlc(5), storeFields: fieldsOf(s) });
    h.disk.intents = [pending(keyOf(s), AT), done(keyOf(s), AT, hlc(50))];
    await h.rec.tick();
    expect(h.tombs()).toHaveLength(1);
    const t = h.tombs()[0];
    expect(t.recordKey).toBe(keyOf(s));
    expect(t.deletedAt).toBe(AT);
    expect(t.observed).toBeUndefined();
    expect(t.title).toBeUndefined();
    expect(status(h).emittedTombstones).toBe(1);
    await h.rec.tick();
    expect(h.tombs()).toHaveLength(1);
  });

  it('an intent whose hlcFloor is older than the own put is inert', async () => {
    const h = harness();
    const s = src('alpha');
    h.seed.set(keyOf(s), { op: 'put', hlc: hlc(500), storeFields: fieldsOf(s) });
    h.disk.intents = [done(keyOf(s), AT, hlc(400))];
    await h.rec.tick();
    expect(h.tombs()).toHaveLength(0);
  });

  it('a put newer than hlcFloor makes the intent inert even with the wall clock moved backwards', async () => {
    const h = harness();
    const s = src('alpha');
    h.seed.set(keyOf(s), { op: 'put', hlc: hlc(500), storeFields: fieldsOf(s) });
    // deletedAt (wall clock) is LATER than anything; floor is older than the put.
    h.disk.intents = [done(keyOf(s), '2099-01-01T00:00:00.000Z', hlc(499, 7))];
    h.nowRef.t = 1_000; // the machine wall clock jumped backwards
    await h.rec.tick();
    expect(h.tombs()).toHaveLength(0);
  });

  it('an edit emitted just before the delete still lets the delete fire', async () => {
    const h = harness();
    const s = src('alpha');
    h.disk.rows = [rowOf(s)];
    await h.rec.tick();
    h.disk.rows = [rowOf({ ...s, summary: 'edit' })];
    await h.rec.tick();
    expect(h.puts()).toHaveLength(2);
    // Removal happens now; the floor is the clock as persisted after it.
    h.disk.rows = [];
    h.disk.intents = [pending(keyOf(s), AT), done(keyOf(s), AT, h.clock.tick())];
    await h.rec.tick();
    expect(h.tombs()).toHaveLength(1);
  });

  it('a reconciler put between pending and removal does not invalidate the deletion (floor read after removal)', async () => {
    const h = harness();
    const s = src('alpha');
    h.disk.rows = [rowOf(s)];
    await h.rec.tick();
    h.disk.intents = [pending(keyOf(s), AT)];
    h.disk.rows = [rowOf({ ...s, summary: 'edited mid-delete' })];
    await h.rec.tick(); // put lands between pending and removal
    expect(h.puts()).toHaveLength(2);
    h.disk.rows = [];
    h.disk.intents = [pending(keyOf(s), AT), done(keyOf(s), AT, h.clock.tick())];
    await h.rec.tick();
    expect(h.tombs()).toHaveLength(1);
  });

  it('an intent whose row is still on disk does nothing (crash between append and removal)', async () => {
    const h = harness();
    const s = src('alpha');
    h.seed.set(keyOf(s), { op: 'put', hlc: hlc(5), storeFields: fieldsOf(s) });
    h.disk.rows = [rowOf(s)];
    h.disk.intents = [done(keyOf(s), AT, hlc(50))];
    await h.rec.tick();
    expect(h.tombs()).toHaveLength(0);
  });

  it('an intent retired by a later sighting of the row does not fire after the row is lost', async () => {
    const h = harness();
    const s = src('alpha');
    h.seed.set(keyOf(s), { op: 'put', hlc: hlc(5), storeFields: fieldsOf(s) });
    h.disk.rows = [rowOf(s)];
    h.disk.intents = [done(keyOf(s), AT, hlc(50))];
    await h.rec.tick();
    h.disk.rows = []; // e.g. a lost update by a racing writer
    await h.rec.tick();
    expect(h.tombs()).toHaveLength(0);
  });

  it('a pending-only intent never fires', async () => {
    const h = harness();
    const s = src('alpha');
    h.seed.set(keyOf(s), { op: 'put', hlc: hlc(5), storeFields: fieldsOf(s) });
    h.disk.intents = [pending(keyOf(s), AT)];
    await h.rec.tick();
    await h.rec.tick();
    expect(h.tombs()).toHaveLength(0);
  });

  it('a pending intent seen with its row present is NOT retired and fires after `done`', async () => {
    const h = harness();
    const s = src('alpha');
    h.seed.set(keyOf(s), { op: 'put', hlc: hlc(5), storeFields: fieldsOf(s) });
    h.disk.rows = [rowOf(s)];
    h.disk.intents = [pending(keyOf(s), AT)];
    await h.rec.tick();
    h.disk.rows = [];
    h.disk.intents = [pending(keyOf(s), AT), done(keyOf(s), AT, hlc(50))];
    await h.rec.tick();
    expect(h.tombs()).toHaveLength(1);
  });

  it('hlcFloor:null (missing pointer / missing or corrupt clock) never fires and is counted', async () => {
    const h = harness();
    const s = src('alpha');
    h.seed.set(keyOf(s), { op: 'put', hlc: hlc(5), storeFields: fieldsOf(s) });
    h.disk.intents = [done(keyOf(s), AT, null)];
    await h.rec.tick();
    expect(h.tombs()).toHaveLength(0);
    expect(status(h).intentNoClock).toBe(1);
  });

  it('a tombstone dropped before flush re-fires after a restart (the entry is a put again)', async () => {
    const s = src('alpha');
    const intents = [done(keyOf(s), AT, hlc(50))];
    const h1 = harness();
    h1.seed.set(keyOf(s), { op: 'put', hlc: hlc(5), storeFields: fieldsOf(s) });
    h1.disk.intents = intents;
    await h1.rec.tick();
    expect(h1.tombs()).toHaveLength(1);
    // Process dies before the flusher wrote the tombstone: the own stream still ends in the put.
    const h2 = harness();
    h2.seed.set(keyOf(s), { op: 'put', hlc: hlc(5), storeFields: fieldsOf(s) });
    h2.disk.intents = intents;
    await h2.rec.tick();
    expect(h2.tombs()).toHaveLength(1);
  });

  it('a re-add during the tick (entry newer than t0) defers the intent', async () => {
    const s = src('alpha');
    let readd = false;
    const h = harness({
      snapshotHook: () => {
        if (!readd) return;
        readd = false;
        h.emitter.emit(KNOWLEDGE_STORE_KEY, keyOf(s), rowOf(s).build);
      },
    });
    h.seed.set(keyOf(s), { op: 'put', hlc: hlc(5), storeFields: fieldsOf(s) });
    h.disk.intents = [done(keyOf(s), AT, hlc(10_000_000))];
    readd = true;
    await h.rec.tick();
    expect(h.tombs()).toHaveLength(0);
    expect(status(h).pendingDeletes).toBe(1);
  });

  it('an incomplete snapshot (skipped rows) defers the intent', async () => {
    const h = harness();
    const s = src('alpha');
    h.seed.set(keyOf(s), { op: 'put', hlc: hlc(5), storeFields: fieldsOf(s) });
    h.disk.intents = [done(keyOf(s), AT, hlc(50))];
    h.disk.skipped = 1;
    await h.rec.tick();
    expect(h.tombs()).toHaveLength(0);
    expect(status(h).pendingDeletes).toBe(1);
    h.disk.skipped = 0;
    await h.rec.tick();
    expect(h.tombs()).toHaveLength(1);
  });

  it('an absent store (present:false) defers the intent', async () => {
    const h = harness();
    const s = src('alpha');
    h.seed.set(keyOf(s), { op: 'put', hlc: hlc(5), storeFields: fieldsOf(s) });
    h.disk.intents = [done(keyOf(s), AT, hlc(50))];
    h.disk.present = false;
    await h.rec.tick();
    expect(h.tombs()).toHaveLength(0);
  });

  it('a deletion burst larger than the per-tick cap drains over later ticks with no intent lost', async () => {
    const h = harness({ cfg: { maxTombstonesPerTick: 2 } });
    const keys: string[] = [];
    for (let i = 0; i < 5; i++) {
      const s = src(`doc-${i}`);
      keys.push(keyOf(s));
      h.seed.set(keyOf(s), { op: 'put', hlc: hlc(5 + i), storeFields: fieldsOf(s) });
      h.disk.intents.push(done(keyOf(s), AT, hlc(50)));
    }
    await h.rec.tick();
    expect(h.tombs()).toHaveLength(2);
    expect(status(h).backlog).toBe(3);
    await h.rec.tick();
    expect(h.tombs()).toHaveLength(4);
    await h.rec.tick();
    expect(h.tombs()).toHaveLength(5);
    expect(status(h).backlog).toBe(0);
    expect(new Set(h.tombs().map((t) => t.recordKey))).toEqual(new Set(keys));
  });

  it('the tombstone carries exactly the intent key (no identity re-derivation)', async () => {
    const h = harness();
    h.seed.set('opaque-key-1', { op: 'put', hlc: hlc(5), storeFields: fieldsOf(src('zzz')) });
    h.disk.intents = [done('opaque-key-1', AT, hlc(50))];
    await h.rec.tick();
    expect(h.tombs().map((t) => t.recordKey)).toEqual(['opaque-key-1']);
  });
});

describe('gates', () => {
  it('store dryRun counts wouldEmit / wouldTombstone and emits nothing', async () => {
    const h = harness({ flags: { knowledge: { enabled: true, dryRun: true } } });
    const s = src('alpha');
    const gone = src('gone');
    h.seed.set(keyOf(gone), { op: 'put', hlc: hlc(5), storeFields: fieldsOf(gone) });
    h.disk.rows = [rowOf(s)];
    h.disk.intents = [done(keyOf(gone), '2026-10-02T00:00:00.000Z', hlc(50))];
    await h.rec.tick();
    expect(h.journal.appended).toHaveLength(0);
    expect(status(h).wouldEmit).toBe(1);
    expect(status(h).wouldTombstone).toBe(1);
    expect(status(h).dryRun).toBe(true);
  });

  it('a puts-only store never tombstones', async () => {
    const h = harness({ putsOnly: true });
    const s = src('alpha');
    h.seed.set(keyOf(s), { op: 'put', hlc: hlc(5), storeFields: fieldsOf(s) });
    await h.rec.tick();
    expect(h.tombs()).toHaveLength(0);
    expect(status(h).putsOnly).toBe(true);
  });

  it('a git-carried store reads nothing', async () => {
    const h = harness();
    h.git.verdict = 'carried';
    h.disk.rows = [rowOf(src('alpha'))];
    await h.rec.tick();
    expect(h.snapshotCalls()).toBe(0);
    expect(h.journal.appended).toHaveLength(0);
    expect(status(h).gitCarried).toBe(true);
  });

  it('a git probe failure reads nothing and is counted', async () => {
    const h = harness();
    h.git.verdict = 'probe-failed';
    await h.rec.tick();
    expect(h.snapshotCalls()).toBe(0);
    expect(status(h).gitProbeFailed).toBe(1);
    expect(status(h).lastError).toBe('git-check-failed');
  });

  it('a dark store reads nothing (no git probe, no snapshot)', async () => {
    const h = harness({ flags: { knowledge: { enabled: false } } });
    await h.rec.tick();
    expect(h.gitCalls()).toBe(0);
    expect(h.snapshotCalls()).toBe(0);
  });

  it('multiMachine.reconcile.enabled:false stops the tick', async () => {
    const h = harness({ cfg: { enabled: false } });
    h.disk.rows = [rowOf(src('alpha'))];
    await h.rec.tick();
    expect(h.gitCalls()).toBe(0);
    expect(h.journal.appended).toHaveLength(0);
  });

  it('a corrupt store snapshot (throw) emits nothing and is never read as empty', async () => {
    const h = harness();
    const s = src('alpha');
    h.seed.set(keyOf(s), { op: 'put', hlc: hlc(5), storeFields: fieldsOf(s) });
    h.disk.intents = [done(keyOf(s), '2026-10-02T00:00:00.000Z', hlc(50))];
    h.disk.throwSnapshot = true;
    await h.rec.tick();
    expect(h.journal.appended).toHaveLength(0);
    expect(status(h).snapshotFailed).toBe(1);
    expect(status(h).lastError).toBe('snapshot-unreadable');
  });
});

describe('caps, cadence and the tick lock', () => {
  it('caps emits per tick, carries the rest over, and schedules a 60 s drain while backlogged', async () => {
    const h = harness({ cfg: { maxEmitsPerTick: 2 } });
    h.disk.rows = [0, 1, 2, 3, 4].map((i) => rowOf(src(`doc-${i}`)));
    h.rec.start();
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0].ms).toBe(90_000);
    h.timers[0].fn();
    await vi.waitFor(() => expect(h.timers).toHaveLength(2));
    expect(h.puts()).toHaveLength(2);
    expect(status(h).backlog).toBe(3);
    expect(h.timers[1].ms).toBe(60_000);
    h.timers[1].fn();
    await vi.waitFor(() => expect(h.timers).toHaveLength(3));
    expect(h.puts()).toHaveLength(4);
    expect(h.timers[2].ms).toBe(60_000);
    h.timers[2].fn();
    await vi.waitFor(() => expect(h.timers).toHaveLength(4));
    expect(h.puts()).toHaveLength(5);
    expect(status(h).backlog).toBe(0);
    expect(h.timers[3].ms).toBe(600_000); // back to the default interval
    h.rec.stop();
  });

  it('a tick past 5 minutes reports once and keeps its lock (a second tick is a no-op)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = harness();
    let releaseGit!: (v: GitCarriedVerdict) => void;
    h.git.impl = () => new Promise((r) => { releaseGit = r; });
    const first = h.rec.tick();
    // gitCarried is reached synchronously inside tick() (before its first await).
    expect(releaseGit).toBeTypeOf('function');
    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect(h.degradations.filter((d) => /longer than 5 minutes/.test(d.reason))).toHaveLength(1);
    await h.rec.tick(); // still running ⇒ returns at once
    expect(h.gitCalls()).toBe(1);
    // Back to real timers before letting the tick finish: its row loop yields via setImmediate.
    vi.useRealTimers();
    releaseGit('local');
    h.git.impl = undefined;
    await first;
    await h.rec.tick();
    expect(h.gitCalls()).toBe(2);
  });
});

describe('sustained-failure breaker', () => {
  it('opens at failure 3, backs off capped at 60 min, parks after 24 h at the cap with one attention + one degradation', async () => {
    const h = harness({ cfg: { intervalMs: 60_000 } });
    h.disk.throwSnapshot = true;
    const MIN = 60_000;

    await h.rec.tick();
    await h.rec.tick();
    expect(status(h).breakerOpenUntil).toBeNull();
    await h.rec.tick(); // failure 3 ⇒ breaker
    const until = Date.parse(status(h).breakerOpenUntil);
    expect(until - h.nowRef.t).toBe(2 * MIN); // interval × 2^1

    // While open: no read at all.
    const callsBefore = h.snapshotCalls();
    h.nowRef.t += MIN;
    await h.rec.tick();
    expect(h.snapshotCalls()).toBe(callsBefore);

    // Keep failing; every wait is capped at 60 min.
    let capReachedAt: number | null = null;
    for (let i = 0; i < 60 && !status(h).parked; i++) {
      h.nowRef.t += 61 * MIN;
      await h.rec.tick();
      const open = status(h).breakerOpenUntil;
      if (open) {
        const wait = Date.parse(open) - h.nowRef.t;
        expect(wait).toBeLessThanOrEqual(60 * MIN);
        if (wait === 60 * MIN && capReachedAt === null) capReachedAt = h.nowRef.t;
      }
    }
    expect(capReachedAt).not.toBeNull();
    expect(status(h).parked).toBe(true);
    expect(h.nowRef.t - capReachedAt!).toBeGreaterThanOrEqual(24 * 60 * MIN);
    expect(h.nowRef.t - capReachedAt!).toBeLessThan(24 * 60 * MIN + 62 * MIN);

    expect(h.attention).toHaveLength(1);
    expect(h.attention[0].key).toBe(`reconcile-parked:${KNOWLEDGE_STORE_KEY}`);
    expect(h.degradations).toHaveLength(1);
    expect(h.degradations[0].reason).toMatch(/failed \d+ times in a row/);

    // Parked: no further reads, no further attention, until the config changes.
    const parkedCalls = h.snapshotCalls();
    h.nowRef.t += 2 * 24 * 60 * MIN;
    await h.rec.tick();
    await h.rec.tick();
    expect(h.snapshotCalls()).toBe(parkedCalls);
    expect(h.attention).toHaveLength(1);

    h.cfg.maxEmitsPerTick = 7; // a config change revives it
    h.disk.throwSnapshot = false;
    await h.rec.tick();
    expect(h.snapshotCalls()).toBe(parkedCalls + 1);
    expect(status(h).parked).toBe(false);
  });

  it('a success resets the failure count', async () => {
    const h = harness({ cfg: { intervalMs: 60_000 } });
    h.disk.throwSnapshot = true;
    await h.rec.tick();
    await h.rec.tick();
    h.disk.throwSnapshot = false;
    await h.rec.tick();
    h.disk.throwSnapshot = true;
    await h.rec.tick();
    await h.rec.tick();
    expect(status(h).breakerOpenUntil).toBeNull();
  });
});

describe('observability', () => {
  it('getStatus carries counters only — no record key, title, url or error message', async () => {
    const h = harness();
    const s = src('Secret Person Notes', { url: 'https://private.example.com/very-secret' });
    const gone = src('gone-identity');
    h.seed.set(keyOf(gone), { op: 'put', hlc: hlc(5), storeFields: fieldsOf(gone) });
    h.disk.rows = [rowOf(s)];
    h.disk.intents = [done(keyOf(gone), '2026-10-02T00:00:00.000Z', hlc(50))];
    await h.rec.tick();
    h.disk.throwSnapshot = true;
    await h.rec.tick();
    const json = JSON.stringify(h.rec.getStatus());
    for (const needle of [keyOf(s), keyOf(gone), 'Secret Person', 'very-secret', 'gone-identity', 'corrupt']) {
      expect(json).not.toContain(needle);
    }
    expect(status(h).emittedPuts).toBe(1);
    expect(status(h).emittedTombstones).toBe(1);
  });
});
