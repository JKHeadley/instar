/**
 * Server-side tests for POST /sessions/restart-all.
 *
 * Stands up an express app with the real router and a minimal RouteContext
 * (sessionRefresh + state + telegram). Verifies validation, the 202 ack with
 * an honest scheduled/skipped breakdown (Telegram-bound running sessions
 * only), exclusion, and that refreshSession() is invoked for each target
 * asynchronously after the response flushes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';

interface Server { url: string; close: () => Promise<void>; }

async function listen(app: express.Express): Promise<Server> {
  return new Promise(resolve => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>(r => srv.close(() => r())),
      });
    });
  });
}

interface BuildOpts {
  sessionRefresh: { refreshSession: ReturnType<typeof vi.fn> } | null;
  runningSessions?: Array<{ tmuxSession: string }>;
  /** Map of tmuxSession -> topicId (in-memory). Absent = not telegram-bound. */
  topics?: Record<string, number>;
}

function buildApp(opts: BuildOpts): express.Express {
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  const running = opts.runningSessions ?? [];
  const topics = opts.topics ?? {};
  const ctx: any = {
    sessionRefresh: opts.sessionRefresh,
    state: {
      listSessions: vi.fn().mockReturnValue(running),
    },
    telegram: {
      getTopicForSession: (name: string) => (name in topics ? topics[name] : null),
      resolveTopicForSessionFromDisk: () => null,
    },
    config: { authToken: 'test', stateDir: '/tmp', port: 0 },
    stateDir: '/tmp',
  };
  const router = createRoutes(ctx);
  app.use(router);
  return app;
}

describe('POST /sessions/restart-all', () => {
  let server: Server;
  let sessionRefresh: { refreshSession: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    sessionRefresh = {
      refreshSession: vi.fn().mockResolvedValue({ ok: true, newSessionName: 'new', topicId: 1 }),
    };
  });

  afterEach(async () => {
    if (server) await server.close();
  });

  async function api(body: unknown) {
    const res = await fetch(server.url + '/sessions/restart-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json };
  }

  it('returns 503 when sessionRefresh is not wired', async () => {
    server = await listen(buildApp({ sessionRefresh: null }));
    const r = await api({});
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/not enabled/i);
  });

  it('returns 400 when excludeSession has invalid characters', async () => {
    server = await listen(buildApp({ sessionRefresh }));
    const r = await api({ excludeSession: 'bad name with spaces' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/excludeSession/);
  });

  it('returns 400 when followUpPrompt is too large', async () => {
    server = await listen(buildApp({ sessionRefresh }));
    const r = await api({ followUpPrompt: 'x'.repeat(500_001) });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/followUpPrompt/);
  });

  it('schedules only running Telegram-bound sessions and reports skipped non-bound ones', async () => {
    server = await listen(buildApp({
      sessionRefresh,
      runningSessions: [
        { tmuxSession: 'echo-topic-100' },
        { tmuxSession: 'echo-topic-200' },
        { tmuxSession: 'headless-job-xyz' }, // not telegram-bound
      ],
      topics: { 'echo-topic-100': 100, 'echo-topic-200': 200 },
    }));
    const r = await api({ reason: 'config apply' });
    expect(r.status).toBe(202);
    expect(r.body.ok).toBe(true);
    expect(r.body.scheduled.sort()).toEqual(['echo-topic-100', 'echo-topic-200']);
    expect(r.body.count).toBe(2);
    expect(r.body.skipped).toBe(1);
  });

  it('excludes the excludeSession from the scheduled set', async () => {
    server = await listen(buildApp({
      sessionRefresh,
      runningSessions: [
        { tmuxSession: 'echo-topic-100' },
        { tmuxSession: 'echo-topic-200' },
      ],
      topics: { 'echo-topic-100': 100, 'echo-topic-200': 200 },
    }));
    const r = await api({ excludeSession: 'echo-topic-100' });
    expect(r.status).toBe(202);
    expect(r.body.scheduled).toEqual(['echo-topic-200']);
    expect(r.body.count).toBe(1);
  });

  it('invokes refreshSession for each scheduled session after the staggered delay', async () => {
    server = await listen(buildApp({
      sessionRefresh,
      runningSessions: [
        { tmuxSession: 'echo-topic-100' },
        { tmuxSession: 'echo-topic-200' },
      ],
      topics: { 'echo-topic-100': 100, 'echo-topic-200': 200 },
    }));
    const r = await api({ reason: 'config apply' });
    expect(r.status).toBe(202);

    // First fires at 500ms, second at 500+750ms. Wait past both.
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(sessionRefresh.refreshSession).toHaveBeenCalledTimes(2);
    expect(sessionRefresh.refreshSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName: 'echo-topic-100', reason: 'config apply' }),
    );
    expect(sessionRefresh.refreshSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName: 'echo-topic-200', reason: 'config apply' }),
    );
  });

  it('defaults the reason when none is provided', async () => {
    server = await listen(buildApp({
      sessionRefresh,
      runningSessions: [{ tmuxSession: 'echo-topic-100' }],
      topics: { 'echo-topic-100': 100 },
    }));
    const r = await api({});
    expect(r.status).toBe(202);
    await new Promise(resolve => setTimeout(resolve, 700));
    expect(sessionRefresh.refreshSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName: 'echo-topic-100', reason: expect.stringMatching(/restart-all/) }),
    );
  });
});
