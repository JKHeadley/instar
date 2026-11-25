#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CATEGORIES = {
  guardian: { title: 'Guardian', hours: 24 },
  maintenance: { title: 'Maintenance', hours: 48 },
  learning: { title: 'Learning', hours: 48 },
  infrastructure: { title: 'Infrastructure', hours: 48 },
};

function count(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid guardian count');
  return value;
}

export function calculateCategoryActivity(report, category, checkedAt) {
  if (!Object.hasOwn(CATEGORIES, category) || report?.category !== category || !Array.isArray(report.jobs)) {
    throw new Error('invalid activity report');
  }
  const { hours } = CATEGORIES[category];
  // The route omits its window and timestamp when the category has no matching jobs.
  const emptyResponse = report.jobs.length === 0 && report.summary?.totalJobs === 0
    && report.sinceHours === undefined && report.generatedAt === undefined;
  const generatedAt = emptyResponse ? checkedAt : report.generatedAt;
  if ((!emptyResponse && report.sinceHours !== hours) || !Number.isFinite(Date.parse(generatedAt))) {
    throw new Error('invalid activity report');
  }
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
    category, hours, generatedAt: new Date(generatedAt).toISOString(), jobs,
    totalRuns: jobs.reduce((total, job) => total + (job.runs ?? 0), 0),
    totalFailures: jobs.reduce((total, job) => total + (job.failures ?? 0), 0),
    jobsSkipping: jobs.filter(job => job.skips > 0).length,
  };
}

export function renderCategoryActivity(activity) {
  const quantity = (value, noun) => `${value} ${noun}${value === 1 ? '' : 's'}`;
  return [
    `${CATEGORIES[activity.category].title} job activity`,
    `${activity.hours}-hour counts as of ${activity.generatedAt}.`,
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
  const headers = { Authorization: `Bearer ${INSTAR_AUTH_TOKEN}`, 'X-Instar-AgentId': INSTAR_AGENT_ID };
  async function save(category, hours) {
    const response = await fetch(`http://127.0.0.1:${port}/jobs/category-report/${category}?sinceHours=${hours}`, {
      headers, redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('activity category unavailable');
    const report = renderCategoryActivity(calculateCategoryActivity(await response.json(), category, new Date().toISOString()));
    const directory = fileURLToPath(new URL(`../../../reports/${category}/`, import.meta.url));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(directory, `${INSTAR_JOB_RUN_ID}.txt`), report, { flag: 'wx', mode: 0o600 });
  }
  const outcomes = await Promise.allSettled(Object.entries(CATEGORIES).map(([category, { hours }]) => save(category, hours)));
  if (outcomes.some(outcome => outcome.status === 'rejected')) throw new Error('activity reports incomplete');
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
    console.log('JOB_RESULT ok activity reports saved');
  } catch {
    console.log('JOB_RESULT failed activity reports incomplete');
    process.exitCode = 1;
  }
}
