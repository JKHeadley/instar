/**
 * Integration tests — the passkey POOL READ PATH routes (Tier 2).
 * Spec: docs/specs/agent-held-google-passkey.md §5.1 / §3.7 / §4.
 * Real createRoutes() behind the real authMiddleware, real on-disk grant / ledger / exclusion /
 * last-known files per machine, a real Ed25519 identity pair per machine, and the peer fetch seam
 * injected so a multi-machine pool is driven in one process (each peer answers from its OWN routes).
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
import { PasskeyAttemptLedger, PASSKEY_POOL_LASTKNOWN_FILE } from '../../src/core/PasskeyPoolState.js';

const AUTH_TOKEN = 'test-passkey-pool-bearer';
const PIN = '112358';

type Rope = 'ok' | 'degraded' | 'peer-offline' | 'urgent' | 'auth-rejected' | 'unknown';
interface Machine { id: string; dir: string; stateDir: string; keys: crypto.KeyPairKeyObjectResult; app: express.Express; ctx: RouteContext & Record<string, unknown>; silent: boolean; rope: Record<string, Rope>; ropeAvailable: boolean }

function machine(id: string, world: Map<string, Machine>, opts: { developmentAgent?: boolean; registryStatus?: Record<string, 'active' | 'revoked' | 'pending'>; ropeAvailable?: boolean } = {}): Machine {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pk-pool-${id}-`));
  const stateDir = path.join(dir, '.instar'); fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}\n');
  const keys = crypto.generateKeyPairSync('ed25519');
  const pem = (k: crypto.KeyObject) => k.export({ type: 'spki', format: 'pem' }).toString();
  const identityManager = {
    loadIdentity: () => ({ machineId: id }),
    loadSigningKey: () => keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    getSigningPublicKeyPem: (mid: string) => world.get(mid) ? pem(world.get(mid)!.keys.publicKey) : null,
    loadRegistry: () => ({ version: 1, machines: Object.fromEntries([...world.keys()].map((m) => [m, { status: opts.registryStatus?.[m] ?? 'active' }])) }),
    getActiveMachines: () => [...world.keys()].filter((m) => (opts.registryStatus?.[m] ?? 'active') === 'active').map((m) => ({ machineId: m, entry: {} })),
  };
  const self: Partial<Machine> = { id, dir, stateDir, keys, silent: false, rope: {}, ropeAvailable: opts.ropeAvailable ?? true };
  const ctx = {
    config: { projectName: 'pk', projectDir: dir, stateDir, port: 0, authToken: AUTH_TOKEN, developmentAgent: opts.developmentAgent ?? true, dashboardPin: PIN, sessions: {}, scheduler: {}, multiMachine: { secretSync: { pushEnabled: id === 'm1' } } },
    sessionManager: { listRunningSessions: () => [] }, state: { getJobState: () => null, getSession: () => null },
    sessionRefresh: null, startTime: new Date(), meshSelfId: id,
    coordinator: { managers: { identityManager } },
    listPoolMachines: () => [...world.keys()].map((m) => ({ machineId: m, nickname: `nick-${m}`, lastKnownUrl: `http://${m}.pool.test` })),
    // Rope health as the test controls it per machine.
    get ropeHealthMonitor() {
      const me = world.get(id)!;
      return me.ropeAvailable ? { status: () => ({ peers: Object.entries(me.rope).map(([machineId, condition]) => ({ machineId, condition })) }) } : null;
    },
    deliverPasskeyCellMandate: async ({ targetMachineId, portable }: { targetMachineId: string; portable: unknown }) => {
      const target = world.get(targetMachineId);
      if (!target) return { ok: false, status: 0, reason: 'no-peer-url' };
      const res = await request(target.app).post('/passkeys/cell-action').set('Authorization', `Bearer ${AUTH_TOKEN}`).send({ portable });
      return { ok: res.status === 200 && res.body.applied === true, status: res.status, reason: res.body.reason, result: res.body };
    },
    // In-process pool: a peer's pool-state is served by ITS OWN route (with this machine's id as caller); a silent peer never answers.
    fetchPasskeyPeerState: async (peer: { machineId: string }) => {
      const target = world.get(peer.machineId);
      if (!target || target.silent) return { ok: false as const, reason: 'unreachable' as const };
      const res = await request(target.app).get('/passkeys/pool-state').set('Authorization', `Bearer ${AUTH_TOKEN}`).set('X-Instar-Machine-Id', id);
      if (res.status === 403) return { ok: false as const, reason: 'unauthorized' as const };
      if (res.status === 503) return { ok: false as const, reason: 'route-missing' as const };
      if (res.status !== 200) return { ok: false as const, reason: 'error' as const };
      return { ok: true as const, body: res.body };
    },
  } as unknown as Machine['ctx'];
  const app = express(); app.use(express.json()); app.use(authMiddleware(AUTH_TOKEN)); app.use('/', createRoutes(ctx));
  const m = { ...self, app, ctx } as Machine;
  world.set(id, m);
  return m;
}

describe('passkey pool read path routes (integration)', () => {
  const world = new Map<string, Machine>();
  const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });
  beforeEach(() => world.clear());
  afterEach(() => { for (const m of world.values()) SafeFsExecutor.safeRmSync(m.dir, { recursive: true, force: true, operation: 'tests/integration/passkeys-pool-read-path-routes.test.ts:afterEach' }); });

  it('401 without a bearer; 503 on every pool route when dark (fleet config)', async () => {
    const m = machine('m1', world, { developmentAgent: false });
    expect((await request(m.app).get('/passkeys')).status).toBe(401);
    for (const r of [
      request(m.app).get('/passkeys').set(auth()),
      request(m.app).get('/passkeys?scope=pool').set(auth()),
      request(m.app).get('/passkeys/pool-state').set(auth()),
      request(m.app).post('/passkeys/pool-state/tick').set(auth()),
      request(m.app).get('/passkeys/admission?action=enroll').set(auth()),
      request(m.app).post('/passkeys/exclude-peer').set(auth()).send({ pin: PIN, machineId: 'm2' }),
    ]) expect((await r).status).toBe(503);
  });

  it('a single machine: GET /passkeys shows its cells, custody names only, attempts and pauses; ?scope=pool is never degraded; nothing secret in any body', async () => {
    const m = machine('m1', world);
    const g = await request(m.app).post('/passkeys/grant').set(auth()).send({ pin: PIN, email: 'A@Example.com' });
    expect(g.status).toBe(200);
    new PasskeyAttemptLedger({ stateDir: m.stateDir, machineId: 'm1' }).recordAttempt({ canonicalEmail: 'a@example.com', kind: 'enrollment' });
    const local = await request(m.app).get('/passkeys').set(auth());
    expect(local.status).toBe(200);
    expect(local.body).toMatchObject({ scope: 'local', machineId: 'm1', pushEnabled: true, exclusions: [] });
    expect(local.body.cells).toEqual([{ canonicalEmail: 'a@example.com', granted: true, grantLocalSeq: 1, grantedAt: expect.any(String), custody: 'absent', googleCreatedAt: null, health: 'unknown' }]);
    expect(local.body.attempts).toHaveLength(1);
    const pool = await request(m.app).get('/passkeys?scope=pool').set(auth());
    expect(pool.status).toBe(200);
    expect(pool.body).toMatchObject({ scope: 'pool', singleMachine: true, degraded: false, peers: [], ageMs: expect.any(Number) });
    expect(JSON.stringify(pool.body)).not.toMatch(/portable|privateKey|emailKey|signature/);
  });

  it('two machines: the pool view merges an observed peer\'s rows; the peer\'s rate-limit rows bound THIS machine\'s enrollment admission', async () => {
    const m1 = machine('m1', world); const m2 = machine('m2', world);
    // m2 has three attempts on the account today: pool-wide daily cap reached for m1 too.
    const ledger = new PasskeyAttemptLedger({ stateDir: m2.stateDir, machineId: 'm2' });
    for (const kind of ['enrollment', 'proof', 'repair'] as const) ledger.recordAttempt({ canonicalEmail: 'a@example.com', kind });
    const pool = await request(m1.app).get('/passkeys?scope=pool').set(auth());
    expect(pool.status).toBe(200);
    expect(pool.body.peers).toHaveLength(1);
    expect(pool.body.peers[0]).toMatchObject({ machineId: 'm2', nickname: 'nick-m2', condition: 'observed', fetch: 'ok' });
    expect(pool.body.peers[0].state.attempts.every((a: { machineId: string }) => a.machineId === 'm2')).toBe(true);
    expect(pool.body.degraded).toBe(false);
    const adm = await request(m1.app).get('/passkeys/admission?action=enroll&email=a@example.com').set(auth());
    expect(adm.status).toBe(200);
    expect(adm.body).toMatchObject({ allowed: false, pool: { allowed: true }, rateLimit: { allowed: false, reason: 'account-daily-cap' }, inputs: { suspension: 'not-published-on-this-build' } });
    // The same-account gap: m2 proved the account within 6h ⇒ m1 may not prove it yet; a repair is never gap-gated.
    const prove = await request(m1.app).get('/passkeys/admission?action=prove&email=a@example.com').set(auth());
    expect(prove.body).toMatchObject({ allowed: false, sameAccountGap: { allowed: false, blockedBy: 'm2' } });
    const repair = await request(m1.app).get('/passkeys/admission?action=repair&email=a@example.com').set(auth());
    expect(repair.body).toMatchObject({ allowed: true, pool: { allowed: true, mode: 'normal' }, sameAccountGap: null });
    expect((await request(m1.app).get('/passkeys/admission?action=bogus').set(auth())).status).toBe(400);
  });

  it('a silent peer: partitioned (rope ok) blocks enroll/prove but not repair/revoke; rope peer-offline keeps its LAST-KNOWN rows and does not block; rope absent ⇒ partitioned', async () => {
    const m1 = machine('m1', world); const m2 = machine('m2', world);
    new PasskeyAttemptLedger({ stateDir: m2.stateDir, machineId: 'm2' }).recordAttempt({ canonicalEmail: 'a@example.com', kind: 'proof' });
    // Observe once so last-known rows exist on m1's disk.
    expect((await request(m1.app).post('/passkeys/pool-state/tick').set(auth())).body.peers[0].condition).toBe('observed');
    expect(fs.existsSync(path.join(m1.stateDir, PASSKEY_POOL_LASTKNOWN_FILE))).toBe(true);
    m2.silent = true; m1.rope = { m2: 'ok' };
    const part = await request(m1.app).post('/passkeys/pool-state/tick').set(auth());
    expect(part.body.peers[0]).toMatchObject({ condition: 'partitioned', fetch: 'unreachable' });
    expect(part.body.degraded).toBe(true);
    expect((await request(m1.app).get('/passkeys/admission?action=enroll&email=b@example.com').set(auth())).body).toMatchObject({ allowed: false, pool: { reason: 'passkey-pool-state-unavailable' } });
    expect((await request(m1.app).get('/passkeys/admission?action=repair').set(auth())).body.pool.allowed).toBe(true);
    expect((await request(m1.app).get('/passkeys/admission?action=revoke').set(auth())).body.pool).toMatchObject({ allowed: true, mode: 'queued' });
    m1.rope = { m2: 'peer-offline' };
    const off = await request(m1.app).post('/passkeys/pool-state/tick').set(auth());
    expect(off.body.peers[0]).toMatchObject({ condition: 'peer-offline', lastObservedAt: expect.any(String) });
    expect(off.body.peers[0].state.attempts).toHaveLength(1);
    expect(off.body.degraded).toBe(false);
    // The offline peer's last-known proof still enforces the same-account gap (restrictive direction).
    expect((await request(m1.app).get('/passkeys/admission?action=prove&email=a@example.com').set(auth())).body).toMatchObject({ allowed: false, pool: { allowed: true }, sameAccountGap: { allowed: false, blockedBy: 'm2' } });
    m1.ropeAvailable = false;
    expect((await request(m1.app).post('/passkeys/pool-state/tick').set(auth())).body.peers[0].condition).toBe('partitioned');
  });

  it('GET /passkeys/pool-state refuses a caller that is not an ACTIVE paired machine (revoked / pending / unknown), and the reader reports it unauthorized', async () => {
    const m1 = machine('m1', world, { registryStatus: { m2: 'revoked', m3: 'pending' } }); machine('m2', world); machine('m3', world);
    expect((await request(m1.app).get('/passkeys/pool-state').set(auth()).set('X-Instar-Machine-Id', 'm2')).status).toBe(403);
    expect((await request(m1.app).get('/passkeys/pool-state').set(auth()).set('X-Instar-Machine-Id', 'm3')).status).toBe(403);
    expect((await request(m1.app).get('/passkeys/pool-state').set(auth()).set('X-Instar-Machine-Id', 'ghost')).status).toBe(403);
    expect((await request(m1.app).get('/passkeys/pool-state').set(auth()).set('X-Instar-Machine-Id', 'm1')).status).toBe(200);
    expect((await request(m1.app).get('/passkeys/pool-state').set(auth())).status).toBe(200);
    // A recovery-QUARANTINED identity claim (registry entry still active) is refused too; an unreadable
    // quarantine ledger refuses rather than serves.
    const m4 = machine('m4', world);
    (m1.ctx as Record<string, unknown>).identityReannounce = { status: () => ({ pending: [{ machineId: 'm4', status: 'pending' }], recent: [] }) };
    const q = await request(m1.app).get('/passkeys/pool-state').set(auth()).set('X-Instar-Machine-Id', 'm4');
    expect(q.status).toBe(403);
    expect(q.body).toEqual({ error: 'peer-not-active', status: 'recovery-quarantined' });
    (m1.ctx as Record<string, unknown>).identityReannounce = { status: () => { throw new Error('ledger unreadable'); } };
    expect((await request(m1.app).get('/passkeys/pool-state').set(auth()).set('X-Instar-Machine-Id', 'm4')).status).toBe(403);
    (m1.ctx as Record<string, unknown>).identityReannounce = null;
    expect((await request(m1.app).get('/passkeys/pool-state').set(auth()).set('X-Instar-Machine-Id', 'm4')).status).toBe(200);
    void m4;
    // m2 (revoked on m1) asking m1: unauthorized ⇒ from m2's point of view m1 is partitioned.
    const m2 = world.get('m2')!; m2.rope = { m1: 'ok', m3: 'ok' };
    const snap = (await request(m2.app).post('/passkeys/pool-state/tick').set(auth())).body;
    expect(snap.peers.find((p: { machineId: string }) => p.machineId === 'm1')).toMatchObject({ condition: 'partitioned', fetch: 'unauthorized' });
  });

  it('exclude-peer / include-peer: PIN-gated, unknown machine 409, excluded peer reads `excluded` (not degraded), auto-clears when it answers; the op also travels as a passkey-cell mandate', async () => {
    const m1 = machine('m1', world); const m2 = machine('m2', world); machine('m3', world);
    expect((await request(m1.app).post('/passkeys/exclude-peer').set(auth()).send({ machineId: 'm2' })).status).toBe(403);
    expect((await request(m1.app).post('/passkeys/exclude-peer').set(auth()).send({ pin: PIN, machineId: 'nobody' })).status).toBe(409);
    expect((await request(m1.app).post('/passkeys/exclude-peer').set(auth()).send({ pin: PIN })).status).toBe(400);
    expect((await request(m1.app).post('/passkeys/exclude-peer').set(auth()).send({ pin: PIN, machineId: 'm1' })).body).toMatchObject({ applied: false, reason: 'cannot-exclude-self' });
    m2.silent = true; m1.rope = { m2: 'ok', m3: 'ok' };
    expect((await request(m1.app).post('/passkeys/pool-state/tick').set(auth())).body.degraded).toBe(true);
    const ex = await request(m1.app).post('/passkeys/exclude-peer').set(auth()).send({ pin: PIN, machineId: 'm2' });
    expect(ex.status).toBe(200);
    expect(ex.body).toMatchObject({ applied: true, op: 'exclude-peer', result: { machineId: 'm2', changed: true } });
    const snap = (await request(m1.app).post('/passkeys/pool-state/tick').set(auth())).body;
    expect(snap.peers.find((p: { machineId: string }) => p.machineId === 'm2').condition).toBe('excluded');
    expect(snap.degraded).toBe(false);
    expect((await request(m1.app).get('/passkeys').set(auth())).body.exclusions).toEqual([{ machineId: 'm2', excludedAt: expect.any(String), excludedBy: 'local-pin:m1' }]);
    // The peer answers again ⇒ exclusion clears by itself.
    m2.silent = false;
    expect((await request(m1.app).post('/passkeys/pool-state/tick').set(auth())).body.peers.find((p: { machineId: string }) => p.machineId === 'm2').condition).toBe('observed');
    expect((await request(m1.app).get('/passkeys').set(auth())).body.exclusions).toEqual([]);
    // include-peer on a non-excluded peer is a no-op that still applies (idempotent).
    expect((await request(m1.app).post('/passkeys/include-peer').set(auth()).send({ pin: PIN, machineId: 'm2' })).body).toMatchObject({ applied: true, result: { changed: false } });
    // As a mandate: m1 (after bootstrapping m3 as an issuer on m3's side is not needed — m1 signs, m3 must trust m1) — m3 confirms m1 as issuer, then m1 excludes m2 ON m3.
    const m3 = world.get('m3')!;
    expect((await request(m3.app).post('/passkeys/issuer-add').set(auth()).send({ pin: PIN, machineId: 'm1' })).status).toBe(200);
    const remote = await request(m1.app).post('/passkeys/exclude-peer').set(auth()).send({ pin: PIN, machineId: 'm2', targetMachineId: 'm3' });
    expect(remote.status).toBe(200);
    expect(remote.body).toMatchObject({ delivered: true, target: 'm3' });
    expect((await request(m3.app).get('/passkeys').set(auth())).body.exclusions).toEqual([{ machineId: 'm2', excludedAt: expect.any(String), excludedBy: 'mandate:m1' }]);
  });
});
