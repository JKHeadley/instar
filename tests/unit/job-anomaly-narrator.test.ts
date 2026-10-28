import { describe, it, expect, vi } from 'vitest';
import {
  JobAnomalyNarrator, renderEvidenceBlock, fallbackSentence,
  NARRATOR_INSTRUCTION, NARRATOR_INPUT_MAX_CHARS,
} from '../../src/scheduler/JobAnomalyNarrator.js';
import { COMPONENT_CATEGORY } from '../../src/core/componentCategories.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const input = {
  jobName: 'Health Check', jobSlug: 'health-check', machineId: 'm1', machineName: 'the mini', episodeId: 'ep1',
  reasons: [{ id: 'disk-critical', class: 'critical' as const }],
  jobBody: 'B'.repeat(10_000),
};

describe('JobAnomalyNarrator', () => {
  it('is registered as a reflector component', () => {
    expect(COMPONENT_CATEGORY.JobAnomalyNarrator).toBe('reflector');
  });

  it('prompt carries the fixed instruction, fences the body as context, cuts it with a marker, stays bounded', () => {
    const p = JobAnomalyNarrator.buildPrompt(input);
    expect(p.startsWith(NARRATOR_INSTRUCTION)).toBe(true);
    expect(p).toContain('CONTEXT ONLY');
    expect(p).toMatch(/truncated|omitted|chars/i); // boundedHead marker
    expect(p.length).toBeLessThanOrEqual(NARRATOR_INPUT_MAX_CHARS);
    expect((p.match(/B/g) ?? []).length).toBeLessThan(2_000);
  });

  it('passes attribution with jobSlug, machineId and episodeId, model fast, 15 s timeout, and takes a model reply', async () => {
    const evaluate = vi.fn(async (_p: string, o: any) => { o.onModel?.({ model: 'gpt-x', framework: 'codex-cli' }); return 'The disk is nearly full.'; });
    const n = new JobAnomalyNarrator({ intelligence: { evaluate } as IntelligenceProvider });
    const r = await n.narrate(input);
    expect(r.source).toBe('model');
    expect(r.text).toBe('The disk is nearly full.');
    expect(r.author.model.value).toBe('gpt-x');
    const opts = evaluate.mock.calls[0][1];
    expect(opts.attribution).toMatchObject({ component: 'JobAnomalyNarrator', jobSlug: 'health-check', machineId: 'm1', episodeId: 'ep1' });
    expect(opts.timeoutMs).toBe(15_000);
  });

  it.each([
    ['error', async () => { throw new Error('boom'); }, 'provider-error'],
    ['empty', async () => '   ', 'empty-reply'],
  ])('falls back to the fixed sentence on %s', async (_n, impl, why) => {
    const n = new JobAnomalyNarrator({ intelligence: { evaluate: impl } as unknown as IntelligenceProvider });
    const r = await n.narrate(input);
    expect(r.source).toBe('fallback');
    expect(r.fallbackReason).toBe(why);
    expect(r.text).toBe('Health Check on the mini: disk-critical.');
    expect(r.author.model.status).toBe('not-applicable');
  });

  it('falls back on timeout and with no provider', async () => {
    const slow = new JobAnomalyNarrator({ intelligence: { evaluate: () => new Promise<string>(() => {}) }, timeoutMs: 20 });
    expect((await slow.narrate(input)).fallbackReason).toBe('timeout');
    const none = new JobAnomalyNarrator({ intelligence: null });
    expect((await none.narrate(input)).fallbackReason).toBe('no-provider');
  });

  it('audit-only mode is bound to a runId and writes an audit row', async () => {
    const rows: any[] = [];
    const n = new JobAnomalyNarrator({ intelligence: null, audit: { append: (r) => rows.push(r) } });
    await n.narrate(input, { auditOnlyRunId: 'run-9' });
    expect(rows).toEqual([expect.objectContaining({ kind: 'narration-audit-only', runId: 'run-9', reasons: ['disk-critical'] })]);
    await n.narrate(input);
    expect(rows).toHaveLength(1);
  });

  it('evidence block is verbatim, capped at 20 × 300 with an overflow line', () => {
    const s = ['messaging.toneGate.enabled fell back: x'];
    expect(renderEvidenceBlock(s)).toBe('- messaging.toneGate.enabled fell back: x');
    const many = Array.from({ length: 23 }, (_, i) => `s${i} ` + 'z'.repeat(400));
    const out = renderEvidenceBlock(many).split('\n');
    expect(out).toHaveLength(21);
    expect(out[20]).toBe('- and 3 more: see the Jobs tab');
    expect(out[0].length).toBeLessThanOrEqual(302);
    expect(fallbackSentence('J', 'M', ['a', 'b'])).toBe('J on M: a, b.');
  });
});
