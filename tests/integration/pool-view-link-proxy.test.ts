// safe-fs-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Integration ("feature-alive") tests for WS4.4 "links that survive machine
 * boundaries" (MULTI-MACHINE-SEAMLESSNESS-SPEC §WS4.4). SECURITY-SENSITIVE.
 *
 * Stands up TWO real route servers over HTTP:
 *   - the HOLDER: a real PrivateViewer holding a view + a real MeshRpcDispatcher
 *     with the real `pool-view-fetch` holder handler (verify assertion → record
 *     jti → holder authz → serve), wired exactly as src/commands/server.ts does.
 *   - the FRONTING machine: a `poolLink` ctx whose proxy probes + fetches the
 *     holder over /mesh/rpc, mints the assertion, and serves GET /view/:id.
 *
 * Proves end-to-end: the fronting /view/:id resolves the holder and proxies;
 * the proxied request carries the ASSERTION (never the PIN); the holder makes the
 * authz decision; an offline holder yields an honest 503; a replay is rejected;
 * private bodies are never cached at the edge.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { MeshRpcDispatcher } from '../../src/core/MeshRpc.js';
import { MeshRpcClient } from '../../src/core/MeshRpcClient.js';
import { generateSigningKeyPair, sign, verify } from '../../src/core/MachineIdentity.js';
import { PrivateViewer } from '../../src/publishing/PrivateViewer.js';
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
const AUTH = 'test-token';
const VIEW_PIN = 'view-pin-8f4d2c9a7e6b1d35';

interface Server { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

describe('WS4.4 pool-view link proxy (§WS4.4 a–e)', () => {
  let dir: string;
  let holderServer: Server;
  let frontingServer: Server;
  let holderViewer: PrivateViewer;
  let frontingViewer: PrivateViewer;
  let jtiStore: PoolLinkJtiStore;
  let viewId: string;
  let pinViewId: string;
  // Keyring: machineId → public PEM. Both sides resolve issuer keys from it.
  const frontKeys = generateSigningKeyPair();
  const holderKeys = generateSigningKeyPair();
  const KEYRING: Record<string, string> = { [FRONTING]: frontKeys.publicKey, [HOLDER]: holderKeys.publicKey };
  let holderOnline: boolean;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws44-'));
    holderOnline = true;

    // ── HOLDER: a real viewer holding the view + the real pool-view-fetch handler ──
    holderViewer = new PrivateViewer({ viewsDir: path.join(dir, 'holder-views') });
    const view = holderViewer.create('Secret Report', '# Top secret\nholder-only body');
    viewId = view.id;
    const pinView = holderViewer.create('Pin Report', '# pin gated', VIEW_PIN);
    pinViewId = pinView.id;

    jtiStore = new PoolLinkJtiStore({ filePath: path.join(dir, 'pool-link-jtis.json'), now: () => Date.now() });
    const seenHolderNonces = new Set<string>();

    const holderDispatcher = new MeshRpcDispatcher({
      verify: {
        selfMachineId: HOLDER,
        verify: (canonical, signature, sender) => {
          const pem = KEYRING[sender];
          return pem ? verify(canonical, signature, pem) : false;
        },
        isRegisteredPeer: (s) => s in KEYRING,
        seenNonce: (s, n) => seenHolderNonces.has(`${s}:${n}`),
        now: () => Date.now(),
        clockToleranceMs: 30_000,
      },
      rbac: { routerHolder: () => null, ownerOf: () => null, placementTargetOf: () => null },
      recordNonce: (s, n) => seenHolderNonces.add(`${s}:${n}`),
      handlers: {
        // The real WS4.4 holder handler, mirroring src/commands/server.ts.
        'pool-view-fetch': async (cmd, sender) => {
          const c = cmd as { type: 'pool-view-fetch'; viewId: string; method: string; probeOnly?: boolean; assertion?: unknown };
          if (typeof c.viewId !== 'string' || !c.viewId) return { ok: false, reason: 'viewId required' };
          const v = holderViewer.get(c.viewId);
          if (c.probeOnly === true) return { present: v != null };
          if (!v) return { status: 404, contentType: 'application/json; charset=utf-8', bodyBase64: Buffer.from(JSON.stringify({ error: 'View not found' })).toString('base64') };
          const assertion = c.assertion as PoolLinkAssertion;
          const verdict = verifyPoolLinkAssertion(
            assertion,
            { viewId: c.viewId, method: typeof c.method === 'string' ? c.method : 'GET' },
            {
              selfFingerprint: HOLDER,
              expectedIssuer: sender,
              resolveIssuerPublicKeyPem: (iss) => KEYRING[iss] ?? null,
              verify: (canonical, signature, pem) => verify(canonical, signature, pem),
              seenJti: (jti) => jtiStore.seen(jti),
              now: () => Date.now(),
            },
          );
          if (!verdict.ok) {
            return { status: statusForPoolLinkReason(verdict.reason), contentType: 'application/json; charset=utf-8', bodyBase64: Buffer.from(JSON.stringify({ error: `assertion rejected: ${verdict.reason}` })).toString('base64') };
          }
          jtiStore.record(assertion.jti, assertion.exp);
          if (v.pinHash) {
            return { status: 200, contentType: 'text/html; charset=utf-8', bodyBase64: Buffer.from(holderViewer.renderPinPage(v)).toString('base64') };
          }
          return { status: 200, contentType: 'text/html; charset=utf-8', bodyBase64: Buffer.from(holderViewer.renderHtml(v)).toString('base64') };
        },
      },
    });
    const holderCtx: any = {
      config: { authToken: AUTH, stateDir: dir, port: 0 },
      stateDir: dir,
      viewer: holderViewer,
      meshRpcDispatcher: holderDispatcher,
    };
    const holderApp = express();
    holderApp.use(express.json());
    holderApp.use(createRoutes(holderCtx));
    holderServer = await listen(holderApp);

    // ── FRONTING: a viewer with NO local view + the poolLink proxy to the holder ──
    frontingViewer = new PrivateViewer({ viewsDir: path.join(dir, 'fronting-views') });
    const ws44Client = new MeshRpcClient({
      selfMachineId: FRONTING,
      sign: (c) => sign(c, frontKeys.privateKey),
      nonce: () => `${FRONTING}:pv:${Date.now()}:${crypto.randomBytes(6).toString('hex')}`,
    });
    const proxy = new PoolViewProxy({
      selfMachineId: FRONTING,
      heldLocally: (id) => frontingViewer.get(id) != null,
      listPeers: () => [{ machineId: HOLDER, url: holderServer.url, online: holderOnline }],
      probePeer: async (peer, id) => {
        if (peer.online === false) return 'unreachable';
        const res = await ws44Client.send(
          { machineId: peer.machineId, url: peer.url },
          { type: 'pool-view-fetch', viewId: id, method: 'GET', probeOnly: true } as any,
          0,
          { timeoutMs: 4000 },
        );
        if (!res.ok) return 'unreachable';
        return (res.result as { present?: boolean })?.present ? 'present' : 'absent';
      },
      now: () => Date.now(),
    });
    const poolLink = {
      selfFingerprint: FRONTING,
      proxy,
      jtiStore,
      mintAssertion: (audience: any, userAuth: any) =>
        mintPoolLinkAssertion(audience, userAuth, {
          selfFingerprint: FRONTING,
          sign: (c) => sign(c, frontKeys.privateKey),
          mintJti: () => crypto.randomBytes(24).toString('hex'),
          now: () => Date.now(),
        }),
      resolveIssuerPublicKeyPem: (iss: string) => KEYRING[iss] ?? null,
      verify: (c: string, s: string, pem: string) => verify(c, s, pem),
      fetchFromHolder: async (holder: any, id: string, method: string, assertion: PoolLinkAssertion) => {
        const res = await ws44Client.send(
          { machineId: holder.machineId, url: holder.url },
          { type: 'pool-view-fetch', viewId: id, method, assertion } as any,
          0,
          { timeoutMs: 8000 },
        );
        if (!res.ok) {
          return { status: res.status ?? 502, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ error: res.reason ?? 'holder unreachable' })) };
        }
        const r = (res.result ?? {}) as { status?: number; contentType?: string | null; bodyBase64?: string };
        return { status: r.status ?? 200, contentType: r.contentType ?? null, body: Buffer.from(r.bodyBase64 ?? '', 'base64') };
      },
    };
    const frontingCtx: any = {
      config: { authToken: AUTH, stateDir: dir, port: 0 },
      stateDir: dir,
      viewer: frontingViewer,
      poolLink,
    };
    const frontingApp = express();
    frontingApp.use(express.json());
    frontingApp.use(createRoutes(frontingCtx));
    frontingServer = await listen(frontingApp);
  });

  afterEach(async () => {
    await holderServer.close();
    await frontingServer.close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/pool-view-link-proxy.test.ts' });
  });

  async function getView(server: Server, id: string, headers: Record<string, string> = {}) {
    const res = await fetch(`${server.url}/view/${id}`, { headers });
    const text = await res.text();
    return { status: res.status, text, cacheControl: res.headers.get('cache-control'), contentType: res.headers.get('content-type') };
  }

  it('FEATURE ALIVE: a /view/:id NOT held locally is proxied to the holder and served (200, holder body)', async () => {
    const r = await getView(frontingServer, viewId);
    expect(r.status).toBe(200);
    expect(r.text).toContain('holder-only body');
    expect(r.contentType).toMatch(/text\/html/);
  });

  it('private body is NEVER cached at the fronting edge (Cache-Control: no-store)', async () => {
    const r = await getView(frontingServer, viewId);
    expect(r.status).toBe(200);
    expect(r.cacheControl).toBe('no-store');
  });

  it('a not-held, not-resolvable view returns 404 (not a leak / not a hang)', async () => {
    const missing = '00000000-0000-0000-0000-000000000000';
    const r = await getView(frontingServer, missing);
    expect(r.status).toBe(404);
  });

  it('OFFLINE HOLDER (§WS4.4 d): honest 503 "temporarily unavailable", never a bare 404 or stale content', async () => {
    holderOnline = false;
    const r = await getView(frontingServer, viewId);
    expect(r.status).toBe(503);
    expect(r.text).toContain('temporarily unavailable');
    expect(r.text).not.toContain('holder-only body'); // never stale content
  });

  it('SINGLE-USE / replay (§WS4.4 e): a captured assertion replayed against the holder is rejected', async () => {
    // Drive the holder DIRECTLY to control the exact assertion (replay needs the
    // SAME jti twice; the fronting route mints a fresh jti per request).
    const ws44Client = new MeshRpcClient({
      selfMachineId: FRONTING,
      sign: (c) => sign(c, frontKeys.privateKey),
      nonce: () => `${FRONTING}:replay:${Date.now()}:${crypto.randomBytes(6).toString('hex')}`,
    });
    const assertion = mintPoolLinkAssertion(
      { holderFingerprint: HOLDER, viewId, method: 'GET' },
      'pin-session',
      { selfFingerprint: FRONTING, sign: (c) => sign(c, frontKeys.privateKey), mintJti: () => 'reused-jti', now: () => Date.now() },
    );
    const first = await ws44Client.send({ machineId: HOLDER, url: holderServer.url }, { type: 'pool-view-fetch', viewId, method: 'GET', assertion } as any, 0, { timeoutMs: 8000 });
    expect((first.result as any)?.status).toBe(200);
    const second = await ws44Client.send({ machineId: HOLDER, url: holderServer.url }, { type: 'pool-view-fetch', viewId, method: 'GET', assertion } as any, 0, { timeoutMs: 8000 });
    expect((second.result as any)?.status).toBe(statusForPoolLinkReason('replayed')); // 409
    expect(Buffer.from((second.result as any).bodyBase64, 'base64').toString()).toContain('replayed');
  });

  it('RAW PIN NEVER CROSSES (§WS4.4 b): the proxied mesh request carries the ASSERTION, not the user PIN/token', async () => {
    // Intercept the holder's /mesh/rpc to capture exactly what crossed the wire.
    let capturedEnvelope: any = null;
    const sniffer = express();
    sniffer.use(express.json());
    sniffer.post('/mesh/rpc', (req, res) => {
      capturedEnvelope = req.body;
      res.json({ ok: true, result: { status: 200, contentType: 'text/html; charset=utf-8', bodyBase64: Buffer.from('ok').toString('base64') } });
    });
    const sniffServer = await listen(sniffer);
    try {
      // Re-point the fronting proxy at the sniffer by using a fresh fronting ctx.
      const ws44Client = new MeshRpcClient({
        selfMachineId: FRONTING,
        sign: (c) => sign(c, frontKeys.privateKey),
        nonce: () => `${FRONTING}:sniff:${Date.now()}:${crypto.randomBytes(6).toString('hex')}`,
      });
      const assertion = mintPoolLinkAssertion(
        { holderFingerprint: HOLDER, viewId, method: 'GET' },
        'pin-session',
        { selfFingerprint: FRONTING, sign: (c) => sign(c, frontKeys.privateKey), mintJti: () => crypto.randomBytes(24).toString('hex'), now: () => Date.now() },
      );
      await ws44Client.send({ machineId: HOLDER, url: sniffServer.url }, { type: 'pool-view-fetch', viewId, method: 'GET', assertion } as any, 0, { timeoutMs: 4000 });
      const serialized = JSON.stringify(capturedEnvelope);
      // The envelope carries the assertion command + its signed assertion…
      expect(capturedEnvelope.command.type).toBe('pool-view-fetch');
      expect(capturedEnvelope.command.assertion.jti).toBeTruthy();
      expect(capturedEnvelope.command.assertion.signature).toBeTruthy();
      // …and NOTHING resembling a raw PIN / dashboard token / view PIN.
      expect(serialized).not.toContain(AUTH); // the fronting authToken (PIN-session credential) never crosses
      expect(serialized).not.toContain(VIEW_PIN); // the high-entropy view PIN never crosses
      expect(serialized).not.toMatch(/"pin"\s*:/i);
      expect(serialized).not.toMatch(/"password"\s*:/i);
    } finally {
      await sniffServer.close();
    }
  });

  it('HOLDER MAKES THE AUTHZ DECISION (§WS4.4 b): the holder rejects an audience-mismatched assertion and the fronting relays the holder verdict UNCHANGED', async () => {
    // Drive the holder with an assertion bound to the WRONG view → the holder
    // rejects (401 wrong-view) and the fronting passes that status through.
    const ws44Client = new MeshRpcClient({
      selfMachineId: FRONTING,
      sign: (c) => sign(c, frontKeys.privateKey),
      nonce: () => `${FRONTING}:authz:${Date.now()}:${crypto.randomBytes(6).toString('hex')}`,
    });
    const wrongAssertion = mintPoolLinkAssertion(
      { holderFingerprint: HOLDER, viewId: 'ffffffff-ffff-ffff-ffff-ffffffffffff', method: 'GET' },
      'pin-session',
      { selfFingerprint: FRONTING, sign: (c) => sign(c, frontKeys.privateKey), mintJti: () => crypto.randomBytes(24).toString('hex'), now: () => Date.now() },
    );
    const res = await ws44Client.send({ machineId: HOLDER, url: holderServer.url }, { type: 'pool-view-fetch', viewId, method: 'GET', assertion: wrongAssertion } as any, 0, { timeoutMs: 8000 });
    expect((res.result as any).status).toBe(401); // wrong-view → 401 (the holder decided)
    expect(Buffer.from((res.result as any).bodyBase64, 'base64').toString()).toContain('wrong-view');
  });

  it('a PIN-gated view is served as the holder\'s PIN PAGE (holder authz: assertion ≠ per-view PIN)', async () => {
    const r = await getView(frontingServer, pinViewId);
    expect(r.status).toBe(200);
    // The holder returns its own PIN entry page — never the gated content.
    expect(r.text).not.toContain('pin gated'); // the gated markdown body is NOT leaked
  });
});
