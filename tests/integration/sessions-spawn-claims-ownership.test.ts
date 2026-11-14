// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Integration — POST /sessions/spawn with a topicId records THIS machine as the
 * topic's owner (Echo Bugs topic 10000001485, 2026-11-03).
 *
 * Before: the route bound the session locally but never wrote the ownership
 * record, so GET /pool/placement answered "unowned" while the session ran, and
 * a peer's router placed the user's next message on itself — a second copy
 * (topic 136774: Studio build session + a Mama PC copy).
 *
 * Full HTTP route pipeline; REAL SessionOwnershipRegistry and the REAL
 * createClaimOwnershipOnSpawn factory server.ts wires; only the session
 * manager is the shared mock.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createRoutes } from '../../src/server/routes.js';
import { SessionOwnershipRegistry, InMemorySessionOwnershipStore } from '../../src/core/SessionOwnershipRegistry.js';
import { createClaimOwnershipOnSpawn } from '../../src/core/ownershipFollowsLiveWork.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createMockSessionManager } from '../helpers/setup.js';

const SELF = 'm_studio';
const PEER = 'm_mamapc';

describe('POST /sessions/spawn — topic-bound spawn claims ownership', () => {
  let tmpDir: string;
  let ownReg: SessionOwnershipRegistry;
  let emits: Array<{ sk: string; ok: boolean }>;

  function app(withClaim: boolean): express.Express {
    const a = express();
    a.use(express.json());
    const ctx: any = {
      config: { authToken: 'test', stateDir: tmpDir, port: 0 },
      sessionManager: createMockSessionManager(),
      startTime: new Date(),
      claimTopicOwnershipOnSpawn: withClaim
        ? createClaimOwnershipOnSpawn({
            enabled: true,
            selfMachineId: SELF,
            ownReg,
            emitPlacement: (sk, r) => emits.push({ sk, ok: r.ok }),
          })
        : null,
    };
    a.use(createRoutes(ctx));
    return a;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-claims-own-'));
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    const seen = new Set<string>();
    ownReg = new SessionOwnershipRegistry({
      store: new InMemorySessionOwnershipStore(),
      seenNonce: (k) => seen.has(k),
      recordNonce: (k) => seen.add(k),
    });
    emits = [];
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/sessions-spawn-claims-ownership.test.ts' });
  });

  it('a topic-bound spawn makes this machine the active owner and journals it', async () => {
    const res = await request(app(true))
      .post('/sessions/spawn')
      .set('Authorization', 'Bearer test')
      .send({ name: 'bug-fix', prompt: 'go', topicId: 10000001485, requireTopicBinding: true });
    expect(res.status).toBe(201);
    expect(res.body.topicBound).toBe(true);
    expect(res.body.ownership).toBe('claimed');
    const rec = ownReg.read('10000001485');
    expect(rec?.ownerMachineId).toBe(SELF);
    expect(rec?.status).toBe('active');
    expect(emits.filter((e) => e.ok)).toHaveLength(2);
  });

  it('a topic a PEER already owns is not taken; the response says so', async () => {
    ownReg.cas({ type: 'place', machineId: PEER }, { sessionKey: '136774', sender: 'ROUTER', nonce: 'p' });
    ownReg.cas({ type: 'claim', machineId: PEER }, { sessionKey: '136774', sender: PEER, nonce: 'c' });
    const res = await request(app(true))
      .post('/sessions/spawn')
      .set('Authorization', 'Bearer test')
      .send({ name: 'people-roles', prompt: 'go', topicId: 136774 });
    expect(res.status).toBe(201);
    expect(res.body.ownership).toBe('owned-elsewhere');
    expect(ownReg.read('136774')?.ownerMachineId).toBe(PEER);
  });

  it('a spawn with no topic never touches ownership', async () => {
    const res = await request(app(true))
      .post('/sessions/spawn')
      .set('Authorization', 'Bearer test')
      .send({ name: 'plain', prompt: 'go' });
    expect(res.status).toBe(201);
    expect(res.body.ownership).toBeUndefined();
    expect(emits).toHaveLength(0);
  });

  it('unwired (single-machine) still spawns and reports unwired', async () => {
    const res = await request(app(false))
      .post('/sessions/spawn')
      .set('Authorization', 'Bearer test')
      .send({ name: 'solo', prompt: 'go', topicId: 55 });
    expect(res.status).toBe(201);
    expect(res.body.ownership).toBe('unwired');
  });

  // Wiring integrity: the production path must hand the REAL claim closure to
  // the route context — not leave it null (the exact gap this test file closes).
  it('server.ts passes the claim closure to AgentServer, and AgentServer forwards it to routes', () => {
    const root = path.resolve(__dirname, '../..');
    const serverSrc = fs.readFileSync(path.join(root, 'src/commands/server.ts'), 'utf-8');
    const agentSrc = fs.readFileSync(path.join(root, 'src/server/AgentServer.ts'), 'utf-8');
    expect(serverSrc).toMatch(/claimTopicOwnershipOnSpawn: \(topicId: number\) => _claimOwnershipForAutonomousSpawn \? _claimOwnershipForAutonomousSpawn\(topicId\) : 'unwired'/);
    expect(serverSrc).toMatch(/_claimOwnershipForAutonomousSpawn = createClaimOwnershipOnSpawn\(\{/);
    expect(agentSrc).toMatch(/claimTopicOwnershipOnSpawn: options\.claimTopicOwnershipOnSpawn \?\? null/);
  });
});
