import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { securityRig, securityBody } from '../helpers/security-preflight.js';
import { verifyPacketSource } from '../../src/scheduler/SecurityReviewPreflight.js';
import type { InstarConfig } from '../../src/core/types.js';
const rigs: ReturnType<typeof securityRig>[] = [];
afterEach(() => { for (const r of rigs.splice(0)) r.close(); });
function setup(enabled = true) {
  const r = securityRig(enabled); rigs.push(r);
  const config = { projectName: 'preflight-integration', projectDir: r.project.dir, stateDir: r.project.stateDir,
    port: 0, authToken: 'preflight-fixture', scheduler: { enabled: false }, monitoring: {}, messaging: [] } as InstarConfig;
  const server = new AgentServer({ config, state: r.project.state, scheduler: r.scheduler, sessionManager: r.sessions as never });
  return { ...r, server, trigger: () => request(server.getApp()).post('/jobs/security-review/trigger').set('Authorization', 'Bearer preflight-fixture').send({ reason: 'fixture' }) };
}
describe('security evidence preflight over actual HTTP job route', () => {
  it('records full private packet after authenticated normal admission, without changing prompt or response', async () => {
    const r = setup(); expect((await request(r.server.getApp()).post('/jobs/security-review/trigger').send({})).status).toBe(401);
    const response = await r.trigger(); expect(response.status).toBe(200);
    await vi.waitFor(() => expect(r.packets()).toHaveLength(1));
    const p = r.packets()[0]; expect(p.coverage).toBe('complete-declared-inputs');
    expect(verifyPacketSource(p.sources[0])).toEqual(fs.readFileSync(r.ledger));
    expect(verifyPacketSource(p.sources[3])!.toString()).toBe(r.sessions._lastSpawnArgs!.prompt);
    expect(r.sessions._lastSpawnArgs!.prompt).toContain(securityBody); expect(r.sessions._spawnCount).toBe(1);
    expect(JSON.stringify(response.body)).not.toContain('Duplicate headings');
  });
  it.each([false, true])('off or missing history never blocks normal review: enabled=%s', async enabled => {
    const r = setup(enabled); if (enabled) fs.renameSync(r.ledger, r.ledger + '.away');
    expect((await r.trigger()).status).toBe(200); await vi.waitFor(() => expect(r.sessions._spawnCount).toBe(1));
    expect(r.packets()).toEqual([]); expect(r.project.state.getJobState('security-review')!.lastResult).toBe('pending');
  });
});
