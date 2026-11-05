/** Add-only repair of shipped legacy job definitions after a lease handoff. */
import fs from 'node:fs';
import { getDefaultJobs } from '../commands/init.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

export function reconcileLegacyDefaultJobs(jobsFile: string, port: number): string[] {
  if (!fs.existsSync(jobsFile)) return [];
  const raw = JSON.parse(fs.readFileSync(jobsFile, 'utf8')) as unknown;
  if (!Array.isArray(raw) || raw.some(j => !j || typeof j !== 'object' || typeof j.slug !== 'string')) {
    throw new Error('jobs.json must be an array of jobs with slugs');
  }
  const existing = new Set(raw.map(j => j.slug as string));
  const missing = (getDefaultJobs(port) as Array<{ slug: string; enabled?: boolean }>)
    .filter(j => !existing.has(j.slug));
  for (const job of missing) {
    if (job.slug === 'git-sync') job.enabled = false;
    raw.push(job);
  }
  if (missing.length > 0) {
    SafeFsExecutor.atomicWriteJsonSync(jobsFile, raw, {
      operation: 'JobCatalogReconcile.reconcileLegacyDefaultJobs', indent: 2,
    });
  }
  return missing.map(j => j.slug);
}
