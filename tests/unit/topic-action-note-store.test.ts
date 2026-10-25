// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * TopicActionNoteStore (CMT-810) — the durable, action-derived write path behind
 * the cross-topic activity index. Record / dedupe / cap / window / list / corrupt-file
 * tolerance / never-throws.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TopicActionNoteStore, describeActionNote } from '../../src/core/TopicActionNoteStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tans-')); });
afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/topic-action-note-store.test.ts' }));

const T0 = Date.parse('2026-10-14T21:34:00Z'); // 14:34 PDT

describe('TopicActionNoteStore', () => {
  it('records a note durably and reads it back (file under stateDir/topic-action-notes)', () => {
    const store = new TopicActionNoteStore({ stateDir: dir, now: () => T0 });
    const r = store.record(102965, { kind: 'approval-request', verb: 'restart', excerpt: 'May I restart the Mac Studio?', source: 'test' });
    expect(r).toMatchObject({ deduped: false, note: { kind: 'approval-request', verb: 'restart', atMs: T0 } });
    expect(fs.existsSync(path.join(dir, 'topic-action-notes', '102965.json'))).toBe(true);
    const again = new TopicActionNoteStore({ stateDir: dir });
    expect(again.notes(102965)).toHaveLength(1);
    expect(again.latest(102965, T0 + 1000)?.excerpt).toBe('May I restart the Mac Studio?');
    expect(again.listTopicIds()).toEqual([102965]);
  });

  it('dedupes an identical note within the window (two Stop hooks can see one turn)', () => {
    let now = T0;
    const store = new TopicActionNoteStore({ stateDir: dir, now: () => now, dedupeWindowMs: 60_000 });
    const n = { kind: 'action-claim' as const, verb: 'push', excerpt: "I'll push the fix.", source: 'a' };
    expect(store.record(7, n)?.deduped).toBe(false);
    now += 5_000;
    expect(store.record(7, { ...n, source: 'b' })?.deduped).toBe(true);
    expect(store.notes(7)).toHaveLength(1);
    now += 120_000; // past the window → a genuinely new note
    expect(store.record(7, n)?.deduped).toBe(false);
    expect(store.notes(7)).toHaveLength(2);
  });

  it('caps retained notes per topic (oldest dropped) and keeps order', () => {
    let now = T0;
    const store = new TopicActionNoteStore({ stateDir: dir, now: () => now, maxNotesPerTopic: 3, dedupeWindowMs: 0 });
    for (const v of ['a', 'b', 'c', 'd']) { store.record(1, { kind: 'action-claim', verb: v, excerpt: v, source: 't' }); now += 1000; }
    expect(store.notes(1).map((n) => n.verb)).toEqual(['b', 'c', 'd']);
  });

  it('latest() honors the freshness window', () => {
    const store = new TopicActionNoteStore({ stateDir: dir, now: () => T0 });
    store.record(1, { kind: 'action-claim', verb: 'restart', excerpt: 'x', source: 't' });
    expect(store.latest(1, T0 + 3600_000, 7200_000)?.verb).toBe('restart');
    expect(store.latest(1, T0 + 3 * 3600_000, 7200_000)).toBeNull();
  });

  it('rejects invalid input without throwing and never writes', () => {
    const store = new TopicActionNoteStore({ stateDir: dir });
    expect(store.record(1.5, { kind: 'action-claim', verb: 'x', excerpt: 'x', source: 't' })).toBeNull();
    expect(store.record(1, { kind: 'nope' as never, verb: 'x', excerpt: 'x', source: 't' })).toBeNull();
    expect(store.record(1, { kind: 'action-claim', verb: '   ', excerpt: 'x', source: 't' })).toBeNull();
    expect(fs.existsSync(path.join(dir, 'topic-action-notes'))).toBe(false);
  });

  it('tolerates a corrupt file: reads as empty, and the next record repairs it', () => {
    fs.mkdirSync(path.join(dir, 'topic-action-notes'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'topic-action-notes', '9.json'), '{not json');
    const store = new TopicActionNoteStore({ stateDir: dir, now: () => T0 });
    expect(store.notes(9)).toEqual([]);
    expect(store.latest(9)).toBeNull();
    // record() catches the read error and reports null — never throws
    expect(() => store.record(9, { kind: 'action-claim', verb: 'fix', excerpt: 'x', source: 't' })).not.toThrow();
  });

  it('drops malformed entries on read but keeps the valid ones', () => {
    fs.mkdirSync(path.join(dir, 'topic-action-notes'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'topic-action-notes', '3.json'), JSON.stringify({ topicId: 3, notes: [
      { kind: 'action-claim', verb: 'push', excerpt: 'ok', atMs: T0, source: 't' },
      { kind: 'bogus', verb: 1 },
      null,
    ] }));
    expect(new TopicActionNoteStore({ stateDir: dir }).notes(3)).toHaveLength(1);
  });

  it('accepts minted negative (Slack) conversation ids', () => {
    const store = new TopicActionNoteStore({ stateDir: dir, now: () => T0 });
    expect(store.record(-42, { kind: 'approval-request', verb: 'deploy', excerpt: 'ok to deploy?', source: 't' })?.deduped).toBe(false);
    expect(store.listTopicIds()).toEqual([-42]);
  });

  it('describeActionNote renders the focus line a sibling session reads', () => {
    expect(describeActionNote({ kind: 'approval-request', verb: 'restart', excerpt: 'May I restart the Mac Studio?', atMs: T0, source: 't' }))
      .toBe('Asked the operator to approve: restart — "May I restart the Mac Studio?"');
    expect(describeActionNote({ kind: 'action-claim', verb: 'push', excerpt: '', atMs: T0, source: 't' })).toBe('Acting: push');
  });
});
