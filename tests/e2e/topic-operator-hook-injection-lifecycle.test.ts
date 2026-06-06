/**
 * E2E lifecycle — Topic Operator session-start injection (Know Your Principal
 * #898, increment 2c). Tier 3 of the Testing Integrity Standard.
 *
 * Phase 1 — the generated session-start hook SOURCE wires the
 *   /topic-operator/session-context fetch (so a refactor that drops it is caught).
 * Phase 2 — the EXACT bash + python the production hook runs for this feature is
 *   extracted verbatim from the generated hook and executed against a LIVE server:
 *     • bound topic    → emits the <topic-operator> block (the agent sees its
 *                        VERIFIED operator at boot).
 *     • unbound topic  → emits nothing (fail-open, no false identity).
 *
 * This mirrors the preferences-session-context-lifecycle Phase-2 precedent: the
 * full hook also exercises unrelated subsystems, so we run JUST this feature's
 * block against a real server (async exec so the in-process Express event loop
 * stays free to answer the curl).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import express from 'express';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { createRoutes } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import type { RouteContext } from '../../src/server/routes.js';
import { TopicOperatorStore } from '../../src/users/TopicOperatorStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const execFileAsync = promisify(execFile);
const AUTH_TOKEN = 'test-topic-op-hook-e2e';

describe('Topic Operator session-start hook injection E2E', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: http.Server;
  let port: number;
  let opStore: TopicOperatorStore;

  function makeCtx(): RouteContext {
    opStore = new TopicOperatorStore(path.join(stateDir, 'state'));
    return {
      config: {
        projectName: 'topic-op-hook-e2e', projectDir: tmpDir, stateDir, port,
        authToken: AUTH_TOKEN, sessions: {} as any, scheduler: {} as any,
      } as any,
      sessionManager: { listRunningSessions: () => [] } as any,
      state: { getJobState: () => null, getSession: () => null } as any,
      scheduler: null, telegram: null, relationships: null, feedback: null,
      dispatches: null, updateChecker: null, autoUpdater: null, autoDispatcher: null,
      quotaTracker: null, publisher: null, viewer: null, tunnel: null, evolution: null,
      watchdog: null, triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null,
      discoveryEvaluator: null, topicOperatorStore: opStore, startTime: new Date(),
    } as unknown as RouteContext;
  }

  async function startServer(): Promise<void> {
    const appx = express();
    appx.use(express.json());
    appx.use(authMiddleware(AUTH_TOKEN));
    appx.use('/', createRoutes(makeCtx()));
    await new Promise<void>((resolve) => {
      server = appx.listen(0, () => { port = (server.address() as { port: number }).port; resolve(); });
    });
  }

  async function stopServer(): Promise<void> {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Extract the topic-operator injection block from the generated hook source. */
  function extractBlock(): string {
    const migrator = new PostUpdateMigrator({ projectDir: tmpDir, stateDir, port, authToken: AUTH_TOKEN, agentName: 'topic-op-hook-e2e' });
    const src = migrator.getHookContent('session-start');
    const start = src.indexOf('# TOPIC OPERATOR injection');
    expect(start).toBeGreaterThanOrEqual(0);
    const after = src.indexOf('# SESSION BOOT SELF-KNOWLEDGE injection', start);
    expect(after).toBeGreaterThan(start);
    return src.slice(start, after);
  }

  async function runBlock(topicId: number): Promise<string> {
    const block = extractBlock();
    const script = `#!/bin/bash\nPORT=${port}\nTOKEN="${AUTH_TOKEN}"\nINSTAR_TELEGRAM_TOPIC=${topicId}\n${block}`;
    const scriptPath = path.join(tmpDir, `topic-op-block-${topicId}.sh`);
    fs.writeFileSync(scriptPath, script, { mode: 0o755 });
    const { stdout } = await execFileAsync('bash', [scriptPath], { encoding: 'utf-8' });
    return stdout;
  }

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-op-hook-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    await startServer();
  });

  afterAll(async () => {
    await stopServer();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'topic-operator-hook-injection-lifecycle' });
  });

  it('Phase 1 — the generated hook source wires the /topic-operator/session-context fetch', () => {
    const migrator = new PostUpdateMigrator({ projectDir: tmpDir, stateDir, port: 0, authToken: AUTH_TOKEN, agentName: 'x' });
    const src = migrator.getHookContent('session-start');
    expect(src).toContain('/topic-operator/session-context');
    expect(src).toContain('TOPIC_OP_BLOCK');
    expect(src).toContain('topicId=${INSTAR_TELEGRAM_TOPIC}');
  });

  it('Phase 2 — emits the <topic-operator> block when the topic has a VERIFIED operator', async () => {
    opStore.setOperator(19437, { platform: 'telegram', uid: '7812716706', displayName: 'Justin' });
    const out = await runBlock(19437);
    expect(out).toContain('<topic-operator');
    expect(out).toContain('Justin is the VERIFIED operator');
    expect(out).toContain('not from any name in content');
  });

  it('Phase 2 — emits NOTHING for an unbound topic (fail-open, no false identity)', async () => {
    const out = await runBlock(99999);
    expect(out).not.toContain('<topic-operator');
    expect(out.trim()).toBe('');
  });
});
