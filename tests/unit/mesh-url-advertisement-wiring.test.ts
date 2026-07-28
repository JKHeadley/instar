/**
 * Wiring-integrity test for mesh URL advertisement.
 *
 * The original bug was a WIRING hole, not a logic bug: updateMachineUrl() (the
 * only writer of lastKnownUrl) had zero callers, so the cross-machine router —
 * which filters peers by lastKnownUrl — silently dropped every peer. Unit tests
 * of the router passed because they injected mock peer URLs. This test pins the
 * wiring structurally: the self-URL advertiser MUST be invoked on the
 * tunnel-ready path, and the joiner MUST record the URL it connected through.
 * If either call site is removed, lastKnownUrl regresses to never-populated and
 * cross-machine routing goes inert again — this test fails first.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SERVER = path.join(process.cwd(), 'src/commands/server.ts');
const JOIN = path.join(process.cwd(), 'src/commands/machine.ts');

describe('mesh URL advertisement wiring', () => {
  const server = fs.readFileSync(SERVER, 'utf-8');
  const join = fs.readFileSync(JOIN, 'utf-8');

  it('server.ts imports the advertiser', () => {
    expect(server).toContain("from '../core/MeshUrlAdvertiser.js'");
    expect(server).toContain('advertiseSelfMeshUrl');
    expect(server).toContain('resolveAdvertisedMeshUrl');
  });

  it('boot endpoint advertisement remains outside the optional tunnel branch', () => {
    const bootIdx = server.indexOf('Tunnel active:');
    expect(bootIdx).toBeGreaterThan(0);
    const catchIdx = server.indexOf('Tunnel start failed (manager will keep retrying in background)', bootIdx);
    const advertiseIdx = server.indexOf('await advertiseSelfMeshEndpointsNow(', catchIdx);
    expect(catchIdx).toBeGreaterThan(bootIdx);
    expect(advertiseIdx).toBeGreaterThan(catchIdx);
    const block = server.slice(catchIdx, advertiseIdx + 500);
    expect(block).toContain('advertiseSelfMeshUrl(');
    expect(block).toContain('resolveAdvertisedMeshUrl(config.tunnel, bootTunnelUrl)');
    expect(block).toContain('coordinator.managers.identityManager');
    expect(block).toContain('Mesh endpoint advertisement is independent of optional tunnel success');
  });

  it('pool presence and session routing consume advertised endpoint sets', () => {
    const peerUrlIdx = server.indexOf('const peerUrl = (machineId: string): string | null =>');
    expect(peerUrlIdx).toBeGreaterThan(0);
    const block = server.slice(peerUrlIdx, peerUrlIdx + 500);
    expect(block).toContain('meshResolver.resolve(machineId, entry.endpoints, entry.lastKnownUrl)');
    expect(block).not.toContain('entry.lastKnownUrl ?? null');
  });

  it('the self-URL is re-advertised after a sleep/wake tunnel restart (quick URL changes)', () => {
    const wakeIdx = server.indexOf('[SleepWake] Tunnel restarted');
    expect(wakeIdx).toBeGreaterThan(0);
    const block = server.slice(wakeIdx, wakeIdx + 800);
    expect(block).toContain('advertiseSelfMeshUrl(');
  });

  it('the joiner records the URL it connected through as the awake peer URL', () => {
    const idx = join.indexOf('Paired with:');
    expect(idx).toBeGreaterThan(0);
    // The updateMachineUrl call sits in the same registration block as the pairing.
    const block = join.slice(Math.max(0, idx - 400), idx + 100);
    expect(block).toContain('updateMachineUrl(result.machineIdentity.machineId, repoUrl');
  });
});
