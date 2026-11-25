import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { expect, it } from 'vitest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { createMockSessionManager } from '../helpers/setup.js';

it('serves the opted-in draft check through the authenticated AgentServer', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-response-alive-'));
  const token = 'rule-response-e2e-fixture';
  const config = {
    projectName: 'fixture', projectDir: stateDir, stateDir, port: 0, authToken: token,
    toneGate: { askLinksEscalation: { enabled: true } },
  } as InstarConfig;
  const server = new AgentServer({
    config, state: new StateManager(stateDir),
    sessionManager: createMockSessionManager() as never,
  });
  const body = { rule: 'ask-links', topic: 7, draft: 'Please approve this.', hasAsk: true };
  try {
    await request(server.getApp()).post('/rule-responses/draft')
      .set('X-Instar-Request', '1').send(body).expect(401);
    const response = await request(server.getApp()).post('/rule-responses/draft')
      .set('Authorization', `Bearer ${token}`).set('X-Instar-Request', '1').send(body).expect(200);
    expect(response.body).toMatchObject({ total: 0, action: 'none', draftCheck: 'not-required' });
  } finally {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'rule response server fixture cleanup' });
  }
});
