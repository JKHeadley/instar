/**
 * Unit tests for JudgmentProvenanceLog — durable decision-content log
 * (ownership-gated-spawn-and-judgment-within-floors spec §3.5).
 *
 * Covers: decision-row schema, write-time credential redaction (contextFull
 * machine-local vs contextRedacted served), the 64KB row clamp, deterministic
 * sampling (arbiter rows always written), outcome annotation, retention sweep
 * via SafeFsExecutor, and readRedacted limit/sinceMs filters.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  JudgmentProvenanceLog,
  PROVENANCE_ROW_BYTE_CLAMP,
} from '../../src/core/JudgmentProvenanceLog.js';
import type { DecisionRowInput, ProvenanceRow } from '../../src/core/JudgmentProvenanceLog.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const T0 = Date.parse('2026-07-10T12:00:00.000Z');
const TODAY = '2026-07-10';

let tmpDir: string;
let fakeNow: number;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jpl-test-'));
  fakeNow = T0;
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(tmpDir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/JudgmentProvenanceLog.test.ts:afterEach',
  });
});

function makeLog(opts: Partial<ConstructorParameters<typeof JudgmentProvenanceLog>[0]> = {}) {
  return new JudgmentProvenanceLog({ dir: tmpDir, now: () => fakeNow, ...opts });
}

function decisionInput(over: Partial<DecisionRowInput> = {}): DecisionRowInput {
  return {
    component: 'SpawnAdmission',
    decisionPoint: 'may-this-machine-spawn-for-this-topic',
    context: { sessionKey: '123', callsite: 'telegram-cold-spawn' },
    optionsPresented: ['spawn', 'forward'],
    decision: 'spawn',
    reason: 'this machine owns the conversation',
    floor: 'admission-table-a-e',
    fallbackRung: 'deterministic',
    ...over,
  };
}

function readDayRows(day = TODAY): ProvenanceRow[] {
  const file = path.join(tmpDir, `${day}.jsonl`);
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as ProvenanceRow);
}

describe('recordDecision', () => {
  it('writes one decision row with the full §3.5 schema', async () => {
    const log = makeLog();
    const id = log.recordDecision(decisionInput());
    expect(id).toMatch(/^jp-/);
    await log.flush();

    const rows = readDayRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.id).toBe(id);
    expect(row.ts).toBe(new Date(T0).toISOString());
    expect(row.kind).toBe('decision');
    expect(row.component).toBe('SpawnAdmission');
    expect(row.decisionPoint).toBe('may-this-machine-spawn-for-this-topic');
    expect(row.contextFull).toEqual({ sessionKey: '123', callsite: 'telegram-cold-spawn' });
    expect(typeof row.contextRedacted).toBe('string');
    expect(row.optionsPresented).toEqual(['spawn', 'forward']);
    expect(row.decision).toBe('spawn');
    expect(row.reason).toBe('this machine owns the conversation');
    expect(row.floor).toBe('admission-table-a-e');
    expect(row.fallbackRung).toBe('deterministic');
  });
});

describe('redaction (write-time scrub; machine-local full context)', () => {
  const TOKEN = 'sk-ant-oat01-' + 'a'.repeat(40);

  it('contextRedacted does NOT carry the raw token; contextFull DOES (machine-local honesty)', async () => {
    const log = makeLog();
    log.recordDecision(decisionInput({ context: { note: `bearer ${TOKEN} in flight` } }));
    await log.flush();

    const row = readDayRows()[0];
    expect(row.contextRedacted).not.toContain(TOKEN);
    expect(JSON.stringify(row.contextFull)).toContain(TOKEN);
  });

  it('readRedacted rows NEVER carry contextFull and DO carry contextRedacted', async () => {
    const log = makeLog();
    log.recordDecision(decisionInput({ context: { note: TOKEN } }));
    const rows = await log.readRedacted();
    expect(rows).toHaveLength(1);
    expect('contextFull' in rows[0]).toBe(false);
    expect(typeof rows[0].contextRedacted).toBe('string');
    expect(rows[0].contextRedacted).not.toContain(TOKEN);
  });
});

describe('64KB per-row clamp', () => {
  it('a ~100KB context is truncated + flagged, and the row on disk stays under the clamp', async () => {
    const log = makeLog();
    log.recordDecision(decisionInput({ context: { huge: 'x'.repeat(100_000) } }));
    await log.flush();

    const file = path.join(tmpDir, `${TODAY}.jsonl`);
    const line = fs
      .readFileSync(file, 'utf-8')
      .split('\n')
      .filter((l) => l.trim().length > 0)[0];
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(PROVENANCE_ROW_BYTE_CLAMP);
    const row = JSON.parse(line) as ProvenanceRow;
    expect(row.truncated).toBe(true);
    expect((row.contextFull as { truncated?: boolean }).truncated).toBe(true);
  });
});

describe('deterministic sampling', () => {
  it('sampling 0: non-arbiter rows return null and write nothing', async () => {
    const log = makeLog({ sampling: 0 });
    expect(log.recordDecision(decisionInput())).toBeNull();
    expect(log.recordDecision(decisionInput())).toBeNull();
    await log.flush();
    expect(fs.existsSync(path.join(tmpDir, `${TODAY}.jsonl`))).toBe(false);
    expect(log.status().counters.decisionsSampledOut).toBe(2);
  });

  it('sampling 0: arbiter rows are ALWAYS written', async () => {
    const log = makeLog({ sampling: 0 });
    const id = log.recordDecision(decisionInput({ arbiter: true }));
    expect(id).not.toBeNull();
    await log.flush();
    const rows = readDayRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].arbiter).toBe(true);
  });

  it('sampling 1: every row is written', async () => {
    const log = makeLog({ sampling: 1 });
    const ids = [log.recordDecision(decisionInput()), log.recordDecision(decisionInput()), log.recordDecision(decisionInput())];
    expect(ids.every((i) => typeof i === 'string')).toBe(true);
    await log.flush();
    expect(readDayRows()).toHaveLength(3);
  });
});

describe('annotateOutcome', () => {
  it('appends an outcome row referencing the decision row id', async () => {
    const log = makeLog();
    const id = log.recordDecision(decisionInput());
    log.annotateOutcome(id as string, 'SpawnAdmission', { ownerReturned: true, resendSeen: false });
    await log.flush();

    const rows = readDayRows();
    const outcome = rows.find((r) => r.kind === 'outcome');
    expect(outcome).toBeDefined();
    expect(outcome?.decisionId).toBe(id);
    expect(outcome?.component).toBe('SpawnAdmission');
    expect(outcome?.outcome).toEqual({ ownerReturned: true, resendSeen: false });
    expect(log.status().counters.outcomesWritten).toBe(1);
  });
});

describe('retention sweep (SafeFsExecutor.safeUnlink — tmpdir is outside the source tree)', () => {
  it('deletes day files older than retention while today survives', async () => {
    const staleFile = path.join(tmpDir, '2020-01-01.jsonl');
    fs.writeFileSync(staleFile, JSON.stringify({ id: 'jp-old', ts: '2020-01-01T00:00:00.000Z', kind: 'decision' }) + '\n');
    // A non-matching file must be left alone by the sweep.
    const strayFile = path.join(tmpDir, 'notes.txt');
    fs.writeFileSync(strayFile, 'keep me');

    const log = makeLog({ retentionDays: 14 });
    log.recordDecision(decisionInput());
    await log.flush();

    expect(fs.existsSync(staleFile)).toBe(false);
    expect(fs.existsSync(strayFile)).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, `${TODAY}.jsonl`))).toBe(true);
  });
});

describe('readRedacted filters', () => {
  it('honors limit (newest first) and sinceMs', async () => {
    const log = makeLog();
    log.recordDecision(decisionInput({ decision: 'first' }));
    fakeNow = T0 + 1_000;
    log.recordDecision(decisionInput({ decision: 'second' }));
    fakeNow = T0 + 2_000;
    log.recordDecision(decisionInput({ decision: 'third' }));

    const limited = await log.readRedacted({ limit: 2 });
    expect(limited.map((r) => r.decision)).toEqual(['third', 'second']);

    const since = await log.readRedacted({ sinceMs: T0 + 1_500 });
    expect(since.map((r) => r.decision)).toEqual(['third']);
  });
});
