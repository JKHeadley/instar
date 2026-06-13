// safe-fs-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Tier-3 "feature is alive" E2E for WS4.4 "links that survive machine boundaries"
 * (MULTI-MACHINE-SEAMLESSNESS-SPEC §WS4.4). Per CLAUDE.md the Tier-3 test is "the
 * single most important test for any feature with API routes": it proves the
 * route is reachable through the REAL AgentServer stack (auth middleware, error
 * handling) and behaves — not 503 because a dep wasn't wired.
 *
 * Spins up TWO real AgentServers:
 *   - HOLDER: a real AgentServer holding a private view + a real MeshRpcDispatcher
 *     with the real WS4.4 `pool-view-fetch` holder handler.
 *   - FRONTING: a real AgentServer with `poolLink` wired, holding NO local copy.
 * Drives GET /view/:id against the FRONTING server with a Bearer token and proves
 * it proxies to the holder (200, holder body, Cache-Control: no-store), that the
 * route sits behind auth (no token → 401/403), and that an offline holder yields
 * an honest 503 (never a bare 404 / stale content).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SessionManager } from '../../src/core/SessionManager.js';
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
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const FRONTING = 'm_front';
const HOLDER = 'm_hold';
const TOKEN = 'ws44-e2e-token';
const FRONT_PORT = 47261;
const HOLD_PORT = 47262;

describe('E2E: WS4.4 pool-view link proxy is ALIVE through the real AgentServer', () => {
  let dir: string;
  let frontingServer: AgentServer;
  let holderServer: AgentServer;
  let viewId: string;
  let holderOnline = true;
  const frontKeys = generateSigningKeyPair();
  const holderKeys = generateSigningKeyPair();
  let frontingProxy: PoolViewProxy;
  const KEYRING: Record<string, string> = { [FRONTING]: frontKeys.publicKey, [HOLDER]: holderKeys.publicKey };
  const frontBase = `http://127.0.0.1:${FRONT_PORT}`;
  const holdBase = `http://127.0.0.1:${HOLD_PORT}`;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws44-alive-'));

    // ── HOLDER server ──
    const holderViewer = new PrivateViewer({ viewsDir: path.join(dir, 'holder-views') });
    viewId = holderViewer.create('Secret', '# secret\nthe-holder-body').id;
    const jtiStore = new PoolLinkJtiStore({ filePath: path.join(dir, 'pool-link-jtis.json'), now: () => Date.now() });
    const seenHolderNonces = new Set<string>();
    const holderDispatcher = new MeshRpcDispatcher({
      verify: {
        selfMachineId: HOLDER,
        verify: (c, s, sender) => { const pem = KEYRING[sender]; return pem ? verify(c, s, pem) : false; },
        isRegisteredPeer: (s) => s in KEYRING,
        seenNonce: (s, n) => seenHolderNonces.has(`${s}:${n}`),
        now: () => Date.now(),
        clockToleranceMs: 30_000,
      },
      rbac: { routerHolder: () => null, ownerOf: () => null, placementTargetOf: () => null },
      recordNonce: (s, n) => seenHolderNonces.add(`${s}:${n}`),
      handlers: {
        'pool-view-fetch': async (cmd, sender) => {
          const c = cmd as { type: 'pool-view-fetch'; viewId: string; method: string; probeOnly?: boolean; assertion?: unknown };
          const v = holderViewer.get(c.viewId);
          if (c.probeOnly === true) return { present: v != null };
          if (!v) return { status: 404, contentType: 'application/json', bodyBase64: Buffer.from('{}').toString('base64') };
          const assertion = c.assertion as PoolLinkAssertion;
          const verdict = verifyPoolLinkAssertion(
            assertion,
            { viewId: c.viewId, method: c.method ?? 'GET' },
            {
              selfFingerprint: HOLDER,
              expectedIssuer: sender,
              resolveIssuerPublicKeyPem: (iss) => KEYRING[iss] ?? null,
              verify: (cc, ss, pem) => verify(cc, ss, pem),
              seenJti: (jti) => jtiStore.seen(jti),
              now: () => Date.now(),
            },
          );
          if (!verdict.ok) return { status: statusForPoolLinkReason(verdict.reason), contentType: 'application/json', bodyBase64: Buffer.from(JSON.stringify({ error: verdict.reason })).toString('base64') };
          jtiStore.record(assertion.jti, assertion.exp);
          return { status: 200, contentType: 'text/html; charset=utf-8', bodyBase64: Buffer.from(holderViewer.renderHtml(v)).toString('base64') };
        },
      },
    });
    holderServer = new AgentServer({
      config: { projectName: 'ws44-holder', projectDir: dir, stateDir: dir, port: HOLD_PORT, authToken: TOKEN } as unknown as InstarConfig,
      sessionManager: new SessionManager({ projectDir: dir, port: HOLD_PORT }),
      state: new StateManager(dir),
      viewer: holderViewer,
      meshRpcDispatcher: holderDispatcher,
      meshSelfId: HOLDER,
    });
    await holderServer.start();

    // ── FRONTING server (poolLink wired; no local view) ──
    const frontingViewer = new PrivateViewer({ viewsDir: path.join(dir, 'fronting-views') });
    const client = new MeshRpcClient({
      selfMachineId: FRONTING,
      sign: (c) => sign(c, frontKeys.privateKey),
      nonce: () => `${FRONTING}:e2e:${Date.now()}:${crypto.randomBytes(6).toString('hex')}`,
    });
    const proxy = new PoolViewProxy({
      selfMachineId: FRONTING,
      heldLocally: (id) => frontingViewer.get(id) != null,
      listPeers: () => [{ machineId: HOLDER, url: holdBase, online: holderOnline }],
      probePeer: async (peer, id) => {
        if (peer.online === false) return 'unreachable';
        const r = await client.send({ machineId: peer.machineId, url: peer.url }, { type: 'pool-view-fetch', viewId: id, method: 'GET', probeOnly: true } as any, 0, { timeoutMs: 4000 });
        if (!r.ok) return 'unreachable';
        return (r.result as { present?: boolean })?.present ? 'present' : 'absent';
      },
      now: () => Date.now(),
    });
    frontingProxy = proxy;
    const poolLink = {
      selfFingerprint: FRONTING,
      proxy,
      jtiStore,
      mintAssertion: (audience: any, userAuth: any) => mintPoolLinkAssertion(audience, userAuth, {
        selfFingerprint: FRONTING, sign: (c) => sign(c, frontKeys.privateKey), mintJti: () => crypto.randomBytes(24).toString('hex'), now: () => Date.now(),
      }),
      resolveIssuerPublicKeyPem: (iss: string) => KEYRING[iss] ?? null,
      verify: (c: string, s: string, pem: string) => verify(c, s, pem),
      fetchFromHolder: async (holder: any, id: string, method: string, assertion: PoolLinkAssertion) => {
        const r = await client.send({ machineId: holder.machineId, url: holder.url }, { type: 'pool-view-fetch', viewId: id, method, assertion } as any, 0, { timeoutMs: 8000 });
        if (!r.ok) return { status: r.status ?? 502, contentType: 'application/json', body: Buffer.from(JSON.stringify({ error: r.reason })) };
        const res = (r.result ?? {}) as { status?: number; contentType?: string | null; bodyBase64?: string };
        return { status: res.status ?? 200, contentType: res.contentType ?? null, body: Buffer.from(res.bodyBase64 ?? '', 'base64') };
      },
    };
    frontingServer = new AgentServer({
      config: { projectName: 'ws44-fronting', projectDir: dir, stateDir: dir, port: FRONT_PORT, authToken: TOKEN } as unknown as InstarConfig,
      sessionManager: new SessionManager({ projectDir: dir, port: FRONT_PORT }),
      state: new StateManager(dir),
      viewer: frontingViewer,
      poolLink,
      meshSelfId: FRONTING,
    });
    await frontingServer.start();
  }, 30000);

  afterAll(async () => {
    await frontingServer?.stop();
    await holderServer?.stop();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/pool-view-link-alive.test.ts' });
  });

  const auth = { Authorization: `Bearer ${TOKEN}` };

  it('GET /view/:id (not held locally) is ALIVE through the real stack — proxies to the holder (200, holder body)', async () => {
    holderOnline = true;
    const res = await fetch(`${frontBase}/view/${viewId}`, { headers: auth });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('the-holder-body');
    expect(res.headers.get('cache-control')).toBe('no-store'); // private body never cached at edge
  });

  it('the proxied /view route sits behind auth (no Bearer → 401/403) — proves the real middleware stack', async () => {
    const res = await fetch(`${frontBase}/view/${viewId}`);
    expect([401, 403]).toContain(res.status);
  });

  it('OFFLINE holder → honest 503 "temporarily unavailable", never a bare 404 or stale content', async () => {
    holderOnline = false;
    // The proxy memoizes resolution; invalidate so this re-resolves against the
    // now-offline peer instead of the cached `remote` from the alive test.
    frontingProxy.invalidate(viewId);
    const res = await fetch(`${frontBase}/view/${viewId}`, { headers: auth });
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toContain('temporarily unavailable');
    expect(text).not.toContain('the-holder-body');
    holderOnline = true;
  });
});
