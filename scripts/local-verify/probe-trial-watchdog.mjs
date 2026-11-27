/** Isolated, bounded calibration for the Darwin peer. Only the disposable watchdog may receive a signal. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { spawnSmallPeerSupervisor } from '../../dist/localVerify/smallPeerSupervisor.js';
import { readSmallPeerMemory, SMALL_PEER_COLLECTOR } from '../../dist/localVerify/smallPeerMemory.js';

const mode = process.argv[2];
if (!['completed', 'disabled', 'stalled-watchdog', 'expired-lease'].includes(mode)) throw new Error('Unknown fixture');
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-trial-watchdog-'));
const attemptId = randomBytes(16).toString('hex');
const start = performance.now();
const elapsed = () => Math.round(performance.now() - start);
const policy = {
  version: 1, machineId: 'm_' + '3'.repeat(32), collector: SMALL_PEER_COLLECTOR,
  floorBytes: 2 ** 30, reserveBytes: 2 ** 29, recoveryMs: 3000, unitWorkers: 2, integration: 1, e2e: 1,
};
const healthy = await readSmallPeerMemory();
if (!healthy || healthy.pressureLevel !== 1 || healthy.availableBytes <= 4 * 2 ** 30) throw new Error('Fixture requires four GiB of available memory');
const worker = `
  const fs = require('node:fs');
  const chunks = [];
  process.on('SIGTERM', () => {});
  fs.writeFileSync(process.argv[1], String(process.pid));
  const t = setInterval(() => {
    if (chunks.length < 32) chunks.push(Buffer.alloc(2 ** 20, 1));
  }, 100);
  setTimeout(() => { clearInterval(t); }, Number(process.argv[2]));
`;
const marker = path.join(stateDir, 'worker');
let enabled = true;
const handle = spawnSmallPeerSupervisor({
  stateDir, attemptId, policy, command: process.execPath,
  args: ['-e', worker, marker, mode === 'completed' ? '3600' : '16000'],
  env: { PATH:'/usr/bin:/bin', HOME:os.homedir() }, logFile:path.join(stateDir, 'fixture.log'),
}, () => enabled);
const report = { mode, attemptId, stateDir, collector: SMALL_PEER_COLLECTOR, maxWorkerAllocationBytes:32 * 2 ** 20, observations:[] };
let done = false;
const observe = async () => {
  while (!done) {
    const memory = await readSmallPeerMemory();
    report.observations.push({ elapsedMs:elapsed(), availableBytes:memory?.availableBytes, pressure:memory?.pressureLevel });
    if (!memory || memory.pressureLevel !== 1 || memory.availableBytes <= 4 * 2 ** 30) enabled = false;
    await wait(100);
  }
};
const observation = observe();
try {
  const deadline = performance.now() + 6000;
  while (!fs.existsSync(marker) && performance.now() < deadline) await wait(50);
  if (!fs.existsSync(marker)) throw new Error('Fixture worker did not start');
  await wait(1300);
  report.triggerMs = elapsed();
  if (mode === 'disabled') enabled = false;
  if (mode === 'stalled-watchdog') process.kill(handle.pid, 'SIGSTOP');
  await handle.exited;
  report.finishedMs = elapsed();
  const receipt = JSON.parse(fs.readFileSync(path.join(stateDir, 'state/local-verify/small-peer-runs', attemptId, 'receipt.json'), 'utf8'));
  report.receipt = receipt;
  if (!receipt.cleanupProven || receipt.outcome !== (mode === 'completed' ? 'completed' : 'capacity')) throw new Error('Unexpected fixture receipt');
  const pid = Number(fs.readFileSync(marker,'utf8'));
  try {process.kill(pid,0); throw new Error('Worker still running');} catch(e) {if(e.code!=='ESRCH') throw e;}
  for (let i=0;i<3;i++) await wait(1000);
} finally {
  enabled = false;
  done = true;
  await observation;
  console.log(JSON.stringify(report));
}
