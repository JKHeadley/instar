/**
 * Chief of Staff evidence gather + judge (docs/specs/chief-of-staff-topic.md §2.2, §2.5) with faked
 * seams: unreadable sources become `unknown` items (never absence), PR listings are shared per repo
 * per tick, generated files are excluded from the net diff, the conversation tail is bounded and
 * marked untrusted, the judge prompt discloses the bound and the judge output parser accepts only the
 * closed verdict set; a refused budget or a throwing provider yields null (the loop then says unknown).
 */
import { describe, it, expect } from 'vitest';
import { buildGather, buildJudge, buildJudgePrompt, parseJudgeOutput, type GatherDeps, type JudgeDeps } from '../../src/core/ChiefOfStaffEvidence.js';
import type { BoundProject, JudgeInput } from '../../src/core/ChiefOfStaffLoop.js';

const project: BoundProject = {
  conversationKey: 'telegram:141014', goal: 'Ship it',
  doneDefinition: [{ id: 'pr', kind: 'deterministic', text: 'page https://docs.example.com/x contains "shipped"' }, { id: 'ok', kind: 'judgment', text: 'Owner happy' }],
  checkCadenceHours: 24, linked: { repos: ['o/r'], branches: ['feat'], domains: ['example.com'] },
  binding: { conversationKey: 'telegram:141014', binding: {}, bindingHlc: { physical: 1, logical: 0, node: 'm' }, confirmed: true, closed: false, lastUnparkAt: null },
};

function deps(over: Partial<GatherDeps> = {}): GatherDeps & { ghCalls: string[][] } {
  const ghCalls: string[][] = [];
  const d: GatherDeps & { ghCalls: string[][] } = {
    ghCalls,
    now: () => Date.parse('2026-11-10T08:00:00Z'),
    gh: async (args) => {
      ghCalls.push(args);
      if (args[0] === 'pr') return { code: 0, stdout: JSON.stringify([{ number: 1, mergedAt: '2026-11-10T01:00:00Z' }, { number: 2, mergedAt: '2026-11-01T01:00:00Z' }]), stderr: '' };
      if (args[0] === 'api' && args[1].includes('/compare/')) return { code: 0, stdout: JSON.stringify([{ filename: 'src/a.ts', additions: 10, deletions: 5 }, { filename: 'dist/bundle.js', additions: 900, deletions: 0 }, { filename: 'pnpm-lock.yaml', additions: 50, deletions: 50 }]), stderr: '' };
      return { code: 1, stdout: '', stderr: 'nope' };
    },
    prCache: new Map(),
    runState: () => ({ state: 'none' }),
    reconcilerCondition: () => 'healthy',
    liveSession: () => false,
    overdueCommitments: () => 0,
    topicHistory: () => [
      { at: '2026-11-10T07:00:00Z', fromUser: false, fromOwner: false, text: 'agent: pushed a fix' },
      { at: '2026-11-10T06:00:00Z', fromUser: true, fromOwner: true, text: 'owner: keep going' },
    ],
    evaluateDoneItem: async (item) => (item.id === 'pr' ? 'fail' : 'unknown'),
    probeTimeoutMs: 1000, tailBoundBytes: 200,
    defaultBranch: async () => 'main',
    ...over,
  };
  return d;
}

describe('buildGather', () => {
  it('reads PRs since the last check, the net diff without generated files, done items, run/session/commitments and the conversation timestamps', async () => {
    const d = deps();
    const b = await buildGather(d)(project, { lastCheckAt: '2026-11-05T00:00:00Z' } as never);
    expect(b.mergedPrsSinceLastCheck).toBe(1); // the Nov 1 merge is before the last check
    expect(b.netDiffLines).toBe(15); // dist/ and the lockfile are excluded
    expect(b.doneItems).toEqual({ pr: 'fail' });
    expect(b.lastOwnerMessageAt).toBe('2026-11-10T06:00:00Z'); expect(b.lastAgentMessageAt).toBe('2026-11-10T07:00:00Z');
    expect(b.items.find((i) => i.id === 'tail')?.conversation).toBe(true);
    expect(b.items.filter((i) => i.unknown)).toHaveLength(0);
  });
  it('shares one PR listing and one compare per repo per tick (the prCache)', async () => {
    const d = deps(); const g = buildGather(d);
    await g(project, null); await g({ ...project, conversationKey: 'telegram:2' }, null);
    expect(d.ghCalls.filter((a) => a[0] === 'pr')).toHaveLength(1);
    expect(d.ghCalls.filter((a) => a[0] === 'api' && a[1].includes('/compare/'))).toHaveLength(1);
  });
  it('an unreadable source is an unknown item, never a zero', async () => {
    const d = deps({ gh: null, topicHistory: () => null, runState: () => { throw new Error('registry down'); } });
    const b = await buildGather(d)(project, null);
    expect(b.mergedPrsSinceLastCheck).toBeNull(); expect(b.netDiffLines).toBeNull();
    expect(b.items.find((i) => i.id === 'prs:o/r')?.unknown).toBe(true);
    expect(b.items.find((i) => i.id === 'run')?.unknown).toBe(true);
    expect(b.items.find((i) => i.id === 'owner-last')?.unknown).toBe(true);
  });
  it('a gh failure or timeout reads as unknown', async () => {
    const d = deps({ gh: async () => ({ code: 1, stdout: '', stderr: 'rate limited' }) });
    const b = await buildGather(d)(project, null);
    expect(b.mergedPrsSinceLastCheck).toBeNull();
    const slow = deps({ gh: () => new Promise(() => {}), probeTimeoutMs: 20 });
    const b2 = await buildGather(slow)(project, null);
    expect(b2.netDiffLines).toBeNull();
  });
  it('the conversation tail is bounded by bytes, newest first', async () => {
    const d = deps({ tailBoundBytes: 60 });
    const b = await buildGather(d)(project, null);
    expect(b.conversationTail.length).toBeLessThanOrEqual(1);
  });
});

describe('judge prompt + parser', () => {
  const input: JudgeInput = { conversationKey: 'telegram:141014', goal: 'Ship it', doneDefinition: project.doneDefinition, tailBoundBytes: 300, bundle: { conversationKey: 'telegram:141014', items: [{ id: 'run', source: 'run', ageMs: 0, value: 'none', unknown: false }, { id: 'prs:o/r', source: 'prs', ageMs: null, value: null, unknown: true }], netDiffLines: 0, mergedPrsSinceLastCheck: null, doneItems: {}, liveSession: false, conversationTail: ['x'.repeat(5000)], lastOwnerMessageAt: null, lastAgentMessageAt: null, overdueCommitments: 0 } };
  it('the prompt discloses the bound, marks unknown reads, and wraps the tail as untrusted', () => {
    const p = buildJudgePrompt(input);
    expect(p).toContain('cut to 300 bytes'); expect(p).toContain('UNKNOWN (could not read)'); expect(p).toContain('untrusted quoted data');
    expect(p.length).toBeLessThan(3000); // the 5000-char tail was cut to the bound
  });
  it('parser accepts only the closed verdict set and bounds the citations', () => {
    expect(parseJudgeOutput('here you go {"verdict":"stalled","citedIds":["run"],"reason":"quiet"} thanks')).toEqual({ verdict: 'stalled', citedIds: ['run'], reason: 'quiet' });
    expect(parseJudgeOutput('{"verdict":"excellent","citedIds":[],"reason":"x"}')).toBeNull();
    expect(parseJudgeOutput('not json')).toBeNull();
    expect(parseJudgeOutput('{"verdict":"moving","citedIds":[1,2,"a"]}')!.citedIds).toEqual(['a']);
  });
});

describe('buildJudge', () => {
  const mk = (over: Partial<JudgeDeps> = {}): JudgeDeps & { calls: number } => {
    const d: JudgeDeps & { calls: number } = { calls: 0, enqueueMetered: async (req) => req.run(new AbortController().signal, () => {}), evaluate: async () => { d.calls++; return '{"verdict":"moving","citedIds":["run"],"reason":"pr opened"}'; }, judgeDailyCents: 15, ...over };
    return d;
  };
  const input: JudgeInput = { conversationKey: 'telegram:141014', goal: 'g', doneDefinition: [], tailBoundBytes: 300, bundle: { conversationKey: 'telegram:141014', items: [], netDiffLines: 0, mergedPrsSinceLastCheck: 0, doneItems: {}, liveSession: false, conversationTail: [], lastOwnerMessageAt: null, lastAgentMessageAt: null, overdueCommitments: 0 } };
  it('runs under the chief-of-staff component budget and parses the answer', async () => {
    let seen: { component?: string; daily?: { costCents?: number } } = {};
    const d = mk({ enqueueMetered: async (req) => { seen = req; return req.run(new AbortController().signal, () => {}); } });
    expect(await buildJudge(d)(input)).toEqual({ verdict: 'moving', citedIds: ['run'], reason: 'pr opened' });
    expect(seen.component).toBe('chief-of-staff'); expect(seen.daily?.costCents).toBe(15);
  });
  it('a refused budget or a throwing provider yields null (the loop then reads unknown)', async () => {
    expect(await buildJudge(mk({ enqueueMetered: async () => { throw new Error('component-budget'); } }))(input)).toBeNull();
    expect(await buildJudge(mk({ evaluate: async () => { throw new Error('provider down'); } }))(input)).toBeNull();
    expect(await buildJudge(mk({ evaluate: async () => 'garbage' }))(input)).toBeNull();
  });
});
