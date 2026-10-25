/**
 * Integration tests — passkey CELL HEALTH routes + the one digest (Tier 2).
 * Spec: docs/specs/agent-held-google-passkey.md §4 / §5.2 / §13 / §3.2 (attestation).
 * Real createRoutes() behind the real authMiddleware, real on-disk health / ledger / grant files, a
 * real Ed25519 identity per machine, the peer-state fetch seam injected, and a recording attention sink
 * so the digest's upsert / buzz decisions are observable.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { PASSKEY_HEALTH_AUDIT_LOG, PASSKEY_HEALTH_DIGEST_KEY } from '../../src/core/PasskeyCellHealth.js';

const AUTH_TOKEN = 'test-passkey-health-bearer';
const PIN = '314159';

interface Upsert { id: string; title: string; description?: string; priority: string; silent?: boolean }
interface Machine { id: string; dir: string; stateDir: string; keys: crypto.KeyPairKeyObjectResult; app: express.Express; ctx: RouteContext & Record<string, unknown>; upserts: Upsert[]; holdsLease: boolean; silent: boolean; rope: Record<string, string> }

function machine(id: string, world: Map<string, Machine>, opts: { developmentAgent?: boolean; holdsLease?: boolean; sink?: boolean } = {}): Machine {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pk-health-${id}-`));
  const stateDir = path.join(dir, '.instar'); fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}\n');
  const keys = crypto.generateKeyPairSync('ed25519');
  const pem = (k: crypto.KeyObject) => k.export({ type: 'spki', format: 'pem' }).toString();
  const identityManager = {
    loadIdentity: () => ({ machineId: id }),
    loadSigningKey: () => keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    getSigningPublicKeyPem: (mid: string) => world.get(mid) ? pem(world.get(mid)!.keys.publicKey) : null,
    loadRegistry: () => ({ version: 1, machines: Object.fromEntries([...world.keys()].map((m) => [m, { status: 'active' }])) }),
    getActiveMachines: () => [...world.keys()].map((m) => ({ machineId: m, entry: {} })),
  };
  const m: Partial<Machine> = { id, dir, stateDir, keys, upserts: [], holdsLease: opts.holdsLease ?? true, silent: false, rope: {} };
  const ctx = {
    config: { projectName: 'pk', projectDir: dir, stateDir, port: 0, authToken: AUTH_TOKEN, developmentAgent: opts.developmentAgent ?? true, dashboardPin: PIN, sessions: {}, scheduler: {} },
    sessionManager: { listRunningSessions: () => [] }, state: { getJobState: () => null, getSession: () => null },
    sessionRefresh: null, startTime: new Date(), meshSelfId: id,
    coordinator: { managers: { identityManager }, holdsLease: () => world.get(id)!.holdsLease },
    listPoolMachines: () => [...world.keys()].map((mid) => ({ machineId: mid, nickname: `nick-${mid}`, lastKnownUrl: `http://${mid}.pool.test` })),
    get ropeHealthMonitor() { const me = world.get(id)!; return { status: () => ({ peers: Object.entries(me.rope).map(([machineId, condition]) => ({ machineId, condition })) }) }; },
    ...(opts.sink === false ? {} : { telegram: { upsertAttentionItem: async (item: Upsert) => { world.get(id)!.upserts.push(item); return item; } } }),
    deliverPasskeyCellMandate: async ({ targetMachineId, portable }: { targetMachineId: string; portable: unknown }) => {
      const target = world.get(targetMachineId);
      if (!target) return { ok: false, status: 0, reason: 'no-peer-url' };
      const res = await request(target.app).post('/passkeys/cell-action').set('Authorization', `Bearer ${AUTH_TOKEN}`).send({ portable });
      return { ok: res.status === 200 && res.body.applied === true, status: res.status, reason: res.body.reason, result: res.body };
    },
    fetchPasskeyPeerState: async (peer: { machineId: string }) => {
      const target = world.get(peer.machineId);
      if (!target || target.silent) return { ok: false as const, reason: 'unreachable' as const };
      const res = await request(target.app).get('/passkeys/pool-state').set('Authorization', `Bearer ${AUTH_TOKEN}`).set('X-Instar-Machine-Id', id);
      return res.status === 200 ? { ok: true as const, body: res.body } : { ok: false as const, reason: 'error' as const };
    },
  } as unknown as Machine['ctx'];
  const app = express(); app.use(express.json()); app.use(authMiddleware(AUTH_TOKEN)); app.use('/', createRoutes(ctx));
  const full = { ...m, app, ctx } as Machine;
  world.set(id, full);
  return full;
}

describe('passkey cell health routes + digest (integration)', () => {
  const world = new Map<string, Machine>();
  const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });
  beforeEach(() => world.clear());
  afterEach(() => { for (const m of world.values()) SafeFsExecutor.safeRmSync(m.dir, { recursive: true, force: true, operation: 'tests/integration/passkeys-cell-health-routes.test.ts:afterEach' }); });

  it('503 on every health route when dark; 400s on a bad outcome/origin; 404 for an account with no grant or record', async () => {
    const dark = machine('d1', world, { developmentAgent: false });
    for (const r of [request(dark.app).get('/passkeys/health').set(auth()), request(dark.app).post('/passkeys/health/digest/refresh').set(auth()),
      request(dark.app).post('/passkeys/health/outcome').set(auth()).send({ email: 'a@example.com', outcome: 'ready' }),
      request(dark.app).post('/passkeys/attest-google-removed').set(auth()).send({ pin: PIN, email: 'a@example.com' })]) expect((await r).status).toBe(503);
    world.clear();
    const m = machine('m1', world);
    expect((await request(m.app).post('/passkeys/health/outcome').set(auth()).send({ email: 'a@example.com', outcome: 'meh' })).status).toBe(400);
    expect((await request(m.app).post('/passkeys/health/outcome').set(auth()).send({ email: 'a@example.com', outcome: 'ready', origin: 'ghost' })).status).toBe(400);
    expect((await request(m.app).post('/passkeys/health/outcome').set(auth()).send({ outcome: 'ready' })).status).toBe(400);
    expect((await request(m.app).post('/passkeys/health/outcome').set(auth()).send({ email: 'nobody@example.com', outcome: 'ready' })).status).toBe(404);
  });

  it('records outcomes for a granted cell through the §4 table, audits states only, shows the state in GET /passkeys and the pool state, and the digest buzzes once then stays quiet', async () => {
    const m = machine('m1', world);
    expect((await request(m.app).post('/passkeys/grant').set(auth()).send({ pin: PIN, email: 'a@example.com' })).status).toBe(200);
    const first = await request(m.app).post('/passkeys/health/outcome').set(auth()).send({ email: 'A@example.com', outcome: 'failed', origin: 'watcher' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ cell: { state: 'healthy' }, transition: null });
    expect(first.body.scheduleConfirmAt).toEqual(expect.any(String));
    // Before any transition the digest is empty: nothing to report, nothing upserted.
    const quiet = await request(m.app).post('/passkeys/health/digest/refresh').set(auth());
    expect(quiet.body).toMatchObject({ holdsLease: true, action: 'none', delivered: 'skipped', digest: { empty: true } });
    expect(m.upserts).toHaveLength(0);
    // The confirming failure lands ≥1h later in wall time — simulate by recording a security outcome instead (immediate, terminal).
    const sec = await request(m.app).post('/passkeys/health/outcome').set(auth()).send({ email: 'a@example.com', outcome: 'security', origin: 'repair' });
    expect(sec.body.transition).toMatchObject({ from: 'healthy', to: 'security' });
    const audit = fs.readFileSync(path.join(m.stateDir, PASSKEY_HEALTH_AUDIT_LOG), 'utf8');
    expect(audit).toContain('"to":"security"');
    expect(audit).not.toContain('a@example.com');
    const health = await request(m.app).get('/passkeys/health').set(auth());
    expect(health.status).toBe(200);
    expect(health.body.cells).toEqual([expect.objectContaining({ canonicalEmail: 'a@example.com', state: 'security', googleSide: 'none' })]);
    expect((await request(m.app).get('/passkeys').set(auth())).body.cells[0]).toMatchObject({ health: 'security', googleSide: 'none' });
    expect((await request(m.app).get('/passkeys/pool-state').set(auth())).body.cells[0].health).toBe('security');
    // Security ⇒ urgent digest, HIGH, buzzed once; a second pass with the same content upserts nothing.
    const buzz = await request(m.app).post('/passkeys/health/digest/refresh').set(auth());
    expect(buzz.body).toMatchObject({ action: 'buzz', delivered: 'upserted', digest: { urgent: true, counts: { cells: 1 } } });
    expect(m.upserts).toEqual([expect.objectContaining({ id: PASSKEY_HEALTH_DIGEST_KEY, priority: 'HIGH', title: expect.stringContaining('SECURITY') })]);
    expect(m.upserts[0].description).toContain('a@example.com on m1: security');
    const again = await request(m.app).post('/passkeys/health/digest/refresh').set(auth());
    expect(again.body.action).toBe('none');
    expect(m.upserts).toHaveLength(1);
    expect((await request(m.app).get('/passkeys/health').set(auth())).body.digest.lastBuzzAt).toEqual(expect.any(String));
    // The two PERMISSIVE provenances need the dashboard PIN over HTTP — a Bearer body cannot assert an
    // operator-triggered proof or a re-enrollment (Know Your Principal).
    expect((await request(m.app).post('/passkeys/health/outcome').set(auth()).send({ email: 'a@example.com', outcome: 'ready', origin: 'operator' })).status).toBe(403);
    expect((await request(m.app).post('/passkeys/health/outcome').set(auth()).send({ email: 'a@example.com', outcome: 'ready', origin: 'enrollment', reenrolled: true })).status).toBe(403);
    expect((await request(m.app).get('/passkeys/health').set(auth())).body.cells[0].state).toBe('security');
    // With the PIN: an operator ready still cannot leave `security`; only a re-enrollment can.
    expect((await request(m.app).post('/passkeys/health/outcome').set(auth()).send({ pin: PIN, email: 'a@example.com', outcome: 'ready', origin: 'operator' })).body.transition).toBeNull();
    const re = await request(m.app).post('/passkeys/health/outcome').set(auth()).send({ pin: PIN, email: 'a@example.com', outcome: 'ready', origin: 'enrollment', reenrolled: true });
    expect(re.body.transition).toMatchObject({ from: 'security', to: 'healthy', cause: 'reenrolled' });
    // Nothing left to report ⇒ the ledger resolves the episode once.
    expect((await request(m.app).post('/passkeys/health/digest/refresh').set(auth())).body).toMatchObject({ action: 'resolve', delivered: 'resolved' });
    expect((await request(m.app).post('/passkeys/health/digest/refresh').set(auth())).body.action).toBe('none');
  });

  it('attest-google-removed (PIN + mandate) marks the cell operator-attested — never removed — and the digest carries it; a verified removal is never downgraded', async () => {
    const m1 = machine('m1', world); const m2 = machine('m2', world);
    // A multi-machine agent's first grant needs a confirmed peer issuer (issuer bootstrap, §3.3).
    expect((await request(m1.app).post('/passkeys/issuer-add').set(auth()).send({ pin: PIN, machineId: 'm2' })).status).toBe(200);
    expect((await request(m1.app).post('/passkeys/grant').set(auth()).send({ pin: PIN, email: 'a@example.com' })).status).toBe(200);
    expect((await request(m1.app).post('/passkeys/attest-google-removed').set(auth()).send({ email: 'a@example.com' })).status).toBe(403);
    // A granted cell with NO health record yet cannot be attested (nothing to attach the state to)…
    const premature = await request(m1.app).post('/passkeys/attest-google-removed').set(auth()).send({ pin: PIN, email: 'a@example.com' });
    expect(premature.status).toBe(400);
    expect(premature.body).toMatchObject({ applied: false, reason: 'no-cell-record' });
    // …once a proof outcome exists, it can.
    expect((await request(m1.app).post('/passkeys/health/outcome').set(auth()).send({ email: 'a@example.com', outcome: 'unknown' })).status).toBe(200);
    const att = await request(m1.app).post('/passkeys/attest-google-removed').set(auth()).send({ pin: PIN, email: 'a@example.com' });
    expect(att.status).toBe(200);
    expect(att.body).toMatchObject({ applied: true, op: 'attest-google-removed', result: { googleSide: 'operator-attested', attestedBy: 'local-pin:m1' } });
    expect((await request(m1.app).get('/passkeys/health').set(auth())).body.cells[0].googleSide).toBe('operator-attested');
    const d = await request(m1.app).post('/passkeys/health/digest/refresh').set(auth());
    expect(d.body.digest.body).toContain('google-side: operator-attested');
    // As a mandate onto m2 (m2 confirms m1 as an issuer first). m2 never held the cell, so the
    // attestation is refused by name — it never MINTS a health record on a machine without one.
    expect((await request(m2.app).post('/passkeys/issuer-add').set(auth()).send({ pin: PIN, machineId: 'm1' })).status).toBe(200);
    const remote = await request(m1.app).post('/passkeys/attest-google-removed').set(auth()).send({ pin: PIN, email: 'a@example.com', targetMachineId: 'm2' });
    expect(remote.status).toBe(502);
    expect(remote.body).toMatchObject({ delivered: false, target: 'm2', reason: 'no-cell-record' });
    expect((await request(m2.app).get('/passkeys/health').set(auth())).body.cells).toEqual([]);
    // Once m2 holds the cell (grant + a recorded outcome), the same mandate applies.
    expect((await request(m2.app).post('/passkeys/grant').set(auth()).send({ pin: PIN, email: 'a@example.com' })).status).toBe(200);
    expect((await request(m2.app).post('/passkeys/health/outcome').set(auth()).send({ email: 'a@example.com', outcome: 'unknown' })).status).toBe(200);
    const remote2 = await request(m1.app).post('/passkeys/attest-google-removed').set(auth()).send({ pin: PIN, email: 'a@example.com', targetMachineId: 'm2' });
    expect(remote2.body).toMatchObject({ delivered: true, target: 'm2' });
    expect((await request(m2.app).get('/passkeys/health').set(auth())).body.cells[0]).toMatchObject({ googleSide: 'operator-attested' });
    // A revoke removes the cell's health record with the grant: nothing left to age or list.
    expect((await request(m2.app).post('/passkeys/revoke').set(auth()).send({ pin: PIN, email: 'a@example.com' })).status).toBe(200);
    expect((await request(m2.app).get('/passkeys/health').set(auth())).body.cells).toEqual([]);
    expect((await request(m2.app).post('/passkeys/health/outcome').set(auth()).send({ email: 'a@example.com', outcome: 'unknown' })).status).toBe(404);
  });

  it('a non-holder narrates only its own machine; the lease holder\'s digest merges peers\' published health, quarantined custody and unobserved peers (silently)', async () => {
    const holder = machine('m1', world, { holdsLease: true }); const other = machine('m2', world, { holdsLease: false }); const dark = machine('m3', world, { holdsLease: false });
    expect((await request(holder.app).post('/passkeys/issuer-add').set(auth()).send({ pin: PIN, machineId: 'm2' })).status).toBe(200);
    expect((await request(other.app).post('/passkeys/issuer-add').set(auth()).send({ pin: PIN, machineId: 'm1' })).status).toBe(200);
    for (const m of [holder, other]) expect((await request(m.app).post('/passkeys/grant').set(auth()).send({ pin: PIN, email: 'a@example.com' })).status).toBe(200);
    expect((await request(other.app).post('/passkeys/health/outcome').set(auth()).send({ email: 'a@example.com', outcome: 'credential-rejected', origin: 'repair' })).body.transition?.to).toBe('rejected');
    // The non-holder's own digest lists its cell only; it never narrates the pool.
    const own = await request(other.app).post('/passkeys/health/digest/refresh').set(auth());
    expect(own.body).toMatchObject({ holdsLease: false, action: 'buzz' });
    expect(own.body.digest.body).toContain('a@example.com on m2: rejected');
    expect(own.body.digest.body).not.toContain('unobserved');
    // The holder sees m2's published `rejected` cell and names the dark peer — the peer section is silent (no extra buzz on peer change).
    dark.silent = true; holder.rope = { m3: 'peer-offline' };
    await request(holder.app).post('/passkeys/pool-state/tick').set(auth());
    const pool = await request(holder.app).post('/passkeys/health/digest/refresh').set(auth());
    expect(pool.body).toMatchObject({ holdsLease: true, action: 'buzz', digest: { counts: { cells: 1, unobservedPeers: 1 } } });
    expect(pool.body.digest.body).toContain('a@example.com on m2: rejected');
    expect(pool.body.digest.body).toContain('nick-m3 (peer-offline)');
    // Peer list changes alone are a SILENT update, never a buzz.
    holder.rope = {};
    await request(holder.app).post('/passkeys/pool-state/tick').set(auth());
    const peersChanged = await request(holder.app).post('/passkeys/health/digest/refresh').set(auth());
    expect(peersChanged.body.action).toBe('silent');
    expect(holder.upserts).toHaveLength(2);
    // The ledger's verdict reaches the SINK: the buzz was a notifying upsert, the peer-only change a silent one.
    expect(holder.upserts[0].silent).toBe(false);
    expect(holder.upserts[1].silent).toBe(true);
  });

  it('without an attention sink the pass reports no-sink and records nothing (a later pass with a sink still buzzes)', async () => {
    const m = machine('m1', world, { sink: false });
    expect((await request(m.app).post('/passkeys/grant').set(auth()).send({ pin: PIN, email: 'a@example.com' })).status).toBe(200);
    await request(m.app).post('/passkeys/health/outcome').set(auth()).send({ email: 'a@example.com', outcome: 'credential-rejected', origin: 'repair' });
    expect((await request(m.app).post('/passkeys/health/digest/refresh').set(auth())).body).toMatchObject({ action: 'buzz', delivered: 'no-sink' });
    (m.ctx as Record<string, unknown>).telegram = { upsertAttentionItem: async (item: Upsert) => { m.upserts.push(item); return item; } };
    expect((await request(m.app).post('/passkeys/health/digest/refresh').set(auth())).body).toMatchObject({ action: 'buzz', delivered: 'upserted' });
    expect(m.upserts).toHaveLength(1);
  });
});
