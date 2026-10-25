import { describe, expect, it, vi } from 'vitest';
import { ObservedEndpointTracker, type ObservedEndpointConfig } from '../../src/core/ObservedEndpointTracker.js';
import { PeerEndpointRecorder } from '../../src/core/PeerEndpointRecorder.js';
import type { MeshEndpoint } from '../../src/core/types.js';

function fixture(overrides: Partial<ObservedEndpointConfig> = {}) {
  let now = 1_000_000;
  const endpoints = new Map<string, MeshEndpoint[]>();
  const writes = vi.fn((machineId: string, rows: MeshEndpoint[]) => endpoints.set(machineId, rows));
  const recorder = new PeerEndpointRecorder({
    getPeerEndpoints: (machineId) => endpoints.get(machineId),
    updateMachineEndpoints: writes,
    meshTransportEnabled: () => true,
  });
  const config: ObservedEndpointConfig = {
    enabled: true,
    dryRun: false,
    corroborationObservations: 3,
    corroborationWindowMinutes: 30,
    ttlDays: 7,
    rotationQuarantineHours: 1,
    ...overrides,
  };
  const dialBack = vi.fn(async () => true);
  const tracker = new ObservedEndpointTracker({ config: () => config, recorder, serverPort: 4042, dialBack, now: () => now });
  return { tracker, endpoints, writes, dialBack, advance: (ms: number) => { now += ms; } };
}

describe('ObservedEndpointTracker', () => {
  it('promotes only after three observations spanning thirty minutes and a signed dial-back', async () => {
    const f = fixture();
    expect(await f.tracker.observe({ machineId: 'm-peer', remoteAddress: '100.101.95.10', keyEpoch: 2, direct: true })).toBe('recorded');
    f.advance(15 * 60_000);
    expect(await f.tracker.observe({ machineId: 'm-peer', remoteAddress: '100.101.95.10', keyEpoch: 2, direct: true })).toBe('insufficient');
    f.advance(15 * 60_000);
    expect(await f.tracker.observe({ machineId: 'm-peer', remoteAddress: '100.101.95.10', keyEpoch: 2, direct: true })).toBe('promoted');
    expect(f.dialBack).toHaveBeenCalledOnce();
    expect(f.endpoints.get('m-peer')).toEqual([expect.objectContaining({ kind: 'tailscale', url: 'http://100.101.95.10:4042', origin: 'observed' })]);
  });

  it('keeps a corroborated observed endpoint alongside an advertised endpoint of the same kind', async () => {
    const f = fixture({ corroborationObservations: 1, corroborationWindowMinutes: 0 });
    f.endpoints.set('m-peer', [{ kind: 'tailscale', url: 'http://100.101.95.20:4042' }]);
    expect(await f.tracker.observe({ machineId: 'm-peer', remoteAddress: '100.101.95.10', keyEpoch: 2, direct: true })).toBe('promoted');
    expect(f.endpoints.get('m-peer')).toEqual([
      { kind: 'tailscale', url: 'http://100.101.95.20:4042' },
      expect.objectContaining({ kind: 'tailscale', url: 'http://100.101.95.10:4042', origin: 'observed' }),
    ]);
  });

  it('never observes forwarded/proxy traffic or public source addresses', async () => {
    const f = fixture();
    expect(await f.tracker.observe({ machineId: 'm-peer', remoteAddress: '100.101.95.10', keyEpoch: 0, direct: false })).toBe('not-direct');
    expect(await f.tracker.observe({ machineId: 'm-peer', remoteAddress: '8.8.8.8', keyEpoch: 0, direct: true })).toBe('invalid-address');
    expect(f.tracker.snapshot('m-peer')).toEqual([]);
  });

  it('refuses shared egress observed for two machine identities', async () => {
    const f = fixture({ corroborationObservations: 1, corroborationWindowMinutes: 0 });
    expect(await f.tracker.observe({ machineId: 'm-a', remoteAddress: '100.101.95.10', keyEpoch: 0, direct: true })).toBe('promoted');
    expect(await f.tracker.observe({ machineId: 'm-b', remoteAddress: '100.101.95.10', keyEpoch: 0, direct: true })).toBe('shared-egress');
    expect(f.endpoints.has('m-b')).toBe(false);
    expect(f.endpoints.get('m-a')).toEqual([]);
    expect(f.tracker.snapshot('m-a')).toEqual([]);
    expect(f.tracker.snapshot('m-b')).toEqual([]);
  });

  it('cannot promote pre-rotation evidence when rotation lands during dial-back', async () => {
    const f = fixture({ corroborationObservations: 1, corroborationWindowMinutes: 0 });
    let finishDialback!: (value: boolean) => void;
    f.dialBack.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finishDialback = resolve; }));
    const observing = f.tracker.observe({ machineId: 'm-peer', remoteAddress: '100.101.95.10', keyEpoch: 0, direct: true });
    await Promise.resolve();
    f.tracker.noteRotation('m-peer');
    finishDialback(true);
    expect(await observing).toBe('rotation-quarantine');
    expect(f.endpoints.has('m-peer')).toBe(false);
  });

  it('clamps rotation quarantine beyond the evidence window even when config is too short', async () => {
    const f = fixture({ corroborationObservations: 1, corroborationWindowMinutes: 30, rotationQuarantineHours: 0 });
    f.tracker.noteRotation('m-peer');
    f.advance(30 * 60_000);
    expect(await f.tracker.observe({ machineId: 'm-peer', remoteAddress: '100.101.95.10', keyEpoch: 1, direct: true })).toBe('rotation-quarantine');
    f.advance(60_001);
    expect(await f.tracker.observe({ machineId: 'm-peer', remoteAddress: '100.101.95.10', keyEpoch: 1, direct: true })).toBe('recorded');
  });

  it('discards evidence and suspends recording after a rotation', async () => {
    const f = fixture({ corroborationObservations: 1, corroborationWindowMinutes: 0 });
    f.tracker.noteRotation('m-peer');
    expect(await f.tracker.observe({ machineId: 'm-peer', remoteAddress: '100.101.95.10', keyEpoch: 1, direct: true })).toBe('rotation-quarantine');
    f.advance(60 * 60_000 + 1);
    expect(await f.tracker.observe({ machineId: 'm-peer', remoteAddress: '100.101.95.10', keyEpoch: 1, direct: true })).toBe('promoted');
  });

  it('dry-run verifies dial-back but does not persist', async () => {
    const f = fixture({ dryRun: true, corroborationObservations: 1, corroborationWindowMinutes: 0 });
    expect(await f.tracker.observe({ machineId: 'm-peer', remoteAddress: '192.168.1.40', keyEpoch: 0, direct: true })).toBe('would-promote');
    expect(f.dialBack).toHaveBeenCalledOnce();
    expect(f.writes).not.toHaveBeenCalled();
  });

  it('dry-run shared-egress detection does not retract a previously persisted observed endpoint', async () => {
    const f = fixture({ dryRun: true, corroborationObservations: 1, corroborationWindowMinutes: 0 });
    f.endpoints.set('m-a', [{ kind: 'tailscale', url: 'http://100.101.95.10:4042', origin: 'observed' }]);
    await f.tracker.observe({ machineId: 'm-a', remoteAddress: '100.101.95.10', keyEpoch: 0, direct: true });
    expect(await f.tracker.observe({ machineId: 'm-b', remoteAddress: '100.101.95.10', keyEpoch: 0, direct: true })).toBe('would-retract-shared-egress');
    expect(f.endpoints.get('m-a')).toEqual([{ kind: 'tailscale', url: 'http://100.101.95.10:4042', origin: 'observed' }]);
    expect(f.writes).not.toHaveBeenCalled();
  });
});
