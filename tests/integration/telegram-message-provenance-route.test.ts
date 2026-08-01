/**
 * Message-store provenance through the real Telegram reply route.
 *
 * Proves the route classifies at the send seam instead of from message text,
 * and that an authenticated relay can preserve an automation classification.
 */

import { afterAll, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createRoutes } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { MessageProvenance } from '../../src/messaging/shared/MessageProvenance.js';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-message-provenance-'));

interface CapturedSend {
  topicId: number;
  text: string;
  provenance?: MessageProvenance;
}

function appWith(sent: CapturedSend[]): express.Express {
  const app = express();
  app.use(express.json());
  app.use(createRoutes({
    config: { authToken: 'test', stateDir, port: 0, projectName: 'provenance-test' },
    telegram: {
      sendToTopic: async (topicId: number, text: string, options?: { provenance?: MessageProvenance }) => {
        sent.push({ topicId, text, provenance: options?.provenance });
        return { messageId: sent.length, timestamp: new Date().toISOString() };
      },
    },
    sessionManager: { clearInjectionTracker: () => {} },
  } as never));
  return app;
}

afterAll(() => {
  SafeFsExecutor.safeRmSync(stateDir, {
    recursive: true,
    force: true,
    operation: 'tests/integration/telegram-message-provenance-route.test.ts',
  });
});

describe('POST /telegram/reply — structural message provenance', () => {
  it('classifies ordinary conversational output as agent-authored', async () => {
    const sent: CapturedSend[] = [];
    const res = await request(appWith(sent))
      .post('/telegram/reply/71')
      .send({ text: 'The work is complete.' });

    expect(res.status).toBe(200);
    expect(sent).toEqual([{ topicId: 71, text: 'The work is complete.', provenance: 'agent' }]);
  });

  it('classifies scheduled output as automation without inspecting its text', async () => {
    const sent: CapturedSend[] = [];
    const res = await request(appWith(sent))
      .post('/telegram/reply/72')
      .send({ text: 'This could look conversational.', metadata: { messageKind: 'automated' } });

    expect(res.status).toBe(200);
    expect(sent[0]?.provenance).toBe('automation');
  });

  it('preserves automation provenance carried by a cross-machine relay', async () => {
    const sent: CapturedSend[] = [];
    const res = await request(appWith(sent))
      .post('/telegram/reply/73')
      .send({ text: 'No kind metadata required.', metadata: { provenance: 'automation' } });

    expect(res.status).toBe(200);
    expect(sent[0]?.provenance).toBe('automation');
  });

  it('does not accept user provenance on an outbound row', async () => {
    const sent: CapturedSend[] = [];
    const res = await request(appWith(sent))
      .post('/telegram/reply/74')
      .send({ text: 'Outbound remains outbound.', metadata: { provenance: 'user' } });

    expect(res.status).toBe(200);
    expect(sent[0]?.provenance).toBe('agent');
  });
});
