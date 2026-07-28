/**
 * DynamicMcpManager — the load/offload driver orchestration, tested via injected
 * fake deps. Covers: no-op short-circuits, the verified-authorization gate (C4),
 * two-phase commit + rollback (M1/M3), offload capture-then-reap (C1), the
 * mid-tool-use abort (M3), and per-topic serialization (M2).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DynamicMcpManager,
  type DynamicMcpDeps,
  type RequestChangeResult,
} from '../../src/core/DynamicMcpManager.js';

interface Recorder {
  writes: Array<{ servers: string[]; committed: boolean; reason: string }>;
  restarts: number;
  reaped: number[][];
  captured: number;
  audits: Record<string, unknown>[];
}

function makeDeps(over: Partial<DynamicMcpDeps> = {}): { deps: DynamicMcpDeps; rec: Recorder } {
  const rec: Recorder = { writes: [], restarts: 0, reaped: [], captured: 0, audits: [] };
  const deps: DynamicMcpDeps = {
    currentServers: () => ['threadline'],
    allServerNames: () => ['playwright', 'threadline'],
    writeLoadedSet: (_t, servers, committed, reason) => { rec.writes.push({ servers, committed, reason }); },
    isPreapproved: () => true,
    mintNonce: () => 'NONCE-XYZ',
    consumeNonce: () => false,
    captureHeavyPids: () => { rec.captured++; return [4242]; },
    reapPids: (pids) => { rec.reaped.push(pids); },
    isMidToolUse: () => false,
    restartSession: async () => { rec.restarts++; return { ok: true }; },
    audit: (e) => { rec.audits.push(e); },
    ...over,
  };
  return { deps, rec };
}

describe('DynamicMcpManager.requestChange — no-op short-circuits (no restart)', () => {
  it('already-loaded ⇒ no-op, no restart, no write', async () => {
    const { deps, rec } = makeDeps({ currentServers: () => ['playwright', 'threadline'] });
    const r = await new DynamicMcpManager(deps).requestChange({ topicId: 1, op: 'load', server: 'playwright', actor: { kind: 'agent' } });
    expect(r).toEqual({ status: 'no-op', reason: 'already-loaded' });
    expect(rec.restarts).toBe(0);
    expect(rec.writes).toHaveLength(0);
  });

  it('not-loaded offload ⇒ no-op', async () => {
    const { deps, rec } = makeDeps({ currentServers: () => ['threadline'] });
    const r = await new DynamicMcpManager(deps).requestChange({ topicId: 1, op: 'offload', server: 'playwright', actor: { kind: 'agent' } });
    expect(r).toEqual({ status: 'no-op', reason: 'not-loaded' });
    expect(rec.restarts).toBe(0);
  });

  it('unknown-server load ⇒ no-op', async () => {
    const { deps } = makeDeps();
    const r = await new DynamicMcpManager(deps).requestChange({ topicId: 1, op: 'load', server: 'ghost', actor: { kind: 'agent' } });
    expect(r).toEqual({ status: 'no-op', reason: 'unknown-server' });
  });
});

describe('DynamicMcpManager — authorization gate (C4: verified, never trusted)', () => {
  it('not preapproved + agent actor ⇒ needs-approval (nonce minted, NO restart, NO state write)', async () => {
    const { deps, rec } = makeDeps({ isPreapproved: () => false });
    const r = await new DynamicMcpManager(deps).requestChange({ topicId: 1, op: 'load', server: 'playwright', actor: { kind: 'agent' } });
    expect(r.status).toBe('needs-approval');
    expect((r as Extract<RequestChangeResult, { status: 'needs-approval' }>).nonce).toBe('NONCE-XYZ');
    expect(rec.restarts).toBe(0);
    expect(rec.writes).toHaveLength(0);
  });

  it('preapproved ⇒ applied (no nonce needed)', async () => {
    const { deps, rec } = makeDeps({ isPreapproved: () => true });
    const r = await new DynamicMcpManager(deps).requestChange({ topicId: 1, op: 'load', server: 'playwright', actor: { kind: 'agent' } });
    expect(r.status).toBe('applied');
    expect(rec.restarts).toBe(1);
  });

  it('operator-approved with a VALID nonce ⇒ applied', async () => {
    const { deps, rec } = makeDeps({ isPreapproved: () => false, consumeNonce: () => true });
    const r = await new DynamicMcpManager(deps).requestChange({ topicId: 1, op: 'load', server: 'playwright', actor: { kind: 'operator-approved', nonce: 'NONCE-XYZ' } });
    expect(r.status).toBe('applied');
    expect(rec.restarts).toBe(1);
  });

  it('operator-approved with an INVALID nonce ⇒ needs-approval again (no restart)', async () => {
    const { deps, rec } = makeDeps({ isPreapproved: () => false, consumeNonce: () => false });
    const r = await new DynamicMcpManager(deps).requestChange({ topicId: 1, op: 'load', server: 'playwright', actor: { kind: 'operator-approved', nonce: 'WRONG' } });
    expect(r.status).toBe('needs-approval');
    expect(rec.restarts).toBe(0);
  });
});

describe('DynamicMcpManager — two-phase commit + rollback (M1/M3)', () => {
  it('applied: COMMITS the new set BEFORE the restart (so the respawn reads it), with NO post-restart commit', async () => {
    // Regression for the load-ordering bug (live-test 2026-06-27): the spawn builder reads
    // the COMMITTED loaded-set, so the new set must be committed BEFORE the restart. Pre-fix
    // wrote it un-committed first ([false, true] with restart between), so the load's own
    // respawn ignored it and spawned lean — load was a no-op on its own restart. This asserts
    // the committed=true write now precedes the restart.
    const order: string[] = [];
    const { deps, rec } = makeDeps({
      writeLoadedSet: (_t, servers, committed, reason) => { order.push(`write:${committed}`); rec.writes.push({ servers, committed, reason }); },
      restartSession: async () => { order.push('restart'); rec.restarts++; return { ok: true }; },
    });
    await new DynamicMcpManager(deps).requestChange({ topicId: 1, op: 'load', server: 'playwright', actor: { kind: 'agent' } });
    expect(order).toEqual(['write:true', 'restart']); // committed BEFORE the restart; no post-restart commit
    expect(rec.writes.map((w) => w.committed)).toEqual([true]);
    expect(rec.writes[0].servers.sort()).toEqual(['playwright', 'threadline']);
    expect(rec.restarts).toBe(1);
  });

  it('restart fails ⇒ restart-failed + rollback to the prior committed set (no phantom change)', async () => {
    const { deps, rec } = makeDeps({ restartSession: async () => ({ ok: false, code: 'rate_limited' }) });
    const r = await new DynamicMcpManager(deps).requestChange({ topicId: 1, op: 'load', server: 'playwright', actor: { kind: 'agent' } });
    expect(r).toEqual({ status: 'restart-failed', code: 'rate_limited' });
    // committed the new set, then a committed ROLLBACK to the ORIGINAL set. A failed restart
    // means no new session came up (restartSession ok ⟺ new session up), so the next spawn
    // reads the rolled-back prior set — no phantom change survives.
    expect(rec.writes[0]).toMatchObject({ committed: true });
    expect(rec.writes[0].servers.sort()).toEqual(['playwright', 'threadline']);
    const last = rec.writes[rec.writes.length - 1];
    expect(last).toMatchObject({ committed: true });
    expect(last.servers).toEqual(['threadline']); // rolled back to prior
  });

  it('restart not_telegram_bound ⇒ unsupported-unbound (no-op-ish, surfaced)', async () => {
    const { deps } = makeDeps({ restartSession: async () => ({ ok: false, code: 'not_telegram_bound' }) });
    const r = await new DynamicMcpManager(deps).requestChange({ topicId: 1, op: 'load', server: 'playwright', actor: { kind: 'agent' } });
    expect(r).toEqual({ status: 'unsupported-unbound' });
  });
});

describe('DynamicMcpManager — offload capture-then-reap (C1) + mid-tool-use (M3)', () => {
  it('offload: captures pids BEFORE restart, reaps them AFTER a confirmed restart', async () => {
    const order: string[] = [];
    const { deps, rec } = makeDeps({
      currentServers: () => ['playwright', 'threadline'],
      captureHeavyPids: () => { order.push('capture'); return [4242]; },
      restartSession: async () => { order.push('restart'); return { ok: true }; },
      reapPids: (pids) => { order.push('reap'); rec.reaped.push(pids); },
    });
    const r = await new DynamicMcpManager(deps).requestChange({ topicId: 1, op: 'offload', server: 'playwright', actor: { kind: 'agent' } });
    expect(r.status).toBe('applied');
    expect(order).toEqual(['capture', 'restart', 'reap']);
    expect(rec.reaped).toEqual([[4242]]);
  });

  it('offload: restart fails ⇒ captured pids are NOT reaped (the old session is still alive)', async () => {
    const { deps, rec } = makeDeps({
      currentServers: () => ['playwright', 'threadline'],
      restartSession: async () => ({ ok: false, code: 'session_not_found' }),
    });
    const r = await new DynamicMcpManager(deps).requestChange({ topicId: 1, op: 'offload', server: 'playwright', actor: { kind: 'agent' } });
    expect(r.status).toBe('restart-failed');
    expect(rec.reaped).toHaveLength(0);
  });

  it('offload aborts when mid-tool-use is TRUE (no capture, no restart)', async () => {
    const { deps, rec } = makeDeps({ currentServers: () => ['playwright', 'threadline'], isMidToolUse: () => true });
    const r = await new DynamicMcpManager(deps).requestChange({ topicId: 1, op: 'offload', server: 'playwright', actor: { kind: 'agent' } });
    expect(r).toEqual({ status: 'aborted', reason: 'mid-tool-use' });
    expect(rec.captured).toBe(0);
    expect(rec.restarts).toBe(0);
  });

  it('offload aborts when mid-tool-use is UNKNOWN (null) — fail-closed', async () => {
    const { deps } = makeDeps({ currentServers: () => ['playwright', 'threadline'], isMidToolUse: () => null });
    const r = await new DynamicMcpManager(deps).requestChange({ topicId: 1, op: 'offload', server: 'playwright', actor: { kind: 'agent' } });
    expect(r).toEqual({ status: 'aborted', reason: 'mid-tool-use' });
  });

  it('a LOAD does not re-check mid-tool-use (only offload does)', async () => {
    const { deps, rec } = makeDeps({ isMidToolUse: () => true });
    const r = await new DynamicMcpManager(deps).requestChange({ topicId: 1, op: 'load', server: 'playwright', actor: { kind: 'agent' } });
    expect(r.status).toBe('applied');
    expect(rec.restarts).toBe(1);
  });
});

describe('DynamicMcpManager — per-topic serialization (M2)', () => {
  it('two concurrent requests on the same topic do not interleave their restart', async () => {
    let active = 0;
    let maxActive = 0;
    const { deps } = makeDeps({
      restartSession: async () => {
        active++; maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--; return { ok: true };
      },
    });
    const mgr = new DynamicMcpManager(deps);
    await Promise.all([
      mgr.requestChange({ topicId: 1, op: 'load', server: 'playwright', actor: { kind: 'agent' } }),
      mgr.requestChange({ topicId: 1, op: 'offload', server: 'playwright', actor: { kind: 'agent' } }),
    ]);
    expect(maxActive).toBe(1); // never two restarts in flight for one topic
  });
});
