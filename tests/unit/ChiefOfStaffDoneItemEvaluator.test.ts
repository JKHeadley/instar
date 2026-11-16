/**
 * Chief of Staff deterministic done-item evaluators (docs/specs/chief-of-staff-topic.md §1.3):
 * `page <url> contains "<text>"` in a linked domain and `PR owner/repo#N merged` in a linked repo.
 * Both sides of each decision: pass, fail, and every unreadable or unlinked case reads `unknown`,
 * which can never certify done (P20).
 */
import { describe, it, expect } from 'vitest';
import { buildDoneItemEvaluator, type DoneItemEvaluatorDeps, type GhExec } from '../../src/core/ChiefOfStaffEvidence.js';
import type { BoundProject } from '../../src/core/ChiefOfStaffLoop.js';

const project: BoundProject = {
  conversationKey: 'telegram:141876', goal: 'Fix it',
  doneDefinition: [],
  checkCadenceHours: 24, linked: { repos: ['JKHeadley/instar'], branches: [], domains: ['example.com'] },
  binding: { conversationKey: 'telegram:141876', binding: {}, bindingHlc: { physical: 1, logical: 0, node: 'm' }, confirmed: true, closed: false, lastUnparkAt: null },
};

function pullsGh(rows: Record<string, { merged_at: string | null; state: string; base: string } | 'error'>): GhExec & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = (async (args: string[]) => {
    calls.push(args);
    const m = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(args[1] ?? '');
    const row = m ? rows[m[2]!] : undefined;
    if (!row || row === 'error') return { code: 1, stdout: '', stderr: 'not found' };
    return { code: 0, stdout: JSON.stringify(row), stderr: '' };
  }) as GhExec & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

function evaluator(over: Partial<DoneItemEvaluatorDeps> = {}) {
  return buildDoneItemEvaluator({
    gh: pullsGh({
      '100': { merged_at: '2026-11-15T10:00:00Z', state: 'closed', base: 'main' },
      '101': { merged_at: null, state: 'open', base: 'main' },
      '102': { merged_at: null, state: 'closed', base: 'main' },
      '103': { merged_at: '2026-11-15T10:00:00Z', state: 'closed', base: 'release' },
      '104': 'error',
    }),
    defaultBranch: async () => 'main',
    fetchPage: async () => 'the release is shipped',
    ...over,
  });
}
const item = (text: string) => ({ id: 'x', kind: 'deterministic', text });

describe('PR-merged done items', () => {
  it('passes when the PR merged into the default branch of a linked repo', async () => {
    expect(await evaluator()(item('PR JKHeadley/instar#100 merged'), project)).toBe('pass');
  });
  it('matches the repo case-insensitively and inside a longer sentence', async () => {
    expect(await evaluator()(item('The fix, PR jkheadley/INSTAR#100 merged, is in.'), project)).toBe('pass');
  });
  it('fails while the PR is open, or closed without merging', async () => {
    expect(await evaluator()(item('PR JKHeadley/instar#101 merged'), project)).toBe('fail');
    expect(await evaluator()(item('PR JKHeadley/instar#102 merged'), project)).toBe('fail');
  });
  it('fails when it merged into a branch other than the default', async () => {
    expect(await evaluator()(item('PR JKHeadley/instar#103 merged'), project)).toBe('fail');
  });
  it('is unknown when GitHub cannot be read, or there is no GitHub runtime', async () => {
    expect(await evaluator()(item('PR JKHeadley/instar#104 merged'), project)).toBe('unknown');
    expect(await evaluator({ gh: null })(item('PR JKHeadley/instar#100 merged'), project)).toBe('unknown');
  });
  it('never reads a repo the owner did not link', async () => {
    const gh = pullsGh({ '100': { merged_at: '2026-11-15T10:00:00Z', state: 'closed', base: 'main' } });
    expect(await evaluator({ gh })(item('PR someone/else#100 merged'), project)).toBe('unknown');
    expect(gh.calls).toHaveLength(0);
  });
});

describe('page done items (unchanged behaviour)', () => {
  it('passes and fails on the assertion text in a linked domain', async () => {
    expect(await evaluator()(item('page https://docs.example.com/x contains "shipped"'), project)).toBe('pass');
    expect(await evaluator()(item('page https://docs.example.com/x contains "withdrawn"'), project)).toBe('fail');
  });
  it('is unknown for an unlinked domain or an unreadable page', async () => {
    expect(await evaluator()(item('page https://other.org/x contains "shipped"'), project)).toBe('unknown');
    expect(await evaluator({ fetchPage: async () => null })(item('page https://docs.example.com/x contains "shipped"'), project)).toBe('unknown');
  });
});

describe('prose done items', () => {
  it('stay unknown: plain words are not a deterministic check', async () => {
    expect(await evaluator()(item('The failures from the screenshot case are fixed and merged.'), project)).toBe('unknown');
  });
});
