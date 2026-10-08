/**
 * jev-correction-shadow — integration tier. Spec: docs/specs/jev-correction-shadow.md.
 *
 * The real message seam and the real HTTP pipeline: a REAL TelegramAdapter logs
 * an agent reply (sendToTopic → appendToLog) and an inbound user message
 * (logInboundMessage → appendToLog); its onMessageLogged is chained to the
 * installed shadow exactly as server.ts chains it; GET /jev-correction/summary
 * through the real createRoutes reports the check. The adapter's own logging is
 * unchanged by the shadow.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { HumanAsDetectorLog } from '../../src/monitoring/HumanAsDetectorLog.js';
import { JevCorrectionShadow, installJevCorrectionShadow, getJevCorrectionShadow } from '../../src/core/JevCorrectionShadow.js';

function app(stateDir: string) {
  const a = express();
  a.use(express.json());
  a.use(createRoutes({ config: { authToken: 'test', stateDir, port: 0, projectName: 'it' } } as never));
  return a;
}

afterEach(() => installJevCorrectionShadow(null));

describe('jev-correction-shadow — message seam + HTTP pipeline', () => {
  it('summary is 503 when the shadow is not constructed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-correction-it-'));
    const res = await request(app(path.join(root, '.instar'))).get('/jev-correction/summary');
    expect(res.status).toBe(503);
  });

  it('an agent reply then a user correction through a real TelegramAdapter produce one check; the summary reports it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-correction-it-'));
    const stateDir = path.join(root, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    const adapter = new TelegramAdapter({ token: 'test-token-123', chatId: '-100123456', pollIntervalMs: 100 }, stateDir);
    let mid = 500;
    vi.spyOn(adapter as unknown as { apiCall: (m: string, p: Record<string, unknown>) => Promise<unknown> }, 'apiCall')
      .mockImplementation(async () => ({ message_id: ++mid, ok: true }));

    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.state).toContain('I paused the build until Sunday.');
      expect(body.state).toContain('waiting makes no sense');
      const p = { correction: 0.85, preference: 0.1, neither: 0.05, cannot_tell: 0 };
      return { ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', answers: { kind: { choice: 'correction', probabilities: p }, kind_rev: { choice: 'correction', probabilities: p } } }) } as unknown as Response;
    });
    const shadow = new JevCorrectionShadow({
      getConfig: () => ({ enabled: true }),
      readKey: () => 'k',
      layer0: (t) => HumanAsDetectorLog.getInstance().classify(t),
      logPath: path.join(root, 'logs', 'jev-correction-shadow.jsonl'),
      fetchImpl: fetchImpl as never,
    });
    installJevCorrectionShadow(shadow);
    // Chained exactly as server.ts chains it.
    const seen: Array<{ fromUser: boolean }> = [];
    adapter.onMessageLogged = (entry) => { seen.push({ fromUser: entry.fromUser }); };
    const before = adapter.onMessageLogged;
    adapter.onMessageLogged = (entry) => { if (before) before(entry); getJevCorrectionShadow()!.observe(entry); };

    await adapter.sendToTopic(42, 'I paused the build until Sunday.', { provenance: 'agent' } as never);
    adapter.logInboundMessage({ messageId: 9001, topicId: 42, text: 'No, waiting makes no sense on something we know is broken. Fix it now.', timestamp: new Date().toISOString(), senderName: 'Op' });
    await getJevCorrectionShadow()!.lastCheck;

    expect(seen).toEqual([{ fromUser: false }, { fromUser: true }]); // the prior consumer still sees both
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const res = await request(app(stateDir)).get('/jev-correction/summary');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, checks: 1, jevFlags: 1, labels: { correction: 1 } });
    const row = JSON.parse(fs.readFileSync(path.join(root, 'logs', 'jev-correction-shadow.jsonl'), 'utf8').trim());
    expect(row).toMatchObject({ kind: 'check', topic: 42, messageId: 9001, hadContext: true, jevFlag: true });
    expect(JSON.stringify(row)).not.toContain('waiting');
  });
});
