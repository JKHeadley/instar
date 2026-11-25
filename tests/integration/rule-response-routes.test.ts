import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';

it('keeps rule response endpoints dark, then records only sent findings and exact-draft overrides', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-response-routes-'));
  let enabled = false;
  const app = express();
  app.use(express.json());
  app.use(createRoutes({
    config: { projectName: 'fixture', projectDir: stateDir, stateDir, port: 0 },
    state: { getSession: () => null },
    sessionManager: { listRunningSessions: () => [] },
    telegram: { getTopicHistory: () => [1, 2, 3].map(messageId => ({ messageId, fromUser: false, authorship: 'agent-outbound' })) },
    liveConfig: { get: (key: string, fallback: unknown) => key === 'toneGate.askLinksEscalation.enabled' ? enabled : fallback },
    startTime: new Date(),
  } as unknown as RouteContext));
  const call = (action: string, data: object) => request(app).post(`/rule-responses/${action}`)
    .set('X-Instar-Request', '1').send({ rule: 'ask-links', topic: 7, ...data });
  const draftInput = { draft: 'Would you approve this?', hasAsk: true };
  try {
    await call('finding', { message: 1, confirmed: true }).expect(404);
    expect(fs.existsSync(path.join(stateDir, 'rule-responses.db'))).toBe(false);
    enabled = true;
    await request(app).post('/rule-responses/draft').send({ rule: 'ask-links', topic: 7, ...draftInput }).expect(403);
    await call('finding', { message: 4, confirmed: true }).expect(409);
    for (const message of [1, 2, 3]) await call('finding', { message, confirmed: true }).expect(200);
    const draft = await call('draft', draftInput).expect(200);
    expect(draft.body).toMatchObject({ total: 3, action: 'draft-check', overrideReason: null, draftCheck: 'needs-links' });
    const withLink = { draft: 'What I need from you\n- Approve the draft at https://example.test/draft', hasAsk: true };
    expect((await call('draft', withLink).expect(200)).body.draftCheck).toBe('pass');
    const reason = 'The operator asked to receive it without a link.';
    await call('override', { ...draftInput, reason }).expect(200);
    expect((await call('draft', draftInput).expect(200)).body).toMatchObject({ overrideReason: reason, draftCheck: 'overridden' });
    expect((await call('draft', { ...draftInput, draft: 'Would you approve the revised draft?' }).expect(200)).body.overrideReason).toBeNull();
  } finally {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'rule response route fixture cleanup' });
  }
});
