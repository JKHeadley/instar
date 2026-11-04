/**
 * Console sign-in from an owner phone (docs/specs/mobile-console-device-signin.md): the stores,
 * the presence signature, the redeem gate (transport, switch, single use, Host, revocation) and the
 * audit trail, on both sides of every boundary. The HTTP pipeline is covered by the integration test.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BoundSecretStore, ConsoleTicketAudit, RedeemLimiter, CONSOLE_TICKET_TTL_MS, isConsoleTicketEnabled,
  mountConsoleTicketRedeemRoute, normalHost, presenceEnrollMessage, presenceMessage, samePublicKey, verifyPresenceSignature, consoleState,
} from '../../src/server/mobileConsoleTicket.js';
import { MobilePairingService, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
const services: MobilePairingService[] = [];
afterAll(() => {
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/mobile-console-ticket.test.ts' });
});
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mct-unit-')); dirs.push(d); return d; };

describe('BoundSecretStore', () => {
  it('issues 43-character base64url secrets, keeps only hashes, and consumes once', () => {
    const s = new BoundSecretStore();
    const a = s.issue('dev-1', 'Echo.Example');
    expect(a.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify([...(s as unknown as { entries: Map<string, unknown> }).entries])).not.toContain(a.secret);
    expect(s.consume(a.secret)).toEqual({ deviceId: 'dev-1', host: 'echo.example', ref: a.ref });
    expect(s.consume(a.secret)).toBeNull();
    expect(s.consume('nope')).toBeNull();
    expect(s.consume(42)).toBeNull();
  });

  it('expires at 60 seconds and an expired secret is gone after one look', () => {
    let t = 1_000;
    const s = new BoundSecretStore(() => t);
    const a = s.issue('d', 'h');
    t += CONSOLE_TICKET_TTL_MS - 1;
    const b = s.issue('d', 'h');
    expect(s.consume(a.secret)).not.toBeNull();
    t += 2;
    expect(s.consume(b.secret)).not.toBeNull(); // b issued later: still live
    const c = s.issue('d', 'h');
    t += CONSOLE_TICKET_TTL_MS;
    expect(s.consume(c.secret)).toBeNull();
  });

  it('caps live secrets at 4 per device and 64 in total, dropping the oldest', () => {
    const s = new BoundSecretStore();
    const mine = Array.from({ length: 5 }, () => s.issue('d', 'h'));
    expect(s.consume(mine[0]!.secret)).toBeNull();
    expect(s.consume(mine[4]!.secret)).not.toBeNull();
    const many = new BoundSecretStore();
    const first = many.issue('x-0', 'h');
    for (let i = 1; i <= 64; i++) many.issue(`x-${i}`, 'h');
    expect(many.size()).toBe(64);
    expect(many.consume(first.secret)).toBeNull();
  });
});

describe('presence signatures', () => {
  const key = makeDevice();
  it('accepts the key\'s own low-S signature over the exact message', () => {
    const m = presenceMessage('dev-1', 'Echo.Example', 'c'.repeat(43));
    expect(m).toBe(`instar-console-ticket-v1\ndev-1\necho.example\n${'c'.repeat(43)}`);
    expect(verifyPresenceSignature(key.publicKey, m, key.sign(m))).toBe(true);
  });
  it('refuses another key, another message, a high-S signature and malformed input', () => {
    const m = presenceMessage('dev-1', 'h', 'c');
    expect(verifyPresenceSignature(makeDevice().publicKey, m, key.sign(m))).toBe(false);
    expect(verifyPresenceSignature(key.publicKey, presenceMessage('dev-1', 'other', 'c'), key.sign(m))).toBe(false);
    expect(verifyPresenceSignature(key.publicKey, m, key.sign(m, true))).toBe(false);
    expect(verifyPresenceSignature(key.publicKey, m, 'not base64!')).toBe(false);
    expect(verifyPresenceSignature(key.publicKey, m, undefined)).toBe(false);
    expect(verifyPresenceSignature('bad-key', m, key.sign(m))).toBe(false);
  });
  it('the enrollment message binds device, host and key; keys compare as bytes', () => {
    expect(presenceEnrollMessage('d', 'H', 'K')).toBe('instar-presence-enroll-v1\nd\nh\nK');
    expect(samePublicKey(key.publicKey, key.publicKey)).toBe(true);
    expect(samePublicKey(key.publicKey, makeDevice().publicKey)).toBe(false);
    expect(samePublicKey('short', 'short')).toBe(false);
  });
});

describe('normalHost', () => {
  it('normalizes like the device authenticator and keeps hosts it cannot parse (an IP with a port)', () => {
    expect(normalHost('Echo.Example:443')).toBe('echo.example');
    expect(normalHost('echo.example.')).toBe('echo.example');
    // Found by the live browser proof: a phone paired on an address the strict parser rejects
    // must still match its own redeem.
    expect(normalHost('127.0.0.1:47000')).toBe('127.0.0.1:47000');
    expect(normalHost(undefined)).toBe('');
  });
});

describe('RedeemLimiter', () => {
  it('limits per address and in total within a minute, then resets', () => {
    let t = 0;
    const l = new RedeemLimiter(() => t, 2, 3);
    expect(l.admit('a')).toBe(true);
    expect(l.admit('a')).toBe(true);
    expect(l.admit('a')).toBe(false);
    expect(l.admit('b')).toBe(true);
    expect(l.admit('c')).toBe(false); // total
    t += 60_000;
    expect(l.admit('a')).toBe(true);
  });
});

describe('ConsoleTicketAudit', () => {
  it('writes metadata rows and aggregates unknown refusals at most once a minute', () => {
    let t = Date.parse('2026-11-03T00:00:00Z');
    const a = new ConsoleTicketAudit(tmp(), () => t);
    a.record({ event: 'minted', deviceId: 'd', ticketRef: 'abc' });
    a.unknownRefusal(); // first one flushes (no flush yet)
    a.unknownRefusal();
    a.unknownRefusal();
    t += 61_000;
    a.unknownRefusal();
    const rows = fs.readFileSync(a.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows[0]).toMatchObject({ event: 'minted', deviceId: 'd', ticketRef: 'abc' });
    expect(rows.filter((r) => r.event === 'refused-unknown').map((r) => r.count)).toEqual([1, 3]);
  });
  it('a failed write is reported, never thrown', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'state', 'mobile-console-tickets.jsonl'), { recursive: true });
    const errs: unknown[] = [];
    const a = new ConsoleTicketAudit(dir, Date.now, (e) => errs.push(e));
    expect(() => a.record({ event: 'redeemed', deviceId: 'd' })).not.toThrow();
    expect(errs).toHaveLength(1);
  });
});

describe('isConsoleTicketEnabled', () => {
  it('is on unless explicitly turned off', () => {
    expect(isConsoleTicketEnabled({} as never)).toBe(true);
    expect(isConsoleTicketEnabled({ mobilePairing: {} } as never)).toBe(true);
    expect(isConsoleTicketEnabled({ mobilePairing: { consoleTicket: { enabled: false } } } as never)).toBe(false);
  });
});

describe('the redeem handler', () => {
  function env(remoteAddress = '127.0.0.1', secure = false) {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'users.json'), '[]');
    const config = { projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', developmentAgent: true, mobilePairing: { multiRoute: { enabled: false } } };
    const deps: MobilePairingDeps = { config: config as never, stateDir: dir, holdsLease: () => true };
    const svc = new MobilePairingService(deps);
    services.push(svc);
    let handler: ((req: unknown, res: unknown) => void) | null = null;
    mountConsoleTicketRedeemRoute({ post: (_p: string, h: typeof handler) => { handler = h; } } as never, svc, () => config.authToken);
    const dev = makeDevice();
    const c = svc.devices.createPending({ deviceName: 'p', label: null, publicKey: dev.publicKey, host: 'echo.example' });
    if (!c.ok) throw new Error('setup');
    svc.devices.applyConfirm(c.device.id, { ok: true });
    const call = (body: unknown, host = 'echo.example') => {
      const out: { status: number; body: unknown } = { status: 200, body: null };
      const res = { setHeader: () => undefined, status(n: number) { out.status = n; return res; }, json(b: unknown) { out.body = b; return res; } };
      handler!({ body, headers: { host }, secure, socket: { remoteAddress }, ip: remoteAddress }, res);
      return out;
    };
    return { svc, config, deviceId: c.device.id, call };
  }

  it('returns only the token for a live ticket, once', () => {
    const e = env();
    const t = consoleState(e.svc).tickets.issue(e.deviceId, 'echo.example');
    expect(e.call({ ticket: t.secret })).toEqual({ status: 200, body: { token: 'tok-1' } });
    expect(e.call({ ticket: t.secret }).status).toBe(401);
  });
  it('refuses plain HTTP from a non-loopback peer even with a live ticket', () => {
    const e = env('192.168.1.20', false);
    const t = consoleState(e.svc).tickets.issue(e.deviceId, 'echo.example');
    expect(e.call({ ticket: t.secret }).status).toBe(403);
    // The refusal did not consume it (nothing was judged).
    expect(consoleState(e.svc).tickets.consume(t.secret)).not.toBeNull();
  });
  it('accepts a TLS socket from a remote peer', () => {
    const e = env('192.168.1.20', true);
    const t = consoleState(e.svc).tickets.issue(e.deviceId, 'echo.example');
    expect(e.call({ ticket: t.secret }).status).toBe(200);
  });
  it('refuses another Host, a revoked phone, a switched-off feature and a missing body', () => {
    const e = env();
    const st = consoleState(e.svc);
    expect(e.call({ ticket: st.tickets.issue(e.deviceId, 'echo.example').secret }, 'evil.example').status).toBe(401);
    expect(e.call({}).status).toBe(400);
    const live = st.tickets.issue(e.deviceId, 'echo.example');
    (e.config.mobilePairing as Record<string, unknown>).consoleTicket = { enabled: false };
    expect(e.call({ ticket: live.secret }).status).toBe(503);
    (e.config.mobilePairing as Record<string, unknown>).consoleTicket = { enabled: true };
    const t = st.tickets.issue(e.deviceId, 'echo.example');
    e.svc.devices.revoke(e.deviceId);
    expect(e.call({ ticket: t.secret })).toEqual({ status: 401, body: { error: 'device-not-active' } });
  });
});
