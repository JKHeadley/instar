import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JevFirstDecision, createJevAsk, settleJevProbability, type JevPoint } from '../../src/core/JevFirstDecision.js';
import { JudgmentProvenanceLog, type DecisionRowInput } from '../../src/core/JudgmentProvenanceLog.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const point: JevPoint = {
  id: 'commitment-detect', promptId: 'commitment-v1', question: 'Did the agent explicitly promise to act?',
  stage: 'live', band: { noMax: 0.2, yesMin: 0.8 }, model: 'jev-1.13.0',
  timeoutMs: 1000, maxStateBytes: 8000, auditRate: 0, fallbackSelection: 'incumbent-no-benchmark',
};
function setup(overrides: Partial<ConstructorParameters<typeof JevFirstDecision>[0]> = {}) {
  const rows: DecisionRowInput[] = [];
  const askJev = vi.fn(async () => ({ model: 'jev-1.13.0', probability: 0.96, ms: 120, tokensIn: 42 }));
  const fallback = vi.fn(async () => ({ answer: false, model: 'gpt-6-luna', tokensIn: 1500 }));
  const gateway = new JevFirstDecision({ readKey: () => 'test-key', askJev,
    recordDecision: (row) => { rows.push(row); return 'jp-test'; }, random: () => 0.5, ...overrides });
  return { gateway, rows, askJev, fallback };
}

describe('JevFirstDecision', () => {
  it('settles only outside the point-specific unsure band', () => {
    expect(settleJevProbability(0.2, point.band)).toBe(false);
    expect(settleJevProbability(0.8, point.band)).toBe(true);
    expect(settleJevProbability(0.5, point.band)).toBeNull();
    expect(settleJevProbability(NaN, point.band)).toBeNull();
  });

  it('lets a confident pinned answer avoid the incumbent and records full scrubbed context locally', async () => {
    const x = setup();
    const result = await x.gateway.decide({ point, state: 'User asked; agent promised to fix it.', fallback: x.fallback });
    expect(result).toMatchObject({ answer: true, source: 'jev', reason: 'confident', recordId: 'jp-test' });
    expect(x.fallback).not.toHaveBeenCalled();
    expect(x.rows).toHaveLength(1);
    expect(x.rows[0].context._contentFull).toEqual({ question: point.question, state: 'User asked; agent promised to fix it.' });
    expect(x.rows[0].context).toMatchObject({ jevProbability: 0.96, fallbackSelection: 'incumbent-no-benchmark' });
    expect(x.rows[0].arbiter).toBe(true);
  });

  it('hands an uncertain answer to the incumbent', async () => {
    const x = setup({ askJev: async () => ({ model: 'jev-1.13.0', probability: 0.5, ms: 100 }) });
    const result = await x.gateway.decide({ point, state: 'A real exchange', fallback: x.fallback });
    expect(result).toMatchObject({ answer: false, source: 'incumbent', reason: 'uncertain' });
    expect(x.fallback).toHaveBeenCalledOnce();
    expect(x.rows[0].context).toMatchObject({ handoffReason: 'uncertain', fallbackModel: 'gpt-6-luna' });
  });

  it('only skips a detail-producing incumbent in the declared direction', async () => {
    const x = setup();
    const result = await x.gateway.decide({ point: { ...point, settleOnly: 'no' }, state: 'A real exchange', fallback: x.fallback });
    expect(result).toMatchObject({ answer: false, source: 'incumbent', reason: 'requires-detail' });
    expect(x.fallback).toHaveBeenCalledOnce();
    const y = setup({ askJev: async () => ({ model: 'jev-1.13.0', probability: 0.05, ms: 100 }) });
    const cleared = await y.gateway.decide({ point: { ...point, settleOnly: 'no' }, state: 'A real exchange', fallback: y.fallback });
    expect(cleared).toMatchObject({ answer: false, source: 'jev', reason: 'confident' });
    expect(y.fallback).not.toHaveBeenCalled();
  });

  it('delivers through one provider when the Jev key is missing', async () => {
    const x = setup({ readKey: () => null });
    const result = await x.gateway.decide({ point, state: 'A real exchange', fallback: x.fallback });
    expect(result).toMatchObject({ answer: false, source: 'incumbent', reason: 'no-key' });
    expect(x.askJev).not.toHaveBeenCalled();
  });

  it('keeps the incumbent authoritative during shadow and random audit', async () => {
    const x = setup();
    const shadow = await x.gateway.decide({ point: { ...point, stage: 'shadow' }, state: 'A real exchange', fallback: x.fallback });
    expect(shadow).toMatchObject({ answer: false, source: 'incumbent', reason: 'shadow' });
    const audited = await x.gateway.decide({ point: { ...point, auditRate: 1 }, state: 'A real exchange', fallback: x.fallback });
    expect(audited).toMatchObject({ answer: false, source: 'incumbent', reason: 'audit' });
    expect(x.rows[1].context.auditDisagree).toBe(true);
  });

  it('falls back on malformed, wrong-model, failed and oversized Jev responses', async () => {
    for (const answer of [
      { model: 'jev-latest', probability: 0.99, ms: 10 },
      { model: 'jev-1.13.0', probability: NaN, ms: 10 },
    ]) {
      const x = setup({ askJev: async () => answer });
      expect((await x.gateway.decide({ point, state: 'A real exchange', fallback: x.fallback })).source).toBe('incumbent');
    }
    const failed = setup({ askJev: async () => { throw new Error('offline'); } });
    expect((await failed.gateway.decide({ point, state: 'A real exchange', fallback: failed.fallback })).reason).toBe('jev-error');
    const oversized = setup();
    const result = await oversized.gateway.decide({ point: { ...point, maxStateBytes: 4 }, state: 'A real exchange', fallback: oversized.fallback });
    expect(result.reason).toBe('oversize');
    expect(oversized.askJev).not.toHaveBeenCalled();
    expect(oversized.rows[0].context._contentFull).toEqual({ question: point.question, state: '[withheld: context unavailable]' });
  });

  it('refuses to settle with Jev if decision recording fails', async () => {
    const x = setup({ recordDecision: () => { throw new Error('disk failed'); } });
    const result = await x.gateway.decide({ point, state: 'A real exchange', fallback: x.fallback });
    expect(result).toMatchObject({ answer: false, source: 'incumbent', reason: 'record-error' });
    expect(x.fallback).toHaveBeenCalledOnce();
  });

  it('keeps the full scrubbed decision local while the served provenance omits it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-first-jpl-'));
    try {
      const log = new JudgmentProvenanceLog({ dir });
      const x = setup({ recordDecision: (row) => log.recordDecisionFlushed(row) });
      const secret = 'Bearer abcdefghijklmnopqrstuvwxyz123456';
      const result = await x.gateway.decide({ point, state: `User said ${secret}; agent promised`, fallback: x.fallback });
      expect(result.source).toBe('jev');
      await log.flush();
      const raw = readFileSync(join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
      expect(raw).toContain('User said');
      expect(raw).not.toContain(secret);
      expect(raw).toContain('commitment-v1');
      expect(raw).toContain('no-linked-outcome-for-commitment-prefilter');
      const served = await log.readRedacted();
      expect(served).toHaveLength(1);
      expect(JSON.stringify(served)).not.toContain('User said');
      expect(JSON.stringify(served)).not.toContain(secret);
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'JevFirstDecision test cleanup' }); }
  });

  it('keeps the incumbent when the provenance flush fails after queuing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-first-jpl-fail-'));
    try {
      const blocked = join(dir, 'not-a-directory');
      writeFileSync(blocked, 'x');
      const log = new JudgmentProvenanceLog({ dir: blocked });
      const x = setup({ recordDecision: (row) => log.recordDecisionFlushed(row) });
      const result = await x.gateway.decide({ point, state: 'A real exchange', fallback: x.fallback });
      expect(result).toMatchObject({ source: 'incumbent', reason: 'record-error' });
      expect(x.fallback).toHaveBeenCalledOnce();
      expect(log.status().counters.writeErrors).toBeGreaterThan(0);
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'JevFirstDecision test cleanup' }); }
  });

  it('sends a pinned, bounded TypeSafe question and parses its probability', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, opts: RequestInit) => {
      expect(JSON.parse(String(opts.body))).toEqual({ state: 'exchange', model: 'jev-1.13.0',
        questions: { decision: { type: 'noul', instructions: 'A promise?' } } });
      return { ok: true, json: async () => ({ model: 'jev-1.13.0', answers: { decision: { noul: 0.91 } }, usage: { input_tokens: 8 } }) } as Response;
    });
    const answer = await createJevAsk(fetchImpl as unknown as typeof fetch)({ key: 'test-key', state: 'exchange', question: 'A promise?', model: 'jev-1.13.0', timeoutMs: 1000 });
    expect(answer).toMatchObject({ model: 'jev-1.13.0', probability: 0.91, tokensIn: 8 });
  });
});
