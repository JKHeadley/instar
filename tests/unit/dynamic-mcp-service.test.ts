/**
 * DynamicMcpService — the composition root. Exercised against a real temp
 * projectDir + .mcp.json + loaded-set store, with the host primitives (restart,
 * preapproval, pid capture/reap, mid-tool-use) faked. Verifies the end-to-end
 * load/offload/state flow the routes will call.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { DynamicMcpService, type DynamicMcpServicePrimitives } from '../../src/core/DynamicMcpService.js';

const MCP_JSON = { mcpServers: { playwright: { command: 'npx' }, threadline: { command: 'node' } } };

describe('DynamicMcpService', () => {
  let dir: string;
  let restarts: number;
  let reaped: number[][];

  const make = (over: Partial<DynamicMcpServicePrimitives> = {}): DynamicMcpService => {
    const p: DynamicMcpServicePrimitives = {
      projectDir: dir,
      enabled: () => true,
      config: () => ({ enabled: true, keepWarm: ['threadline'] }),
      restart: async () => { restarts++; return { ok: true }; },
      isPreapproved: () => true,
      captureHeavyPids: () => [4242],
      reapPids: (pids) => { reaped.push(pids); },
      isMidToolUse: () => false,
      ...over,
    };
    return new DynamicMcpService(p);
  };

  const committedOf = (topic: number): string[] | null => {
    const f = path.join(dir, '.instar', 'state', 'mcp-loaded', `${topic}.json`);
    if (!fs.existsSync(f)) return null;
    const r = JSON.parse(fs.readFileSync(f, 'utf-8'));
    return r.committed ? r.servers : null;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-dynsvc-'));
    fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify(MCP_JSON));
    restarts = 0; reaped = [];
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/dynamic-mcp-service.test.ts' });
  });

  it('getSessionState reports the lean baseline + preapproved when no committed state', () => {
    const st = make().getSessionState(5);
    expect(st).toMatchObject({ topicId: 5, servers: ['threadline'], preapproved: true, source: 'baseline' });
  });

  it('requestLoad (preapproved) loads the server, restarts, and commits the new set', async () => {
    const svc = make();
    const r = await svc.requestLoad(5, 'playwright', { kind: 'agent' });
    expect(r.status).toBe('applied');
    expect(restarts).toBe(1);
    expect(new Set(committedOf(5))).toEqual(new Set(['threadline', 'playwright']));
    // getSessionState now reflects the committed set
    expect(new Set(svc.getSessionState(5).servers)).toEqual(new Set(['threadline', 'playwright']));
  });

  it('requestLoad (NOT preapproved) ⇒ needs-approval, no restart; the minted nonce then authorizes', async () => {
    const svc = make({ isPreapproved: () => false });
    const r1 = await svc.requestLoad(5, 'playwright', { kind: 'agent' });
    expect(r1.status).toBe('needs-approval');
    expect(restarts).toBe(0);
    const nonce = (r1 as { nonce: string }).nonce;
    const r2 = await svc.requestLoad(5, 'playwright', { kind: 'operator-approved', nonce });
    expect(r2.status).toBe('applied');
    expect(restarts).toBe(1);
  });

  it('a stale/forged nonce never authorizes', async () => {
    const svc = make({ isPreapproved: () => false });
    await svc.requestLoad(5, 'playwright', { kind: 'agent' });
    const r = await svc.requestLoad(5, 'playwright', { kind: 'operator-approved', nonce: 'forged' });
    expect(r.status).toBe('needs-approval');
    expect(restarts).toBe(0);
  });

  it('requestOffload (preapproved, not mid-tool-use) drops the server, restarts, reaps the captured pids', async () => {
    const svc = make();
    // first load playwright so there is something to offload
    await svc.requestLoad(5, 'playwright', { kind: 'agent' });
    const r = await svc.requestOffload(5, 'playwright', { kind: 'agent' });
    expect(r.status).toBe('applied');
    expect(committedOf(5)).toEqual(['threadline']);
    expect(reaped).toEqual([[4242]]);
  });

  it('requestOffload aborts (no restart) when mid-tool-use is unknown', async () => {
    const svc = make({ isMidToolUse: () => null });
    await svc.requestLoad(5, 'playwright', { kind: 'agent' });
    const before = restarts;
    const r = await svc.requestOffload(5, 'playwright', { kind: 'agent' });
    expect(r).toEqual({ status: 'aborted', reason: 'mid-tool-use' });
    expect(restarts).toBe(before);
    expect(reaped).toHaveLength(0);
  });

  it('a failed restart leaves the committed set unchanged (two-phase rollback)', async () => {
    const svc = make({ restart: async () => ({ ok: false, code: 'rate_limited' }) });
    // seed a committed baseline first via a state read
    expect(svc.getSessionState(5).servers).toEqual(['threadline']);
    const r = await svc.requestLoad(5, 'playwright', { kind: 'agent' });
    expect(r).toEqual({ status: 'restart-failed', code: 'rate_limited' });
    // committed set is still the baseline (rollback), playwright NOT persisted as committed
    expect(committedOf(5)).toEqual(['threadline']);
  });

  // The default-standard "thorough scenario" (operator mandate): a feature must be
  // proven to BOTH load on demand AND offload when the work is done — as one
  // continuous flow over the real service state, not just isolated operations. This
  // is the deterministic, runs-in-CI complement to the live-as-self Playwright proof
  // (which drives the same flow through a real session). See
  // docs/specs/DYNAMIC-MCP-LIFECYCLE-SPEC.md and the live harness in
  // docs/dynamic-mcp-live-as-self-harness.md.
  it('FULL LIFECYCLE: lean baseline → load on demand → offload when done → back to lean', async () => {
    const captured = [9001, 9002];
    const svc = make({ captureHeavyPids: () => captured });
    const TOPIC = 42;

    // 1) starts LEAN — only the keep-warm baseline, no heavy server, no restart yet.
    expect(svc.getSessionState(TOPIC)).toMatchObject({ servers: ['threadline'], source: 'baseline' });
    expect(restarts).toBe(0);

    // 2) LOADS ON DEMAND — the heavy server is added and the session restarts once.
    const load = await svc.requestLoad(TOPIC, 'playwright', { kind: 'agent' });
    expect(load.status).toBe('applied');
    expect(restarts).toBe(1);
    const afterLoad = svc.getSessionState(TOPIC);
    expect(new Set(afterLoad.servers)).toEqual(new Set(['threadline', 'playwright']));
    expect(afterLoad.source).toBe('committed'); // the load is durably committed, survives a re-read
    expect(reaped).toHaveLength(0);              // nothing reaped on a load

    // 3) OFFLOADS WHEN DONE — the heavy server is dropped, the session restarts again,
    //    and the heavy child processes captured-before-kill are actually reaped (C1:
    //    they reparent to launchd, so the offload must clean them up explicitly).
    const offload = await svc.requestOffload(TOPIC, 'playwright', { kind: 'agent' });
    expect(offload.status).toBe('applied');
    expect(restarts).toBe(2);
    expect(reaped).toEqual([captured]); // the leaked browser children are reclaimed

    // 4) BACK TO LEAN — the committed set is the keep-warm baseline again; a fresh
    //    read sees no heavy server. The machine reclaimed the footprint it borrowed.
    const afterOffload = svc.getSessionState(TOPIC);
    expect(afterOffload.servers).toEqual(['threadline']);
    expect(committedOf(TOPIC)).toEqual(['threadline']);
  });
});
