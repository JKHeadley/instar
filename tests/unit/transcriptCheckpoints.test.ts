/**
 * native-conversation-any-machine-access §3f — transcript checkpoint replication, source and copy.
 * The tests fixed by §3f item 4 are here: a token split across two reads at every position, a partial
 * trailing row, hash verification on the replica, and the two crash points.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  TranscriptCheckpointSource, TranscriptCopyStore, splitWholeRows, redactRow, checkpointChunks, coverageSentence,
  validateCheckpointChunk, boundConversations, wireTranscriptCopies, CHECKPOINT_MAX_SOURCE_BYTES, MAX_WAITING_CHUNKS, type CheckpointChunkData,
} from '../../src/core/transcriptCheckpoints.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const TOKEN = 'tok-SECRET-abc123xyz';
const PIN = '482913';
const SRC = 'm_source';
const base = () => (process.env.TMPDIR && !process.env.TMPDIR.includes('/.') ? process.env.TMPDIR : os.tmpdir());
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/transcriptCheckpoints.test.ts' }); });
function tmp(): string { const d = fs.mkdtempSync(path.join(base(), 'tcp-')); dirs.push(d); return d; }

const row = (o: unknown) => `${JSON.stringify(o)}\n`;
const ROWS = [
  row({ type: 'user', timestamp: '2026-11-11T14:00:00Z', message: { content: 'first' } }),
  row({ type: 'assistant', timestamp: '2026-11-11T14:01:00Z', message: { content: `the key is ${TOKEN} ok` } }),
  row({ type: 'user', timestamp: '2026-11-11T14:02:00Z', message: { content: 'third, ünïcode ✓' } }),
];

/** A source on one machine and a copy store on another, joined by an emit that lands each chunk. */
function pair(opts: { emitFails?: () => boolean; deliverThenThrow?: () => boolean; bytesPerDay?: number } = {}) {
  const srcDir = tmp(), dstDir = tmp();
  const file = path.join(srcDir, 'session.jsonl');
  const emitted: CheckpointChunkData[] = [];
  const copies = new TranscriptCopyStore(dstDir);
  const make = () => new TranscriptCheckpointSource({
    stateDir: srcDir, machineId: SRC, secrets: () => [TOKEN, PIN], bytesPerDay: opts.bytesPerDay,
    emit: async (chunks) => {
      if (opts.emitFails?.()) return false;
      for (const c of chunks) { emitted.push(c.data); copies.ingest(SRC, { ...c.data, origin: SRC }); }
      if (opts.deliverThenThrow?.()) throw new Error('crash after delivery');
      return true;
    },
  });
  const session = (conversations = ['telegram:1']) => ({ sessionId: 'sess-1', session: 'echo-a', filePath: file, conversations });
  return { srcDir, dstDir, file, emitted, copies, make, session };
}

const copyText = (copies: TranscriptCopyStore) => {
  const m = copies.manifest(SRC, 'sess-1');
  return m && fs.existsSync(copies.copyFile(m)) ? fs.readFileSync(copies.copyFile(m), 'utf8') : '';
};
const decoded = (emitted: CheckpointChunkData[]) => emitted.map((c) => Buffer.from(c.chunk, 'base64').toString('utf8'));

describe('whole rows', () => {
  it('splits a window into whole rows and holds back a trailing partial row', () => {
    const buf = Buffer.from(`${ROWS[0]}${ROWS[1]}{"type":"par`);
    const { rows, consumed } = splitWholeRows(buf);
    expect(rows.map((r) => r.toString())).toEqual([ROWS[0], ROWS[1]]);
    expect(consumed).toBe(Buffer.byteLength(ROWS[0] + ROWS[1]));
  });

  it('redacts inside the parsed row, so a PIN inside another number cannot break the row', () => {
    const r = Buffer.from(row({ ts: 104829130, text: `pin ${PIN}`, pin: Number(PIN), [TOKEN]: 1 }));
    const out = redactRow(r, [TOKEN, PIN]).toString();
    expect(out.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(out);
    expect(parsed).toEqual({ ts: 104829130, text: 'pin [redacted]', pin: '[redacted]', '[redacted]': 1 });
    expect(out).not.toContain(TOKEN);
  });

  it('keeps a row with no secret byte for byte, and redacts a row that is not JSON as text on one line', () => {
    const clean = Buffer.from(ROWS[0]);
    expect(redactRow(clean, [TOKEN])).toBe(clean);
    expect(redactRow(Buffer.from(`not json ${TOKEN}\n`), [TOKEN]).toString()).toBe('not json [redacted]\n');
  });
});

describe('the token split across two reads', () => {
  it('appears in no checkpoint and not in the replica, at every split position', async () => {
    const full = Buffer.from(ROWS.join(''));
    const expected = ROWS.map((r) => redactRow(Buffer.from(r), [TOKEN, PIN]).toString()).join('');
    // Every split position from just before the token's row to just after it.
    const rowStart = Buffer.byteLength(ROWS[0]);
    const rowEnd = rowStart + Buffer.byteLength(ROWS[1]);
    for (let p = rowStart - 2; p <= rowEnd + 2; p++) {
      const t = pair();
      fs.writeFileSync(t.file, full.subarray(0, p));
      await t.make().tick([t.session()]);
      fs.appendFileSync(t.file, full.subarray(p));
      await t.make().tick([t.session()], { final: new Set(['sess-1']) });
      for (const text of decoded(t.emitted)) expect(text).not.toContain(TOKEN);
      expect(copyText(t.copies)).toBe(expected);
      const m = t.copies.manifest(SRC, 'sess-1')!;
      expect(m).toMatchObject({ complete: true, rowCount: 3, throughOffset: Buffer.byteLength(expected), sourceThroughOffset: full.length });
    }
  }, 120_000);
});

describe('a partial trailing row', () => {
  it('is held back and appears whole in the next checkpoint', async () => {
    const t = pair();
    const r2 = Buffer.from(ROWS[2]);
    fs.writeFileSync(t.file, Buffer.concat([Buffer.from(ROWS[0]), r2.subarray(0, 10)]));
    const src = t.make();
    await src.tick([t.session()]);
    expect(src.state('sess-1')).toMatchObject({ seq: 1, sourceThroughOffset: Buffer.byteLength(ROWS[0]), pending: null });
    expect(copyText(t.copies)).toBe(ROWS[0]);
    fs.appendFileSync(t.file, r2.subarray(10));
    await src.tick([t.session()]);
    expect(copyText(t.copies)).toBe(ROWS[0] + ROWS[2]);
    expect(t.emitted.filter((c) => c.seq === 2).map((c) => c.rowCount)).toEqual([1]);
    expect(t.copies.manifest(SRC, 'sess-1')).toMatchObject({ complete: false, nextSeq: 3 });
  });
});

describe('the replica verifies', () => {
  it('each sha256 against the bytes it holds: a changed chunk is not assembled and the copy says so', async () => {
    const srcDir = tmp(), dstDir = tmp();
    const copies = new TranscriptCopyStore(dstDir);
    const body = Buffer.from(ROWS[0]);
    const meta = { sessionId: 'sess-1', session: 'echo-a', sourceMachineId: SRC, seq: 1, fromOffset: 0, toOffset: body.length, sourceThroughOffset: body.length, rowCount: 1, firstAt: null, lastAt: '2026-11-11T14:00:00Z', sha256: crypto.createHash('sha256').update(body).digest('hex'), bytes: body.length, conversations: [], conversationsOverflow: false, final: false, withheldRows: 0 };
    void srcDir;
    const [chunk] = checkpointChunks(meta, body);
    const forged = { ...chunk.data, chunk: Buffer.from(ROWS[1].slice(0, body.length)).toString('base64') };
    expect(copies.ingest(SRC, forged)).toBe('landed');
    const m = copies.manifest(SRC, 'sess-1')!;
    expect(m).toMatchObject({ nextSeq: 1, throughOffset: 0, problem: 'checkpoint 1 did not check out' });
    expect(coverageSentence(m, false)).toContain('did not check out');
  });

  it('a gap in seq stops coverage at the gap, and the missing checkpoint closes it', async () => {
    const t = pair();
    const src = t.make();
    fs.writeFileSync(t.file, ROWS[0]); await src.tick([t.session()]);
    fs.appendFileSync(t.file, ROWS[1]); await src.tick([t.session()]);
    fs.appendFileSync(t.file, ROWS[2]); await src.tick([t.session()]);
    const other = new TranscriptCopyStore(tmp());
    const by = (seq: number) => t.emitted.filter((c) => c.seq === seq);
    for (const c of [...by(1), ...by(3)]) other.ingest(SRC, c);
    expect(other.manifest(SRC, 'sess-1')).toMatchObject({ nextSeq: 2, rowCount: 1 });
    for (const c of by(2)) other.ingest(SRC, c);
    expect(other.manifest(SRC, 'sess-1')).toMatchObject({ nextSeq: 4, rowCount: 3 });
  });

  it('refuses a checkpoint from any machine but the one that ran the session', () => {
    const copies = new TranscriptCopyStore(tmp());
    const body = Buffer.from(ROWS[0]);
    const [c] = checkpointChunks({ sessionId: 's', session: 'x', sourceMachineId: SRC, seq: 1, fromOffset: 0, toOffset: body.length, sourceThroughOffset: body.length, rowCount: 1, firstAt: null, lastAt: null, sha256: crypto.createHash('sha256').update(body).digest('hex'), bytes: body.length, conversations: [], conversationsOverflow: false, final: false, withheldRows: 0 }, body);
    expect(copies.ingest('m_other', c.data)).toBe('refused');
    expect(copies.ingest(SRC, { ...c.data, origin: 'm_other' })).toBe('refused');
    expect(validateCheckpointChunk({ ...c.data, toOffset: 9999 })).toBeNull();
  });
});

describe('restart', () => {
  it('a crash with a partial row buffered resumes with no gap and no repeat', async () => {
    const t = pair();
    const r1 = Buffer.from(ROWS[1]);
    fs.writeFileSync(t.file, Buffer.concat([Buffer.from(ROWS[0]), r1.subarray(0, 7)]));
    await t.make().tick([t.session()]);
    // The process dies here, the partial row only in memory. A new process reads from the row boundary.
    fs.appendFileSync(t.file, Buffer.concat([r1.subarray(7), Buffer.from(ROWS[2])]));
    await t.make().tick([t.session()]);
    const expected = ROWS.map((r) => redactRow(Buffer.from(r), [TOKEN, PIN]).toString()).join('');
    expect(copyText(t.copies)).toBe(expected);
    expect(t.emitted.map((c) => c.seq)).toEqual([1, 2]);
  });

  it('a crash between a checkpoint\'s write and its emit re-emits that checkpoint, then reads on', async () => {
    let fail = true;
    const t = pair({ emitFails: () => fail });
    fs.writeFileSync(t.file, ROWS[0] + ROWS[1]);
    const first = t.make();
    expect((await first.tick([t.session()]))['sess-1']).toBe('pending');
    // The checkpoint and its sourceThroughOffset were written in the same transaction.
    expect(first.state('sess-1')).toMatchObject({ seq: 1, sourceThroughOffset: Buffer.byteLength(ROWS[0] + ROWS[1]), pending: { meta: { seq: 1 } } });
    fail = false;
    fs.appendFileSync(t.file, ROWS[2]);
    await t.make().tick([t.session()]);
    expect(t.emitted.map((c) => c.seq)).toEqual([1, 2]);
    expect(t.copies.manifest(SRC, 'sess-1')).toMatchObject({ nextSeq: 3, rowCount: 3 });
  });

  it('a crash after delivery but before the outbox was cleared repeats nothing in the copy', async () => {
    let crash = true;
    const t = pair({ deliverThenThrow: () => { const c = crash; crash = false; return c; } });
    fs.writeFileSync(t.file, ROWS[0]);
    await t.make().tick([t.session()]);
    fs.appendFileSync(t.file, ROWS[1]);
    await t.make().tick([t.session()]);
    expect(t.emitted.map((c) => c.seq)).toEqual([1, 1, 2]);
    const expected = [ROWS[0], ROWS[1]].map((r) => redactRow(Buffer.from(r), [TOKEN, PIN]).toString()).join('');
    expect(copyText(t.copies)).toBe(expected);
  });

  it('bytes past the manifest (an append the manifest never committed) are cut before the next append', async () => {
    const t = pair();
    const src = t.make();
    fs.writeFileSync(t.file, ROWS[0]); await src.tick([t.session()]);
    const m = t.copies.manifest(SRC, 'sess-1')!;
    fs.appendFileSync(t.copies.copyFile(m), 'torn partial append');
    fs.appendFileSync(t.file, ROWS[2]); await src.tick([t.session()]);
    expect(copyText(t.copies)).toBe(ROWS[0] + ROWS[2]);
  });
});

describe('coverage and audience', () => {
  it('states how far the copy reaches and never calls a partial copy whole', async () => {
    const t = pair();
    fs.writeFileSync(t.file, ROWS[0] + ROWS[1]);
    await t.make().tick([t.session()]);
    const m = t.copies.manifest(SRC, 'sess-1')!;
    const sentence = coverageSentence(m, false);
    expect(sentence).toMatch(/^Copied through \d\d:\d\d; the machine that ran it is asleep; later rows are not here yet\.$/);
    await t.make().tick([t.session()], { final: new Set(['sess-1']) });
    expect(coverageSentence(t.copies.manifest(SRC, 'sess-1')!, false)).toMatch(/^Copied in full, through \d\d:\d\d; the machine that ran it is asleep\.$/);
  });

  it('takes the union of the conversations every held checkpoint names', async () => {
    const t = pair();
    fs.writeFileSync(t.file, ROWS[0]); await t.make().tick([t.session(['telegram:1'])]);
    fs.appendFileSync(t.file, ROWS[1]); await t.make().tick([t.session(['app-private'])]);
    expect(t.copies.manifest(SRC, 'sess-1')!.conversations).toEqual(['app-private', 'telegram:1']);
    expect(t.copies.find('echo-a', SRC)?.sessionId).toBe('sess-1');
    expect(t.copies.find('echo-a', 'm_elsewhere')).toBeNull();
  });
});

describe('bounds', () => {
  it('a row larger than one checkpoint is replaced by a marker that names its size, and the cursor moves past it', async () => {
    const t = pair();
    const huge = row({ type: 'user', message: { content: 'x'.repeat(CHECKPOINT_MAX_SOURCE_BYTES + 10) } });
    fs.writeFileSync(t.file, huge + ROWS[0]);
    await t.make().tick([t.session()]);
    const lines = copyText(t.copies).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(lines[0]).toEqual({ type: 'instar-row-withheld', reason: 'row-larger-than-a-checkpoint', bytes: Buffer.byteLength(huge) });
    expect(lines[1].message.content).toBe('first');
    expect(t.copies.manifest(SRC, 'sess-1')).toMatchObject({ withheldRows: 1, rowCount: 2 });
  });

  it('stops for the day at the byte budget and says so', async () => {
    const held: string[] = [];
    const t = pair({ bytesPerDay: 10 });
    const src = new TranscriptCheckpointSource({ stateDir: t.srcDir, machineId: SRC, secrets: () => [], bytesPerDay: 10, emit: async () => true, onEvidence: (k, r) => held.push(`${k}:${r}`) });
    fs.writeFileSync(t.file, ROWS[0]);
    expect((await src.tick([t.session()]))['sess-1']).toBe('copied');
    fs.appendFileSync(t.file, ROWS[1]);
    expect((await src.tick([t.session()]))['sess-1']).toBe('budget');
    expect(held).toContain('held:daily-budget');
    expect(src.state('sess-1')!.seq).toBe(1);
  });

  it('cuts a checkpoint into journal entries under the line cap', () => {
    const body = Buffer.alloc(200 * 1024, 0x61);
    const chunks = checkpointChunks({ sessionId: 's', session: 'x', sourceMachineId: SRC, seq: 1, fromOffset: 0, toOffset: body.length, sourceThroughOffset: body.length, rowCount: 1, firstAt: null, lastAt: null, sha256: 'a'.repeat(64), bytes: body.length, ...boundConversations(Array.from({ length: 64 }, (_, i) => `slack:${'é'.repeat(30)}${i}`)), final: false, withheldRows: 0 }, body);
    expect(chunks.length).toBe(5);
    for (const c of chunks) expect(Buffer.byteLength(JSON.stringify({ seq: 1, ts: 'x', machine: SRC, kind: 'session-transcript-checkpoint', data: { ...c.data, recordKey: c.key, hlc: { physical: 1, logical: 0, node: SRC }, op: 'put', origin: SRC } }))).toBeLessThan(80 * 1024);
  });
});

describe('second-pass fixes', () => {
  it('a session end seen while a pass is running is saved and cut by the next pass', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const t = pair();
    const src = new TranscriptCheckpointSource({ stateDir: t.srcDir, machineId: SRC, secrets: () => [], emit: async (chunks) => { await gate; for (const c of chunks) t.copies.ingest(SRC, c.data); return true; } });
    fs.writeFileSync(t.file, ROWS[0]);
    const running = src.tick([t.session()]);
    expect(await src.tick([t.session()], { final: new Set(['sess-1']) })).toEqual({});
    expect(src.state('sess-1')).toMatchObject({ finalRequested: true });
    release(); await running;
    await src.tick([t.session()]);
    expect(t.copies.manifest(SRC, 'sess-1')).toMatchObject({ complete: true });
  });

  it('a session that served more conversations than a checkpoint can name is marked, and the mark is sticky', async () => {
    expect(boundConversations(Array.from({ length: 65 }, (_, i) => `telegram:${i}`))).toEqual({ conversations: [], conversationsOverflow: true });
    expect(boundConversations(Array.from({ length: 64 }, () => `slack:${'é'.repeat(200)}`).map((c, i) => c + i)).conversationsOverflow).toBe(true);
    const t = pair();
    fs.writeFileSync(t.file, ROWS[0]); await t.make().tick([t.session(Array.from({ length: 70 }, (_, i) => `telegram:${i}`))]);
    fs.appendFileSync(t.file, ROWS[2]); await t.make().tick([t.session(['telegram:1'])]);
    expect(t.copies.manifest(SRC, 'sess-1')).toMatchObject({ conversationsOverflow: true, conversations: ['telegram:1'] });
  });

  it('a secret written with JSON escapes is redacted too', () => {
    const escaped = TOKEN.split('').map((ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    const out = redactRow(Buffer.from(`{"text":"key ${escaped}"}\n`), [TOKEN]).toString();
    expect(JSON.parse(out).text).toBe('key [redacted]');
  });

  it('a read sees only what the manifest committed', async () => {
    const t = pair();
    fs.writeFileSync(t.file, ROWS[0]); await t.make().tick([t.session()]);
    const m = t.copies.manifest(SRC, 'sess-1')!;
    fs.appendFileSync(t.copies.copyFile(m), 'uncommitted');
    expect(fs.readFileSync(t.copies.committedCopyFile(m), 'utf8')).toBe(ROWS[0]);
  });

  it('chunks waiting behind a missing checkpoint stop being kept at the bound, and the copy says why', () => {
    const copies = new TranscriptCopyStore(tmp());
    const body = Buffer.from('x\n');
    const meta = (seq: number) => ({ sessionId: 'g', session: 'gap', sourceMachineId: SRC, seq, fromOffset: 0, toOffset: body.length, sourceThroughOffset: 2, rowCount: 1, firstAt: null, lastAt: null, sha256: crypto.createHash('sha256').update(body).digest('hex'), bytes: body.length, conversations: [], conversationsOverflow: false, final: false, withheldRows: 0 });
    for (let seq = 2; seq < 2 + MAX_WAITING_CHUNKS; seq++) expect(copies.ingest(SRC, checkpointChunks(meta(seq), body)[0].data)).toBe('landed');
    expect(copies.ingest(SRC, checkpointChunks(meta(2 + MAX_WAITING_CHUNKS), body)[0].data)).toBe('refused');
    const m = copies.manifest(SRC, 'g')!;
    expect(m.problem).toBe('checkpoint 1 has not arrived; later ones are not kept');
    expect(coverageSentence(m, false)).toContain('has not arrived');
    expect(copies.ingest(SRC, checkpointChunks(meta(1), body)[0].data)).toBe('assembled');
  }, 60_000);

  it('the coverage says how many rows were too large to copy, and a copy not asked of its source says so', () => {
    const m = { throughAt: '2026-11-11T14:02:00Z', complete: true, rowCount: 3, withheldRows: 1 };
    expect(coverageSentence(m, null)).toMatch(/^Copied in full, through \d\d:\d\d; the machine that ran it was not asked\. One row was too large to copy and is named by size only\.$/);
  });

  it('the production wiring copies, finalizes on session end, lands peer entries and prunes finished outbox records', async () => {
    const t = pair();
    fs.writeFileSync(t.file, ROWS[0]);
    let at = Date.parse('2026-11-11T15:00:00Z');
    const wired = wireTranscriptCopies({
      stateDir: t.srcDir, machineId: SRC, secrets: () => [TOKEN], now: () => new Date(at),
      emit: async (chunks) => { for (const c of chunks) { t.emitted.push(c.data); t.copies.ingest(SRC, c.data); } return true; },
      listSessions: () => [{ id: 'sess-1', status: 'running', tmuxSession: 'echo-a' }, { id: 'old', status: 'completed', endedAt: '2026-11-01T00:00:00Z', tmuxSession: 'echo-old' }],
      describe: (x) => ({ filePath: x.id === 'sess-1' ? t.file : null, conversations: [] }),
    });
    await wired.tick();
    expect(wired.copies.status().sessions).toEqual([{ session: 'echo-a', seq: 1, copiedThroughOffset: Buffer.byteLength(ROWS[0]), pending: false }]);
    await wired.final({ id: 'sess-1', status: 'completed', tmuxSession: 'echo-a' });
    expect(t.copies.manifest(SRC, 'sess-1')).toMatchObject({ complete: true });
    const other = new TranscriptCopyStore(tmp());
    const w2 = { ingest: (s: string, e: Array<{ data: unknown }>) => { for (const x of e) other.ingest(s, x.data); } };
    w2.ingest(SRC, t.emitted.map((data) => ({ data })));
    expect(other.manifest(SRC, 'sess-1')).toMatchObject({ complete: true });
    // Two weeks on and no longer listed, the finished record is pruned.
    const outbox = path.join(t.srcDir, 'state', 'transcript-checkpoints', 'source');
    for (const f of fs.readdirSync(outbox)) fs.utimesSync(path.join(outbox, f), new Date('2026-11-01'), new Date('2026-11-01'));
    at = Date.parse('2026-11-30T15:00:00Z');
    expect(wired.source.pruneFinished(new Set())).toBe(1);
    expect(wired.source.state('sess-1')).toBeNull();
  });
});

