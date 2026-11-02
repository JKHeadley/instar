/** Unit: this machine's own names (docs/specs/mobile-multi-route.md §4.1, §4.2). */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  MobileOwnNames, normalizeRequestHost, tailscaleSelfName, serveStateFor, BREAKER_FAILURES, BREAKER_RESUME_MS,
  HEALTHY_INTERVAL_MS, MAX_BACKOFF_MS, type MobileOwnNamesDeps, type TailscaleExec,
} from '../../src/core/MobileOwnNames.js';
import { canonicalString, verifyDeviceRequest, ReplayGuard } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const TS = 'studio.tail1234.ts.net';
const CF = 'echo.example.dev';
const PORT = 4042;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/mobile-own-names.test.ts' }); });

const statusJson = (o: Record<string, unknown> = {}) => JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${TS}.` }, CertDomains: [TS], ...o });
const serveJson = (port = PORT, host = TS) => JSON.stringify({ TCP: { '443': { HTTPS: true } }, Web: { [`${host}:443`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } } });

const answer = (n: string) => crypto.createHash('sha256').update('secret' + n).digest('hex');

interface World {
  tunnel: string | null;
  status: string | Error;
  serve: string | Error;
  /** host → ping response, given the nonce. */
  ping: (host: string, nonce: string) => { status: number; body: unknown } | Error;
  siblings: Set<string>;
  devices: string[];
  execCalls: string[][];
  t: number;
}

function make(world: Partial<World> = {}, extra: Partial<MobileOwnNamesDeps> = {}, dir?: string) {
  if (!dir) { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-names-')); dirs.push(dir); }
  const w: World = {
    tunnel: CF, status: statusJson(), serve: serveJson(), siblings: new Set(), devices: [], execCalls: [], t: 1_800_000_000_000,
    ping: (host, n) => ({ status: 200, body: { h: answer(n), host, arrival: 'local-tls' } }),
    ...world,
  };
  const reports: string[] = [];
  const exec: TailscaleExec = async (args) => {
    w.execCalls.push(args);
    const v = args[0] === 'status' ? w.status : args[0] === 'serve' && args[1] === 'status' ? w.serve : '';
    if (v instanceof Error) throw v;
    return v;
  };
  let fetches = 0;
  const fetchFn = (async (url: string) => {
    fetches++;
    const u = new URL(url);
    const r = w.ping(u.hostname, u.searchParams.get('n')!);
    if (r instanceof Error) throw r;
    return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
  const names = new MobileOwnNames({
    stateDir: dir, port: PORT, tunnelHost: () => w.tunnel, activeDeviceHosts: () => w.devices,
    issueNonce: () => crypto.randomBytes(18).toString('base64url'), expectedAnswer: answer,
    siblingClaims: (h) => w.siblings.has(h), pingPath: '/mobile/pairing-codes/ping', exec, fetchFn,
    reportDegradation: (what) => { reports.push(what); }, now: () => w.t, ...extra,
  });
  return { names, w, reports, dir, fetches: () => fetches };
}

describe('host normalisation', () => {
  it('lowercases and strips a default :443 and a trailing dot; other ports stay', () => {
    expect(normalizeRequestHost('Studio.Tail1234.TS.net:443')).toBe(TS);
    expect(normalizeRequestHost(`${TS}.`)).toBe(TS);
    expect(normalizeRequestHost(`${TS}:8443`)).toBeNull();
    expect(normalizeRequestHost(undefined)).toBeNull();
  });
});

describe('candidate reading', () => {
  it('a Tailscale name not in CertDomains is not a candidate', () => {
    expect(tailscaleSelfName(statusJson({ CertDomains: [] }))).toEqual({ reason: 'tailscale-name-not-in-cert-domains' });
    expect(tailscaleSelfName(statusJson())).toEqual({ host: TS });
    expect(tailscaleSelfName(statusJson({ BackendState: 'Stopped' }))).toEqual({ reason: 'tailscale-not-running' });
  });

  it('serve must map HTTPS 443 to this agent port', () => {
    expect(serveStateFor(serveJson(), TS, PORT, false)).toBe('ours');
    expect(serveStateFor(serveJson(9999), TS, PORT, false)).toBe('other');
    expect(serveStateFor('{}', TS, PORT, false)).toBe('none');
    expect(serveStateFor(JSON.stringify({ TCP: { '443': { HTTPS: true } }, Web: { [`${TS}:443`]: { Handlers: { '/': { Proxy: 'http://172.20.1.2:4042' } } } } }), TS, PORT, false)).toBe('other');
    // WSL: the Windows serve may forward to the WSL address.
    expect(serveStateFor(JSON.stringify({ TCP: { '443': { HTTPS: true } }, Web: { [`${TS}:443`]: { Handlers: { '/': { Proxy: 'http://172.20.1.2:4042' } } } } }), TS, PORT, true)).toBe('ours');
  });

  it('reads both candidates from local sources; serve on another port drops the Tailscale one', async () => {
    const a = make();
    const r = await a.names.readCandidates();
    expect(r.candidates.map((c) => `${c.kind}:${c.host}`)).toEqual([`cloudflare:${CF}`, `tailscale:${TS}`]);
    const b = make({ serve: serveJson(1234) });
    const rb = await b.names.readCandidates();
    expect(rb.candidates.map((c) => c.kind)).toEqual(['cloudflare']);
    expect(rb.problems).toEqual([{ kind: 'tailscale', reason: 'tailscale-serve-other-target' }]);
  });

  it('under WSL the Tailscale CLI is tailscale.exe (the injected exec is what runs)', async () => {
    const calls: string[][] = [];
    const a = make({}, { isWsl: true, exec: async (args) => { calls.push(args); return args[0] === 'status' ? statusJson() : JSON.stringify({ TCP: { '443': {} }, Web: { [`${TS}:443`]: { Handlers: { '/': { Proxy: 'http://localhost:4042' } } } } }); } });
    const r = await a.names.readCandidates();
    expect(r.candidates.some((c) => c.kind === 'tailscale')).toBe(true);
    expect(calls).toEqual([['status', '--json'], ['serve', 'status', '--json']]);
  });
});

describe('proof', () => {
  it('a proven candidate becomes an own name with firstVerifiedAt', async () => {
    const { names } = make();
    await names.tick();
    expect(names.listed().map((n) => n.host).sort()).toEqual([CF, TS].sort());
    expect(names.accepts(TS)).toBe(true);
    expect(names.routes()[0]).toMatchObject({ kind: 'tailscale', origin: `https://${TS}`, lastProbeOk: true });
  });

  it.each([
    ['another process answers', (host: string) => ({ status: 200, body: { h: '0'.repeat(64), host, arrival: 'local-tls' } }), 'another-process'],
    ['the Host is not echoed', (_h: string, n: string) => ({ status: 200, body: { h: answer(n), host: 'other.example', arrival: 'local-tls' } }), 'host-not-echoed'],
    ['not a local TLS arrival', (host: string, n: string) => ({ status: 200, body: { h: answer(n), host, arrival: 'other' } }), 'not-local-tls'],
  ])('refuses when %s', async (_l, ping, reason) => {
    const { names } = make({ ping: ping as World['ping'] });
    await names.tick();
    expect(names.listed()).toHaveLength(0);
    const cand = (names.healthSnapshot().candidates as Array<{ host: string | null; lastFailure: string }>).find((c) => c.host === TS);
    expect(cand?.lastFailure).toBe(reason);
  });

  it('refuses when a sibling machine claims the name', async () => {
    const { names } = make({ siblings: new Set([TS]) });
    await names.tick();
    expect(names.listed().map((n) => n.host)).toEqual([CF]);
  });
});

describe('identity vs health', () => {
  it('a listed name leaves at once when its local source drops it', async () => {
    const ctx = make();
    await ctx.names.tick();
    const v1 = ctx.names.version;
    ctx.w.serve = '{}';
    await ctx.names.refreshCandidates();
    expect(ctx.names.listed().map((n) => n.host)).toEqual([CF]);
    expect(ctx.names.accepts(TS)).toBe(false);
    expect(ctx.names.version).toBeGreaterThan(v1);
    // The Cloudflare name leaves the instant the live config stops naming it.
    ctx.w.tunnel = 'new.example.dev';
    expect(ctx.names.accepts(CF)).toBe(false);
  });

  it('a failed or unreadable Tailscale command does not remove a listed name (unknown is not absent)', async () => {
    const ctx = make();
    await ctx.names.tick();
    ctx.w.status = new Error('timed out');
    await ctx.names.refreshCandidates();
    expect(ctx.names.accepts(TS)).toBe(true);
    ctx.w.status = statusJson();
    ctx.w.serve = 'not json';
    await ctx.names.refreshCandidates();
    expect(ctx.names.accepts(TS)).toBe(true);
    // Positive evidence (Tailscale stopped) removes it at once.
    ctx.w.status = statusJson({ BackendState: 'Stopped' });
    await ctx.names.refreshCandidates();
    expect(ctx.names.accepts(TS)).toBe(false);
  });

  it('after a restart, an unknown first Tailscale read keeps the persisted name; a removed binary drops it', async () => {
    const a = make();
    await a.names.tick();
    const b = make({ status: new Error('timed out') }, {}, a.dir);
    await b.names.refreshCandidates();
    expect(b.names.accepts(TS)).toBe(true);
    const gone = Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT' });
    b.w.status = gone;
    await b.names.refreshCandidates();
    expect(b.names.accepts(TS)).toBe(false);
  });

  it('a listed name leaves at once when another process answers', async () => {
    const ctx = make();
    await ctx.names.tick();
    ctx.w.ping = (host) => ({ status: 200, body: { h: 'f'.repeat(64), host, arrival: 'local-tls' } });
    ctx.w.t += HEALTHY_INTERVAL_MS;
    await ctx.names.tick();
    expect(ctx.names.listed()).toHaveLength(0);
  });

  it('a request on a listed name is accepted while every outbound probe fails', async () => {
    const ctx = make();
    await ctx.names.tick();
    ctx.w.ping = () => new Error('down');
    for (let i = 0; i < 3; i++) { ctx.w.t += MAX_BACKOFF_MS; await ctx.names.tick(); }
    expect(ctx.names.routes().every((r) => r.lastProbeOk === false)).toBe(true);
    expect(ctx.names.accepts(TS)).toBe(true);
    expect(ctx.names.accepts(CF)).toBe(true);
  });
});

describe('probe brakes', () => {
  it('backs off, stops after the breaker count with one degradation, resumes after 24 h', async () => {
    const ctx = make({ ping: () => new Error('down') }, {}, undefined);
    await ctx.names.tick();
    // Backoff: the next probe is not due before 2 × 60 s.
    const before = ctx.fetches();
    ctx.w.t += HEALTHY_INTERVAL_MS;
    await ctx.names.tick();
    expect(ctx.fetches()).toBe(before);
    for (let i = 0; i < 20; i++) { ctx.w.t += MAX_BACKOFF_MS; await ctx.names.tick(); }
    const snap = ctx.names.healthSnapshot().candidates as Array<{ host: string | null; consecutiveFailures: number; probingPaused: boolean }>;
    const ts = snap.find((c) => c.host === TS)!;
    expect(ts.consecutiveFailures).toBe(BREAKER_FAILURES);
    expect(ts.probingPaused).toBe(true);
    expect(ctx.reports.filter((r) => r === 'MobileRoutes.probe')).toHaveLength(2); // one per name (tailscale + cloudflare)
    const stoppedAt = ctx.fetches();
    ctx.w.t += MAX_BACKOFF_MS;
    await ctx.names.tick();
    expect(ctx.fetches()).toBe(stoppedAt);
    ctx.w.ping = (host, n) => ({ status: 200, body: { h: answer(n), host, arrival: 'local-tls' } });
    ctx.w.t += BREAKER_RESUME_MS;
    await ctx.names.tick();
    expect(ctx.names.listed()).toHaveLength(2);
  });

  it('one probe per name in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    const ctx = make({}, {
      fetchFn: (async (url: string) => { calls++; await gate; const u = new URL(url); const n = u.searchParams.get('n')!; return { ok: true, status: 200, json: async () => ({ h: answer(n), host: u.hostname, arrival: 'local-tls' }) } as unknown as Response; }) as unknown as typeof fetch,
    });
    await ctx.names.refreshCandidates();
    const p1 = ctx.names.probe('tailscale', TS);
    const p2 = ctx.names.probe('tailscale', TS);
    release();
    await Promise.all([p1, p2]);
    expect(calls).toBe(1);
  });

  it('a source change resets the breaker', async () => {
    const ctx = make({ ping: () => new Error('down') });
    for (let i = 0; i < 12; i++) { await ctx.names.tick(); ctx.w.t += MAX_BACKOFF_MS; }
    ctx.w.ping = (host, n) => ({ status: 200, body: { h: answer(n), host, arrival: 'local-tls' } });
    ctx.w.serve = serveJson(); // unchanged: still paused
    ctx.w.t += 1;
    await ctx.names.refreshCandidates();
    await ctx.names.tick();
    expect(ctx.names.listed()).toHaveLength(0);
    ctx.w.tunnel = 'echo2.example.dev';
    await ctx.names.refreshCandidates();
    await ctx.names.tick();
    expect(ctx.names.listed().map((n) => n.host)).toEqual(['echo2.example.dev']);
  });
});

describe('upgrade seed and version', () => {
  it('seeds the tunnel host on first boot when an active device carries it', () => {
    const { names } = make({ devices: [CF], ping: () => new Error('down') });
    expect(names.listed()).toMatchObject([{ kind: 'cloudflare', host: CF, seeded: true }]);
    expect(names.accepts(CF)).toBe(true);
    const none = make({ devices: ['someone.else'] });
    expect(none.names.listed()).toHaveLength(0);
  });

  it('only on first boot: an existing file is never re-seeded', async () => {
    const a = make({ devices: [] });
    const again = make({ devices: [CF] }, {}, a.dir);
    expect(again.names.listed()).toHaveLength(0);
  });

  it('version moves forward after a restart with a lost counter', async () => {
    const a = make();
    await a.names.tick();
    const v = a.names.version;
    SafeFsExecutor.safeUnlinkSync(a.names.file, { operation: 'tests/unit/mobile-own-names.test.ts' }); // the counter is lost
    const b = make({ t: a.w.t + 1_000 }, {}, a.dir); // a restart, a second later
    await b.names.tick();
    expect(b.names.version).toBeGreaterThan(v);
    expect(b.names.version).toBeGreaterThanOrEqual(b.w.t);
  });
});

describe('tailscale serve boot step', () => {
  it('configures 443 only when it has no serve config, and is idempotent', async () => {
    const ctx = make({ serve: '{}' });
    expect(await ctx.names.ensureServe()).toBe('configured');
    expect(ctx.w.execCalls.at(-1)).toEqual(['serve', '--bg', '--https=443', `http://127.0.0.1:${PORT}`]);
    ctx.w.serve = serveJson();
    const n = ctx.w.execCalls.length;
    expect(await ctx.names.ensureServe()).toBe('ours');
    expect(ctx.w.execCalls.slice(n).every((a) => a[0] === 'status' || a[1] === 'status')).toBe(true);
  });

  it('never overwrites a different 443 config; reports it', async () => {
    const ctx = make({ serve: serveJson(8080) });
    expect(await ctx.names.ensureServe()).toBe('other');
    expect(ctx.w.execCalls.some((a) => a[0] === 'serve' && a[1] === '--bg')).toBe(false);
    expect((ctx.names.healthSnapshot().tailscaleServe as { state: string }).state).toBe('other');
  });
});

describe('verifyDeviceRequest host', () => {
  it('flag off ignores the request Host: the stored paired host is used', () => {
    const dev = makeDevice();
    const id = 'dev-12345678';
    const t = String(Date.now());
    const lookup = () => ({ publicKey: dev.publicKey, host: CF, status: 'active' as const });
    const sigCf = dev.sign(canonicalString(id, CF, 'GET', '/sessions', t, undefined));
    expect(verifyDeviceRequest({ deviceId: id, time: t, sig: sigCf, method: 'GET', pathWithQuery: '/sessions', rawBody: undefined }, lookup, new Set(['active']), new ReplayGuard()).ok).toBe(true);
    const sigTs = dev.sign(canonicalString(id, TS, 'GET', '/sessions', t, undefined));
    expect(verifyDeviceRequest({ deviceId: id, time: t, sig: sigTs, method: 'GET', pathWithQuery: '/sessions', rawBody: undefined }, lookup, new Set(['active']), new ReplayGuard()).ok).toBe(false);
    // With a host given (multi-route), the signature over that host verifies.
    expect(verifyDeviceRequest({ deviceId: id, time: t, sig: sigTs, method: 'GET', pathWithQuery: '/sessions', rawBody: undefined, host: TS }, lookup, new Set(['active']), new ReplayGuard()).ok).toBe(true);
  });
});

describe('gate', () => {
  it('multi-route is on only with phone pairing on; omitted ⇒ development agent only', async () => {
    const { isMobileMultiRouteEnabled } = await import('../../src/server/mobilePairingRoutes.js');
    expect(isMobileMultiRouteEnabled({ developmentAgent: true } as never)).toBe(true);
    expect(isMobileMultiRouteEnabled({ developmentAgent: false } as never)).toBe(false);
    expect(isMobileMultiRouteEnabled({ developmentAgent: true, mobilePairing: { enabled: false } } as never)).toBe(false);
    expect(isMobileMultiRouteEnabled({ developmentAgent: true, mobilePairing: { multiRoute: { enabled: false } } } as never)).toBe(false);
    expect(isMobileMultiRouteEnabled({ developmentAgent: false, mobilePairing: { enabled: true, multiRoute: { enabled: true } } } as never)).toBe(true);
  });

  it('probing pauses while phone pairing is switched off', async () => {
    let on = false;
    const ctx = make({}, { active: () => on });
    await ctx.names.tick();
    expect(ctx.fetches()).toBe(0);
    on = true;
    await ctx.names.tick();
    expect(ctx.fetches()).toBeGreaterThan(0);
  });
});

describe('device authenticator with multi-route on (spec 4.2)', () => {
  async function svcWithNames(pingWorks: boolean) {
    const { MobilePairingService, deviceAuthenticator } = await import('../../src/server/mobilePairingRoutes.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-names-auth-'));
    dirs.push(dir);
    const config = { projectName: 'echo', projectDir: dir, stateDir: dir, port: PORT, authToken: 't', developmentAgent: true, tunnel: { type: 'named', hostname: CF } } as never;
    const fetchFn = (async (url: string) => {
      if (!pingWorks) throw new Error('down');
      const u = new URL(url);
      const { pingAnswer } = await import('../../src/core/MobilePairing.js');
      return { ok: true, status: 200, json: async () => ({ h: pingAnswer(u.searchParams.get('n')!), host: u.hostname, arrival: 'local-tls' }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const exec: TailscaleExec = async (args) => (args[0] === 'status' ? statusJson() : serveJson());
    const svc = new MobilePairingService({ config, stateDir: dir, fetchFn, tailscaleExec: exec });
    const dev = makeDevice();
    // An active device paired on the tunnel host (written as the registry would hold it).
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    const id = 'dev-abcdef12';
    fs.writeFileSync(svc.devices.file, JSON.stringify({ devices: [{ id, deviceName: 'p', label: null, pairedAt: new Date().toISOString(), status: 'active', publicKey: dev.publicKey, host: CF }] }));
    return { svc, auth: deviceAuthenticator(svc), dev, id };
  }
  const req = (dev: ReturnType<typeof makeDevice>, id: string, host: string, remoteAddress: string, signHost = host) => {
    const t = String(Date.now());
    return {
      method: 'GET', path: '/sessions', originalUrl: '/sessions', secure: false, socket: { remoteAddress },
      headers: { host, 'x-instar-device': id, 'x-instar-device-time': t, 'x-instar-device-sig': dev.sign(canonicalString(id, signHost, 'GET', '/sessions', t, undefined)) },
    } as never;
  };
  const res = () => { const r = { code: 0, body: null as unknown, status(c: number) { r.code = c; return r; }, json(b: unknown) { r.body = b; return r; } }; return r; };

  it('a request through the local front on a listed own name is accepted while every outbound probe fails', async () => {
    const { svc, auth, dev, id } = await svcWithNames(true);
    await svc.ownNames!.tick(); // proves both names
    // From now on every outbound probe fails.
    svc.ownNames!['deps'].fetchFn = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    svc.ownNames!['probes'].forEach((p: { nextProbeAt: number }) => { p.nextProbeAt = 0; });
    await svc.ownNames!.tick();
    expect(svc.ownNames!.routes().every((r) => r.lastProbeOk === false)).toBe(true);
    expect(auth(req(dev, id, TS, '127.0.0.1'), res() as never)).toBe('ok');
    expect(auth(req(dev, id, `${CF}:443`, '127.0.0.1', CF), res() as never)).toBe('ok');
    svc.stop();
  });

  it('a request for an own name that did not arrive through a local front is refused', async () => {
    const { svc, auth, dev, id } = await svcWithNames(true);
    await svc.ownNames!.tick();
    const r = res();
    expect(auth(req(dev, id, TS, '100.101.102.103'), r as never)).toBe('refused');
    expect(r.code).toBe(401);
    expect(r.body).toEqual({ error: 'device-unauthorized' });
    svc.stop();
  });

  it('the upgrade seed keeps an existing phone working with no probe ever passing', async () => {
    const { svc, auth, dev, id } = await svcWithNames(false);
    // The registry was written after construction in this helper, so seed explicitly the way a
    // first boot with an existing device does: a fresh service over the same state dir.
    SafeFsExecutor.safeUnlinkSync(svc.ownNames!.file, { operation: 'tests/unit/mobile-own-names.test.ts' });
    const { MobilePairingService, deviceAuthenticator } = await import('../../src/server/mobilePairingRoutes.js');
    const svc2 = new MobilePairingService({ ...svc.deps });
    expect(svc2.ownNames!.listed()).toMatchObject([{ host: CF, seeded: true }]);
    expect(deviceAuthenticator(svc2)(req(dev, id, CF, '127.0.0.1'), res() as never)).toBe('ok');
    svc.stop(); svc2.stop();
    void auth;
  });
});
