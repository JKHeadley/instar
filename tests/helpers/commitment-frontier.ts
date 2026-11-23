import { wireCommitmentReceiptConsumption } from '../../src/scheduler/CommitmentReceiptWiring.js';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createTempProject, createMockSessionManager } from './setup.js';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { EvolutionManager } from '../../src/core/EvolutionManager.js';
import type { JobDefinition } from '../../src/core/types.js';
import type { SessionManager } from '../../src/core/SessionManager.js';

export const normalBody = 'Perform normal recent-message review. Keep the existing source filtering and bookmark.';
export function frontierSource(id = '1', text = 'No promise.') {
  return JSON.stringify({ messageId: id, topicId: 7, fromUser: true, telegramUserId: 42, provenance: 'user', timestamp: '2026-11-23T20:00:00Z', text }) + '\n';
}
export function commitmentRig(flags: { enabled?: boolean; skipEnabled?: boolean } = { enabled: true, skipEnabled: false }) {
  const project = createTempProject();
  let config: Record<string, unknown> = { jobs: { commitmentConsumedFrontier: flags } };
  fs.writeFileSync(path.join(project.stateDir, 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(project.stateDir, 'telegram-messages.jsonl'), frontierSource());
  const job: JobDefinition = { slug: 'commitment-detection', name: 'Commitment Detection', description: 'Normal review',
    schedule: '0 0 1 1 *', priority: 'high', expectedDurationMinutes: 0, model: 'haiku', enabled: true,
    execute: { type: 'prompt', value: normalBody }, body: normalBody };
  const jobsFile = path.join(project.stateDir, 'jobs.json'); fs.writeFileSync(jobsFile, JSON.stringify([job]));
  project.state.saveJobState({ slug: job.slug, lastRun: new Date().toISOString(), lastResult: 'success', consecutiveFailures: 0 });
  const sessions = createMockSessionManager(); const original = sessions.spawnSession;
  sessions.spawnSession = async options => { const session = await original(options); project.state.saveSession(session); return session; };
  const scheduler = new JobScheduler({ jobsFile, enabled: true, maxParallelJobs: 1, allowOnThrowawayAgent: true,
    quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } }, sessions as unknown as SessionManager, project.state, project.stateDir);
  scheduler.setConfigReader(() => config);
  scheduler.setMachineIdentity('fixture-machine', 'Fixture');
  const evolution = new EvolutionManager({ stateDir: project.stateDir });
  wireCommitmentReceiptConsumption(scheduler, evolution);
  scheduler.start();
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  function batch() {
    const dir = path.join(project.stateDir, 'state', 'commitment-frontier', 'batches');
    const file = fs.readdirSync(dir).find(name => name.endsWith('.json') && !name.endsWith('.ack.json'))!;
    const raw = fs.readFileSync(path.join(dir, file), 'utf8');
    return { value: JSON.parse(raw), ackPath: path.join(dir, file.replace('.json', '.ack.json')), hash: createHash('sha256').update(raw).digest('hex') };
  }
  async function finish(status = 'completed') {
    await settle();
    const session = sessions._sessions.at(-1)!;
    const captured = batch();
    fs.writeFileSync(captured.ackPath, JSON.stringify({ version: 1, batchId: captured.value.batchId,
      sessionName: session.name, batchHash: captured.hash,
      decisions: captured.value.rows.map((row: { key: string }) => ({ key: row.key, outcome: 'reviewed-no-action' })) }));
    session.status = status as typeof session.status;
    project.state.saveSession(session);
    await scheduler.notifyJobComplete(session.id, session.tmuxSession);
    return session;
  }
  return { project, scheduler, sessions, evolution, job, jobsFile, batch, finish, settle,
    setFlags(value: { enabled?: boolean; skipEnabled?: boolean }) { config = { jobs: { commitmentConsumedFrontier: value } }; fs.writeFileSync(path.join(project.stateDir, 'config.json'), JSON.stringify(config)); },
    close() { scheduler.stop(); project.cleanup(); } };
}
