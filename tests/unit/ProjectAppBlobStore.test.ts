import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  projectAppBlobStoreSchema as schema, splitIntoChunks, prepareDocument, openChunk, reassemble, decodeDocument,
  buildChunk, buildRevision, foldRevisions, availableChunkKeys, isComplete, newestCompleteRevision, crossedEdits,
  checkWriteBase, isFencedLateWrite, epochTimeline, budgetUsage, admitBudget, checkWriteSize, fitsRecordLine,
  serializedLineBytes, chunkKey, sealText, docHashes, sha256Hex, openText, noteAad, CHUNK_PLAINTEXT_MAX, RECORD_LINE_MAX,
  type UnionEntry, type RevisionFields, type BlobKind,
} from '../../src/core/ProjectAppBlobStore.js';
import { buildSummary } from '../../src/core/ProjectAppCustomFold.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';

const APP = 'pa_0123456789abcdef';
const APP2 = 'pa_fedcba9876543210';
const at = '2026-11-17T01:00:00.000Z';
const DAY_MS = Date.parse(at);
let tick = 0;
const hlc = (node = 'm_a'): HlcTimestamp => ({ physical: DAY_MS + tick++, logical: 0, node });
const ctx = { countDroppedField() {}, countJailReject() {} };
const v = (raw: Record<string, unknown>) => schema.validate(raw, ctx as never);

type Build = (h: HlcTimestamp, o: string) => Record<string, unknown> | null;
const put = (u: UnionEntry[], b: Build, node = 'm_a', h = hlc(node)): Record<string, unknown> => {
  const d = b(h, node); if (!d) throw new Error('builder refused');
  u.push({ data: d, origin: node }); return d;
};

/** Write a document the way the lease holder would: new chunks, then a revision over `base`. */
function write(u: UnionEntry[], key: Buffer, doc: string, base: string | null = null, o: { kind?: BlobKind; keyGen?: number; epoch?: number; node?: string; appId?: string } = {}): Record<string, unknown> {
  const appId = o.appId ?? APP; const kind = o.kind ?? 'source'; const keyGen = o.keyGen ?? 1; const node = o.node ?? 'm_a';
  const p = prepareDocument(key, { appId, kind, keyGen }, doc);
  const have = availableChunkKeys(u);
  for (const c of p.chunkRecords) if (!have.has(chunkKey(appId, kind, keyGen, c.sha))) put(u, buildChunk(c, at), node);
  const rev: RevisionFields = { appId, kind, keyGen, contentSha: p.contentSha, chunks: p.chunks, bytes: p.bytes, base, by: 'agent', epoch: o.epoch ?? 1, at };
  return put(u, buildRevision(rev), node);
}

describe('chunks: split, seal, reassemble', () => {
  const key = randomBytes(32);
  it('splits on byte boundaries and reassembles a multibyte document exactly', () => {
    const doc = '€'.repeat(CHUNK_PLAINTEXT_MAX); // 3 bytes each: chunk edges fall inside characters
    const pieces = splitIntoChunks(doc);
    expect(pieces.every((p) => p.length <= CHUNK_PLAINTEXT_MAX)).toBe(true);
    expect(pieces.length).toBe(3);
    const p = prepareDocument(key, { appId: APP, kind: 'data', keyGen: 1 }, doc);
    const byS = new Map(p.chunkRecords.map((c) => [c.sha, openChunk(key, c)]));
    const out = reassemble(p, (s) => byS.get(s) ?? null, docHashes(key, { appId: APP, kind: 'data', keyGen: 1 }));
    expect(out && decodeDocument(out)).toBe(doc);
    // data ids are keyed: the plain sha256 check refuses to reassemble them
    expect(reassemble(p, (s) => byS.get(s) ?? null)).toBeNull();
  });
  it('a missing chunk or a wrong key never yields a partial document', () => {
    const p = prepareDocument(key, { appId: APP, kind: 'data', keyGen: 1 }, 'x'.repeat(CHUNK_PLAINTEXT_MAX + 5));
    expect(reassemble(p, () => null)).toBeNull();
    expect(openChunk(randomBytes(32), p.chunkRecords[0])).toBeNull();
  });
  it('a chunk moved to another app, kind or generation does not open (AAD binding)', () => {
    const c = prepareDocument(key, { appId: APP, kind: 'data', keyGen: 1 }, 'hello').chunkRecords[0];
    expect(openChunk(key, c)?.toString()).toBe('hello');
    expect(openChunk(key, { ...c, appId: APP2 })).toBeNull();
    expect(openChunk(key, { ...c, kind: 'source' })).toBeNull();
    expect(openChunk(key, { ...c, keyGen: 2 })).toBeNull();
  });
  it('erase → identical content under a new generation is a new chunk, never a collision', () => {
    const k1 = randomBytes(32); const k2 = randomBytes(32);
    const a = prepareDocument(k1, { appId: APP, kind: 'data', keyGen: 1 }, 'same text');
    const b = prepareDocument(k2, { appId: APP, kind: 'data', keyGen: 2 }, 'same text');
    // data hashes are keyed per generation: the same text under a new key shares no hash with the old
    expect(a.contentSha).not.toBe(b.contentSha);
    expect(a.chunks[0]).not.toBe(b.chunks[0]);
    const ka = chunkKey(APP, 'data', 1, a.chunks[0]); const kb = chunkKey(APP, 'data', 2, b.chunks[0]);
    expect(ka).not.toBe(kb);
    const u: UnionEntry[] = [];
    put(u, buildChunk(a.chunkRecords[0], at)); put(u, buildChunk(b.chunkRecords[0], at));
    expect(availableChunkKeys(u).size).toBe(2);
    // the old ciphertext cannot be read with the new generation's key
    expect(openChunk(k2, a.chunkRecords[0])).toBeNull();
  });
  it('seals the change note under the source key', () => {
    const n = sealText(key, 'Added a total row', noteAad(APP, 1));
    expect(openText(key, n, noteAad(APP, 1))).toBe('Added a total row');
    expect(openText(key, n, noteAad(APP, 2))).toBeNull();
  });
});

describe('keyed hashes for data (erase leaves nothing to confirm a guess against)', () => {
  it('data chunk ids and the content hash are HMACs under the data key, stable for the key holder; source stays sha256', () => {
    const key = randomBytes(32);
    const text = JSON.stringify({ deals: ['Acme', 'Globex'], total: 42 });
    const d1 = prepareDocument(key, { appId: APP, kind: 'data', keyGen: 1 }, text);
    const d2 = prepareDocument(key, { appId: APP, kind: 'data', keyGen: 1 }, text);
    expect(d1.contentSha).not.toBe(sha256Hex(text));
    expect(d1.chunks[0]).not.toBe(sha256Hex(text));
    expect(d1.contentSha).not.toBe(d1.chunks[0]); // separate labels for a piece and the whole
    expect(d2.contentSha).toBe(d1.contentSha); // dedupe and lookup still work for the key holder
    expect(d2.chunks).toEqual(d1.chunks);
    expect(openChunk(key, d1.chunkRecords[0])?.toString()).toBe(text);
    const s = prepareDocument(key, { appId: APP, kind: 'source', keyGen: 1 }, text);
    expect(s.contentSha).toBe(sha256Hex(text));
    expect(s.chunks[0]).toBe(sha256Hex(text));
  });
});

describe('the 64 KiB serialized line cap', () => {
  it('counts the serialized bytes, so quote-heavy text is measured after escaping', () => {
    const quotes = { recordType: 'project-app-revision', text: '"'.repeat(40 * 1024) };
    expect(JSON.stringify(quotes.text).length).toBeGreaterThan(RECORD_LINE_MAX);
    expect(quotes.text.length).toBeLessThan(RECORD_LINE_MAX);
    expect(fitsRecordLine(quotes)).toBe(false);
    expect(fitsRecordLine({ text: 'a'.repeat(40 * 1024) })).toBe(true);
    const backslashes = { text: '\\\n'.repeat(20 * 1024) };
    expect(fitsRecordLine(backslashes)).toBe(false);
  });
  it('a full 32 KiB chunk record fits; the schema refuses a line over the cap', () => {
    const key = randomBytes(32);
    const c = prepareDocument(key, { appId: APP, kind: 'data', keyGen: 1 }, randomBytes(CHUNK_PLAINTEXT_MAX)).chunkRecords[0];
    const rec = buildChunk(c, at)(hlc(), 'm_a')!;
    expect(rec).not.toBeNull();
    expect(serializedLineBytes(rec)).toBeLessThanOrEqual(RECORD_LINE_MAX);
    expect(v(rec)).not.toBeNull();
    expect(v({ ...rec, padding: '"'.repeat(20 * 1024) })).toBeNull();
  });
  it('refuses a chunk whose plaintext would exceed 32 KiB, a bad key or a mismatched record key', () => {
    const key = randomBytes(32);
    const big = prepareDocument(key, { appId: APP, kind: 'data', keyGen: 1 }, randomBytes(CHUNK_PLAINTEXT_MAX)).chunkRecords[0];
    const tooBig = { ...big, ct: Buffer.concat([Buffer.from(big.ct, 'base64'), Buffer.alloc(3)]).toString('base64') };
    expect(v({ recordType: 'project-app-chunk', ...tooBig })).toBeNull();
    expect(v({ recordType: 'project-app-chunk', ...big, recordKey: chunkKey(APP, 'data', 2, big.sha) })).toBeNull();
    expect(v({ recordType: 'project-app-chunk', ...big, appId: 'pa_nope' })).toBeNull();
  });
  it('a revision whose chunk list does not match its size is refused; later-build types are inert stubs', () => {
    const sha = 'a'.repeat(64);
    const good = { recordType: 'project-app-revision', appId: APP, kind: 'data', keyGen: 1, contentSha: sha, chunks: [sha], bytes: 10, base: null, by: 'app', epoch: 1, at };
    expect(v(good)).not.toBeNull();
    expect(v({ ...good, chunks: [sha, sha] })).toBeNull();
    expect(v({ ...good, note: { nonce: 'AAAAAAAAAAAAAAAA', ct: 'AAAA' } })).toBeNull(); // notes are source-only
    expect(v({ ...good, base: 'rev:pa_fedcba9876543210:1.0.m_a' })).toBeNull(); // a base in another app
    expect(v({ recordType: 'project-app-thing', appId: APP })).toEqual({ recordType: 'project-app-thing' });
  });
});

describe('revisions: A → B → A, crossed edits, stale base, fenced writes, completeness', () => {
  const key = randomBytes(32);
  it('A → B → A makes three revisions that point at two contents, and reuses chunks', () => {
    const u: UnionEntry[] = [];
    const r1 = write(u, key, 'A'); const r2 = write(u, key, 'B', r1.recordKey as string); write(u, key, 'A', r2.recordKey as string);
    const revs = foldRevisions(u, { appId: APP, kind: 'source' });
    expect(revs.length).toBe(3);
    expect(new Set(revs.map((r) => r.contentSha)).size).toBe(2);
    expect(u.filter((e) => e.data.recordType === 'project-app-chunk').length).toBe(2);
    expect(newestCompleteRevision(revs, APP, 'source', availableChunkKeys(u))?.id).toBe(revs[2].id);
  });
  it('an incomplete newest revision is skipped for the newest complete one', () => {
    const u: UnionEntry[] = [];
    const r1 = write(u, key, 'one');
    const big = 'z'.repeat(CHUNK_PLAINTEXT_MAX * 2);
    write(u, key, big, r1.recordKey as string);
    const missing = u.findIndex((e) => e.data.recordType === 'project-app-chunk' && e.data.sha !== u[0].data.sha);
    const partial = u.filter((_, i) => i !== missing);
    const revs = foldRevisions(partial);
    expect(isComplete(revs[1], availableChunkKeys(partial))).toBe(false);
    expect(newestCompleteRevision(revs, APP, 'source', availableChunkKeys(partial))?.id).toBe(r1.recordKey);
  });
  it('two revisions on the same base are crossed edits; a stale base answers 409 with the current head', () => {
    const u: UnionEntry[] = [];
    const r1 = write(u, key, 'base', null, { kind: 'data' });
    const tabA = write(u, key, 'tab A', r1.recordKey as string, { kind: 'data' });
    write(u, key, 'tab B', r1.recordKey as string, { kind: 'data', node: 'm_b' });
    const revs = foldRevisions(u);
    const x = crossedEdits(revs);
    expect(x.length).toBe(1);
    expect(x[0].base).toBe(r1.recordKey);
    expect(x[0].revisions.length).toBe(2);
    const stale = checkWriteBase(revs, APP, 'data', tabA.recordKey as string);
    expect(stale.ok).toBe(false);
    if (!stale.ok) { expect(stale.status).toBe(409); expect(stale.current?.id).toBe(revs[2].id); }
    expect(checkWriteBase(revs, APP, 'data', revs[2].id).ok).toBe(true);
    expect(checkWriteBase([], APP, 'data', null).ok).toBe(true);
    expect(checkWriteBase(revs, APP, 'data', null).ok).toBe(false);
  });
  it('a fenced late write is excluded from serving and the head, but counted in the budget', () => {
    const u: UnionEntry[] = [];
    const r1 = write(u, key, 'epoch one', null, { epoch: 1 });
    const handover = hlc('m_b');
    const late = write(u, key, 'late from old holder', r1.recordKey as string, { epoch: 1 });
    const epochAt = epochTimeline([{ epoch: 1, since: { physical: 0, logical: 0, node: 'm_a' } }, { epoch: 2, since: handover }]);
    const revs = foldRevisions(u);
    const lateRev = revs.find((r) => r.id === late.recordKey)!;
    expect(isFencedLateWrite(lateRev, epochAt)).toBe(true);
    expect(isFencedLateWrite(revs[0], epochAt)).toBe(false);
    expect(newestCompleteRevision(revs, APP, 'source', availableChunkKeys(u), { epochAt })?.id).toBe(r1.recordKey);
    expect(checkWriteBase(revs, APP, 'source', r1.recordKey as string, epochAt).ok).toBe(true);
    const all = budgetUsage(u, APP, '2026-11-17');
    const without = budgetUsage(u.filter((e) => e.data !== late), APP, '2026-11-17');
    expect(all).toBeGreaterThan(without);
  });
});

describe('the per-app daily budget', () => {
  const key = randomBytes(32);
  it('sums serialized bytes per app per UTC day, including summary records, and nothing of other apps', () => {
    const u: UnionEntry[] = [];
    write(u, key, 'doc', null, { kind: 'data' });
    write(u, key, 'other app', null, { kind: 'data', appId: APP2 });
    const before = budgetUsage(u, APP, '2026-11-17');
    expect(before).toBe(u.filter((e) => e.data.appId === APP).reduce((n, e) => n + serializedLineBytes(e.data), 0));
    const sum = put(u, buildSummary({ appId: APP, keyGen: 1, sealed: sealText(key, 'Ten deals', 'x'), asOf: at, by: 'app', at }));
    expect(budgetUsage(u, APP, '2026-11-17')).toBe(before + serializedLineBytes(sum));
    expect(budgetUsage(u, APP, '2026-11-18')).toBe(0);
  });
  it('admits up to the budget and answers 429 past it; per-write sizes answer 413', () => {
    expect(admitBudget(100, 50, 200)).toEqual({ ok: true, usedAfter: 150 });
    expect(admitBudget(190, 50, 200)).toEqual({ ok: false, status: 429, used: 190, budget: 200 });
    expect(checkWriteSize('source', 2 * 1024 * 1024).ok).toBe(true);
    expect(checkWriteSize('source', 2 * 1024 * 1024 + 1)).toEqual({ ok: false, status: 413, limit: 2 * 1024 * 1024 });
    expect(checkWriteSize('data', 1024 * 1024 + 1)).toEqual({ ok: false, status: 413, limit: 1024 * 1024 });
  });
});
