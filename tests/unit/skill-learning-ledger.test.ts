// safe-fs-allow: test fixture cleanup uses SafeFsExecutor.
/**
 * Skill Learning Sentinel — Ledger (Tier 1). Spec §3.2 / §4: immutable per-machine segments with
 * fsync'd appends, generation roll-over at 4 MB, whole-segment retention, a derived SQLite cache that is
 * idempotent across restarts, dedupe by source, the (runId, revision) precedence reducer in any arrival
 * order, and the ≤200-rows-per-key cache bound.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { DEFAULT_SEGMENT_BYTES, Ledger, MAX_REQUESTS_PER_KEY, reduceOutcomes } from '../../src/monitoring/skillLearning/Ledger.js';
import type { OutcomeRow, RequestRow, VerdictRow, EventRow } from '../../src/monitoring/skillLearning/types.js';

const M1 = 'm_alpha';
const M2 = 'm_beta';
let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skl-ledger-'));
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/skill-learning-ledger.test.ts' });
});

let seq = 0;
function request(over: Partial<RequestRow> & { machineId?: string } = {}): RequestRow {
  seq += 1;
  return {
    kind: 'request', eventId: `ev-${seq}`, source: { channel: 'telegram', chatId: '7', messageId: String(1000 + seq) },
    topicId: '7', sessionName: 'echo-7', at: new Date(Date.UTC(2026, 10, 6, 12, 0, seq)).toISOString(), channel: 'telegram',
    identity: 'verified', state: 'pending', runId: `run-${seq}`, machineId: M1, ...over,
  };
}
function outcome(over: Partial<OutcomeRow> = {}): OutcomeRow {
  seq += 1;
  return {
    kind: 'outcome', eventId: `oc-${seq}`, runId: 'run-1', revision: 0, procedureKey: 'ci-health-report', topicId: '7',
    label: 'unknown', provisional: true, windowStart: '2026-11-06T12:00:00.000Z', at: new Date(Date.UTC(2026, 10, 6, 13, 0, seq)).toISOString(),
    machineId: M1, ...over,
  };
}

function open(machineId = M1, opts: Partial<ConstructorParameters<typeof Ledger>[0]> = {}): Ledger {
  const l = new Ledger({ stateDir, machineId, ...opts });
  l.startSync();
  return l;
}

describe('Ledger — segments', () => {
  it('appends fsync\'d JSONL rows to <machineId>.<generation>.jsonl and never stores message text', () => {
    const l = open();
    l.append(request());
    const file = l.segmentPath(0);
    expect(fs.existsSync(file)).toBe(true);
    const raw = fs.readFileSync(file, 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    const row = JSON.parse(raw.trim());
    expect(row.kind).toBe('request');
    expect(row).not.toHaveProperty('text');
    expect(l.status().currentGeneration).toBe(0);
    l.close();
  });

  it('refuses a row stamped with another machine\'s id (a shard has exactly one writer)', () => {
    const l = open();
    expect(() => l.append(request({ machineId: M2 }))).toThrow(/not this machine/);
    l.close();
  });

  it('opens a new generation at 4 MB and never rewrites the old one', () => {
    const l = open();
    const big = 'x'.repeat(100 * 1024);
    for (let i = 0; i < 44; i++) l.append(request({ state: 'classified', procedureKey: `k-${i}`, paraphrase: big }));
    const gen0 = fs.statSync(l.segmentPath(0));
    expect(gen0.size).toBeGreaterThanOrEqual(DEFAULT_SEGMENT_BYTES);
    expect(l.status().currentGeneration).toBe(1);
    expect(fs.existsSync(l.segmentPath(1))).toBe(true);
    const before = fs.readFileSync(l.segmentPath(0), 'utf-8');
    l.append(request({ state: 'classified', procedureKey: 'after-roll' }));
    expect(fs.readFileSync(l.segmentPath(0), 'utf-8')).toBe(before);
    expect(l.keys().map((k) => k.procedureKey)).toContain('after-roll');
    // A fresh instance resumes on the latest generation.
    l.close();
    const l2 = open();
    expect(l2.status().currentGeneration).toBe(1);
    l2.close();
  });

  it('retention prunes only WHOLE segments of this machine older than 3×windowDays — never the current generation, a segment with a young row, or another machine\'s shard', () => {
    const now = Date.parse('2026-11-06T12:00:00Z');
    const l = open(M1, { windowDays: 1, segmentBytes: 400, now: () => now });
    const old = new Date(now - 10 * 86_400_000).toISOString();
    const young = new Date(now - 3600_000).toISOString();
    l.append(request({ at: old, state: 'classified', procedureKey: 'old-a', paraphrase: 'p'.repeat(300) })); // gen 0 (old only)
    l.append(request({ at: old, state: 'classified', procedureKey: 'old-b', paraphrase: 'p'.repeat(300) })); // gen 1 (old) ...
    l.append(request({ at: young, state: 'classified', procedureKey: 'young', paraphrase: 'p'.repeat(300) })); // gen 1 gets a young row? no: gen 1 is full → gen 2
    l.append(request({ at: old, state: 'classified', procedureKey: 'old-c' })); // current generation
    // Another machine's old segment in the same dir.
    const other = path.join(l.ledgerDir, `${M2}.0.jsonl`);
    fs.writeFileSync(other, JSON.stringify(request({ at: old, machineId: M2, state: 'classified', procedureKey: 'other-old' })) + '\n');
    l.ingestSync();
    const gens = fs.readdirSync(l.ledgerDir).sort();
    expect(gens.length).toBeGreaterThanOrEqual(4);
    const pruned = l.prune(now);
    expect(pruned.length).toBeGreaterThanOrEqual(1);
    for (const p of pruned) expect(path.basename(p).startsWith(`${M1}.`)).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
    expect(fs.existsSync(l.segmentPath(l.status().currentGeneration))).toBe(true);
    const remainingKeys = l.keys().map((k) => k.procedureKey);
    expect(remainingKeys).toContain('young');
    expect(remainingKeys).toContain('other-old');
    expect(remainingKeys).toContain('old-c');
    // Every pruned segment held only old rows; the young row's segment survived.
    for (const p of pruned) expect(fs.existsSync(p)).toBe(false);
    expect(remainingKeys).not.toContain('old-a');
    l.close();
  });
});

describe('Ledger — cache', () => {
  it('ingestion is idempotent across restarts (same rows, zero re-ingest, segment offsets persisted)', () => {
    const l = open();
    l.append(request({ state: 'classified', procedureKey: 'k' }));
    l.append(request({ state: 'classified', procedureKey: 'k' }));
    expect(l.requestsForKey('k')).toHaveLength(2);
    l.close();
    const l2 = open();
    expect(l2.requestsForKey('k')).toHaveLength(2);
    expect(l2.ingestSync()).toBe(0);
    expect(l2.status().counters.ingested).toBe(0);
    l2.close();
  });

  it('a torn tail line is not ingested until its newline lands', () => {
    const l = open();
    l.append(request({ state: 'classified', procedureKey: 'k' }));
    const file = l.segmentPath(0);
    fs.appendFileSync(file, JSON.stringify(request({ state: 'classified', procedureKey: 'torn' })).slice(0, 40));
    expect(l.ingestSync()).toBe(0);
    expect(l.keys().map((k) => k.procedureKey)).toEqual(['k']);
    l.close();
  });

  it('a corrupt cache is treated as missing and rebuilt from the segments', () => {
    const l = open();
    l.append(request({ state: 'classified', procedureKey: 'k' }));
    l.close();
    fs.writeFileSync(l.cachePath, 'this is not a sqlite file');
    for (const s of ['-wal', '-shm']) { try { SafeFsExecutor.safeRmSync(l.cachePath + s, { force: true, operation: 'tests/unit/skill-learning-ledger.test.ts' }); } catch { /* absent */ } }
    const l2 = open();
    expect(l2.status().counters.rebuilds).toBe(1);
    expect(l2.requestsForKey('k')).toHaveLength(1);
    l2.close();
  });

  it('rebuild() drops the cache and re-ingests every machine\'s segments', async () => {
    const l = open();
    l.append(request({ state: 'classified', procedureKey: 'k' }));
    fs.writeFileSync(path.join(l.ledgerDir, `${M2}.0.jsonl`), JSON.stringify(request({ machineId: M2, state: 'classified', procedureKey: 'k2' })) + '\n');
    await l.rebuild();
    expect(l.keys().map((k) => k.procedureKey).sort()).toEqual(['k', 'k2']);
    l.close();
  });

  it('dedupes request rows by source: a second observation is ignored, a classified row replaces pending, pending never downgrades classified', () => {
    const l = open();
    const src = { channel: 'telegram' as const, chatId: '7', messageId: '42' };
    l.append(request({ source: src }));
    fs.writeFileSync(path.join(l.ledgerDir, `${M2}.0.jsonl`), JSON.stringify(request({ source: src, machineId: M2 })) + '\n');
    l.ingestSync();
    expect(l.pendingCount()).toBe(1);
    expect(l.status().counters.deduped).toBe(1);
    l.append(request({ source: src, state: 'classified', procedureKey: 'k', repeatable: true }));
    expect(l.pendingCount()).toBe(0);
    expect(l.requestBySource(src)?.state).toBe('classified');
    l.append(request({ source: src, state: 'pending' }));
    expect(l.requestBySource(src)?.state).toBe('classified');
    expect(l.pendingCount()).toBe(0);
    l.close();
  });

  it('pendingRows skips a row whose retryAfter is in the future and selects one whose hold has passed; a later hold on the same row replaces the cached one', () => {
    let now = Date.parse('2026-11-06T12:00:00Z');
    const l = new Ledger({ stateDir, machineId: M1, now: () => now });
    l.startSync();
    const src = (id: string) => ({ channel: 'telegram' as const, chatId: '-1', messageId: id });
    const base = { kind: 'request' as const, topicId: '7', at: new Date(now - 1000).toISOString(), channel: 'telegram' as const, identity: 'verified' as const, machineId: M1 };
    l.append({ ...base, eventId: 'e-future', source: src('1'), state: 'needs-full', retryAfter: new Date(now + 86_400_000).toISOString() });
    l.append({ ...base, eventId: 'e-past', source: src('2'), state: 'needs-full', retryAfter: new Date(now - 60_000).toISOString() });
    l.append({ ...base, eventId: 'e-none', source: src('3'), state: 'pending' });
    l.ingestSync();
    expect(l.pendingRows(10).map((r) => r.eventId).sort()).toEqual(['e-none', 'e-past']);
    expect(l.pendingCount()).toBe(3);                                                   // the hold is visible backlog, not a drop
    expect(l.requestBySource(src('1'))?.retryAfter).toBe(new Date(now + 86_400_000).toISOString());
    now += 2 * 86_400_000;
    expect(l.pendingRows(10).map((r) => r.eventId).sort()).toEqual(['e-future', 'e-none', 'e-past']);
    // A second, later hold on the same source replaces the cached row (same rank, later retryAfter); an earlier one is deduped.
    l.append({ ...base, eventId: 'e-future-2', source: src('1'), state: 'needs-full', retryAfter: new Date(now + 86_400_000).toISOString() });
    l.append({ ...base, eventId: 'e-future-old', source: src('1'), state: 'needs-full', retryAfter: new Date(now - 86_400_000).toISOString() });
    l.ingestSync();
    expect(l.requestBySource(src('1'))?.eventId).toBe('e-future-2');
    expect(l.pendingRows(10).map((r) => r.eventId).sort()).toEqual(['e-none', 'e-past']);
    l.close();
  });

  it('keeps at most 200 request rows per key in the cache (newest), while the segment keeps all', () => {
    const l = open();
    for (let i = 0; i < MAX_REQUESTS_PER_KEY + 25; i++) l.append(request({ state: 'classified', procedureKey: 'hot' }));
    expect(l.requestsForKey('hot')).toHaveLength(MAX_REQUESTS_PER_KEY);
    const lines = fs.readFileSync(l.segmentPath(0), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(MAX_REQUESTS_PER_KEY + 25);
    expect(l.keys()[0]).toMatchObject({ procedureKey: 'hot', requests: MAX_REQUESTS_PER_KEY });
    l.close();
  });
});

describe('Ledger — outcome reducer (§3.6)', () => {
  it('reduceOutcomes keeps the higher-ranked label and marks the conflict', () => {
    const a = outcome({ label: 'accepted' });
    const b = outcome({ label: 'corrected' });
    expect(reduceOutcomes(a, b)).toMatchObject({ eventId: b.eventId, label: 'corrected', conflict: true });
    expect(reduceOutcomes(b, a)).toMatchObject({ eventId: b.eventId, label: 'corrected', conflict: true });
    expect(() => reduceOutcomes(a, outcome({ revision: 1 }))).toThrow();
  });

  it('two machines\' rows for one (runId, revision) reduce to the same answer in any arrival order', () => {
    const rows: OutcomeRow[] = [
      outcome({ runId: 'run-x', revision: 1, label: 'weak-positive', machineId: M1 }),
      outcome({ runId: 'run-x', revision: 1, label: 'accepted-inferred', machineId: M2 }),
      outcome({ runId: 'run-x', revision: 1, label: 'accepted', machineId: M2 }),
    ];
    const orders = [[0, 1, 2], [2, 1, 0], [1, 2, 0], [2, 0, 1]];
    for (const order of orders) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skl-order-'));
      try {
        const l = new Ledger({ stateDir: dir, machineId: M1 });
        l.startSync();
        fs.mkdirSync(l.ledgerDir, { recursive: true });
        // Each arrival lands as its own segment so the arrival order is the ingest order.
        order.forEach((idx, gen) => {
          const r = rows[idx];
          fs.writeFileSync(path.join(l.ledgerDir, `${r.machineId}.${gen}.jsonl`), JSON.stringify(r) + '\n');
          l.ingestSync();
        });
        const reduced = l.outcomesForKey('ci-health-report');
        expect(reduced).toHaveLength(1);
        expect(reduced[0].label).toBe('accepted');
        expect(reduced[0].conflict).toBe(true);
        expect(l.status().counters.outcomeConflicts).toBe(2);
        l.close();
      } finally {
        SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/skill-learning-ledger.test.ts' });
      }
    }
  });

  it('outcomesForKey returns the latest revision per run; latestOutcome / outcomeClosedBy / provisionalOutcomes read the same rows', () => {
    const l = open();
    l.append(outcome({ runId: 'run-1', revision: 0, label: 'unknown', closedBy: { channel: 'telegram', chatId: '7', messageId: '99' } }));
    l.append(outcome({ runId: 'run-1', revision: 1, label: 'accepted', provisional: true }));
    l.append(outcome({ runId: 'run-2', revision: 0, label: 'unknown', windowStart: '2026-11-06T13:00:00.000Z' }));
    const reduced = l.outcomesForKey('ci-health-report');
    expect(reduced.map((r) => [r.runId, r.revision, r.label])).toEqual([['run-2', 0, 'unknown'], ['run-1', 1, 'accepted']]);
    expect(l.latestOutcome('run-1')?.revision).toBe(1);
    expect(l.outcomeClosedBy({ channel: 'telegram', chatId: '7', messageId: '99' })?.runId).toBe('run-1');
    expect(l.provisionalOutcomes().map((r) => r.runId)).toEqual(['run-1', 'run-2']);
    l.close();
  });
});

describe('Ledger — verdicts, events, open runs', () => {
  it('verdictsForKey keeps the latest unexpired verdict per author', () => {
    const now = Date.parse('2026-11-06T12:00:00Z');
    const l = open(M1, { now: () => now });
    const v = (over: Partial<VerdictRow>): VerdictRow => ({ kind: 'verdict', eventId: `v-${++seq}`, procedureKey: 'k', by: 'arbiter', verdict: 'wait', at: new Date(now - 1000 * seq).toISOString(), machineId: M1, ...over });
    l.append(v({ by: 'arbiter', verdict: 'wait', expiresAt: new Date(now - 1).toISOString() }));
    l.append(v({ by: 'arbiter', verdict: 'draft', at: new Date(now - 5000).toISOString() }));
    l.append(v({ by: 'operator', verdict: 'agree' }));
    const out = l.verdictsForKey('k');
    expect(out.map((x) => [x.by, x.verdict]).sort()).toEqual([['arbiter', 'draft'], ['operator', 'agree']]);
    l.close();
  });

  it('eventsForKey returns improve/reviewer events newest first; openRuns lists requests without an outcome', () => {
    const l = open();
    l.append(request({ runId: 'run-open' }));
    l.append(request({ runId: 'run-done' }));
    l.append(request({ runId: undefined, identity: 'unverified-catchup' }));
    l.append(outcome({ runId: 'run-done' }));
    expect(l.openRuns().map((r) => r.runId)).toEqual(['run-open']);
    const ev = (event: EventRow['event'], at: string): EventRow => ({ kind: 'event', eventId: `e-${++seq}`, event, runId: 'run-done', procedureKey: 'ci-health-report', at, machineId: M1 });
    l.append(ev('improve', '2026-11-06T14:00:00.000Z'));
    l.append(ev('reviewer', '2026-11-06T15:00:00.000Z'));
    expect(l.eventsForKey('ci-health-report').map((e) => e.event)).toEqual(['reviewer', 'improve']);
    l.close();
  });

  it('before start() the reader answers empty and honestly reports cacheReady=false', () => {
    const l = new Ledger({ stateDir, machineId: M1 });
    expect(l.cacheReady).toBe(false);
    expect(l.keys()).toEqual([]);
    expect(l.pendingCount()).toBe(0);
  });
});
