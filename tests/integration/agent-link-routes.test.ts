/** POST /agent-links over HTTP (docs/specs/permanent-agent-links.md §2b): flag, strict identity
 * refusals, grammar refusals, and the split-identity warning. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import express from 'express';
import request from 'supertest';
import { createAgentLinkRoutes } from '../../src/server/agentLinkRoutes.js';
import { computeCanonicalId } from '../../src/identity/types.js';

function key() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { pub: Buffer.from(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)), priv: Buffer.from(privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32)) };
}
function write(file: string, k: { pub: Buffer; priv: Buffer }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ publicKey: k.pub.toString('base64'), privateKey: k.priv.toString('base64') }));
}

describe('POST /agent-links', () => {
  let dir: string;
  let enabled: boolean;
  let split: string[];
  let app: express.Express;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-link-routes-'));
    enabled = true; split = [];
    app = express();
    app.use(express.json());
    app.use(createAgentLinkRoutes({ stateDir: dir, enabled: () => enabled, splitMachines: () => split }));
  });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/agent-link-routes.test.ts' }); });

  it('off → 404 agent-links-off (read live)', async () => {
    enabled = false;
    const r = await request(app).post('/agent-links').send({ target: 'home' });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'agent-links-off' });
  });
  it('no identity → 409 no-agent-identity; split files → 409 identity-split', async () => {
    expect((await request(app).post('/agent-links').send({ target: 'home' })).body).toEqual({ error: 'no-agent-identity' });
    write(path.join(dir, 'identity.json'), key());
    write(path.join(dir, 'threadline', 'identity.json'), key());
    const r = await request(app).post('/agent-links').send({ target: 'home' });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'identity-split' });
  });
  it('builds a doc link with an explicit comment, and refuses bad targets', async () => {
    const k = key();
    write(path.join(dir, 'identity.json'), k);
    const id = computeCanonicalId(k.pub);
    const doc = '12345678-1234-1234-1234-123456789abc';
    const r = await request(app).post('/agent-links').send({ target: 'doc', ref: doc, comment: `p1:${doc}` });
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toEqual({ url: `https://instar.sh/a#v=1&i=${id}&t=doc&r=${doc}&c=p1%3A${doc}`, appUrl: `instar://a#v=1&i=${id}&t=doc&r=${doc}&c=p1%3A${doc}` });
    expect((await request(app).post('/agent-links').send({ target: 'doc', ref: '../api' })).status).toBe(400);
    expect((await request(app).post('/agent-links').send({})).status).toBe(400);
  });
  it('builds a strict card navigation reference', async () => {
    const k = key(); write(path.join(dir, 'identity.json'), k);
    const id = computeCanonicalId(k.pub);
    const ref = 'wc_0123456789abcdef';
    const r = await request(app).post('/agent-links').send({ target: 'card', ref });
    expect(r.status).toBe(200);
    expect(r.body.url).toBe(`https://instar.sh/a#v=1&i=${id}&t=card&r=${ref}`);
    expect((await request(app).post('/agent-links').send({ target: 'card', ref: '../api' })).status).toBe(400);
    expect((await request(app).post('/agent-links').send({ target: 'card', ref, comment: 'p:12345678-1234-1234-1234-123456789abc' })).status).toBe(400);
  });
  it('adds the split-identity warning with the machines named', async () => {
    write(path.join(dir, 'identity.json'), key());
    split = ['laptop'];
    const r = await request(app).post('/agent-links').send({ target: 'home' });
    expect(r.status).toBe(200);
    expect(r.body.warning).toBe('split-identity');
    expect(r.body.machines).toEqual(['laptop']);
  });
});
