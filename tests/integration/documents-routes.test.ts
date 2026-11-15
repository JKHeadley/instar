/**
 * Instar Documents routes over HTTP (spec §3.3, §3.7, §3.9): the dark gate, create and read, the
 * comment list, session context, probing, and confined-session scope.
 */
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateSigningKeyPair, sign as edSign } from '../../src/core/MachineIdentity.js';
import { signerKeyHashOf, type MachineSigner } from '../../src/core/AppRecordSignatures.js';
import { DocumentStore } from '../../src/documents/store.js';
import { DocumentService } from '../../src/documents/service.js';
import { createDocumentRoutes, renderSessionContext, type DocumentRouteDeps } from '../../src/server/documentRoutes.js';
import type { TeamView } from '../../src/documents/access.js';
import { placeMatches } from '../../src/server/memorySessionGuard.js';

const tmp: string[] = [];
afterEach(() => { for (const d of tmp.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/documents-routes.test.ts' }); });

const OWN = 'telegram:7';
const SHARED = 'telegram:500';

function app(config: unknown, session?: { placeKey: string; kind: string }) {
  const kp = generateSigningKeyPair();
  const signer: MachineSigner = { machineId: () => 'A', signerKeyHash: () => signerKeyHashOf(kp.publicKey), sign: (p) => ({ machineId: 'A', signerKeyHash: signerKeyHashOf(kp.publicKey), sig: edSign(p, kp.privateKey) }) };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docroutes-')); tmp.push(dir);
  const store = new DocumentStore(dir, { signer, keyLookup: () => ({ status: 'ok', publicKeyPem: kp.publicKey }), standing: () => 'ok' });
  const team: TeamView = { personMay: () => false, ownerOnly: (ref) => ref === OWN, sessionInPlace: (k, ref) => placeMatches(ref, k), teamRefusal: () => null, sendReachesOwner: () => false };
  const service = new DocumentService(store, team);
  const deps: DocumentRouteDeps = {
    config: () => config, service: () => service, store: () => store, teamVector: () => ({}),
    grantsOf: () => [], ownsConversation: () => false, ownerConversation: () => OWN, deviceApprovedVia: () => null,
  };
  const a = express();
  a.use(express.json({ limit: '2mb' }));
  if (session) a.use((_req, res, next) => { res.locals.memorySession = { sessionId: 's', placeKey: session.placeKey, audience: { kind: session.kind } }; next(); });
  a.use(createDocumentRoutes(deps));
  return { a, service };
}

describe('documents routes', () => {
  it('answer 503 documents-off on a fleet config, and serve on a development agent', async () => {
    const off = app({});
    expect((await request(off.a).post('/docs').send({ title: 't', markdown: 'm' })).status).toBe(503);
    const on = app({ developmentAgent: true });
    const created = await request(on.a).post('/docs').send({ title: 'Plan', markdown: '# Plan\n\nText.\n' });
    expect(created.status).toBe(201);
    const read = await request(on.a).get(`/docs/${created.body.id}/data`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ title: 'Plan', markdown: '# Plan\n\nText.\n', version: { label: 1 } });
  });

  it('refuses an unknown or malformed id with the same 404', async () => {
    const on = app({ developmentAgent: true });
    expect((await request(on.a).get('/docs/11111111-1111-4111-8111-111111111111/comments')).status).toBe(404);
    expect((await request(on.a).get('/docs/not-an-id/data')).status).toBe(404);
  });

  it('owner-reach cannot put a document into a shared conversation', async () => {
    const on = app({ developmentAgent: true });
    const r = await request(on.a).post('/docs').send({ title: 'x', markdown: 'y', primary: SHARED });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('primary-wider-than-caller');
  });

  it('a confined session works only in its own place, and owner-reach sees metadata only', async () => {
    const confined = app({ developmentAgent: true }, { placeKey: 'telegram:topic:500', kind: 'place' });
    const created = await request(confined.a).post('/docs').send({ title: 'Team plan', markdown: '# Team\n', primary: SHARED });
    expect(created.status).toBe(201);
    expect((await request(confined.a).post('/docs').send({ title: 'Elsewhere', markdown: '# x\n', primary: 'telegram:9' })).status).toBe(409);
    const list = await request(confined.a).get(`/docs?conversation=${SHARED}`);
    expect(list.body.documents).toHaveLength(1);
    // The owner-reach bearer path over the same store.
    const deps = (confined as unknown as { service: DocumentService }).service;
    expect(deps.metadata(created.body.id, { principal: { kind: 'bearer' }, actor: { type: 'agent', placeKey: 'x' }, access: {}, reader: { kind: 'owner' } }).title).toBeNull();
  });

  it('a system session (scheduler, lifeline, agent-to-agent) is owner reach: its documents land in the owner conversation, never a shared one (§3.9b)', async () => {
    const sys = app({ developmentAgent: true }, { placeKey: '', kind: 'system' });
    const made = await request(sys.a).post('/docs').send({ title: 'Job report', markdown: '# r\n' });
    expect(made.status).toBe(201);
    expect(sys.service.facts(made.body.id)?.primary).toBe(OWN);
    expect((await request(sys.a).post('/docs').send({ title: 'x', markdown: 'y', primary: SHARED })).status).toBe(409);
  });

  it('session context lists documents within the line and character budget, with an overflow line', () => {
    const docs = Array.from({ length: 14 }, (_, i) => ({ id: `id-${i}`, title: `Document number ${i}`, version: 1, openComments: 14 - i }));
    const ctx = renderSessionContext(SHARED, docs);
    expect(ctx.text.split('\n').length).toBe(12); // header + 10 + overflow
    expect(ctx.text).toContain('and 4 more documents');
    expect(ctx.text.length).toBeLessThanOrEqual(1700);
  });
});
