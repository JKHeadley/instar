/**
 * WS1.1 — dispatch-to-owner (MULTI-MACHINE-SEAMLESSNESS-SPEC): the pieces the
 * queue merge (#1079) did NOT ship. (The receiver half — epoch fencing, durable
 * remote receipts, sender re-validation — shipped with the queue and has its
 * own suite; SessionRouter.test.ts covers the new skew gate's decision table.)
 *
 *  1. seamlessnessFlags roundtrip: heartbeat observation → getCapacity, with
 *     ABSENT = non-participant (older peer) and live-only passthrough.
 *  2. The drain spawn-boundary ownership re-check seam (TOCTOU double-spawn
 *     guard) — source-level assertions on the server wiring, following the
 *     established dashboard/ws3 at-rest pattern.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MachinePoolRegistry } from '../../src/core/MachinePoolRegistry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'commands', 'server.ts'), 'utf-8');

describe('WS1.1 — seamlessnessFlags heartbeat roundtrip', () => {
  function makeRegistry() {
    return new MachinePoolRegistry({
      listMachines: () => [
        { machineId: 'm_new', nickname: 'new' },
        { machineId: 'm_old', nickname: 'old' },
      ],
    } as ConstructorParameters<typeof MachinePoolRegistry>[0]);
  }

  it('a heartbeat carrying ws11DeliverReceive surfaces on getCapacity; a peer without flags has the field ABSENT', () => {
    const reg = makeRegistry();
    reg.recordHeartbeat({ machineId: 'm_new', selfReportedLastSeen: new Date().toISOString(), seamlessnessFlags: { ws11DeliverReceive: true } });
    reg.recordHeartbeat({ machineId: 'm_old', selfReportedLastSeen: new Date().toISOString() }); // pre-spec peer
    expect(reg.getCapacity('m_new')?.seamlessnessFlags?.ws11DeliverReceive).toBe(true);
    expect(reg.getCapacity('m_old')?.seamlessnessFlags).toBeUndefined(); // absent = non-participant
  });

  it('the advertisement is LIVE-only: withdrawing it on a later heartbeat withdraws the capability', () => {
    const reg = makeRegistry();
    reg.recordHeartbeat({ machineId: 'm_new', selfReportedLastSeen: new Date().toISOString(), seamlessnessFlags: { ws11DeliverReceive: true } });
    reg.recordHeartbeat({ machineId: 'm_new', selfReportedLastSeen: new Date().toISOString() }); // queue went dark
    expect(reg.getCapacity('m_new')?.seamlessnessFlags).toBeUndefined();
  });
});

describe('WS1.1 — server wiring seams (at-rest)', () => {
  it('the self-heartbeat advertises ws11DeliverReceive from the LIVE queue handle', () => {
    expect(serverSrc).toMatch(/seamlessnessFlags: \{ ws11DeliverReceive: !!_inboundQueue \}/);
  });

  it('the drain spawn boundary re-checks ownership and bounces non-owner spawns to un-routable', () => {
    const seam = serverSrc.match(/_ownershipReadForDrain && _meshSelfId[\s\S]{0,400}/);
    expect(seam, 'drain spawn-boundary re-check missing').toBeTruthy();
    expect(seam![0]).toContain("ownership-moved-before-spawn");
    expect(seam![0]).toContain("'un-routable'");
  });

  it('the re-check guards the SPAWN path only (placed before the spawn-in-progress guard, after direct-inject)', () => {
    const spawnGuardIdx = serverSrc.indexOf("reason: 'spawn-in-progress'");
    const recheckIdx = serverSrc.indexOf("ownership-moved-before-spawn");
    const directInjectIdx = serverSrc.indexOf('Direct inject: receipt FIRST');
    expect(recheckIdx).toBeGreaterThan(directInjectIdx);
    expect(recheckIdx).toBeLessThan(spawnGuardIdx);
  });

  it('the router wiring resolves ownerSupportsForward from the peer heartbeat flags (absent flags → false, unknown peer → null)', () => {
    const wiring = serverSrc.match(/ownerSupportsForward: \(m\) => \{[\s\S]{0,400}/);
    expect(wiring, 'ownerSupportsForward wiring missing').toBeTruthy();
    expect(wiring![0]).toContain('seamlessnessFlags?.ws11DeliverReceive === true');
    expect(wiring![0]).toContain('return null');
  });
});
