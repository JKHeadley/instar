import fs from 'node:fs';
import path from 'node:path';
import { createTempProject, createMockSessionManager } from './setup.js';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import type { JobDefinition } from '../../src/core/types.js';
import type { SecurityPreflightPacket } from '../../src/scheduler/SecurityReviewPreflight.js';

export const securityBody = 'Read the complete private ledger. Review every assigned area and A12. Probe required models. Never suppress reads.';
export function securityRig(enabled = true) {
  const project = createTempProject();
  const privateDir = path.join(project.stateDir, 'state/security/private'); fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 }); fs.chmodSync(privateDir, 0o700);
  const ledger = path.join(privateDir, 'findings.md'); fs.writeFileSync(ledger, '# Private ledger\nDuplicate headings and mixed statuses remain verbatim.\n');
  const rotation = path.join(project.stateDir, 'state/security/review-state.json'); fs.writeFileSync(rotation, '{"lastPass":1}');
  fs.mkdirSync(path.join(project.dir, 'docs/security'), { recursive: true });
  const map = path.join(project.dir, 'docs/security/threat-map.md'); fs.writeFileSync(map, '# All areas\nA1 through A12 are retained.\n');
  let config = { jobs: { securityReviewPreflight: { enabled, sourceRoot: project.dir } } };
  const saveConfig = () => fs.writeFileSync(path.join(project.stateDir, 'config.json'), JSON.stringify(config)); saveConfig();
  const job: JobDefinition = { slug: 'security-review', name: 'Security Review', description: 'Full normal security review',
    schedule: '0 0 1 1 *', priority: 'high', expectedDurationMinutes: 0, model: 'opus', enabled: true,
    execute: { type: 'prompt', value: securityBody }, body: securityBody };
  const jobsFile = path.join(project.stateDir, 'jobs.json'); fs.writeFileSync(jobsFile, JSON.stringify([job]));
  project.state.saveJobState({ slug: job.slug, lastRun: new Date().toISOString(), lastResult: 'success', consecutiveFailures: 0 });
  const sessions = createMockSessionManager(); const spawn = sessions.spawnSession;
  sessions.spawnSession = async options => { const s = await spawn(options); project.state.saveSession(s); return s; };
  function scheduler() {
    const s = new JobScheduler({ jobsFile, enabled: true, maxParallelJobs: 1, allowOnThrowawayAgent: true,
      quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } }, sessions as never, project.state, project.stateDir);
    s.setConfigReader(() => config); s.setMachineIdentity('fixture-machine', 'Fixture'); s.start(); return s;
  }
  const active = scheduler(); const packetDir = path.join(privateDir, 'review-packets');
  const packets = (): SecurityPreflightPacket[] => !fs.existsSync(packetDir) ? [] : fs.readdirSync(packetDir).filter(n => n.endsWith('.json')).map(n => JSON.parse(fs.readFileSync(path.join(packetDir, n), 'utf8')));
  return { project, ledger, map, rotation, privateDir, packetDir, packets, sessions, scheduler: active, rebuild: scheduler, jobsFile, job,
    setEnabled(value: boolean) { config = { jobs: { securityReviewPreflight: { enabled: value, sourceRoot: project.dir } } }; saveConfig(); },
    close() { active.stop(); project.cleanup(); } };
}
