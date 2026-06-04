/**
 * McpProcessReaper — Option B of the MCP-leak fix. THE safety requirement under
 * test: NEVER reap an MCP proc whose owning session is live/tracked, and NEVER
 * touch a proc under an external (non-instar) tmux session. A proc is reap-
 * eligible ONLY when old AND (its owning instar session is dead/stale OR it is
 * fully orphaned). Covers both sides of every boundary + dry-run + the cap.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  McpProcessReaper,
  resolveOwningSession,
  classifyMcpProcess,
  type McpProcessReaperDeps,
  type McpProcessInfo,
} from '../../src/monitoring/McpProcessReaper.js';
import { matchMcpSignature, MCP_PROCESS_SIGNATURES } from '../../src/monitoring/mcpProcessSignatures.js';

const NOW = 1_000_000_000_000;
const OLD = 3 * 3600 * 1000; // > default minAgeMs (2h)
const YOUNG = 5 * 60 * 1000; // < minAgeMs

function proc(over: Partial<McpProcessInfo> = {}): McpProcessInfo {
  return { pid: 100, ppid: 50, elapsedMs: OLD, command: 'node playwright-mcp', signatureId: 'playwright-mcp', ...over };
}

function deps(over: Partial<McpProcessReaperDeps> = {}): McpProcessReaperDeps {
  return {
    listMcpProcesses: () => [],
    getProcessTree: () => new Map(),
    getTmuxPaneMap: () => new Map(),
    getLiveSessions: () => new Set(),
    getInstarSessions: () => new Set(),
    killProcess: vi.fn(),
    now: () => NOW,
    ...over,
  };
}

describe('matchMcpSignature', () => {
  it('matches each allow-listed signature', () => {
    expect(matchMcpSignature('npm exec @playwright/mcp@latest')?.id).toBe('playwright-mcp');
    expect(matchMcpSignature('node mcp-remote https://api.fathom.ai/mcp')?.id).toBe('mcp-remote');
    expect(matchMcpSignature('node /x/dist/mcp/mcp-stdio-entry.js')?.id).toBe('instar-mcp-stdio');
  });
  it('does NOT match an unrelated node/npm process (no broad match)', () => {
    expect(matchMcpSignature('node /usr/local/bin/instar server start')).toBeNull();
    expect(matchMcpSignature('npm run build')).toBeNull();
    expect(matchMcpSignature('node some-app.js')).toBeNull();
    expect(matchMcpSignature('')).toBeNull();
  });
  it('keeps the allow-list to exactly the three known MCP shapes', () => {
    expect(MCP_PROCESS_SIGNATURES.map((s) => s.id).sort()).toEqual(['instar-mcp-stdio', 'mcp-remote', 'playwright-mcp']);
  });
});

describe('resolveOwningSession', () => {
  it('resolves via the proc pid directly being a pane pid', () => {
    const tmux = new Map([[100, 'echo-topic-5']]);
    expect(resolveOwningSession(100, new Map(), tmux, 30)).toBe('echo-topic-5');
  });
  it('walks the ppid chain to a tmux pane ancestor', () => {
    // 100(mcp) -> 50(npm) -> 40(claude) -> 30(shell=pane)
    const tree = new Map([[100, 50], [50, 40], [40, 30]]);
    const tmux = new Map([[30, 'echo-topic-9']]);
    expect(resolveOwningSession(100, tree, tmux, 30)).toBe('echo-topic-9');
  });
  it('returns null when no tmux ancestor exists (orphaned/re-parented)', () => {
    const tree = new Map([[100, 50], [50, 1]]); // re-parented to launchd
    expect(resolveOwningSession(100, tree, new Map(), 30)).toBeNull();
  });
  it('is cycle-safe and bounded by maxHops', () => {
    const tree = new Map([[100, 50], [50, 100]]); // cycle
    expect(resolveOwningSession(100, tree, new Map(), 30)).toBeNull();
    const deep = new Map<number, number>();
    for (let i = 0; i < 100; i++) deep.set(i, i + 1);
    expect(resolveOwningSession(0, deep, new Map([[99, 's']]), 5)).toBeNull(); // hop-capped before reaching 99
  });
});

describe('classifyMcpProcess (both sides of every boundary)', () => {
  const live = new Set(['echo-live']);
  const instar = new Set(['echo-live', 'echo-stale']);
  const MIN = 2 * 3600 * 1000;

  it('KEEPS a proc under a live/tracked session regardless of age', () => {
    const e = classifyMcpProcess(proc({ elapsedMs: 10 * 24 * 3600 * 1000 }), 'echo-live', live, instar, MIN);
    expect(e.verdict).toBe('keep');
    expect(e.reason).toBe('session-live');
  });
  it('KEEPS a proc under an external (non-instar) session even when old', () => {
    const e = classifyMcpProcess(proc({ elapsedMs: OLD }), 'user-tmux', live, instar, MIN);
    expect(e.verdict).toBe('keep');
    expect(e.reason).toBe('external-session');
  });
  it('REAPS a proc under a stale/dead instar session when old', () => {
    const e = classifyMcpProcess(proc({ elapsedMs: OLD }), 'echo-stale', live, instar, MIN);
    expect(e.verdict).toBe('reap-eligible');
    expect(e.reason).toContain('stale-instar-session:echo-stale');
  });
  it('KEEPS a stale-instar proc that is too young', () => {
    const e = classifyMcpProcess(proc({ elapsedMs: YOUNG }), 'echo-stale', live, instar, MIN);
    expect(e.verdict).toBe('keep');
    expect(e.reason).toBe('stale-instar-too-young');
  });
  it('REAPS a fully orphaned proc (no owning session) when old', () => {
    const e = classifyMcpProcess(proc({ elapsedMs: OLD }), null, live, instar, MIN);
    expect(e.verdict).toBe('reap-eligible');
    expect(e.reason).toBe('orphaned-no-session');
  });
  it('KEEPS an orphaned proc that is too young', () => {
    const e = classifyMcpProcess(proc({ elapsedMs: YOUNG }), null, live, instar, MIN);
    expect(e.verdict).toBe('keep');
    expect(e.reason).toBe('orphan-too-young');
  });
});

describe('McpProcessReaper.reap()', () => {
  // 100 = orphaned old playwright (reapable); 200 = under live session (sacred)
  const procs: McpProcessInfo[] = [
    proc({ pid: 100, ppid: 1, elapsedMs: OLD }),
    proc({ pid: 200, ppid: 30, elapsedMs: OLD, signatureId: 'mcp-remote' }),
  ];
  const tree = new Map([[100, 1], [200, 30]]);
  const tmux = new Map([[30, 'echo-live']]);
  const base = () => deps({
    listMcpProcesses: () => procs,
    getProcessTree: () => tree,
    getTmuxPaneMap: () => tmux,
    getLiveSessions: () => new Set(['echo-live']),
    getInstarSessions: () => new Set(['echo-live']),
  });

  it('DRY-RUN (default): classifies, audits would-reap, kills nothing', async () => {
    const kill = vi.fn();
    const audit = vi.fn();
    const r = new McpProcessReaper(base(), { enabled: true, dryRun: true });
    // override kill+audit
    (r as any).deps.killProcess = kill;
    (r as any).deps.audit = audit;
    const res = await r.reap();
    expect(kill).not.toHaveBeenCalled();
    expect(res.reaped).toEqual([]);
    expect(res.dryRun).toBe(true);
    expect(audit.mock.calls.some(([e]) => e.type === 'would-reap' && e.pid === 100)).toBe(true);
  });

  it('ENABLED + not dry-run: reaps the orphaned proc, NEVER the live-session one', async () => {
    const kill = vi.fn();
    const d = base();
    d.killProcess = kill;
    const r = new McpProcessReaper(d, { enabled: true, dryRun: false });
    const res = await r.reap();
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(100);
    expect(kill).not.toHaveBeenCalledWith(200); // sacred live session
    expect(res.reaped).toEqual([100]);
  });

  it('respects maxReapsPerPass', async () => {
    const many = Array.from({ length: 5 }, (_, i) => proc({ pid: 1000 + i, ppid: 1, elapsedMs: OLD }));
    const kill = vi.fn();
    const d = deps({ listMcpProcesses: () => many, killProcess: kill });
    const r = new McpProcessReaper(d, { enabled: true, dryRun: false, maxReapsPerPass: 2 });
    const res = await r.reap();
    expect(res.reaped.length).toBe(2);
    expect(kill).toHaveBeenCalledTimes(2);
  });

  it('DISABLED reaper kills nothing even with reap-eligible procs', async () => {
    const kill = vi.fn();
    const d = base();
    d.killProcess = kill;
    const r = new McpProcessReaper(d, { enabled: false, dryRun: false });
    const res = await r.reap();
    expect(kill).not.toHaveBeenCalled();
    expect(res.dryRun).toBe(true); // killsEnabled false ⇒ dryRun-reported
  });

  it('snapshot() reports reapEligible count without side effects', () => {
    const kill = vi.fn();
    const d = base();
    d.killProcess = kill;
    const r = new McpProcessReaper(d, { enabled: true, dryRun: true });
    const snap = r.snapshot();
    expect(snap.reapEligible).toBe(1); // only pid 100
    expect(kill).not.toHaveBeenCalled();
  });
});
