/**
 * Integration tests — Session Boot Self-Knowledge routes (Tier 2).
 *
 * Spec: docs/specs/session-boot-self-knowledge.md.
 *
 * Exercises the REAL production path: the inline routes in createRoutes(),
 * mounted behind the real authMiddleware, backed by a REAL SecretStore vault
 * in a temp stateDir (file-key via the VITEST constructor guard — the OS
 * keychain is structurally unreachable from these tests).
 *
 * Covers:
 *   - 401 without a bearer token
 *   - 503 when dark (flag unset + developmentAgent false) and when explicitly disabled
 *   - 200 via the developmentAgent gate (flag unset + developmentAgent true)
 *   - 200 shape with a real vault; raw-body value-leak negative assertion
 *   - decrypt-failure → 200 with the warning block, NOT 500 (curl -sf would
 *     swallow a 5xx and hide the exact warning the honesty rule delivers)
 *   - ?full=1 bypasses the name cap
 *   - facts writer contract: 400 empty/oversize, 409 duplicate/cap/ambiguous/
 *     expect-mismatch, POST→GET→DELETE round-trip, atomic write (config stays
 *     valid JSON), fresh-read (no restart needed)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { SecretStore } from '../../src/core/SecretStore.js';
import { clearBootSelfKnowledgeCache, MAX_FACT_CHARS, MAX_FACTS_STORED } from '../../src/core/BootSelfKnowledge.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH_TOKEN = 'test-boot-sk-bearer';

function ctxFor(projectDir: string, opts: { developmentAgent?: boolean } = {}): RouteContext {
  const stateDir = path.join(projectDir, '.instar');
  return {
    config: {
      projectName: 'boot-sk-test',
      projectDir,
      stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
      developmentAgent: opts.developmentAgent ?? false,
      sessions: {} as any,
      scheduler: {} as any,
    } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, relationships: null, feedback: null,
    dispatches: null, updateChecker: null, autoUpdater: null, autoDispatcher: null,
    quotaTracker: null, publisher: null, viewer: null, tunnel: null, evolution: null,
    watchdog: null, triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null,
    discoveryEvaluator: null, startTime: new Date(),
  } as unknown as RouteContext;
}

function appWith(projectDir: string, opts: { developmentAgent?: boolean } = {}): express.Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(AUTH_TOKEN));
  app.use('/', createRoutes(ctxFor(projectDir, opts)));
  return app;
}

describe('Session Boot Self-Knowledge routes (integration, real createRoutes + authMiddleware)', () => {
  let projectDir: string;
  let stateDir: string;
  let configPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-sk-routes-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    configPath = path.join(stateDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({}, null, 2) + '\n');
    clearBootSelfKnowledgeCache();
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/integration/self-knowledge-session-context-routes.test.ts:afterEach' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });
  const seedVault = (secrets: Record<string, unknown>) => new SecretStore({ stateDir }).write(secrets);

  it('401 without a bearer token', async () => {
    const res = await request(appWith(projectDir)).get('/self-knowledge/session-context');
    expect(res.status).toBe(401);
  });

  it('503 when dark (flag unset, developmentAgent false)', async () => {
    const res = await request(appWith(projectDir, { developmentAgent: false }))
      .get('/self-knowledge/session-context').set(auth());
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('disabled');
  });

  it('503 when explicitly disabled even on a developmentAgent', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ selfKnowledge: { sessionContext: { enabled: false } } }, null, 2) + '\n');
    const res = await request(appWith(projectDir, { developmentAgent: true }))
      .get('/self-knowledge/session-context').set(auth());
    expect(res.status).toBe(503);
  });

  it('200 via the developmentAgent gate (flag unset) with real vault names and NO values in the raw body', async () => {
    seedVault({ github_token: 'ghp_INTEGRATIONSECRET', portal: { instarReadToken: 'tok_NEVERLEAK' } });
    const res = await request(appWith(projectDir, { developmentAgent: true }))
      .get('/self-knowledge/session-context').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.present).toBe(true);
    expect(res.body.vaultState).toBe('ok');
    expect(res.body.names).toContain('github_token');
    expect(res.body.names).toContain('portal.instarReadToken');
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('ghp_INTEGRATIONSECRET');
    expect(raw).not.toContain('tok_NEVERLEAK');
    expect(res.body.block).toContain('<session-self-knowledge');
  });

  it('explicit enabled:true works on a NON-development agent (the live-fleet flip shape)', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ selfKnowledge: { sessionContext: { enabled: true } } }, null, 2) + '\n');
    seedVault({ some_key: 'v' });
    const res = await request(appWith(projectDir, { developmentAgent: false }))
      .get('/self-knowledge/session-context').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.names).toContain('some_key');
  });

  it('decrypt-failure returns 200 with the warning block, NOT 500', async () => {
    seedVault({ github_token: 'ghp_x' });
    // Corrupt the master key so the existing vault no longer decrypts.
    fs.writeFileSync(path.join(stateDir, 'machine', 'secrets-master.key'), Buffer.alloc(32, 9).toString('hex'));
    clearBootSelfKnowledgeCache();
    const res = await request(appWith(projectDir, { developmentAgent: true }))
      .get('/self-knowledge/session-context').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.present).toBe(true);
    expect(res.body.vaultState).toBe('decrypt-failed');
    expect(res.body.block).toContain('Do NOT attempt to repair');
  });

  it('?full=1 bypasses the name cap', async () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 60; i++) big[`key_${String(i).padStart(2, '0')}`] = 'v';
    seedVault(big);
    const app = appWith(projectDir, { developmentAgent: true });
    const capped = await request(app).get('/self-knowledge/session-context').set(auth());
    expect(capped.body.block).toContain('hidden by size limit');
    const full = await request(app).get('/self-knowledge/session-context?full=1').set(auth());
    expect(full.body.block).toContain('key_59');
    expect(full.body.block).not.toContain('hidden by size limit');
  });

  describe('facts writer contract', () => {
    it('POST validates, stamps, and round-trips; DELETE removes; config stays valid JSON', async () => {
      const app = appWith(projectDir, { developmentAgent: true });

      const empty = await request(app).post('/self-knowledge/facts').set(auth()).send({ fact: '   ' });
      expect(empty.status).toBe(400);

      const oversize = await request(app).post('/self-knowledge/facts').set(auth())
        .send({ fact: 'x'.repeat(MAX_FACT_CHARS + 1) });
      expect(oversize.status).toBe(400);

      const ok = await request(app).post('/self-knowledge/facts').set(auth())
        .send({ fact: 'The Telegram seat is the default playwright profile' });
      expect(ok.status).toBe(200);
      const stored = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const entry = stored.selfKnowledge.operationalFacts[0];
      expect(entry.fact).toContain('Telegram seat');
      expect(entry.updatedAt).toBeTruthy();
      expect(entry.machine).toBeTruthy();

      const dup = await request(app).post('/self-knowledge/facts').set(auth())
        .send({ fact: 'The Telegram seat is the default playwright profile' });
      expect(dup.status).toBe(409);

      // Fresh-read: the fact appears in the session-context with NO restart.
      const ctxRes = await request(app).get('/self-knowledge/session-context').set(auth());
      expect(ctxRes.body.block).toContain('Telegram seat');

      const ambiguousSetup = await request(app).post('/self-knowledge/facts').set(auth())
        .send({ fact: 'Another seat fact entirely' });
      expect(ambiguousSetup.status).toBe(200);
      const ambiguous = await request(app).delete('/self-knowledge/facts').set(auth()).send({ match: 'seat' });
      expect(ambiguous.status).toBe(409);

      const wrongExpect = await request(app).delete('/self-knowledge/facts').set(auth())
        .send({ index: 0, expect: 'not the fact text' });
      expect(wrongExpect.status).toBe(409);

      const del = await request(app).delete('/self-knowledge/facts').set(auth())
        .send({ match: 'Another seat fact' });
      expect(del.status).toBe(200);
      const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(after.selfKnowledge.operationalFacts).toHaveLength(1);
    });

    it('409 at the fact cap', async () => {
      const facts = Array.from({ length: MAX_FACTS_STORED }, (_, i) => ({ fact: `fact ${i}` }));
      fs.writeFileSync(configPath, JSON.stringify({ selfKnowledge: { operationalFacts: facts } }, null, 2) + '\n');
      const res = await request(appWith(projectDir, { developmentAgent: true }))
        .post('/self-knowledge/facts').set(auth()).send({ fact: 'one too many' });
      expect(res.status).toBe(409);
      expect(res.body.error).toContain('cap');
    });

    it('writer requires auth', async () => {
      const res = await request(appWith(projectDir, { developmentAgent: true }))
        .post('/self-knowledge/facts').send({ fact: 'nope' });
      expect(res.status).toBe(401);
    });
  });
});
