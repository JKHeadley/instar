import { fork } from 'node:child_process';
import fs from 'node:fs';
import { finalizeTrialReceipt } from './smallPeerReceipts.js';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { type TrialStart } from './smallPeerWatchdog.js';
import { reconcileTrialScopes } from './trialExecutionScope.js';
import { SAMPLE_DEADLINE_MS, validSmallPeerHeartbeat, type SmallPeerHeartbeat } from './smallPeerMemory.js';
import type { ChildHandle } from './LocalVerifyService.js';

/** Separate process and IPC boundary so an unavailable server cannot strand the PR job. */
export function spawnSmallPeerSupervisor(args: TrialStart, policyStillEnabled: () => boolean): ChildHandle {
  const fd = fs.openSync(args.logFile, 'a', 0o600);
  const script = fileURLToPath(new URL('./runSmallPeerWatchdog.js', import.meta.url));
  let child;
  try {
    const index = args.args.indexOf('--attempt-token');
    const identity = index >= 0 ? args.args.slice(index,index+2) : [];
    child = fork(script, identity, { detached: true, env: args.env, execArgv: [], stdio: ['ignore', fd, fd, 'ipc'] });
  } finally { fs.closeSync(fd); }
  if (!child.pid) throw new Error('trial watchdog failed to spawn');
  const started = performance.now();
  let lastGood = started;
  let previous: SmallPeerHeartbeat | null = null;
  let observed: { peakRssBytes: number; minimumAvailableBytes: number; samples: number; reserveBreached: boolean } | undefined;
  let probe = 0;
  const outstanding = new Map<number, number>();
  let cancelled: string | null = null;
  let cancellingAt = 0;
  let teardownStarted: number | undefined;
  const send = (msg: object) => {
    if (child.connected) child.send(msg, (error) => { if (error && !cancelled) cancel('watchdog-disconnected'); });
  };
  const cancel = (reason: string) => {
    if (cancelled) return;
    cancelled = reason;
    cancellingAt = performance.now();
    send({ cancel: true });
  };
  child.on('message', (msg: { validSample?: number; probe?: number; stopping?: boolean; peakRssBytes?: number; minimumAvailableBytes?: number; samples?: number }) => {
    if (msg.stopping === true) {
      teardownStarted ??= performance.now();
      return;
    }
    const probeTime = msg.probe === undefined ? undefined : outstanding.get(msg.probe);
    if (probeTime === undefined || typeof msg.validSample !== 'number') return;
    const next = { attemptId: args.attemptId, sequence: msg.validSample, requestedAt: probeTime };
    if (!validSmallPeerHeartbeat(args.attemptId, previous, next, performance.now())) return;
    const {peakRssBytes,minimumAvailableBytes,samples} = msg;
    if (typeof peakRssBytes === 'number' && Number.isSafeInteger(peakRssBytes) && peakRssBytes >= 0
      && typeof minimumAvailableBytes === 'number' && Number.isSafeInteger(minimumAvailableBytes) && minimumAvailableBytes >= 0
      && typeof samples === 'number' && Number.isSafeInteger(samples) && samples > 0) {
      observed = {
        peakRssBytes: Math.max(observed?.peakRssBytes ?? 0, peakRssBytes),
        minimumAvailableBytes: Math.min(observed?.minimumAvailableBytes ?? Infinity, minimumAvailableBytes),
        samples: Math.max(observed?.samples ?? 0, samples),
        reserveBreached: !!observed?.reserveBreached || minimumAvailableBytes <= args.policy.reserveBytes,
      };
    }
    previous = next;
    lastGood = probeTime;
    for (const id of outstanding.keys()) if (id <= msg.probe!) outstanding.delete(id);
  });
  send(args);
  let killing = false;
  const pulse = () => {
    const now = performance.now();
    if (!policyStillEnabled()) cancel('trial-disabled');
    if (teardownStarted !== undefined) {
      // During bounded teardown the watchdog has already stopped sampling and is draining its owned scope.
      if (now - teardownStarted >= 5000 && !killing) {
        killing = true;
        cancel('cleanup-timeout');
        child.kill('SIGKILL');
      }
      return;
    }
    if (now - lastGood >= SAMPLE_DEADLINE_MS && !killing) {
      // A stalled watchdog cannot perform cleanup. Its exit immediately transfers cleanup to the server.
      cancel('sample-expired');
      killing = true;
      child.kill('SIGKILL');
      return;
    }
    if (cancelled) {
      if (now - cancellingAt > 2000 && !killing) {
        killing = true;
        child.kill('SIGKILL');
      }
      return;
    }
    // Retain the originating monotonic timestamp. Queueing a stale IPC response cannot extend the deadline.
    outstanding.set(++probe, now);
    send({ probe });
  };
  const timer = setInterval(pulse, 250);
  timer.unref();
  pulse();
  const exited = new Promise<{status: number | null; signal: string | null}>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', async (code, signal) => {
      clearInterval(timer);
      try {
        await reconcileTrialScopes(args.stateDir);
        finalizeTrialReceipt(args.stateDir, args.attemptId, cancelled, performance.now() - started, observed);
        resolve({ status: code, signal });
      } catch (e) { reject(e); }
    });
  });
  return { pid: child.pid, exited, renewTrial: (expiresAt) => send({ expiresAt }), cancelTrial: cancel };
}
