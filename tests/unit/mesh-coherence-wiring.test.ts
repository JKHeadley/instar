/**
 * Wiring integrity (mesh-coherence-live-state-honesty Fix (b)): pin the periodic
 * live-coherence recheck against src/commands/server.ts source so a future refactor
 * can't silently drop it, leave it ungated, lose the throw-safety, or pass a no-op
 * live signal. This is the e2e/wiring tier for an INLINE-wired feature — there is no
 * extractable timer function to construct in isolation, so the source assertions ARE
 * the "feature is actually alive on the boot path" proof (mirrors peer-presence-wiring).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('server-boot wiring: mesh live-coherence recheck', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf-8');

  it('imports the pure check + warmup const from configCoherence', () => {
    expect(src).toContain('checkMeshLiveStateCoherence');
    expect(src).toContain('MESH_WARMUP_GRACE_MS');
  });

  it('declares meshResolvedBindHost at OUTER scope as a let (reachable from the timer closure)', () => {
    expect(src).toContain('let meshResolvedBindHost: string | undefined');
  });

  it('assigns meshResolvedBindHost from resolveMeshBindHost in the mesh-init block', () => {
    expect(src).toContain('meshResolvedBindHost = resolveMeshBindHost({');
    // …from the SAME meshBindActive inputs the AgentServer bind callsite uses.
    const idx = src.indexOf('meshResolvedBindHost = resolveMeshBindHost({');
    const block = src.slice(idx, idx + 300);
    expect(block).toContain('configHost: config.host');
    expect(block).toContain('meshBindHostOverride: config.multiMachine?.meshTransport?.bindHost');
  });

  it('the recheck runs in the named peerPresenceTick callback, dev-gated on the NESTED ?.enabled', () => {
    const tickIdx = src.indexOf('const peerPresenceTick = ()');
    expect(tickIdx).toBeGreaterThan(0);
    const block = src.slice(tickIdx, tickIdx + 4200);
    // gated on the nested ?.enabled boolean (NOT the block object — the dev-gate footgun)
    expect(block).toContain('resolveDevAgentGate(config.monitoring?.meshCoherenceLiveCheck?.enabled, config)');
    // calls the pure check with the REAL live signals (not a no-op stub)
    expect(block).toContain('checkMeshLiveStateCoherence(config.multiMachine, true, live, warmupGraceMs)');
    expect(block).toContain('boundHost: meshResolvedBindHost');
    expect(block).toContain('selfEndpoints: getSelfMeshEndpoints?.() ?? []');
    expect(block).toContain('uptimeMs: process.uptime() * 1000');
  });

  it('reads both tuning knobs (warmupGraceMs + emitCap) — not dead config', () => {
    const tickIdx = src.indexOf('const peerPresenceTick = ()');
    const block = src.slice(tickIdx, tickIdx + 4200);
    expect(block).toContain('config.monitoring?.meshCoherenceLiveCheck?.warmupGraceMs ?? MESH_WARMUP_GRACE_MS');
    expect(block).toContain('config.monitoring?.meshCoherenceLiveCheck?.emitCap');
    expect(block).toContain('count < emitCap');
  });

  it('records a per-feature metric (Observable Intelligence) for fired/noop and a transition-gated error', () => {
    const tickIdx = src.indexOf('const peerPresenceTick = ()');
    const block = src.slice(tickIdx, tickIdx + 4200);
    expect(block).toContain("feature: 'mesh-coherence-live'");
    expect(block).toContain("outcome: firedThisTick ? 'fired' : 'noop'");
    expect(block).toContain("outcome: 'error'");
  });

  it('wraps the live read so a throwing getSelfMeshEndpoints cannot crash the tick (Decision #11)', () => {
    const tickIdx = src.indexOf('const peerPresenceTick = ()');
    const block = src.slice(tickIdx, tickIdx + 4200);
    // a try/catch around the read, the failing latch, and the backoff counters
    expect(block).toContain('try {');
    expect(block).toContain('} catch {');
    expect(block).toContain('_meshCoherenceFailing');
    expect(block).toContain('_meshCoherenceConsecFailures += 1');
  });

  it('the existing boot-time config-only coherence call is left intact', () => {
    expect(src).toContain('checkMultiMachineConfigCoherence(config.multiMachine, true)');
  });
});
