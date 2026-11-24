import { expect, it, vi } from 'vitest';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import type { InstarConfig } from '../../src/core/types.js';
import { codexFollowupFixture } from '../helpers/codexFollowupFixture.js';

it('production server exposes persistent owner follow-up custody and drains it once after completion', async () => {
  const f = codexFollowupFixture();
  let server: AgentServer | undefined;
  try {
    const first = f.boot();
    expect(first.manager.injectTelegramMessage('pooled-session', 42, 'Original owner request', 'Fixture', 'Owner', 123, 201)).toBe(true);
    expect(first.manager.injectTelegramMessage('pooled-session', 42, 'Owner follow-up', 'Fixture', 'Owner', 123, 202)).toBe(true);
    expect(first.paste).toHaveBeenCalledTimes(1);
    const active = first.store.observableDeliveries()[0];
    expect(active).toBeDefined();
    first.store.close();

    // server.ts constructs SessionManager before AgentServer; reconstruct both
    // against the same state directory without injecting a resolver or ledger.
    const second = f.boot();
    const config = {
      projectName: 'fixture', projectDir: f.project.dir, stateDir: f.project.stateDir, port: 0,
      authToken: 'fixture', developmentAgent: true,
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 2, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    } as unknown as InstarConfig;
    server = new AgentServer({ config, sessionManager: second.manager, state: f.project.state,
      initiativeTracker: new InitiativeTracker(f.project.stateDir) });
    const status = await request(server.getApp()).get('/sessions/inbound-delivery-status').set('Authorization', 'Bearer fixture');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ enabled: true, logicalRows: 2, deliveriesByState: { dispatched: 1, prepared: 1 } });
    second.seam.dispatchPreparedInboundDeliveries();
    expect(second.paste).not.toHaveBeenCalled();
    expect(second.store.recordTranscriptConsumed(active.conversationId, active.deliveryId, 'turn-1', active.baselineOffset)).toBe(true);
    expect(second.store.recordResponded(active.conversationId, active.deliveryId, 'turn-1', active.baselineOffset)).toBe(true);
    second.seam.dispatchPreparedInboundDeliveries();
    expect(second.paste).toHaveBeenCalledTimes(1);
    expect(second.paste.mock.calls[0][1]).toContain('Owner follow-up');
    expect(second.paste.mock.calls[0][1]).not.toContain('Original owner request');
    expect(second.store.get(active.conversationId, active.deliveryId)?.transportState).toBe('consumed');
    const dispatched = second.store.observableDeliveries()[0];
    expect(dispatched.rolloutPath).toBe(f.rollout);
    expect(dispatched.rolloutId).toBe('native-rollout');
    second.seam.dispatchPreparedInboundDeliveries();
    expect(second.paste).toHaveBeenCalledTimes(1);
  } finally {
    await server?.stop();
    vi.restoreAllMocks();
    f.cleanup();
  }
});
