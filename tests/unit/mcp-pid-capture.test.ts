/**
 * mcpPidCapture — the offload capture-then-reap pid resolver (C1). Verifies it
 * captures only the heavy procs of the TARGET session + server, and is
 * conservative (unknown/non-heavy server, wrong session ⇒ no pid).
 */
import { describe, it, expect } from 'vitest';
import { captureHeavyMcpPidsForSession, MCP_SERVER_NAME_TO_SIGNATURE } from '../../src/core/mcpPidCapture.js';
import type { McpProcessInfo } from '../../src/monitoring/McpProcessReaper.js';

const proc = (pid: number, ppid: number, signatureId: McpProcessInfo['signatureId']): McpProcessInfo =>
  ({ pid, ppid, command: `${signatureId} cmd`, signatureId } as McpProcessInfo);

// A simple topology: pane pid 100 = session "echo-5"; pane pid 200 = session "echo-9".
const paneMap = new Map<number, string>([[100, 'echo-5'], [200, 'echo-9']]);
// tree: 4242 -> 100 (under echo-5); 4243 -> 200 (under echo-9); 4244 -> 999 (orphan).
const tree = new Map<number, number>([[4242, 100], [4243, 200], [4244, 999]]);

describe('captureHeavyMcpPidsForSession', () => {
  it('captures the heavy (playwright) pid under the target session only', () => {
    const procs = [proc(4242, 100, 'playwright-mcp'), proc(4243, 200, 'playwright-mcp')];
    const pids = captureHeavyMcpPidsForSession({ sessionName: 'echo-5', server: 'playwright', procs, tree, paneMap, maxHops: 10 });
    expect(pids).toEqual([4242]); // not 4243 (that's echo-9)
  });

  it('captures nothing for an unknown server (no heavy signature mapping)', () => {
    const procs = [proc(4242, 100, 'playwright-mcp')];
    expect(captureHeavyMcpPidsForSession({ sessionName: 'echo-5', server: 'unknown-server', procs, tree, paneMap, maxHops: 10 })).toEqual([]);
  });

  it('captures nothing for a LIGHT signature server (never offloaded)', () => {
    // threadline is not in the server→signature map ⇒ no capture (conservative).
    const procs = [proc(4242, 100, 'instar-mcp-stdio')];
    expect(captureHeavyMcpPidsForSession({ sessionName: 'echo-5', server: 'threadline', procs, tree, paneMap, maxHops: 10 })).toEqual([]);
  });

  it('captures nothing when the proc resolves to a DIFFERENT session', () => {
    const procs = [proc(4243, 200, 'playwright-mcp')]; // under echo-9
    expect(captureHeavyMcpPidsForSession({ sessionName: 'echo-5', server: 'playwright', procs, tree, paneMap, maxHops: 10 })).toEqual([]);
  });

  it('captures nothing for an orphan proc (owning session unresolvable)', () => {
    const procs = [proc(4244, 999, 'playwright-mcp')];
    expect(captureHeavyMcpPidsForSession({ sessionName: 'echo-5', server: 'playwright', procs, tree, paneMap, maxHops: 10 })).toEqual([]);
  });

  it('captures MULTIPLE heavy pids under the same session', () => {
    const tree2 = new Map([[4242, 100], [5555, 100]]);
    const procs = [proc(4242, 100, 'playwright-mcp'), proc(5555, 100, 'playwright-mcp')];
    const pids = captureHeavyMcpPidsForSession({ sessionName: 'echo-5', server: 'playwright', procs, tree: tree2, paneMap, maxHops: 10 });
    expect(new Set(pids)).toEqual(new Set([4242, 5555]));
  });

  it('the server→signature map is conservative (playwright mapped; light bridges absent)', () => {
    expect(MCP_SERVER_NAME_TO_SIGNATURE.playwright).toBe('playwright-mcp');
    expect(MCP_SERVER_NAME_TO_SIGNATURE.threadline).toBeUndefined();
  });
});
