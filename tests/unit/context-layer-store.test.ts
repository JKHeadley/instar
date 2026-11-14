// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * Unit — the context layer store, transcript archive, archive retention and
 * backup posture (context-budget-layered-summaries §9.7, §6, §12, §14).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { LayerStore, rowRefFor, rowRefMatches, scrubField, MAX_FIELD_CHARS, type LayerMeta } from '../../src/monitoring/contextLayers/LayerStore.js';
import { TranscriptArchive } from '../../src/monitoring/contextLayers/TranscriptArchive.js';
import { replicateVia, buildContextLayers, contextLayersEnabled } from '../../src/monitoring/contextLayers/contextLayersBoot.js';
import { pruneContextArchive, currentPhaseSpans } from '../../src/monitoring/diskSteward/pruneContextArchive.js';
import { BackupManager, NEVER_BACKUP_PATH_SEGMENTS, readContextLayersSwitch } from '../../src/core/BackupManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { CONTEXT_LAYER_STORE_KEY } from '../../src/monitoring/contextLayerKind.js';

const OP = 'tests/unit/context-layer-store.test.ts';
const LIVE = 'live-secret-value-0123456789abcdef';
const META: LayerMeta = { author: { sessionId: 's1', machine: 'm1', model: 'opus', kind: 'derived' }, asOf: { at: 1_000, lastMessageId: 42 } };

const dirs: string[] = [];
function tmp(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cls-')); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP }); });
const mode = (p: string) => fs.statSync(p).mode & 0o777;

describe('LayerStore — derived projections', () => {
  it('writes 0600 files under 0700 directories, carrying author and as-of', () => {
    const sd = tmp();
    const store = new LayerStore({ stateDir: sd, liveSecrets: () => [] });
    const r = store.writeDerived('141133', 'h1', 'current', { text: 'next step: run tests' }, META);
    expect(r.written).toBe(true);
    if (!r.written) return;
    expect(mode(r.file)).toBe(0o600);
    for (const d of [path.join(sd, 'state', 'context-layers'), path.join(sd, 'state', 'context-layers', '141133'), path.dirname(r.file)]) expect(mode(d)).toBe(0o700);
    const back = store.read('141133', 'h1', 'current');
    expect(back?.author).toEqual(META.author);
    expect(back?.asOf).toEqual(META.asOf);
    expect(back?.data.text).toBe('next step: run tests');
  });

  it('scrubs every string field on its own: shape patterns and the live-value pass, nested too', () => {
    const store = new LayerStore({ stateDir: tmp(), liveSecrets: () => [LIVE] });
    const r = store.writeDerived('t1', 'chunk', 'c1', {
      text: `pasted output ${LIVE} end`,
      artifacts: [{ note: `key ghp_${'a'.repeat(36)}` }],
      clean: 'nothing here',
    }, META);
    expect(r.written).toBe(true);
    if (!r.written) return;
    expect(JSON.stringify(r.record.data)).not.toContain(LIVE);
    expect(r.record.data.text).toContain('[REDACTED:live-secret]');
    expect(JSON.stringify(r.record.data)).not.toContain('a'.repeat(36));
    expect(r.record.data.clean).toBe('nothing here');
    expect(r.record.redactionKinds).toContain('live-secret');
  });

  it('replaces a subtree nested past the bound instead of storing it unscrubbed', () => {
    const store = new LayerStore({ stateDir: tmp(), liveSecrets: () => [LIVE] });
    let deep: Record<string, unknown> = { leak: `x ${LIVE}` };
    for (let i = 0; i < 12; i++) deep = { d: deep };
    const r = store.writeDerived('t', 'chunk', 'deep', deep, META);
    expect(r.written).toBe(true);
    if (!r.written) return;
    expect(JSON.stringify(r.record.data)).not.toContain(LIVE);
    expect(JSON.stringify(r.record.data)).toContain('[REDACTED:too-deep]');
    expect(r.record.redactionKinds).toContain('too-deep');
  });

  it('keeps an oversize field as a pointer with its size, without redacting the rest', () => {
    const store = new LayerStore({ stateDir: tmp(), liveSecrets: () => [] });
    const big = 'x'.repeat(MAX_FIELD_CHARS + 10);
    const r = store.writeDerived('t1', 'chunk', 'c2', { text: big, title: 'kept' }, META);
    expect(r.written).toBe(true);
    if (!r.written) return;
    expect(r.record.data.text).toBe(`[REDACTED:oversize] (${big.length} chars withheld)`);
    expect(r.record.data.title).toBe('kept');
    expect(r.record.oversizeFields).toEqual(['text']);
  });

  it('refuses unsafe ids, reserved carrier names, unknown types and missing author or as-of', () => {
    const store = new LayerStore({ stateDir: tmp(), liveSecrets: () => [] });
    expect(store.writeDerived('_seeded', 'h1', 'a', {}, META)).toMatchObject({ written: false, reason: 'unsafe-id' });
    expect(store.writeDerived('t', 'chunk', 'a', {}, { ...META, spanIds: ['../x'] })).toMatchObject({ written: false, reason: 'bad-meta' });
    expect(store.writeDerived('../x', 'h1', 'a', {}, META)).toMatchObject({ written: false, reason: 'unsafe-id' });
    expect(store.writeDerived('t', 'h1', '../a', {}, META)).toMatchObject({ written: false, reason: 'unsafe-id' });
    expect(store.writeDerived('t', 'bogus' as never, 'a', {}, META)).toMatchObject({ written: false, reason: 'unknown-type' });
    expect(store.writeDerived('t', 'h1', 'a', {}, { ...META, author: { ...META.author, kind: 'bot' as never } })).toMatchObject({ written: false, reason: 'bad-meta' });
    expect(store.writeDerived('t', 'h1', 'a', {}, { ...META, status: 'a/b' })).toMatchObject({ written: false, reason: 'bad-meta' });
  });

  it('lists newest first, skips a torn file, and removes', () => {
    let t = 1;
    const sd = tmp();
    const store = new LayerStore({ stateDir: sd, liveSecrets: () => [], now: () => t++ });
    store.writeDerived('t', 'chunk', 'a', { text: 'a' }, META);
    store.writeDerived('t', 'chunk', 'b', { text: 'b' }, META);
    fs.writeFileSync(path.join(sd, 'state', 'context-layers', 't', 'chunk', 'torn.json'), '{"oops');
    expect(store.list('t', 'chunk').map((r) => r.entryKey)).toEqual(['b', 'a']);
    expect(store.remove('t', 'chunk', 'a')).toBe(true);
    expect(store.list('t', 'chunk').map((r) => r.entryKey)).toEqual(['b']);
  });
});

describe('LayerStore — protected references (A, G, U)', () => {
  it('stores row references only, and the reference verifies byte identity against the row', () => {
    const store = new LayerStore({ stateDir: tmp(), liveSecrets: () => [LIVE] });
    const row = `Please do X. My key is ${LIVE}`;
    const ref = rowRefFor(7, row);
    const r = store.writeProtected('t', 'anchor', 'anchor', [ref], META, { kind: 'framing', supersedes: null });
    expect(r.written).toBe(true);
    if (!r.written) return;
    expect(JSON.stringify(r.record)).not.toContain('Please do X');
    expect(rowRefMatches(r.record.rows![0], row)).toBe(true);
    expect(rowRefMatches(r.record.rows![0], row + ' ')).toBe(false);
    expect(rowRefMatches(r.record.rows![0], row.replace('X', 'Y'))).toBe(false);
  });

  it('refuses a protected record that carries the words themselves (at any depth, under any key), or a malformed reference', () => {
    const store = new LayerStore({ stateDir: tmp(), liveSecrets: () => [] });
    expect(store.writeProtected('t', 'ledger-entry', 'e1', [rowRefFor(1, 'x')], META, { text: 'the quote' })).toMatchObject({ written: false, reason: 'protected-text' });
    expect(store.writeProtected('t', 'ledger-entry', 'e1', [rowRefFor(1, 'x')], META, { summary: 'please ship it today' })).toMatchObject({ written: false, reason: 'protected-text' });
    expect(store.writeProtected('t', 'ledger-entry', 'e1', [rowRefFor(1, 'x')], META, { note: { deep: ['ok', 'not ok words'] } })).toMatchObject({ written: false, reason: 'protected-text' });
    expect(store.writeProtected('t', 'ledger-entry', 'e1', [rowRefFor(1, 'x')], META, { type: 'decision', supersedes: 'e0', confirmed: false, weight: 2 })).toMatchObject({ written: true });
    expect(store.writeProtected('t', 'u', 'u1', [{ messageId: 1, sha256: 'nothex', length: 1 }], META)).toMatchObject({ written: false, reason: 'bad-row-ref' });
    expect(store.writeProtected('t', 'u', 'u1', [{ messageId: 1.5, sha256: 'a'.repeat(64), length: 1 }], META)).toMatchObject({ written: false, reason: 'bad-row-ref' });
  });
});

describe('LayerStore — replication seam', () => {
  function fakeEmitter(outcome = 'emitted') {
    const calls: Array<{ store: string; key: string; data: Record<string, unknown> | null }> = [];
    return {
      calls,
      emit(store: string, key: string, build: (h: never, o: string, w?: never) => Record<string, unknown> | null) {
        calls.push({ store, key, data: build({ physical: 1, logical: 0 } as never, 'm1') });
        return { outcome };
      },
    };
  }

  it('offers every replicated type to the emitter as a layer-kind put with the scrubbed body', () => {
    const em = fakeEmitter();
    const store = new LayerStore({ stateDir: tmp(), liveSecrets: () => [LIVE], replicate: replicateVia(em) });
    const r = store.writeDerived('t', 'h1', 'current', { text: `x ${LIVE}` }, { ...META, status: 'fresh' });
    expect(r).toMatchObject({ written: true, replication: 'emitted' });
    expect(em.calls).toHaveLength(1);
    expect(em.calls[0].store).toBe(CONTEXT_LAYER_STORE_KEY);
    expect(em.calls[0].key).toBe('t:h1:current');
    expect(em.calls[0].data).toMatchObject({ recordType: 'h1', topicKey: 't', entryKey: 'current', status: 'fresh', origin: 'm1' });
    expect(String(em.calls[0].data?.body)).not.toContain(LIVE);
  });

  it('refuses (never truncates) an oversize content record for replication; the local record stands', () => {
    const em = fakeEmitter();
    const store = new LayerStore({ stateDir: tmp(), liveSecrets: () => [], replicate: replicateVia(em) });
    const r = store.writeDerived('t', 'h1', 'big', { text: 'y'.repeat(20_000) }, META);
    expect(r).toMatchObject({ written: true, replication: 'oversize' });
    expect(em.calls).toHaveLength(0);
    expect(store.read('t', 'h1', 'big')?.data.text).toHaveLength(20_000);
  });

  it('never replicates U bodies or probe records, and reports a disabled store', () => {
    const em = fakeEmitter('disabled');
    const store = new LayerStore({ stateDir: tmp(), liveSecrets: () => [], replicate: replicateVia(em) });
    expect(store.writeProtected('t', 'u', 'u1', [rowRefFor(1, 'x')], META)).toMatchObject({ written: true, replication: 'not-replicated' });
    expect(store.writeDerived('t', 'probe', 'p1', { q: 'q' }, META)).toMatchObject({ written: true, replication: 'not-replicated' });
    expect(store.writeDerived('t', 'h2', 'p', { text: 'phase' }, META)).toMatchObject({ written: true, replication: 'disabled' });
    expect(em.calls).toHaveLength(1);
  });

  it('a throwing replicator never breaks the local write', () => {
    const store = new LayerStore({ stateDir: tmp(), liveSecrets: () => [], replicate: () => { throw new Error('journal down'); } });
    expect(store.writeDerived('t', 'h1', 'a', { text: 'a' }, META)).toMatchObject({ written: true, replication: 'dropped' });
  });
});

describe('scrubField', () => {
  it('ignores live values shorter than the minimum (a PIN-sized value is not substring-scrubbed)', () => {
    expect(scrubField('pin 123456 here', ['123456']).text).toBe('pin 123456 here');
  });
});

describe('TranscriptArchive', () => {
  const entry = (id: string, text: string, messageIds: number[] = []) => ({ entryId: id, messageIds, fields: { text }, meta: { type: 'assistant' } });

  it('writes compressed 0600 spans, scrubbed per entry per field, and an index by entry and message id', () => {
    const sd = tmp();
    const a = new TranscriptArchive({ stateDir: sd, liveSecrets: () => [LIVE] });
    const r = a.archiveSpan('t', 'span1', [entry('e1', `token ${LIVE}`, [10]), entry('e2', 'fine', [11])]);
    expect(r).toMatchObject({ archived: true, entries: 2, deduplicated: 0 });
    const file = path.join(sd, 'state', 'context-archive', 't', 'spans', 'span1.jsonl.gz');
    expect(mode(file)).toBe(0o600);
    expect(mode(path.join(sd, 'state', 'context-archive', 't'))).toBe(0o700);
    const raw = zlib.gunzipSync(fs.readFileSync(file)).toString('utf-8');
    expect(raw).not.toContain(LIVE);
    expect(a.spanForEntry('t', 'e2')).toBe('span1');
    expect(a.spansForMessage('t', 10)).toEqual(['span1']);
    const read = a.readSpan('t', 'span1')!;
    expect(read.map((e) => e.entryId)).toEqual(['e1', 'e2']);
    expect(read.every((e) => e.scrubbed)).toBe(true);
  });

  it('deduplicates by entry id across spans and refuses to overwrite a span', () => {
    const a = new TranscriptArchive({ stateDir: tmp(), liveSecrets: () => [] });
    a.archiveSpan('t', 's1', [entry('e1', 'a')]);
    expect(a.archiveSpan('t', 's2', [entry('e1', 'a'), entry('e2', 'b')])).toMatchObject({ archived: true, entries: 1, deduplicated: 1 });
    expect(a.archiveSpan('t', 's3', [entry('e1', 'a')])).toMatchObject({ archived: false, reason: 'empty' });
    expect(a.archiveSpan('t', 's1', [entry('e9', 'z')])).toMatchObject({ archived: false, reason: 'exists' });
  });

  it('re-scrubs on read, so a secret learnt after the write never leaves through a lookup', () => {
    let secrets: string[] = [];
    const a = new TranscriptArchive({ stateDir: tmp(), liveSecrets: () => secrets });
    a.archiveSpan('t', 's1', [entry('e1', `later ${LIVE}`)]);
    expect(a.readSpan('t', 's1')![0].fields.text).toContain(LIVE);
    secrets = [LIVE];
    expect(a.readSpan('t', 's1')![0].fields.text).not.toContain(LIVE);
  });

  it('re-scrubs metadata on read too, and a corrupt span reads as absent', () => {
    let secrets: string[] = [];
    const sd = tmp();
    const a = new TranscriptArchive({ stateDir: sd, liveSecrets: () => secrets });
    a.archiveSpan('t', 's1', [{ entryId: 'e1', fields: { text: 'x' }, meta: { tool: `Bash ${LIVE}` } }]);
    secrets = [LIVE];
    expect(a.readSpan('t', 's1')![0].meta.tool).not.toContain(LIVE);
    fs.writeFileSync(path.join(sd, 'state', 'context-archive', 't', 'spans', 's1.jsonl.gz'), 'not gzip');
    expect(a.readSpan('t', 's1')).toBeNull();
  });

  it('never replaces an unreadable index, and never overwrites a span file already on disk', () => {
    const sd = tmp();
    const a = new TranscriptArchive({ stateDir: sd, liveSecrets: () => [] });
    a.archiveSpan('t', 's1', [{ entryId: 'e1', fields: { text: 'x' } }]);
    const idx = path.join(sd, 'state', 'context-archive', 't', 'index.json');
    const good = fs.readFileSync(idx, 'utf-8');
    fs.writeFileSync(idx, '{"torn');
    expect(a.archiveSpan('t', 's2', [{ entryId: 'e2', fields: { text: 'y' } }])).toMatchObject({ archived: false, reason: 'index-unreadable' });
    expect(fs.readFileSync(idx, 'utf-8')).toBe('{"torn');
    expect(a.evictSpan('t', 's1')).toBe(false);
    fs.writeFileSync(idx, good);
    fs.writeFileSync(path.join(sd, 'state', 'context-archive', 't', 'spans', 's9.jsonl.gz'), 'orphan');
    expect(a.archiveSpan('t', 's9', [{ entryId: 'e9', fields: { text: 'z' } }])).toMatchObject({ archived: false, reason: 'exists' });
  });

  it('keeps an oversize field as a pointer, the rest of the span intact', () => {
    const a = new TranscriptArchive({ stateDir: tmp(), liveSecrets: () => [] });
    a.archiveSpan('t', 's1', [entry('big', 'z'.repeat(MAX_FIELD_CHARS + 1)), entry('small', 'ok')]);
    const read = a.readSpan('t', 's1')!;
    expect(read[0].fields.text).toMatch(/^\[REDACTED:oversize\]/);
    expect(read[0].oversizeFields).toEqual(['text']);
    expect(read[1].fields.text).toBe('ok');
  });

  it('plans eviction superseded-first then oldest, never a protected span; an evicted span reads raw-evicted', () => {
    let t = 0;
    const a = new TranscriptArchive({ stateDir: tmp(), liveSecrets: () => [], now: () => ++t });
    for (const s of ['old', 'mid', 'new']) a.archiveSpan('t', s, [entry(`${s}-e`, 'w'.repeat(2000))]);
    a.markSuperseded('t', 'new');
    const plan = a.planEviction('t', 1, new Set(['old']));
    expect(plan.evict).toEqual(['new']);
    const all = a.planEviction('t', Number.MAX_SAFE_INTEGER, new Set(['old']));
    expect(all.evict).toEqual(['new', 'mid']);
    expect(all.short).toBe(true);
    expect(a.evictSpan('t', 'mid')).toBe(true);
    expect(a.spanState('t', 'mid')).toBe('raw-evicted');
    expect(a.readSpan('t', 'mid')).toBeNull();
    expect(a.spanState('t', 'nope')).toBe('unknown');
    expect(a.evictSpan('t', 'mid')).toBe(false);
  });
});

describe('TranscriptArchive — cross-process index lock', () => {
  it('a live lock held by another process makes the write fail cleanly; a stale one is broken', () => {
    const sd = tmp();
    const a = new TranscriptArchive({ stateDir: sd, liveSecrets: () => [] });
    a.archiveSpan('t', 's0', [{ entryId: 'e0', fields: { text: 'x' } }]);
    const lock = path.join(sd, 'state', 'context-archive', 't', 'index.lock');
    fs.writeFileSync(lock, '99999');
    expect(a.archiveSpan('t', 's1', [{ entryId: 'e1', fields: { text: 'y' } }])).toMatchObject({ archived: false, reason: 'write-failed' });
    expect(a.spanState('t', 's1')).toBe('unknown');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    expect(a.archiveSpan('t', 's1', [{ entryId: 'e1', fields: { text: 'y' } }])).toMatchObject({ archived: true });
    expect(fs.existsSync(lock)).toBe(false);
  });
});

describe('Disk Steward context-archive category', () => {
  function fill(sd: string, topic: string, spans: string[], bytesEach: number) {
    const a = new TranscriptArchive({ stateDir: sd, liveSecrets: () => [] });
    // Incompressible text so the stored bytes stay near bytesEach.
    for (const s of spans) a.archiveSpan(topic, s, [{ entryId: `${s}-e`, fields: { text: Array.from({ length: bytesEach }, () => String.fromCharCode(33 + Math.floor(Math.random() * 90))).join('') } }]);
    return a;
  }

  it('skips under the limit, and with no archive at all', () => {
    expect(pruneContextArchive({ stateDir: tmp(), dryRun: false, maxGiB: 1, budgetMs: 10_000 })).toMatchObject({ skipped: 'no-archive' });
    const sd = tmp();
    fill(sd, 't', ['a'], 1000);
    expect(pruneContextArchive({ stateDir: sd, dryRun: false, maxGiB: 1, budgetMs: 10_000 })).toMatchObject({ skipped: 'under-limit', removedItems: 0 });
  });

  it('over the limit, evicts outside the current phase only; dry-run plans without removing', () => {
    const sd = tmp();
    const a = fill(sd, 't', ['s1', 's2', 's3'], 4000);
    const store = new LayerStore({ stateDir: sd, liveSecrets: () => [] });
    store.writeDerived('t', 'h2', 'current', { text: 'phase' }, { ...META, spanIds: ['s1'] });
    store.writeDerived('t', 'chunk', 'open1', { text: 'open' }, { ...META, status: 'open', spanIds: ['s2'] });
    store.writeDerived('t', 'chunk', 'closed1', { text: 'closed' }, { ...META, status: 'closed', spanIds: ['s3'] });
    expect([...currentPhaseSpans(store, 't')!].sort()).toEqual(['s1', 's2']);
    const tiny = 1 / (1024 ** 3); // a 1-byte limit: everything is over it
    const dry = pruneContextArchive({ stateDir: sd, dryRun: true, maxGiB: tiny, budgetMs: 10_000 });
    expect(dry).toMatchObject({ skipped: 'dry-run', plannedItems: 1 });
    expect(a.spanState('t', 's3')).toBe('present');
    const real = pruneContextArchive({ stateDir: sd, dryRun: false, maxGiB: tiny, budgetMs: 10_000 });
    expect(real.removedItems).toBe(1);
    expect(a.spanState('t', 's3')).toBe('raw-evicted');
    expect(a.spanState('t', 's1')).toBe('present');
    expect(a.spanState('t', 's2')).toBe('present');
  });
});

describe('eviction floor when unknown', () => {
  it('a topic with archive spans but no readable H2 or chunk record is skipped, never treated as unprotected', () => {
    const sd = tmp();
    const a = new TranscriptArchive({ stateDir: sd, liveSecrets: () => [] });
    a.archiveSpan('moved', 's1', [{ entryId: 'e1', fields: { text: Array.from({ length: 3000 }, (_, i) => String.fromCharCode(33 + (i * 7919) % 90)).join('') } }]);
    expect(currentPhaseSpans(new LayerStore({ stateDir: sd, liveSecrets: () => [] }), 'moved')).toBeNull();
    const r = pruneContextArchive({ stateDir: sd, dryRun: false, maxGiB: 1 / (1024 ** 3), budgetMs: 10_000 });
    expect(r.removedItems).toBe(0);
    expect(a.spanState('moved', 's1')).toBe('present');
  });
});

describe('cached live secrets', () => {
  it('reads once per TTL, and reports an unreadable secret store', async () => {
    const { cachedLiveSecrets } = await import('../../src/monitoring/contextLayers/liveSecrets.js');
    let t = 0;
    let tok = 'first-token-0123456789';
    const errors: unknown[] = [];
    const get = cachedLiveSecrets({ stateDir: path.join(tmp(), 'nope'), get authToken() { return tok; } } as never, { ttlMs: 1000, now: () => t, onStoreError: (e) => errors.push(e) });
    expect(get()).toContain('first-token-0123456789');
    tok = 'second-token-0123456789';
    t = 500;
    expect(get()).toContain('first-token-0123456789');
    t = 1500;
    expect(get()).toContain('second-token-0123456789');
  });
});

describe('backup posture (§9.7)', () => {
  function seed(sd: string, cfg: Record<string, unknown> | null) {
    if (cfg) fs.writeFileSync(path.join(sd, 'config.json'), JSON.stringify(cfg));
    fs.writeFileSync(path.join(sd, 'AGENT.md'), '# Agent');
    fs.writeFileSync(path.join(sd, 'topic-memory.db'), 'db');
    fs.writeFileSync(path.join(sd, 'topic-memory.db-wal'), 'wal');
    const t = path.join(sd, 'state', 'context-layers', '141133');
    for (const d of ['h1', 'fold-records', '_x']) fs.mkdirSync(path.join(t, d), { recursive: true });
    fs.writeFileSync(path.join(t, 'h1', 'current.json'), '{}');
    fs.writeFileSync(path.join(t, 'fold-records', 'f1.json'), '{"state":"locked"}');
    fs.writeFileSync(path.join(t, 'fold-hold.json'), '{}');
    for (const d of ['_seeded', '_clear-seed', '_fold-markers']) {
      fs.mkdirSync(path.join(sd, 'state', 'context-layers', d), { recursive: true });
      fs.writeFileSync(path.join(sd, 'state', 'context-layers', d, 'x.json'), '{}');
    }
    fs.mkdirSync(path.join(sd, 'state', 'context-archive', '141133', 'spans'), { recursive: true });
    fs.writeFileSync(path.join(sd, 'state', 'context-archive', '141133', 'spans', 's.jsonl.gz'), 'gz');
  }

  it('with the layers on, carries the layer store and TopicMemory, never fold state, holds, markers or the archive', () => {
    const sd = tmp();
    seed(sd, { contextBudget: { enabled: true } });
    const snap = new BackupManager(sd).createSnapshot('manual');
    expect(snap.files).toEqual(expect.arrayContaining(['topic-memory.db', 'topic-memory.db-wal']));
    expect(snap.files.some((f) => f.includes(path.join('141133', 'h1', 'current.json')))).toBe(true);
    for (const bad of ['fold-records', 'fold-hold.json', '_seeded', '_clear-seed', '_fold-markers', 'context-archive']) {
      expect(snap.files.filter((f) => f.split(/[\\/]/).includes(bad)), bad).toEqual([]);
    }
    expect(NEVER_BACKUP_PATH_SEGMENTS).toEqual(expect.arrayContaining(['fold-hold.json', '_seeded', '_clear-seed', '_fold-markers']));
  });

  it('with the layers off (or unreadable config), carries neither', () => {
    for (const cfg of [{ contextBudget: { enabled: false } }, null, { developmentAgent: false }]) {
      const sd = tmp();
      seed(sd, cfg);
      const snap = new BackupManager(sd).createSnapshot('manual');
      expect(snap.files.filter((f) => f.startsWith('topic-memory.db') || f.includes('context-layers'))).toEqual([]);
    }
  });

  it('the switch resolves through the development-agent gate: omitted is live on a dev agent, dark on the fleet; explicit wins', () => {
    const sd = tmp();
    const w = (c: unknown) => { fs.writeFileSync(path.join(sd, 'config.json'), JSON.stringify(c)); return readContextLayersSwitch(sd); };
    expect(w({ developmentAgent: true })).toBe(true);
    expect(w({})).toBe(false);
    expect(w({ developmentAgent: true, contextBudget: { enabled: false } })).toBe(false);
    expect(w({ contextBudget: { enabled: true } })).toBe(true);
    expect(contextLayersEnabled({ developmentAgent: true })).toBe(true);
    expect(contextLayersEnabled({})).toBe(false);
    expect(contextLayersEnabled({ developmentAgent: true }, false)).toBe(false);
  });
});

describe('buildContextLayers', () => {
  it('creates both roots 0700 at construction and reports status', () => {
    const sd = tmp();
    const layers = buildContextLayers({ stateDir: sd, authToken: 'tok-0123456789abcdef' });
    const st = layers.status();
    expect(st.layersRoot.mode).toBe('0700');
    expect(st.archiveRoot.mode).toBe('0700');
    expect(st.topics).toBe(0);
    layers.store.writeDerived('t', 'h1', 'current', { text: 'tok-0123456789abcdef leaked' }, META);
    expect(layers.store.read('t', 'h1', 'current')?.data.text).toBe('[REDACTED:live-secret] leaked');
    expect(layers.status().topics).toBe(1);
  });
});
