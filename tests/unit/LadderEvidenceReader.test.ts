import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonlQueries, type JsonlQuery } from '../../src/monitoring/LadderEvidenceReader.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const DAY = 86_400_000;
const now = Date.parse('2026-11-03T00:00:00Z');
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) SafeFsExecutor.safeRmSync(r, { recursive: true, force: true, operation: 'LadderEvidenceReader.test' }); });

function home(files: Record<string, unknown[]>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-reader-'));
  roots.push(root);
  for (const [name, rows] of Object.entries(files)) {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  }
  return root;
}
const at = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString();
const q = (over: Partial<JsonlQuery> & { ref: JsonlQuery['ref'] }): JsonlQuery => ({ key: 'k', sinceMs: now - 14 * DAY, direction: 'at-least', ...over });
const one = async (root: string, query: JsonlQuery) => (await readJsonlQueries(root, [query], now)).get('k')!;

describe('readJsonlQueries', () => {
  it('counts matches in the window, with exposure as samples', async () => {
    const root = home({ 'logs/a.jsonl': [
      { at: at(1), kind: 'fired' }, { at: at(2), kind: 'held' }, { at: at(30), kind: 'fired' }, { at: at(3), kind: 'error' },
    ] });
    expect(await one(root, q({ ref: { file: 'logs/a.jsonl', where: { kind: 'fired' }, value: 'count' } }))).toMatchObject({ value: 1, samples: 3 });
  });

  it('a clean harm count reads 0 with real exposure, so it can pass', async () => {
    const root = home({ 'logs/a.jsonl': [{ at: at(1), kind: 'fired' }, { at: at(2), kind: 'fired' }] });
    expect(await one(root, q({ direction: 'at-most', ref: { file: 'logs/a.jsonl', where: { kind: 'error' }, value: 'count' } }))).toMatchObject({ value: 0, samples: 2 });
  });

  it('computes a ratio over its cohort, and no denominator means no number', async () => {
    const root = home({ 'logs/a.jsonl': [{ at: at(1), ok: true }, { at: at(1), ok: false }, { at: at(2), ok: true }, { at: at(2), other: 1 }] });
    const ref = { file: 'logs/a.jsonl', where: { ok: true }, of: { ok: true }, value: 'ratio' as const };
    expect((await one(root, q({ ref }))).value).toBe(1);
    const none = await one(root, q({ ref: { ...ref, of: { ok: 'never' } } }));
    expect(none).toMatchObject({ value: null, samples: 0 });
  });

  it('dedupes so a re-graded event counts once, last grade wins', async () => {
    const root = home({ 'logs/a.jsonl': [
      { at: at(3), gradesEventId: 'e1', outcome: 'wrong', kind: 'outcome' },
      { at: at(2), gradesEventId: 'e1', outcome: 'right', kind: 'outcome' },
      { at: at(2), gradesEventId: 'e2', outcome: 'right', kind: 'outcome' },
    ] });
    const r = await one(root, q({ ref: { file: 'logs/a.jsonl', where: { outcome: 'right' }, of: { kind: 'outcome' }, value: 'ratio', dedupe: 'gradesEventId' } }));
    expect(r).toMatchObject({ value: 1, samples: 2 });
  });

  it('reads all rotated segments', async () => {
    const root = home({ 'logs/a.jsonl': [{ at: at(1), k: 1 }], 'logs/a.jsonl.3': [{ at: at(13), k: 1 }], 'logs/a.jsonl.4': [{ at: at(5), k: 1 }] });
    expect((await one(root, q({ ref: { file: 'logs/a.jsonl', where: { k: 1 }, value: 'count' } }))).value).toBe(3);
  });

  it('a cut log withholds anything missing rows could flip, but keeps an at-least count', async () => {
    const root = home({ 'logs/a.jsonl': [{ at: at(2), kind: 'error' }, { at: at(1), kind: 'fired' }], 'logs/a.jsonl.1': [{ at: at(3), kind: 'fired' }] });
    const cut = { file: 'logs/a.jsonl', where: { kind: 'error' }, value: 'count' as const };
    const harm = await one(root, q({ direction: 'at-most', ref: cut }));
    expect(harm).toMatchObject({ value: null, reason: 'evidence-cut' });
    expect(harm.coverageDays).toBeGreaterThan(0);
    const ratio = await one(root, q({ direction: 'at-most', ref: { ...cut, of: { kind: 'fired' }, value: 'ratio' } }));
    expect(ratio).toMatchObject({ value: null, reason: 'evidence-cut' });
    const atLeast = await one(root, q({ ref: { ...cut, where: { kind: 'fired' } } }));
    expect(atLeast.value).toBe(2);
    expect(atLeast.reason).toBeUndefined();
  });

  it('a young log that never rotated is not treated as cut', async () => {
    const root = home({ 'logs/a.jsonl': [{ at: at(1), kind: 'fired' }] });
    expect(await one(root, q({ direction: 'at-most', ref: { file: 'logs/a.jsonl', where: { kind: 'error' }, value: 'count' } }))).toMatchObject({ value: 0, samples: 1 });
  });

  it('a stale ran metric reads as nothing, so a burst then a crash cannot hold a soak', async () => {
    const root = home({ 'logs/a.jsonl': [{ at: at(10), kind: 'fired' }, { at: at(9), kind: 'fired' }, { at: at(1), kind: 'other' }] });
    const r = await one(root, q({ freshWithinMs: 7 * DAY, ref: { file: 'logs/a.jsonl', where: { kind: 'fired' }, value: 'count' } }));
    expect(r).toMatchObject({ value: 0, samples: 0 });
  });

  it('tolerates junk lines, epoch seconds and a missing file', async () => {
    const root = home({ 'logs/a.jsonl': [] });
    fs.writeFileSync(path.join(root, 'logs/a.jsonl'), `not json\n${JSON.stringify({ ts: Math.floor((now - DAY) / 1000) })}\n{"no":"time"}\n`);
    expect((await one(root, q({ ref: { file: 'logs/a.jsonl', value: 'count' } }))).value).toBe(1);
    expect(await one(root, q({ ref: { file: 'logs/missing.jsonl', value: 'count' } }))).toMatchObject({ value: 0, samples: 0 });
  });

  it('refuses a disallowed path and a symlink out of the home', async () => {
    const root = home({ 'logs/a.jsonl': [{ at: at(1) }] });
    expect(await one(root, q({ ref: { file: '../outside.jsonl', value: 'count' } }))).toMatchObject({ value: null, reason: 'file-refused' });
    const outside = home({ 'x.jsonl': [{ at: at(1) }] });
    fs.symlinkSync(path.join(outside, 'x.jsonl'), path.join(root, 'logs/link.jsonl'));
    expect(await one(root, q({ ref: { file: 'logs/link.jsonl', value: 'count' } }))).toMatchObject({ value: null, reason: 'file-refused' });
  });
});
