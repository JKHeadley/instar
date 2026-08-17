import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const guardPath = process.env.STANDARDS_DIRECTION_GUARD_UNDER_TEST ??
  path.resolve(__dirname, '../../scripts/standards-direction-guard.mjs');
const guard = await import(/* @vite-ignore */ pathToFileURL(guardPath).href);

const baseRegistry = [
  '# Standards',
  '',
  '## The Root',
  '',
  '### Structure beats Willpower',
  '**Article ID.** `structure-beats-willpower`',
  '**Rule.** Enforce behavior in architecture.',
  '',
  '## Building',
  '',
  '### Honest Gap',
  '**Article ID.** `honest-gap`',
  '**Rule.** Preserve this obligation.',
  '',
].join('\n');

describe('standards direction guard behavioral contract', () => {
  it('passes a pristine non-vacuous registry', () => {
    const result = guard.evaluateStandardsDirection({
      baseMarkdown: baseRegistry,
      candidateMarkdown: baseRegistry,
      baseRevision: 'contract-base',
    });
    expect(result.status).toBe('passed');
    expect(result.errors).toEqual([]);
    expect(result.population.continuity).toBe(2);
  });

  it('refuses and names a real removal without shrinking continuity', () => {
    const candidate = baseRegistry.replace([
      '### Honest Gap',
      '**Article ID.** `honest-gap`',
      '**Rule.** Preserve this obligation.',
      '',
    ].join('\n'), '');
    expect(candidate).not.toContain('### Honest Gap');
    const result = guard.evaluateStandardsDirection({
      baseMarkdown: baseRegistry,
      candidateMarkdown: candidate,
      baseRevision: 'contract-base',
    });
    expect(result.status).toBe('not-proven');
    expect(result.errors.join('\n')).toContain('REMOVAL "Honest Gap"');
    expect(result.population).toEqual(expect.objectContaining({
      protectedBase: 2,
      candidate: 1,
      continuity: 2,
    }));
  });

  it('refuses an empty candidate rather than passing 0/0', () => {
    const result = guard.evaluateStandardsDirection({
      baseMarkdown: baseRegistry,
      candidateMarkdown: '# Standards\n',
      baseRevision: 'contract-base',
    });
    expect(result.status).toBe('not-proven');
    expect(result.errors.join('\n')).toContain('standards article population is empty');
  });
});
