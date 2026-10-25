import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import type { Session } from '../../src/core/types.js';

const session: Session = {
  id: '14360e43-d507-4a10-97db-f424e81443e0',
  name: 'route-worker',
  tmuxSession: 'echo-route-worker',
  status: 'running',
  startedAt: '2026-08-23T07:15:44.000Z',
};

function appWithRealHandler() {
  const captureOutput = vi.fn((tmux: string) =>
    tmux === session.tmuxSession ? 'live route output' : null,
  );
  const app = express();
  app.use(express.json());
  app.use(createRoutes({
    config: { projectName: 'route-test', projectDir: '/tmp', stateDir: '/tmp', port: 0 } as never,
    state: { listSessions: () => [session] } as never,
    sessionManager: { captureOutput } as never,
  } as RouteContext));
  return { app, captureOutput };
}

describe('GET /sessions/:name/output identifier resolution', () => {
  it.each([
    ['UUID', session.id],
    ['logical name', session.name],
    ['tmux session', session.tmuxSession],
  ])('returns 200 through the real route handler for %s', async (_form, identifier) => {
    const { app, captureOutput } = appWithRealHandler();
    const response = await request(app).get(`/sessions/${identifier}/output?lines=3`);

    expect(response.status).toBe(200);
    expect(response.body.output).toBe('live route output');
    expect(captureOutput).toHaveBeenCalledWith(session.tmuxSession, 3);
  });

  it('keeps a genuinely unknown identifier on the 404 path', async () => {
    const { app, captureOutput } = appWithRealHandler();
    const response = await request(app).get('/sessions/genuinely-unknown/output');

    expect(response.status).toBe(404);
    expect(captureOutput).not.toHaveBeenCalled();
  });
});
