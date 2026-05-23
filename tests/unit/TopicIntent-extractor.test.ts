/**
 * Unit tests for TopicIntentExtractor — signal proposal → EvidenceEvent translation.
 *
 * The LLM call is stubbed; the focus is the LOGIC that turns LLM output into
 * persisted events.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TopicIntentStore } from '../../src/core/TopicIntent.js';
import {
  TopicIntentExtractor,
  parseExtractorResponse,
  buildExtractorPrompt,
  type ExtractFn,
  type SignalProposal,
  type ExtractorInput,
} from '../../src/core/TopicIntentExtractor.js';

let tempDir: string;
let store: TopicIntentStore;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-intent-extractor-test-'));
  store = new TopicIntentStore(tempDir);
});

afterEach(() => {
  try { SafeFsExecutor.safeRmSync(tempDir, { recursive: true, force: true, operation: 'tests/unit/TopicIntent-extractor.test.ts' }); } catch { /* best */ }
});

function makeInput(opts: Partial<ExtractorInput> & { topicId: number }): ExtractorInput {
  return {
    topicId: opts.topicId,
    arcId: opts.arcId ?? 'arc-default',
    message: opts.message ?? {
      id: 'msg-1',
      text: 'Hello',
      fromUser: true,
      turn: 1,
      at: '2026-01-01T00:00:00.000Z',
    },
    existingRefs: opts.existingRefs ?? [],
  };
}

describe('TopicIntentExtractor — ingest', () => {
  it('creates a new ref when LLM proposes new-ref from user message', async () => {
    const proposals: SignalProposal[] = [{
      kind: 'new-ref',
      refId: null,
      propositionText: 'use Path A OAuth for fetchDocument',
      refKind: 'decision',
    }];
    const ext = new TopicIntentExtractor(store, async () => proposals);
    const result = await ext.ingest(makeInput({ topicId: 500 }));

    expect(result.emitted).toHaveLength(1);
    expect(result.emitted[0].kind).toBe('extract-user');
    expect(result.createdRefs).toHaveLength(1);
    expect(result.createdRefs[0].text).toBe('use Path A OAuth for fetchDocument');
    expect(result.skipped).toBe(0);

    const file = store.load(500);
    expect(Object.keys(file.refs)).toHaveLength(1);
    const refId = Object.keys(file.refs)[0];
    // Read the live projection at the message's time (avoids stale-snapshot decay):
    const proj = store.getProjection(500, refId, Date.parse('2026-01-01T00:00:00.000Z'));
    expect(proj!.confidence).toBeCloseTo(0.40);
  });

  it('marks new-ref from agent message as extract-agent (not user-authored)', async () => {
    const proposals: SignalProposal[] = [{ kind: 'new-ref', refId: null, propositionText: 'something', refKind: 'fact' }];
    const ext = new TopicIntentExtractor(store, async () => proposals);
    const result = await ext.ingest(makeInput({
      topicId: 501,
      message: { id: 'msg-agent', text: 'I think we should use X', fromUser: false, turn: 2, at: '2026-01-01T00:00:00.000Z' },
    }));
    expect(result.emitted[0].kind).toBe('extract-agent');
    expect(result.emitted[0].userAuthored).toBe(false);
  });

  it('reref proposal generates user-reref evidence for user message', async () => {
    // Seed a ref
    store.appendEvidence(502, 'ref-existing', {
      eventId: 'e0', refId: 'ref-existing', kind: 'extract-user',
      sourceMessageId: 'seed', userAuthored: true, at: '2026-01-01T00:00:00.000Z', delta: 0.40,
    }, { text: 'use Path A', kind: 'decision' });

    const proposals: SignalProposal[] = [{ kind: 'reref', refId: 'ref-existing' }];
    const ext = new TopicIntentExtractor(store, async () => proposals);
    const result = await ext.ingest(makeInput({
      topicId: 502,
      message: { id: 'msg-2', text: 'on Path A...', fromUser: true, turn: 3, at: '2026-01-02T00:00:00.000Z' },
      existingRefs: store.read(502).refs ? Object.values(store.read(502).refs) : [],
    }));
    expect(result.emitted).toHaveLength(1);
    expect(result.emitted[0].kind).toBe('user-reref');
    expect(result.emitted[0].userAuthored).toBe(true);
  });

  it('affirm proposal from agent message is dropped (only user can affirm)', async () => {
    store.appendEvidence(503, 'ref-existing', {
      eventId: 'e0', refId: 'ref-existing', kind: 'extract-user',
      sourceMessageId: 'seed', userAuthored: true, at: '2026-01-01T00:00:00.000Z', delta: 0.40,
    }, { text: 'use Path A', kind: 'decision' });

    const proposals: SignalProposal[] = [{ kind: 'affirm', refId: 'ref-existing' }];
    const ext = new TopicIntentExtractor(store, async () => proposals);
    const result = await ext.ingest(makeInput({
      topicId: 503,
      message: { id: 'msg-2', text: 'yes', fromUser: false, turn: 4, at: '2026-01-02T00:00:00.000Z' },
      existingRefs: Object.values(store.read(503).refs),
    }));
    expect(result.emitted).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });

  it('contradict proposal from user message generates contradiction evidence', async () => {
    store.appendEvidence(504, 'ref-existing', {
      eventId: 'e0', refId: 'ref-existing', kind: 'extract-user',
      sourceMessageId: 'seed', userAuthored: true, at: '2026-01-01T00:00:00.000Z', delta: 0.40,
    }, { text: 'use Path A', kind: 'decision' });

    const proposals: SignalProposal[] = [{ kind: 'contradict', refId: 'ref-existing' }];
    const ext = new TopicIntentExtractor(store, async () => proposals);
    const result = await ext.ingest(makeInput({
      topicId: 504,
      message: { id: 'msg-2', text: "actually no, we're on Path B", fromUser: true, turn: 5, at: '2026-01-02T00:00:00.000Z' },
      existingRefs: Object.values(store.read(504).refs),
    }));
    expect(result.emitted).toHaveLength(1);
    expect(result.emitted[0].kind).toBe('contradiction');
    expect(result.emitted[0].delta).toBe(-0.60);
  });

  it('proposals with missing required fields are skipped', async () => {
    const proposals: SignalProposal[] = [
      { kind: 'new-ref', refId: null },                              // missing propositionText
      { kind: 'reref', refId: null },                                 // missing refId
      { kind: 'reref', refId: 'no-such-ref' },                        // refId not in existingRefs
      { kind: 'new-ref', refId: null, propositionText: 'ok', refKind: 'fact' }, // valid
    ];
    const ext = new TopicIntentExtractor(store, async () => proposals);
    const result = await ext.ingest(makeInput({ topicId: 505 }));
    expect(result.emitted).toHaveLength(1);
    expect(result.skipped).toBe(3);
  });

  it('extractor handles LLM returning empty array', async () => {
    const ext = new TopicIntentExtractor(store, async () => []);
    const result = await ext.ingest(makeInput({ topicId: 506 }));
    expect(result.emitted).toHaveLength(0);
    expect(result.skipped).toBe(0);
  });
});

describe('parseExtractorResponse — robust JSON extraction', () => {
  it('parses bare JSON array', () => {
    const out = parseExtractorResponse('[{"kind":"reref","refId":"r1"}]');
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('reref');
  });

  it('strips ```json code fences', () => {
    const out = parseExtractorResponse('```json\n[{"kind":"affirm","refId":"r2"}]\n```');
    expect(out).toHaveLength(1);
    expect(out[0].refId).toBe('r2');
  });

  it('strips bare ``` code fences', () => {
    const out = parseExtractorResponse('```\n[{"kind":"new-ref","refId":null,"propositionText":"x","refKind":"fact"}]\n```');
    expect(out).toHaveLength(1);
  });

  it('handles prose preamble before the array', () => {
    const out = parseExtractorResponse('Here are the signals: [{"kind":"contradict","refId":"r3"}] — that\'s it');
    expect(out).toHaveLength(1);
  });

  it('returns empty array for malformed JSON', () => {
    expect(parseExtractorResponse('not json')).toEqual([]);
    expect(parseExtractorResponse('[{"kind":"reref"')).toEqual([]);
  });

  it('filters items missing the kind field', () => {
    const out = parseExtractorResponse('[{"kind":"reref","refId":"r1"},{"refId":"r2"},null]');
    expect(out).toHaveLength(1);
  });
});

describe('buildExtractorPrompt', () => {
  it('includes the message text and existing refs', () => {
    const input = makeInput({
      topicId: 600,
      message: { id: 'm1', text: 'we should use Path B', fromUser: true, turn: 5, at: '2026-01-01T00:00:00.000Z' },
      existingRefs: [{
        refId: 'ref-A', arcId: 'arc-1', topicId: 600, kind: 'decision',
        text: 'use Path A OAuth', confidence: 0.45, evidence: [],
        lastReinforcedAt: '2026-01-01T00:00:00.000Z', status: 'live',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      }],
    });
    const { systemPrompt, userPrompt } = buildExtractorPrompt(input);
    expect(userPrompt).toContain('we should use Path B');
    expect(userPrompt).toContain('ref-A');
    expect(userPrompt).toContain('use Path A OAuth');
    expect(systemPrompt).toContain('JSON array');
  });
});
