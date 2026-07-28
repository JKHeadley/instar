/**
 * The Benchmark-Divergence Detector's Q0 precondition compares two strings for
 * EXACT equality (BenchmarkDivergenceAnalyzer.ts):
 *
 *     registrySourceMatches =
 *       task.benchedPromptSource === registryEntry.source
 *
 * A mismatch means `precondition-failed / hash-unverifiable` — the detector
 * declines to judge, which is the correct behaviour for a benchmark it cannot
 * tie to the live prompt.
 *
 * WHAT HAPPENED (2026-07-25). The mirror wrote those sources with a COLON
 * separator (`MessagingToneGate.ts:TONE_GATE_PROMPT_TEMPLATE`) while the
 * registry declared them with a HASH (`...ts#TONE_GATE_PROMPT_TEMPLATE`). One
 * character. So `registrySourceMatches` was false for EVERY task on EVERY run,
 * and the detector returned `precondition-failed` for its entire shipped life.
 *
 * It never looked broken. `precondition-failed` is a legitimate, designed
 * verdict — the responsible answer when a benchmark is genuinely stale. The
 * analysis pass completed cleanly, emitted a valid verdict, and errored never.
 * A permanently blindfolded detector is output-identical to a correctly
 * cautious one, which is exactly why this survived.
 *
 * The one-character typo was the bug. The absence of anything comparing the two
 * strings at build time was the DEFECT — that is what this file fixes. The
 * exact-match comparison in the analyzer is deliberately NOT loosened: it is the
 * guard. Loosening it would trade a visible failure for a silent one. Instead a
 * mismatch is made unshippable.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROMPT_TEMPLATE_REGISTRY,
  liveTemplateHash,
} from '../../src/data/benchmarkDivergenceRegistry.js';
import { computeVerdict, type VerdictInput } from '../../src/core/benchmarkDivergenceCore.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIRROR_PATH = path.join(ROOT, 'src/data/benchmarkPredictions.json');

interface MirrorTask {
  benchedPromptSource?: unknown;
  benchedPromptHash?: unknown;
  perModel?: Record<string, unknown>;
}

function readMirror(): { tasks: Record<string, MirrorTask> } {
  return JSON.parse(fs.readFileSync(MIRROR_PATH, 'utf-8'));
}

describe('benchmark mirror ↔ prompt registry agreement (Q0 precondition)', () => {
  const mirror = readMirror();

  it('the fixture is real — the mirror carries tasks and the registry is populated', () => {
    // Guards the guard: every assertion below iterates one of these, so an
    // empty collection would make this whole file vacuously green.
    expect(Object.keys(mirror.tasks).length).toBeGreaterThan(0);
    expect(Object.keys(PROMPT_TEMPLATE_REGISTRY).length).toBeGreaterThan(0);
  });

  it('every mirror task names a task the registry knows', () => {
    for (const taskId of Object.keys(mirror.tasks)) {
      expect(
        PROMPT_TEMPLATE_REGISTRY[taskId],
        `mirror task '${taskId}' has no PROMPT_TEMPLATE_REGISTRY entry — the analyzer cannot resolve a live prompt for it`,
      ).toBeDefined();
    }
  });

  it('benchedPromptSource EXACTLY equals the registry source — the string the analyzer compares', () => {
    // THE regression test. This is the comparison the analyzer performs; if it
    // fails here, the detector is blind in production and says nothing about it.
    for (const [taskId, entry] of Object.entries(PROMPT_TEMPLATE_REGISTRY)) {
      const task = mirror.tasks[taskId];
      if (!task) continue; // covered by the coverage test below
      expect(
        task.benchedPromptSource,
        `task '${taskId}': the mirror's benchedPromptSource must be byte-identical to the registry source, or ` +
          `registrySourceMatches is false and every verdict becomes precondition-failed/hash-unverifiable. ` +
          `Note the separator: the registry uses '#', not ':'.`,
      ).toBe(entry.source);
    }
  });

  it('benchedPromptHash matches the live template hash', () => {
    // The sibling precondition. A drifted hash is a legitimate stale-benchmark
    // signal (re-capture the mirror), unlike the source mismatch above which is
    // always a bug — but both silently disable the detector, so both are pinned.
    for (const taskId of Object.keys(PROMPT_TEMPLATE_REGISTRY)) {
      const task = mirror.tasks[taskId];
      if (!task) continue;
      const live = liveTemplateHash(taskId);
      expect(live, `task '${taskId}': live template hash is uncomputable`).not.toBeNull();
      expect(
        task.benchedPromptHash,
        `task '${taskId}': the benched prompt hash no longer matches the live template — the prompt changed ` +
          `since the benchmark was captured. Re-capture the mirror; do NOT edit the hash by hand.`,
      ).toBe(live);
    }
  });

  it('every registry task has a mirror entry (no silently unbenchable decision point)', () => {
    for (const taskId of Object.keys(PROMPT_TEMPLATE_REGISTRY)) {
      expect(
        mirror.tasks[taskId],
        `registry task '${taskId}' has no mirror entry — it can never be compared against a benched baseline`,
      ).toBeDefined();
    }
  });

  it('every mirror task carries at least one per-model baseline', () => {
    for (const [taskId, task] of Object.entries(mirror.tasks)) {
      const models = Object.keys(task.perModel ?? {});
      expect(models.length, `mirror task '${taskId}' has no perModel baselines`).toBeGreaterThan(0);
    }
  });
});

/**
 * The BEHAVIOURAL claim. String equality above is the mechanism; this is the
 * consequence — with the sources agreeing the ladder gets PAST step 2 and can
 * reach a real verdict, and with them disagreeing it cannot, no matter how good
 * the evidence is.
 */
describe('the source match is what lets the ladder reach a real verdict', () => {
  const HASH = 'a'.repeat(64);

  function input(registrySourceMatches: boolean): VerdictInput {
    return {
      normalizedModel: 'gpt-5.5',
      mirrorPresent: true,
      mirrorStaleDays: 1,
      mirrorStalenessMaxDays: 30,
      bench: { passRate: 0.96, passes: 27, deterministic: 28 },
      benchedPromptHash: HASH,
      liveHash: HASH,
      registrySourceMatches,
      windowPromptIds: ['p1'],
      // Deliberately generous evidence: plenty of settled grades, no unknowns,
      // no orphans, full coverage. Nothing but the source flag differs.
      rightN: 180,
      wrongN: 20,
      decidedTotal: 200,
      orphanShare: 0,
      coverageComplete: true,
      thresholds: {
        divergenceThreshold: 0.1,
        minSample: 20,
        maxUnknownShare: 0.5,
        maxOrphanShare: 0.2,
      },
    };
  }

  it('sources DISAGREE → precondition-failed/hash-unverifiable, however strong the evidence', () => {
    const r = computeVerdict(input(false));
    expect(r.verdict).toBe('precondition-failed');
    expect(r.preconditionReason).toBe('hash-unverifiable');
    // This was production for the detector's entire shipped life.
  });

  it('sources AGREE → a real, actionable verdict on the same evidence', () => {
    const r = computeVerdict(input(true));
    expect(r.verdict).not.toBe('precondition-failed');
    expect(r.preconditionReason).toBeUndefined();
    // 0.90 real vs 0.96 benched = 0.06 delta, inside the 0.10 threshold.
    expect(r.verdict).toBe('aligned');
    expect(r.realGradeRate).toBeCloseTo(0.9, 5);
    expect(r.predictedRate).toBeCloseTo(0.96, 5);
  });

  it('and a genuinely worse real rate now surfaces as divergent-worse', () => {
    const r = computeVerdict({ ...input(true), rightN: 120, wrongN: 80 });
    expect(r.verdict).toBe('divergent-worse');
  });
});
