// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-1 tests for the operator queue store (spec docs/specs/local-verify-queue-controls.md,
 * "What the controls remember"): the atomic write with the previous good copy kept beside the
 * file, the read that falls back to that copy, the report when neither can be read, the
 * record bound, and the pure helpers.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import {
  MAX_TIME_MS, OPERATOR_QUEUE_LIMITS, OperatorQueueStore, bootReason, cleanLabel, cleanMergeHoldReason, holdDueAt, holdReminderDue,
  inspectOperatorRecord, isValidTime, parseOperatorRecord, parseSavedEntry, parseUntil, safeIso,
} from '../../../src/localVerify/operatorQueue.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'operatorQueue.test.ts' }); });

const T0 = Date.parse('2026-11-18T12:00:00.000Z');
const HOUR = 60 * 60_000;
const sha = (c: string) => c.repeat(40);

function store(dir?: string) {
  const d = dir ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvopstore-')));
  if (!dir) dirs.push(d);
  const file = path.join(d, 'state', 'local-verify', 'operator-queue.json');
  const audits: Array<Record<string, unknown>> = [];
  let t = T0;
  const s = new OperatorQueueStore(file, () => t, (e) => { audits.push(e); });
  return { s, d, file, audits, advance: (ms: number) => { t += ms; } };
}

const hold = (s: OperatorQueueStore, pr: number, reason = 'waiting on 120') => { s.ensure(pr).hold = { by: 'echo', reason, at: T0 }; };

describe('the store: one file, written atomically, with the previous good copy beside it', () => {
  it('starts empty with no file, and writes nothing until asked', () => {
    const { s, file } = store();
    expect(s.load()).toEqual({ status: 'absent' });
    expect(s.size()).toBe(0);
    expect(s.isHeld(7)).toBe(false);
    expect(s.frontOrder(7)).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('a hold and a front survive a new store on the same file', () => {
    const a = store();
    hold(a.s, 7);
    a.s.ensure(7).hold!.entry = { headSha: sha('a'), baseSha: sha('b'), baseRefName: 'main', firstQueuedAt: T0 - HOUR, attempts: 1, errorRetries: 0, starvedRaised: false };
    a.s.ensure(9).front = { order: a.s.takeOrder(), by: 'echo', reason: 'unblocks 14', at: T0 };
    a.s.markOverCap(9);
    expect(a.s.persist()).toBe(true);
    expect(fs.existsSync(`${a.file}.tmp`)).toBe(false); // the temporary file was renamed into place
    const b = store(a.d);
    expect(b.s.load()).toEqual({ status: 'ok' });
    expect(b.s.isHeld(7)).toBe(true);
    expect(b.s.get(7)!.hold).toMatchObject({ by: 'echo', reason: 'waiting on 120', entry: { headSha: sha('a'), firstQueuedAt: T0 - HOUR } });
    expect(b.s.frontOrder(9)).toBe(1);
    expect(b.s.overCapCount()).toBe(1);
    // The rising number never goes back after a restart.
    expect(b.s.takeOrder()).toBe(2);
  });

  it('keeps the previous good copy after every write, and an unchanged store is not rewritten', () => {
    const { s, file } = store();
    hold(s, 1);
    s.persist();
    expect(fs.existsSync(`${file}.prev`)).toBe(false); // nothing before the first write
    hold(s, 2);
    s.persist();
    const prev = JSON.parse(fs.readFileSync(`${file}.prev`, 'utf-8')) as { records: Array<{ pr: number }> };
    expect(prev.records.map((r) => r.pr)).toEqual([1]); // the copy from before this write
    const before = fs.statSync(file).mtimeMs;
    const prevBefore = fs.readFileSync(`${file}.prev`, 'utf-8');
    expect(s.persist()).toBe(true);
    expect(fs.statSync(file).mtimeMs).toBe(before);
    expect(fs.readFileSync(`${file}.prev`, 'utf-8')).toBe(prevBefore);
  });

  it('an unreadable file with a good previous copy: the copy is used, the holds it restored are named, the bad file is kept aside', () => {
    const a = store();
    hold(a.s, 1, 'first');
    a.s.persist();
    hold(a.s, 2, 'second');
    a.s.persist(); // .prev now holds [1]
    fs.writeFileSync(a.file, '{"v":1,"records":[{"pr":1,"hold":'); // torn
    const b = store(a.d);
    const report = b.s.load();
    expect(report).toEqual({ status: 'restored-from-previous', holds: [{ pr: 1, reason: 'first' }], fronted: [] });
    expect(b.s.isHeld(1)).toBe(true);
    expect(b.s.isHeld(2)).toBe(false); // the most recent change is the one that may be missing
    expect(fs.readdirSync(path.dirname(a.file)).some((n) => n.startsWith('operator-queue.json.corrupt-'))).toBe(true);
    // The restored copy is the file again, so the next boot reads it without a report.
    expect(store(a.d).s.load()).toEqual({ status: 'ok' });
  });

  it('an unreadable file with no readable previous copy: empty, and reported as lost', () => {
    const a = store();
    hold(a.s, 1);
    a.s.persist();
    fs.writeFileSync(a.file, 'not json');
    const b = store(a.d);
    expect(b.s.load()).toEqual({ status: 'lost' });
    expect(b.s.size()).toBe(0);
    // Both unreadable is lost too.
    const c = store();
    hold(c.s, 1);
    c.s.persist();
    hold(c.s, 2);
    c.s.persist();
    fs.writeFileSync(c.file, '[]');
    fs.writeFileSync(`${c.file}.prev`, '{"v":2}');
    expect(store(c.d).s.load()).toEqual({ status: 'lost' });
  });

  it('a double corruption is reported as lost once: three loads in a row say lost, then ok, then ok', () => {
    const a = store();
    hold(a.s, 1);
    a.s.persist();
    hold(a.s, 2);
    a.s.persist();
    fs.writeFileSync(a.file, 'garbage');
    fs.writeFileSync(`${a.file}.prev`, 'garbage too');
    expect([store(a.d).s.load().status, store(a.d).s.load().status, store(a.d).s.load().status]).toEqual(['lost', 'ok', 'ok']);
    // Both unreadable copies are kept aside as evidence, and the file is the empty state.
    const names = fs.readdirSync(path.dirname(a.file));
    expect(names.some((n) => n.startsWith('operator-queue.json.corrupt-'))).toBe(true);
    expect(names.some((n) => n.startsWith('operator-queue.json.prev.corrupt-'))).toBe(true);
    expect(names).not.toContain('operator-queue.json.prev');
    expect(JSON.parse(fs.readFileSync(a.file, 'utf-8'))).toMatchObject({ v: 1, records: [] });
    // The main file gone and only an unreadable previous copy left: lost once as well.
    const b = store();
    fs.mkdirSync(path.dirname(b.file), { recursive: true });
    fs.writeFileSync(`${b.file}.prev`, '{{');
    expect([store(b.d).s.load().status, store(b.d).s.load().status]).toEqual(['lost', 'ok']);
  });

  it('a write that fails is audited and reports false, and the store keeps working in memory', () => {
    const { s, file, audits } = store();
    fs.mkdirSync(path.dirname(path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.dirname(file), 'a file where the folder should be');
    hold(s, 1);
    expect(s.persist()).toBe(false);
    expect(audits.map((a) => a.event)).toEqual(['operator-file-write-failed']);
    expect(s.isHeld(1)).toBe(true);
  });

  it('restore() puts a record back exactly as it was before a change that could not be written', () => {
    const { s } = store();
    hold(s, 1, 'as it was');
    const before = s.copyOf(1);
    s.ensure(1).hold!.reason = 'changed';
    s.ensure(1).front = { order: 5, by: 'x', reason: 'y', at: T0 };
    s.restore(1, before);
    expect(s.get(1)).toEqual({ pr: 1, hold: { by: 'echo', reason: 'as it was', at: T0 } });
    s.restore(2, null);
    expect(s.get(2)).toBeNull();
  });
});

describe('the store: holds, front marks, the bound and the overflow', () => {
  it('held = a hold that is not being released; the record goes when its last part goes', () => {
    const { s } = store();
    hold(s, 1);
    s.ensure(1).front = { order: s.takeOrder(), by: 'echo', reason: 'r', at: T0 };
    expect(s.isHeld(1)).toBe(true);
    s.get(1)!.hold!.releasing = { by: 'echo', at: T0 };
    expect(s.isHeld(1)).toBe(false);
    expect(s.held().map((r) => r.pr)).toEqual([1]); // still listed while the release finishes
    s.clearHold(1);
    expect(s.get(1)).toEqual({ pr: 1, front: { order: 1, by: 'echo', reason: 'r', at: T0 } });
    s.clearFront(1);
    expect(s.get(1)).toBeNull();
    expect(s.size()).toBe(0);
  });

  it('fronted() lists the most recently fronted first', () => {
    const { s } = store();
    for (const pr of [10, 11, 12]) s.ensure(pr).front = { order: s.takeOrder(), by: 'echo', reason: 'r', at: T0 };
    s.ensure(10).front!.order = s.takeOrder(); // fronted again
    expect(s.fronted().map((r) => r.pr)).toEqual([10, 12, 11]);
    expect(s.anyFront()).toBe(true);
    expect(s.anyHold()).toBe(false);
  });

  it('has room for 200 changes, and for a change it already remembers', () => {
    const { s } = store();
    for (let pr = 1; pr <= OPERATOR_QUEUE_LIMITS.maxRecords; pr++) hold(s, pr);
    expect(s.size()).toBe(200);
    expect(s.hasRoomFor(201)).toBe(false);
    expect(s.hasRoomFor(200)).toBe(true);
    expect(s.drop(5)).toBe(true);
    expect(s.hasRoomFor(201)).toBe(true);
    expect(s.drop(5)).toBe(false);
  });

  it('the overflow counts an over-cap admission only while its entry is queued', () => {
    const { s } = store();
    s.markOverCap(1);
    s.markOverCap(2);
    expect(s.overflowUsed(new Set([1, 2, 3]))).toBe(2);
    expect(s.overflowUsed(new Set([2]))).toBe(1); // PR 1 left the queue
    expect(s.overflowUsed(new Set([1, 2]))).toBe(1); // and does not count again when it comes back
  });

  it('a stored record is re-validated: a bad hold or front is dropped, a good one kept', () => {
    expect(parseOperatorRecord({ pr: 3, hold: { by: 'echo', reason: 'r', at: T0, until: T0 + HOUR, wanted: 'watcher', reminded: true } }))
      .toEqual({ pr: 3, hold: { by: 'echo', reason: 'r', at: T0, until: T0 + HOUR, wanted: 'watcher', reminded: true } });
    expect(parseOperatorRecord({ pr: 3, hold: { by: '', reason: 'r', at: T0 } })).toBeNull();
    expect(parseOperatorRecord({ pr: 3, front: { order: 0, by: 'e', reason: 'r', at: T0 } })).toBeNull();
    expect(parseOperatorRecord({ pr: -1, hold: { by: 'e', reason: 'r', at: T0 } })).toBeNull();
    // A hold whose saved entry is malformed stays in force without the entry (the entry is never repaired).
    expect(parseOperatorRecord({ pr: 3, hold: { by: 'e', reason: 'r', at: T0, entry: { headSha: 'nope' } }, front: { order: 2, by: 'e', reason: 'r', at: T0, admitting: true } }))
      .toEqual({ pr: 3, hold: { by: 'e', reason: 'r', at: T0 }, front: { order: 2, by: 'e', reason: 'r', at: T0, admitting: true } });
    expect(parseOperatorRecord({ pr: 3, hold: { by: 'e', reason: 'r', at: T0, releasing: { by: 'e', at: T0 + 1, tries: 2 } } }))
      .toEqual({ pr: 3, hold: { by: 'e', reason: 'r', at: T0, releasing: { by: 'e', at: T0 + 1, tries: 2 } } });
  });
});

describe('times a Date cannot hold, and saved entries, are refused from disk', () => {
  const entry = { headSha: sha('a'), baseSha: sha('b'), baseRefName: 'main', firstQueuedAt: T0, attempts: 1, errorRetries: 0, starvedRaised: false };

  it('isValidTime and safeIso: inside the Date range only, and safeIso never throws', () => {
    expect(isValidTime(T0)).toBe(true);
    expect(isValidTime(MAX_TIME_MS)).toBe(true);
    for (const bad of [1e300, MAX_TIME_MS + 1, -1, 0, Number.NaN, Number.POSITIVE_INFINITY, '5', null, undefined]) expect(isValidTime(bad), String(bad)).toBe(false);
    expect(safeIso(T0)).toBe('2026-11-18T12:00:00.000Z');
    for (const bad of [1e300, Number.NaN, -5, 'x', undefined]) expect(safeIso(bad)).toBeNull();
  });

  it('a hold or a front mark with an out-of-range time is an invalid record', () => {
    expect(parseOperatorRecord({ pr: 3, hold: { by: 'e', reason: 'r', at: 1e300 } })).toBeNull();
    expect(parseOperatorRecord({ pr: 3, hold: { by: 'e', reason: 'r', at: T0, until: 1e300 } })).toBeNull();
    expect(parseOperatorRecord({ pr: 3, hold: { by: 'e', reason: 'r', at: T0, takenAt: 1e300 } })).toBeNull();
    expect(parseOperatorRecord({ pr: 3, hold: { by: 'e', reason: 'r', at: T0, releasing: { by: 'e', at: 1e300 } } })).toBeNull();
    expect(parseOperatorRecord({ pr: 3, front: { order: 1, by: 'e', reason: 'r', at: 1e300 } })).toBeNull();
    expect(parseOperatorRecord({ pr: 3, hold: { by: 'e', reason: 'r', at: T0, until: T0 + HOUR } })).not.toBeNull();
  });

  it('a file holding a record with a time of 1e300 loads without it, says so, and nothing built from the store can throw on it', () => {
    const a = store();
    fs.mkdirSync(path.dirname(a.file), { recursive: true });
    fs.writeFileSync(a.file, JSON.stringify({ v: 1, savedAt: T0, nextOrder: 3, overCap: [], leaseNoticeAt: 1e300, records: [
      { pr: 1, hold: { by: 'e', reason: 'bad time', at: 1e300 } },
      { pr: 2, hold: { by: 'e', reason: 'good', at: T0 }, front: { order: 2, by: 'e', reason: 'bad front time', at: 1e300 } },
    ] }));
    expect(a.s.load()).toEqual({ status: 'ok' });
    expect(a.s.records()).toEqual([{ pr: 2, hold: { by: 'e', reason: 'good', at: T0 } }]);
    expect(a.s.leaseNoticeSentAt()).toBeNull();
    expect(a.audits).toEqual([
      { event: 'operator-file-invalid-record', pr: 1, what: 'hold-dropped' },
      { event: 'operator-file-invalid-record', pr: 2, what: 'front-dropped' },
    ]);
    expect(a.s.loadIssues()).toEqual([{ pr: 1, what: 'hold-dropped' }, { pr: 2, what: 'front-dropped' }]);
    // The file was rewritten without them: the next start has nothing to report.
    const again = store(a.d);
    expect(again.s.load()).toEqual({ status: 'ok' });
    expect(again.s.loadIssues()).toEqual([]);
    for (const r of a.s.records()) expect(() => new Date(r.hold!.at).toISOString()).not.toThrow();
  });

  it('a saved entry is checked field by field: type, range and the branch-name pattern', () => {
    expect(parseSavedEntry(entry)).toEqual(entry);
    const full = { ...entry, firstRefusedAt: T0 - HOUR, pausedMs: 5000, baseResolvedAt: T0, interruptions: 1, resumeFirst: true, priority: 10, remoteAttempts: 1, preflightBypassRetry: true, preflightRediscoverable: true };
    expect(parseSavedEntry(full)).toEqual(full);
    // Unknown fields are not carried into a live queue entry.
    expect(parseSavedEntry({ ...entry, kind: 'main', remote: { machineId: 'x' }, notBefore: 5 })).toEqual(entry);
    const bad: Array<Record<string, unknown>> = [
      { baseRefName: '--upload-pack=x' }, { baseRefName: 'a b' }, { baseRefName: '' }, { baseRefName: 'x'.repeat(256) }, { baseRefName: 7 }, { baseRefName: 'a..b' }, { baseRefName: '/x' },
      { attempts: -5.5 }, { attempts: -1 }, { attempts: '1' }, { errorRetries: 1.5 }, { starvedRaised: 'no' },
      { pausedMs: 'abc' }, { pausedMs: -1 }, { pausedMs: 1e300 }, { firstRefusedAt: 'zzz' }, { firstRefusedAt: 1e300 }, { firstQueuedAt: 1e300 }, { firstQueuedAt: '5' },
      { baseResolvedAt: -3 }, { interruptions: 0.5 }, { resumeFirst: 'yes' }, { resumeFirst: false }, { priority: 100 }, { priority: '10' },
      { remoteAttempts: -2 }, { preflightBypassRetry: 1 }, { preflightRediscoverable: 'true' }, { headSha: 'nope' }, { baseSha: sha('g') },
    ];
    for (const over of bad) expect(parseSavedEntry({ ...entry, ...over }), JSON.stringify(over)).toBeNull();
    for (const notAnEntry of [null, [], 'x', 5]) expect(parseSavedEntry(notAnEntry)).toBeNull();
    // Any branch name the record validator accepts round-trips, so a valid queued branch cannot lose its own saved entry.
    for (const ref of ['release+1', 'feature/x_y', 'v1.2-hotfix', 'user@work']) expect(parseSavedEntry({ ...entry, baseRefName: ref }), ref).toEqual({ ...entry, baseRefName: ref });
    // The four probes: the bad entry never reaches a live queue, and the hold that carried it stays in force without it.
    for (const over of [{ baseRefName: '--upload-pack=x' }, { attempts: -5.5 }, { pausedMs: 'abc' }, { firstRefusedAt: 'zzz' }]) {
      expect(inspectOperatorRecord({ pr: 3, hold: { by: 'e', reason: 'r', at: T0, wanted: 'explicit', entry: { ...entry, ...over } } }), JSON.stringify(over))
        .toEqual({ record: { pr: 3, hold: { by: 'e', reason: 'r', at: T0, wanted: 'explicit' } }, issues: [{ pr: 3, what: 'saved-entry-dropped' }] });
    }
    expect(inspectOperatorRecord({ pr: 3, hold: { by: 'e', reason: 'r', at: T0, waiter: { firstRefusedAt: 'zzz', lastOfferedAt: T0, refusals: 1 } } }))
      .toEqual({ record: { pr: 3, hold: { by: 'e', reason: 'r', at: T0 } }, issues: [{ pr: 3, what: 'saved-waiter-dropped' }] });
    // A hold whose who, why or times are wrong is dropped whole, and that is an issue too.
    expect(inspectOperatorRecord({ pr: 3, hold: { by: 'e', reason: 'r', at: 1e300, entry } })).toEqual({ record: null, issues: [{ pr: 3, what: 'hold-dropped' }] });
    expect(inspectOperatorRecord({ pr: 3, hold: { by: '', reason: 'r', at: T0 } })).toEqual({ record: null, issues: [{ pr: 3, what: 'hold-dropped' }] });
    expect(inspectOperatorRecord({ pr: 3, hold: { by: 'e', reason: '', at: T0 } })).toEqual({ record: null, issues: [{ pr: 3, what: 'hold-dropped' }] });
    expect(inspectOperatorRecord({ pr: 'x', hold: { by: 'e', reason: 'r', at: T0 } })).toEqual({ record: null, issues: [{ pr: null, what: 'record-dropped' }] });
    expect(inspectOperatorRecord({ pr: 3, hold: { by: 'e', reason: 'r', at: T0 } })).toEqual({ record: { pr: 3, hold: { by: 'e', reason: 'r', at: T0 } }, issues: [] });
    expect(parseOperatorRecord({ pr: 3, hold: { by: 'e', reason: 'r', at: T0, wanted: 'maybe' } })).toBeNull();
    expect(parseOperatorRecord({ pr: 3, hold: { by: 'e', reason: 'r', at: T0, entry, waiter: { firstRefusedAt: T0, lastOfferedAt: T0, refusals: 2 } } }))
      .toEqual({ pr: 3, hold: { by: 'e', reason: 'r', at: T0, entry, waiter: { firstRefusedAt: T0, lastOfferedAt: T0, refusals: 2 } } });
  });
});

describe('pure helpers', () => {
  it('cleanLabel: one line, trimmed; empty or too long is refused, never cut', () => {
    expect(cleanLabel('  echo\nthroughput ', 100)).toBe('echo throughput');
    expect(cleanLabel('', 100)).toBeNull();
    expect(cleanLabel('   ', 100)).toBeNull();
    expect(cleanLabel(7, 100)).toBeNull();
    expect(cleanLabel('x'.repeat(500), OPERATOR_QUEUE_LIMITS.reasonChars)).toHaveLength(500);
    expect(cleanLabel('x'.repeat(501), OPERATOR_QUEUE_LIMITS.reasonChars)).toBeNull();
  });

  it('parseUntil: absent, a date, or not a date', () => {
    expect(parseUntil(undefined)).toBeUndefined();
    expect(parseUntil(null)).toBeUndefined();
    expect(parseUntil('2026-12-01T18:00:00Z')).toBe(Date.parse('2026-12-01T18:00:00Z'));
    expect(parseUntil(T0)).toBe(T0);
    expect(parseUntil(1e300)).toBeNull(); // a number no calendar can hold
    expect(parseUntil(MAX_TIME_MS + 1)).toBeNull();
    expect(parseUntil(-5)).toBeNull();
    expect(parseUntil('next week')).toBeNull();
    expect(parseUntil('')).toBeNull();
    expect(parseUntil(true)).toBeNull();
  });

  it('cleanMergeHoldReason: no bracket or line break, at most 200 characters (the merge-side route\'s rule)', () => {
    expect(cleanMergeHoldReason('wait] for\nPR 120\r')).toBe('wait  for PR 120 ');
    expect(cleanMergeHoldReason('x'.repeat(300))).toHaveLength(200);
    expect(cleanMergeHoldReason(undefined)).toBe('');
  });

  it('a hold is due at `until`, or 24 hours after it was set when there is none, and only until it is reminded', () => {
    expect(holdDueAt({ at: T0 })).toBe(T0 + 24 * HOUR);
    expect(holdDueAt({ at: T0, until: T0 + HOUR })).toBe(T0 + HOUR);
    expect(holdReminderDue({ at: T0 }, T0 + 24 * HOUR - 1)).toBe(false);
    expect(holdReminderDue({ at: T0 }, T0 + 24 * HOUR)).toBe(true);
    expect(holdReminderDue({ at: T0, until: T0 + HOUR }, T0 + HOUR)).toBe(true);
    expect(holdReminderDue({ at: T0, until: T0 + 48 * HOUR }, T0 + 30 * HOUR)).toBe(false); // the operator's date wins over 24 hours
    expect(holdReminderDue({ at: T0, reminded: true }, T0 + 99 * HOUR)).toBe(false);
  });

  it('bootReason: the consumed request\'s reason, once; unknown for none, an old one, or one already named', () => {
    const at = new Date(T0 - 60_000).toISOString();
    expect(bootReason(null, null, T0)).toEqual({ reason: 'unknown' });
    expect(bootReason({ at, reason: 'reorder the queue', requestedBy: 'echo-increasing-throughput' }, null, T0))
      .toEqual({ reason: 'reorder the queue', requestedBy: 'echo-increasing-throughput', restartAt: at });
    // A request with no reason is still this start's request: the row says unknown and names it.
    expect(bootReason({ at, reason: null, requestedBy: 'AutoUpdater' }, null, T0)).toEqual({ reason: 'unknown', requestedBy: 'AutoUpdater', restartAt: at });
    // Already named by an earlier boot row: this start had no request of its own.
    expect(bootReason({ at, reason: 'reorder the queue', requestedBy: 'x' }, at, T0)).toEqual({ reason: 'unknown' });
    // Consumed long before this start.
    expect(bootReason({ at: new Date(T0 - 2 * HOUR).toISOString(), reason: 'install', requestedBy: 'x' }, null, T0)).toEqual({ reason: 'unknown' });
    expect(bootReason({ at: 'not a date', reason: 'install', requestedBy: 'x' }, null, T0)).toEqual({ reason: 'unknown' });
  });
});
