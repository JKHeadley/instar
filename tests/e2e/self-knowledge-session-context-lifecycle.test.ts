/**
 * E2E test — Session Boot Self-Knowledge full lifecycle (Tier 3).
 *
 * Spec: docs/specs/session-boot-self-knowledge.md.
 *
 * Tests the complete PRODUCTION path, mirroring the preferences E2E precedent:
 *   Phase 1 — Feature is alive: the route is wired into AgentServer the same
 *             way production wires it. 200 + the names block on a dev-agent
 *             config with a REAL seeded vault; 503 on a fleet-default config
 *             (flag unset, developmentAgent false). The single most important
 *             assertion for any feature with API routes.
 *   Phase 2 — The generated session-start hook's boot-self-knowledge fetch
 *             (the SAME bash + python PostUpdateMigrator.getSessionStartHook()
 *             installs) runs against a LIVE server and emits the
 *             <session-self-knowledge> block when enabled — and emits NOTHING
 *             on the dark/503 path (fail-open, silent).
 *
 * All SecretStores ride the VITEST constructor guard (file-key only) — the OS
 * keychain is structurally unreachable from this test.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import request from 'supertest';
import express from 'express';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SecretStore } from '../../src/core/SecretStore.js';
import { clearBootSelfKnowledgeCache } from '../../src/core/BootSelfKnowledge.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { createRoutes } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import type { RouteContext } from '../../src/server/routes.js';
import { createMockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

const execFileAsync = promisify(execFile);

const AUTH_TOKEN = 'test-boot-sk-e2e';
const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });

describe('Session Boot Self-Knowledge E2E lifecycle', () => {
  // ── Phase 1: Feature is alive on the production AgentServer boot path ──
  describe('Phase 1: Feature is alive (production AgentServer boot path, developmentAgent)', () => {
    let tmpDir: string;
    let stateDir: string;
    let server: AgentServer;
    let app: ReturnType<AgentServer['getApp']>;

    beforeAll(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-sk-e2e-on-'));
      stateDir = path.join(tmpDir, '.instar');
      fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
      fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'boot-sk-e2e' }));
      clearBootSelfKnowledgeCache();

      // A REAL vault on the production read path (file-key via the VITEST guard).
      new SecretStore({ stateDir }).write({ github_token: 'ghp_E2ESECRET', portal: { instarReadToken: 'tok_E2E' } });

      const config: InstarConfig = {
        projectName: 'boot-sk-e2e-on',
        agentName: 'E2E Agent',
        projectDir: tmpDir,
        stateDir,
        port: 0,
        authToken: AUTH_TOKEN,
        developmentAgent: true, // the graduated gate resolves enabled ?? !!developmentAgent
      } as InstarConfig;

      server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(stateDir) });
      app = server.getApp();
    });

    afterAll(async () => {
      try { await (server as unknown as { stop?: () => Promise<void> }).stop?.(); } catch { /* ignore */ }
      SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'self-knowledge-session-context-lifecycle:phase1' });
    });

    it('returns 200 with the names block — feature is ALIVE on the production wiring', async () => {
      const res = await request(app).get('/self-knowledge/session-context').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.present).toBe(true);
      expect(res.body.vaultState).toBe('ok');
      expect(res.body.names).toContain('github_token');
      expect(res.body.names).toContain('portal.instarReadToken');
      expect(res.body.block).toContain("<session-self-knowledge src='boot'");
      expect(JSON.stringify(res.body)).not.toContain('ghp_E2ESECRET');
    });

    it('facts writer is alive on the same boot path (POST → visible in context)', async () => {
      const post = await request(app).post('/self-knowledge/facts').set(auth())
        .send({ fact: 'E2E operational fact: the seat lives here' });
      expect(post.status).toBe(200);
      const res = await request(app).get('/self-knowledge/session-context').set(auth());
      expect(res.body.block).toContain('E2E operational fact');
    });
  });

  describe('Phase 1b: 503 on the same boot path with the fleet-default config (dark)', () => {
    let tmpDir: string;
    let stateDir: string;
    let server: AgentServer;
    let app: ReturnType<AgentServer['getApp']>;

    beforeAll(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-sk-e2e-off-'));
      stateDir = path.join(tmpDir, '.instar');
      fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
      fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'boot-sk-e2e-off' }));
      clearBootSelfKnowledgeCache();

      const config: InstarConfig = {
        projectName: 'boot-sk-e2e-off',
        agentName: 'E2E Agent',
        projectDir: tmpDir,
        stateDir,
        port: 0,
        authToken: AUTH_TOKEN,
        // fleet default: no selfKnowledge config, developmentAgent unset → dark
      } as InstarConfig;

      server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(stateDir) });
      app = server.getApp();
    });

    afterAll(async () => {
      try { await (server as unknown as { stop?: () => Promise<void> }).stop?.(); } catch { /* ignore */ }
      SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'self-knowledge-session-context-lifecycle:phase1b' });
    });

    it('returns 503 — dark on the fleet by default', async () => {
      const res = await request(app).get('/self-knowledge/session-context').set(auth());
      expect(res.status).toBe(503);
    });
  });

  // ── Phase 2: the generated hook's boot-self-knowledge fetch logic ──
  describe('Phase 2: session-start hook injects the <session-self-knowledge> block', () => {
    let tmpDir: string;
    let stateDir: string;
    let server: http.Server;
    let port: number;

    function makeCtx(developmentAgent: boolean): RouteContext {
      return {
        config: {
          projectName: 'boot-sk-hook-e2e', projectDir: tmpDir, stateDir, port,
          authToken: AUTH_TOKEN,
          developmentAgent,
          sessions: {} as any, scheduler: {} as any,
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

    async function startServer(developmentAgent: boolean): Promise<void> {
      const appx = express();
      appx.use(express.json());
      appx.use(authMiddleware(AUTH_TOKEN));
      appx.use('/', createRoutes(makeCtx(developmentAgent)));
      await new Promise<void>((resolve) => {
        server = appx.listen(0, () => {
          port = (server.address() as { port: number }).port;
          resolve();
        });
      });
    }

    async function stopServer(): Promise<void> {
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    /** Extract the boot-self-knowledge block from the generated hook source. */
    function extractBootSkBlock(): string {
      const migrator = new PostUpdateMigrator({ projectDir: tmpDir, stateDir, port, authToken: AUTH_TOKEN, agentName: 'boot-sk-hook-e2e' });
      const src = migrator.getHookContent('session-start');
      const start = src.indexOf('# SESSION BOOT SELF-KNOWLEDGE injection');
      expect(start).toBeGreaterThanOrEqual(0);
      const after = src.indexOf('# BEGIN integrated-being-v2', start);
      expect(after).toBeGreaterThan(start);
      return src.slice(start, after);
    }

    async function runBootSkBlock(): Promise<string> {
      const block = extractBootSkBlock();
      const script = `#!/bin/bash\nPORT=${port}\nTOKEN="${AUTH_TOKEN}"\n${block}`;
      const scriptPath = path.join(tmpDir, 'boot-sk-block.sh');
      fs.writeFileSync(scriptPath, script, { mode: 0o755 });
      const { stdout } = await execFileAsync('bash', [scriptPath], { encoding: 'utf-8' });
      return stdout;
    }

    beforeAll(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-sk-hook-e2e-'));
      stateDir = path.join(tmpDir, '.instar');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({}, null, 2) + '\n');
      clearBootSelfKnowledgeCache();
    });

    afterAll(async () => {
      await stopServer();
      SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'self-knowledge-session-context-lifecycle:phase2' });
    });

    it('the full hook source wires the /self-knowledge/session-context fetch (curl -sf, header auth, connect-timeout)', () => {
      const migrator = new PostUpdateMigrator({ projectDir: tmpDir, stateDir, port: 0, authToken: AUTH_TOKEN, agentName: 'x' });
      const src = migrator.getHookContent('session-start');
      expect(src).toContain('/self-knowledge/session-context');
      const block = src.slice(src.indexOf('# SESSION BOOT SELF-KNOWLEDGE injection'));
      expect(block).toContain('curl -sf --max-time 4 --connect-timeout 1');
      expect(block).toContain('Authorization: Bearer');
      expect(block).not.toContain('?token='); // the token travels ONLY in the header
    });

    it('emits the <session-self-knowledge> block against a live enabled server', async () => {
      new SecretStore({ stateDir }).write({ github_token: 'ghp_HOOKSECRET' });
      clearBootSelfKnowledgeCache();
      await startServer(true);
      const out = await runBootSkBlock();
      expect(out).toContain("<session-self-knowledge src='boot'");
      expect(out).toContain('github_token');
      expect(out).not.toContain('ghp_HOOKSECRET');
      await stopServer();
    });

    it('emits NOTHING on the dark/503 path (fail-open, silent)', async () => {
      await startServer(false);
      const out = await runBootSkBlock();
      expect(out.trim()).toBe('');
      await stopServer();
    });
  });

  // ── Phase 3: compaction re-injection (long-session survival) ──
  // A days-long session compacts; the boot block must RE-inject on the compact
  // path or it survives only by the grace of the compaction summary.
  describe('Phase 3: compaction-recovery hook re-injects the block', () => {
    let tmpDir: string;
    let stateDir: string;
    let server: http.Server;
    let port: number;

    function makeCtx(developmentAgent: boolean): RouteContext {
      return {
        config: {
          projectName: 'boot-sk-compact-e2e', projectDir: tmpDir, stateDir, port,
          authToken: AUTH_TOKEN,
          developmentAgent,
          sessions: {} as any, scheduler: {} as any,
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

    beforeAll(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-sk-compact-e2e-'));
      stateDir = path.join(tmpDir, '.instar');
      fs.mkdirSync(stateDir, { recursive: true });
      clearBootSelfKnowledgeCache();
    });

    afterAll(async () => {
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'self-knowledge-session-context-lifecycle:phase3' });
    });

    function extractCompactBlock(): string {
      const migrator = new PostUpdateMigrator({ projectDir: tmpDir, stateDir, port, authToken: AUTH_TOKEN, agentName: 'boot-sk-compact-e2e' });
      const src = migrator.getHookContent('compaction-recovery');
      const start = src.indexOf('# SESSION BOOT SELF-KNOWLEDGE re-injection');
      expect(start).toBeGreaterThanOrEqual(0);
      const after = src.indexOf('echo "=== END IDENTITY RECOVERY', start);
      expect(after).toBeGreaterThan(start);
      return src.slice(start, after);
    }

    it('the compact hook source wires the re-injection fetch', () => {
      const block = extractCompactBlock();
      expect(block).toContain('/self-knowledge/session-context');
      expect(block).toContain('curl -sf --max-time 4 --connect-timeout 1');
      expect(block).not.toContain('?token=');
    });

    it('re-emits the <session-self-knowledge> block against a live server (the day-2 survival path)', async () => {
      // config.json on disk is what the compact hook reads for port + token fallback.
      const appx = express();
      appx.use(express.json());
      appx.use(authMiddleware(AUTH_TOKEN));
      await new Promise<void>((resolve) => {
        server = appx.listen(0, () => {
          port = (server.address() as { port: number }).port;
          resolve();
        });
      });
      appx.use('/', createRoutes(makeCtx(true)));
      fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port, authToken: AUTH_TOKEN }, null, 2) + '\n');
      new SecretStore({ stateDir }).write({ day2_secret: 'stored-mid-session' });
      clearBootSelfKnowledgeCache();

      const block = extractCompactBlock();
      const script = `#!/bin/bash\nINSTAR_DIR="${stateDir}"\nPORT=${port}\nexport INSTAR_AUTH_TOKEN="${AUTH_TOKEN}"\n${block}`;
      const scriptPath = path.join(tmpDir, 'compact-block.sh');
      fs.writeFileSync(scriptPath, script, { mode: 0o755 });
      const { stdout } = await execFileAsync('bash', [scriptPath], { encoding: 'utf-8' });
      expect(stdout).toContain("<session-self-knowledge src='boot'");
      expect(stdout).toContain('day2_secret');
      expect(stdout).not.toContain('stored-mid-session');
    });
  });
});
