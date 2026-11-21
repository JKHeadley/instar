/**
 * Wiring-integrity for unroutable-owner release (docs/specs/unroutable-owner-release.md).
 * The router layer is the one that repairs the fleet (the engine is dev-gated), so a
 * silently dropped dep would pass every module test and still leave topics stranded.
 * SOURCE assertions: server.ts hands the SessionRouter both deps backed by the real
 * seams (lease, registry, journal reader, ownership CAS + placement journal), the
 * engine gets the registry-standing dep and the corrected mirror read, and the
 * AgentServer option reaches the route context.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

describe('unroutable-owner release wiring — SOURCE', () => {
  const server = read('src/commands/server.ts');

  it('the session router receives both deps, backed by real seams', () => {
    const at = server.indexOf('_sessionRouter = new routerMod.SessionRouter({');
    expect(at).toBeGreaterThan(0);
    const ctor = server.slice(at, at + 400);
    expect(ctor).toContain('isOwnerUnroutable: (m) => _isOwnerUnroutable?.(m) ?? false');
    expect(ctor).toContain('forceClaimUnroutableForSelf: routerForceClaimUnroutable');
    const fAt = server.indexOf('const routerForceClaimUnroutable = (');
    expect(fAt).toBeGreaterThan(0);
    expect(fAt).toBeLessThan(at);
    const block = server.slice(fAt, fAt + 1500);
    expect(block).toContain("ownReg.cas({ type: 'force-claim', machineId: meshSelfId }");
    expect(block).toContain("emitPlacement(sk, r, 'failover', prevOwner)");
    expect(block).toContain('if (!coordinator.holdsLease()) return false;');
  });

  it('the lease-gated predicate is assigned BEFORE the router is built, from the real registry + journal', () => {
    const assign = server.indexOf('_isOwnerUnroutable = (m) => {');
    const build = server.indexOf('_sessionRouter = new routerMod.SessionRouter({');
    expect(assign).toBeGreaterThan(0);
    expect(assign).toBeLessThan(build);
    expect(server).toContain('registryMachines: () => coordinator.managers.identityManager.loadRegistry().machines');
    expect(server).toContain('lastSideEffectMs: (m) => newestSideEffectMs(unroutableReader, m)');
  });

  it('the AgentServer receives the predicate (route context for POST /pool/transfer)', () => {
    expect(server).toContain('isOwnerUnroutable: (m: string) => _isOwnerUnroutable?.(m) ?? false');
    expect(read('src/server/AgentServer.ts')).toContain('isOwnerUnroutable: options.isOwnerUnroutable ?? null');
    expect(read('src/server/routes.ts')).toContain("casAndJournal({ type: 'force-claim', machineId: target }, 'tforce')");
  });

  it('the stale-owner engine gets registry standing and the corrected mirror read (no streams[machineId])', () => {
    expect(server).toContain('ownerStanding: (machineId) => {');
    expect(server).toContain('return unroutableOwnerMod.newestSideEffectMs(pinAdvisoryReader, machineId);');
    expect(server).not.toContain('const st = res.streams[machineId];');
    expect(server).toContain('unroutableOwnerLive: c.unroutableOwnerLive !== false');
  });
});
