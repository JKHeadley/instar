#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function count(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid guardian count');
  return value;
}

export function calculateGuardianActivity(report) {
  if (report.category !== 'guardian' || report.sinceHours !== 24 || !Array.isArray(report.jobs)
    || !Number.isFinite(Date.parse(report.generatedAt))) throw new Error('invalid guardian report');
  const slugs = new Set();
  const jobs = report.jobs.map(job => {
    if (typeof job.slug !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(job.slug)
      || typeof job.enabled !== 'boolean' || slugs.has(job.slug)) throw new Error('invalid guardian job');
    slugs.add(job.slug);
    const runs = job.stats === null ? null : count(job.stats?.totalRuns);
    const failures = job.stats === null ? null : count(job.stats?.failures);
    if (runs !== null && failures > runs) throw new Error('guardian failures exceed runs');
    const consecutiveFailures = count(job.state?.consecutiveFailures);
    const skips = count(job.skips?.total);
    const quotaSkips = count(job.skips?.byReason?.quota ?? 0);
    if (quotaSkips > skips) throw new Error('quota skips exceed skips');
    return { slug: job.slug, enabled: job.enabled, runs, failures, consecutiveFailures, skips, quotaSkips };
  }).sort((left, right) => left.slug.localeCompare(right.slug));
  return {
    generatedAt: new Date(report.generatedAt).toISOString(), jobs,
    totalRuns: jobs.reduce((total, job) => total + (job.runs ?? 0), 0),
    totalFailures: jobs.reduce((total, job) => total + (job.failures ?? 0), 0),
    jobsSkipping: jobs.filter(job => job.skips > 0).length,
  };
}

export function renderGuardianActivity(activity) {
  const quantity = (value, noun) => `${value} ${noun}${value === 1 ? '' : 's'}`;
  return [
    'Guardian job activity',
    `24-hour counts as of ${activity.generatedAt}.`,
    `${quantity(activity.jobs.length, 'job')}, ${quantity(activity.totalRuns, 'run')}, ${quantity(activity.totalFailures, 'failure')}, ${quantity(activity.jobsSkipping, 'job')} with skips.`,
    ...activity.jobs.map(job => {
      const runs = job.runs === null ? 'run counts unavailable' : `${quantity(job.runs, 'run')}, ${quantity(job.failures, 'failure')}`;
      return `${job.slug} (${job.enabled ? 'enabled' : 'disabled'}): ${runs}, ${quantity(job.consecutiveFailures, 'consecutive failure')}, ${quantity(job.skips, 'skip')} (${job.quotaSkips} quota).`;
    }),
    '',
  ].join('\n');
}

async function main() {
  const { INSTAR_PORT, INSTAR_AGENT_ID, INSTAR_AUTH_TOKEN, INSTAR_JOB_RUN_ID } = process.env;
  const port = Number(INSTAR_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !INSTAR_AUTH_TOKEN || !INSTAR_AGENT_ID
    || !/^guardian-activity-report-script-[a-z0-9-]+$/.test(INSTAR_JOB_RUN_ID ?? '')) {
    throw new Error('invalid scheduled report configuration');
  }
  const response = await fetch(`http://127.0.0.1:${port}/jobs/category-report/guardian?sinceHours=24`, {
    headers: { Authorization: `Bearer ${INSTAR_AUTH_TOKEN}`, 'X-Instar-AgentId': INSTAR_AGENT_ID },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('guardian category unavailable');
  const report = renderGuardianActivity(calculateGuardianActivity(await response.json()));
  const directory = fileURLToPath(new URL('../../../reports/guardian/', import.meta.url));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, `${INSTAR_JOB_RUN_ID}.txt`), report, { flag: 'wx', mode: 0o600 });
}

function invokedDirectly() {
  try {
    return Boolean(process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  try {
    await main();
    console.log('JOB_RESULT ok guardian activity report saved');
  } catch {
    console.log('JOB_RESULT failed guardian activity report could not be written');
    process.exitCode = 1;
  }
}
