/**
 * Sealed-handoff R2 — trust-gated transfer authorization, WIRED into the submit
 * (accept) path. Proves the route actually consults the trust gate before
 * consuming the one-time request:
 *   - peer below 'trusted'  → 403 (blocked by trust policy)
 *   - op-autonomy below 'log' → 403 (blocked) even when the peer is trusted
 *   - high trust on both axes → NOT 403 (passes the gate; then fails R1a on the
 *     missing signature → 410, which distinguishes "passed R2" from "blocked")
 *   - an ordinary user Secret Drop (no pinned peer) → never gated
 *
 * The 403-vs-410 split is the whole point: 403 means R2 refused; 410 means R2
 * allowed and the downstream one-time/R1a check spoke.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

interface TestServer { url: string; close: () => Promise<void>; }

function buildApp(peerLevel: string, opLevel: string, stateDir: string): express.Express {
  const app = express();
  app.use(express.json());
  const ctx: any = {
    config: { projectName: 'test-agent', port: 4042, stateDir },
    stateDir,
    tunnel: null,
    // peer trust (AgentTrustManager via UnifiedTrustSystem)
    unifiedTrust: { trustManager: { getTrustLevelByFingerprint: vi.fn().mockReturnValue(peerLevel) } },
    // user's trust of the agent (AdaptiveTrust operation autonomy)
    adaptiveTrust: { getTrustLevel: vi.fn().mockReturnValue({ level: opLevel }) },
  };
  app.use(createRoutes(ctx));
  return app;
}

async function listen(app: express.Express): Promise<TestServer> {
  return new Promise(resolve => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>(r => srv.close(() => r())) });
    });
  });
}

describe('Sealed-handoff R2 — trust gate wired into the accept path', () => {
  let stateDir: string;
  let server: TestServer;

  beforeEach(() => { stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-gate-')); });
  afterEach(async () => {
    if (server) await server.close();
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/integration/sealed-handoff-r2-trust-gate.test.ts:cleanup' });
  });

  /** Mint a peer-pinned request, fetch its CSRF, then submit. Returns the submit response. */
  async function mintAndSubmit(opts: { peerKeyHex?: string }) {
    const mint = await fetch(server.url + '/threadline/secrets/request', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: 'Peer credential',
        ...(opts.peerKeyHex ? { senderVerification: { senderPubKeyHex: opts.peerKeyHex } } : {}),
      }),
    });
    const { token } = await mint.json();
    const formHtml = await (await fetch(server.url + `/secrets/drop/${token}`)).text();
    const csrf = /name="_csrf"\s+value="([0-9a-fA-F]+)"/.exec(formHtml)?.[1];
    const submit = await fetch(server.url + `/secrets/drop/${token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _csrf: csrf, secret: 'value' }),
    });
    return { status: submit.status, body: await submit.json().catch(() => ({})) };
  }

  const PEER_KEY = 'a'.repeat(64);

  it('BLOCKS (403) when the peer is below the trust bar (verified < trusted)', async () => {
    server = await listen(buildApp('verified', 'autonomous', stateDir));
    const r = await mintAndSubmit({ peerKeyHex: PEER_KEY });
    expect(r.status).toBe(403);
    expect(String(r.body.error)).toMatch(/not authorized by trust policy/i);
  });

  it('BLOCKS (403) when op-autonomy is below the bar even with a trusted peer (approve-first < log)', async () => {
    server = await listen(buildApp('trusted', 'approve-first', stateDir));
    const r = await mintAndSubmit({ peerKeyHex: PEER_KEY });
    expect(r.status).toBe(403);
  });

  it('PASSES the gate (NOT 403) when both axes are high (trusted peer + autonomous op)', async () => {
    server = await listen(buildApp('trusted', 'autonomous', stateDir));
    const r = await mintAndSubmit({ peerKeyHex: PEER_KEY });
    // Passed R2 → downstream R1a fails on the missing signature → 410, NOT a 403.
    expect(r.status).not.toBe(403);
    expect(r.status).toBe(410);
  });

  it('does NOT gate an ordinary user Secret Drop (no pinned peer)', async () => {
    server = await listen(buildApp('untrusted', 'approve-always', stateDir));
    const r = await mintAndSubmit({}); // no senderVerification
    expect(r.status).not.toBe(403); // never blocked by the peer-transfer trust gate
  });
});
