import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { commitmentRig, frontierSource, normalBody } from '../helpers/commitment-frontier.js';
import type { InstarConfig } from '../../src/core/types.js';

const rigs: ReturnType<typeof commitmentRig>[] = [];
afterEach(() => { for (const rig of rigs.splice(0)) rig.close(); });
function setup(flags = { enabled: true, skipEnabled: false }) {
  const rig = commitmentRig(flags); rigs.push(rig);
  const config = { projectName: 'receipt-integration', projectDir: rig.project.dir, stateDir: rig.project.stateDir, port: 0,
    authToken: 'receipt-fixture', scheduler: { enabled: false }, monitoring: {}, messaging: [] } as InstarConfig;
  const server = new AgentServer({ config, state: rig.project.state, scheduler: rig.scheduler, sessionManager: rig.sessions as never, evolution: rig.evolution });
  const trigger = () => request(server.getApp()).post('/jobs/commitment-detection/trigger').set('Authorization', 'Bearer receipt-fixture').send({ reason: 'fixture' });
  return { ...rig, server, trigger };
}

describe('consumed commitment frontier over HTTP', () => {
  it('collection preserves normal review; opt-in skips only exact covered source; appended input runs', async () => {
    const rig = setup();
    expect((await rig.trigger()).status).toBe(200); await rig.finish();
    expect(rig.sessions._lastSpawnArgs!.prompt).toContain(normalBody);
    expect((await rig.trigger()).status).toBe(200); await rig.finish();
    rig.setFlags({ enabled: true, skipEnabled: true });
    const quiet = await rig.trigger(); expect(quiet.status).toBe(409); expect(quiet.body.result).toBe('skipped');
    expect(rig.sessions._spawnCount).toBe(2);
    fs.appendFileSync(path.join(rig.project.stateDir, 'telegram-messages.jsonl'), frontierSource('9000000000000001', 'I will write the report.'));
    expect((await rig.trigger()).status).toBe(200); expect(rig.sessions._spawnCount).toBe(3);
  });
  it('a successful run without an acknowledgement is not coverage', async () => {
    const rig = setup(); await rig.trigger(); await rig.settle();
    const session = rig.sessions._sessions[0]; session.status = 'completed'; rig.project.state.saveSession(session);
    await rig.scheduler.notifyJobComplete(session.id, session.tmuxSession);
    rig.setFlags({ enabled: true, skipEnabled: true });
    expect((await rig.trigger()).status).toBe(200);
    expect(rig.sessions._spawnCount).toBe(2);
  });
  it('flags off is legacy and existing HTTP authentication remains required', async () => {
    const rig = setup({ enabled: false, skipEnabled: false });
    expect((await request(rig.server.getApp()).post('/jobs/commitment-detection/trigger').send({})).status).toBe(401);
    expect((await rig.trigger()).status).toBe(200); await rig.settle();
    expect(rig.sessions._lastSpawnArgs!.prompt).not.toContain('Optional commitment coverage');
    expect(fs.existsSync(path.join(rig.project.stateDir, 'state', 'commitment-frontier'))).toBe(false);
  });
});
