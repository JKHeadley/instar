import fs from 'node:fs';
import path from 'node:path';
import { leaseJobHttpFixture } from './lease-job-http.js';
import { loadJobsDetailed } from '../../src/scheduler/JobLoader.js';

export function installPortableHttpJob(fixture: Awaited<ReturnType<typeof leaseJobHttpFixture>>) {
  fs.mkdirSync(path.join(fixture.stateDir, 'jobs', 'schedule'), { recursive: true });
  fs.mkdirSync(path.join(fixture.stateDir, 'jobs', 'user'), { recursive: true });
  fs.writeFileSync(path.join(fixture.stateDir, 'jobs', 'schedule', 'portable-http.json'), JSON.stringify({
    slug: 'portable-http', origin: 'user', schedule: '0 9 * * *', priority: 'medium',
    expectedDurationMinutes: 5, enabled: true, portable: true, requiredPaths: [],
    execute: { type: 'agentmd' },
  }));
  fs.writeFileSync(path.join(fixture.stateDir, 'jobs', 'user', 'portable-http.md'),
    '---\nname: Portable HTTP\ndescription: Portable transfer lifecycle fixture\n---\n# Portable private body\n');
  const loaded = loadJobsDetailed(fixture.config.scheduler!.jobsFile!, { quiet: true });
  if (loaded.problems.length || !loaded.jobs.some(job => job.slug === 'portable-http' && job.portable)) {
    throw new Error(`Portable HTTP fixture is not a runnable catalog entry: ${JSON.stringify(loaded.problems)}`);
  }
  fixture.config.multiMachine = { ...fixture.config.multiMachine,
    jobDefinitionSync: { enabled: true, dryRun: false } };
}
