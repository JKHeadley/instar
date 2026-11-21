// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * docs/specs/topic-name-replication.md — Telegram topic names reach every machine.
 * Unit tier: the row validator, the fold, the store (local evidence, landing, fill rules,
 * carrying, the drain, persistence) and the TelegramAdapter publish seam.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import {
  TelegramTopicNameStore, TopicNameDrain, validateTopicNameRow, compareTopicNameRows, foldTopicNames,
  topicNameStoreSchema, normalizeTopicName, type TopicNameRow, type TopicNameTarget,
} from '../../src/messaging/TelegramTopicNameReplication.js';
import { wireTelegramTopicNames } from '../../src/messaging/TelegramTopicNameReplicationWiring.js';

const OP = 'tests/unit/telegram-topic-name-replication.test.ts';
const CHAT = '-100123';
const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tnr-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP }); });

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const row = (over: Partial<TopicNameRow> = {}): TopicNameRow => ({ eventId: uuid(), chat: CHAT, topicId: 101, name: 'Project Alpha', atMs: 1_000, source: 'rename', ...over });

/** An in-memory adapter double with the TopicNameTarget surface. */
class FakeTarget implements TopicNameTarget {
  names = new Map<number, string>();
  saves = 0;
  applies: Array<[number, string]> = [];
  getTopicName(id: number) { return this.names.get(id) ?? null; }
  applyReplicatedTopicName(id: number, name: string, persist = true) { this.names.set(id, name); this.applies.push([id, name]); if (persist) this.saves++; return true; }
  persistTopicNames() { this.saves++; }
  listTopicNames(): Array<[number, string]> { return [...this.names.entries()]; }
}

function store(opts: { now?: () => number; dir?: string; hook?: (r: TopicNameRow) => 'emitted' | 'refused' | 'final'; timers?: Array<() => void> } = {}) {
  const s = new TelegramTopicNameStore({ stateDir: opts.dir ?? tmp(), chat: CHAT, now: opts.now ?? (() => 10_000), newEventId: uuid,
    setTimer: (fn) => { opts.timers?.push(fn); return {}; } });
  const target = new FakeTarget();
  s.setTarget(target);
  const sent: TopicNameRow[] = [];
  s.setReplicationHook(opts.hook ?? ((r) => { sent.push(r); return 'emitted'; }));
  return { s, target, sent };
}

describe('row validation', () => {
  it('accepts an exact row and refuses every malformed field', () => {
    expect(validateTopicNameRow(row())).not.toBeNull();
    expect(validateTopicNameRow({ ...row(), extra: 1 })).toBeNull();
    expect(validateTopicNameRow({ ...row(), eventId: 'x' })).toBeNull();
    expect(validateTopicNameRow({ ...row(), chat: 'group' })).toBeNull();
    expect(validateTopicNameRow({ ...row(), topicId: 0 })).toBeNull();
    expect(validateTopicNameRow({ ...row(), topicId: 1.5 })).toBeNull();
    expect(validateTopicNameRow({ ...row(), name: '' })).toBeNull();
    expect(validateTopicNameRow({ ...row(), name: ' padded ' })).toBeNull();
    expect(validateTopicNameRow({ ...row(), name: 'x'.repeat(129) })).toBeNull();
    expect(validateTopicNameRow({ ...row(), name: 'topic-101' })).toBeNull();
    expect(validateTopicNameRow({ ...row(), name: 'two\nlines' })).toBeNull();
    expect(validateTopicNameRow({ ...row(), name: 'bidi‮flip' })).toBeNull();
    expect(validateTopicNameRow({ ...row(), name: 'zero​width' })).toBeNull();
    expect(validateTopicNameRow({ ...row(), atMs: -1 })).toBeNull();
    expect(validateTopicNameRow({ ...row(), source: 'observed' })).toBeNull();
    expect(normalizeTopicName(5, '  🧭 Chief of Staff  ')).toBe('🧭 Chief of Staff');
  });
  it('the store schema refuses deletes and wraps the row', () => {
    const ctx = { countDroppedField: () => {} } as never;
    expect(topicNameStoreSchema.validate({ op: 'delete' }, ctx)).toBeNull();
    const r = row();
    expect(topicNameStoreSchema.validate({ op: 'put', row: r }, ctx)).toEqual({ row: r });
    expect(topicNameStoreSchema.validate({ op: 'put', row: { ...r, name: 'topic-101' } }, ctx)).toBeNull();
  });
});

describe('the fold', () => {
  it('rename beats fill, then later atMs, then larger eventId; order-independent', () => {
    const fill = row({ source: 'fill', atMs: 9_999, name: 'Old' });
    const rename = row({ source: 'rename', atMs: 1, name: 'New' });
    expect(compareTopicNameRows(rename, fill)).toBeGreaterThan(0);
    const a = row({ atMs: 5, name: 'A' }); const b = row({ atMs: 6, name: 'B' });
    expect(compareTopicNameRows(b, a)).toBeGreaterThan(0);
    const t1 = row({ atMs: 7, eventId: '00000000-0000-4000-8000-000000000001', name: 'T1' });
    const t2 = row({ atMs: 7, eventId: '00000000-0000-4000-8000-000000000002', name: 'T2' });
    expect(compareTopicNameRows(t2, t1)).toBeGreaterThan(0);
    const all = [fill, rename, a, b, t1, t2];
    expect(foldTopicNames(all).get(101)!.name).toBe('T2');
    expect(foldTopicNames([...all].reverse()).get(101)!.name).toBe('T2');
  });
});

describe('local evidence (recordLocal)', () => {
  it('an API result wins over a held winner even with a clock behind it', () => {
    const { s, sent } = store({ now: () => 100 });
    s.ingestReplicatedAll([row({ atMs: 5_000, name: 'Peer rename' })]);
    expect(s.recordLocal(101, 'Mine', 'rename', { api: true })).toBe('Mine');
    expect(s.winner(101)).toMatchObject({ name: 'Mine', atMs: 5_001, source: 'rename' });
    expect(sent.at(-1)!.name).toBe('Mine');
  });
  it('a late rename notice older than a held rename loses and the held name is handed back', () => {
    const { s } = store({ now: () => 10_000 });
    s.ingestReplicatedAll([row({ atMs: 8_000, name: 'Newer' })]);
    expect(s.recordLocal(101, 'Older', 'rename', { atMs: 7_000 })).toBe('Newer');
    expect(s.winner(101)!.name).toBe('Newer');
  });
  it('a reply quoting the creation name after a rename never undoes the rename', () => {
    const { s } = store({ now: () => 10_000 });
    s.ingestReplicatedAll([row({ atMs: 2_000, name: 'Renamed' })]);
    expect(s.recordLocal(101, 'Created as', 'fill')).toBe('Renamed');
    expect(s.winner(101)!.name).toBe('Renamed');
  });
  it('renames A, B, A delivered as A, A, B end on A', () => {
    const { s } = store({ now: () => 50_000 });
    s.recordLocal(101, 'A', 'rename', { atMs: 10_000 });
    s.recordLocal(101, 'A', 'rename', { atMs: 30_000 });
    expect(s.recordLocal(101, 'B', 'rename', { atMs: 20_000 })).toBe('A');
    expect(s.winner(101)).toMatchObject({ name: 'A', atMs: 30_000 });
  });
  it('a fill naming the held name records nothing; a bad name is refused', () => {
    const { s, sent } = store();
    s.recordLocal(101, 'Same', 'fill');
    const n = sent.length;
    s.recordLocal(101, 'Same', 'fill');
    expect(sent.length).toBe(n);
    expect(s.recordLocal(101, 'topic-101', 'rename')).toBeNull();
  });
});

describe('landing, fills and carrying', () => {
  it('a rename winner is applied and carried once with the identical row; a duplicate is not carried again', () => {
    const { s, target, sent } = store();
    const r = row({ name: 'From peer' });
    expect(s.ingestReplicatedAll([r])).toBe(1);
    expect(target.names.get(101)).toBe('From peer');
    expect(sent).toEqual([r]);
    expect(s.ingestReplicatedAll([r, { ...r }])).toBe(0);
    expect(sent).toHaveLength(1);
  });
  it('an older rename never replaces a newer one', () => {
    const { s, target } = store();
    s.ingestReplicatedAll([row({ atMs: 2_000, name: 'New' })]);
    s.ingestReplicatedAll([row({ atMs: 1_000, name: 'Old' })]);
    expect(target.names.get(101)).toBe('New');
  });
  it('a fill fills a gap but never replaces a name the machine held itself', () => {
    const { s, target } = store();
    target.names.set(101, 'My own');
    s.ingestReplicatedAll([row({ source: 'fill', name: 'Peer fill' })]);
    expect(target.names.get(101)).toBe('My own');
    s.ingestReplicatedAll([row({ topicId: 202, source: 'fill', name: 'Gap filled' })]);
    expect(target.names.get(202)).toBe('Gap filled');
  });
  it('two empty machines receiving conflicting fills in opposite orders converge', () => {
    const f1 = row({ source: 'fill', atMs: 1_000, name: 'Fill one' });
    const f2 = row({ source: 'fill', atMs: 2_000, name: 'Fill two' });
    const a = store(); const b = store();
    a.s.ingestReplicatedAll([f1]); a.s.ingestReplicatedAll([f2]);
    b.s.ingestReplicatedAll([f2]); b.s.ingestReplicatedAll([f1]);
    expect(a.target.names.get(101)).toBe('Fill two');
    expect(b.target.names.get(101)).toBe('Fill two');
  });
  it('rows for another Telegram group are ignored', () => {
    const { s, target } = store();
    expect(s.ingestReplicatedAll([row({ chat: '-100999', name: 'Old group' })])).toBe(0);
    expect(target.names.has(101)).toBe(false);
  });
  it('a far-future row is deferred, then landed by its timer once its time comes, without a restart', () => {
    let now = 10_000; const timers: Array<() => void> = [];
    const { s, target } = store({ now: () => now, timers });
    expect(s.ingestReplicatedAll([row({ atMs: now + 10 * 60_000, name: 'Ahead' })])).toBe(0);
    expect(s.deferredCount()).toBe(1);
    expect(timers).toHaveLength(1);
    now += 6 * 60_000;
    timers.shift()!();
    expect(target.names.get(101)).toBe('Ahead');
    expect(s.deferredCount()).toBe(0);
  });
  it('staggered future rows: a far-ahead row never evicts one due sooner', () => {
    let now = 10_000; const timers: Array<() => void> = [];
    const { s, target } = store({ now: () => now, timers });
    s.ingestReplicatedAll([row({ atMs: now + 6 * 60_000, name: 'Soon' })]);
    s.ingestReplicatedAll([row({ atMs: now + 365 * 24 * 3_600_000, name: 'Years ahead' })]);
    expect(s.deferredCount()).toBe(2);
    now += 2 * 60_000;
    timers.shift()!();
    expect(target.names.get(101)).toBe('Soon');
    expect(s.deferredCount()).toBe(1);
  });
  it('a batch writes the registry once, not per row', () => {
    const { s, target } = store();
    s.ingestReplicatedAll([1, 2, 3, 4, 5].map((t) => row({ topicId: t, name: `Topic name ${t}` })));
    expect(target.applies).toHaveLength(5);
    expect(target.saves).toBe(1);
  });
});

describe('backfill and session binds', () => {
  it('backfill shares held names with no row as fills; a standby never re-fills over another fill', () => {
    const { s, target } = store({ now: () => 5_000 });
    target.names.set(101, 'Standby name');
    target.names.set(202, 'Only here');
    s.ingestReplicatedAll([row({ source: 'fill', atMs: 4_000, name: 'Other fill' })]);
    expect(s.backfill(target.listTopicNames(), false)).toBe(1);
    expect(s.winner(202)).toMatchObject({ name: 'Only here', source: 'fill' });
    expect(s.winner(101)!.name).toBe('Other fill');
    // Decided once per machine: booting as lead later never promotes this machine's pre-upgrade names.
    expect(s.backfill(target.listTopicNames(), true)).toBe(0);
    expect(s.winner(101)!.name).toBe('Other fill');
  });
  it('the lead at its first boot shares its names as lead rows over a different fill, once', () => {
    const { s, target } = store({ now: () => 5_000 });
    target.names.set(101, 'Lead name');
    s.ingestReplicatedAll([row({ source: 'fill', atMs: 4_000, name: 'Stale standby name' })]);
    expect(s.backfill(target.listTopicNames(), true)).toBe(1);
    expect(s.winner(101)).toMatchObject({ name: 'Lead name', source: 'lead', atMs: 5_000 });
    s.ingestReplicatedAll([row({ source: 'lead', atMs: 6_000, name: 'Other lead name' })]);
    expect(s.backfill(target.listTopicNames(), true)).toBe(0);
    expect(s.winner(101)!.name).toBe('Other lead name');
  });
  it('the lead promotes a fill whose text matches its own name, so a later stale fill cannot win', () => {
    const { s, target } = store({ now: () => 5_000 });
    target.names.set(101, 'Alpha');
    s.ingestReplicatedAll([row({ source: 'fill', atMs: 4_000, name: 'Alpha' })]);
    s.backfill(target.listTopicNames(), true);
    expect(s.winner(101)).toMatchObject({ name: 'Alpha', source: 'lead' });
    s.ingestReplicatedAll([row({ source: 'fill', atMs: 9_000, name: 'Beta' })]);
    expect(s.winner(101)!.name).toBe('Alpha');
  });
  it('a lead row outranks a standby fill made later, whatever the upgrade order', () => {
    const lead = row({ source: 'lead', atMs: 1_000, name: 'Current' });
    const stale = row({ source: 'fill', atMs: 9_000, name: 'Old' });
    expect(foldTopicNames([lead, stale]).get(101)!.name).toBe('Current');
    expect(foldTopicNames([stale, lead]).get(101)!.name).toBe('Current');
  });
  it('the fold is a total order: every permutation of rows with and without seq picks one winner', () => {
    const A = row({ atMs: 7_000, seq: 2, name: 'A', eventId: '00000000-0000-4000-8000-00000000000a' });
    const B = row({ atMs: 7_000, name: 'B', eventId: '00000000-0000-4000-8000-00000000000b' });
    const C = row({ atMs: 7_000, seq: 1, name: 'C', eventId: '00000000-0000-4000-8000-00000000000c' });
    const perms = [[A, B, C], [A, C, B], [B, A, C], [B, C, A], [C, A, B], [C, B, A]];
    const winners = new Set(perms.map((p) => foldTopicNames(p).get(101)!.name));
    expect([...winners]).toEqual(['A']);
  });
  it('two rename notices in the same second follow Telegram message order', () => {
    const first = row({ atMs: 7_999, seq: 500, name: 'First', eventId: '00000000-0000-4000-8000-ffffffffffff' });
    const second = row({ atMs: 7_999, seq: 501, name: 'Second', eventId: '00000000-0000-4000-8000-000000000000' });
    expect(foldTopicNames([first, second]).get(101)!.name).toBe('Second');
    expect(foldTopicNames([second, first]).get(101)!.name).toBe('Second');
  });
  it('heldName: a rename or an applied fill stands; a refused fill does not; anything fills a machine with no name', () => {
    const { s, target } = store();
    target.names.set(101, 'Own');
    s.ingestReplicatedAll([row({ source: 'fill', name: 'Refused fill' })]);
    expect(s.heldName(101)).toBeNull();
    s.ingestReplicatedAll([row({ topicId: 202, source: 'fill', name: 'Applied fill' })]);
    expect(s.heldName(202)).toBe('Applied fill');
    s.ingestReplicatedAll([row({ topicId: 303, name: 'A rename' })]);
    expect(s.heldName(303)).toBe('A rename');
    target.names.delete(101);
    expect(s.heldName(101)).toBe('Refused fill');
  });
});

describe('persistence and crash repair', () => {
  it('the state file survives a reload, and the boot reconcile re-applies winners to the adapter', () => {
    const dir = tmp();
    const a = store({ dir });
    a.s.ingestReplicatedAll([row({ name: 'Rename' }), row({ topicId: 202, source: 'fill', name: 'Fill' })]);
    // A crash after the store's write but before the registry's: the new adapter has neither name.
    const b = store({ dir });
    expect(b.s.winner(101)!.name).toBe('Rename');
    expect(b.s.reconcileTarget()).toBe(2);
    expect(b.target.names.get(101)).toBe('Rename');
    expect(b.target.names.get(202)).toBe('Fill');
  });
  it('a fill recorded in `filled` is re-applied over the previous fill after a crash between the writes', () => {
    const dir = tmp();
    const a = store({ dir });
    a.s.ingestReplicatedAll([row({ source: 'fill', atMs: 1_000, name: 'First fill' })]);
    a.s.ingestReplicatedAll([row({ source: 'fill', atMs: 2_000, name: 'Second fill' })]);
    const b = store({ dir });
    b.target.names.set(101, 'First fill'); // the registry write of the second fill never happened
    b.s.reconcileTarget();
    expect(b.target.names.get(101)).toBe('Second fill');
  });
  it('a final refusal stays final across a restart: not re-sent by the own-stream check', () => {
    const dir = tmp(); const reports: string[] = [];
    const a = new TelegramTopicNameStore({ stateDir: dir, chat: CHAT, now: () => 1_000, newEventId: uuid, report: (_w, d) => reports.push(d) });
    a.setReplicationHook(() => 'final');
    a.recordLocal(101, 'Refused for good', 'rename');
    expect(reports).toHaveLength(1);
    const b = new TelegramTopicNameStore({ stateDir: dir, chat: CHAT, now: () => 1_000, newEventId: uuid });
    expect(b.reconcileOwnStream(() => false)).toBe(0);
    expect(b.dueCount()).toBe(0);
  });
  it('`filled` from another Telegram group is not trusted after a group change', () => {
    const dir = tmp();
    const a = store({ dir });
    a.s.ingestReplicatedAll([row({ source: 'fill', name: 'Old group fill' })]);
    const b = new TelegramTopicNameStore({ stateDir: dir, chat: '-100999', now: () => 1_000, newEventId: uuid });
    const t = new FakeTarget(); t.names.set(101, 'Old group fill'); b.setTarget(t);
    expect(b.winner(101)).toBeNull();
    expect(b.heldName(101)).toBeNull();
  });
  it('rows marked sent that the own stream lacks are sent again', () => {
    const { s, sent } = store();
    s.recordLocal(101, 'Sent once', 'rename');
    expect(s.dueCount()).toBe(0);
    expect(s.reconcileOwnStream(() => false)).toBe(1);
    s.flushEmits();
    expect(sent.filter((r) => r.name === 'Sent once')).toHaveLength(2);
  });
});

describe('the drain', () => {
  it('retries refused rows without a restart; progress keeps a short cadence; a final refusal is reported once, not retried', () => {
    let accept = false; const reports: string[] = [];
    const s = new TelegramTopicNameStore({ stateDir: tmp(), chat: CHAT, now: () => 1_000, newEventId: uuid, report: (_w, d) => reports.push(d) });
    s.setTarget(new FakeTarget());
    s.setReplicationHook((r) => (r.name === 'Never' ? 'final' : accept ? 'emitted' : 'refused'));
    const timers: Array<() => void> = [];
    const drain = new TopicNameDrain(s, { setTimer: (fn) => { timers.push(fn); return {}; } });
    s.recordLocal(101, 'Later', 'rename');
    s.recordLocal(202, 'Never', 'rename');
    expect(reports.some((d) => d.includes('topic 202'))).toBe(true);
    expect(s.dueCount()).toBe(1);
    drain.arm();
    expect(drain.currentDelayMs()).toBe(2 * 60_000);
    timers.shift()!(); // refused again: backs off
    expect(drain.currentDelayMs()).toBe(4 * 60_000);
    accept = true;
    timers.shift()!();
    expect(s.dueCount()).toBe(0);
  });
  it('a large backlog goes out in batches of at most 80 with a 5-second pause between them', () => {
    let budget = 80; const s = new TelegramTopicNameStore({ stateDir: tmp(), chat: CHAT, now: () => 1_000, newEventId: uuid });
    s.setTarget(new FakeTarget());
    s.setReplicationHook(() => (budget-- > 0 ? 'emitted' : 'refused'));
    s.backfill(Array.from({ length: 200 }, (_, i) => [i + 1, `Topic number ${i + 1}`] as [number, string]));
    const timers: Array<() => void> = [];
    const drain = new TopicNameDrain(s, { setTimer: (fn) => { timers.push(fn); return {}; } });
    s.flushEmits(80);
    expect(s.dueCount()).toBe(120);
    budget = 80; drain.arm(); timers.shift()!();
    expect(s.dueCount()).toBe(40);
    expect(drain.currentDelayMs()).toBe(5_000);
  });
});

describe('TelegramAdapter publish seam', () => {
  function adapter() {
    const dir = tmp();
    const a = new TelegramAdapter({ token: 't', chatId: CHAT } as never, dir, { suppressLifelineAutoCreate: true });
    return { a, dir };
  }
  it('captureTopicName publishes creation as fill and renames as rename, before the registry write, only on change', async () => {
    const { a, dir } = adapter();
    const calls: Array<[number, string, string, unknown, boolean]> = [];
    const regFile = path.join(dir, 'topic-session-registry.json');
    a.setTopicNameReplicationHook((id, name, source, ev) => {
      let onDisk = false;
      try { onDisk = JSON.parse(fs.readFileSync(regFile, 'utf-8')).topicToName?.[id] === name; } catch { onDisk = false; }
      calls.push([id, name, source, ev, onDisk]); return name;
    });
    a.captureTopicName(101, 'Created', false);
    a.captureTopicName(101, 'Created', false);
    a.captureTopicName(101, 'Renamed', true, 5_000);
    expect(calls).toEqual([[101, 'Created', 'fill', { atMs: undefined }, false], [101, 'Renamed', 'rename', { atMs: 5_000 }, false]]);
    a.captureTopicName(101, 'Renamed', true, 6_000);
    expect(calls).toHaveLength(3);
    await a.stop();
  });
  it('renames A, B, A delivered first, third, second through the adapter end on A', async () => {
    const { a, dir } = adapter();
    const s = new TelegramTopicNameStore({ stateDir: dir, chat: CHAT, now: () => 100_000, newEventId: uuid });
    s.setTarget(a); s.setReplicationHook(() => 'emitted');
    a.setTopicNameReplicationHook((id, name, source, ev) => s.recordLocal(id, name, source, ev), (id) => s.heldName(id));
    a.captureTopicName(101, 'A', true, 10_000, 1);
    a.captureTopicName(101, 'A', true, 30_000, 3);
    a.captureTopicName(101, 'B', true, 20_000, 2);
    expect(a.getTopicName(101)).toBe('A');
    expect(s.winner(101)).toMatchObject({ name: 'A', atMs: 30_000, seq: 3 });
    await a.stop();
  });
  it('the hook can put a held newer name back; apply and session binds never publish; a bind keeps the held name', async () => {
    const { a } = adapter();
    const hook = vi.fn((_id: number, name: string) => (name === 'Stale' ? 'Held rename' : name));
    a.setTopicNameReplicationHook(hook, (id) => (id === 101 ? 'Held rename' : null));
    a.captureTopicName(101, 'Stale', false);
    expect(a.getTopicName(101)).toBe('Held rename');
    hook.mockClear();
    expect(a.applyReplicatedTopicName(101, 'From peer')).toBe(true);
    expect(a.getTopicName(101)).toBe('From peer');
    a.registerTopicSession(101, 'sess-1', 'Caller title');
    expect(a.getTopicName(101)).toBe('Held rename');
    a.registerTopicSession(202, 'sess-2', 'Caller title');
    expect(a.getTopicName(202)).toBe('Caller title');
    expect(hook).not.toHaveBeenCalled();
    await a.stop();
  });
  it('applying over a real name fires the rename handler; a placeholder is refused', async () => {
    const { a } = adapter();
    const renamed = vi.fn();
    a.setTopicRenamedHandler(renamed);
    a.applyReplicatedTopicName(101, 'First');
    expect(renamed).not.toHaveBeenCalled();
    a.applyReplicatedTopicName(101, 'Second');
    expect(renamed).toHaveBeenCalledWith(101, 'Second');
    expect(a.applyReplicatedTopicName(101, 'topic-101')).toBe(false);
    expect(a.listTopicNames()).toEqual([[101, 'Second']]);
    await a.stop();
  });
});

describe('boot wiring', () => {
  it('lands peer rows, reconciles, backfills, attaches the hook; a failure leaves the adapter untouched', async () => {
    const dir = tmp();
    const a = new TelegramAdapter({ token: 't', chatId: CHAT } as never, dir, { suppressLifelineAutoCreate: true });
    a.captureTopicName(202, 'Held before upgrade', false);
    const peer = row({ name: 'Peer rename' });
    const emitted: unknown[] = [];
    const wired = wireTelegramTopicNames({
      stateDir: dir, chat: CHAT, adapter: a, ownMachineId: 'm_self', report: () => {}, setTimer: () => ({}),
      emitter: { emit: (_s: string, _k: unknown, build: (h: never, o: string) => unknown) => { emitted.push(build({ physical: 1, logical: 0, node: 'm_self' } as never, 'm_self')); return { outcome: 'emitted' }; } } as never,
      peerStreams: { listRecordKeys: () => ['k1'], loadOriginRecords: () => [{ origin: 'm_peer', data: { row: peer } }] },
    });
    expect(a.getTopicName(101)).toBe('Peer rename');
    expect(wired.store.winner(202)).toMatchObject({ name: 'Held before upgrade', source: 'fill' });
    expect(emitted.length).toBeGreaterThanOrEqual(2);
    a.captureTopicName(303, 'After wiring', false);
    expect(wired.store.winner(303)!.name).toBe('After wiring');
    await a.stop();
  });
});
