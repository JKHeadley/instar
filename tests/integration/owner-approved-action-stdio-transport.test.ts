/**
 * Tier 2 (SEC-018 companion): the `/threadline/approved-delete` route end-to-end on a real
 * AgentServer. The load-bearing security property (CoS condition, msg 92e3952c): a HOSTILE LOCAL
 * caller holding the agent token, with the feature ENABLED, still gets `owner-approval-required`
 * and the thread SURVIVES — the route cannot be used to delete without a device-signed approval.
 * Positive control: a recorded approval deletes it. Dark control: disabled → deletes.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { ThreadResumeMap, type ThreadResumeEntry } from '../../src/threadline/ThreadResumeMap.js';
import { OwnerApprovedActionStore } from '../../src/server/OwnerApprovedActionStore.js';
import { PendingApprovalRegistry } from '../../src/server/PendingApprovalRegistry.js';
import { createMockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'oaa-stdio-integ-token';
const dirs: string[] = [];

function entry(subject: string): ThreadResumeEntry {
  const iso = new Date().toISOString();
  return { uuid: 'u-' + subject, sessionName: 'sess-' + subject, createdAt: iso, savedAt: iso, lastAccessedAt: iso,
    remoteAgent: 'peer', subject, state: 'active', pinned: false, messageCount: 2,
    // A thread bound to a conversation: get() then does not require a transcript file on
    // disk (an unpinned, unbound entry with no transcript reads as absent).
    originTopicId: 4242 };
}

function boot(enabled: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oaa-stdio-integ-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });

  const threadResumeMap = new ThreadResumeMap(stateDir, dir);
  threadResumeMap.save('thr_hostile', entry('Hostile target'));
  threadResumeMap.save('thr_approved', entry('Approved target'));
  threadResumeMap.save('thr_dark', entry('Dark target'));

  const ownerApprovedActionStore = new OwnerApprovedActionStore();
  // Positive control: a device-signed approval was recorded by the owner's phone for thr_approved.
  ownerApprovedActionStore.record({ purpose: 'thread-delete', actionKey: 'thr_approved' });
  const ownerApprovedActionPending = new PendingApprovalRegistry();

  const config = {
    projectName: 'oaa-stdio-integ', agentName: 'E2E', projectDir: dir, stateDir,
    port: 0, authToken: AUTH, dashboardPin: '123456',
    ...(enabled ? { security: { ownerApprovedActions: { enabled: true } } } : {}),
  } as InstarConfig;
  const sessionManager = Object.assign(createMockSessionManager() as any, { on: vi.fn() });
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir),
    threadResumeMap, ownerApprovedActionStore, ownerApprovedActionPending } as any);
  return { server, threadResumeMap };
}

afterAll(() => { for (const d of dirs) { try { SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/owner-approved-action-stdio-transport.test.ts' }); } catch { /* best-effort */ } } });

describe('owner-approved-action stdio transport route (SEC-018 companion)', () => {
  it('HOSTILE caller (holds the agent token) + enabled + NO approval → owner-approval-required, thread SURVIVES', async () => {
    const { server, threadResumeMap } = boot(true);
    const res = await request(server.getApp())
      .post('/threadline/approved-delete').set('Authorization', `Bearer ${AUTH}`)
      .send({ threadId: 'thr_hostile' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, reason: 'owner-approval-required' });
    expect(threadResumeMap.get('thr_hostile')).not.toBeNull(); // could NOT delete
  });

  it('positive control: a recorded device approval → deletes the thread', async () => {
    const { server, threadResumeMap } = boot(true);
    const res = await request(server.getApp())
      .post('/threadline/approved-delete').set('Authorization', `Bearer ${AUTH}`)
      .send({ threadId: 'thr_approved' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.deleted).toBe(true);
    expect(threadResumeMap.get('thr_approved')).toBeNull(); // gone
  });

  it('dark control: feature DISABLED → the delete just proceeds (byte-identical to today)', async () => {
    const { server, threadResumeMap } = boot(false);
    const res = await request(server.getApp())
      .post('/threadline/approved-delete').set('Authorization', `Bearer ${AUTH}`)
      .send({ threadId: 'thr_dark' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(threadResumeMap.get('thr_dark')).toBeNull();
  });

  it('a tunnel-arriving request (X-Forwarded-For) is refused before anything, even with the token', async () => {
    const { server, threadResumeMap } = boot(true);
    const res = await request(server.getApp())
      .post('/threadline/approved-delete').set('Authorization', `Bearer ${AUTH}`)
      .set('X-Forwarded-For', '203.0.113.9').send({ threadId: 'thr_hostile' });
    expect(res.status).toBe(403);
    expect(threadResumeMap.get('thr_hostile')).not.toBeNull();
  });
});
