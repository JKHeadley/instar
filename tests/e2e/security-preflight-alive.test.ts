import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { securityRig } from '../helpers/security-preflight.js';
import { verifyPacketSource } from '../../src/scheduler/SecurityReviewPreflight.js';
import type { InstarConfig } from '../../src/core/types.js';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
describe('security preflight production-shaped lifecycle', () => {
  it('real started scheduler writes verifiable evidence; reconstructed scheduler still launches normal review', async () => {
    const r = securityRig(); cleanup.push(() => r.close());
    const config = { projectName: 'preflight-alive', projectDir: r.project.dir, stateDir: r.project.stateDir,
      port: 0, authToken: 'preflight-alive', scheduler: { enabled: false }, monitoring: {}, messaging: [] } as InstarConfig;
    async function boot(scheduler: typeof r.scheduler) {
      const s = new AgentServer({ config, state: r.project.state, scheduler, sessionManager: r.sessions as never });
      await s.start();
      let stopRequest: Promise<void> | undefined;
      const stop = () => stopRequest ??= s.stop();
      cleanup.push(stop);
      return { server: s, stop };
    }
    async function triggerAndCheckSpawn(server: AgentServer, spawnCount: number) {
      const response = await request(server.getApp()).post('/jobs/security-review/trigger')
        .set('Authorization', 'Bearer preflight-alive').send({ reason: 'lifecycle' });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ slug: 'security-review', result: 'triggered' });
      expect(r.sessions._spawnCount).toBe(spawnCount);
      const session = r.sessions._sessions[spawnCount - 1];
      expect(session).toMatchObject({ jobSlug: 'security-review', status: 'running' });
      return session;
    }
    // Capture is detached from admission and performs asynchronous filesystem checks.
    // Wait for its terminal outcome and match the private packet to the launched session.
    async function capturedPacket(sessionId: string, packetCount: number) {
      const outcome = await vi.waitFor(() => {
        const events = r.project.state.queryEvents({ type: 'security_review_preflight', limit: packetCount });
        expect(events).toHaveLength(packetCount);
        return events;
      }, { timeout: 10_000 });
      expect(outcome.map(event => event.metadata)).toEqual(
        Array.from({ length: packetCount }, () => expect.objectContaining({ status: 'recorded' })),
      );
      const packets = r.packets();
      expect(packets).toHaveLength(packetCount);
      const packet = packets.find(p => p.binding.sessionId === sessionId);
      if (!packet) throw new Error('No evidence packet matched the launched session');
      expect(outcome.map(event => event.metadata)).toContainEqual(expect.objectContaining({
        status: 'recorded',
        packetId: packet.packetId,
        runId: packet.binding.runId,
      }));
      expect(packet.sources.every(source => verifyPacketSource(source) !== null)).toBe(true);
      return packet;
    }
    const first = await boot(r.scheduler);
    const session = await triggerAndCheckSpawn(first.server, 1);
    const prior = await capturedPacket(session.id, 1);
    session.status = 'completed'; r.project.state.saveSession(session);
    await r.scheduler.notifyJobComplete(session.id, session.tmuxSession); await first.stop(); r.scheduler.stop();
    const rebuilt = r.rebuild(); cleanup.push(() => rebuilt.stop());
    const second = await boot(rebuilt);
    const relaunched = await triggerAndCheckSpawn(second.server, 2);
    const next = await capturedPacket(relaunched.id, 2);
    expect(next.packetId).not.toBe(prior.packetId);
    expect(r.packets()).toContainEqual(prior);
    expect(r.packets().every(p => p.preflight.delivery === 'not-proven')).toBe(true);
  });
});
