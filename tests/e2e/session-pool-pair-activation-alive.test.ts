/**
 * Single-machine strict no-op, and the wiring in server.ts that a pair depends on
 * (docs/specs/session-pool-activation-at-pairing.md).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import { activatedAtPairing } from '../../src/core/sessionPoolPairActivation.js';
import { computePoolReadiness, SINGLE_MACHINE_READINESS, type PoolReadinessDeps } from '../../src/core/poolReadiness.js';

const server = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf-8');
const routes = fs.readFileSync(path.join(process.cwd(), 'src/server/machineRoutes.ts'), 'utf-8');
const joinFlow = fs.readFileSync(path.join(process.cwd(), 'src/commands/machine.ts'), 'utf-8');

describe('a single-machine agent', () => {
  const shipped: Record<string, unknown> = {};
  applyDefaults(shipped, getMigrationDefaults('claude-code' as never));

  it('ships unmarked and off, so no new behaviour can run', () => {
    expect(activatedAtPairing(shipped)).toBe(false);
    expect((shipped as any).multiMachine.sessionPool.enabled).toBe(false);
    expect((shipped as any).multiMachine.sessionPool.promotionModel).toBe('off');
  });
  it('update never writes the marker', () => {
    const again = structuredClone(shipped);
    applyDefaults(again, getMigrationDefaults('claude-code' as never));
    expect(activatedAtPairing(again)).toBe(false);
  });
  it('readiness stays the single-machine answer', () => {
    const deps = { peerIds: () => [] } as unknown as PoolReadinessDeps;
    expect(computePoolReadiness(deps)).toBe(SINGLE_MACHINE_READINESS);
  });
  it('the only writer of the keys is the pairing route and the join', () => {
    const src = path.join(process.cwd(), 'src');
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(d, e.name);
      return e.isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
    });
    const callers = walk(src)
      .filter((f) => /finishInviterPairActivation\(|applyJoinerPairActivation\(/.test(fs.readFileSync(f, 'utf-8')))
      .map((f) => path.relative(src, f)).sort();
    expect(callers).toEqual(['commands/machine.ts', 'core/sessionPoolPairActivation.ts', 'server/machineRoutes.ts']);
  });
});

describe('wiring', () => {
  it('the decision runs before the joiner is stored', () => {
    expect(routes.indexOf('decideInviterPairActivation({')).toBeLessThan(routes.indexOf('storeRemoteIdentity(acceptedMachineIdentity'));
    expect(routes.indexOf('decideInviterPairActivation({')).toBeGreaterThan(routes.indexOf("router.post('/api/pair'"));
  });
  it('the joiner writes before its first boot, and before it records the peer', () => {
    expect(joinFlow.indexOf('applyJoinerPairActivation({')).toBeLessThan(joinFlow.indexOf('mgr.storeRemoteIdentity(result.machineIdentity)'));
  });
  it('the green and the expiry are gated on the marker, and the runner keeps its place', () => {
    expect(server).toMatch(/const pairStartedPool = activatedAtPairing\(config\)/);
    expect(server).toMatch(/\.\.\.\(pairStartedPool \? \{\s*shadowProof:/);
    expect(server).toMatch(/if \(pairStartedPool && !failoverRunnerCfg\.enabled\) \{/);
  });
  it('the duplicate check asks peers over the signed verb, and both sides are wired', () => {
    expect(server).toContain("'session-live-probe': async (cmd) =>");
    expect(server).toMatch(/_signedLiveCopyProbe = \(machineId, url, platform, platformId\) =>/);
    expect(server).toMatch(/_serveLiveCopyProbe = async \(platform, platformId\) =>/);
    expect(server).toMatch(/probeLiveCopy: async[\s\S]{0,900}probeLiveCopyOnPeer\(\{/);
  });
  it('every path that skips the router at dark asks about a peer first', () => {
    expect(server.match(/_routesToPeerAtDark\(/g)?.length).toBe(3);
    expect(server).not.toMatch(/if \(_sessionRouter && _sessionPoolStage\(\) !== 'dark'\)/);
  });
});
