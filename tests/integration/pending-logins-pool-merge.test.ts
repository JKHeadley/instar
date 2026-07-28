/**
 * WS5.2 seam #3 — GET /subscription-pool/pending-logins?scope=pool MUST merge the local
 * pending logins with every peer's local pending logins, tagging each with its machine, and
 * tolerate a dark peer (a classified failed entry, never a 500). This is what surfaces a
 * follow-me login created on the TARGET machine (the Mac Mini) onto the operator's SINGLE
 * (fronting) dashboard — without it, the device-code link never appears and the proof stalls
 * after Approve (the 2026-06-18 failure). Drives the REAL route via createRoutes() with a
 * real stub "peer" express app.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import { createRoutes } from '../../src/server/routes.js';

interface Up { server: http.Server; url: string; }
function listen(app: express.Express): Promise<Up> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

describe('GET /subscription-pool/pending-logins?scope=pool (integration)', () => {
  let self: Up; let peer: Up; let darkPeer: Up;

  beforeEach(async () => {
    // A real "peer" machine serving its own LOCAL pending-logins (a follow-me login on the Mini).
    const peerApp = express();
    peerApp.get('/subscription-pool/pending-logins', (_req, res) => {
      res.json({ enabled: true, logins: [{ id: 'adriana', label: 'adriana', userCode: 'AAAA-BBBB', verificationUrl: 'https://claude.com/oauth/device' }] });
    });
    peer = await listen(peerApp);

    // A dark peer that always errors — must degrade to a failed entry, never a 500.
    const darkApp = express();
    darkApp.get('/subscription-pool/pending-logins', (_req, res) => res.status(500).end());
    darkPeer = await listen(darkApp);

    const selfApp = express();
    selfApp.use(express.json());
    const ctx: any = {
      config: { authToken: 't', stateDir: '/tmp', port: 0 },
      startTime: new Date(),
      meshSelfId: 'self-machine',
      enrollmentWizard: { pending: () => [{ id: 'local-codex', label: 'codex', userCode: 'LOCL-CODE', verificationUrl: 'https://auth.openai.com/device' }] },
      resolvePeerUrls: () => [
        { machineId: 'mac-mini', url: peer.url },
        { machineId: 'dark-one', url: darkPeer.url },
      ],
      machinePoolRegistry: { getCapacity: (id: string) => ({ nickname: id === 'mac-mini' ? 'Mac Mini' : id }) },
    };
    selfApp.use(createRoutes(ctx));
    self = await listen(selfApp);
  });

  afterEach(async () => {
    await Promise.all([self, peer, darkPeer].map((u) => new Promise<void>((r) => u.server.close(() => r()))));
  });

  const get = (p: string) => fetch(self.url + p, { headers: { Authorization: 'Bearer t' } }).then(async (r) => ({ status: r.status, body: await r.json() }));

  it('merges local + peer pending logins, tagged by machine', async () => {
    const res = await get('/subscription-pool/pending-logins?scope=pool');
    expect(res.status).toBe(200);
    const ids = res.body.logins.map((l: any) => l.id).sort();
    expect(ids).toEqual(['adriana', 'local-codex']); // BOTH surface on the single dashboard
    const adriana = res.body.logins.find((l: any) => l.id === 'adriana');
    expect(adriana.remote).toBe(true);
    expect(adriana.machineId).toBe('mac-mini');
    expect(adriana.machineNickname).toBe('Mac Mini');
    expect(adriana.verificationUrl).toContain('claude.com'); // the tappable link is preserved
    const local = res.body.logins.find((l: any) => l.id === 'local-codex');
    expect(local.remote).toBe(false);
  });

  it('tolerates a dark peer — classified failed entry, never a 500', async () => {
    const res = await get('/subscription-pool/pending-logins?scope=pool');
    expect(res.status).toBe(200);
    expect(res.body.pool.failed.some((f: any) => f.machineId === 'dark-one')).toBe(true);
    // The reachable peer's login still surfaces despite the dark one.
    expect(res.body.logins.some((l: any) => l.id === 'adriana')).toBe(true);
  });

  it('local-only (no scope) is unchanged — just the local logins, no pool field', async () => {
    const res = await get('/subscription-pool/pending-logins');
    expect(res.status).toBe(200);
    expect(res.body.logins.map((l: any) => l.id)).toEqual(['local-codex']);
    expect(res.body.pool).toBeUndefined();
  });
});
