// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { parseLadderRegistry } from '../../src/monitoring/MaturationLadder.js';

// Maturation Path, clause (h): a dark rung has a dated owner. The lint fails the build for a dark
// rung with no owner or no review date; the runtime parser only validates the fields when present,
// so one entry can never reject the whole registry.
const LINT = path.resolve('scripts/lint-maturation-dated-owner.mjs');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'lint-maturation-dated-owner.test.ts' }); });

type Entry = Record<string, unknown>;
const entry = (id: string, tracking: Record<string, unknown>, extra: Entry = {}): Entry => ({
  id, disposition: 'ladder', tracking: { state: 'measured', plan: 'Measured weekly.', ...tracking }, ...extra,
});
function run(entries: Entry[], today = '2026-12-01'): { code: number; out: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dated-owner-lint-')));
  dirs.push(root);
  fs.mkdirSync(path.join(root, 'src/data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/data/feature-ladders.json'), JSON.stringify({ schema: 'feature-ladders/1', entries }));
  const r = spawnSync(process.execPath, [LINT, `--today=${today}`], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  return { code: r.status ?? -1, out: `${r.stdout}\n${r.stderr}` };
}

describe('lint-maturation-dated-owner', () => {
  it('passes when every dark rung has an owner and a review date', () => {
    const r = run([entry('a.one', { owner: 'echo-pipeline-strategy', reviewDue: '2026-12-04' })]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('1 dark rung(s), each with an owner and a review date; 0 past due');
  });

  it('fails a dark rung with no owner, naming it', () => {
    const r = run([entry('a.one', { reviewDue: '2026-12-04' })]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('a.one is a dark rung with no owner');
  });

  it('fails a dark rung with no review date, or a malformed one', () => {
    expect(run([entry('a.one', { owner: 'x' })]).out).toContain('a.one is a dark rung with no reviewDue');
    expect(run([entry('a.one', { owner: 'x', reviewDue: 'next week' })]).code).toBe(1);
    expect(run([entry('a.one', { owner: 'x', reviewDue: '2026-02-30' })]).code).toBe(1); // a date that does not exist
    expect(run([entry('a.one', { owner: ' ', reviewDue: '2026-12-04' })]).code).toBe(1);
  });

  it('ignores finished, composed and retiring entries', () => {
    const r = run([
      entry('a.done', {}, { finished: { on: '2026-11-01' } }),
      entry('a.part', {}, { disposition: 'composed', composedInto: 'x' }),
      entry('a.gone', {}, { disposition: 'retire' }),
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('0 dark rung(s)');
  });

  it('reports a passed review date by name but does not fail the build', () => {
    const r = run([entry('a.late', { owner: 'echo-scaling', reviewDue: '2026-11-20' })], '2026-12-01');
    expect(r.code).toBe(0);
    expect(r.out).toContain('1 dark rung(s) past their review date (reported, not failed)');
    expect(r.out).toContain('a.late: due 2026-11-20, owner echo-scaling');
  });

  it('fails loudly on an unreadable registry', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dated-owner-lint-')));
    dirs.push(root);
    const r = spawnSync(process.execPath, [LINT], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unreadable or not JSON');
  });
});

describe('MaturationLadder parser — owner and reviewDue', () => {
  const real = JSON.parse(fs.readFileSync('src/data/feature-ladders.json', 'utf8')) as { schema: string; entries: Entry[] };
  const withTracking = (t: Record<string, unknown>) => {
    const copy = structuredClone(real);
    const e = copy.entries.find((x) => x.disposition === 'ladder' && !x.finished)!;
    e.tracking = { ...(e.tracking as object), ...t };
    return { text: JSON.stringify(copy), id: e.id as string };
  };

  it('accepts the shipped registry, whose entries may not carry the fields yet', () => {
    expect(parseLadderRegistry(JSON.stringify(real)).ok).toBe(true);
  });

  it('keeps a valid owner and reviewDue on the parsed entry', () => {
    const { text, id } = withTracking({ owner: 'echo-pipeline-strategy', reviewDue: '2026-12-04' });
    const r = parseLadderRegistry(text);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.registry.entries.find((x) => x.id === id)!.tracking).toMatchObject({ owner: 'echo-pipeline-strategy', reviewDue: '2026-12-04' });
  });

  it('keeps a recorded reason for a date, and refuses an empty one', () => {
    const ok = parseLadderRegistry(withTracking({ owner: 'x', reviewDue: '2026-12-07', reviewDueReason: 'First expected 2026-06-20; re-dated at owner assignment on 2026-11-27.' }).text);
    expect(ok.ok).toBe(true);
    const bad = parseLadderRegistry(withTracking({ reviewDueReason: '' }).text);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toMatch(/tracking\.reviewDueReason$/);
  });

  it('refuses a present but malformed owner or reviewDue', () => {
    const a = parseLadderRegistry(withTracking({ owner: '' }).text);
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.reason).toMatch(/tracking\.owner$/);
    expect(parseLadderRegistry(withTracking({ reviewDue: '2026-02-30' }).text).ok).toBe(false);
    const b = parseLadderRegistry(withTracking({ reviewDue: '2026-12-04T00:00' }).text);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toMatch(/tracking\.reviewDue$/);
  });
});
