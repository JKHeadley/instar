// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * The dashboard check-in (docs/specs/chief-of-staff-topic.md §4) through the REAL routes: a PIN-gated
 * POST renews the operator lease with a machine-signed record (the loop's `checkIn`), a wrong PIN or a
 * missing PIN renews nothing, and the status route then shows the lease live with the conversation key.
 * Feature off (no loop) ⇒ 503 on both.
 */
import { describe, it, expect, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { sign, verify } from '../../src/core/MachineIdentity.js';
import { ChiefOfStaffLoop, CHIEF_OF_STAFF_LOOP_DEFAULTS } from '../../src/core/ChiefOfStaffLoop.js';
import { chiefOfStaffRecordStoreSchema, type UnionEntry } from '../../src/core/ChiefOfStaffStore.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/chief-of-staff-check-in.test.ts' }); });

function keypair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return { priv: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, pub: publicKey.export({ type: 'spki', format: 'pem' }) as string };
}
const ctxV = () => ({ countDroppedField: () => {}, countJailReject: () => {} });

function app(opts: { loop: boolean }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-checkin-')); dirs.push(dir);
  const keys = keypair();
  const entries: UnionEntry[] = []; let clock = 1; let seq = 0;
  const loop = new ChiefOfStaffLoop({
    now: () => Date.now(), machineId: 'm1', enabled: () => true, holdsLease: () => true, config: () => CHIEF_OF_STAFF_LOOP_DEFAULTS,
    journal: {
      emit: (recordKey, build) => { const hlc: HlcTimestamp = { physical: ++clock, logical: 0, node: 'm1' }; const data = build(hlc, 'm1'); if (!data) return { outcome: 'dropped' }; const v = chiefOfStaffRecordStoreSchema.validate(data, ctxV()); if (!v) return { outcome: 'dropped:schema' }; entries.push({ data: { ...v, recordKey, hlc, op: 'put', origin: 'm1' }, origin: 'm1' }); return { outcome: 'emitted', seq: ++seq }; },
      loadUnion: () => entries.slice(),
    },
    verifyRenewal: (r) => verify(`cos-renewal:${r.renewedAt}:${r.renewedVia}:${r.principal}:${r.machine}`, String(r.machineSignature), keys.pub),
    gather: async () => { throw new Error('n/a'); }, judge: async () => null,
    protocol: { claim: async () => ({ outcome: 'rejected', reason: 'n/a' }), standDown: () => null, settleOpenIntent: async () => 'lost', operatorLeaseLive: () => false } as never,
    mirrorInitiativeStatus: () => {}, sendNote: async () => {}, sendImmediate: async () => {}, statusUrl: () => 'x', localHour: () => 8,
    sign: (c) => sign(c, keys.priv),
  });
  const state = new Map<string, unknown>([['chief-of-staff-topic', 900]]);
  const ctx = {
    config: { projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', dashboardPin: '424242', sessions: {}, scheduler: {} },
    startTime: new Date(), scheduler: null,
    sessionManager: { listRunningSessions: () => [], killSession: () => true },
    state: { get: (k: string) => state.get(k) ?? null, getJobState: () => null, getSession: () => null, queryEvents: () => [], getCoherenceJournal: () => undefined, readOnly: false },
    liveConfig: { get: (_k: string, fb?: unknown) => fb },
    ...(opts.loop ? { chiefOfStaffLoop: loop } : {}),
  } as unknown as RouteContext;
  const a = express();
  a.use(express.json());
  a.use(authMiddleware(() => 'tok-1', 'echo'));
  a.use(createRoutes(ctx));
  return { a, entries };
}
const auth = { Authorization: 'Bearer tok-1', 'X-Instar-AgentId': 'echo', 'X-Instar-Request': '1' };

describe('POST /chief-of-staff/check-in', () => {
  it('feature off ⇒ 503 on check-in and status', async () => {
    const { a } = app({ loop: false });
    expect((await request(a).post('/chief-of-staff/check-in').set(auth).send({ pin: '424242' })).status).toBe(503);
    expect((await request(a).get('/chief-of-staff').set(auth)).status).toBe(503);
  });
  it('a missing or wrong PIN renews nothing; the right PIN writes a signed renewal and the lease reads live with the conversation key', async () => {
    const { a, entries } = app({ loop: true });
    const before = await request(a).get('/chief-of-staff').set(auth);
    expect(before.status).toBe(200); expect(before.body.lease.live).toBe(false); expect(before.body.conversationKey).toBe('telegram:900');
    expect((await request(a).post('/chief-of-staff/check-in').set(auth).send({})).status).toBeGreaterThanOrEqual(400);
    expect((await request(a).post('/chief-of-staff/check-in').set(auth).send({ pin: '000000' })).status).toBeGreaterThanOrEqual(400);
    expect(entries.filter((e) => e.data.recordType === 'renewal')).toHaveLength(0);
    const ok = await request(a).post('/chief-of-staff/check-in').set(auth).send({ pin: '424242' });
    expect(ok.status).toBe(200); expect(ok.body.ok).toBe(true); expect(ok.body.lease.live).toBe(true);
    const renewals = entries.filter((e) => e.data.recordType === 'renewal');
    expect(renewals).toHaveLength(1); expect(renewals[0].data.renewedVia).toBe('console'); expect(renewals[0].data.principal).toBe('console:owner');
    const after = await request(a).get('/chief-of-staff').set(auth);
    expect(after.body.lease.live).toBe(true);
  });
});
