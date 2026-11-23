/**
 * The home listener's limits sized for a real phone, the pass-through's one address getting the whole
 * door, and the bounded refusal log (builder #63, after builder #62's live iPhone pairing over home
 * Wi-Fi: a phone screen opened ~8 TLS connections at once and the 6-open / 40-a-minute limit refused
 * the rest; 403s afterwards could not be explained because nothing recorded refusals).
 *
 * The limit tests use the numbers themselves, not the constants, so they fail if the limits go back down.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import {
  SameNetworkListener, SAME_NETWORK_MAX_CONNECTIONS, SAME_NETWORK_PER_ADDRESS_OPEN, SAME_NETWORK_PER_ADDRESS_PER_MIN,
  SAME_NETWORK_FORWARDER_OPEN, SAME_NETWORK_FORWARDER_PER_MIN,
} from '../../src/server/sameNetworkListener.js';
import {
  SameNetworkRefusalLog, SAME_NETWORK_REFUSALS_FILE, refusalRoute, refusalCode, reasonFromBody, devicePrefix,
} from '../../src/server/sameNetworkRefusals.js';
import type { NetworkObservation, WslModeReading } from '../../src/core/SameNetworkNetwork.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOME: NetworkObservation = { kind: 'observed', network: { iface: 'eth0', router: '192.168.1.1', address: '192.168.1.20', range: '192.168.1.0/24' } };
const dirs: string[] = [];
const listeners: SameNetworkListener[] = [];
afterAll(async () => {
  for (const l of listeners) await l.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/same-network-home-limits.test.ts' });
});
const newDir = (): string => { const d = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'snl-')); dirs.push(d); return d; };

type Gate = ConstructorParameters<typeof SameNetworkListener>[0]['gate'];
/** A listener on a LAN-style bind (per-address limit on), with a settable clock. */
function lan(clock: { t: number }, gate: Gate = () => true, dir = newDir()): SameNetworkListener {
  const l = new SameNetworkListener({
    stateDir: dir, agentName: 'Lan', machineName: 'box', mainPort: 4040, port: 0,
    app: (_req, res) => { res.end('ok'); }, gate, wsl: false, announce: false, bindHost: '0.0.0.0',
    observe: async () => HOME, now: () => clock.t,
  });
  listeners.push(l);
  return l;
}
function mirrored(clock: { t: number }): SameNetworkListener {
  const reading: WslModeReading = { mode: 'mirrored', source: 'wslinfo', detail: 'mirrored' };
  const l = new SameNetworkListener({
    stateDir: newDir(), agentName: 'Wsly', machineName: 'pc', mainPort: 4040, port: 0,
    app: (_req, res) => { res.end('ok'); }, gate: () => true, wsl: true, announce: false,
    observe: async () => ({ kind: 'delegated', observer: 'windows-app' }),
    wslMode: async () => reading, wslNatAddress: () => null, now: () => clock.t,
  });
  listeners.push(l);
  return l;
}
/** Takes `n` places from `addr`; returns how many were let through. */
const take = (l: SameNetworkListener, addr: string, n: number): number => { let ok = 0; for (let i = 0; i < n; i++) if (l.perAddressOk(addr)) ok++; return ok; };
/** Frees `n` open places for `addr` as a closing socket does (the listener's own close handler is on real sockets only). */
function release(l: SameNetworkListener, addr: string, n: number): void {
  const m = (l as unknown as { perAddress: Map<string, { open: number }> }).perAddress;
  const e = m.get(addr); if (e) e.open = Math.max(0, e.open - n);
}

describe('the numbers', () => {
  it('are sized for a busy phone: 24 open and 240 a minute per address, 64 in all; the pass-through address gets the door', () => {
    expect(SAME_NETWORK_PER_ADDRESS_OPEN).toBe(24);
    expect(SAME_NETWORK_PER_ADDRESS_PER_MIN).toBe(240);
    expect(SAME_NETWORK_MAX_CONNECTIONS).toBe(64);
    expect(SAME_NETWORK_FORWARDER_OPEN).toBe(64);
    expect(SAME_NETWORK_FORWARDER_PER_MIN).toBe(960);
  });
});

describe('where the agent listens directly (per caller address)', () => {
  it('a busy phone is never refused: ten 12-connection screen loads in a minute, then 24 open at once', async () => {
    const clock = { t: Date.parse('2026-11-21T12:00:00Z') };
    const l = lan(clock);
    expect((await l.openForOwner()).ok).toBe(true);
    const phone = '192.168.1.48';
    for (let load = 0; load < 10; load++) {
      expect(take(l, phone, 12)).toBe(12);
      release(l, phone, 12);
      clock.t += 5_000;
    }
    expect(take(l, phone, 24)).toBe(24);
  });

  it('24 open from one address are let in, the 25th is refused as address-open; another address is not held up', async () => {
    const clock = { t: Date.parse('2026-11-21T12:00:00Z') };
    const l = lan(clock);
    expect((await l.openForOwner()).ok).toBe(true);
    expect(take(l, '192.168.1.60', 24)).toBe(24);
    expect(l.perAddressRefusal('192.168.1.60')).toBe('address-open');
    expect(l.perAddressRefusal('192.168.1.61')).toBeNull();
    release(l, '192.168.1.60', 1);
    expect(l.perAddressRefusal('192.168.1.60')).toBeNull();
    expect(l.perAddressRefusal('192.168.1.60')).toBe('address-open');
  });

  it('240 new a minute from one address are let in, the 241st is refused as address-per-minute until the minute passes', async () => {
    const clock = { t: Date.parse('2026-11-21T12:00:00Z') };
    const l = lan(clock);
    expect((await l.openForOwner()).ok).toBe(true);
    const a = '192.168.1.62';
    for (let i = 0; i < 240; i++) { expect(l.perAddressRefusal(a)).toBeNull(); release(l, a, 1); }
    expect(l.perAddressRefusal(a)).toBe('address-per-minute');
    expect(l.perAddressRefusal('192.168.1.63')).toBeNull();
    clock.t += 59_000;
    expect(l.perAddressRefusal(a)).toBe('address-per-minute');
    clock.t += 1_000;
    expect(l.perAddressRefusal(a)).toBeNull();
  });
});

describe('WSL mirrored: every caller arrives from the pass-through as loopback', () => {
  it('loopback gets the whole door: 64 open let in, the 65th refused; 960 a minute, not 961', async () => {
    const clock = { t: Date.parse('2026-11-21T12:00:00Z') };
    const l = mirrored(clock);
    expect((await l.openForOwner({ windowsAppHandlesNetworkRule: true })).ok).toBe(true);
    expect(l.status().bind).toBe('127.0.0.1');
    expect(take(l, '127.0.0.1', 64)).toBe(64);
    expect(l.perAddressRefusal('127.0.0.1')).toBe('address-open');
    release(l, '127.0.0.1', 64);
    // 64 already counted this minute; 896 more reach 960.
    for (let i = 0; i < 896; i++) { expect(l.perAddressRefusal('127.0.0.1')).toBeNull(); release(l, '127.0.0.1', 1); }
    expect(l.perAddressRefusal('127.0.0.1')).toBe('address-per-minute');
    // The IPv4-mapped form of the same address is the same door.
    expect(l.perAddressRefusal('::ffff:127.0.0.1')).toBeNull();
  });

  it('two busy phones together through the pass-through are not refused by the agent (the old shared 6 would refuse)', async () => {
    const clock = { t: Date.parse('2026-11-21T12:00:00Z') };
    const l = mirrored(clock);
    expect((await l.openForOwner({ windowsAppHandlesNetworkRule: true })).ok).toBe(true);
    expect(take(l, '127.0.0.1', 24)).toBe(24);
  });

  it('any other address in mirrored mode still has the per-phone limit', async () => {
    const clock = { t: Date.parse('2026-11-21T12:00:00Z') };
    const l = mirrored(clock);
    expect((await l.openForOwner({ windowsAppHandlesNetworkRule: true })).ok).toBe(true);
    expect(take(l, '127.0.0.2', 30)).toBe(24);
  });

  it('WSL NAT mode has no per-address limit here and no door-sized bucket (the pass-through limits each phone)', async () => {
    const clock = { t: Date.parse('2026-11-21T12:00:00Z') };
    const reading: WslModeReading = { mode: 'nat', source: 'wslinfo', detail: 'nat' };
    const l = new SameNetworkListener({
      stateDir: newDir(), agentName: 'Wsln', machineName: 'pc', mainPort: 4040, port: 0,
      app: (_req, res) => { res.end('ok'); }, gate: () => true, wsl: true, announce: false,
      observe: async () => ({ kind: 'delegated', observer: 'windows-app' }),
      wslMode: async () => reading, wslNatAddress: () => '127.0.0.1', now: () => clock.t,
    });
    listeners.push(l);
    expect((await l.openForOwner()).ok).toBe(true);
    expect(take(l, '127.0.0.1', 100)).toBe(100);
    expect((l as unknown as { forwarderAddress: string | null }).forwarderAddress).toBeNull();
  });

  it('a direct (non-WSL) listener gives loopback no door-sized bucket', async () => {
    const clock = { t: Date.parse('2026-11-21T12:00:00Z') };
    const l = lan(clock);
    expect((await l.openForOwner()).ok).toBe(true);
    expect(take(l, '127.0.0.1', 30)).toBe(24);
  });
});

describe('the refusal log', () => {
  it('reduces a path to a route: no query, ids and codes replaced, odd characters masked, clipped', () => {
    expect(refusalRoute('/mobile/phone-setup/16ff8b30-1234-4abc-8def-0123456789ab?token=SECRET')).toBe('/mobile/phone-setup/:id');
    expect(refusalRoute('/Mobile/Device/')).toBe('/mobile/device');
    expect(refusalRoute('/mobile/pairing-codes/redeem')).toBe('/mobile/pairing-codes/redeem');
    expect(refusalRoute('/a/b%20c')).toBe('/a/:x');
    expect(refusalRoute('/x/abc123')).toBe('/x/:id');
    expect(refusalRoute('/x/ab12')).toBe('/x/ab12');
    expect(refusalRoute('/' + 'a'.repeat(24) + '/' + 'b'.repeat(25))).toBe('/' + 'a'.repeat(24) + '/:id');
    expect(refusalRoute('/' + Array.from({ length: 40 }, () => 'segment').join('/')).length).toBe(120);
  });

  it('keeps a reason only when it is a plain code', () => {
    expect(refusalCode('device-unauthorized')).toBe('device-unauthorized');
    expect(refusalCode('Phone pairing is off on this agent.')).toBeNull();
    expect(reasonFromBody('{"error":"cannot-approve-yet","detail":"..."}')).toBe('cannot-approve-yet');
    expect(reasonFromBody('{"error":"That link has expired or was already used."}')).toBeNull();
    expect(reasonFromBody('not json')).toBeNull();
    expect(devicePrefix('4977bad9-12b7-4aae-93cc-1a7d61788676')).toBe('4977bad9');
    expect(devicePrefix('x')).toBeUndefined();
    expect(devicePrefix('evil value with spaces')).toBeUndefined();
    expect(devicePrefix(['a'])).toBeUndefined();
  });

  it('is bounded: the oldest go first, and a repeat of the newest only counts up', () => {
    const dir = newDir();
    let t = Date.parse('2026-11-21T12:00:00Z');
    const log = new SameNetworkRefusalLog({ stateDir: dir, now: () => t, max: 5, flushMs: 60_000 });
    for (let i = 0; i < 1000; i++) { log.record({ kind: 'connection', reason: 'address-open', from: '192.168.1.9' }); t += 10; }
    let r = log.recent();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ count: 1000, reason: 'address-open', from: '192.168.1.9', at: '2026-11-21T12:00:00.000Z' });
    expect(r[0].lastAt).toBe(new Date(t - 10).toISOString());
    for (let i = 0; i < 7; i++) log.record({ kind: 'request', reason: 'not-found', method: 'GET', url: `/route${'abcdefg'[i]}`, status: 404 });
    r = log.recent();
    expect(r).toHaveLength(5);
    expect(r[0].route).toBe('/routeg');
    expect(r[4].route).toBe('/routec');
    expect(log.recent(2)).toHaveLength(2);
    log.flush();
  });

  it('survives a restart in a private file, and keeps no header value, body, query or full device id', () => {
    const dir = newDir();
    const log = new SameNetworkRefusalLog({ stateDir: dir, flushMs: 60_000 });
    log.record({ kind: 'request', reason: 'device-unauthorized', method: 'get', url: '/mobile/device?sig=SIGNATURE-VALUE', status: 401, deviceHeader: '4977bad9-12b7-4aae-93cc-1a7d61788676', from: '172.31.96.1' });
    log.record({ kind: 'request', reason: 'Some sentence the route sent.', method: 'POST', url: '/mobile/pairing-codes/redeem', status: 403 });
    log.flush();
    const f = path.join(dir, SAME_NETWORK_REFUSALS_FILE);
    const text = fs.readFileSync(f, 'utf8');
    expect(text).not.toContain('SIGNATURE-VALUE');
    expect(text).not.toContain('12b7-4aae');
    expect(text).not.toContain('Some sentence');
    expect(fs.statSync(f).mode & 0o077).toBe(0);
    const again = new SameNetworkRefusalLog({ stateDir: dir });
    const r = again.recent();
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ kind: 'request', reason: 'http-403', method: 'POST', route: '/mobile/pairing-codes/redeem', status: 403 });
    expect(r[1]).toMatchObject({ kind: 'request', reason: 'device-unauthorized', method: 'GET', route: '/mobile/device', status: 401, device: '4977bad9', from: '172.31.96.1' });
  });

  it('a burst of refusals writes the file once per flush, not once per refusal', async () => {
    const dir = newDir();
    const spy = vi.spyOn(fs, 'renameSync');
    try {
      const log = new SameNetworkRefusalLog({ stateDir: dir, flushMs: 30 });
      for (let i = 0; i < 200; i++) log.record({ kind: 'connection', reason: i % 2 ? 'address-open' : 'address-per-minute', from: `192.168.1.${i % 50}` });
      expect(spy).not.toHaveBeenCalled();
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(spy.mock.calls.filter((c) => String(c[1]).endsWith('same-network-refusals.json'))).toHaveLength(1);
    } finally { spy.mockRestore(); }
  });

  it('a clipped error body still gives its leading code', () => {
    expect(reasonFromBody(('{"error":"device-unauthorized","detail":"' + 'x'.repeat(600)).slice(0, 512))).toBe('device-unauthorized');
    expect(reasonFromBody('{"detail":"x","error":"not-found"')).toBeNull();
  });

  it('an unreadable file starts an empty log', () => {
    const dir = newDir();
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, SAME_NETWORK_REFUSALS_FILE), '{not json');
    expect(new SameNetworkRefusalLog({ stateDir: dir }).recent()).toEqual([]);
  });
});

describe('the refusal log on a real home listener', () => {
  const portOf = (l: SameNetworkListener): number => Number(l.status().port);
  function ask(port: number, p: string, headers: Record<string, string> = {}): Promise<number> {
    return new Promise((resolve, reject) => {
      const s = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false, minVersion: 'TLSv1.3' }, () => {
        s.write(`GET ${p} HTTP/1.1\r\nHost: lan-box.local:${port}\r\nConnection: close\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`);
      });
      let buf = '';
      s.on('data', (d) => { buf += d.toString('utf8'); });
      s.on('end', () => { resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(buf)?.[1] ?? 0)); });
      s.on('error', reject);
    });
  }

  it('records the gate\'s and a route\'s refusals (route, status, code, device prefix), and lets successes go unrecorded', async () => {
    const clock = { t: Date.now() };
    const gate: Gate = (req, res) => {
      if (req.url?.startsWith('/ok')) return true;
      if (req.url?.startsWith('/route-refuses')) return true;
      res.statusCode = 404; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: 'not-found' })); return false;
    };
    const dir = newDir();
    const l = new SameNetworkListener({
      stateDir: dir, agentName: 'Lan', machineName: 'box', mainPort: 4040, port: 0,
      app: (req, res) => {
        if (req.url?.startsWith('/route-refuses')) { res.statusCode = 403; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: 'cannot-approve-yet', detail: 'later' })); return; }
        res.end('ok');
      },
      gate, wsl: false, announce: false, bindHost: '0.0.0.0', observe: async () => HOME, now: () => clock.t,
    });
    listeners.push(l);
    expect((await l.openForOwner()).ok).toBe(true);
    const port = portOf(l);
    expect(await ask(port, '/ok')).toBe(200);
    expect(await ask(port, '/mobile/phone-setup/16ff8b30-1234-4abc-8def-0123456789ab?k=SECRETPIN')).toBe(404);
    expect(await ask(port, '/route-refuses', { 'X-Instar-Device': '4977bad9-12b7-4aae-93cc-1a7d61788676', 'X-Instar-Signature': 'SIGVALUE' })).toBe(403);
    const r = l.recentRefusals();
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ kind: 'request', reason: 'cannot-approve-yet', method: 'GET', route: '/route-refuses', status: 403, device: '4977bad9', from: '127.0.0.1' });
    expect(r[1]).toMatchObject({ kind: 'request', reason: 'not-found', route: '/mobile/phone-setup/:id', status: 404 });
    expect(r[1].device).toBeUndefined();
    await l.stop();
    const text = fs.readFileSync(path.join(dir, SAME_NETWORK_REFUSALS_FILE), 'utf8');
    for (const secret of ['SECRETPIN', 'SIGVALUE', '16ff8b30', '12b7-4aae']) expect(text).not.toContain(secret);
  });

  it('records a request whose caller hung up before any answer', async () => {
    const dir = newDir();
    const l = new SameNetworkListener({
      stateDir: dir, agentName: 'Lan', machineName: 'box', mainPort: 4040, port: 0,
      app: () => { /* never answers */ }, gate: () => true, wsl: false, announce: false, bindHost: '0.0.0.0', observe: async () => HOME,
    });
    listeners.push(l);
    expect((await l.openForOwner()).ok).toBe(true);
    const port = portOf(l);
    await new Promise<void>((resolve) => {
      const s = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
        s.write(`GET /mobile/conversations?x=1 HTTP/1.1\r\nHost: h\r\nX-Instar-Device: 4977bad9-12b7-4aae-93cc-1a7d61788676\r\n\r\n`);
        setTimeout(() => { s.destroy(); resolve(); }, 100);
      });
      s.on('error', () => undefined);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(l.recentRefusals()[0]).toMatchObject({ kind: 'request', reason: 'closed-before-answer', route: '/mobile/conversations', device: '4977bad9' });
  });

  it('records a connection refused by the per-address limit, and a failed TLS handshake', async () => {
    const clock = { t: Date.now() };
    const l = lan(clock);
    expect((await l.openForOwner()).ok).toBe(true);
    const port = portOf(l);
    // Fill this address's places directly, then a real connection is refused at the door.
    expect(take(l, '127.0.0.1', 24)).toBe(24);
    await new Promise<void>((resolve) => {
      const s = net.connect(port, '127.0.0.1');
      s.on('close', () => resolve()); s.on('error', () => undefined);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(l.recentRefusals()[0]).toMatchObject({ kind: 'connection', reason: 'address-open', from: '127.0.0.1' });
    release(l, '127.0.0.1', 24);
    // Not TLS at all: the handshake fails, and its code is kept.
    await new Promise<void>((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => { s.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n'); });
      s.on('close', () => resolve()); s.on('error', () => undefined);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const tlsEntry = l.recentRefusals().find((e) => e.kind === 'tls');
    expect(tlsEntry).toBeDefined();
    expect(tlsEntry!.reason).toMatch(/^tls-[a-z0-9-]+$/);
    expect(tlsEntry!.from).toBe('127.0.0.1');
  });
});
