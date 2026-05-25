/**
 * Unit tests (Tier 1) for rung-2 store unification.
 *
 *   - WorkingSet: blended score, ranking, the topic-intent + Playbook adapters,
 *     degrade-safety.
 *   - WorkingMemoryAssembler integration: the REGRESSION PIN (no new deps →
 *     output has no working-set section, existing behavior unchanged) + the
 *     new working-set section appears when topic-intent/Playbook have content.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  blendedScore,
  rankWorkingSet,
  topicIntentToWorkingSet,
  playbookManifestToWorkingSet,
  type WorkingSetItem,
} from '../../src/memory/WorkingSet.js';
import { TopicIntentStore, buildEvent } from '../../src/core/TopicIntent.js';
import { WorkingMemoryAssembler } from '../../src/memory/WorkingMemoryAssembler.js';

const NOW = Date.parse('2026-03-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

let tempDir: string;
beforeEach(() => { tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwa-unify-')); });
afterEach(() => { try { SafeFsExecutor.safeRmSync(tempDir, { recursive: true, force: true, operation: 'tests/unit/cwa-unify-stores.test.ts' }); } catch { /* best */ } });

function item(over: Partial<WorkingSetItem>): WorkingSetItem {
  return { source: 'topic-intent', id: 'i', text: 't', relevance: 0.5, recencyAt: new Date(NOW).toISOString(), kind: 'fact', ...over };
}

describe('WorkingSet ranking', () => {
  it('blendedScore decays with age (half at one half-life)', () => {
    const fresh = blendedScore(item({ relevance: 1, recencyAt: new Date(NOW).toISOString() }), NOW);
    const old = blendedScore(item({ relevance: 1, recencyAt: new Date(NOW - 30 * DAY).toISOString() }), NOW);
    expect(fresh).toBeCloseTo(1, 2);
    expect(old).toBeCloseTo(0.5, 1);
  });

  it('ranks higher relevance × recency first; stable on ties', () => {
    const items = [
      item({ id: 'a', relevance: 0.9, recencyAt: new Date(NOW - 60 * DAY).toISOString() }), // decayed
      item({ id: 'b', relevance: 0.6, recencyAt: new Date(NOW).toISOString() }),             // fresh
      item({ id: 'c', relevance: 0.6, recencyAt: new Date(NOW).toISOString() }),             // tie with b → stable
    ];
    const ranked = rankWorkingSet(items, NOW).map(i => i.id);
    expect(ranked[0]).toBe('b'); // 0.6 fresh beats 0.9 heavily-decayed
    expect(ranked.indexOf('b')).toBeLessThan(ranked.indexOf('c')); // stable tie order
  });
});

describe('topic-intent adapter', () => {
  it('maps refs at/above tentative to WorkingSetItems; degrade-safe on no store', () => {
    expect(topicIntentToWorkingSet(null, 1)).toEqual([]);
    expect(topicIntentToWorkingSet(undefined, undefined)).toEqual([]);

    const store = new TopicIntentStore(tempDir);
    store.appendEvidence(42, 'ref-1', buildEvent('ref-1', 'extract-user', 'm1'), { text: 'use Path B', kind: 'decision' });
    const items = topicIntentToWorkingSet(store, 42);
    expect(items.length).toBe(1);
    expect(items[0]).toMatchObject({ source: 'topic-intent', text: 'use Path B', kind: 'decision' });
    expect(items[0].relevance).toBeGreaterThan(0);
  });
});

describe('Playbook manifest adapter', () => {
  function writeManifest(items: unknown[]) {
    const dir = path.join(tempDir, 'playbook', 'builtin-manifests');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'm.json'), JSON.stringify({ version: 1, items }));
  }

  it('surfaces only items whose triggers/tags match the query; degrade-safe with no dir', () => {
    expect(playbookManifestToWorkingSet(undefined, ['x'])).toEqual([]);
    expect(playbookManifestToWorkingSet(tempDir, [])).toEqual([]); // no query → trigger-gated, nothing

    writeManifest([
      { id: '/a', category: 'infra', load_triggers: ['deploying', 'release'], tags: { domains: ['deploy'] }, freshness: new Date(NOW).toISOString(), usefulness: { helpful: 3, misleading: 0 } },
      { id: '/b', category: 'infra', load_triggers: ['cooking'], tags: { domains: ['kitchen'] }, freshness: new Date(NOW).toISOString() },
    ]);
    const items = playbookManifestToWorkingSet(tempDir, ['deploying', 'the', 'app']);
    expect(items.map(i => i.id)).toEqual(['/a']); // only the trigger-matching item
    expect(items[0].source).toBe('playbook');
    expect(items[0].relevance).toBeGreaterThan(0);
  });

  it('ignores a corrupt manifest without throwing', () => {
    const dir = path.join(tempDir, 'playbook');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bad.json'), '{ not valid json');
    expect(() => playbookManifestToWorkingSet(tempDir, ['x'])).not.toThrow();
    expect(playbookManifestToWorkingSet(tempDir, ['x'])).toEqual([]);
  });
});

describe('WorkingMemoryAssembler — regression pin + new section', () => {
  it('REGRESSION PIN: with no topic-intent/stateDir deps, output has no working-set section', () => {
    const a = new WorkingMemoryAssembler({}); // no new deps, no memory systems
    const out = a.assemble({ prompt: 'anything about deploying', topicId: 7 });
    expect(out.sources.find(s => s.name === 'working-set')).toBeUndefined();
    expect(out.context).not.toContain('Working Set');
  });

  it('with the deps present but EMPTY sources, still no working-set section (additive)', () => {
    const store = new TopicIntentStore(tempDir); // empty store, no refs
    const a = new WorkingMemoryAssembler({ topicIntentStore: store, stateDir: tempDir });
    const out = a.assemble({ prompt: 'deploying', topicId: 999 });
    expect(out.sources.find(s => s.name === 'working-set')).toBeUndefined();
  });

  it('surfaces a working-set section when topic-intent has refs', () => {
    const store = new TopicIntentStore(tempDir);
    store.appendEvidence(7, 'r1', buildEvent('r1', 'extract-user', 'm1'), { text: 'we will deploy via blue-green', kind: 'decision' });
    const a = new WorkingMemoryAssembler({ topicIntentStore: store, stateDir: tempDir });
    const out = a.assemble({ prompt: 'how are we deploying', topicId: 7 });
    const ws = out.sources.find(s => s.name === 'working-set');
    expect(ws).toBeDefined();
    expect(ws!.count).toBeGreaterThanOrEqual(1);
    expect(out.context).toContain('Working Set');
    expect(out.context).toContain('blue-green');
  });
});
