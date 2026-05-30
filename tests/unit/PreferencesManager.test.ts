/**
 * Unit tests — PreferencesManager (Correction & Preference Learning Sentinel, Slice 1a).
 *
 * Tier 1 of the Testing Integrity Standard. Pins the load-bearing invariants of
 * the ONLY writer to `.instar/preferences.json`:
 *   - atomic write + schema-version stamped
 *   - upsert by dedupeKey (recurring learning collapses to ONE entry)
 *   - absent file ≡ empty store (never throws)
 *   - bounded-bytes + priority ordering of the session-start block
 *   - serves only learning + metadata
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  PreferencesManager,
  formatPreferencesForSessionStart,
  PREFERENCES_SCHEMA_VERSION,
  type PreferencesStore,
} from '../../src/core/PreferencesManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('PreferencesManager', () => {
  let tmpDir: string;
  let stateDir: string;
  let mgr: PreferencesManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-mgr-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    mgr = new PreferencesManager(stateDir);
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/PreferencesManager.test.ts:afterEach' });
  });

  describe('absent file ≡ empty store', () => {
    it('read() returns an empty, schema-versioned store when no file exists', () => {
      expect(mgr.exists()).toBe(false);
      const store = mgr.read();
      expect(store.preferences).toEqual([]);
      expect(store.schemaVersion).toBe(PREFERENCES_SCHEMA_VERSION);
    });

    it('sessionContext() reports present:false with no file', () => {
      const ctx = mgr.sessionContext();
      expect(ctx.present).toBe(false);
      expect(ctx.block).toBe('');
      expect(ctx.count).toBe(0);
    });

    it('a malformed file is treated as empty (never throws)', () => {
      fs.writeFileSync(mgr.getPath(), '{ this is not json');
      expect(() => mgr.read()).not.toThrow();
      expect(mgr.read().preferences).toEqual([]);
    });
  });

  describe('recordPreference — atomic write + schema version', () => {
    it('creates the file with a schema version and one entry', () => {
      const entry = mgr.recordPreference({
        learning: 'Lead with the one action, no preamble.',
        dedupeKey: 'user-preference:abc123',
        confidence: 0.8,
      });
      expect(mgr.exists()).toBe(true);

      const onDisk = JSON.parse(fs.readFileSync(mgr.getPath(), 'utf-8')) as PreferencesStore;
      expect(onDisk.schemaVersion).toBe(PREFERENCES_SCHEMA_VERSION);
      expect(onDisk.preferences).toHaveLength(1);
      expect(onDisk.preferences[0].learning).toBe('Lead with the one action, no preamble.');
      expect(onDisk.preferences[0].provenance).toBe('correction-loop');
      expect(onDisk.preferences[0].dedupeKey).toBe('user-preference:abc123');
      expect(onDisk.preferences[0].dedupeCount).toBe(1);
      expect(entry.dedupeCount).toBe(1);
    });

    it('leaves no temp files behind after a write', () => {
      mgr.recordPreference({ learning: 'x', dedupeKey: 'k:1' });
      const leftovers = fs.readdirSync(stateDir).filter((f) => f.includes('.tmp.'));
      expect(leftovers).toEqual([]);
    });

    it('throws on empty learning or empty dedupeKey', () => {
      expect(() => mgr.recordPreference({ learning: '   ', dedupeKey: 'k:1' })).toThrow();
      expect(() => mgr.recordPreference({ learning: 'real', dedupeKey: '' })).toThrow();
    });

    it('clamps confidence into [0,1] and defaults to 0.5', () => {
      mgr.recordPreference({ learning: 'a', dedupeKey: 'k:a', confidence: 5 });
      mgr.recordPreference({ learning: 'b', dedupeKey: 'k:b', confidence: -3 });
      mgr.recordPreference({ learning: 'c', dedupeKey: 'k:c' });
      const byKey = Object.fromEntries(mgr.read().preferences.map((p) => [p.dedupeKey, p.confidence]));
      expect(byKey['k:a']).toBe(1);
      expect(byKey['k:b']).toBe(0);
      expect(byKey['k:c']).toBe(0.5);
    });
  });

  describe('upsert by dedupeKey', () => {
    it('collapses a repeated dedupeKey to ONE entry and increments dedupeCount', () => {
      mgr.recordPreference({ learning: 'Be plainer.', dedupeKey: 'user-preference:plain', confidence: 0.5, recordedAt: '2026-05-01T00:00:00.000Z' });
      mgr.recordPreference({ learning: 'Use plainer language.', dedupeKey: 'user-preference:plain', confidence: 0.7, recordedAt: '2026-05-02T00:00:00.000Z' });
      mgr.recordPreference({ learning: 'Plainer, please.', dedupeKey: 'user-preference:plain', confidence: 0.6, recordedAt: '2026-05-03T00:00:00.000Z' });

      const store = mgr.read();
      expect(store.preferences).toHaveLength(1);
      const e = store.preferences[0];
      expect(e.dedupeCount).toBe(3);
      // learning refreshes to the latest phrasing
      expect(e.learning).toBe('Plainer, please.');
      // recordedAt advances to the latest observation
      expect(e.recordedAt).toBe('2026-05-03T00:00:00.000Z');
      // confidence takes the max observed
      expect(e.confidence).toBe(0.7);
    });

    it('keeps distinct dedupeKeys as separate entries', () => {
      mgr.recordPreference({ learning: 'a', dedupeKey: 'k:1' });
      mgr.recordPreference({ learning: 'b', dedupeKey: 'k:2' });
      expect(mgr.read().preferences).toHaveLength(2);
    });
  });

  describe('formatPreferencesForSessionStart — bounded bytes + priority order', () => {
    it('orders by recency × confidence × dedupeCount (highest first)', () => {
      const store: PreferencesStore = {
        schemaVersion: PREFERENCES_SCHEMA_VERSION,
        preferences: [
          { learning: 'OLD low', provenance: 'correction-loop', dedupeKey: 'k:old', recordedAt: '2020-01-01T00:00:00.000Z', confidence: 0.9, dedupeCount: 1 },
          { learning: 'NEW high', provenance: 'correction-loop', dedupeKey: 'k:new', recordedAt: '2026-05-30T00:00:00.000Z', confidence: 0.9, dedupeCount: 5 },
        ],
      };
      const block = formatPreferencesForSessionStart(store, 4000);
      const idxNew = block.indexOf('NEW high');
      const idxOld = block.indexOf('OLD low');
      expect(idxNew).toBeGreaterThanOrEqual(0);
      expect(idxOld).toBeGreaterThanOrEqual(0);
      expect(idxNew).toBeLessThan(idxOld);
    });

    it('bounds the block to maxBytes and includes the envelope', () => {
      const prefs = Array.from({ length: 50 }, (_, i) => ({
        learning: `Preference number ${i} `.repeat(10),
        provenance: 'correction-loop' as const,
        dedupeKey: `k:${i}`,
        recordedAt: new Date(2026, 0, i + 1).toISOString(),
        confidence: 0.5,
        dedupeCount: 1,
      }));
      const store: PreferencesStore = { schemaVersion: PREFERENCES_SCHEMA_VERSION, preferences: prefs };
      const maxBytes = 600;
      const block = formatPreferencesForSessionStart(store, maxBytes);
      expect(Buffer.byteLength(block, 'utf-8')).toBeLessThanOrEqual(maxBytes);
      expect(block).toContain("<auto-learned-preference src='correction-loop'>");
      expect(block).toContain('</auto-learned-preference>');
      // Should have dropped at least some preferences under the tight budget
      const included = (block.match(/Preference number/g) ?? []).length;
      expect(included).toBeGreaterThan(0);
      expect(included).toBeLessThan(50);
    });

    it('returns an empty string for an empty store', () => {
      expect(formatPreferencesForSessionStart({ schemaVersion: PREFERENCES_SCHEMA_VERSION, preferences: [] })).toBe('');
    });
  });

  describe('sessionContext — serves only learning + metadata', () => {
    it('renders the block from recorded preferences and excludes raw extras', () => {
      mgr.recordPreference({ learning: 'Lead with the action.', dedupeKey: 'user-preference:action', confidence: 0.8 });
      const ctx = mgr.sessionContext(4000);
      expect(ctx.present).toBe(true);
      expect(ctx.count).toBe(1);
      expect(ctx.block).toContain('Lead with the action.');
      expect(ctx.block).toContain("<auto-learned-preference src='correction-loop'>");
      // metadata appears (confidence + seen-count); no internal dedupeKey/provenance leak
      expect(ctx.block).toContain('confidence 0.80');
      expect(ctx.block).not.toContain('user-preference:action');
    });
  });
});
