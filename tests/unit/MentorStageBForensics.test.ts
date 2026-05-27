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
  it('bounds the signals length', () => {
    const p = buildForensicPrompt('x', 'a'.repeat(20000));
    expect(p.length).toBeLessThan(13000);
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
