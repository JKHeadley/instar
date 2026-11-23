import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { EvolutionManager } from '../../src/core/EvolutionManager.js';
import { wireCommitmentReceiptConsumption } from '../../src/scheduler/CommitmentReceiptWiring.js';
import { commitmentRig, frontierSource } from '../helpers/commitment-frontier.js';
import type { InstarConfig } from '../../src/core/types.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

describe('consumed commitment frontier production-shaped lifecycle', () => {
  it('the same production wiring records real action proof, reloads durable coverage, and rejects independent action-store rollback', async () => {
    const rig = commitmentRig(); cleanup.push(() => rig.close());
    fs.writeFileSync(path.join(rig.project.stateDir, 'telegram-messages.jsonl'), frontierSource('1', 'I will send the promised report.'));
    const config = { projectName: 'frontier-alive', projectDir: rig.project.dir, stateDir: rig.project.stateDir,
      port: 0, authToken: 'frontier-alive', scheduler: { enabled: false }, monitoring: {}, messaging: [] } as InstarConfig;
    const server = new AgentServer({ config, state: rig.project.state, sessionManager: rig.sessions as never,
      scheduler: rig.scheduler, evolution: rig.evolution });
    await server.start(); cleanup.push(() => server.stop());
    const trigger = (s: AgentServer) => request(s.getApp()).post('/jobs/commitment-detection/trigger').set('Authorization', 'Bearer frontier-alive').send({ reason: 'lifecycle-fixture' });
    expect((await trigger(server)).status).toBe(200); await rig.settle();
    const batch = rig.batch(); const row = batch.value.rows[0];
    const action = rig.evolution.addAction({ title: 'Send the promised report', description: 'A real fixture action record.',
      followThroughOptOutReason: 'No due time stated.', source: { platform: 'commitment-detection', contentId: `cf1:${row.messageKey}:0` } });
    fs.writeFileSync(batch.ackPath, JSON.stringify({ version: 1, batchId: batch.value.batchId,
      sessionName: batch.value.sessionName, batchHash: batch.hash,
      decisions: [{ key: row.key, outcome: 'registered', actionIds: [action.id] }] }));
    const session = rig.sessions._sessions[0]; session.status = 'completed'; rig.project.state.saveSession(session);
    await rig.scheduler.notifyJobComplete(session.id, session.tmuxSession);
    rig.setFlags({ enabled: true, skipEnabled: true });
    expect((await trigger(server)).status).toBe(409); expect(rig.sessions._spawnCount).toBe(1);
    await server.stop();

    const rebuilt = new JobScheduler({ jobsFile: rig.jobsFile, enabled: true, allowOnThrowawayAgent: true, maxParallelJobs: 1,
      quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } }, rig.sessions as never, rig.project.state, rig.project.stateDir);
    rebuilt.setMachineIdentity('fixture-machine', 'Fixture');
    const evolution = new EvolutionManager({ stateDir: rig.project.stateDir });
    wireCommitmentReceiptConsumption(rebuilt, evolution); rebuilt.start(); cleanup.push(() => rebuilt.stop());
    const second = new AgentServer({ config, state: rig.project.state, sessionManager: rig.sessions as never,
      scheduler: rebuilt, evolution });
    await second.start(); cleanup.push(() => second.stop());
    expect((await trigger(second)).status).toBe(409); expect(rig.sessions._spawnCount).toBe(1);
    // Independent restore loses a referenced effect while retaining the source and receipt.
    const store = path.join(rig.project.stateDir, 'state', 'evolution', 'action-queue.json');
    const old = JSON.parse(fs.readFileSync(store, 'utf8')); old.actions = []; fs.writeFileSync(store, JSON.stringify(old));
    expect((await trigger(second)).status).toBe(200); expect(rig.sessions._spawnCount).toBe(2);
    expect(evolution.listActions()).toHaveLength(0); // observation never recreates an intentionally missing action
  });
});
