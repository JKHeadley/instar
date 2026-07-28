/**
 * Tier-2 integration ("feature-alive") test for WS4.4 "links that survive
 * machine boundaries" (MULTI-MACHINE-SEAMLESSNESS-SPEC §WS4.4). SECURITY-CRITICAL.
 *
 * Two REAL express servers: a HOLDER (owns the private view + runs the real
 * pool-view-fetch mesh handler that verifies the assertion) and a FRONTING
 * machine (proxies GET /view/:id to the holder over real HTTP, carrying a
 * signed, audience-bound, single-use mesh assertion). Real Ed25519 throughout
 * (MachineIdentity.sign/verify). No mocks of the crypto or the dispatcher.
 *
 * NAMED INVARIANT — WS4.4 auth-preservation: the END-USER credential is required
 * end-to-end and the machine credential is NEVER substituted. Proven three ways:
 *   (1) end-to-end happy path: a fronting GET /view/:id (the user already passed
 *       edge auth) lands the holder's rendered body via a valid assertion.
 *   (2) a BARE mesh pool-view-fetch (machine-authed, NO user-auth assertion) is
 *       refused by the holder — the machine credential alone never yields a body.
 *   (3) replay: a captured assertion is rejected against (i) another view-id,
 *       (ii) another holder, (iii) a second use within its TTL.
 * Plus flag-off ⇒ plain local /view is unchanged (no proxy).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { PrivateViewer } from '../../src/publishing/PrivateViewer.js';
import { MeshRpcDispatcher, signEnvelope, type MeshCommand, type MeshEnvelope } from '../../src/core/MeshRpc.js';
import { generateSigningKeyPair, sign, verify } from '../../src/core/MachineIdentity.js';
import { PoolViewProxy } from '../../src/core/PoolViewProxy.js';
import { PoolLinkJtiStore } from '../../src/core/PoolLinkJtiStore.js';
import {
  mintPoolLinkAssertion,
  verifyPoolLinkAssertion,
  statusForPoolLinkReason,
  type PoolLinkAssertion,
} from '../../src/core/PoolLinkAssertion.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const FRONTING = 'm_fronting';
const HOLDER = 'm_holder';

interface Server { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

describe('WS4.4 pool-view proxy (cross-machine /view)', () => {
  let dir: string;
  let holderServer: Server;
  let frontingServer: Server;
  let holderViewer: PrivateViewer;
  let frontingViewer: PrivateViewer;
  let jtiStore: PoolLinkJtiStore;
  let frontingKeys: { publicKey: string; privateKey: string };
  let viewId: string;

  // Keyring the HOLDER uses to resolve the issuer's REGISTERED key.
  let KEYRING: Record<string, string>;

  /** Build the holder's real pool-view-fetch handler (mirrors server.ts). */
  function makeHolderDispatcher(): MeshRpcDispatcher {
    const seenNonces = new Set<string>();
    return new MeshRpcDispatcher({
      verify: {
        selfMachineId: HOLDER,
        // The fronting machine is the only registered peer; its envelope is
        // signed with its mesh key (real Ed25519).
        verify: (canonical, signature, sender) =>
          sender === FRONTING && verify(canonical, signature, frontingKeys.publicKey),
        isRegisteredPeer: (s) => s === FRONTING,
        seenNonce: (s, n) => seenNonces.has(`${s}:${n}`),
        now: () => Date.now(),
        clockToleranceMs: 30_000,
      },
      rbac: { routerHolder: () => null, ownerOf: () => null, placementTargetOf: () => null },
      recordNonce: (s, n) => seenNonces.add(`${s}:${n}`),
      handlers: {
        'pool-view-fetch': (cmd, sender) => {
          const c = cmd as MeshCommand & { type: 'pool-view-fetch' };
          if (typeof c.viewId !== 'string' || !c.viewId) return { ok: false, reason: 'viewId required' };
          const view = holderViewer.get(c.viewId);
          // Probe: existence only — never the body.
          if (c.probeOnly === true) return { present: view != null };
          if (!view) {
            return { status: 404, contentType: 'application/json', bodyBase64: Buffer.from(JSON.stringify({ error: 'View not found' })).toString('base64') };
          }
          const assertion = c.assertion as PoolLinkAssertion;
          const verdict = verifyPoolLinkAssertion(
            assertion,
            { viewId: c.viewId, method: typeof c.method === 'string' ? c.method : 'GET' },
            {
              selfFingerprint: HOLDER,
              expectedIssuer: sender, // authenticated transport sender
              resolveIssuerPublicKeyPem: (iss) => KEYRING[iss] ?? null,
              verify: (canonical, signature, pem) => { try { return verify(canonical, signature, pem); } catch { return false; } },
              seenJti: (jti) => jtiStore.seen(jti),
              now: () => Date.now(),
            },
          );
          if (!verdict.ok) {
            return { status: statusForPoolLinkReason(verdict.reason), contentType: 'application/json', bodyBase64: Buffer.from(JSON.stringify({ error: `assertion rejected: ${verdict.reason}` })).toString('base64') };
          }
          jtiStore.record(assertion.jti, assertion.exp);
          const html = holderViewer.renderHtml(view);
          return { status: 200, contentType: 'text/html; charset=utf-8', bodyBase64: Buffer.from(html).toString('base64') };
        },
      },
    });
  }

  /** A real machine-authed mesh send from FRONTING → HOLDER over HTTP. */
  let frontNonce = 0;
  async function meshSend(command: MeshCommand): Promise<{ status: number; result?: any; reason?: string }> {
    const env: MeshEnvelope = signEnvelope(
      { sender: FRONTING, recipient: HOLDER, command, epoch: 0, nonce: `n${++frontNonce}`, timestamp: Date.now() },
      (c) => sign(c, frontingKeys.privateKey),
    );
    const res = await fetch(`${holderServer.url}/mesh/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(env),
    });
    const body = (await res.json().catch(() => ({}))) as { result?: unknown; reason?: string };
    return { status: res.status, result: body.result, reason: body.reason };
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws44-proxy-'));
    frontingKeys = generateSigningKeyPair();
    KEYRING = { [FRONTING]: frontingKeys.publicKey };

    holderViewer = new PrivateViewer({ viewsDir: path.join(dir, 'holder-views') });
    frontingViewer = new PrivateViewer({ viewsDir: path.join(dir, 'fronting-views') });
    jtiStore = new PoolLinkJtiStore({ filePath: path.join(dir, 'jtis.json'), now: () => Date.now() });

    // The view lives ONLY on the holder (view-id ownership ≠ topic ownership).
    const created = holderViewer.create('Cross-machine report', '# Hello from the holder');
    viewId = created.id;

    // ── HOLDER server: real viewer + real mesh dispatcher with the handler. ──
    const holderCtx = {
      config: { authToken: 'test', stateDir: dir, port: 0 },
      stateDir: dir,
      viewer: holderViewer,
      meshRpcDispatcher: makeHolderDispatcher(),
      startTime: new Date(),
    } as unknown as RouteContext;
    const holderApp = express();
    holderApp.use(express.json({ limit: '5mb' }));
    holderApp.use(createRoutes(holderCtx));
    holderServer = await listen(holderApp);
  });

  afterEach(async () => {
    await holderServer?.close();
    await frontingServer?.close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/ws44-pool-view-proxy.test.ts' });
  });

  /** Build the fronting server, with or without the WS4.4 poolLink wired. */
  async function startFronting(opts: { wirePoolLink: boolean }): Promise<void> {
    let poolLink: RouteContext['poolLink'] = null;
    if (opts.wirePoolLink) {
      const proxy = new PoolViewProxy({
        selfMachineId: FRONTING,
        heldLocally: (id) => frontingViewer.get(id) != null, // fronting holds NOTHING
        listPeers: () => [{ machineId: HOLDER, url: holderServer.url, online: true }],
        probePeer: async (peer, vId) => {
          const r = await meshSend({ type: 'pool-view-fetch', viewId: vId, method: 'GET', probeOnly: true });
          if (r.status !== 200) return 'unreachable';
          return r.result?.present === true ? 'present' : 'absent';
        },
        now: () => Date.now(),
      });
      let jtiSeq = 0;
      poolLink = {
        selfFingerprint: FRONTING,
        proxy,
        jtiStore: new PoolLinkJtiStore({ filePath: path.join(dir, 'fronting-jtis.json'), now: () => Date.now() }),
        mintAssertion: (audience, userAuth) =>
          mintPoolLinkAssertion(audience, userAuth, {
            selfFingerprint: FRONTING,
            sign: (c) => sign(c, frontingKeys.privateKey),
            mintJti: () => `front-jti-${++jtiSeq}-${crypto.randomBytes(4).toString('hex')}`,
            now: () => Date.now(),
          }),
        resolveIssuerPublicKeyPem: (iss) => KEYRING[iss] ?? null,
        verify: (canonical, signature, pem) => { try { return verify(canonical, signature, pem); } catch { return false; } },
        fetchFromHolder: async (holder, vId, method, assertion) => {
          const r = await meshSend({ type: 'pool-view-fetch', viewId: vId, method, assertion });
          if (r.status !== 200) {
            return { status: r.status, contentType: 'application/json', body: Buffer.from(JSON.stringify({ error: r.reason ?? 'unreachable' })) };
          }
          const res = (r.result ?? {}) as { status?: number; contentType?: string; bodyBase64?: string };
          return {
            status: typeof res.status === 'number' ? res.status : 200,
            contentType: res.contentType ?? null,
            body: Buffer.from(res.bodyBase64 ?? '', 'base64'),
          };
        },
      };
    }
    const frontingCtx = {
      config: { authToken: 'test', stateDir: dir, port: 0 },
      stateDir: dir,
      viewer: frontingViewer,
      poolLink,
      startTime: new Date(),
    } as unknown as RouteContext;
    const app = express();
    app.use(express.json());
    app.use(createRoutes(frontingCtx));
    frontingServer = await listen(app);
  }

  it('END-TO-END: a fronting GET /view/:id lands the HOLDER\'s rendered body via a valid assertion', async () => {
    await startFronting({ wirePoolLink: true });
    const res = await fetch(`${frontingServer.url}/view/${viewId}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Hello from the holder');
    // §WS4.4 c: private bodies are NEVER cached at the edge.
    expect(res.headers.get('cache-control')).toBe('no-store');
    // The single-use jti was recorded on the holder.
    expect(jtiStore.size()).toBe(1);
  });

  it('INVARIANT (auth-preservation): a BARE mesh pool-view-fetch with NO assertion is REFUSED — machine credential never substituted', async () => {
    await startFronting({ wirePoolLink: true });
    // The fronting machine is a registered, authenticated peer (real signature).
    // It asks for the body with NO user-auth assertion (machine cred only).
    const r = await meshSend({ type: 'pool-view-fetch', viewId, method: 'GET' /* no assertion */ });
    // The mesh envelope is accepted (it's a registered peer) — status 200 at the
    // transport — but the HANDLER refuses to serve the body without a valid
    // user-auth assertion. The body is an error, NEVER the rendered view.
    expect(r.status).toBe(200); // transport accepted the registered peer
    const inner = r.result as { status?: number; bodyBase64?: string };
    expect(inner.status).not.toBe(200); // the handler refused
    const innerBody = Buffer.from(inner.bodyBase64 ?? '', 'base64').toString('utf-8');
    expect(innerBody).not.toContain('Hello from the holder');
    expect(innerBody).toMatch(/assertion rejected|malformed/i);
    // Nothing was recorded — a refused fetch never burns a jti.
    expect(jtiStore.size()).toBe(0);
  });

  it('REPLAY (i): a captured assertion cannot fetch ANOTHER view-id', async () => {
    await startFronting({ wirePoolLink: true });
    const otherView = holderViewer.create('Other', '# secret two');
    // Mint a valid assertion for `viewId`, then present it for `otherView.id`.
    const assertion = mintPoolLinkAssertion(
      { holderFingerprint: HOLDER, viewId, method: 'GET' },
      'pin-session',
      { selfFingerprint: FRONTING, sign: (c) => sign(c, frontingKeys.privateKey), mintJti: () => 'replay-i', now: () => Date.now() },
    );
    const r = await meshSend({ type: 'pool-view-fetch', viewId: otherView.id, method: 'GET', assertion });
    const inner = r.result as { status?: number; bodyBase64?: string };
    expect(inner.status).not.toBe(200);
    expect(Buffer.from(inner.bodyBase64 ?? '', 'base64').toString()).toMatch(/wrong-view/);
  });

  it('REPLAY (ii): a captured assertion bound to ANOTHER holder is rejected (wrong-holder)', async () => {
    await startFronting({ wirePoolLink: true });
    const assertion = mintPoolLinkAssertion(
      { holderFingerprint: 'm_someone_else', viewId, method: 'GET' },
      'pin-session',
      { selfFingerprint: FRONTING, sign: (c) => sign(c, frontingKeys.privateKey), mintJti: () => 'replay-ii', now: () => Date.now() },
    );
    const r = await meshSend({ type: 'pool-view-fetch', viewId, method: 'GET', assertion });
    const inner = r.result as { status?: number; bodyBase64?: string };
    expect(inner.status).not.toBe(200);
    expect(Buffer.from(inner.bodyBase64 ?? '', 'base64').toString()).toMatch(/wrong-holder/);
  });

  it('REPLAY (iii): a second use of the same assertion within its TTL is rejected (single-use)', async () => {
    await startFronting({ wirePoolLink: true });
    const assertion = mintPoolLinkAssertion(
      { holderFingerprint: HOLDER, viewId, method: 'GET' },
      'pin-session',
      { selfFingerprint: FRONTING, sign: (c) => sign(c, frontingKeys.privateKey), mintJti: () => 'replay-iii', now: () => Date.now() },
    );
    // First use: accepted, body served, jti recorded.
    const r1 = await meshSend({ type: 'pool-view-fetch', viewId, method: 'GET', assertion });
    expect((r1.result as any).status).toBe(200);
    // Second use of the SAME assertion: rejected as replayed.
    const r2 = await meshSend({ type: 'pool-view-fetch', viewId, method: 'GET', assertion });
    const inner = r2.result as { status?: number; bodyBase64?: string };
    expect(inner.status).not.toBe(200);
    expect(Buffer.from(inner.bodyBase64 ?? '', 'base64').toString()).toMatch(/replayed/);
  });

  it('FLAG OFF: with no poolLink wired, a non-local /view is a plain local-only 404 (today\'s behavior)', async () => {
    await startFronting({ wirePoolLink: false });
    const res = await fetch(`${frontingServer.url}/view/${viewId}`);
    expect(res.status).toBe(404); // never proxied — exactly as before WS4.4
    const body = await res.json();
    expect(body).toEqual({ error: 'View not found' });
    // The holder was never asked — no jti recorded.
    expect(jtiStore.size()).toBe(0);
  });

  it('OFFLINE HOLDER (§WS4.4 d): an unreachable holder yields an honest "temporarily unavailable", NOT a bare 404', async () => {
    // Close the holder so the probe is unreachable.
    await startFronting({ wirePoolLink: true });
    await holderServer.close();
    holderServer = { url: holderServer.url, close: async () => {} }; // afterEach safe
    const res = await fetch(`${frontingServer.url}/view/${viewId}`);
    expect(res.status).toBe(503); // honest unavailable, not 404
    const body = await res.text();
    expect(body).toMatch(/temporarily unavailable/i);
  });
});
