/**
 * Unit — HumanAsDetectorLog Layer-0 extension for the Correction & Preference
 * Learning Sentinel (Slice 1b, spec §3.2).
 *
 * Pins:
 *   - preference + frustration families classify on BOTH sides of each rule;
 *   - a lone weak signal never fires (the precision contract holds);
 *   - learningKind + deterministicWeight are exposed for the correction loop;
 *   - preference/frustration traffic does NOT change summarizeByLayer() counts
 *     (the guardian-failure heat map is untouched — the key §3.2 invariant);
 *   - the drift-canary counter records.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HumanAsDetectorLog,
  LEARNING_ONLY_CATEGORIES,
  LEARNING_DETERMINISTIC_THRESHOLD,
} from '../../src/monitoring/HumanAsDetectorLog.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('HumanAsDetectorLog — correction-learning Layer-0 extension', () => {
  let tmpDir: string;
  let log: HumanAsDetectorLog;

  beforeEach(() => {
    HumanAsDetectorLog.resetForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hadl-cl-'));
    log = HumanAsDetectorLog.getInstance();
    log.configure({ stateDir: tmpDir, agentName: 'cl-test' });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/HumanAsDetectorLog-correction-learning.test.ts' });
    HumanAsDetectorLog.resetForTesting();
  });

  describe('preference family (both sides)', () => {
    it('flags an explicit "from now on" preference', () => {
      const v = log.classify('From now on, lead with the one action and skip the preamble.');
      expect(v).not.toBeNull();
      expect(v!.category).toBe('preference');
      expect(v!.learningKind).toBe('preference');
      expect(v!.deterministicWeight).toBeGreaterThanOrEqual(LEARNING_DETERMINISTIC_THRESHOLD);
    });

    it('flags "I prefer / I\'d rather"', () => {
      expect(log.classify("I'd rather you keep it plain.")!.learningKind).toBe('preference');
      expect(log.classify('I prefer no tables in chat.')!.category).toBe('preference');
    });

    it('does NOT flag a benign request that is not a preference', () => {
      expect(log.classify('Can you add a chart to the report?')).toBeNull();
      expect(log.classify('What is the status of the deploy?')).toBeNull();
    });
  });

  describe('frustration family (both sides)', () => {
    it('flags "you keep" / "every time" / "stop asking me"', () => {
      expect(log.classify('You keep asking me to confirm the same thing.')!.learningKind).toBe('frustration');
      expect(log.classify('Every session you ask me this again.')!.category).toBe('frustration');
      expect(log.classify('Please stop asking me to authorize the push.')!.learningKind).toBe('frustration');
    });

    it('does NOT flag a neutral mention of time', () => {
      expect(log.classify('I will be away every Tuesday afternoon.')).toBeNull();
    });
  });

  it('a lone WEAK preference signal never fires on its own', () => {
    // "no more" alone is weight 1 → below the threshold-of-2 gate. Lone weak.
    expect(log.classify('no more')).toBeNull();
  });

  it('LEARNING_ONLY_CATEGORIES contains preference + frustration only', () => {
    expect(LEARNING_ONLY_CATEGORIES.has('preference')).toBe(true);
    expect(LEARNING_ONLY_CATEGORIES.has('frustration')).toBe(true);
    expect(LEARNING_ONLY_CATEGORIES.has('factual-correction')).toBe(false);
  });

  describe('summarizeByLayer() is UNCHANGED by preference/frustration traffic (§3.2)', () => {
    it('learning-only signals do not appear in the guardian-failure heat map', () => {
      // 2 guardian-failure corrections + 3 learning signals.
      log.observe({ text: "that's wrong", source: 'telegram', topicId: 1 });
      log.observe({ text: 'this is out of date', source: 'telegram', topicId: 1 });
      log.observe({ text: 'from now on lead with the action', source: 'telegram', topicId: 1 });
      log.observe({ text: 'you keep asking me to confirm', source: 'telegram', topicId: 1 });
      log.observe({ text: 'I prefer plain language', source: 'telegram', topicId: 1 });

      const summary = log.summarizeByLayer();
      const total = summary.reduce((s, e) => s + e.count, 0);
      // ONLY the 2 guardian-failure signals are counted — the 3 learning
      // signals are excluded.
      expect(total).toBe(2);
      // No learning-only layer sentinel appears.
      const layers = summary.map((s) => s.layer).join(' | ');
      expect(layers).not.toContain('correction-learning signal');
      // No preference/frustration category leaks into the heat map.
      const cats = summary.flatMap((s) => s.categories);
      expect(cats).not.toContain('preference');
      expect(cats).not.toContain('frustration');
    });

    it('adding learning traffic to an existing heat map does not change its counts', () => {
      log.observe({ text: "that's wrong", source: 'telegram' });
      const before = log.summarizeByLayer();
      const beforeTotal = before.reduce((s, e) => s + e.count, 0);

      log.observe({ text: 'from now on keep it plain', source: 'telegram' });
      log.observe({ text: 'you keep doing this every time', source: 'telegram' });

      const after = log.summarizeByLayer();
      const afterTotal = after.reduce((s, e) => s + e.count, 0);
      expect(afterTotal).toBe(beforeTotal);
    });
  });

  describe('drift canary', () => {
    it('records sampled + mismatch counts', () => {
      log.recordDriftSample(false);
      log.recordDriftSample(true);
      log.recordDriftSample(false);
      const c = log.getDriftCanary();
      expect(c.sampled).toBe(3);
      expect(c.mismatches).toBe(1);
      expect(c.missRate).toBeCloseTo(1 / 3, 5);
    });

    it('miss-rate is 0 with no samples', () => {
      expect(log.getDriftCanary().missRate).toBe(0);
    });
  });
});
