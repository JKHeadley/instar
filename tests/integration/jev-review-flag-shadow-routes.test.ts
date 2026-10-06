/**
 * jev-review-flag-shadow — integration tier. Spec: docs/specs/jev-review-flag-shadow.md.
 *
 * The full HTTP pipeline through the real createRoutes: the installed shadow
 * tails a real Telegram history file from disk, judges the agent reply, and
 * GET /jev-review-flag/summary reports it. 503 when not constructed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import { HookEventReceiver } from '../../src/monitoring/HookEventReceiver.js';
import { JevReviewFlagShadow, installJevReviewFlagShadow, getJevReviewFlagShadow } from '../../src/core/JevReviewFlagShadow.js';

function app(stateDir: string) {
  const a = express();
  a.use(express.json());
  a.use(createRoutes({
    config: { authToken: 'test', stateDir, port: 0, projectName: 'it' },
    hookEventReceiver: new HookEventReceiver({ stateDir }),
  } as never));
  return a;
}

afterEach(() => installJevReviewFlagShadow(null));

describe('jev-review-flag-shadow — HTTP pipeline', () => {
  it('summary is 503 when the shadow is not constructed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-rf-it-'));
    installJevReviewFlagShadow(null);
    const res = await request(app(path.join(root, '.instar'))).get('/jev-review-flag/summary');
    expect(res.status).toBe(503);
  });

  it('a tick over a real history file is reported by the summary route', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-rf-it-'));
    const stateDir = path.join(root, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    const historyPath = path.join(stateDir, 'telegram-messages.jsonl');
    const now = Date.now();
    fs.writeFileSync(historyPath, [
      { messageId: 501, topicId: 77, text: 'Is the release out?', fromUser: true, timestamp: new Date(now - 120_000).toISOString(), sessionName: 'echo-a', provenance: 'user' },
      { messageId: 502, topicId: 77, text: 'Daily digest posted.', fromUser: false, timestamp: new Date(now - 90_000).toISOString(), sessionName: null, provenance: 'automation' },
      { messageId: 503, topicId: 77, text: 'Yes, released and verified.', fromUser: false, timestamp: new Date(now - 60_000).toISOString(), sessionName: 'echo-a', provenance: 'agent' },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.state).toContain('Yes, released and verified.');
      expect(body.state).toContain('Is the release out?');
      expect(body.state).not.toContain('Daily digest');
      const p = { needs_review: 0.7, fine: 0.28, cannot_tell: 0.02 };
      return { ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', answers: { review: { choice: 'needs_review', probabilities: p }, review_rev: { choice: 'needs_review', probabilities: p } } }) } as unknown as Response;
    });
    installJevReviewFlagShadow(new JevReviewFlagShadow({
      getConfig: () => ({ enabled: true }),
      readKey: () => 'k',
      logPath: path.join(root, 'logs', 'jev-review-flag-shadow.jsonl'),
      historyPath,
      fetchImpl: fetchImpl as never,
    }));
    await getJevReviewFlagShadow()!.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const res = await request(app(stateDir)).get('/jev-review-flag/summary');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, checks: 1, wouldFlags: 1, labels: { needs_review: 1 } });
    expect(res.body.perTopic['77']).toMatchObject({ checks: 1, wouldFlags: 1 });
  });
});
