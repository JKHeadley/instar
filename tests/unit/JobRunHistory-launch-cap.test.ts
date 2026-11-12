/**
 * T6 (frozen acceptance list, step3/acceptance-tests.md): `launch` under the existing
 * 2,048-byte row cap (spec job-launch-intent-record D9, §4 record bounds).
 * Red on main: recordStart does not store `launch`, and `launch` is not in TRUNCATABLE_FIELDS.
 *
 *  - Shedding the other optional fields (outputSummary, stateSnapshot, handoffNotes, reflection)
 *    comes first; when that is enough, `launch` SURVIVES intact.
 *  - Only when it is not enough is `launch` shed; every essential field is kept unchanged.
 *  - Sizes are computed in the test from a measured base row, so each case sits on the boundary
 *    it claims to test regardless of incidental field lengths.
 *  - Bounds (contract fixed here): JobRunHistory.recordStart keeps the first 8 entries of each of
 *    `applied` and `dropped`, in order, and sets `omitted` to the number of entries it removed
 *    across both arrays; `omitted` is absent when nothing was removed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JobRunHistory } from '../../src/scheduler/JobRunHistory.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const CAP = 2048;
const OPTIONAL = ['outputSummary', 'stateSnapshot', 'handoffNotes', 'reflection', 'launch'];
const START = { slug: 'j', sessionId: 'sess-1', trigger: 'scheduled', model: 'opus', framework: 'claude-code', origin: 'user' as const };
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf-8');
const omit = (r: Record<string, unknown>, keys: string[]) => Object.fromEntries(Object.entries(r).filter(([k]) => !keys.includes(k)));
const entry = (value: string) => ({ feature: 'thinkingMode', requestedValue: 'low', value, channel: 'argv' });
/** A launch whose own JSON (as `"launch":{...}` inside a row) adds exactly `size` bytes, give or take 0. */
function launchAdding(size: number) {
  const make = (pad: number) => ({ cliVersion: '2.1.322', requested: { thinkingMode: 'low' }, applied: [entry('l'.repeat(pad))], dropped: [] });
  const overhead = bytes({ launch: make(0) }) - 2; // `"launch":{...}` minus the braces of the wrapper
  const pad = size - overhead - 1; // -1 for the comma joining it to the row
  expect(pad, 'requested launch size is too small to build').toBeGreaterThan(0);
  return make(pad);
}
const REFLECTION = (n: number) => ({ summary: 's'.repeat(n), strengths: [], improvements: [], deviationAnalysis: null, purposeDrift: null, suggestedChanges: [] });

describe('T6 launch and the row size cap', () => {
  let dir: string;
  let h: JobRunHistory;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-launch-cap-'));
    fs.mkdirSync(path.join(dir, 'ledger'), { recursive: true });
    h = new JobRunHistory(dir);
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/JobRunHistory-launch-cap.test.ts:cleanup' }));

  /** Size of a completed row carrying no optional field at all (the essentials). */
  function measuredBase(): number {
    const id = h.recordStart(START);
    h.recordCompletion({ runId: id, result: 'success' });
    return bytes(h.findRun(id));
  }
  const run = (id: string) => h.findRun(id) as unknown as Record<string, unknown>;

  it('shedding outputSummary alone suffices: launch survives intact, essentials unchanged', () => {
    const base = measuredBase();
    const launch = launchAdding(CAP - base - 300); // base + launch = CAP - 300: fits
    const id = h.recordStart({ ...START, launch } as never);
    const started = run(id);
    expect(started.launch, 'recordStart did not store launch').toEqual(launch);
    h.recordCompletion({ runId: id, result: 'success', outputSummary: 'y'.repeat(900) }); // pushes it over
    const stored = run(id);
    expect(stored.truncated).toBe(true);
    expect(stored.outputSummary).toBeUndefined();
    expect(stored.launch, 'launch was shed although dropping outputSummary was enough').toEqual(launch);
    expect(bytes(stored)).toBeLessThanOrEqual(CAP);
    expect(omit(stored, [...OPTIONAL, 'truncated', 'completedAt', 'durationSeconds', 'result']))
      .toEqual(omit(started, [...OPTIONAL, 'completedAt', 'durationSeconds', 'result']));
    expect(stored.result).toBe('success');
    expect(typeof stored.completedAt).toBe('string');
    expect(typeof stored.durationSeconds).toBe('number');
  });

  it('every other optional field is shed before launch: launch is the last one standing', () => {
    const base = measuredBase();
    const launch = launchAdding(CAP - base - 150); // fits alone, but not with any 200+ byte field beside it
    const id = h.recordStart({ ...START, launch } as never);
    const started = run(id);
    expect(started.launch, 'recordStart did not store launch').toEqual(launch);
    h.recordHandoff(id, 'h'.repeat(250), { snap: 'x'.repeat(250) });
    h.recordReflection(id, REFLECTION(250));
    h.recordCompletion({ runId: id, result: 'success', outputSummary: 'y'.repeat(250) });
    const stored = run(id);
    expect(stored.truncated).toBe(true);
    for (const f of ['outputSummary', 'stateSnapshot', 'handoffNotes', 'reflection']) expect(stored[f], `${f} kept over launch`).toBeUndefined();
    expect(stored.launch, 'launch was shed before the other optional fields').toEqual(launch);
    expect(bytes(stored)).toBeLessThanOrEqual(CAP);
    expect(omit(stored, [...OPTIONAL, 'truncated', 'completedAt', 'durationSeconds', 'result']))
      .toEqual(omit(started, [...OPTIONAL, 'completedAt', 'durationSeconds', 'result']));
  });

  it('when even launch must go, the row lands with no launch and every essential field unchanged', () => {
    const controlId = h.recordStart(START);
    const control = run(controlId);
    const huge = { cliVersion: '2.1.322', requested: { thinkingMode: 'low' }, applied: Array.from({ length: 8 }, () => entry('z'.repeat(400))), dropped: [] };
    expect(bytes(huge)).toBeGreaterThan(CAP);
    const id = h.recordStart({ ...START, launch: huge } as never);
    const stored = run(id);
    expect(stored, 'the row was refused instead of shedding launch').toBeTruthy();
    expect(stored.launch).toBeUndefined();
    expect(stored.truncated, 'no truncated marker: launch was never on the row').toBe(true);
    expect(bytes(stored)).toBeLessThanOrEqual(CAP);
    expect(omit(stored, [...OPTIONAL, 'truncated', 'runId', 'startedAt'])).toEqual(omit(control, [...OPTIONAL, 'runId', 'startedAt']));
    expect(stored.runId).toBe(id);
  });

  describe('entry bounds: at most 8 per array, the rest counted in `omitted`', () => {
    const many = (n: number, tag: string) => Array.from({ length: n }, (_, i) => entry(`${tag}${i}`));
    const drops = (n: number) => Array.from({ length: n }, (_, i) => ({ feature: 'thinkingMode', requestedValue: 'low', reason: i % 2 ? 'invalid' : 'not-supported' }));

    it('11 applied + 9 dropped → first 8 of each kept in order, omitted 4', () => {
      const launch = { cliVersion: '2.1.322', requested: { thinkingMode: 'low' }, applied: many(11, 'a'), dropped: drops(9) };
      const stored = run(h.recordStart({ ...START, launch } as never)).launch as Record<string, unknown> | undefined;
      expect(stored, 'recordStart did not store launch').toBeDefined();
      expect(stored!.applied).toEqual(launch.applied.slice(0, 8));
      expect(stored!.dropped).toEqual(launch.dropped.slice(0, 8));
      expect(stored!.omitted).toBe(4);
    });

    it('9 applied + 0 dropped → omitted 1', () => {
      const launch = { cliVersion: '2.1.322', requested: {}, applied: many(9, 'b'), dropped: [] };
      const stored = run(h.recordStart({ ...START, launch } as never)).launch as Record<string, unknown> | undefined;
      expect(stored, 'recordStart did not store launch').toBeDefined();
      expect(stored!.applied).toHaveLength(8);
      expect(stored!.omitted).toBe(1);
    });

    it('exactly 8 + 8 → nothing removed, no omitted key', () => {
      const launch = { cliVersion: '2.1.322', requested: {}, applied: many(8, 'c'), dropped: drops(8) };
      const stored = run(h.recordStart({ ...START, launch } as never)).launch as Record<string, unknown> | undefined;
      expect(stored, 'recordStart did not store launch').toEqual(launch);
      expect(stored).not.toHaveProperty('omitted');
    });
  });
});
