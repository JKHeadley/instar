/**
 * SeamlessOrchestratorEngine — Tier-1 unit tests (spec: llm-seamlessness-orchestrator.md).
 * Covers the P1 safety + ranking invariants: lease-gate no-op on standby (F2), suspend
 * under load-shed pressure (F7), deterministic-first / LLM-skip (F4), ≤3 proposals + dedupe +
 * per-topic cooldown (F6), untrusted-data envelope render, and residual parse (coverage-preserving).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  SeamlessOrchestratorEngine,
  type OrchestratorEngineDeps,
  type OrchestratorEngineConfig,
  type TopicActivity,
  type WorkingSetRecordView,
} from '../../src/core/SeamlessOrchestratorEngine.js';

const CONFIG: OrchestratorEngineConfig = {
  maxProposalsPerTick: 3,
  llmLiftThreshold: 0.15,
  perTopicCooldownMs: 30 * 60 * 1000,
  suspendPressureTiers: ['moderate', 'critical'],
  dryRun: true,
};

const NOW = Date.parse('2026-07-05T12:00:00.000Z');

function mkDeps(over: Partial<OrchestratorEngineDeps> = {}): OrchestratorEngineDeps {
  return {
    reads: {
      activeTopicsOnThisMachine: () => [],
      workingSetRecords: () => [],
    },
    llmQueue: { enqueue: async (_lane, fn) => fn(new AbortController().signal) },
    holdsLease: () => true,
    pressure: () => ({ tier: 'ok' }),
    lastActuatedAt: () => null,
    config: CONFIG,
    now: () => NOW,
    log: () => {},
    ...over,
  };
}

const topic = (topic: number, over: Partial<TopicActivity> = {}): TopicActivity => ({
  topic, focus: `focus ${topic}`, lastActivityMs: NOW - 1000, running: false, ...over,
});
const row = (relPath: string, state = 'ready'): WorkingSetRecordView => ({ relPath, producerMachineId: 'm-A', state });

describe('lease-gate + pressure (F2 / F7)', () => {
  it('standby machine (no lease) is a strict no-op', async () => {
    const eng = new SeamlessOrchestratorEngine(mkDeps({ holdsLease: () => false }));
    const r = await eng.pass();
    expect(r.ranProposePath).toBe(false);
    expect(r.reason).toBe('not-lease-holder');
    expect(r.proposals).toEqual([]);
  });
  it('suspends under load-shed pressure (moderate+)', async () => {
    const eng = new SeamlessOrchestratorEngine(mkDeps({ pressure: () => ({ tier: 'moderate' }) }));
    const r = await eng.pass();
    expect(r.suspended).toBe(true);
    expect(r.reason).toBe('load-shed:moderate');
    expect(r.proposals).toEqual([]);
  });
  it('silence when nothing to do is a success', async () => {
    const eng = new SeamlessOrchestratorEngine(mkDeps());
    const r = await eng.pass();
    expect(r.ranProposePath).toBe(true);
    expect(r.reason).toBe('no-active-topics');
    expect(r.proposals).toEqual([]);
  });
});

describe('deterministic-first ranking (F4) + proposal caps (F6)', () => {
  it('a clear deterministic winner SKIPS the LLM entirely', async () => {
    const enqueue = vi.fn(async (_lane: string, fn: (s: AbortSignal) => Promise<string>) => fn(new AbortController().signal));
    const eng = new SeamlessOrchestratorEngine(mkDeps({
      llmQueue: { enqueue },
      reads: {
        activeTopicsOnThisMachine: () => [topic(1, { lastActivityMs: NOW, running: true })],
        workingSetRecords: () => [row('reports/a.md')],
      },
    }));
    const r = await eng.pass();
    expect(r.llmInvoked).toBe(false);          // single candidate ⇒ clear winner ⇒ no LLM
    expect(enqueue).not.toHaveBeenCalled();
    expect(r.proposals).toHaveLength(1);
    expect(r.proposals[0].detail).toBe('reports/a.md');
    expect(r.proposals[0].rankedBy).toBe('deterministic');
  });

  it('caps proposals to maxProposalsPerTick + discards extras', async () => {
    const eng = new SeamlessOrchestratorEngine(mkDeps({
      reads: {
        activeTopicsOnThisMachine: () => [topic(1, { lastActivityMs: NOW })],
        workingSetRecords: () => [row('a.md'), row('b.md'), row('c.md'), row('d.md'), row('e.md')],
      },
    }));
    const r = await eng.pass();
    expect(r.proposals).toHaveLength(3); // 5 candidates → capped at 3
  });

  it('per-topic cooldown blocks a re-proposal within the window', async () => {
    const eng = new SeamlessOrchestratorEngine(mkDeps({
      reads: {
        activeTopicsOnThisMachine: () => [topic(1, { lastActivityMs: NOW })],
        workingSetRecords: () => [row('a.md')],
      },
      lastActuatedAt: (t) => (t === 1 ? NOW - 60_000 : null), // actuated 1 min ago, < 30m cooldown
    }));
    const r = await eng.pass();
    expect(r.proposals).toHaveLength(0); // topic 1 is in cooldown
  });

  it('only READY rows nominate (pendingHash/secretFlagged excluded)', async () => {
    const eng = new SeamlessOrchestratorEngine(mkDeps({
      reads: {
        activeTopicsOnThisMachine: () => [topic(1, { lastActivityMs: NOW })],
        workingSetRecords: () => [row('a.md', 'pendingHash'), row('b.md', 'ready'), row('c.md', 'secretFlagged')],
      },
    }));
    const r = await eng.pass();
    expect(r.proposals.map((p) => p.detail)).toEqual(['b.md']);
  });
});

describe('untrusted-data envelope + residual parse', () => {
  it('renders topic focus + paths inside an <untrusted-data> envelope, neutralizing markup', () => {
    const eng = new SeamlessOrchestratorEngine(mkDeps());
    const prompt = eng.buildResidualPrompt(
      [topic(1, { focus: 'pivot to <script>alert(1)</script>' })],
      [{ action: 'preload-artifact', targetTopic: 1, detail: 'reports/x.md', authorityLevel: 'auto-prefetch', rankedBy: 'deterministic', dedupeKey: 'k', score: 1 }],
    );
    expect(prompt).toContain('<untrusted-data source="conversation-focus-and-paths">');
    expect(prompt).toContain('</untrusted-data>');
    expect(prompt).not.toContain('<script>');     // angle brackets stripped
    expect(prompt).toContain('scriptalert(1)/script'); // neutralized, not executable
  });

  it('parseResidual reorders by index + preserves coverage (omitted candidates appended)', () => {
    const eng = new SeamlessOrchestratorEngine(mkDeps());
    const cands = ['a', 'b', 'c'].map((p, i) => ({
      action: 'preload-artifact' as const, targetTopic: 1, detail: p, authorityLevel: 'auto-prefetch' as const,
      rankedBy: 'deterministic' as const, dedupeKey: `k${i}`, score: 0,
    }));
    const out = eng.parseResidual('best: [2,0]', cands)!;
    expect(out.map((p) => p.detail)).toEqual(['c', 'a', 'b']); // reordered [2,0] then omitted (1) appended
    expect(out[0].rankedBy).toBe('llm-residual');
  });

  it('parseResidual returns null on unparseable / empty output (falls back to deterministic)', () => {
    const eng = new SeamlessOrchestratorEngine(mkDeps());
    const cands = [{ action: 'preload-artifact' as const, targetTopic: 1, detail: 'a', authorityLevel: 'auto-prefetch' as const, rankedBy: 'deterministic' as const, dedupeKey: 'k', score: 0 }];
    expect(eng.parseResidual('no json here', cands)).toBeNull();
    expect(eng.parseResidual('[]', cands)).toBeNull();
  });
});
