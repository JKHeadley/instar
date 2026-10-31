/**
 * QueuePaceLedger (docs/specs/queue-pace.md §1): crash-safe commit, baseline after gaps or lost
 * state, failed reads write no numbers, too-large, row identity, retention compaction,
 * hysteretic evaluation, owner-not-serving, notices, and the tick log's enable gate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QueuePaceLedger, QueuePaceTickLog, readUnderBoundary, type AdapterRead, type QueueAdapter } from '../../src/monitoring/QueuePaceLedger.js';
import { HOUR_MS, DAY_MS, TIME_EXHAUSTED, type IntervalRow, type PaceEvent } from '../../src/monitoring/QueuePace.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const T0 = Date.parse('2026-10-30T00:05:00Z');

/** A fake owner: open ids + a timestamped event log; read returns events since the cursor. */
class FakeOwner {
  open = new Set<string>();
  events: PaceEvent[] = [];
  fail: string | null = null;
  enter(id: string, at: number) { this.open.add(id); this.events.push({ itemId: id, kind: 'entered', at }); }
  complete(id: string, at: number) { this.open.delete(id); this.events.push({ itemId: id, kind: 'completed', at }); }
  silentlyDrop(id: string) { this.open.delete(id); }
  adapter(queue: QueueAdapter['queue'] = 'commitments', ownerServing?: () => boolean): QueueAdapter {
    return {
      queue,
      ...(ownerServing ? { ownerServing } : {}),
      read: (cursor, now): AdapterRead => {
        if (this.fail) return { ok: false, reason: this.fail };
        const since = (cursor as { at?: number } | null)?.at ?? now - HOUR_MS;
        return { ok: true, mode: 'hourly', events: this.events.filter((e) => e.at > since && e.at <= now), openIds: [...this.open], cursorAfter: { at: now } };
      },
    };
  }
}

describe('QueuePaceLedger', () => {
  let dir: string;
  let now: number;
  const config = { developmentAgent: true };
  const mk = (adapters: QueueAdapter[], extra: Record<string, unknown> = {}) =>
    new QueuePaceLedger({ stateDir: dir, machineId: 'm1', config: () => config, adapters, ticks: null, clock: () => now, ...extra });
  const rowsOnDisk = (): IntervalRow[] => {
    const f = path.join(dir, 'logs', 'queue-pace.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'qp-ledger-'));
    now = T0;
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/queue-pace-ledger.test.ts:cleanup' }));

  it('does nothing while the dev gate resolves off', async () => {
    const owner = new FakeOwner();
    const l = new QueuePaceLedger({ stateDir: dir, machineId: 'm1', config: () => ({ developmentAgent: false }), adapters: [owner.adapter()], ticks: null, clock: () => now });
    expect(await l.tick()).toBe(0);
    expect(rowsOnDisk()).toHaveLength(0);
  });

  it('first interval is a baseline (the open set is never counted as arrivals), then ok rows', async () => {
    const owner = new FakeOwner();
    owner.open = new Set(['a', 'b', 'c']);
    const l = mk([owner.adapter()]);
    await l.tick();
    expect(rowsOnDisk()[0]).toMatchObject({ ok: false, reason: 'baseline', open: 3 });
    expect(rowsOnDisk()[0].entered).toBeUndefined();
    now += HOUR_MS;
    owner.enter('d', now - 10 * 60_000);
    owner.complete('a', now - 5 * 60_000);
    await l.tick();
    const r = rowsOnDisk()[1];
    expect(r).toMatchObject({ ok: true, openStart: 3, open: 3, entered: 1, completed: 1, from: Date.parse('2026-10-30T00:00:00Z') });
  });

  it('a second tick inside the same hour writes nothing and does not re-read', async () => {
    const owner = new FakeOwner();
    let reads = 0;
    const a = owner.adapter();
    const counting: QueueAdapter = { ...a, read: (c, n) => { reads++; return a.read(c, n); } };
    const l = mk([counting]);
    await l.tick();
    now += 10 * 60_000;
    await l.tick();
    expect(reads).toBe(1);
    expect(rowsOnDisk()).toHaveLength(1);
  });

  it('a missed hour leaves a gap and the next row is a baseline carrying gapRecovered (context only)', async () => {
    const owner = new FakeOwner();
    const l = mk([owner.adapter()]);
    await l.tick();
    now += 3 * HOUR_MS; // two hours missed
    owner.enter('x', now - 2 * HOUR_MS);
    owner.enter('y', now - 10 * 60_000);
    await l.tick();
    const r = rowsOnDisk()[1];
    expect(r).toMatchObject({ ok: false, reason: 'baseline', gapRecovered: { entered: 2, completed: 0 } });
    const w = l.window('commitments', now);
    expect(w.okSlots).toBe(0);
  });

  it('a failed read writes ok:false with a reason and NO numbers, and the cursor does not move', async () => {
    const owner = new FakeOwner();
    const l = mk([owner.adapter()]);
    await l.tick();
    now += HOUR_MS;
    owner.fail = 'read-failed';
    owner.enter('late', now - 60_000);
    await l.tick();
    const failed = rowsOnDisk()[1];
    expect(failed).toMatchObject({ ok: false, reason: 'read-failed' });
    expect(failed.open).toBeUndefined();
    expect(failed.completed).toBeUndefined();
    owner.fail = null;
    now += HOUR_MS;
    await l.tick();
    const next = rowsOnDisk()[2];
    // The gap forces a baseline; the event the failed hour could not read is recovered as context.
    expect(next).toMatchObject({ reason: 'baseline', gapRecovered: { entered: 1 } });
  });

  it('a queue over 20,000 ids records too-large', async () => {
    const owner = new FakeOwner();
    for (let i = 0; i <= 20_000; i++) owner.open.add(`i${i}`);
    const l = mk([owner.adapter()]);
    await l.tick();
    expect(rowsOnDisk()[0]).toMatchObject({ ok: false, reason: 'too-large' });
  });

  it('ids that left with no recorded exit → count-drift, and the following hour is ok (fresh snapshot)', async () => {
    const owner = new FakeOwner();
    owner.open = new Set(['a', 'b']);
    const l = mk([owner.adapter()]);
    await l.tick();
    now += HOUR_MS;
    owner.silentlyDrop('b');
    await l.tick();
    expect(rowsOnDisk()[1]).toMatchObject({ ok: false, reason: 'count-drift' });
    now += HOUR_MS;
    await l.tick();
    expect(rowsOnDisk()[2]).toMatchObject({ ok: true, open: 1 });
  });

  it('crash between row and state: the row cursor wins, no double count, a digest mismatch re-baselines', async () => {
    const owner = new FakeOwner();
    owner.open = new Set(['a']);
    const l1 = mk([owner.adapter()]);
    await l1.tick();
    const stateFile = path.join(dir, 'state', 'queue-pace', 'commitments.json');
    const stateAfterBaseline = fs.readFileSync(stateFile, 'utf8');
    now += HOUR_MS;
    owner.enter('b', now - 60_000);
    await l1.tick();
    // Simulate the crash: the row for hour 2 was written, the state file replace did not happen.
    fs.writeFileSync(stateFile, stateAfterBaseline);
    const l2 = mk([owner.adapter()]); // boot
    now += 10 * 60_000;
    await l2.tick(); // same hour: the row for it already exists → nothing new
    expect(rowsOnDisk()).toHaveLength(2);
    now += HOUR_MS;
    await l2.tick();
    const r = rowsOnDisk()[2];
    // The stale state's ids no longer match the row's digest → baseline, never a double count.
    expect(r.reason).toBe('baseline');
    // Events already counted in the hour-2 row are NOT recovered again (the row's cursor won).
    expect(r.gapRecovered).toMatchObject({ entered: 0, completed: 0, exitedOther: 0 });
  });

  it('a repeated append of the same row identity is ignored (also across a restart)', async () => {
    const owner = new FakeOwner();
    const l = mk([owner.adapter()]);
    await l.tick();
    SafeFsExecutor.safeRmSync(path.join(dir, 'state', 'queue-pace', 'commitments.json'), { force: true, operation: 'tests/unit/queue-pace-ledger.test.ts:drop-state' });
    const l2 = mk([owner.adapter()]);
    await l2.tick();
    expect(rowsOnDisk()).toHaveLength(1);
  });

  it('retention: rows older than 14 days compact to daily rows; daily rows older than 90 days are dropped', async () => {
    const file = path.join(dir, 'logs', 'queue-pace.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const day = Math.floor((T0 - 20 * DAY_MS) / DAY_MS) * DAY_MS;
    const lines: IntervalRow[] = [];
    for (let h = 0; h < 24; h++) lines.push({ schema: 'queue-pace/1', kind: 'interval', machineId: 'm1', queue: 'commitments', from: day + h * HOUR_MS, to: day + (h + 1) * HOUR_MS, ok: true, openStart: 5, open: 5, entered: 1, reentered: 0, completed: 1, exitedOther: 0 });
    lines.push({ schema: 'queue-pace/1', kind: 'daily', machineId: 'm1', queue: 'commitments', from: T0 - 100 * DAY_MS, to: T0 - 99 * DAY_MS, ok: true });
    fs.writeFileSync(file, lines.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const l = mk([]);
    l.compact(T0);
    const out = rowsOnDisk();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'daily', entered: 24, completed: 24, okHours: 24 });
  });

  it('evaluation: two hourly evaluations promote falling-behind; a restart does not add a step', async () => {
    const owner = new FakeOwner();
    const l = mk([owner.adapter()]);
    // 10 hours of steady growth.
    for (let h = 0; h < 10; h++) {
      owner.enter(`n${h}a`, now - 30_000);
      owner.enter(`n${h}b`, now - 20_000);
      await l.tick();
      now += HOUR_MS;
    }
    const ev = l.evaluation('commitments')!;
    expect(ev.raw.verdict).toBe('falling-behind');
    expect(ev.hysteresis.shown).toBe('falling-behind');
    const v = l.view(now);
    expect(v.queues[0]).toMatchObject({ id: 'commitments', label: 'Promises', verdict: 'falling-behind', owner: 'this-machine' });
    // Restart inside the same hour: the persisted evaluation is reused unchanged.
    const before = JSON.stringify(ev.hysteresis);
    const l2 = mk([owner.adapter()]);
    expect(JSON.stringify(l2.evaluation('commitments')!.hysteresis)).toBe(before);
  });

  it('owner-not-serving overrides the verdict for feedback queues', async () => {
    const owner = new FakeOwner();
    const l = mk([owner.adapter('feedback.triage', () => false)]);
    await l.tick();
    expect(l.evaluation('feedback.triage')!.hysteresis.shown).toBe('owner-not-serving');
    expect(l.view(now).queues[0].owner).toBe('not-serving');
  });

  it('notices: dry-run logs a would-raise and never calls attention', async () => {
    const owner = new FakeOwner();
    const raised: string[] = [];
    const ticks = new QueuePaceTickLog(path.join(dir, 'logs', 'queue-pace-ticks.jsonl'), () => true, () => now);
    const l = mk([owner.adapter('feedback.triage', () => true)], {
      ticks,
      triageCalls: () => ({ callsUsedToday: 10, maxCallsPerDay: 10_000 }),
      attention: { raise: async (i: { id: string }) => { raised.push(i.id); }, clear: () => undefined },
    });
    for (let h = 0; h < 40; h++) {
      for (const m of [1, 16, 31, 46]) ticks.append({ source: 'triage', kind: 'tick', decided: 2, calls: 1, stopReason: TIME_EXHAUSTED, queueDepthAfter: 30, at: now - (60 - m) * 60_000 });
      owner.enter(`x${h}a`, now - 30_000); owner.enter(`x${h}b`, now - 20_000);
      await l.tick();
      now += HOUR_MS;
    }
    expect(l.evaluation('feedback.triage')!.bottleneck?.kind).toBe('worker');
    expect(raised).toHaveLength(0);
    const log = fs.readFileSync(path.join(dir, 'logs', 'queue-pace-notices.jsonl'), 'utf8');
    expect(log).toContain('"wouldAct":true');
  });

  it('notices live (notices.dryRun false): raises once with the machine-scoped conditionKey', async () => {
    const owner = new FakeOwner();
    const raised: Array<{ id: string; conditionKey: string; summary: string }> = [];
    const ticks = new QueuePaceTickLog(path.join(dir, 'logs', 'queue-pace-ticks.jsonl'), () => true, () => now);
    const live = { developmentAgent: true, queuePace: { notices: { dryRun: false } } };
    const l = new QueuePaceLedger({ stateDir: dir, machineId: 'm1', config: () => live, adapters: [owner.adapter('feedback.triage', () => true)], ticks, clock: () => now,
      triageCalls: () => ({ callsUsedToday: 10, maxCallsPerDay: 10_000 }),
      attention: { raise: async (i) => { raised.push(i); }, clear: () => undefined } });
    for (let h = 0; h < 40; h++) {
      for (const m of [1, 16, 31, 46]) ticks.append({ source: 'triage', kind: 'tick', decided: 2, calls: 1, stopReason: TIME_EXHAUSTED, queueDepthAfter: 30, at: now - (60 - m) * 60_000 });
      owner.enter(`x${h}a`, now - 30_000); owner.enter(`x${h}b`, now - 20_000);
      await l.tick();
      now += HOUR_MS;
    }
    expect(raised).toHaveLength(1);
    expect(raised[0].conditionKey).toBe('queue-pace:m1:feedback.triage');
    expect(raised[0].summary).toContain('Feedback sorting');
  });

  it('notices: 40 h in dry-run then switched live — the first live raise still fires (dry-run never marks it open)', async () => {
    const owner = new FakeOwner();
    const raised: string[] = [];
    const ticks = new QueuePaceTickLog(path.join(dir, 'logs', 'queue-pace-ticks.jsonl'), () => true, () => now);
    const cfg: Record<string, unknown> = { developmentAgent: true, queuePace: { notices: { dryRun: true } } };
    const l = new QueuePaceLedger({ stateDir: dir, machineId: 'm1', config: () => cfg, adapters: [owner.adapter('feedback.triage', () => true)], ticks, clock: () => now,
      triageCalls: () => ({ callsUsedToday: 10, maxCallsPerDay: 10_000 }),
      attention: { raise: async (i: { id: string }) => { raised.push(i.id); }, clear: () => undefined } });
    const hour = async () => {
      for (const m of [1, 16, 31, 46]) ticks.append({ source: 'triage', kind: 'tick', decided: 2, calls: 1, stopReason: TIME_EXHAUSTED, queueDepthAfter: 30, at: now - (60 - m) * 60_000 });
      owner.enter(`x${now}a`, now - 30_000); owner.enter(`x${now}b`, now - 20_000);
      await l.tick();
      now += HOUR_MS;
    };
    for (let h = 0; h < 40; h++) await hour();
    expect(raised).toHaveLength(0);
    cfg.queuePace = { notices: { dryRun: false } };
    for (let h = 0; h < 40; h++) await hour();
    expect(raised).toHaveLength(1);
  });

  it('the tick log writes only while enabled, and finds a run by id', () => {
    let on = false;
    const f = path.join(dir, 'logs', 'queue-pace-ticks.jsonl');
    const t = new QueuePaceTickLog(f, () => on, () => now);
    t.append({ source: 'triage', kind: 'tick', runId: 'r1', decided: 1 });
    expect(fs.existsSync(f)).toBe(false);
    on = true;
    t.append({ source: 'triage', kind: 'tick', runId: 'r1', decided: 1 });
    expect(t.byRunId('r1')).toMatchObject({ decided: 1 });
    expect(new QueuePaceTickLog(f, () => true).since(0)).toHaveLength(1); // reloaded from disk
  });

  it('readUnderBoundary retries once on a moved watermark, then reports read-race', async () => {
    let w = 0;
    const always = await readUnderBoundary(() => w++, () => 'x');
    expect(always).toEqual({ ok: false, reason: 'read-race' });
    let calls = 0;
    const once = await readUnderBoundary(() => (calls++ < 1 ? 'a' : 'b'), () => 'y');
    expect(once).toEqual({ ok: true, value: 'y' });
  });
});
