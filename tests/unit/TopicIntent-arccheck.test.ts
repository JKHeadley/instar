/**
 * Unit tests for TopicIntentArcCheck — Layer 3 classifier.
 *
 * Covers:
 *   - No tracked refs at or above tentative → no fire
 *   - Acts-on-tentative fires with suggestedRewriteHint
 *   - Contradicts-settled fires with higher priority than acts-on-tentative
 *   - Acts-on-authoritative does NOT fire (it's confirmation, not uncertainty)
 *   - Contradicts-tentative does NOT fire (not strong enough — let user signal land)
 *   - Empty actsOn + contradicts → no fire
 *   - parseArcCheckResponse robustness (code fences, prose, malformed JSON)
 *   - Signal-only: verdict never includes a "block" field; the agent decides
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  TopicIntentStore,
  buildEvent,
} from '../../src/core/TopicIntent.js';
import {
  ArcCheck,
  parseArcCheckResponse,
  buildArcCheckPrompt,
  createArcCheckClassifyFn,
  type ArcCheckClassifyFn,
  type ArcCheckClassification,
} from '../../src/core/TopicIntentArcCheck.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

let tempDir: string;
let store: TopicIntentStore;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-intent-arccheck-test-'));
  store = new TopicIntentStore(tempDir);
});

afterEach(() => {
  try { SafeFsExecutor.safeRmSync(tempDir, { recursive: true, force: true, operation: 'tests/unit/TopicIntent-arccheck.test.ts' }); } catch { /* best */ }
});

function seedTentative(topicId: number, refId: string, text: string): void {
  store.appendEvidence(topicId, refId, buildEvent(refId, 'extract-user', `seed-${refId}`), { text, kind: 'decision' });
}

function seedAuthoritative(topicId: number, refId: string, text: string): void {
  store.appendEvidence(topicId, refId, buildEvent(refId, 'extract-user', `seed-${refId}-1`), { text, kind: 'decision' });
  store.appendEvidence(topicId, refId, buildEvent(refId, 'user-affirm', `seed-${refId}-2`));
}

function classifierReturning(c: ArcCheckClassification): ArcCheckClassifyFn {
  return async () => c;
}

describe('ArcCheck — fires & priorities', () => {
  it('no refs at all → no fire', async () => {
    const ac = new ArcCheck(store, classifierReturning({ actsOn: [], contradicts: [] }));
    const v = await ac.check({ topicId: 100, draftText: 'doing the thing' });
    expect(v.fire).toBe(false);
  });

  it('refs exist but classifier returns no engagement → no fire', async () => {
    seedTentative(101, 'ref-A', 'use Path A');
    const ac = new ArcCheck(store, classifierReturning({ actsOn: [], contradicts: [] }));
    const v = await ac.check({ topicId: 101, draftText: 'unrelated draft' });
    expect(v.fire).toBe(false);
  });

  it('acts-on-tentative → fire with rewrite hint', async () => {
    seedTentative(102, 'ref-A', 'use Path A OAuth');
    const ac = new ArcCheck(store, classifierReturning({ actsOn: ['ref-A'], contradicts: [] }));
    const v = await ac.check({ topicId: 102, draftText: 'Using Path A here, the implementation is …' });
    expect(v.fire).toBe(true);
    if (v.fire) {
      expect(v.kind).toBe('acting-on-tentative');
      expect(v.refId).toBe('ref-A');
      expect(v.currentTier).toBe('tentative');
      expect(v.suggestedRewriteHint).toContain('confirmation');
      expect(v.suggestedRewriteHint).toContain('use Path A OAuth');
    }
  });

  it('contradicts-settled → fire with higher priority than acts-on-tentative', async () => {
    seedAuthoritative(103, 'ref-set', 'use Path A OAuth');
    seedTentative(103, 'ref-tent', 'timeout is 30s');
    const ac = new ArcCheck(store, classifierReturning({
      actsOn: ['ref-tent'],
      contradicts: ['ref-set'],
    }));
    const v = await ac.check({ topicId: 103, draftText: 'switching to Path B and using the 30s timeout' });
    expect(v.fire).toBe(true);
    if (v.fire) {
      // Contradicts-settled wins over acts-on-tentative
      expect(v.kind).toBe('contradicts-settled');
      expect(v.refId).toBe('ref-set');
      expect(v.currentTier).toBe('authoritative');
      expect(v.suggestedRewriteHint).toContain('previously settled');
    }
  });

  it('acts-on-authoritative does NOT fire (confirmation, not uncertainty)', async () => {
    seedAuthoritative(104, 'ref-set', 'use Path A');
    // Classifier says draft acts on the SETTLED item — that's just proceeding correctly
    const ac = new ArcCheck(store, classifierReturning({ actsOn: ['ref-set'], contradicts: [] }));
    const v = await ac.check({ topicId: 104, draftText: 'Per our Path A decision, …' });
    expect(v.fire).toBe(false);
  });

  it('contradicts-tentative does NOT fire (let the user signal land via Layer 1 evidence)', async () => {
    seedTentative(105, 'ref-tent', 'use Path A');
    const ac = new ArcCheck(store, classifierReturning({ actsOn: [], contradicts: ['ref-tent'] }));
    const v = await ac.check({ topicId: 105, draftText: 'I think we should switch to Path B' });
    // A contradiction of a tentative item is itself a signal that Layer 1 should record;
    // ArcCheck doesn't double-up by also firing a confirmation question. No fire.
    expect(v.fire).toBe(false);
  });

  it('verdict never includes a "block" or authority field — signal only', async () => {
    seedTentative(106, 'ref-A', 'use Path A');
    const ac = new ArcCheck(store, classifierReturning({ actsOn: ['ref-A'], contradicts: [] }));
    const v = await ac.check({ topicId: 106, draftText: 'Using Path A …' });
    // ts shape: ArcCheckVerdict never has 'block' / 'authority' fields
    expect((v as Record<string, unknown>).block).toBeUndefined();
    expect((v as Record<string, unknown>).authority).toBeUndefined();
  });

  it('classifier targeting a refId that no longer exists → no fire (safe degrade)', async () => {
    seedTentative(107, 'ref-real', 'real item');
    const ac = new ArcCheck(store, classifierReturning({ actsOn: ['ref-no-such-thing'], contradicts: [] }));
    const v = await ac.check({ topicId: 107, draftText: 'doing something' });
    expect(v.fire).toBe(false);
  });
});

describe('parseArcCheckResponse — robust JSON extraction', () => {
  it('parses bare object', () => {
    const r = parseArcCheckResponse('{"actsOn":["r1"],"contradicts":[]}');
    expect(r).toEqual({ actsOn: ['r1'], contradicts: [] });
  });

  it('strips ```json code fences', () => {
    const r = parseArcCheckResponse('```json\n{"actsOn":["r2"],"contradicts":["r3"]}\n```');
    expect(r.actsOn).toEqual(['r2']);
    expect(r.contradicts).toEqual(['r3']);
  });

  it('handles prose preamble', () => {
    const r = parseArcCheckResponse('Here is the classification: {"actsOn":[],"contradicts":["r4"]} — done');
    expect(r.contradicts).toEqual(['r4']);
  });

  it('degrades to empty arrays on malformed JSON', () => {
    expect(parseArcCheckResponse('not json')).toEqual({ actsOn: [], contradicts: [] });
    expect(parseArcCheckResponse('{"actsOn":')).toEqual({ actsOn: [], contradicts: [] });
  });

  it('filters non-string items from the arrays', () => {
    const r = parseArcCheckResponse('{"actsOn":["r1",42,null,"r2"],"contradicts":[true]}');
    expect(r.actsOn).toEqual(['r1', 'r2']);
    expect(r.contradicts).toEqual([]);
  });

  it('handles missing keys', () => {
    const r = parseArcCheckResponse('{"actsOn":["only"]}');
    expect(r.actsOn).toEqual(['only']);
    expect(r.contradicts).toEqual([]);
  });
});

describe('buildArcCheckPrompt', () => {
  it('includes the draft text and tracked refs', () => {
    seedTentative(200, 'ref-A', 'use Path A');
    const refs = store.getRefsAtOrAbove(200, 'tentative');
    const { systemPrompt, userPrompt } = buildArcCheckPrompt('I will use Path A for the OAuth flow', refs);
    expect(systemPrompt).toContain('actsOn');
    expect(systemPrompt).toContain('contradicts');
    expect(userPrompt).toContain('I will use Path A for the OAuth flow');
    expect(userPrompt).toContain('ref-A');
    expect(userPrompt).toContain('use Path A');
  });
});

describe('createArcCheckClassifyFn', () => {
  it('returns an empty classification (degrade-safe) when no provider is configured', async () => {
    let reason: string | undefined;
    const classify = createArcCheckClassifyFn(undefined, r => { reason = r; });
    const out = await classify('draft', []);
    expect(out).toEqual({ actsOn: [], contradicts: [] });
    expect(reason).toBe('no-intelligence');
  });

  it('calls the provider at the FAST tier with attribution and parses JSON', async () => {
    let seenOpts: { model?: string; attribution?: { component?: string } } | undefined;
    const provider: IntelligenceProvider = {
      async evaluate(_prompt, options) {
        seenOpts = options;
        return '{"actsOn":["ref-X"],"contradicts":["ref-Y"]}';
      },
    };
    const classify = createArcCheckClassifyFn(provider);
    const out = await classify('draft text', [] as never);
    expect(out).toEqual({ actsOn: ['ref-X'], contradicts: ['ref-Y'] });
    expect(seenOpts?.model).toBe('fast');
    expect(seenOpts?.attribution?.component).toBe('TopicIntentArcCheck');
  });

  it('returns an empty classification (degrade-safe) when the provider throws', async () => {
    let reason: string | undefined;
    const provider: IntelligenceProvider = { async evaluate() { throw new Error('timeout'); } };
    const classify = createArcCheckClassifyFn(provider, r => { reason = r; });
    const out = await classify('draft', []);
    expect(out).toEqual({ actsOn: [], contradicts: [] });
    expect(reason).toBe('error');
  });

  it('tolerates code-fenced provider responses', async () => {
    const provider: IntelligenceProvider = {
      async evaluate() { return '```json\n{"actsOn":[],"contradicts":["ref-Z"]}\n```'; },
    };
    const classify = createArcCheckClassifyFn(provider);
    const out = await classify('draft', []);
    expect(out).toEqual({ actsOn: [], contradicts: ['ref-Z'] });
  });
});
