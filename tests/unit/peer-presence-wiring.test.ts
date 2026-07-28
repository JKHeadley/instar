/**
 * Wiring integrity: the server-boot mesh block must construct a real
 * PeerPresencePuller and actually START it (one immediate pass + a recurring
 * timer), feeding the SIGNED /mesh/rpc `session-status` call into the pool
 * registry's recordHeartbeat. Without this, the credential-less standby never
 * appears online and the placement engine refuses to transfer to it — the exact
 * gap the live-transfer proof surfaced on real hardware (laptop ↔ mini).
 *
 * These assertions pin the wiring against src/commands/server.ts source so a
 * future refactor can't silently drop the puller or leave it constructed-but-
 * never-pulled (the "constructed but inert" failure the Testing Integrity
 * Standard calls out for dependency-injected components).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('server-boot wiring: PeerPresencePuller (HTTP presence transport)', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf-8');

  it('imports + constructs a real PeerPresencePuller in the mesh block', () => {
    expect(src).toContain("import('../core/PeerPresencePuller.js')");
    expect(src).toContain('new presenceMod.PeerPresencePuller(');
  });

  it('feeds the SIGNED session-status call into recordHeartbeat (not a no-op)', () => {
    const ctorIdx = src.indexOf('new presenceMod.PeerPresencePuller(');
    expect(ctorIdx).toBeGreaterThan(0);
    const block = src.slice(ctorIdx, ctorIdx + 900);
    // fetchPeerCapacity must issue the read-class session-status command...
    expect(block).toContain("{ type: 'session-status' }");
    expect(block).toContain('meshClient.send(');
    // ...and the record path must delegate to the real pool registry.
    expect(block).toContain('machinePoolRegistry?.recordHeartbeat(obs)');
  });

  it('actually STARTS it: an immediate pullOnce() + a recurring unref-ed timer', () => {
    expect(src).toContain('void peerPresencePuller.pullOnce()');
    // The recurring tick is a named callback (peerPresenceTick) — see mesh-coherence-live-
    // state-honesty Fix (b), which appends the live-coherence recheck to it — so the timer
    // is registered with the named fn and the pull lives inside that fn.
    const tickIdx = src.indexOf('const peerPresenceTick = ()');
    expect(tickIdx).toBeGreaterThan(0);
    const tickBlock = src.slice(tickIdx, tickIdx + 200);
    expect(tickBlock).toContain('peerPresencePuller.pullOnce()');
    const timerIdx = src.indexOf('const peerPresenceTimer = setInterval(peerPresenceTick');
    expect(timerIdx).toBeGreaterThan(0);
    const block = src.slice(timerIdx, timerIdx + 200);
    expect(block).toContain('peerPresenceTimer.unref');
  });

  it('resolves each peer URL via the shared multi-rope peerUrl helper', () => {
    const ctorIdx = src.indexOf('new presenceMod.PeerPresencePuller(');
    const block = src.slice(ctorIdx, ctorIdx + 900);
    expect(block).toContain('peerUrl(m.machineId)');
    expect(block).toContain('selfMachineId: meshSelfId');
  });

  it('uses the shared multi-rope resolver for pool-scope fanout too', () => {
    const resolverIdx = src.indexOf('_resolvePeerUrls = () =>');
    expect(resolverIdx).toBeGreaterThan(0);
    const block = src.slice(resolverIdx, resolverIdx + 600);
    expect(block).toContain('peerUrl(m.machineId)');
    expect(block).not.toContain('!!m.entry.lastKnownUrl');
    expect(block).not.toContain('url: m.entry.lastKnownUrl');
  });
});
