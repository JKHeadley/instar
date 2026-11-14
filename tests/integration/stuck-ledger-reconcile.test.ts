import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { MessageProcessingLedger } from '../../src/messaging/MessageProcessingLedger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

it('reconciles only a reviewed exact owner reply, without replay', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stuck-ledger-reconcile-'));
  const ledger = MessageProcessingLedger.openMemory();
  const key = 'telegram:136471:136473';
  ledger.record(key, { platform: 'telegram', topic: '136471', input: 'question' });
  ledger.beginProcessing(key, 1);
  const config = { projectName: 'echo', projectDir: stateDir, stateDir, port: 0, authToken: 'test-token', sessions: {}, scheduler: {} };
  const telegram = { getTopicHistory: () => [
    { messageId: 136473, topicId: 136471, timestamp: '2026-11-03T05:19:55Z', fromUser: true, text: 'question' },
    { messageId: 136475, topicId: 136471, timestamp: '2026-11-03T05:20:18Z', fromUser: false, authorship: 'agent-outbound', text: 'answer' },
  ] };
  const ctx = { config, startTime: new Date(), scheduler: null,
    sessionManager: { listRunningSessions: () => [] },
    state: { getJobState: () => null, getSession: () => null, queryEvents: () => [] },
    telegram, messageLedger: ledger, resolvePeerUrls: () => [] } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use(createRoutes(ctx));
  const server = await new Promise<import('node:http').Server>(resolve => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
  config.port = (server.address() as { port: number }).port;
  try {
    const base = `http://127.0.0.1:${config.port}`;
    const bad = await request(base).post('/telegram/reconcile-stuck-ledger')
      .send({ dedupeKey: key, replyMessageId: 999, reviewedBy: 'echo' });
    expect(bad.status).toBe(409);
    expect(ledger.get(key)?.state).toBe('processing');
    const good = await request(base).post('/telegram/reconcile-stuck-ledger')
      .send({ dedupeKey: key, replyMessageId: 136475, reviewedBy: 'echo' });
    expect(good.status).toBe(200);
    expect(ledger.get(key)?.state).toBe('cursor_advanced');
    expect(fs.readFileSync(path.join(stateDir, 'logs', 'stuck-ledger-reconciliation.jsonl'), 'utf8')).toContain(key);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    ledger.close();
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/integration/stuck-ledger-reconcile.test.ts' });
  }
});
