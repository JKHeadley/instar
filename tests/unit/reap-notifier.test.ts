import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReapNotifier, type ReapEvent } from '../../src/monitoring/ReapNotifier.js';
import type { Session } from '../../src/core/types.js';

function sess(name: string, tmux = name): Pick<Session, 'name' | 'tmuxSession'> {
  return { name, tmuxSession: tmux };
}

function makeNotifier(over?: {
  resolveTopic?: (t: string) => number | null;
  lifeline?: number | null;
  enabled?: boolean;
  windowMs?: number;
  maxBuffer?: number;
}) {
  const sends: Array<{ topicId: number; text: string }> = [];
  const lifeline = over && 'lifeline' in over ? (over.lifeline ?? null) : 999;
  const n = new ReapNotifier(
    {
      resolveTopic: over?.resolveTopic ?? (() => null),
      lifelineTopic: () => lifeline,
      send: (topicId, text) => { sends.push({ topicId, text }); },
    },
    // perTopic:false — this suite documents the LEGACY (rollback-lever)
    // behavior, byte-compatible with the pre-v2 notifier. The v2 per-topic
    // suite below has its own factory.
    { enabled: over?.enabled ?? true, coalesceWindowMs: over?.windowMs ?? 60_000, maxBuffer: over?.maxBuffer ?? 100, perTopic: false },
  );
  return { n, sends };
}

describe('ReapNotifier (§P3)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stays SILENT for a recovery-bounce reap', async () => {
    const { n, sends } = makeNotifier();
    n.onReaped({ session: sess('s1'), reason: 'context-exhaustion', disposition: 'recovery-bounce' });
    await n.flush();
    expect(sends).toHaveLength(0);
  });

  it('stays SILENT for an operator kill (the user did it themselves)', async () => {
    const { n, sends } = makeNotifier();
    n.onReaped({ session: sess('s1'), reason: 'operator-kill', disposition: 'terminal', origin: 'operator' });
    await n.flush();
    expect(sends).toHaveLength(0);
  });

  it('stays SILENT when disabled', async () => {
    const { n, sends } = makeNotifier({ enabled: false });
    n.onReaped({ session: sess('s1'), reason: 'idle-zombie', disposition: 'terminal' });
    await n.flush();
    expect(sends).toHaveLength(0);
  });

  it('routes an isolated topic-bound reap to its BOUND topic', async () => {
    const { n, sends } = makeNotifier({ resolveTopic: () => 42, lifeline: 999 });
    n.onReaped({ session: sess('alpha'), reason: 'idle-zombie', disposition: 'terminal' });
    await n.flush();
    expect(sends).toHaveLength(1);
    expect(sends[0].topicId).toBe(42);
    expect(sends[0].text).toContain('alpha');
    expect(sends[0].text).toContain('idle-zombie');
  });

  it('routes an isolated UNBOUND reap to the lifeline topic', async () => {
    const { n, sends } = makeNotifier({ resolveTopic: () => null, lifeline: 999 });
    n.onReaped({ session: sess('beta'), reason: 'age-limit', disposition: 'terminal' });
    await n.flush();
    expect(sends).toHaveLength(1);
    expect(sends[0].topicId).toBe(999);
  });

  it('coalesces a burst into ONE consolidated lifeline message with the exact total count', async () => {
    const { n, sends } = makeNotifier({ resolveTopic: () => 42, lifeline: 999 });
    n.onReaped({ session: sess('a'), reason: 'boot-purge-dead', disposition: 'terminal' });
    n.onReaped({ session: sess('b'), reason: 'boot-purge-dead', disposition: 'terminal' });
    n.onReaped({ session: sess('c'), reason: 'idle-zombie', disposition: 'terminal' });
    await n.flush();
    expect(sends).toHaveLength(1);
    expect(sends[0].topicId).toBe(999); // lifeline, not per-topic, for a burst
    expect(sends[0].text).toContain('3 sessions');
  });

  it('reports the exact total even when the detail buffer overflows (drop-oldest)', async () => {
    const { n, sends } = makeNotifier({ lifeline: 999, maxBuffer: 2 });
    for (let i = 0; i < 5; i++) {
      n.onReaped({ session: sess(`s${i}`), reason: 'idle-zombie', disposition: 'terminal' });
    }
    await n.flush();
    expect(sends).toHaveLength(1);
    expect(sends[0].text).toContain('5 sessions'); // count is exact regardless of buffer
    expect(sends[0].text).toMatch(/showing the latest 2/);
  });

  it('fires automatically when the coalesce window elapses (single shared timer)', async () => {
    const { n, sends } = makeNotifier({ resolveTopic: () => 7, windowMs: 60_000 });
    n.onReaped({ session: sess('z'), reason: 'idle-zombie', disposition: 'terminal' });
    expect(sends).toHaveLength(0); // buffered, not yet sent
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sends).toHaveLength(1);
  });

  it('wraps a malicious session name as a literal code span (never markup)', async () => {
    const { n, sends } = makeNotifier({ resolveTopic: () => 7 });
    const evil: ReapEvent = {
      session: sess('*pwn* [x](http://e) `boom`', 'tmux1'),
      reason: 'idle-zombie',
      disposition: 'terminal',
    };
    n.onReaped(evil);
    await n.flush();
    // The dynamic value is wrapped in backticks and any inner backtick neutralized,
    // so the downstream formatter renders it as literal inline code, not markup.
    expect(sends[0].text).toContain('`*pwn* [x](http://e) ');
    expect(sends[0].text).not.toContain('`boom`'); // inner backticks neutralized
  });

  it('drops a single notice silently when no channel is reachable (reap-log still has it)', async () => {
    const { n, sends } = makeNotifier({ resolveTopic: () => null, lifeline: null });
    n.onReaped({ session: sess('orphan'), reason: 'idle-zombie', disposition: 'terminal' });
    await n.flush();
    expect(sends).toHaveLength(0); // no throw, no send
  });
});

// ── v2: per-topic grouping + durable delivery (reap-notify spec R1.1–R1.5) ──

interface EnqueuedRow {
  delivery_id: string;
  topic_id: number;
  text: string;
  next_attempt_at: string;
}

function makeV2(over?: {
  resolveTopic?: (t: string) => number | null;
  lifeline?: number | null;
  maxBuffer?: number;
  maxImmediatePerFlush?: number;
  drainEnabled?: boolean;
  enqueueOk?: boolean;
  enqueueThrows?: boolean;
  quietHoursEndAt?: (now: number) => number | null;
  summaryReleaseAt?: (now: number) => number;
  resumeQueuedFor?: (t: string) => boolean;
  now?: () => number;
}) {
  const sends: Array<{ topicId: number; text: string }> = [];
  const rows: EnqueuedRow[] = [];
  const records: Array<{ noticeId: string; topicId: number | null; outcome: string; detail?: string }> = [];
  const degradations: string[] = [];
  const lifeline = over && 'lifeline' in over ? (over.lifeline ?? null) : 999;
  const NOW = 1_750_000_000_000;
  const n = new ReapNotifier(
    {
      resolveTopic: over?.resolveTopic ?? (() => null),
      lifelineTopic: () => lifeline,
      send: (topicId, text) => { sends.push({ topicId, text }); },
      enqueueNotice: (input) => {
        if (over?.enqueueThrows) throw new Error('store closed');
        if (over?.enqueueOk === false) return false;
        rows.push(input);
        return true;
      },
      recordNotify: (e) => { records.push(e); },
      quietHoursEndAt: over?.quietHoursEndAt ?? (() => null),
      summaryReleaseAt: over?.summaryReleaseAt ?? ((now) => now + 10 * 60_000),
      resumeQueuedFor: over?.resumeQueuedFor,
      reportDegradation: (reason) => { degradations.push(reason); },
      now: over?.now ?? (() => NOW),
    },
    {
      enabled: true,
      coalesceWindowMs: 60_000,
      maxBuffer: over?.maxBuffer ?? 100,
      perTopic: true,
      maxImmediatePerFlush: over?.maxImmediatePerFlush ?? 5,
      drainEnabled: over?.drainEnabled ?? true,
    },
  );
  return { n, sends, rows, records, degradations, NOW };
}

describe('ReapNotifier v2 — per-topic grouping (R1.1)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a single topic-bound reap enqueues ONE durable notice for THAT topic', async () => {
    const { n, rows, records } = makeV2({ resolveTopic: () => 42 });
    n.onReaped({ session: sess('alpha'), reason: 'idle-zombie', disposition: 'terminal' });
    await n.flush();
    expect(rows).toHaveLength(1);
    expect(rows[0].topic_id).toBe(42);
    expect(rows[0].delivery_id.startsWith('reap-notify:')).toBe(true);
    expect(rows[0].text).toContain('alpha');
    // Plain English (R1.2): no slug, no API pointer in the body.
    expect(rows[0].text).toContain('stopped responding');
    expect(rows[0].text).not.toContain('idle-zombie');
    expect(rows[0].text).not.toMatch(/GET \/|curl/);
    expect(records.map((r) => r.outcome)).toEqual(['enqueued']);
  });

  it('a multi-topic burst produces one notice PER affected topic + lifeline cross-topic index', async () => {
    const topicFor: Record<string, number | null> = { a: 1, b: 1, c: 2, d: null };
    const { n, rows } = makeV2({ resolveTopic: (t) => topicFor[t] ?? null });
    for (const name of ['a', 'b', 'c', 'd']) {
      n.onReaped({ session: sess(name), reason: 'quota-shed', disposition: 'terminal' });
    }
    await n.flush();
    const byTopic = new Map(rows.map((r) => [r.topic_id, r]));
    expect(byTopic.has(1)).toBe(true);
    expect(byTopic.has(2)).toBe(true);
    expect(byTopic.has(999)).toBe(true); // lifeline: unbound 'd' + index
    expect(rows).toHaveLength(3); // ≤ affected topics + 1 lifeline (P17 bound)
    expect(byTopic.get(1)!.text).toContain('2 of this topic');
    expect(byTopic.get(999)!.text).toContain('Index:'); // cross-topic index
    expect(byTopic.get(999)!.text).toContain('background session'); // unbound notice
  });

  it('storm beyond the detail buffer: every affected topic still gets a correct COUNT (R1.1)', async () => {
    // 10 reaps across 10 topics with a buffer of 2 — detail is dropped for 8,
    // but the affected-set keeps exact counts for all.
    const { n, rows } = makeV2({
      resolveTopic: (t) => Number(t.replace('s', '')),
      maxBuffer: 2,
    });
    for (let i = 1; i <= 10; i++) {
      n.onReaped({ session: sess(`s${i}`), reason: 'quota-shed', disposition: 'terminal' });
    }
    await n.flush();
    // 10 topic notices + 1 lifeline index.
    expect(rows).toHaveLength(11);
    const trimmed = rows.filter((r) => r.text.includes('details were trimmed'));
    expect(trimmed.length).toBeGreaterThanOrEqual(8); // count-only notices
  });

  it('mid-work tag and queued-resume line appear ONLY when true (R1.2)', async () => {
    const { n, rows } = makeV2({
      resolveTopic: () => 7,
      resumeQueuedFor: (t) => t === 'tmx-queued',
    });
    n.onReaped({ session: { name: 'worker', tmuxSession: 'tmx-queued' }, reason: 'quota-shed', disposition: 'terminal', midWork: true });
    await n.flush();
    expect(rows[0].text).toContain('middle of work');
    expect(rows[0].text).toContain('A restart is queued');

    const second = makeV2({ resolveTopic: () => 7 });
    second.n.onReaped({ session: sess('idler'), reason: 'reaped-idle', disposition: 'terminal', midWork: false });
    await second.n.flush();
    expect(second.rows[0].text).not.toContain('middle of work');
    expect(second.rows[0].text).not.toContain('restart is queued');
  });

  it('unknown reason slug gets the generic sentence with the slug shown (R1.2)', async () => {
    const { n, rows } = makeV2({ resolveTopic: () => 7 });
    n.onReaped({ session: sess('x'), reason: 'mystery-slug', disposition: 'terminal' });
    await n.flush();
    expect(rows[0].text).toContain('shut down automatically');
    expect(rows[0].text).toContain('mystery-slug');
  });
});

describe('ReapNotifier v2 — release tiers + caps (R1.5, decision 1)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('mid-work + queued-resume releases IMMEDIATE (now); routine releases on the SUMMARY window', async () => {
    const { n, rows, NOW } = makeV2({
      resolveTopic: (t) => (t === 'urgent' ? 1 : 2),
      resumeQueuedFor: (t) => t === 'urgent',
      summaryReleaseAt: (now) => now + 15 * 60_000,
    });
    n.onReaped({ session: { name: 'u', tmuxSession: 'urgent' }, reason: 'quota-shed', disposition: 'terminal', midWork: true });
    n.onReaped({ session: { name: 'r', tmuxSession: 'routine' }, reason: 'reaped-idle', disposition: 'terminal' });
    await n.flush();
    const urgent = rows.find((r) => r.topic_id === 1)!;
    const routine = rows.find((r) => r.topic_id === 2)!;
    expect(Date.parse(urgent.next_attempt_at)).toBe(NOW); // immediate
    expect(Date.parse(routine.next_attempt_at)).toBe(NOW + 15 * 60_000); // summary window
  });

  it('IMMEDIATE inside quiet hours holds to quiet-hours end (never wakes the user)', async () => {
    const { n, rows, NOW } = makeV2({
      resolveTopic: () => 1,
      resumeQueuedFor: () => true,
      quietHoursEndAt: (now) => now + 4 * 3600_000,
    });
    n.onReaped({ session: sess('u'), reason: 'quota-shed', disposition: 'terminal', midWork: true });
    await n.flush();
    expect(Date.parse(rows[0].next_attempt_at)).toBe(NOW + 4 * 3600_000);
  });

  it('caps IMMEDIATE releases per flush at maxImmediatePerFlush; the rest fall back to SUMMARY', async () => {
    const { n, rows, NOW } = makeV2({
      resolveTopic: (t) => Number(t.replace('q', '')),
      resumeQueuedFor: () => true,
      maxImmediatePerFlush: 2,
      summaryReleaseAt: (now) => now + 10 * 60_000,
    });
    for (let i = 1; i <= 4; i++) {
      n.onReaped({ session: { name: `q${i}`, tmuxSession: `q${i}` }, reason: 'quota-shed', disposition: 'terminal', midWork: true });
    }
    await n.flush();
    const topicRows = rows.filter((r) => r.topic_id !== 999);
    const immediate = topicRows.filter((r) => Date.parse(r.next_attempt_at) === NOW);
    const summary = topicRows.filter((r) => Date.parse(r.next_attempt_at) > NOW);
    expect(immediate).toHaveLength(2);
    expect(summary).toHaveLength(2); // still durable, still per-topic
  });
});

describe('ReapNotifier v2 — outcome records + degraded paths (R1.3)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('enqueue failure falls back to ONE direct send, recorded enqueue-failed + degradation', async () => {
    const { n, sends, records, degradations } = makeV2({ resolveTopic: () => 7, enqueueOk: false });
    n.onReaped({ session: sess('x'), reason: 'reaped-idle', disposition: 'terminal' });
    await n.flush();
    expect(sends).toHaveLength(1); // the one direct attempt
    expect(records.map((r) => r.outcome)).toEqual(['enqueue-failed']);
    expect(degradations).toHaveLength(1);
  });

  it('a THROWING store is the same loud degraded path (never a crash)', async () => {
    const { n, sends, records } = makeV2({ resolveTopic: () => 7, enqueueThrows: true });
    n.onReaped({ session: sess('x'), reason: 'reaped-idle', disposition: 'terminal' });
    await n.flush();
    expect(sends).toHaveLength(1);
    expect(records[0].outcome).toBe('enqueue-failed');
    expect(records[0].detail).toContain('store closed');
  });

  it('drainEnabled:false reverts delivery to legacy direct send (grouping unaffected)', async () => {
    const { n, sends, rows } = makeV2({ resolveTopic: () => 7, drainEnabled: false });
    n.onReaped({ session: sess('x'), reason: 'reaped-idle', disposition: 'terminal' });
    await n.flush();
    expect(rows).toHaveLength(0); // no durable rows
    expect(sends).toHaveLength(1); // direct send
    expect(sends[0].text).toContain('idle for a long time'); // v2 body, legacy transport
  });

  it('records no-topic when lifeline content exists but no lifeline is configured', async () => {
    const { n, records, rows } = makeV2({ resolveTopic: () => null, lifeline: null });
    n.onReaped({ session: sess('orphan'), reason: 'reaped-idle', disposition: 'terminal' });
    await n.flush();
    expect(rows).toHaveLength(0);
    expect(records.map((r) => r.outcome)).toEqual(['no-topic']);
  });
});
