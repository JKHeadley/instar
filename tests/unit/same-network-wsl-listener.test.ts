/**
 * Identity A4 inside WSL, on a real TLS listener: the bind follows the networking mode as READ, the
 * listener fails closed on mirrored (without the Windows app's word), unknown and other modes, never
 * skips the per-address limit in mirrored mode, and owner actions run one at a time (a port move
 * cannot be undone by an open that started earlier).
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { SameNetworkListener, SAME_NETWORK_PER_ADDRESS_OPEN, SAME_NETWORK_FORWARDER_OPEN, SAME_NETWORK_STATE_FILE } from '../../src/server/sameNetworkListener.js';
import type { NetworkObservation, WslModeReading, WslNetworkingMode } from '../../src/core/SameNetworkNetwork.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOME: NetworkObservation = { kind: 'observed', network: { iface: 'eth0', router: '192.168.1.1', address: '192.168.1.20', range: '192.168.1.0/24' } };
const dirs: string[] = [];
const listeners: SameNetworkListener[] = [];
afterAll(async () => {
  for (const l of listeners) await l.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/same-network-wsl-listener.test.ts' });
});
const newDir = (): string => { const d = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'snw-')); dirs.push(d); return d; };
const reading = (mode: WslNetworkingMode): WslModeReading => ({ mode, source: 'wslinfo', detail: mode });

/** A WSL listener. WSL's "NAT address" is loopback here so the test can bind it on any host. */
function wsl(dir: string, mode: { m: WslNetworkingMode }, natAddress: string | null = '127.0.0.1'): SameNetworkListener {
  const l = new SameNetworkListener({
    stateDir: dir, agentName: 'Wsly', machineName: 'pc', mainPort: 4040, port: 0,
    app: (_req, res) => { res.end('ok'); }, gate: () => true, wsl: true, announce: false,
    observe: async () => ({ kind: 'delegated', observer: 'windows-app' }),
    wslMode: async () => reading(mode.m), wslNatAddress: () => natAddress,
  });
  listeners.push(l);
  return l;
}
const stateOf = (dir: string): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(dir, SAME_NETWORK_STATE_FILE), 'utf8'));
const limited = (l: SameNetworkListener, addr: string, cap = SAME_NETWORK_PER_ADDRESS_OPEN): boolean => {
  let passed = 0;
  for (let i = 0; i < cap + 1; i++) if (l.perAddressOk(addr)) passed++;
  return passed === cap;
};

describe('the same-network listener inside WSL', () => {
  it('NAT (read): binds WSL\'s own NAT address; the pass-through limits each caller', async () => {
    const l = wsl(newDir(), { m: 'nat' });
    const r = await l.openForOwner();
    expect(r.ok).toBe(true);
    expect(l.listening()).toBe(true);
    expect(l.status().bind).toBe('127.0.0.1');
    expect(l.status().wslMode).toMatchObject({ mode: 'nat' });
    expect(limited(l, 'pass-through')).toBe(false);
  });

  it('NAT mode with no readable NAT address: refused, nothing recorded', async () => {
    const dir = newDir();
    const l = wsl(dir, { m: 'nat' }, null);
    expect(await l.openForOwner({ windowsAppHandlesNetworkRule: true })).toMatchObject({ ok: false, reason: 'wsl-networking-mode', mode: 'nat' });
    expect(l.listening()).toBe(false);
    expect(fs.existsSync(path.join(dir, SAME_NETWORK_STATE_FILE))).toBe(false);
  });

  it('mirrored without the Windows app\'s word: refused before anything is recorded', async () => {
    const dir = newDir();
    const l = wsl(dir, { m: 'mirrored' });
    const r = await l.openForOwner();
    expect(r).toMatchObject({ ok: false, reason: 'wsl-networking-mode', mode: 'mirrored' });
    expect(l.listening()).toBe(false);
    expect(l.status().wanted).toBe(false);
    expect(fs.existsSync(path.join(dir, SAME_NETWORK_STATE_FILE))).toBe(false);
  });

  it('mirrored with the Windows app\'s word: loopback only, and the per-address limit stays on (sized for the whole pass-through door)', async () => {
    const dir = newDir();
    const l = wsl(dir, { m: 'mirrored' }, '172.20.10.5'); // a 172.16-31.x LAN address: never bound
    const r = await l.openForOwner({ windowsAppHandlesNetworkRule: true });
    expect(r.ok).toBe(true);
    expect(l.status().bind).toBe('127.0.0.1');
    // Every phone arrives from the pass-through as loopback, so loopback's bucket is the door's (builder #63).
    expect(limited(l, '127.0.0.1', SAME_NETWORK_FORWARDER_OPEN)).toBe(true);
    expect(stateOf(dir).windowsAppNetworkRule).toBe(true);
    // A real connection past the limit is closed by the listener.
    const port = l.status().port!;
    const socks: net.Socket[] = [];
    try {
      const closed = await new Promise<boolean>((resolve) => {
        const s = net.connect(port, '127.0.0.1');
        socks.push(s);
        s.once('close', () => resolve(true));
        s.once('connect', () => setTimeout(() => resolve(s.destroyed), 300));
      });
      expect(closed).toBe(true);
    } finally { for (const s of socks) s.destroy(); }
  });

  it('unknown and other modes are refused even with the Windows app\'s word', async () => {
    for (const m of ['unknown', 'other'] as const) {
      const l = wsl(newDir(), { m });
      expect(await l.openForOwner({ windowsAppHandlesNetworkRule: true }), m).toMatchObject({ ok: false, reason: 'wsl-networking-mode', mode: m });
      expect(l.listening()).toBe(false);
    }
  });

  it('after a restart it reopens on the stored word in mirrored mode; closing forgets the word', async () => {
    const dir = newDir();
    const a = wsl(dir, { m: 'mirrored' });
    expect((await a.openForOwner({ windowsAppHandlesNetworkRule: true })).ok).toBe(true);
    await a.stop();
    const b = wsl(dir, { m: 'mirrored' });
    await b.start();
    expect(b.listening()).toBe(true);
    expect(b.status().bind).toBe('127.0.0.1');
    await b.close();
    expect(stateOf(dir).windowsAppNetworkRule).toBeUndefined();
  });

  it('an address opened in NAT mode stays closed when WSL comes back mirrored (no word)', async () => {
    const dir = newDir();
    const a = wsl(dir, { m: 'nat' });
    expect((await a.openForOwner()).ok).toBe(true);
    await a.stop();
    const b = wsl(dir, { m: 'mirrored' });
    await b.start();
    expect(b.listening()).toBe(false);
    expect(b.status().held).toBe('wsl-networking-mode');
  });

  it('outside WSL the per-address limit applies on the LAN address', async () => {
    const l = new SameNetworkListener({
      stateDir: newDir(), agentName: 'Lan', machineName: 'box', mainPort: 4040, port: 0,
      app: (_req, res) => { res.end('ok'); }, gate: () => true, wsl: false, announce: false, bindHost: '0.0.0.0', observe: async () => HOME,
    });
    listeners.push(l);
    expect((await l.openForOwner()).ok).toBe(true);
    expect(limited(l, '192.168.1.50')).toBe(true);
  });
});

describe('owner actions run one at a time', () => {
  async function freePort(): Promise<number> {
    const s = net.createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    const p = (s.address() as net.AddressInfo).port;
    await new Promise((r) => s.close(() => r(undefined)));
    return p;
  }
  function lan(): SameNetworkListener {
    const l = new SameNetworkListener({
      stateDir: newDir(), agentName: 'Serial', machineName: 'box', mainPort: 4040, port: 0,
      app: (_req, res) => { res.end('ok'); }, gate: () => true, wsl: false, announce: false, bindHost: '127.0.0.1', observe: async () => HOME,
    });
    listeners.push(l);
    return l;
  }

  it('two opens asking for different ports at once: the later one wins, and each answer matches what it did', async () => {
    for (let round = 0; round < 5; round++) {
      const l = lan();
      const [a, b] = [await freePort(), await freePort()];
      const [ra, rb] = await Promise.all([l.openForOwner({ port: a, mayMovePort: true }), l.openForOwner({ port: b, mayMovePort: true })]);
      expect(ra.ok && ra.status.port).toBe(a);
      expect(rb.ok && rb.status.port).toBe(b);
      expect(l.status().port).toBe(b);
      expect(l.host()).toBe(`serial-box.local:${b}`);
      expect(l.listening()).toBe(true);
      await l.reconcile();
      expect(l.status().port).toBe(b);
    }
  });

  it('a close asked during an open runs after it, so the address ends closed', async () => {
    const l = lan();
    const [opened] = await Promise.all([l.openForOwner(), l.close()]);
    expect(opened.ok).toBe(true);
    expect(l.listening()).toBe(false);
    expect(l.status().wanted).toBe(false);
  });

  it('an action that fails does not hold up the next one', async () => {
    let fail = true;
    const l = new SameNetworkListener({
      stateDir: newDir(), agentName: 'Serial', machineName: 'box', mainPort: 4040, port: 0,
      app: (_req, res) => { res.end('ok'); }, gate: () => true, wsl: false, announce: false, bindHost: '127.0.0.1',
      observe: async () => { if (fail) { fail = false; throw new Error('observation failed'); } return HOME; },
    });
    listeners.push(l);
    const [first, second] = await Promise.allSettled([l.openForOwner(), l.openForOwner()]);
    expect(first.status).toBe('rejected');
    expect(second.status === 'fulfilled' && second.value.ok).toBe(true);
  });
});
