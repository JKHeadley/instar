/**
 * E2E test — External Operation Gate action vocabulary lifecycle.
 *
 * Verifies the HTTP evaluator route exposes the same action vocabulary the
 * generated PreToolUse hook handles: proceed, show-plan,
 * suggest-alternative, and block. `allow` is a legacy compatibility input for
 * the hook only, not an endpoint output.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { ExternalOperationGate, AUTONOMY_PROFILES } from '../../src/core/ExternalOperationGate.js';
import { MessageSentinel } from '../../src/core/MessageSentinel.js';
import { AdaptiveTrust } from '../../src/core/AdaptiveTrust.js';
import {
  createTempProject,
  createMockSessionManager,
} from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('E2E: External Operation Gate action vocabulary lifecycle', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let server: AgentServer;
  let listener: Server;
  let baseUrl: string;
  const AUTH_TOKEN = 'test-auth-external-vocab';

  beforeAll(async () => {
    project = createTempProject();
    mockSM = createMockSessionManager();

    const config: InstarConfig = {
      projectName: 'external-vocab-e2e',
      projectDir: project.dir,
      stateDir: project.stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
      requestTimeoutMs: 5000,
      sessions: { maxSessions: 3 },
      scheduler: { enabled: false },
      users: [],
      messaging: [],
      monitoring: {},
    };

    server = new AgentServer({
      config,
      sessionManager: mockSM.manager,
      state: mockSM.state,
      operationGate: new ExternalOperationGate({
        stateDir: project.stateDir,
        autonomyDefaults: AUTONOMY_PROFILES.collaborative,
        blockedServices: ['banking'],
      }),
      sentinel: new MessageSentinel({}),
      adaptiveTrust: new AdaptiveTrust({ stateDir: project.stateDir }),
    });

    listener = await new Promise<Server>((resolve) => {
      const started = server.getApp().listen(0, '127.0.0.1', () => resolve(started));
    });
    const address = listener.address();
    if (!address || typeof address === 'string') {
      throw new Error('expected tcp test listener');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    project.cleanup();
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });

  it('emits proceed for allowed reads and irreversible writes', async () => {
    const read = await request(baseUrl)
      .post('/operations/evaluate')
      .set(auth())
      .send({
        service: 'gmail',
        mutability: 'read',
        reversibility: 'reversible',
        description: 'Fetch inbox',
      });

    expect(read.status).toBe(200);
    expect(read.body.action).toBe('proceed');

    const write = await request(baseUrl)
      .post('/operations/evaluate')
      .set(auth())
      .send({
        service: 'gmail',
        mutability: 'write',
        reversibility: 'irreversible',
        description: 'Send an email',
      });

    expect(write.status).toBe(200);
    expect(write.body.action).toBe('proceed');
  });

  it('emits show-plan for high-risk deletes and block for configured denials', async () => {
    const highRiskDelete = await request(baseUrl)
      .post('/operations/evaluate')
      .set(auth())
      .send({
        service: 'gmail',
        mutability: 'delete',
        reversibility: 'irreversible',
        description: 'Delete an email permanently',
      });

    expect(highRiskDelete.status).toBe(200);
    expect(highRiskDelete.body.action).toBe('show-plan');
    expect(highRiskDelete.body.action).not.toBe('allow');

    const blocked = await request(baseUrl)
      .post('/operations/evaluate')
      .set(auth())
      .send({
        service: 'banking',
        mutability: 'read',
        reversibility: 'reversible',
        description: 'Read account balance',
      });

    expect(blocked.status).toBe(200);
    expect(blocked.body.action).toBe('block');
  });
});
