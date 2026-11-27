import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { MultiMachineCoordinator } from '../../src/core/MultiMachineCoordinator.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';

/** Real identity and coordinator dependencies, rooted outside the developer agent. */
export async function leaseJobHttpFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-job-http-'));
  const stateDir = path.join(root, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  const jobsFile = path.join(stateDir, 'jobs.json');
  fs.writeFileSync(jobsFile, '[]');
  const identityManager = new MachineIdentityManager(stateDir);
  const identity = await identityManager.generateIdentity({ name: 'Lease Jobs Fixture' });
  const state = new StateManager(stateDir);
  const coordinator = new MultiMachineCoordinator(state, { stateDir });
  const config = {
    projectName: 'lease-job-http', projectDir: root, stateDir, port: 0,
    host: '127.0.0.1', authToken: 'lease-job-http-auth', dashboardPin: '654321',
    scheduler: { enabled: false, jobsFile, maxParallelJobs: 1 },
  } as InstarConfig;
  return { root, stateDir, identityManager, identity, state, coordinator, config };
}
