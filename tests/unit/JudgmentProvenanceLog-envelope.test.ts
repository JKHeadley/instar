/**
 * Unit tests for the JudgmentProvenanceLog envelope extensions
 * (llm-decision-quality-meter §5.2): the additive seam fields
 * (correlationId/promptId/contentClass/mintedBy + outcome grading fields),
 * the serve-discipline charset clamps (violation → fixed marker + counted),
 * seam rows bypassing the legacy global sampling knob, correlation-id keyed
 * annotateOutcome beside the preserved legacy row-id path, and the exported
 * content-class envelope builders (bounded output, body keys dropped).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  JudgmentProvenanceLog,
  buildBoundedContext,
  buildTranscriptSliceIdentityContext,
  clampServedVerdictClass,
  clampServedPromptId,
  clampServedOptionLabel,
  fnv1aSampleBucket,
  SERVED_LABEL_RE,
} from '../../src/core/JudgmentProvenanceLog.js';
import type { DecisionRowInput, ProvenanceRow } from '../../src/core/JudgmentProvenanceLog.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const T0 = Date.parse('2026-07-10T12:00:00.000Z');
const TODAY = '2026-07-10';
const SECRET = 'sk-ant-oat01-abcdefghijklmnopqrstuvwx';

let tmpDir: string;
let fakeNow: number;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jpl-envelope-test-'));
  fakeNow = T0;
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(tmpDir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/JudgmentProvenanceLog-envelope.test.ts:afterEach',
  });
});

function makeLog(opts: Partial<ConstructorParameters<typeof JudgmentProvenanceLog>[0]> = {}) {
  return new JudgmentProvenanceLog({ dir: tmpDir, now: () => fakeNow, ...opts });
}

function seamInput(over: Partial<DecisionRowInput> = {}): DecisionRowInput {
  return {
    component: 'TestGate',
    decisionPoint: 'test-point',
    context: { commandHash: 'abc' },
    optionsPresented: ['kill', 'leave'],
    decision: 'fired',
    reason: 'router-settlement',
    floor: 'observe-only settlement seam',
    fallbackRung: 'llm',
    correlationId: 'd-00000000-0000-4000-8000-000000000001',
    promptId: 'prompt-v1',
    contentClass: 'content-bearing',
    mintedBy: 'router',
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

/* ── Additive seam fields ─────────────────────────────────────────────── */

describe('seam decision rows', () => {
  it('carry correlationId/promptId/contentClass/mintedBy and serve them redacted (contextFull omitted)', async () => {
    const log = makeLog();
    log.recordDecision(seamInput({ context: { leaked: SECRET } }));
    await log.flush();
    const [row] = readDayRows();
    expect(row.correlationId).toBe('d-00000000-0000-4000-8000-000000000001');
    expect(row.promptId).toBe('prompt-v1');
    expect(row.contentClass).toBe('content-bearing');
    expect(row.mintedBy).toBe('router');
    const [redacted] = await log.readRedacted();
    expect(redacted.correlationId).toBe('d-00000000-0000-4000-8000-000000000001');
    expect(redacted).not.toHaveProperty('contextFull');
    expect(redacted.contextRedacted).not.toContain(SECRET);
  });

  it('bypass the legacy global sampling knob (the census volume valve applied upstream)', async () => {
    const log = makeLog({ sampling: 0 }); // every legacy non-arbiter row samples out
    expect(log.recordDecision(seamInput())).toMatch(/^jp-/); // seam row written
    // Legacy row (no correlationId): byte-identical pre-seam behavior — sampled out.
    expect(
      log.recordDecision(seamInput({ correlationId: undefined, promptId: undefined, mintedBy: undefined, contentClass: undefined })),
    ).toBeNull();
    await log.flush();
    expect(readDayRows()).toHaveLength(1);
  });
});

/* ── Serve-discipline clamps (§5.2) ───────────────────────────────────── */

describe('serve-discipline clamps on seam rows', () => {
  it('clamps a violating decision to the fixed marker + counts it', async () => {
    const log = makeLog();
    log.recordDecision(seamInput({ decision: `raw model output: ${SECRET}` }));
    await log.flush();
    const [row] = readDayRows();
    expect(row.decision).toBe('unclassified');
    expect((log.status().counters as Record<string, number>).labelClampViolations).toBe(1);
  });

  it('keeps the seam-authored fixed markers verbatim', async () => {
    const log = makeLog();
    log.recordDecision(seamInput({ decision: '<errored>' }));
    log.recordDecision(seamInput({ decision: 'unclassified' }));
    await log.flush();
    const rows = readDayRows();
    expect(rows.map((r) => r.decision)).toEqual(['<errored>', 'unclassified']);
    expect((log.status().counters as Record<string, number>).labelClampViolations).toBe(0);
  });

  it('clamps violating optionsPresented entries + promptId, counting each', async () => {
    const log = makeLog();
    log.recordDecision(
      seamInput({ optionsPresented: ['clean_label', 'has spaces!'], promptId: 'prompt with spaces' }),
    );
    await log.flush();
    const [row] = readDayRows();
    expect(row.optionsPresented).toEqual(['clean_label', 'unclassified']);
    expect(row.promptId).toBe('unlabeled-prompt');
    expect((log.status().counters as Record<string, number>).labelClampViolations).toBe(2);
  });

  it('does NOT clamp legacy rows (byte-identical pre-seam behavior)', async () => {
    const log = makeLog();
    log.recordDecision(
      seamInput({
        correlationId: undefined,
        promptId: undefined,
        contentClass: undefined,
        mintedBy: undefined,
        decision: 'spawn on this machine (owner)',
        optionsPresented: ['spawn here', 'forward to owner'],
      }),
    );
    await log.flush();
    const [row] = readDayRows();
    expect(row.decision).toBe('spawn on this machine (owner)');
    expect(row.optionsPresented).toEqual(['spawn here', 'forward to owner']);
    expect((log.status().counters as Record<string, number>).labelClampViolations).toBe(0);
  });

  it('clamp helpers agree with the exported charset (both sides)', () => {
    expect(SERVED_LABEL_RE.test('ok-label_1')).toBe(true);
    expect(clampServedVerdictClass('fired')).toEqual({ value: 'fired', violated: false });
    expect(clampServedVerdictClass('<errored>')).toEqual({ value: '<errored>', violated: false });
    expect(clampServedVerdictClass('x'.repeat(65))).toEqual({ value: 'unclassified', violated: true });
    expect(clampServedVerdictClass(undefined)).toEqual({ value: 'unclassified', violated: false });
    expect(clampServedPromptId('v1')).toEqual({ value: 'v1', violated: false });
    expect(clampServedPromptId('v 1')).toEqual({ value: 'unlabeled-prompt', violated: true });
    expect(clampServedPromptId(undefined)).toEqual({ value: undefined, violated: false });
    expect(clampServedOptionLabel('kill')).toEqual({ value: 'kill', violated: false });
    expect(clampServedOptionLabel(42)).toEqual({ value: 'unclassified', violated: true });
  });
});

/* ── annotateOutcome keying (§5.4.1) ──────────────────────────────────── */

describe('annotateOutcome keying', () => {
  it('a correlation-id ref lands as correlationId with the grading fields', async () => {
    const log = makeLog();
    log.annotateOutcome(
      'd-00000000-0000-4000-8000-000000000009',
      'ExternalHogSentinel',
      { respawnPid: 4242 },
      { grade: 'wrong', gradedBy: 'ExternalHogSentinel', ruleId: 'hog-respawn-wrong-v1' },
    );
    await log.flush();
    const [row] = readDayRows();
    expect(row.kind).toBe('outcome');
    expect(row.correlationId).toBe('d-00000000-0000-4000-8000-000000000009');
    expect(row.decisionId).toBeUndefined();
    expect(row.grade).toBe('wrong');
    expect(row.gradedBy).toBe('ExternalHogSentinel');
    expect(row.ruleId).toBe('hog-respawn-wrong-v1');
  });

  it('the legacy row-id path is preserved unchanged (the two deterministic callsites)', async () => {
    const log = makeLog();
    log.annotateOutcome('jp-abc-1', 'SpawnAdmission', { ownerReturned: true });
    await log.flush();
    const [row] = readDayRows();
    expect(row.decisionId).toBe('jp-abc-1');
    expect(row.correlationId).toBeUndefined();
    expect(row.grade).toBeUndefined();
  });

  it('validates the FD3 grade enum at write: invalid → omitted + counted, never stored', async () => {
    const log = makeLog();
    log.annotateOutcome('d-x', 'ExternalHogSentinel', {}, { grade: 'sorta-right', ruleId: 'hog-respawn-wrong-v1' });
    await log.flush();
    const [row] = readDayRows();
    expect(row.grade).toBeUndefined();
    expect(row.ruleId).toBe('hog-respawn-wrong-v1');
    expect((log.status().counters as Record<string, number>).invalidGradeDropped).toBe(1);
  });
});

/* ── Envelope builders (§5.2) ─────────────────────────────────────────── */

describe('buildBoundedContext', () => {
  it('keeps code-authored facts and clamps + scrubs strings to 300 chars', () => {
    const out = buildBoundedContext({
      commandHash: 'abc123',
      cpuPercent: 220.5,
      floorPermitted: true,
      nullish: null,
      head: `${SECRET} ` + 'x'.repeat(1000),
    });
    expect(out.commandHash).toBe('abc123');
    expect(out.cpuPercent).toBe(220.5);
    expect(out.floorPermitted).toBe(true);
    expect(out.nullish).toBeNull();
    expect((out.head as string).length).toBeLessThanOrEqual(300);
    expect(out.head as string).not.toContain(SECRET);
  });

  it('bounds arrays, nesting depth, and key count', () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) wide[`k${i}`] = i;
    const out = buildBoundedContext({
      list: Array.from({ length: 100 }, (_, i) => `item-${i}`),
      nested: { a: { b: { c: 'too deep', huge: 'y'.repeat(2000) } } },
      wide,
    });
    expect((out.list as unknown[]).length).toBeLessThanOrEqual(32);
    const nested = out.nested as Record<string, unknown>;
    // Depth 2 collapses to a scrubbed JSON head, never unbounded nesting.
    expect(typeof nested.a).toBe('string');
    expect((nested.a as string).length).toBeLessThanOrEqual(300);
    const wideOut = out.wide as Record<string, unknown>;
    expect(Object.keys(wideOut).length).toBeLessThanOrEqual(65); // 64 kept + _truncatedKeys flag
    expect(wideOut._truncatedKeys).toBe(true);
  });

  it('drops functions/symbols and never throws', () => {
    const out = buildBoundedContext({ fn: () => 'x', sym: Symbol('s'), ok: 1 });
    expect(out.fn).toBeUndefined();
    expect(out.sym).toBeUndefined();
    expect(out.ok).toBe(1);
  });
});

describe('buildTranscriptSliceIdentityContext', () => {
  it('carries slice IDENTITY (hash + bounds) — never text', () => {
    const out = buildTranscriptSliceIdentityContext(
      { sliceHash: 'deadbeef01', startOffset: 100, endOffset: 4200, lineCount: 87, byteLength: 4100, source: 'autonomous-run-transcript' },
      { stopSignals: { markerSeen: true, turnCount: 12 } },
    );
    expect(out.sliceHash).toBe('deadbeef01');
    expect(out.sliceBounds).toEqual({ startOffset: 100, endOffset: 4200, lineCount: 87, byteLength: 4100 });
    expect(out.source).toBe('autonomous-run-transcript');
    expect((out.stopSignals as Record<string, unknown>).markerSeen).toBe(true);
  });

  it('structurally DROPS body-shaped keys from extra (the store is not a transcript archive)', () => {
    const out = buildTranscriptSliceIdentityContext(
      { sliceHash: 'deadbeef01' },
      {
        text: 'FULL TRANSCRIPT BODY',
        transcript: 'ALSO A BODY',
        Content: 'case-insensitive body',
        response: 'model output body',
        turnCount: 3,
      },
    );
    expect(out.text).toBeUndefined();
    expect(out.transcript).toBeUndefined();
    expect(out.Content).toBeUndefined();
    expect(out.response).toBeUndefined();
    expect(out.turnCount).toBe(3);
    expect(JSON.stringify(out)).not.toContain('TRANSCRIPT BODY');
  });
});

describe('fnv1aSampleBucket', () => {
  it('is deterministic and in [0,1)', () => {
    const b1 = fnv1aSampleBucket('d-abc');
    expect(b1).toBe(fnv1aSampleBucket('d-abc'));
    expect(b1).toBeGreaterThanOrEqual(0);
    expect(b1).toBeLessThan(1);
    expect(fnv1aSampleBucket('d-abc')).not.toBe(fnv1aSampleBucket('d-abd')); // near-collision sanity
  });
});
