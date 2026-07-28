/**
 * Tier-1 unit tests for MentorStageBForensics — the Stage-B "look under the hood"
 * analysis (FRAMEWORK-ONBOARDING-MENTOR-SPEC §3.2, §19.4).
 *
 * Defensive parsing is the load-bearing property: a bad LLM forensic read must
 * never crash a tick or poison the ledger with malformed/invented findings.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildForensicPrompt,
  parseForensicFindings,
  analyzeForensics,
} from '../../src/scheduler/MentorStageBForensics.js';

describe('buildForensicPrompt', () => {
  it('names the framework, the three buckets, and demands JSON-only output', () => {
    const p = buildForensicPrompt('codex-cli', 'some error log');
    expect(p).toContain('codex-cli');
    expect(p).toMatch(/framework-limitation/);
    expect(p).toMatch(/instar-integration-gap/);
    expect(p).toMatch(/generic-agent-mistake/);
    expect(p).toMatch(/JSON array/);
    expect(p).toContain('some error log');
  });
  it('bounds the signals length (slices to 12000 + a fixed preamble)', () => {
    const p = buildForensicPrompt('x', 'a'.repeat(20000));
    // Signals are capped at 12000; the preamble is a fixed ~1.5k of instructions.
    expect(p.length).toBeLessThan(14000);
    expect(p).not.toContain('a'.repeat(12001)); // the 20k signal was truncated
  });
});

describe('parseForensicFindings — defensive', () => {
  it('parses a clean JSON array into validated findings', () => {
    const raw = JSON.stringify([
      { bucket: 'framework-limitation', title: 'argv overflow on long thread', severity: 'high', dedupKey: 'argv-overflow' },
      { bucket: 'instar-integration-gap', title: 'hook not firing', severity: 'medium' },
    ]);
    const f = parseForensicFindings(raw, 'codex-cli');
    expect(f).toHaveLength(2);
    expect(f[0].bucket).toBe('framework-limitation');
    expect(f[0].dedupKey).toBe('codex-cli::argv-overflow');
    expect(f[1].dedupKey).toBe('codex-cli::hook-not-firing'); // derived from title
    expect(f[1].severity).toBe('medium');
  });

  it('tolerates markdown fences / surrounding prose', () => {
    const raw = 'Here are the issues:\n```json\n[{"bucket":"generic-agent-mistake","title":"typo in commit"}]\n```\nDone.';
    const f = parseForensicFindings(raw, 'codex-cli');
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('medium'); // default
  });

  it('drops entries with an invalid bucket or missing title', () => {
    const raw = JSON.stringify([
      { bucket: 'nonsense', title: 'x' },
      { bucket: 'framework-limitation' }, // no title
      { bucket: 'framework-limitation', title: 'valid one' },
    ]);
    const f = parseForensicFindings(raw, 'codex-cli');
    expect(f).toHaveLength(1);
    expect(f[0].title).toBe('valid one');
  });

  it('returns [] for non-JSON, non-array, or empty output (never throws)', () => {
    expect(parseForensicFindings('', 'x')).toEqual([]);
    expect(parseForensicFindings('the agent seems fine', 'x')).toEqual([]);
    expect(parseForensicFindings('{"not":"an array"}', 'x')).toEqual([]);
    expect(parseForensicFindings('[ broken json', 'x')).toEqual([]);
  });

  it('prefers the model-supplied stable dedupKey over the title', () => {
    const raw = JSON.stringify([{ bucket: 'instar-integration-gap', title: 'InputGuard LLM review times out at 8000ms under load', severity: 'medium', dedupKey: 'inputguard-review-timeout' }]);
    const f = parseForensicFindings(raw, 'codex-cli');
    expect(f[0].dedupKey).toBe('codex-cli::inputguard-review-timeout');
  });

  it('derives a STABLE fallback key — volatile tokens (numbers/versions/units) stripped so phrasing variants merge', () => {
    // Two phrasings of the SAME issue across ticks, both without a model dedupKey,
    // differing only in volatile tokens (timeout value, wording). They must collapse.
    const a = parseForensicFindings(JSON.stringify([{ bucket: 'instar-integration-gap', title: 'InputGuard review timeout at 8s' }]), 'codex-cli');
    const b = parseForensicFindings(JSON.stringify([{ bucket: 'instar-integration-gap', title: 'InputGuard review timeout at 8000ms' }]), 'codex-cli');
    expect(a[0].dedupKey).toBe(b[0].dedupKey); // volatile "8s"/"8000ms" stripped → same key
    expect(a[0].dedupKey).not.toMatch(/\d/); // no digits leaked into the key
  });

  it('strips version/percent/hex tokens from the derived fallback key', () => {
    const f = parseForensicFindings(JSON.stringify([{ bucket: 'framework-limitation', title: 'Process stale at v1.3.3 vs disk v1.3.14, session 019e681c, rate 42%' }]), 'codex-cli');
    expect(f[0].dedupKey).not.toMatch(/1-3-3|1-3-14|019e681c|42/);
    expect(f[0].dedupKey).toContain('process'); // stable symptom words kept
  });

  it('caps the number of findings per run', () => {
    const many = JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ bucket: 'framework-limitation', title: `issue ${i}` })));
    expect(parseForensicFindings(many, 'x').length).toBeLessThanOrEqual(10);
  });
});

describe('analyzeForensics', () => {
  it('returns [] without calling the LLM when there are no signals', async () => {
    const evaluate = vi.fn(async () => '[]');
    const f = await analyzeForensics({ framework: 'codex-cli', signals: '   ', evaluate });
    expect(f).toEqual([]);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('classifies real signals via the injected LLM', async () => {
    const evaluate = vi.fn(async () => '[{"bucket":"framework-limitation","title":"context truncated mid-task","severity":"high"}]');
    const f = await analyzeForensics({ framework: 'codex-cli', signals: 'ERROR: context window exceeded', evaluate });
    expect(evaluate).toHaveBeenCalledOnce();
    expect(f).toHaveLength(1);
    expect(f[0].bucket).toBe('framework-limitation');
    expect(f[0].severity).toBe('high');
  });

  it('returns [] (no crash) when the LLM call throws', async () => {
    const evaluate = vi.fn(async () => { throw new Error('LLM unavailable'); });
    const f = await analyzeForensics({ framework: 'codex-cli', signals: 'some signal', evaluate });
    expect(f).toEqual([]);
  });
});
