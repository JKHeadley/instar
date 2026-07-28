import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  extractionGapSignals,
  protectedCueGaps,
  ClaimObservationRecorder,
  type ExtractedClaim,
} from '../../src/monitoring/ClaimObservation.js';

/**
 * Spec claim-verification-sentinel.md §2.1 — the deterministic protected-predicate lane emits
 * ExtractionGapSignal {minimumCriticality, reason, span}. Before this, the lane collapsed every
 * gap to a bare cue-family name, so a gap booked because NOTHING overlapped was indistinguishable
 * from a gap booked despite an overlapping claim the extractor CORRECTLY marked hedged/quoted.
 * That ambiguity is what made the observed gap rate uninterpretable.
 */

const claimOver = (startByte: number, endByte: number, overrides: Partial<ExtractedClaim> = {}): ExtractedClaim => ({
  clauseId: 0,
  kind: 'completion',
  subjectKind: 'tool-action',
  predicate: 'tool-action.completed',
  operand: { type: 'state-enum', value: 'done', enumVersion: 'action-v1' },
  comparator: 'eq',
  subjectSelector: { type: 'unresolved' },
  consequence: { relation: 'none', actionClass: 'none' },
  sourceStartByte: startByte,
  sourceEndByte: endByte,
  referencedEntityHints: [],
  endorsed: true,
  negated: false,
  hedged: false,
  quoted: false,
  suggestedCriticality: 'low',
  confidence: 0.9,
  tenseScope: 'past',
  ...overrides,
});

describe('ExtractionGapSignal — reason (spec §2.1)', () => {
  const message = 'The migration is done.';

  it('books no-overlapping-claim when the model extracted nothing over the span', () => {
    const signals = extractionGapSignals(message, []).filter((s) => s.kind === 'completion');
    expect(signals).toHaveLength(1);
    expect(signals[0].reason).toBe('no-overlapping-claim');
  });

  it('books unendorsed-overlap when a hedged claim DID overlap — the extractor was not silent', () => {
    const signals = extractionGapSignals(message, [claimOver(0, message.length, { hedged: true })])
      .filter((s) => s.kind === 'completion');
    expect(signals).toHaveLength(1);
    // The distinction this whole change exists to make: a hedged overlap is the extractor
    // classifying correctly, not the extractor missing a claim.
    expect(signals[0].reason).toBe('unendorsed-overlap');
  });

  it.each([
    ['quoted', { quoted: true }],
    ['non-endorsed', { endorsed: false }],
  ])('books unendorsed-overlap for a %s overlap too', (_label, overrides) => {
    const signals = extractionGapSignals(message, [claimOver(0, message.length, overrides)])
      .filter((s) => s.kind === 'completion');
    expect(signals[0]?.reason).toBe('unendorsed-overlap');
  });

  it('books NO gap at all when an endorsed, unquoted, unhedged claim overlaps (the other side)', () => {
    const signals = extractionGapSignals(message, [claimOver(0, message.length)])
      .filter((s) => s.kind === 'completion');
    expect(signals).toHaveLength(0);
  });

  it('books invalid-envelope when the model envelope failed validation', () => {
    const signals = extractionGapSignals(message, [], { envelopeValid: false })
      .filter((s) => s.kind === 'completion');
    expect(signals[0]?.reason).toBe('invalid-envelope');
  });
});

describe('ExtractionGapSignal — span and criticality floor', () => {
  it('carries the byte span of the cue candidate, not the whole message', () => {
    const message = 'Nothing here. The deploy is done.';
    const [signal] = extractionGapSignals(message, []).filter((s) => s.kind === 'completion');
    expect(signal.span.startByte).toBeGreaterThan(0);
    expect(signal.span.endByte).toBeGreaterThan(signal.span.startByte);
    expect(message.slice(signal.span.startByte, signal.span.endByte)).toContain('deploy');
  });

  it.each([
    ['The deploy is done.', 'completion', 'high'],
    ['We are capped at four lanes.', 'capacity', 'high'],
    ['Justin approved it.', 'attribution', 'high'],
    ['I will delete the branch.', 'action', 'irreversible-precondition'],
    ['The job is running.', 'state', 'medium'],
  ])('%s -> %s floors at %s (uncertainty rounds up)', (message, kind, expected) => {
    const signal = extractionGapSignals(message, []).find((s) => s.kind === kind);
    expect(signal?.minimumCriticality).toBe(expected);
  });
});

describe('ExtractionGapSignal — every span, not just the first', () => {
  it('catches a later unmatched span even when an earlier one was covered', () => {
    // Two completion-cue sentences. The FIRST is covered by an endorsed claim; the second is not.
    // The prior implementation stopped at the first matching candidate per cue family and would
    // have reported no completion gap at all here.
    const message = 'The merge is done. The deploy is finished.';
    const firstEnd = message.indexOf('.') + 1;
    const signals = extractionGapSignals(message, [claimOver(0, firstEnd)])
      .filter((s) => s.kind === 'completion');
    expect(signals).toHaveLength(1);
    expect(signals[0].reason).toBe('no-overlapping-claim');
    expect(signals[0].span.startByte).toBeGreaterThanOrEqual(firstEnd);
  });

  it('protectedCueGaps still returns deduped family names for existing counters', () => {
    const gaps = protectedCueGaps('The merge is done. The deploy is finished.', []);
    expect(gaps).toEqual([...new Set(gaps)]);
    expect(gaps).toContain('completion');
  });
});

describe('ExtractionGapSignal — audit persistence stays within the privacy boundary', () => {
  const withRecorder = (fn: (recorder: ClaimObservationRecorder, dir: string) => void): void => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-gap-'));
    try {
      fn(new ClaimObservationRecorder({ stateDir: dir, pseudonymKey: Buffer.alloc(32, 9) }), dir);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'claim-gap-test' });
    }
  };

  const readAudit = (dir: string): Record<string, unknown> => JSON.parse(
    fs.readFileSync(path.join(dir, 'state', 'claim-verification', 'claim-observation-audit-v2.jsonl'), 'utf8')
      .trim().split('\n')[0],
  );

  it('persists structural gap signals and never the message text', () => {
    withRecorder((recorder, dir) => {
      const message = 'The migration is done.';
      expect(recorder.recordEvent({ ts: new Date().toISOString(), evaluated: true,
        event: 'protected-cue-unextracted', gapKinds: ['completion'],
        gapSignals: extractionGapSignals(message, []).filter((s) => s.kind === 'completion'),
        dryRun: true })).toBe(true);
      const raw = fs.readFileSync(path.join(dir, 'state', 'claim-verification', 'claim-observation-audit-v2.jsonl'), 'utf8');
      expect(raw).not.toContain('migration');
      const row = readAudit(dir);
      expect(row.gapSignals).toMatchObject([
        { kind: 'completion', reason: 'no-overlapping-claim', minimumCriticality: 'high' },
      ]);
      expect((row.gapSignals as Array<{ span: unknown }>)[0].span)
        .toMatchObject({ startByte: expect.any(Number), endByte: expect.any(Number) });
    });
  });

  it('clamps a malformed signal rather than writing arbitrary caller data through', () => {
    withRecorder((recorder, dir) => {
      expect(recorder.recordEvent({ ts: new Date().toISOString(), evaluated: true,
        event: 'protected-cue-unextracted',
        gapSignals: [{ kind: 'x'.repeat(200), reason: 42, minimumCriticality: 'not-a-tier',
          span: { startByte: -5, endByte: 'nope' }, secretField: 'gh-token-value' }],
        dryRun: true })).toBe(true);
      const raw = fs.readFileSync(path.join(dir, 'state', 'claim-verification', 'claim-observation-audit-v2.jsonl'), 'utf8');
      expect(raw).not.toContain('gh-token-value');
      expect(raw).not.toContain('secretField');
      const signal = (readAudit(dir).gapSignals as Array<Record<string, unknown>>)[0];
      expect((signal.kind as string).length).toBe(32);
      expect(signal.reason).toBe('unknown');
      expect(signal.minimumCriticality).toBe('medium');
      expect(signal.span).toMatchObject({ startByte: 0, endByte: 0 });
    });
  });

  it('caps PER FAMILY so a busy message cannot drop the completion family wholesale', () => {
    withRecorder((recorder, dir) => {
      // Family-outer emission means a flat head-slice would keep only `capacity` here and silently
      // discard `completion` — the family the gap-reason statistic is actually about.
      const message = Array.from({ length: 24 },
        (_, i) => `Lane ${i} is capped and the deploy is done and running.`).join(' ');
      const gapSignals = extractionGapSignals(message, []);
      expect(gapSignals.length).toBeGreaterThan(24);
      expect(recorder.recordEvent({ ts: new Date().toISOString(), evaluated: true,
        event: 'protected-cue-unextracted', gapSignals, dryRun: true })).toBe(true);
      const row = readAudit(dir);
      const persisted = row.gapSignals as Array<{ kind: string }>;
      const families = [...new Set(persisted.map((s) => s.kind))].sort();
      expect(families).toEqual(['capacity', 'completion', 'state']);
      for (const family of families) {
        expect(persisted.filter((s) => s.kind === family).length).toBeLessThanOrEqual(8);
      }
      // Loss is recorded, never silent.
      expect(row.gapSignalsTruncated).toBe(true);
    });
  });

  it('bounds the array unconditionally against a hostile caller inventing kinds', () => {
    withRecorder((recorder, dir) => {
      // recordEvent is an untrusted-input boundary. A per-family cap alone bounds the array at
      // 8 x DISTINCT KINDS, so 5000 invented kinds would each get their own bucket and land a
      // ~500KB row — and appendBounded rotates-then-writes rather than rejecting, so an oversized
      // row costs audit history.
      expect(recorder.recordEvent({ ts: new Date().toISOString(), evaluated: true,
        event: 'protected-cue-unextracted',
        gapSignals: Array.from({ length: 5000 }, (_, i) => ({ kind: `invented-${i}`,
          reason: 'no-overlapping-claim', minimumCriticality: 'high', span: { startByte: 0, endByte: 1 } })),
        dryRun: true })).toBe(true);
      const row = readAudit(dir);
      expect((row.gapSignals as unknown[]).length).toBe(48);
      expect(row.gapSignalsTruncated).toBe(true);
    });
  });

  it('does not mark truncation when everything fit', () => {
    withRecorder((recorder, dir) => {
      expect(recorder.recordEvent({ ts: new Date().toISOString(), evaluated: true,
        event: 'protected-cue-unextracted',
        gapSignals: extractionGapSignals('The migration is done.', []),
        dryRun: true })).toBe(true);
      expect(readAudit(dir)).not.toHaveProperty('gapSignalsTruncated');
    });
  });

  it('stamps schemaVersion 2 so gap rates are never compared across the conformance fix', () => {
    withRecorder((recorder, dir) => {
      recorder.recordEvent({ ts: new Date().toISOString(), evaluated: true,
        event: 'protected-cue-unextracted', gapKinds: ['completion'], dryRun: true });
      expect(readAudit(dir).schemaVersion).toBe(2);
    });
  });

  it('omits gapSignals entirely when none are supplied, leaving legacy rows unchanged', () => {
    withRecorder((recorder, dir) => {
      expect(recorder.recordEvent({ ts: new Date().toISOString(), evaluated: true,
        event: 'protected-cue-unextracted', gapKinds: ['completion'], dryRun: true })).toBe(true);
      const row = readAudit(dir);
      expect(row.gapKinds).toEqual(['completion']);
      expect(row).not.toHaveProperty('gapSignals');
    });
  });
});
