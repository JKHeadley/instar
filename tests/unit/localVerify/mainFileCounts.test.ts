// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-1: the baseline results file (docs/specs/local-verify-borrowed-slices-count.md, F "Baseline
 * results" and "Build decisions"): the last three green main verifies, bounded; the file's hash
 * written to the audit log on write and checked on read (a mismatch means no baseline); a baseline
 * usable only when its commit is `baseSha` or an ancestor of it, and only for files whose content is
 * the same in the merge tree; a dry run's baseline kept until released.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { appendLocalVerifyAudit } from '../../../src/localVerify/LocalVerifyService.js';
import {
  MAIN_FILE_COUNTS_LIMITS, MainFileCountsStore, lastAuditedHash, parseFileCounts, parseMainFileCounts, selectBaselineRows, usableBaseline, withBaseline, withPin,
  type FileCountsRow, type MainBaseline, type MainFileCountsFile,
} from '../../../src/localVerify/mainFileCounts.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'mainFileCounts.test.ts' }); });
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvcounts-'))); dirs.push(d); return d; };
const sha = (c: string) => c.repeat(40);
const D = (c: string) => c.repeat(64);
const row = (passed: number, digest = D('1')): FileCountsRow => [passed, 0, 0, 0, digest];
const A = 'tests/integration/a.test.ts';
const B = 'tests/integration/b.test.ts';
const baseline = (c: string, files: Record<string, FileCountsRow> = { [A]: row(3), [B]: row(5, D('2')) }): MainBaseline => ({ commit: sha(c), finishedAt: '2026-11-19T08:00:00.000Z', machineId: 'm_studio', files });
const empty: MainFileCountsFile = { v: 1, baselines: [], pinned: [] };

/** A store whose audit rows go to the real audit log of a temp state folder, as in production. */
function store(dir = tmp()) {
  const auditPath = path.join(dir, 'logs', 'local-verify.jsonl');
  const s = () => new MainFileCountsStore({ stateDir: dir, audit: (e) => appendLocalVerifyAudit(auditPath, e, Date.now()) });
  return { dir, auditPath, open: s, file: path.join(dir, 'state', 'local-verify', 'main-file-counts.json') };
}

describe('the kept baselines (pure)', () => {
  it('keeps the last three green main verifies, newest first, and replaces a commit seen again', () => {
    let f = empty;
    for (const c of ['a', 'b', 'c', 'd']) f = withBaseline(f, baseline(c));
    expect(f.baselines.map((b) => b.commit)).toEqual([sha('d'), sha('c'), sha('b')]);
    f = withBaseline(f, baseline('c', { [A]: row(9) }));
    expect(f.baselines.map((b) => b.commit)).toEqual([sha('c'), sha('d'), sha('b')]);
    expect(f.baselines[0].files[A][0]).toBe(9);
  });

  it('a baseline a dry run pinned outlives newer greens until it is released; at most two pins', () => {
    let f = withBaseline(empty, baseline('a'));
    f = withPin(f, sha('a'), true)!;
    expect(withPin(f, sha('f'), true)).toBeNull(); // not a kept commit
    for (const c of ['b', 'c', 'd', 'e']) f = withBaseline(f, baseline(c));
    expect(f.baselines.map((b) => b.commit)).toEqual([sha('e'), sha('d'), sha('c'), sha('a')]);
    expect(f.pinned).toEqual([sha('a')]);
    f = withPin(f, sha('a'), false)!;
    expect(f.baselines.map((b) => b.commit)).toEqual([sha('e'), sha('d'), sha('c')]);
    expect(f.pinned).toEqual([]);
    let g = withBaseline(withBaseline(withBaseline(empty, baseline('a')), baseline('b')), baseline('c'));
    g = withPin(withPin(g, sha('a'), true)!, sha('b'), true)!;
    expect(withPin(g, sha('c'), true)).toBeNull(); // no third pin
  });

  it('parses strictly and within bounds', () => {
    const good = withBaseline(empty, baseline('a'));
    expect(parseMainFileCounts(JSON.parse(JSON.stringify(good)))).toEqual(good);
    expect(parseMainFileCounts({ ...good, v: 2 })).toBeNull();
    expect(parseMainFileCounts({ ...good, extra: 1 })).toBeNull();
    expect(parseMainFileCounts({ ...good, baselines: [baseline('a'), baseline('a')] })).toBeNull(); // a commit twice
    expect(parseMainFileCounts({ ...good, baselines: Array.from({ length: MAIN_FILE_COUNTS_LIMITS.baselines + MAIN_FILE_COUNTS_LIMITS.pinned + 1 }, (_, i) => baseline(String(i))) })).toBeNull();
    expect(parseMainFileCounts({ ...good, baselines: [{ ...baseline('a'), commit: 'main' }] })).toBeNull();
    expect(parseFileCounts({ [A]: [1, 0, 0, 0, 'short'] })).toBeNull();
    expect(parseFileCounts({ [A]: [1, 0, 0, D('1')] })).toBeNull();
    expect(parseFileCounts({ [A]: [-1, 0, 0, 0, D('1')] })).toBeNull();
    expect(parseFileCounts({ '../outside.test.ts': row(1) })).toBeNull();
    expect(parseFileCounts({ '/abs/a.test.ts': row(1) })).toBeNull();
    expect(parseFileCounts([row(1)])).toBeNull();
    expect(parseFileCounts(Object.fromEntries(Array.from({ length: MAIN_FILE_COUNTS_LIMITS.filesPerBaseline + 1 }, (_, i) => [`tests/unit/f${i}.test.ts`, row(1)])))).toBeNull();
    expect(parseFileCounts({ [A]: row(1) })).toEqual({ [A]: row(1) });
  });
});

describe('which baseline a verify may use (pure)', () => {
  const kept = [baseline('c'), baseline('b'), baseline('a')]; // newest first

  it('only a baseline whose commit is baseSha or an ancestor of it; the newest such one; none means no baseline', () => {
    expect(usableBaseline(kept, sha('b'), () => false)?.commit).toBe(sha('b')); // baseSha itself
    expect(usableBaseline(kept, sha('z'), (c) => c === sha('a') || c === sha('b'))?.commit).toBe(sha('b')); // the newest ancestor
    expect(usableBaseline(kept, sha('z'), (c) => c === sha('a'))?.commit).toBe(sha('a'));
    expect(usableBaseline(kept, sha('z'), () => false)).toBeNull(); // newer than the base, or on another line
    expect(usableBaseline(kept, sha('z'), () => null)).toBeNull(); // git could not tell: not usable
    expect(usableBaseline([], sha('a'), () => true)).toBeNull();
  });

  it('only for files whose content is the same in the merge tree', () => {
    const b = baseline('a');
    const at = (blobs: Record<string, string | null>) => (f: string) => blobs[f] ?? null;
    const same = selectBaselineRows(b, [A, B, 'tests/integration/new.test.ts'], at({ [A]: 'blob1', [B]: 'blob2' }), at({ [A]: 'blob1', [B]: 'blob2', 'tests/integration/new.test.ts': 'blob3' }));
    expect([...same.keys()]).toEqual([A, B]); // a file the baseline does not have gets no row
    const edited = selectBaselineRows(b, [A, B], at({ [A]: 'blob1', [B]: 'blob2' }), at({ [A]: 'blob1', [B]: 'blob2-edited' }));
    expect([...edited.keys()]).toEqual([A]); // the change edits B: no baseline for it
    expect(edited.get(A)).toEqual(row(3));
    expect(selectBaselineRows(b, [A], at({}), at({ [A]: 'blob1' })).size).toBe(0); // unreadable on one side
    expect(selectBaselineRows(b, [A], at({ [A]: 'blob1' }), at({})).size).toBe(0); // deleted in the merge tree
    expect(selectBaselineRows(null, [A], at({ [A]: 'x' }), at({ [A]: 'x' })).size).toBe(0);
    // A file name that is an object key by inheritance is not a row.
    expect(selectBaselineRows(b, ['constructor'], () => 'x', () => 'x').size).toBe(0);
  });
});

describe('MainFileCountsStore: the hash is written to the audit log and checked when read', () => {
  it('a written file reads back, also in a new process, with its hash in the audit log', () => {
    const s = store();
    const hash = s.open().add(baseline('a'));
    const rows = fs.readFileSync(s.auditPath, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(rows.at(-1)).toMatchObject({ event: 'main-file-counts-written', hash, baselines: [sha('a')], why: 'green-main' });
    expect(lastAuditedHash(s.auditPath)).toBe(hash);
    const fresh = s.open(); // a new process: the expected hash comes from the audit log
    const r = fresh.read();
    expect(r).toMatchObject({ ok: true, hash });
    expect(fresh.baselines().map((b) => b.commit)).toEqual([sha('a')]);
    expect(fresh.hash()).toBe(hash);
  });

  it('a file changed behind the server\'s back does not match the audited hash: no baseline', () => {
    const s = store();
    s.open().add(baseline('a'));
    // A test (or anything else running as the same user) rewrites a count and a digest.
    const doc = JSON.parse(fs.readFileSync(s.file, 'utf-8')) as MainFileCountsFile;
    doc.baselines[0].files[A] = row(3, D('f'));
    fs.writeFileSync(s.file, JSON.stringify(doc));
    for (const st of [s.open()]) {
      expect(st.read()).toEqual({ ok: false, reason: 'hash-mismatch' });
      expect(st.baselines()).toEqual([]);
      expect(st.hash()).toBeNull();
    }
    // The next green main verify replaces it (never merges into it), and it reads again.
    const repaired = s.open();
    repaired.add(baseline('b'));
    expect(s.open().baselines().map((b) => b.commit)).toEqual([sha('b')]);
  });

  it('no file, no audited hash, a malformed file and an oversize file all mean no baseline', () => {
    const s = store();
    expect(s.open().read()).toEqual({ ok: false, reason: 'absent' });
    fs.mkdirSync(path.dirname(s.file), { recursive: true });
    fs.writeFileSync(s.file, JSON.stringify(withBaseline(empty, baseline('a'))));
    expect(s.open().read()).toEqual({ ok: false, reason: 'no-audited-hash' }); // a file nobody audited
    const text = '{"v":1,"baselines":"none","pinned":[]}';
    fs.writeFileSync(s.file, text);
    const malformed = new MainFileCountsStore({ stateDir: s.dir, audit: () => {}, auditedHash: () => crypto.createHash('sha256').update(text).digest('hex') });
    expect(malformed.read()).toEqual({ ok: false, reason: 'malformed' });
    fs.writeFileSync(s.file, Buffer.alloc(MAIN_FILE_COUNTS_LIMITS.maxBytes + 1, 0x20));
    expect(s.open().read()).toEqual({ ok: false, reason: 'oversize' });
  });

  it('the audited hash is found in a rotated log too, and the newest row wins', () => {
    const s = store();
    fs.mkdirSync(path.dirname(s.auditPath), { recursive: true });
    fs.writeFileSync(`${s.auditPath}.1`, `${JSON.stringify({ event: 'main-file-counts-written', hash: D('a') })}\n`);
    expect(lastAuditedHash(s.auditPath)).toBe(D('a'));
    fs.writeFileSync(s.auditPath, `${JSON.stringify({ event: 'started' })}\n${JSON.stringify({ event: 'main-file-counts-written', hash: D('b') })}\n${JSON.stringify({ event: 'main-file-counts-written', hash: D('c') })}\nnot json main-file-counts-written\n`);
    expect(lastAuditedHash(s.auditPath)).toBe(D('c'));
    expect(lastAuditedHash(path.join(s.dir, 'logs', 'none.jsonl'))).toBeNull();
  });

  it('pins and releases a dry run\'s baseline, and a peer stores the coordinator\'s copy under its own audit row', () => {
    const s = store();
    const st = s.open();
    st.add(baseline('a'));
    expect(st.pin(sha('a'), true)).toBe(true);
    expect(st.pin(sha('f'), true)).toBe(false);
    for (const c of ['b', 'c', 'd']) st.add(baseline(c));
    expect(s.open().baselines().map((b) => b.commit)).toEqual([sha('d'), sha('c'), sha('b'), sha('a')]);
    expect(st.pin(sha('a'), false)).toBe(true);
    expect(s.open().baselines().map((b) => b.commit)).toEqual([sha('d'), sha('c'), sha('b')]);
    const peer = store();
    const read = s.open().read();
    if (!read.ok) throw new Error('unreadable');
    const hash = peer.open().replace(read.file);
    expect(hash).toBe(read.hash); // the same bytes, so the same hash on both machines
    expect(peer.open().baselines().map((b) => b.commit)).toEqual([sha('d'), sha('c'), sha('b')]);
    expect(JSON.parse(fs.readFileSync(peer.auditPath, 'utf-8').trim().split('\n').at(-1)!)).toMatchObject({ event: 'main-file-counts-written', why: 'from-coordinator' });
  });
});
