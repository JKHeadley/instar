/**
 * `instar dev:profile-node` — unit tests. The pure `aggregateHotFrames` (both
 * sides of the boundary) + `runDevProfileNode` orchestration with injected deps
 * (no real process/inspector/ws). Productizes the SIGUSR1+CDP technique used to
 * pin the StateManager.listSessions hot-loop.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  aggregateHotFrames,
  findInspectorTarget,
  runDevProfileNode,
  type CdpProfile,
  type ProfileNodeDeps,
  type ProfileNodeOutput,
} from '../../src/commands/devProfileNode.js';

function capture(): ProfileNodeOutput & { out: string; err: string } {
  const o = { out: '', err: '', write(t: string) { o.out += t; }, error(t: string) { o.err += t; } };
  return o;
}

// A profile dominated by one hot JS function (the listSessions-style case).
const HOT_PROFILE: CdpProfile = {
  nodes: [
    { callFrame: { functionName: '(idle)', url: '', lineNumber: 0 }, hitCount: 480 },
    { callFrame: { functionName: 'readFileUtf8', url: '', lineNumber: 0 }, hitCount: 300 },
    { callFrame: { functionName: 'listSessions', url: '/x/dist/core/StateManager.js', lineNumber: 150 }, hitCount: 70 },
    { callFrame: { functionName: 'readdir', url: '', lineNumber: 0 }, hitCount: 40 },
    { callFrame: { functionName: '', url: '/x/dist/core/Foo.js', lineNumber: 9 }, hitCount: 10 },
  ],
};

function mkDeps(over: Partial<ProfileNodeDeps> = {}): ProfileNodeDeps {
  return {
    signalUsr1: vi.fn(),
    fetchInspectorTarget: vi.fn(async (port: number) =>
      port === 9229 ? { webSocketDebuggerUrl: 'ws://127.0.0.1:9229/abc', title: 'inst' } : null),
    captureCpuProfile: vi.fn(async () => HOT_PROFILE),
    hottestNodePid: vi.fn(async () => 4242),
    sleep: vi.fn(async () => {}),
    ...over,
  };
}

describe('aggregateHotFrames (pure, both sides)', () => {
  it('ranks by self-time and normalizes the dist/src file:line', () => {
    const frames = aggregateHotFrames(HOT_PROFILE);
    expect(frames[0].label).toBe('(idle)');           // idle dominates the sample
    expect(frames[1].label).toBe('readFileUtf8');     // the real hot work is #2
    expect(frames[1].selfPct).toBeCloseTo(33.3, 0);   // 300 / (480+300+70+40+10=900)
    const ls = frames.find(f => f.label.startsWith('listSessions'));
    expect(ls?.label).toBe('listSessions  dist/core/StateManager.js:151'); // +1 line, path trimmed
  });

  it('falls back to (anonymous) for a nameless frame', () => {
    const anon = aggregateHotFrames(HOT_PROFILE).find(f => f.label.startsWith('(anonymous)'));
    expect(anon?.label).toBe('(anonymous)  dist/core/Foo.js:10');
  });

  it('empty profile → no frames (no divide-by-zero)', () => {
    expect(aggregateHotFrames({})).toEqual([]);
    expect(aggregateHotFrames({ nodes: [] })).toEqual([]);
  });

  it('respects the topN cap', () => {
    expect(aggregateHotFrames(HOT_PROFILE, 2)).toHaveLength(2);
  });
});

describe('findInspectorTarget', () => {
  it('returns the first port that has a ws target', async () => {
    const t = await findInspectorTarget(mkDeps());
    expect(t?.webSocketDebuggerUrl).toBe('ws://127.0.0.1:9229/abc');
  });
  it('returns null when no port has a target', async () => {
    const t = await findInspectorTarget(mkDeps({ fetchInspectorTarget: async () => null }));
    expect(t).toBeNull();
  });
});

describe('runDevProfileNode (orchestration, injected deps)', () => {
  it('happy path: signals the pid, profiles, prints hot frames, exit 0', async () => {
    const deps = mkDeps(); const out = capture();
    const code = await runDevProfileNode({ pid: '4242', deps, output: out });
    expect(code).toBe(0);
    expect(deps.signalUsr1).toHaveBeenCalledWith(4242);
    expect(out.out).toContain('readFileUtf8');
    expect(out.out).toContain('listSessions  dist/core/StateManager.js:151');
  });

  it('no pid → profiles the hottest node process', async () => {
    const deps = mkDeps(); const out = capture();
    const code = await runDevProfileNode({ deps, output: out });
    expect(code).toBe(0);
    expect(deps.hottestNodePid).toHaveBeenCalled();
    expect(deps.signalUsr1).toHaveBeenCalledWith(4242);
  });

  it('no node process found → exit 1', async () => {
    const deps = mkDeps({ hottestNodePid: async () => null }); const out = capture();
    expect(await runDevProfileNode({ deps, output: out })).toBe(1);
    expect(out.err).toContain('No running node process');
  });

  it('SIGUSR1 fails (pid gone) → exit 1', async () => {
    const deps = mkDeps({ signalUsr1: () => { throw new Error('ESRCH'); } }); const out = capture();
    expect(await runDevProfileNode({ pid: '99', deps, output: out })).toBe(1);
    expect(out.err).toContain('Could not signal');
  });

  it('no inspector target opened → exit 1', async () => {
    const deps = mkDeps({ fetchInspectorTarget: async () => null }); const out = capture();
    expect(await runDevProfileNode({ pid: '4242', deps, output: out })).toBe(1);
    expect(out.err).toContain('did not expose a node inspector');
  });

  it('profile capture throws → exit 1', async () => {
    const deps = mkDeps({ captureCpuProfile: async () => { throw new Error('ws closed'); } }); const out = capture();
    expect(await runDevProfileNode({ pid: '4242', deps, output: out })).toBe(1);
    expect(out.err).toContain('CPU profile failed');
  });
});
