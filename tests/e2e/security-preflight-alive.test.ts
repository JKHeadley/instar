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
      await s.start(); cleanup.push(() => s.stop()); return s;
    }
    const trigger = (s: AgentServer) => request(s.getApp()).post('/jobs/security-review/trigger').set('Authorization', 'Bearer preflight-alive').send({ reason: 'lifecycle' });
    const first = await boot(r.scheduler); expect((await trigger(first)).status).toBe(200);
    await vi.waitFor(() => expect(r.packets()).toHaveLength(1));
    const prior = r.packets()[0]; expect(prior.sources.every(s => verifyPacketSource(s) !== null)).toBe(true);
    const session = r.sessions._sessions[0]; session.status = 'completed'; r.project.state.saveSession(session);
    await r.scheduler.notifyJobComplete(session.id, session.tmuxSession); await first.stop(); r.scheduler.stop();
    const rebuilt = r.rebuild(); cleanup.push(() => rebuilt.stop());
    const second = await boot(rebuilt); expect((await trigger(second)).status).toBe(200);
    await vi.waitFor(() => expect(r.packets()).toHaveLength(2));
    expect(r.sessions._spawnCount).toBe(2); expect(r.packets().some(p => p.packetId === prior.packetId)).toBe(true);
    expect(r.packets().every(p => p.preflight.delivery === 'not-proven')).toBe(true);
  });
});
