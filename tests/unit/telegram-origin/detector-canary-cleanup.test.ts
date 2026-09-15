import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { OriginDetectorCanary } from '../../../src/messaging/telegram-origin/OriginDetectorCanary.js';
import { DegradationReporter } from '../../../src/monitoring/DegradationReporter.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const checks = ['encrypted-config-read', 'exact-hub-permission', 'opt-out-observed', 'hub-rebind-refused', 'credential-rotation-refused', 'malformed-source-refused'];
let report: ReturnType<typeof vi.spyOn>;
beforeEach(() => { report = vi.spyOn(DegradationReporter.getInstance(), 'report').mockImplementation(() => undefined); });
function expectFault(fault: string) {
  expect(report).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining(`(${fault})`) }));
}
const cleanups: Array<() => Promise<void>> = [];
function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
afterEach(async () => {
  try { for (const close of cleanups.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); }
});
async function fixture(body: string, options: { timeoutMs?: number; cleanupTimeoutMs?: number } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'origin-canary-protocol-'));
  cleanups.push(() => SafeFsExecutor.safeRm(directory, { recursive: true, force: true, operation: 'origin-canary-protocol-fixture-cleanup' }));
  const file = path.join(directory, 'worker.mjs');
  await writeFile(file, `import {parentPort} from 'node:worker_threads';\nconst checks=${JSON.stringify(checks)};\n${body}`);
  const canary = new OriginDetectorCanary({ workerUrl: pathToFileURL(file), ...options });
  cleanups.push(() => canary.close());
  return canary;
}

it('retains running ownership while timely contract checks wait for slower verified cleanup', async () => {
  const canary = await fixture(`parentPort.postMessage({type:'checks',passed:true,checks});
    setTimeout(()=>parentPort.postMessage({type:'cleanup',verified:true}),1200);`,
  { timeoutMs: 1000, cleanupTimeoutMs: 2000 });
  const first = canary.run();
  await vi.waitFor(() => expect(canary.getHealth()).toMatchObject({ state: 'running', reason: 'canary-cleanup-running', checks: [] }));
  expect(canary.run()).toBe(first);
  await first;
  expect(canary.getHealth()).toMatchObject({ state: 'pass', attempts: 1, checks });
});

it.each([
  ['incomplete checks', `parentPort.postMessage({type:'checks',passed:true,checks:[]});parentPort.postMessage({type:'cleanup',verified:true});`],
  ['out-of-order checks', `parentPort.postMessage({type:'checks',passed:true,checks:[...checks].reverse()});parentPort.postMessage({type:'cleanup',verified:true});`],
  ['duplicate checks', `parentPort.postMessage({type:'checks',passed:true,checks});parentPort.postMessage({type:'checks',passed:true,checks});parentPort.postMessage({type:'cleanup',verified:true});`],
  ['duplicate cleanup', `parentPort.postMessage({type:'checks',passed:true,checks});parentPort.postMessage({type:'cleanup',verified:true});parentPort.postMessage({type:'cleanup',verified:true});`],
  ['cleanup before checks', `parentPort.postMessage({type:'cleanup',verified:true});parentPort.postMessage({type:'checks',passed:true,checks});`],
  ['unverified worker cleanup proof', `parentPort.postMessage({type:'checks',passed:true,checks});parentPort.postMessage({type:'cleanup',verified:true,fixtureRemoved:false,completedAt:0});`],
  ['missing check result', `parentPort.postMessage({passed:true,checks});`],
])('rejects %s without producing passing health', async (_name, body) => {
  const canary = await fixture(body);
  await canary.run();
  expect(canary.getHealth()).toMatchObject({ state: 'fail', attempts: 2, checks: [] });
});

it.each([
  ['missing cleanup', 'worker-exit-without-ack:awaiting-ack', `parentPort.postMessage({type:'checks',passed:true,checks});`],
  ['failed cleanup', 'negative-ack:awaiting-ack', `parentPort.postMessage({type:'checks',passed:true,checks});parentPort.postMessage({type:'cleanup',verified:false});`],
  ['stalled cleanup', 'deadline-timer:awaiting-ack', `parentPort.postMessage({type:'checks',passed:true,checks});setInterval(()=>{},1000);`],
  ['worker alive after acknowledgement', 'deadline-timer:awaiting-exit', `parentPort.postMessage({type:'checks',passed:true,checks});parentPort.postMessage({type:'cleanup',verified:true});setInterval(()=>{},1000);`],
])('latches %s instead of repeating successful checks', async (_name, fault, body) => {
  const canary = await fixture(body, { cleanupTimeoutMs: 100 });
  await canary.run();
  const health = canary.getHealth();
  expect(health).toMatchObject({ state: 'fail', reason: 'canary-cleanup-unverified', attempts: 1, checks: [] });
  await canary.run();
  expect(canary.getHealth()).toEqual(health);
  expectFault(`cleanup:${fault}`);
});

it('rejects late checks even when the parent timeout callback is delayed', async () => {
  const realTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
    realTimeout(callback, delay === 50 ? 250 : delay, ...args)) as typeof setTimeout);
  const canary = await fixture(`setTimeout(()=>{parentPort.postMessage({type:'checks',passed:true,checks});parentPort.postMessage({type:'cleanup',verified:true});},80);`,
    { timeoutMs: 50, cleanupTimeoutMs: 1000 });
  await canary.run();
  expect(canary.getHealth()).toMatchObject({ state: 'fail', attempts: 2, checks: [] });
});

it('rejects a late cleanup acknowledgement even when its deadline callback is delayed', async () => {
  const realTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
    realTimeout(callback, delay === 50 ? 250 : delay, ...args)) as typeof setTimeout);
  const canary = await fixture(`parentPort.postMessage({type:'checks',passed:true,checks});
    setTimeout(()=>parentPort.postMessage({type:'cleanup',verified:true}),80);`,
    { timeoutMs: 1000, cleanupTimeoutMs: 50 });
  await canary.run();
  expectFault('cleanup:late-ack:awaiting-ack');
  expect(canary.getHealth()).toMatchObject({ state: 'fail', reason: 'canary-cleanup-unverified', attempts: 1, checks: [] });
});

it('accepts cleanup completed before its deadline when parent receipt is event-loop delayed', async () => {
  const canary = await fixture(`
    const {performance}=await import('node:perf_hooks');
    const {rm}=await import('node:fs/promises');
    const {workerData}=await import('node:worker_threads');
    parentPort.postMessage({type:'checks',passed:true,checks,checkedAt:performance.now()});
    setTimeout(async()=>{await rm(workerData.directory,{recursive:true,force:true});parentPort.postMessage({type:'cleanup',verified:true,fixtureRemoved:true,completedAt:performance.now()})},50);`,
  { cleanupTimeoutMs: 100 });
  const run = canary.run();
  await vi.waitFor(() => expect(canary.getHealth().reason).toBe('canary-cleanup-running'), { interval: 1 });
  const stalledUntil = performance.now() + 200;
  while (performance.now() < stalledUntil) { /* Deliberately stall only the parent thread. */ }
  await run;
  expect(canary.getHealth().state, JSON.stringify(report.mock.calls)).toBe('pass');
  expect(canary.getHealth().attempts).toBe(1);
});

it('does not schedule automatic probes after a cleanup failure latches', async () => {
  const canary = await fixture(`parentPort.postMessage({type:'checks',passed:true,checks});parentPort.postMessage({type:'cleanup',verified:false});`);
  await canary.run();
  expect(canary.getHealth().reason).toBe('canary-cleanup-unverified');
  const timer = vi.spyOn(globalThis, 'setTimeout');
  canary.start();
  expect(timer).not.toHaveBeenCalled();
});

it('keeps ownership and close pending through late termination acknowledgement', async () => {
  const entered = gate(), release = gate(), realTerminate = Worker.prototype.terminate;
  const terminate = vi.spyOn(Worker.prototype, 'terminate').mockImplementation(async function (this: Worker) {
    const result = await realTerminate.call(this); entered.release(); await release.promise; return result;
  });
  const canary = await fixture(`parentPort.postMessage({type:'checks',passed:true,checks});parentPort.postMessage({type:'cleanup',verified:true});`, { cleanupTimeoutMs: 100 });
  const first = canary.run();
  let closeFinished = false;
  try {
    await entered.promise;
    await vi.waitFor(() => expect(canary.getHealth()).toMatchObject({ state: 'fail', reason: 'canary-cleanup-unverified' }));
    expect(canary.run()).toBe(first);
    const closing = canary.close().then(() => { closeFinished = true; });
    await Promise.resolve(); expect(closeFinished).toBe(false);
    release.release(); await first; await closing;
    expect(terminate).toHaveBeenCalledOnce();
    expect(report).not.toHaveBeenCalled(); // close suppresses a completed-cycle report.
  } finally { release.release(); }
});

it.each([false, true])('requires actual fixture removal completion (late=%s)', async late => {
  const entered = gate(), release = gate(), realRemove = SafeFsExecutor.safeRm;
  vi.spyOn(SafeFsExecutor, 'safeRm').mockImplementation(async (target, options) => {
    await realRemove(target, options);
    if (options.operation === 'origin-detector-canary-private-fixture-cleanup') { entered.release(); await release.promise; }
  });
  const canary = await fixture(`parentPort.postMessage({type:'checks',passed:true,checks});parentPort.postMessage({type:'cleanup',verified:true});`, { cleanupTimeoutMs: late ? 100 : 2000 });
  const first = canary.run();
  try {
    await entered.promise;
    expect(canary.run()).toBe(first);
    if (late) await vi.waitFor(() => expect(canary.getHealth().reason).toBe('canary-cleanup-unverified'));
    else expect(canary.getHealth()).toMatchObject({ state: 'running', reason: 'canary-cleanup-running', checks: [] });
    release.release(); await first;
    expect(canary.getHealth()).toMatchObject({ state: late ? 'fail' : 'pass', attempts: 1 });
    if (late) expectFault('cleanup:deadline-timer:removing-fixture');
  } finally { release.release(); }
});

it('latches a failed fixture removal proof and reports only a fixed public reason', async () => {
  const realRemove = SafeFsExecutor.safeRm;
  const remove = vi.spyOn(SafeFsExecutor, 'safeRm').mockImplementation(async (target, options) => {
    await realRemove(target, options);
    if (options.operation === 'origin-detector-canary-private-fixture-cleanup') throw new Error('private fixture detail');
  });
  const canary = await fixture(`parentPort.postMessage({type:'checks',passed:true,checks});parentPort.postMessage({type:'cleanup',verified:true});`);
  await canary.run();
  expect(canary.getHealth()).toMatchObject({ state: 'fail', reason: 'canary-cleanup-unverified', attempts: 1 });
  expect(JSON.stringify(canary.getHealth())).not.toMatch(/private fixture|\/tmp\//);
  expectFault('cleanup:operation-error:removing-fixture');
  expect(JSON.stringify(report.mock.calls)).not.toMatch(/private fixture detail|\/tmp\//);
  await canary.run(); expect(remove).toHaveBeenCalledOnce();
});

it.each(['checks', 'cleanup'])('closes during %s without passing or starting another attempt', async phase => {
  const canary = await fixture(phase === 'checks' ? 'setInterval(()=>{},1000);'
    : `parentPort.postMessage({type:'checks',passed:true,checks});setInterval(()=>{},1000);`);
  const online = gate(), realEmit = Worker.prototype.emit;
  vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (this: Worker, event, ...args) {
    if (event === 'online') online.release();
    return realEmit.call(this, event, ...args);
  });
  const first = canary.run();
  await online.promise;
  if (phase === 'cleanup') await vi.waitFor(() => expect(canary.getHealth().reason).toBe('canary-cleanup-running'));
  await canary.close(); await first;
  expect(canary.getHealth()).toMatchObject({ state: 'closed', attempts: 1, checks: [] });
  await canary.run(); expect(canary.getHealth().attempts).toBe(1);
});

it.each([0, -1, 30_001, 1.5, Number.NaN])('rejects invalid cleanup bounds (%s)', cleanupTimeoutMs => {
  expect(() => new OriginDetectorCanary({ cleanupTimeoutMs })).toThrow('invalid-canary-cleanup-timeout');
});


it.each([
  ['worker-exit-nonzero', 'process.exitCode = 2;'],
  ['worker-error', "setImmediate(() => { throw new Error('private worker detail'); });"],
])('distinguishes %s after valid cleanup acknowledgement', async (fault, ending) => {
  const canary = await fixture(`parentPort.postMessage({type:'checks',passed:true,checks});parentPort.postMessage({type:'cleanup',verified:true});${ending}`);
  await canary.run();
  expect(canary.getHealth()).toMatchObject({ state: 'fail', attempts: 1, reason: 'canary-cleanup-unverified' });
  expectFault(`cleanup:${fault}:awaiting-exit`);
  expect(JSON.stringify(report.mock.calls)).not.toContain('private worker detail');
});

it('distinguishes termination rejection after actually joining the owned worker', async () => {
  const terminate = Worker.prototype.terminate, emit = Worker.prototype.emit;
  vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (this: Worker, event, ...args) {
    if (event === 'message' && args[0]?.type === 'checks' && typeof args[0].ownedDirectory === 'string') {
      const ownedDirectory = args[0].ownedDirectory;
      cleanups.push(() => SafeFsExecutor.safeRm(ownedDirectory, { recursive: true, force: true, operation: 'origin-canary-protocol-fixture-cleanup' }));
    }
    return emit.call(this, event, ...args);
  });
  vi.spyOn(Worker.prototype, 'terminate').mockImplementation(async function (this: Worker) {
    await terminate.call(this); throw new Error('private termination detail');
  });
  const canary = await fixture(`import {workerData} from 'node:worker_threads';
    parentPort.postMessage({type:'checks',passed:true,checks,ownedDirectory:workerData.directory});parentPort.postMessage({type:'cleanup',verified:true});`);
  await canary.run();
  expectFault('cleanup:operation-error:terminating-worker');
  expect(JSON.stringify(report.mock.calls)).not.toContain('private termination detail');
});

it('distinguishes completion after the deadline when the timer callback is delayed', async () => {
  const realTimeout = globalThis.setTimeout, realRemove = SafeFsExecutor.safeRm;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
    realTimeout(callback, delay === 100 ? 1000 : delay, ...args)) as typeof setTimeout);
  vi.spyOn(SafeFsExecutor, 'safeRm').mockImplementation(async (target, options) => {
    await realRemove(target, options);
    if (options.operation === 'origin-detector-canary-private-fixture-cleanup') await new Promise(resolve => realTimeout(resolve, 150));
  });
  const canary = await fixture(`parentPort.postMessage({type:'checks',passed:true,checks});parentPort.postMessage({type:'cleanup',verified:true});`, { cleanupTimeoutMs: 100 });
  await canary.run();
  expectFault('cleanup:deadline-after-cleanup:removing-fixture');
});

it('preserves a negative acknowledgement through later termination delay and removal failure', async () => {
  const terminate = Worker.prototype.terminate, realRemove = SafeFsExecutor.safeRm;
  vi.spyOn(Worker.prototype, 'terminate').mockImplementation(async function (this: Worker) {
    const code = await terminate.call(this); await new Promise(resolve => setTimeout(resolve, 150)); return code;
  });
  vi.spyOn(SafeFsExecutor, 'safeRm').mockImplementation(async (target, options) => {
    await realRemove(target, options);
    if (options.operation === 'origin-detector-canary-private-fixture-cleanup') throw new Error('private later failure');
  });
  const canary = await fixture(`parentPort.postMessage({type:'checks',passed:true,checks});parentPort.postMessage({type:'cleanup',verified:false});`, { cleanupTimeoutMs: 100 });
  await canary.run();
  expectFault('cleanup:negative-ack:awaiting-ack');
  expect(report).toHaveBeenCalledOnce();
  expect(JSON.stringify(report.mock.calls)).not.toMatch(/private later failure|deadline-timer|operation-error/);
});
