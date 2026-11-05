import fs from 'node:fs';
import path from 'node:path';
import { leaseJobHttpFixture } from './lease-job-http.js';

export function installPortableHttpJob(fixture: Awaited<ReturnType<typeof leaseJobHttpFixture>>) {
  fs.mkdirSync(path.join(fixture.stateDir, 'jobs', 'schedule'), { recursive: true });
  fs.mkdirSync(path.join(fixture.stateDir, 'jobs', 'user'), { recursive: true });
  fs.writeFileSync(path.join(fixture.stateDir, 'jobs', 'schedule', 'portable-http.json'), JSON.stringify({
    slug: 'portable-http', origin: 'user', schedule: '0 9 * * *', priority: 'medium',
    expectedDurationMinutes: 5, enabled: true, portable: true, requiredPaths: [],
    execute: { type: 'agentmd' },
  }));
  fs.writeFileSync(path.join(fixture.stateDir, 'jobs', 'user', 'portable-http.md'), '# Portable private body\n');
  fixture.config.multiMachine = { ...fixture.config.multiMachine,
    jobDefinitionSync: { enabled: true, dryRun: false } };
}
