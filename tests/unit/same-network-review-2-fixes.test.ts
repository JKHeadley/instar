/**
 * Identity A4/A5: fixes from the second outside (GPT) review, each with both sides of its boundary.
 *  1. The auth middleware requires a verified device signature for anything that arrived on the
 *     same-network listener except the pairing redeem and ping, even with no agent token configured.
 *  2. A phone paired on the home address, or let in at the computer, is never a document device
 *     (local record or replicated activation row).
 *  3. An approval push is never sent to a phone let in at the computer, on iPhone or Android.
 *  4. The ceremony credential: a spend or a refusal removes only the file it checked; a newer one
 *     minted meanwhile survives; wrong tries never rewrite the file.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Request, Response } from 'express';
import { authMiddleware } from '../../src/server/middleware.js';
import { markSameNetworkSocket, isSameNetworkPublicRoute } from '../../src/core/requestArrival.js';
import { notADocumentDevice, notADocumentDeviceRow } from '../../src/server/documentPageRoutes.js';
import { DeviceRegistry } from '../../src/core/MobileDeviceKeys.js';
import { MobilePushService, type ApnsTransport } from '../../src/core/MobilePush.js';
import { ceremonyCredentialPath, mintCeremonyCredential, spendCeremonyCredential, CEREMONY_CREDENTIAL_MAX_FAILURES, CEREMONY_TRIES_FILE } from '../../src/core/ceremonyCredential.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/same-network-review-2-fixes.test.ts' }); });
const newDir = (p: string): string => { const d = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), p)); dirs.push(d); return d; };

describe('1. the auth middleware on the same-network listener', () => {
  function req(opts: { path: string; method?: string; device?: string; home?: boolean }): Request {
    const socket = { remoteAddress: '192.168.1.50' } as never;
    if (opts.home !== false) markSameNetworkSocket(socket);
    return { path: opts.path, method: opts.method ?? 'GET', headers: opts.device ? { 'x-instar-device': opts.device } : {}, query: {}, socket } as unknown as Request;
  }
  function res(): Response & { statusCode: number } {
    const r = { statusCode: 0 } as Response & { statusCode: number };
    r.status = ((n: number) => { r.statusCode = n; return r; }) as Response['status'];
    r.json = (() => r) as Response['json'];
    return r;
  }
  const run = (token: string | undefined, rq: Request, verdict: 'none' | 'ok' | 'refused' | null) => {
    let nexted = false;
    const r = res();
    const mw = authMiddleware(() => token, 'a', undefined, verdict === null ? undefined : (() => verdict));
    mw(rq, r, () => { nexted = true; });
    return { nexted, status: r.statusCode };
  };

  for (const token of [undefined, '', 'tok']) {
    it(`with token ${JSON.stringify(token)}: unsigned requests reach only the redeem and ping`, () => {
      expect(run(token, req({ path: '/mobile/pairing-codes/redeem', method: 'POST' }), 'none').nexted).toBe(true);
      expect(run(token, req({ path: '/mobile/pairing-codes/ping' }), 'none').nexted).toBe(true);
      for (const p of ['/sessions', '/mobile/routes', '/docs/x', '/health/full', '/mobile/pairing-codes/redeem']) {
        const r = run(token, req({ path: p }), 'none');
        expect(r.nexted, p).toBe(false);
        expect(r.status, p).toBe(404);
      }
    });

    it(`with token ${JSON.stringify(token)}: a device id without a verified signature reaches nothing`, () => {
      expect(run(token, req({ path: '/sessions', device: 'd1' }), 'none')).toEqual({ nexted: false, status: 401 });
      expect(run(token, req({ path: '/sessions', device: 'd1' }), 'refused').nexted).toBe(false);
      expect(run(token, req({ path: '/sessions', device: 'd1' }), null)).toEqual({ nexted: false, status: 404 });
      expect(run(token, req({ path: '/internal/x', device: 'd1' }), 'ok').nexted).toBe(false);
      expect(run(token, req({ path: '/sessions', device: 'd1' }), 'ok').nexted).toBe(true);
    });
  }

  it('the main listener with no token keeps its old behaviour (positive control for the arrival test)', () => {
    expect(run(undefined, req({ path: '/sessions', home: false }), 'none').nexted).toBe(true);
  });

  it('the public route list matches only the exact method and path', () => {
    expect(isSameNetworkPublicRoute('post', '/mobile/pairing-codes/redeem/')).toBe(true);
    expect(isSameNetworkPublicRoute('GET', '/mobile/pairing-codes/redeem')).toBe(false);
    expect(isSameNetworkPublicRoute('HEAD', '/mobile/pairing-codes/ping')).toBe(false);
    expect(isSameNetworkPublicRoute('GET', '/mobile/pairing-codes/ping/x')).toBe(false);
  });
});

describe('2. document devices', () => {
  it('a home phone or an at-computer phone is never one; others are', () => {
    expect(notADocumentDevice({ addressKind: 'same-network' })).toBe(true);
    expect(notADocumentDevice({ admission: 'at-computer' })).toBe(true);
    expect(notADocumentDevice({ approvedVia: 'at-computer' })).toBe(true);
    expect(notADocumentDevice({ approvedVia: 'telegram-dm' })).toBe(false);
    expect(notADocumentDevice({})).toBe(false);
  });

  it('the replicated row: its approval way, or a home host', () => {
    expect(notADocumentDeviceRow({ approvedVia: 'at-computer', host: 'agent.example.ts.net' })).toBe(true);
    expect(notADocumentDeviceRow({ approvedVia: 'telegram-dm', host: 'echo-pc.local:24040' })).toBe(true);
    expect(notADocumentDeviceRow({ approvedVia: 'telegram-dm', host: 'agent.example.ts.net' })).toBe(false);
    expect(notADocumentDeviceRow({ approvedVia: 'dashboard-pin', host: 'x.trycloudflare.com:443' })).toBe(false);
  });

  it('the production lookup uses both (wiring)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/server/AgentServer.ts'), 'utf8');
    expect(src).toMatch(/if \(notADocumentDevice\(d\)\) return null;/);
    expect(src).toMatch(/if \(notADocumentDeviceRow\(act\)\) return null;/);
    // The decision root delegates to documentDecisionRootOf (behaviour in same-network-review-4-fixes.test.ts).
    expect(src).toMatch(/return documentDecisionRootOf\(\{/);
  });
});

describe('3. approval pushes', () => {
  it('an at-computer iPhone or Android phone gets conversation pushes but never an approval notice', async () => {
    const dir = newDir('snp2-');
    const reg = new DeviceRegistry(dir, () => Date.parse('2026-11-20T10:00:00Z'));
    const mk = (name: string, admission: boolean, provider: 'apns' | 'fcm') => {
      const c = reg.createPending({ deviceName: name, label: null, publicKey: crypto.randomBytes(65).toString('base64url'), host: 'h', ...(admission ? { admission: 'at-computer' as const } : {}) });
      if (!c.ok) throw new Error('setup');
      reg.applyConfirm(c.device.id, { ok: true, approvedVia: admission ? 'at-computer' : 'telegram-dm' });
      reg.setPush(c.device.id, provider === 'apns'
        ? { token: crypto.randomBytes(32).toString('hex'), environment: 'sandbox', notifyTokenHash: 'a'.repeat(64), revision: 1 }
        : { token: `fcm-${name}-${'x'.repeat(140)}`, provider: 'fcm', notifyTokenHash: 'a'.repeat(64), revision: 1 });
      return c.device.id;
    };
    const atIphone = mk('at-iphone', true, 'apns');
    const okIphone = mk('ok-iphone', false, 'apns');
    const sentTo: string[] = [];
    const transport: ApnsTransport = async (_e, _t, _h, body) => { sentTo.push(JSON.parse(body).instar.deviceId); return { status: 200 }; };
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const svc = new MobilePushService({
      notificationReader: () => 'owner', canonicalReplyRef: (key: string) => `app:${key}`, mutedFor: () => false, mayNotify: () => true,
      stateDir: dir, registry: reg, agentId: 'echo', agentName: 'Echo', machineId: 'm1', enabled: () => true,
      credentials: () => ({ keyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), keyId: 'K', teamId: 'T' }),
      transport, canApprove: (id) => id !== atIphone, now: () => Date.parse('2026-11-20T10:00:00Z'),
    } as never);
    await svc.receive({ kind: 'notice', subject: 'phone-approval', dedupeKey: 'pairing-request:x', sourceMachine: 'm1' } as never, false);
    expect(sentTo).toContain(okIphone);
    expect(sentTo).not.toContain(atIphone);
  });
});

describe('4. the ceremony credential and a mint at the same time', () => {
  const M = 'm_self';
  const mint = (d: string) => mintCeremonyCredential(d, { scope: 'phone-setup', machineId: M }).credential;
  const spend = (d: string, c: unknown) => spendCeremonyCredential(d, c, { scope: 'phone-setup', machineId: M });

  it('wrong tries never rewrite the file (so a newer mint is never overwritten); the third removes only the checked file', () => {
    const d = newDir('icc2-');
    mint(d);
    const file = ceremonyCredentialPath(d);
    const before = fs.statSync(file);
    expect(spend(d, 'icc1_wrong1')).toEqual({ ok: false, reason: 'wrong' });
    const after = fs.statSync(file);
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
    for (let i = 1; i < CEREMONY_CREDENTIAL_MAX_FAILURES; i++) spend(d, `icc1_wrong${i + 1}`);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('wrong tries survive a restart: the same credential does not get three more', async () => {
    const d = newDir('icc3-');
    mint(d);
    const file = ceremonyCredentialPath(d);
    for (let i = 1; i < CEREMONY_CREDENTIAL_MAX_FAILURES; i++) expect(spend(d, `icc1_wrong${i}`)).toEqual({ ok: false, reason: 'wrong' });
    expect(fs.existsSync(file)).toBe(true);
    // A restart: a fresh copy of the module, with an empty in-memory count.
    vi.resetModules();
    const fresh = await import('../../src/core/ceremonyCredential.js');
    expect(fresh.spendCeremonyCredential(d, 'icc1_wrong-after-restart', { scope: 'phone-setup', machineId: M })).toEqual({ ok: false, reason: 'wrong' });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('a newer credential starts its own count; a spend clears the count', () => {
    const d = newDir('icc3-');
    mint(d);
    expect(spend(d, 'icc1_wrong1').ok).toBe(false);
    const c = mint(d);
    for (let i = 1; i < CEREMONY_CREDENTIAL_MAX_FAILURES; i++) expect(spend(d, `icc1_wrong${i}`)).toEqual({ ok: false, reason: 'wrong' });
    expect(fs.existsSync(ceremonyCredentialPath(d))).toBe(true);
    expect(spend(d, c)).toEqual({ ok: true });
    expect(fs.existsSync(path.join(d, CEREMONY_TRIES_FILE))).toBe(false);
  });

  it('the checked handle stays open until the file is taken aside (its inode cannot be reused by a newer file)', () => {
    const d = newDir('icc3-');
    const c = mint(d);
    const order: string[] = [];
    const realRename = fs.renameSync; const realClose = fs.closeSync;
    (fs as { renameSync: typeof fs.renameSync }).renameSync = ((from: fs.PathLike, to: fs.PathLike) => { if (String(to).endsWith('.claimed')) order.push('claim'); return realRename(from, to); }) as typeof fs.renameSync;
    (fs as { closeSync: typeof fs.closeSync }).closeSync = ((fd: number) => { order.push('close'); return realClose(fd); }) as typeof fs.closeSync;
    try { expect(spend(d, c)).toEqual({ ok: true }); } finally {
      (fs as { renameSync: typeof fs.renameSync }).renameSync = realRename; (fs as { closeSync: typeof fs.closeSync }).closeSync = realClose;
    }
    expect(order.indexOf('claim')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('claim')).toBeLessThan(order.lastIndexOf('close'));
  });

  it('a credential spent by another caller first: the second presentation is refused', () => {
    const d = newDir('icc2-');
    const c = mint(d);
    expect(spend(d, c)).toEqual({ ok: true });
    expect(spend(d, c).ok).toBe(false);
  });

  it('a newer credential that replaced the checked one between check and removal is left in place', () => {
    const d = newDir('icc2-');
    const old = mint(d);
    const file = ceremonyCredentialPath(d);
    // Mint again in the window after the check: simulate by swapping the file on the first rename.
    const realRename = fs.renameSync;
    let fresh = '';
    let swapped = false;
    (fs as { renameSync: typeof fs.renameSync }).renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      if (!swapped && String(from) === file && String(to).endsWith('.claimed')) { swapped = true; (fs as { renameSync: typeof fs.renameSync }).renameSync = realRename; fresh = mint(d); }
      return realRename(from, to);
    }) as typeof fs.renameSync;
    try {
      expect(spend(d, old).ok).toBe(false);
    } finally { (fs as { renameSync: typeof fs.renameSync }).renameSync = realRename; }
    expect(swapped).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    expect(spend(d, fresh)).toEqual({ ok: true });
  });
});
