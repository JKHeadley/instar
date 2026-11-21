/**
 * The home-network port (identity A4; docs/specs/identity-security-piece3e-same-network-first-phone.md §3.1):
 * the default is main + 20000 (5040, the old default, is Windows' Connected Devices Platform service's on every
 * Windows 10/11 PC), and a caller may ask for an exact port, which is never swapped for another and never moves
 * while a phone is paired on the home address. Both sides of every boundary, on a real TLS listener.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  SameNetworkListener, defaultSameNetworkPort, isRequestablePort, SAME_NETWORK_FALLBACK_PORT, SAME_NETWORK_PORT_OFFSET,
} from '../../src/server/sameNetworkListener.js';
import { FETCH_BLOCKED_PORTS } from '../../src/core/AgentRegistry.js';
import type { NetworkObservation } from '../../src/core/SameNetworkNetwork.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOME: NetworkObservation = { kind: 'observed', network: { iface: 'eth0', router: '192.168.1.1', address: '192.168.1.20', range: '192.168.1.0/24' } };
const dirs: string[] = [];
const listeners: SameNetworkListener[] = [];
const blockers: net.Server[] = [];
afterAll(async () => {
  for (const l of listeners) await l.stop();
  for (const b of blockers) await new Promise((r) => b.close(() => r(undefined)));
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/same-network-port.test.ts' });
});

function make(opts: { mainPort?: number; port?: number; observe?: () => Promise<NetworkObservation> } = {}): SameNetworkListener {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'snp-'));
  dirs.push(dir);
  const l = new SameNetworkListener({
    stateDir: dir, agentName: 'Porty', machineName: 'box', mainPort: opts.mainPort ?? 4040, ...(opts.port !== undefined ? { port: opts.port } : {}),
    app: (_req, res) => { res.end('ok'); }, gate: () => true, bindHost: '127.0.0.1', wsl: false, announce: false, observe: opts.observe ?? (async () => HOME),
  });
  listeners.push(l);
  return l;
}

/** A port free right now on 127.0.0.1 (taken by the OS, then released). */
async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const p = (s.address() as net.AddressInfo).port;
  await new Promise((r) => s.close(() => r(undefined)));
  return p;
}
async function hold(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  blockers.push(s);
  return (s.address() as net.AddressInfo).port;
}

describe('the default home port', () => {
  it('is the main port + 20000: 4040 -> 24040 and 4099 -> 24099, never 5040', () => {
    expect(SAME_NETWORK_PORT_OFFSET).toBe(20_000);
    expect(defaultSameNetworkPort(4040)).toBe(24_040);
    expect(defaultSameNetworkPort(4099)).toBe(24_099);
    for (let p = 4040; p <= 4099; p++) {
      const d = defaultSameNetworkPort(p);
      expect(d).not.toBe(5040);
      expect(FETCH_BLOCKED_PORTS.has(d)).toBe(false);
      expect(d).toBeLessThan(32_768); // below every ephemeral range (Linux starts at 32768)
    }
  });

  it('falls back to 24040 when main + 20000 would reach an ephemeral range: 12767 -> 32767, 12768 -> 24040', () => {
    expect(defaultSameNetworkPort(12_767)).toBe(32_767);
    expect(defaultSameNetworkPort(12_768)).toBe(SAME_NETWORK_FALLBACK_PORT);
    expect(defaultSameNetworkPort(50_000)).toBe(SAME_NETWORK_FALLBACK_PORT);
  });

  it('the listener reports it before it ever opens, so the app can check it is free first', () => {
    const l = make({ mainPort: 4042 });
    expect(l.status().preferredPort).toBe(24_042);
    expect(l.status().port).toBeNull();
  });
});

describe('a port the caller asks for', () => {
  it('is requestable from 1024 to 65535, whole numbers only, never a fetch-blocked port', () => {
    expect(isRequestablePort(1023)).toBe(false);
    expect(isRequestablePort(1024)).toBe(true);
    expect(isRequestablePort(65_535)).toBe(true);
    expect(isRequestablePort(65_536)).toBe(false);
    expect(isRequestablePort(24_041.5)).toBe(false);
    expect(isRequestablePort('24041')).toBe(false);
    expect(isRequestablePort(5060)).toBe(false); // SIP, on the fetch bad-ports list
    expect(isRequestablePort(5062)).toBe(true);
  });

  it('is used exactly when no port is stored yet', async () => {
    const l = make();
    const want = await freePort();
    const r = await l.openForOwner({ port: want });
    expect(r.ok).toBe(true);
    expect(l.status().port).toBe(want);
    expect(l.host()).toBe(`porty-box.local:${want}`);
  });

  it('is never swapped for another: a taken port fails the open, and no port is stored', async () => {
    const l = make({ port: 0 });
    const taken = await hold();
    const r = await l.openForOwner({ port: taken });
    expect(r).toMatchObject({ ok: false, reason: 'port-unavailable', port: taken });
    expect(l.listening()).toBe(false);
    expect(l.status().port).toBeNull();
    // Without an asked port, the old rule still applies: the first open may take another free port.
    const again = await l.openForOwner();
    expect(again.ok).toBe(true);
  });

  it('moves the stored port only when allowed (no phone paired on the home address)', async () => {
    const l = make({ port: 0 });
    expect((await l.openForOwner()).ok).toBe(true);
    const first = l.status().port!;
    const other = await freePort();
    const refused = await l.openForOwner({ port: other, mayMovePort: false });
    expect(refused).toMatchObject({ ok: false, reason: 'port-fixed', port: first });
    expect(l.status().port).toBe(first);
    expect(l.listening()).toBe(true);
    // The same port is always fine.
    expect((await l.openForOwner({ port: first, mayMovePort: false })).ok).toBe(true);
    const moved = await l.openForOwner({ port: other, mayMovePort: true });
    expect(moved.ok).toBe(true);
    expect(l.status().port).toBe(other);
    expect(l.host()).toBe(`porty-box.local:${other}`);
  });

  it('a reconcile already running when a move starts (the 15-second tick) cannot leave the listener on the old port', async () => {
    // The tick can read the stored port, bind it, and store it back while a move is in flight; the move
    // then joins that tick. Simulated deterministically: the first reconcile the move joins behaves as
    // that stale tick (it stores the earlier port back before running).
    const l = make({ port: 0 });
    const a = await freePort();
    expect((await l.openForOwner({ port: a })).ok).toBe(true);
    const b = await freePort();
    const real = l.reconcile.bind(l);
    let stale = true;
    (l as unknown as { reconcile: (c?: boolean) => Promise<void> }).reconcile = async (c?: boolean) => {
      if (stale) { stale = false; (l as unknown as { state: { port: number | null } }).state.port = a; }
      return real(c);
    };
    const r = await l.openForOwner({ port: b, mayMovePort: true });
    expect(r.ok).toBe(true);
    expect(l.status().port).toBe(b);
    expect(l.host()).toBe(`porty-box.local:${b}`);
    expect(r.ok && r.status.host).toBe(`porty-box.local:${b}`);
  });

  it('a failed move keeps the earlier port', async () => {
    const l = make({ port: 0 });
    expect((await l.openForOwner()).ok).toBe(true);
    const first = l.status().port!;
    const taken = await hold();
    const r = await l.openForOwner({ port: taken, mayMovePort: true });
    expect(r).toMatchObject({ ok: false, reason: 'port-unavailable' });
    expect(l.status().port).toBe(first);
    // Listening on the earlier port again at once, not only at the next reconcile.
    expect(l.listening()).toBe(true);
    expect(l.host()).toBe(`porty-box.local:${first}`);
  });
});
