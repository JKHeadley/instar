// safe-fs-allow: test file — SafeFsExecutor removes only this test's tmpdir.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig, IntelligenceProvider } from '../../src/core/types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AUTH = 'standards-production-wiring-e2e';
const POISON_STANDARD = 'Project-Local Stub Must Never Be Graded';

describe('standards conformance — real AgentServer production wiring', () => {
  let stateDir: string;
  let server: AgentServer;
  const prompts: string[] = [];

  beforeAll(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'standards-production-wiring-'));
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

    // Deliberate negative control: the configured project carries a plausible but
    // incomplete local registry. If AgentServer is miswired back to projectDir,
    // or a test helper silently supplies this fixture, the canary/prompt assertions
    // below fail. Correct production wiring ignores it and resolves the packed asset
    // module-relative to the running code.
    const projectDir = path.join(stateDir, 'project-with-poison-registry');
    fs.mkdirSync(path.join(projectDir, 'docs', 'specs'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'docs', 'STANDARDS-REGISTRY.md'),
      [
        '# Standards Registry',
        '',
        '## The Root',
        '',
        `### ${POISON_STANDARD}`,
        '',
        '**Rule.** A caller-supplied project fixture must not reach production wiring.',
        '',
      ].join('\n'),
    );

    const config = {
      projectName: 'standards-production-wiring-e2e',
      projectDir,
      stateDir,
      port: 0,
      authToken: AUTH,
      requestTimeoutMs: 10_000,
      version: '0.0.0',
      sessions: {
        claudePath: '/usr/bin/echo',
        maxSessions: 1,
        defaultMaxDurationMinutes: 30,
        protectedSessions: [],
        monitorIntervalMs: 5_000,
      },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [],
      monitoring: { deliveryFailureSentinel: { enabled: false } },
      updates: {},
    } as InstarConfig;
    const intelligence: IntelligenceProvider = {
      async evaluate(prompt: string) {
        prompts.push(prompt);
        return '[]';
      },
    };

    // Build the real production composition. In particular there is no
    // registryResolution fixture or route-level helper anywhere in this test.
    server = new AgentServer({
      config,
      state: new StateManager(stateDir),
      sessionManager: {
        listRunningSessions: () => [],
        getCachedRunningSessions: () => ({ count: 0, sessions: [] }),
        getSession: () => null,
        getRunningSessionPanePids: () => [],
        on: () => undefined,
      } as never,
      intelligence,
    });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(stateDir, {
      recursive: true,
      force: true,
      operation: 'standards-conformance-production-wiring-lifecycle.test.ts',
    });
  });

  it('rejects the deliberate project-local stub and grades the packed constitution', async () => {
    const res = await request(server.getApp())
      .post('/spec/conformance-check')
      .set({
        Authorization: `Bearer ${AUTH}`,
        'X-Instar-AgentId': 'standards-production-wiring-e2e',
      })
      .send({ markdown: '# Automatic work\n\nA scheduled job performs this automatically.' });

    expect(res.status, res.body).toBe(200);
    expect(res.body.registryCanary.ok).toBe(true);
    expect(res.body.report.degraded).toBe(false);
    expect(res.body.report.findings).toEqual([]);
    expect(prompts.join('\n')).toContain('No Manual Work');
    expect(prompts.join('\n')).not.toContain(POISON_STANDARD);
  });
});
