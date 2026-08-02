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
  parseExtractorAnalysis,
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

  it('persists all three awareness levels without changing ref confidence tiers', async () => {
    const ext = new TopicIntentExtractor(store, async () => ({
      signals: [{ kind: 'new-ref', refId: null, propositionText: 'Keep the initial course visible', refKind: 'goal' }],
      awareness: {
        topic: { goal: 'Keep the initial course visible while the topic evolves', trend: 'Broadening from one task to durable continuity', themes: ['continuity', 'evolution'] },
        recentArc: { goal: 'Add three temporal scopes', trend: 'Moving from design into implementation', themes: ['topic', 'arc', 'work'] },
        currentWork: { goal: 'Persist the first projection', trend: 'Writing the guarded update path', themes: ['validation', 'storage'] },
        arcTransition: { kind: 'continue' },
      },
    }));

    const result = await ext.ingest(makeInput({
      topicId: 507,
      message: { id: 'msg-awareness', text: 'Keep the initial course visible while this evolves', fromUser: true, turn: 1, at: '2026-01-02T00:00:00.000Z' },
    }));

    expect(result.awarenessUpdated).toBe(true);
    expect(result.awarenessInvalid).toBe(false);
    expect(store.read(507).awareness?.anchor.goal).toContain('initial course');
    expect(store.read(507).awareness?.currentWork.themes).toEqual(['validation', 'storage']);
    const created = Object.values(store.read(507).refs)[0];
    expect(created.arcId).toBe('arc-507');
    expect(store.getProjection(507, created.refId, Date.parse(created.createdAt))?.tier).toBe('tentative');
  });

  it('classifies a valid agent-only anchor attempt as refused, not invalid', async () => {
    const ext = new TopicIntentExtractor(store, async () => ({
      signals: [],
      awareness: {
        topic: { goal: 'Agent-inferred origin', trend: 'Starting', themes: ['origin'] },
        recentArc: { goal: 'Agent arc', trend: 'Starting', themes: ['arc'] },
        currentWork: { goal: 'Agent work', trend: 'Starting', themes: ['work'] },
      },
    }));
    const result = await ext.ingest(makeInput({
      topicId: 509,
      message: {
        id: 'agent-first', text: 'I infer the topic goal', fromUser: false, turn: 0,
        at: '2026-01-01T00:00:00.000Z',
      },
    }));

    expect(result.awarenessUpdated).toBe(false);
    expect(result.awarenessInvalid).toBe(false);
    expect(result.awarenessAgentAnchorRefused).toBe(true);
    expect(store.read(509).awareness).toBeUndefined();
    expect(store.read(509).telemetry.capture?.awareness_agent_anchor_refused).toBe(1);
  });

  it('ignores an out-of-order projection and keeps its ref on the captured arc snapshot', async () => {
    const baseAwareness = {
      topic: { goal: 'Track the topic', trend: 'Starting', themes: ['continuity'] },
      recentArc: { goal: 'First arc', trend: 'Starting', themes: ['arc one'] },
      currentWork: { goal: 'First work', trend: 'Starting', themes: ['work'] },
      arcTransition: { kind: 'continue' as const },
    };
    store.updateAwareness(508, baseAwareness, {
      messageId: 'm1', messageText: 'Track the topic', fromUser: true,
      at: '2026-01-01T00:01:00.000Z', turn: 1,
    });
    store.updateAwareness(508, {
      ...baseAwareness,
      recentArc: { goal: 'Second arc', trend: 'Switching', themes: ['arc two'] },
      arcTransition: { kind: 'new', evidenceQuote: 'Now switch to the second arc' },
    }, {
      messageId: 'm2', messageText: 'Now switch to the second arc', fromUser: true,
      at: '2026-01-01T00:02:00.000Z', turn: 2,
    });
    expect(store.arcIdFor(508)).toBe('arc-508-2');

    const ext = new TopicIntentExtractor(store, async () => ({
      signals: [{ kind: 'new-ref', refId: null, propositionText: 'older arc fact', refKind: 'fact' }],
      awareness: baseAwareness,
    }));
    const result = await ext.ingest(makeInput({
      topicId: 508,
      arcId: 'arc-508',
      message: {
        id: 'late-m1', text: 'Older work completed late', fromUser: true, turn: 1,
        at: '2026-01-01T00:01:30.000Z',
      },
      existingAwareness: store.read(508).awareness,
    }));

    expect(result.awarenessUpdated).toBe(false);
    expect(result.awarenessStaleIgnored).toBe(true);
    expect(result.awarenessAnchorCorrected).toBe(false);
    expect(result.awarenessInvalid).toBe(false);
    expect(store.read(508).refs[result.createdRefs[0].refId].arcId).toBe('arc-508');
    expect(store.arcIdFor(508)).toBe('arc-508-2');
    expect(store.read(508).telemetry.capture?.awareness_stale_ignored).toBe(1);
  });

  it('refolds a delayed explicit boundary and re-homes newer refs by creation turn', async () => {
    const baseAwareness = {
      topic: { goal: 'Track the topic', trend: 'Starting', themes: ['continuity'] },
      recentArc: { goal: 'First arc', trend: 'Starting', themes: ['arc one'] },
      currentWork: { goal: 'First work', trend: 'Starting', themes: ['work'] },
      arcTransition: { kind: 'continue' as const },
    };
    store.updateAwareness(510, baseAwareness, {
      messageId: 'm1', messageText: 'Track the topic', fromUser: true,
      at: '2026-01-01T00:01:00.000Z', turn: 1,
    });

    const laterExtractor = new TopicIntentExtractor(store, async () => ({
      signals: [{ kind: 'new-ref', refId: null, propositionText: 'turn three fact', refKind: 'fact' }],
      awareness: {
        ...baseAwareness,
        recentArc: { goal: 'Documentation after the shift', trend: 'Continuing', themes: ['docs'] },
      },
    }));
    const later = await laterExtractor.ingest(makeInput({
      topicId: 510,
      arcId: 'arc-510',
      message: {
        id: 'm3', text: 'Continue documenting', fromUser: true, turn: 3,
        at: '2026-01-01T00:03:00.000Z',
      },
      existingAwareness: store.read(510).awareness,
    }));
    expect(store.read(510).refs[later.createdRefs[0].refId].arcId).toBe('arc-510');

    const boundaryExtractor = new TopicIntentExtractor(store, async () => ({
      signals: [{ kind: 'new-ref', refId: null, propositionText: 'turn two boundary fact', refKind: 'fact' }],
      awareness: {
        ...baseAwareness,
        recentArc: { goal: 'Move into documentation', trend: 'Switching', themes: ['docs'] },
        arcTransition: { kind: 'new' as const, evidenceQuote: 'Now move to documentation' },
      },
    }));
    const boundary = await boundaryExtractor.ingest(makeInput({
      topicId: 510,
      arcId: 'arc-510',
      message: {
        id: 'm2', text: 'Now move to documentation', fromUser: true, turn: 2,
        at: '2026-01-01T00:02:00.000Z',
      },
      existingAwareness: store.read(510).awareness,
    }));

    const file = store.read(510);
    expect(boundary.awarenessStaleIgnored).toBe(true);
    expect(boundary.arcTransitioned).toBe(true);
    expect(file.awareness?.currentArcId).toBe('arc-510-2');
    expect(file.refs[later.createdRefs[0].refId].arcId).toBe('arc-510-2');
    expect(file.refs[boundary.createdRefs[0].refId].arcId).toBe('arc-510-2');
    expect(file.telemetry.capture?.awareness_arc_transitions).toBe(1);
  });

  it('keeps a ref on its stable historical arc after that arc ages out of the reorder window', () => {
    const base = {
      topic: { goal: 'Long topic', trend: 'Starting', themes: ['history'] },
      recentArc: { goal: 'Initial arc', trend: 'Starting', themes: ['arc'] },
      currentWork: { goal: 'Initial work', trend: 'Starting', themes: ['work'] },
      arcTransition: { kind: 'continue' as const },
    };
    store.updateAwareness(511, base, {
      messageId: 'm1', messageText: 'Long topic', fromUser: true,
      at: '2026-01-01T00:01:00.000Z', turn: 1,
    });
    store.updateAwareness(511, {
      ...base,
      recentArc: { goal: 'Phase 2', trend: 'Switching', themes: ['phase'] },
      arcTransition: { kind: 'new', evidenceQuote: 'Now switch to phase 2' },
    }, {
      messageId: 'm2', messageText: 'Now switch to phase 2', fromUser: true,
      at: '2026-01-01T00:02:00.000Z', turn: 2,
    });
    store.appendEvidence(511, 'historical-ref', {
      eventId: 'historical-event', refId: 'historical-ref', kind: 'extract-user',
      sourceMessageId: 'm2', userAuthored: true,
      at: '2026-01-01T00:02:00.000Z', delta: 0.4,
    }, { text: 'Phase two decision', kind: 'decision', arcId: 'arc-511-2', sourceTurn: 2 });

    for (let turn = 3; turn <= 70; turn++) {
      store.updateAwareness(511, {
        ...base,
        recentArc: { goal: `Phase ${turn}`, trend: 'Switching', themes: ['phase'] },
        arcTransition: { kind: 'new', evidenceQuote: `Now switch to phase ${turn}` },
      }, {
        messageId: `m${turn}`, messageText: `Now switch to phase ${turn}`, fromUser: true,
        at: new Date(Date.UTC(2026, 0, 1, 0, turn)).toISOString(), turn,
      });
    }

    const file = store.read(511);
    expect(file.awareness?.archivedArcCount).toBeGreaterThan(0);
    expect(file.refs['historical-ref'].arcId).toBe('arc-511-2');
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

describe('parseExtractorAnalysis — three awareness levels', () => {
  it('preserves a legacy array containing proposal objects during rolling upgrades', () => {
    const parsed = parseExtractorAnalysis(
      '[{"kind":"new-ref","refId":null,"propositionText":"keep the signal","refKind":"decision"}]',
    );
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect((parsed as SignalProposal[])[0].propositionText).toBe('keep the signal');
  });

  it('parses the structured object and rejects a partial awareness block', () => {
    const raw = JSON.stringify({
      signals: [{ kind: 'reref', refId: 'r1' }],
      awareness: {
        topic: { goal: 'g', trend: 't', themes: ['a'] },
        recentArc: { goal: 'g2', trend: 't2', themes: ['b'] },
        currentWork: { goal: 'g3', trend: 't3', themes: ['c'] },
        arcTransition: { kind: 'continue' },
      },
    });
    const parsed = parseExtractorAnalysis(raw);
    expect(Array.isArray(parsed)).toBe(false);
    expect((parsed as any).signals).toHaveLength(1);
    expect((parsed as any).awareness.currentWork.goal).toBe('g3');

    const partial = parseExtractorAnalysis(JSON.stringify({ signals: [], awareness: { topic: {} } }));
    expect((partial as any).awareness).toBeUndefined();
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
    expect(systemPrompt).toContain('signals');
    expect(systemPrompt).toContain('THREE TEMPORAL AWARENESS LEVELS');
    expect(systemPrompt).toContain('goal, trend, and 1-5 themes');
  });
});
