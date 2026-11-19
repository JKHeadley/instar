/**
 * Bounded-input derivation review, batch 2 (STD-SUBCOUNTDOWN-bounded-input-derivation-review).
 * Behaviour pins for the sites not covered in their own suites:
 *  - the preload ranker keeps the END of a long path (the file name) and says it cut;
 *  - the temporal checker keeps both ends of a cut state document (the newest
 *    position is usually last) and discloses the middle; a configured bound
 *    below the helper's floor is honoured at the floor rather than throwing.
 * (Session history: topic-memory.test.ts. Summarizer: topic-summarizer.test.ts.)
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SeamlessOrchestratorEngine, type OrchestratorEngineDeps } from '../../src/core/SeamlessOrchestratorEngine.js';
import { TemporalCoherenceChecker } from '../../src/core/TemporalCoherenceChecker.js';
import { BOUNDED_ENDS_MIN_CHARS } from '../../src/core/boundedInput.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('preload ranker prompt', () => {
  const deps = {
    reads: { activeTopicsOnThisMachine: () => [], workingSetRecords: () => [] },
    llmQueue: { enqueue: async (_l: unknown, fn: (s: AbortSignal) => unknown) => fn(new AbortController().signal) },
    holdsLease: () => true, pressure: () => ({ tier: 'ok' }), lastActuatedAt: () => null,
    config: { maxProposalsPerTick: 3, llmLiftThreshold: 0.15, perTopicCooldownMs: 1, suspendPressureTiers: [], dryRun: true },
    now: () => 0, log: () => {},
  } as unknown as OrchestratorEngineDeps;

  it('keeps the file name of a long path and discloses the cut, on one line', () => {
    const longPath = `${'deeply/nested/dir/'.repeat(30)}the-report-that-matters.md`;
    const prompt = new SeamlessOrchestratorEngine(deps).buildResidualPrompt(
      [{ topic: 1, focus: 'short focus', lastActivityMs: 0, running: false }],
      [{ action: 'preload-artifact', targetTopic: 1, detail: longPath, authorityLevel: 'auto-prefetch', rankedBy: 'deterministic', dedupeKey: 'k', score: 1 } as never],
    );
    const line = prompt.split('\n').find((l) => l.startsWith('0. '))!;
    expect(line).toContain('the-report-that-matters.md');
    expect(line).toContain('[BOUNDED INPUT:');
    expect(prompt).toContain(': short focus');
  });
});

describe('temporal coherence state documents', () => {
  function setup(maxCharsPerDocument: number, agentMd: string) {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-b2-'));
    fs.writeFileSync(path.join(projectDir, 'AGENT.md'), agentMd);
    const checker = new TemporalCoherenceChecker({ projectDir, stateDir: path.join(projectDir, '.instar'), maxCharsPerDocument });
    return { checker, done: () => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/bounded-input-review-batch2.test.ts' }) };
  }

  it('keeps BOTH ends of a cut state document (identity at the top, newest position at the bottom) and discloses the middle', () => {
    const { checker, done } = setup(4000, `# Who I am\n${'old reflection. '.repeat(1000)}\n## Latest position: compaction is choice`);
    const state = checker.loadCurrentState()!;
    expect(state).toContain('# Who I am');
    expect(state).toContain('## Latest position: compaction is choice');
    expect(state).toContain('MIDDLE content was omitted');
    done();
  });

  it('a configured bound below the helper floor is honoured at the floor, not a thrown error', () => {
    const { checker, done } = setup(100, 'A'.repeat(5000));
    const state = checker.loadCurrentState()!;
    expect(state).toContain('[AGENT.md]');
    expect(state.length).toBeLessThan(BOUNDED_ENDS_MIN_CHARS + 50);
    done();
  });
});
