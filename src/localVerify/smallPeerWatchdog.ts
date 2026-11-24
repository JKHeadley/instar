/** Runs separately from both the server and the PR job. All input comes from the trusted server via IPC. */
import { writeWatchdogReceipt } from './smallPeerReceipts.js';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawnViaLaunchd } from './launchdSpawn.js';
import { TrialExecutionScope, reconcileTrialScopes } from './trialExecutionScope.js';
import { readSmallPeerMemory, smallPeerMemoryAllows, type SmallPeerTrialPolicy } from './smallPeerMemory.js';

export interface TrialStart {
  stateDir: string;
  attemptId: string;
  policy: SmallPeerTrialPolicy;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  logFile: string;
}

export function trialDirectory(stateDir: string, attemptId: string): string {
  if (!/^[a-f0-9]{32}$/.test(attemptId)) throw new Error('invalid trial attempt');
  return path.join(stateDir, 'state', 'local-verify', 'small-peer-runs', attemptId);
}

export interface TrialReceipt {
  attemptId: string;
  outcome: 'completed' | 'capacity';
  reason: string;
  elapsedMs: number | null;
  peakRssBytes: number | null;
  minimumAvailableBytes: number | null;
  samples: number;
  cleanupProven: boolean;
  reserveBreached: boolean;
}

export async function runSmallPeerWatchdog(a: TrialStart): Promise<void> {
  const dir = trialDirectory(a.stateDir, a.attemptId);
  fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  const permit = path.join(dir, 'start');
  const began = performance.now();
  let scope: TrialExecutionScope | undefined;
  let peak: number | null = null;
  let minimum: number | null = null;
  const trace = (event: string, fields: Record<string, unknown> = {}) => {
    fs.appendFileSync(path.join(dir, 'sampling.jsonl'), JSON.stringify({
      event, elapsedMs: performance.now() - began, collector: a.policy.collector, ...fields,
    }) + '\n', { mode: 0o600 });
  };
  let samples = 0;
  let sequence = 0;
  let stopping = false;
  let completed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const receipt = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    if (timer) clearInterval(timer);
    if (process.connected) process.send?.({ stopping: true });
    try {
      trace('teardown-start', { reason });
      if (scope) {
        // A worker may allocate throughout TERM grace. Continue observing while cleanup owns the scope.
        let closing = true;
        const closingScope = scope;
        const observeTeardown = async () => {
          while (closing) {
            const memory = await readSmallPeerMemory();
            if (!closing) break;
            if (memory) minimum = Math.min(minimum ?? Infinity, memory.availableBytes);
            if (!smallPeerMemoryAllows(memory, a.policy.floorBytes, performance.now()) && completed) {
              completed = false;
              reason = memory ? 'memory' : 'measurement-failed';
            }
            const rss = closingScope.sample().rssBytes;
            peak = Math.max(peak ?? 0, rss);
            trace('teardown-sample', { availableBytes: memory?.availableBytes, rssBytes: rss });
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        };
        const monitoring = observeTeardown().catch(() => {
          completed = false;
          reason = 'measurement-failed';
        });
        try { await scope.stop(); }
        finally { closing = false; await monitoring; }
      } else await reconcileTrialScopes(a.stateDir);
      trace('scope-empty', { reason });
      const record: TrialReceipt = {
        attemptId: a.attemptId, outcome: completed ? 'completed' : 'capacity', reason,
        elapsedMs: performance.now() - began, peakRssBytes: peak, minimumAvailableBytes: minimum,
        samples, cleanupProven: true, reserveBreached: minimum !== null && minimum <= a.policy.reserveBytes,
      };
      writeWatchdogReceipt(a.stateDir, record);
      process.exitCode = completed ? 0 : 1;
    } catch (e) {
      console.error('Small peer trial cleanup failed', e);
      process.exitCode = 1;
    } finally {
      if (process.connected) process.disconnect();
    }
  };
  process.once('disconnect', () => void receipt('server-disconnected'));
  process.once('SIGTERM', () => void receipt('cancelled'));
  process.once('SIGINT', () => void receipt('cancelled'));
  try {
    const label = TrialExecutionScope.prepare(a.stateDir, a.attemptId);
    // The prelude is one Node process and execve preserves its pid. It starts no worker until released.
    const prelude = `const fs=require('node:fs');const [permit,...argv]=process.argv.slice(1);let n=0;
      const t=setInterval(()=>{if(++n>300){clearInterval(t);process.exitCode=1;return}
      if(fs.existsSync(permit)){clearInterval(t);process.execve(argv[0],argv,process.env)}},25);`;
    const realCommand = a.command === 'nice' ? '/usr/bin/nice' : a.command;
    const handle = spawnViaLaunchd({ command: process.execPath, args: ['-e', prelude, permit, realCommand, ...a.args], env: a.env, logFile: a.logFile },
      { dir, labelPrefix: label, trialLabel: label, cwd: process.cwd() });
    scope = TrialExecutionScope.capture({ stateDir: a.stateDir, attemptId: a.attemptId, rootPid: handle.pid });
    const hostMonotonic = () => Number(process.hrtime.bigint() / 1000000n);
    let leaseUntil = hostMonotonic() + 10_000;
    let probe = 0;
    let busy = false;
    let lastGood = performance.now();
    process.on('message', (msg: { expiresAt?: number; cancel?: boolean; probe?: number }) => {
      if (typeof msg.probe === 'number' && Number.isSafeInteger(msg.probe)) probe = msg.probe;
      if (msg.cancel) { void receipt('coordinator-disabled'); return; }
      // Only the parent that owns this IPC channel can renew, after validating the peer-issued challenge.
      if (typeof msg.expiresAt === 'number' && msg.expiresAt > hostMonotonic() && msg.expiresAt <= hostMonotonic() + 10_000 && hostMonotonic() < leaseUntil) {
        leaseUntil = msg.expiresAt;
      }
    });
    const sample = async () => {
      if (stopping) return;
      if (hostMonotonic() >= leaseUntil) { await receipt('lease-expired'); return; }
      if (performance.now() - lastGood >= 2000) { await receipt('sample-expired'); return; }
      if (busy) return;
      busy = true;
      try {
        const samplingProbe = probe;
        const memory = await readSmallPeerMemory();
        if (stopping) return;
        trace('memory', { availableBytes: memory?.availableBytes, pressure: memory?.pressureLevel,
          sampleElapsedMs: memory ? memory.sampledAt - began : null });
        if (memory) minimum = Math.min(minimum ?? Infinity, memory.availableBytes);
        if (!smallPeerMemoryAllows(memory, a.policy.floorBytes, performance.now())) { await receipt('memory'); return; }
        const rss = scope!.sample().rssBytes;
        if (performance.now() - lastGood >= 2000) { await receipt('sample-expired'); return; }
        peak = Math.max(peak ?? 0, rss);
        lastGood = memory!.sampledAt;
        samples++;
        trace('scope-sample', { rssBytes: rss, sequence: samples });
        process.send?.({ validSample: ++sequence, probe: samplingProbe, peakRssBytes: peak, minimumAvailableBytes: minimum, samples });
        if (samplingProbe > 0 && !fs.existsSync(permit)) fs.writeFileSync(permit, 'start', { mode: 0o600, flag: 'wx' });
      } catch { await receipt('measurement-failed'); }
      finally { busy = false; }
    };
    timer = setInterval(() => void sample(), 1000);
    await sample();
    handle.exited.then(async () => {
      if (stopping) return;
      completed = true;
      await receipt('runner-exited');
    });
  } catch (e) {
    console.error('Could not start small peer trial', e);
    await receipt('setup-failed');
  }
}
