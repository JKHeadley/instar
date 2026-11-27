#!/usr/bin/env node
import { createReadStream, realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const MINIMUM_FILES = { unit: 4000, integration: 1000, e2e: 700 };
const HOUR = 3_600_000;

function timestamp(value) {
  const time = typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) throw new Error('invalid report timestamp');
  return time;
}

export function calculateVerdicts(records, baseline, asOf) {
  const start = timestamp(baseline);
  const end = timestamp(asOf);
  if (start >= end) throw new Error('invalid report window');
  const entries = records.map(record => ({ record, finished: timestamp(record.finishedAt) }));
  function summarize(from) {
    const attempts = entries.filter(({ finished }) => from <= finished && finished <= end);
    const complete = attempts.map(({ record }) => record).filter(record => {
      if (!['success', 'failure'].includes(record.outcome)) return false;
      const files = new Map((record.lanes ?? []).map(lane => [lane.name, lane.files]));
      return Object.entries(MINIMUM_FILES).every(([lane, minimum]) => (files.get(lane) ?? 0) >= minimum);
    });
    const successful = complete.filter(record => record.outcome === 'success').length;
    const hours = (end - from) / HOUR;
    return { attempts: attempts.length, complete: complete.length, successful, hours };
  }
  return { sinceBaseline: summarize(start), lastTwoHours: summarize(end - 2 * HOUR) };
}

export function renderThroughputReport(asOf, metrics, queue = null) {
  function line(label, { attempts, complete, successful, hours }) {
    return `${label}: ${complete} full-gate verdicts (${(complete / hours).toFixed(2)}/hour), ${successful} successful (${(successful / hours).toFixed(2)}/hour), ${attempts} attempts ended.`;
  }
  return [
    'Testing throughput report',
    `Calculated at ${asOf}.`,
    line('Last two hours', metrics.lastTwoHours),
    line('Since the baseline', metrics.sinceBaseline),
    queue
      ? `Queue snapshot: ${queue.admitted} admitted, ${queue.waiting} waiting. Active revision: ${queue.head ?? 'none recorded'}.`
      : 'Queue snapshot is unavailable.',
    'Exact-head publication latency is unavailable from the verification journal.',
    '',
  ].join('\n');
}

async function readQueueSnapshot(directory) {
  async function read(name) {
    return JSON.parse(await readFile(path.join(directory, name), 'utf8'));
  }
  try {
    const [queue, waiting, active] = await Promise.all([
      read('queue.json'), read('waiting.json'), read('inflight.json').catch(() => null),
    ]);
    if (!Array.isArray(queue.entries) || !Array.isArray(waiting.waiters)) return null;
    const head = active?.headSha;
    return {
      admitted: queue.entries.length,
      waiting: waiting.waiters.length,
      head: typeof head === 'string' && /^[a-f0-9]{40}$/.test(head) ? head : null,
    };
  } catch {
    return null;
  }
}

export async function writeThroughputReport(stateDir, runId, asOf = new Date().toISOString()) {
  if (typeof runId !== 'string' || !/^testing-throughput-report-script-[a-z0-9-]+$/.test(runId)) {
    throw new Error('invalid scheduled run ID');
  }
  const directory = path.join(stateDir, 'reports', 'throughput-improvement');
  const baseline = JSON.parse(await readFile(path.join(directory, 'acceleration-baseline-20261124.json'), 'utf8'));
  const verifyDir = path.join(stateDir, 'state', 'local-verify');
  const input = createReadStream(path.join(verifyDir, 'journal.jsonl'));
  const lines = createInterface({ input, crlfDelay: Infinity });
  const records = [];
  try {
    for await (const line of lines) {
      if (line.trim()) records.push(JSON.parse(line).record);
    }
  } finally {
    lines.close();
    input.destroy();
  }
  const queue = await readQueueSnapshot(verifyDir);
  const report = renderThroughputReport(asOf, calculateVerdicts(records, baseline.asOf, asOf), queue);
  await writeFile(path.join(directory, `${runId}.txt`), report, { flag: 'wx', mode: 0o600 });
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
    const stateDir = fileURLToPath(new URL('../../../', import.meta.url));
    await writeThroughputReport(stateDir, process.env.INSTAR_JOB_RUN_ID);
    console.log('JOB_RESULT ok testing throughput report saved');
  } catch {
    console.log('JOB_RESULT failed testing throughput report could not be written');
    process.exitCode = 1;
  }
}
