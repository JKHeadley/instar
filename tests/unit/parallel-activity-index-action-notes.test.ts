// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * ParallelActivityIndex × action notes (CMT-810, Defect 1). The index must surface
 * an action-derived note the moment it is written: as focus when newer than the
 * conversational refs, as tags, as `lastAction`, and as a topic row even when the
 * topic has no intent file. Replays the 2026-10-14 incident timeline.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ParallelActivityIndex } from '../../src/core/ParallelActivityIndex.js';
import { TopicActionNoteStore } from '../../src/core/TopicActionNoteStore.js';
import type { EstablishedRef } from '../../src/core/TopicIntent.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { buildPoolActivityView } from '../../src/core/PoolActivityView.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-notes-')); fs.mkdirSync(path.join(dir, 'topic-intent')); });
afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/parallel-activity-index-action-notes.test.ts' }));

const T_GOAL = Date.parse('2026-10-14T21:13:00Z');     // 14:13 PDT — last conversational update
const T_ASK = Date.parse('2026-10-14T21:34:00Z');      // 14:34 PDT — restart approval requested
const T_LATER = Date.parse('2026-10-14T23:19:00Z');    // 16:19 PDT — the sibling asked "who restarted?"

function ref(topicId: number, kind: EstablishedRef['kind'], text: string, atMs: number): EstablishedRef {
  const iso = new Date(atMs).toISOString();
  return { refId: `${kind}-${atMs}`, arcId: 'a', topicId, kind, text, confidence: 0.9, evidence: [], lastReinforcedAt: iso, status: 'established', createdAt: iso, updatedAt: iso } as EstablishedRef;
}

describe('ParallelActivityIndex with action notes', () => {
  it('REPLAY 2026-10-14: at 14:34 a sibling session would have seen the pending restart, not the 14:13 goal', () => {
    fs.writeFileSync(path.join(dir, 'topic-intent', '102965.json'), '{}');
    const notes = new TopicActionNoteStore({ stateDir: dir, now: () => T_ASK });
    const index = new ParallelActivityIndex({
      stateDir: dir,
      actionNotes: notes,
      getRefs: (topicId) => topicId === 102965
        ? [ref(102965, 'goal', 'The immediate goal is to prevent idle cleanup from shutting down the desk', T_GOAL)]
        : [],
    });
    // Before the request: the index shows the conversational goal (today's behavior).
    const before = index.activities(T_GOAL + 60_000).find((a) => a.topicId === 102965)!;
    expect(before.focus).toBe('The immediate goal is to prevent idle cleanup from shutting down the desk');
    expect(before.lastAction).toBeNull();

    // 14:34 — the turn asks the operator to approve the restart; the observer writes the note.
    notes.record(102965, { kind: 'approval-request', verb: 'restart', excerpt: 'May I restart the Mac Studio to clear the kernel memory leak?', source: 'action-claim-observe' });

    const at1434 = index.activities(T_ASK + 1000).find((a) => a.topicId === 102965)!;
    expect(at1434.focus).toBe('Asked the operator to approve: restart — "May I restart the Mac Studio to clear the kernel memory leak?"');
    expect(at1434.lastAction).toEqual({ kind: 'approval-request', verb: 'restart', excerpt: 'May I restart the Mac Studio to clear the kernel memory leak?', at: T_ASK });
    expect(at1434.tags).toEqual(expect.arrayContaining(['restart', 'studio', 'kernel', 'memory', 'leak']));
    expect(at1434.updatedAt).toBe(T_ASK); // freshness moves with the action, not the stale ref

    // 16:19 — still visible two hours later (the note is within the 24h window).
    const at1619 = index.activities(T_LATER).find((a) => a.topicId === 102965)!;
    expect(at1619.lastAction?.verb).toBe('restart');
    expect(at1619.focus).toContain('approve: restart');
  });

  it('a conversational ref NEWER than the note wins focus again (recency rule), but lastAction + tags stay', () => {
    fs.writeFileSync(path.join(dir, 'topic-intent', '5.json'), '{}');
    const notes = new TopicActionNoteStore({ stateDir: dir, now: () => T_ASK });
    notes.record(5, { kind: 'action-claim', verb: 'push', excerpt: "I'll push the fix now.", source: 't' });
    const index = new ParallelActivityIndex({
      stateDir: dir, actionNotes: notes,
      getRefs: () => [ref(5, 'goal', 'Ship the retained-binary PR', T_ASK + 600_000)],
    });
    const a = index.activities(T_ASK + 700_000).find((x) => x.topicId === 5)!;
    expect(a.focus).toBe('Ship the retained-binary PR');
    expect(a.lastAction?.verb).toBe('push');
    expect(a.tags).toContain('push');
    expect(a.updatedAt).toBe(T_ASK + 600_000);
  });

  it('a note-only topic (no intent file yet) still appears as a row', () => {
    const notes = new TopicActionNoteStore({ stateDir: dir, now: () => T_ASK });
    notes.record(61449, { kind: 'action-claim', verb: 'restart', excerpt: 'Restarting the desk now.', source: 't' });
    const index = new ParallelActivityIndex({ stateDir: dir, actionNotes: notes, getRefs: () => [] });
    expect(index.listTopicIds()).toEqual([61449]);
    const row = index.activities(T_ASK + 1).find((a) => a.topicId === 61449)!;
    expect(row.refCount).toBe(0);
    expect(row.focus).toBe('Acting: restart — "Restarting the desk now."');
  });

  it('a note older than the window no longer shapes focus/tags/lastAction', () => {
    fs.writeFileSync(path.join(dir, 'topic-intent', '8.json'), '{}');
    const notes = new TopicActionNoteStore({ stateDir: dir, now: () => T_ASK });
    notes.record(8, { kind: 'action-claim', verb: 'deploy', excerpt: 'Deploying it now.', source: 't' });
    const index = new ParallelActivityIndex({ stateDir: dir, actionNotes: notes, actionNoteWindowMs: 3600_000, getRefs: () => [] });
    expect(index.activities(T_ASK + 1000).find((a) => a.topicId === 8)!.lastAction?.verb).toBe('deploy');
    const stale = index.activities(T_ASK + 2 * 3600_000).find((a) => a.topicId === 8)!;
    expect(stale.lastAction).toBeNull();
    expect(stale.focus).toBeNull();
    expect(stale.tags).not.toContain('deploy');
  });

  it('without a notes store the index behaves exactly as before (lastAction null, intent topics only)', () => {
    fs.writeFileSync(path.join(dir, 'topic-intent', '2.json'), '{}');
    const index = new ParallelActivityIndex({ stateDir: dir, getRefs: () => [ref(2, 'decision', 'Use codex here', T_GOAL)] });
    const [row] = index.activities(T_ASK);
    expect(row.topicId).toBe(2);
    expect(row.focus).toBe('Use codex here');
    expect(row.lastAction).toBeNull();
  });

  it('lastAction crosses the ?scope=pool composer on local rows (ISO timestamp)', () => {
    const notes = new TopicActionNoteStore({ stateDir: dir, now: () => T_ASK });
    notes.record(102965, { kind: 'approval-request', verb: 'restart', excerpt: 'May I restart the Mac Studio?', source: 't' });
    const index = new ParallelActivityIndex({ stateDir: dir, actionNotes: notes, getRefs: () => [] });
    const view = buildPoolActivityView({ ownMachineId: 'm1', local: index.activities(T_ASK + 1), reader: { query: () => ({ entries: [] }) } as never });
    const row = view.rows.find((r) => r.topicId === '102965' && r.kind === 'local') as { lastAction?: { verb: string; at: string } };
    expect(row.lastAction).toEqual({ kind: 'approval-request', verb: 'restart', excerpt: 'May I restart the Mac Studio?', at: new Date(T_ASK).toISOString() });
  });

  it('a throwing notes provider never blinds the intent-backed rows', () => {
    fs.writeFileSync(path.join(dir, 'topic-intent', '2.json'), '{}');
    const index = new ParallelActivityIndex({
      stateDir: dir,
      actionNotes: { latest: () => { throw new Error('boom'); }, listTopicIds: () => { throw new Error('boom'); } },
      getRefs: () => [ref(2, 'goal', 'G', T_GOAL)],
    });
    const rows = index.activities(T_ASK);
    expect(rows).toHaveLength(1);
    expect(rows[0].focus).toBe('G');
  });
});
