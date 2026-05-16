/**
 * Unit tests for TaskClassifier (Phase 5b.2).
 *
 * Verifies stable-slug emission, fallback on errors / malformed output,
 * task-payload formatting (tags, truncation), and fast-tier routing.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  TaskClassifier,
  UNCLASSIFIED_PATTERN,
} from '../../../../src/providers/uxConfirm/TaskClassifier.js';
import type { IntelligenceProvider } from '../../../../src/core/types.js';

function makeProvider(impl: IntelligenceProvider['evaluate']): IntelligenceProvider {
  return { evaluate: impl };
}

describe('TaskClassifier', () => {
  it('returns the LLM slug when it matches the strict pattern', async () => {
    const evaluate = vi.fn(async () => 'code-refactor-typescript');
    const c = new TaskClassifier({ intelligence: makeProvider(evaluate) });
    const result = await c.classify({ prompt: 'refactor X to use new transport' });
    expect(result.taskPattern).toBe('code-refactor-typescript');
    expect(result.source).toBe('ok');
  });

  it('strips wrapping whitespace, quotes, and a leading "slug:" prefix', async () => {
    const c = new TaskClassifier({
      intelligence: makeProvider(async () => '  "summarize-meeting-transcript"\n'),
    });
    const r1 = await c.classify({ prompt: 'summarize this' });
    expect(r1.taskPattern).toBe('summarize-meeting-transcript');

    const c2 = new TaskClassifier({
      intelligence: makeProvider(async () => 'slug: draft-email-followup'),
    });
    const r2 = await c2.classify({ prompt: 'draft' });
    expect(r2.taskPattern).toBe('draft-email-followup');
  });

  it('lowercases the slug', async () => {
    const c = new TaskClassifier({
      intelligence: makeProvider(async () => 'CODE-DEBUG-PYTHON'),
    });
    const r = await c.classify({ prompt: 'debug' });
    expect(r.taskPattern).toBe('code-debug-python');
  });

  it('returns fallback when slug contains illegal characters', async () => {
    const c = new TaskClassifier({
      intelligence: makeProvider(async () => 'code refactor typescript'), // spaces
    });
    const r = await c.classify({ prompt: 'refactor' });
    expect(r.taskPattern).toBe(UNCLASSIFIED_PATTERN);
    expect(r.source).toBe('fallback');
  });

  it('returns fallback when slug is too short', async () => {
    const c = new TaskClassifier({
      intelligence: makeProvider(async () => 'ab'),
    });
    const r = await c.classify({ prompt: 'whatever' });
    expect(r.source).toBe('fallback');
  });

  it('returns fallback when slug is too long', async () => {
    const longSlug = 'a-' + 'really-long-'.repeat(20);
    const c = new TaskClassifier({
      intelligence: makeProvider(async () => longSlug),
    });
    const r = await c.classify({ prompt: 'whatever' });
    expect(r.source).toBe('fallback');
  });

  it('returns fallback when LLM echoes the unclassified sentinel', async () => {
    const c = new TaskClassifier({
      intelligence: makeProvider(async () => UNCLASSIFIED_PATTERN),
    });
    const r = await c.classify({ prompt: 'whatever' });
    expect(r.source).toBe('fallback');
  });

  it('returns fallback when provider throws', async () => {
    const c = new TaskClassifier({
      intelligence: makeProvider(async () => {
        throw new Error('upstream down');
      }),
    });
    const r = await c.classify({ prompt: 'whatever' });
    expect(r.taskPattern).toBe(UNCLASSIFIED_PATTERN);
    expect(r.source).toBe('fallback');
  });

  it('routes to fast tier with a narrow token budget', async () => {
    const evaluate = vi.fn(async () => 'code-refactor-typescript');
    const c = new TaskClassifier({ intelligence: makeProvider(evaluate) });
    await c.classify({ prompt: 'refactor X' });
    const opts = evaluate.mock.calls[0]?.[1];
    expect(opts?.model).toBe('fast');
    expect(opts?.maxTokens).toBeLessThanOrEqual(32);
    expect(opts?.temperature).toBe(0);
  });

  it('embeds the task prompt in the prompt template', async () => {
    const evaluate = vi.fn(async () => 'x-y-z');
    const c = new TaskClassifier({ intelligence: makeProvider(evaluate) });
    await c.classify({ prompt: 'unique-test-marker-12345' });
    const prompt = evaluate.mock.calls[0]?.[0] as string;
    expect(prompt).toContain('unique-test-marker-12345');
  });

  it('appends tags when provided', async () => {
    const evaluate = vi.fn(async () => 'x-y-z');
    const c = new TaskClassifier({ intelligence: makeProvider(evaluate) });
    await c.classify({ prompt: 'task body', tags: ['code', 'agent-echo'] });
    const prompt = evaluate.mock.calls[0]?.[0] as string;
    expect(prompt).toContain('tags: code, agent-echo');
  });

  it('truncates very long prompts to keep classification cheap', async () => {
    const evaluate = vi.fn(async () => 'x-y-z');
    const c = new TaskClassifier({ intelligence: makeProvider(evaluate) });
    const long = 'A'.repeat(2000);
    await c.classify({ prompt: long });
    const prompt = evaluate.mock.calls[0]?.[0] as string;
    // After substitution, the truncated body + boilerplate should be well
    // under 2000 chars even with the template overhead.
    expect(prompt.length).toBeLessThan(2200);
    expect(prompt).toContain('…');
  });

  it('respects a custom prompt template', async () => {
    const evaluate = vi.fn(async () => 'custom-slug');
    const c = new TaskClassifier({
      intelligence: makeProvider(evaluate),
      promptTemplate: 'CUSTOM-{{TASK}}-END',
    });
    await c.classify({ prompt: 'inner' });
    const prompt = evaluate.mock.calls[0]?.[0] as string;
    expect(prompt).toBe('CUSTOM-inner-END');
  });
});
