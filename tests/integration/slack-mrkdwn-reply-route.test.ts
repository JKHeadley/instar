/**
 * Integration: POST /slack/reply/:channelId applies the GFM→mrkdwn formatter
 * at the outbound funnel (roadmap 0.1).
 *
 * Mounts the real Express router with a real SlackAdapter (Socket Mode never
 * started; the API transport is stubbed BELOW the formatting funnel so no
 * network call happens). Verifies the full HTTP pipeline:
 *   - a GFM reply is converted to mrkdwn by the time it reaches the Slack API
 *   - metadata.formatMode 'legacy-passthrough' opts a single call out
 *   - the config rollback ('legacy-passthrough') restores byte-for-byte sends
 *   - /internal/slack-forward rides the same funnel
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { SlackAdapter } from '../../src/messaging/slack/SlackAdapter.js';
import type { SlackConfig } from '../../src/messaging/slack/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmp: string | null = null;

const CH = 'C_MAIN';

function makeSlack(stateDir: string, configOverrides: Partial<SlackConfig> = {}) {
  const posted: Array<{ method: string; params: Record<string, unknown> }> = [];

  const adapter = new SlackAdapter(
    {
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      authorizedUserIds: ['U_TEST'],
      workspaceMode: 'dedicated',
      ...configOverrides,
    } as SlackConfig,
    stateDir,
  );

  // Stub the transport UNDER the formatter funnel — capture what would hit
  // the Slack Web API; the formatting chokepoint itself is production code.
  (adapter as unknown as { apiClient: unknown }).apiClient = {
    call: async (method: string, params: Record<string, unknown>) => {
      posted.push({ method, params });
      return { ok: true, ts: '1700000001.000001' };
    },
  };

  return { adapter, posted };
}

function appWith(slack: SlackAdapter, stateDir: string): express.Express {
  const ctx = {
    config: { projectName: 'test', projectDir: '/tmp', stateDir, port: 0, users: [], sessions: {} as unknown, scheduler: {} as unknown },
    sessionManager: { listRunningSessions: () => [] },
    state: { getJobState: () => null, getSession: () => null },
    scheduler: null, telegram: null, slack, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null,
    tokenLedger: null, featureMetricsLedger: null, resourceLedger: null,
    messagingToneGate: null, // tone gate not configured → checkOutboundMessage passes through
    startTime: new Date(),
  } as unknown as RouteContext;

  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return app;
}

afterEach(() => {
  if (tmp) {
    SafeFsExecutor.safeRmSync(tmp, {
      recursive: true,
      force: true,
      operation: 'tests/integration/slack-mrkdwn-reply-route.test.ts',
    });
    tmp = null;
  }
});

describe('POST /slack/reply/:channelId — GFM→mrkdwn funnel (integration)', () => {
  it('converts a GFM reply to mrkdwn at the Slack API boundary', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-mrkdwn-reply-'));
    const { adapter, posted } = makeSlack(tmp);
    const app = appWith(adapter, tmp);

    const res = await request(app)
      .post(`/slack/reply/${CH}`)
      .send({ text: '**Done** — see [the PR](https://github.com/x/y/pull/1).\n\n- tests green' });

    expect(res.status).toBe(200);
    expect(posted.length).toBe(1);
    expect(posted[0].method).toBe('chat.postMessage');
    expect(posted[0].params.text).toBe(
      '*Done* — see <https://github.com/x/y/pull/1|the PR>.\n\n• tests green',
    );
  });

  it('metadata.formatMode legacy-passthrough opts a single reply out (already-mrkdwn caller)', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-mrkdwn-reply-'));
    const { adapter, posted } = makeSlack(tmp);
    const app = appWith(adapter, tmp);

    const mrkdwn = '*already mrkdwn* with <https://x.co|a link>';
    const res = await request(app)
      .post(`/slack/reply/${CH}`)
      .send({ text: mrkdwn, metadata: { formatMode: 'legacy-passthrough' } });

    expect(res.status).toBe(200);
    expect(posted[0].params.text).toBe(mrkdwn);
    expect('_formatMode' in posted[0].params).toBe(false);
  });

  it('an invalid metadata.formatMode is ignored (default conversion applies)', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-mrkdwn-reply-'));
    const { adapter, posted } = makeSlack(tmp);
    const app = appWith(adapter, tmp);

    const res = await request(app)
      .post(`/slack/reply/${CH}`)
      .send({ text: '**b**', metadata: { formatMode: 'nonsense' } });

    expect(res.status).toBe(200);
    expect(posted[0].params.text).toBe('*b*');
  });

  it("config rollback formatMode:'legacy-passthrough' restores byte-for-byte replies", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-mrkdwn-reply-'));
    const { adapter, posted } = makeSlack(tmp, { formatMode: 'legacy-passthrough' });
    const app = appWith(adapter, tmp);

    const raw = '**untouched** & <raw>';
    const res = await request(app).post(`/slack/reply/${CH}`).send({ text: raw });

    expect(res.status).toBe(200);
    expect(posted[0].params.text).toBe(raw);
  });

  it('threaded replies format AND keep their thread_ts', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-mrkdwn-reply-'));
    const { adapter, posted } = makeSlack(tmp);
    const app = appWith(adapter, tmp);

    const res = await request(app)
      .post(`/slack/reply/${CH}`)
      .send({ text: '**in thread**', thread_ts: '1700000000.000100' });

    expect(res.status).toBe(200);
    expect(posted[0].params.thread_ts).toBe('1700000000.000100');
    expect(posted[0].params.text).toBe('*in thread*');
  });

  it('/internal/slack-forward rides the same funnel', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-mrkdwn-reply-'));
    const { adapter, posted } = makeSlack(tmp);
    const app = appWith(adapter, tmp);

    const res = await request(app)
      .post('/internal/slack-forward')
      .send({ channelId: CH, text: '# Replayed\n**bold**' });

    expect(res.status).toBe(200);
    expect(posted[0].params.text).toBe('*Replayed*\n*bold*');
  });
});
