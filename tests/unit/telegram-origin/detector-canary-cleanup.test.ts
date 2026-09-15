import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { OriginDetectorCanary } from '../../../src/messaging/telegram-origin/OriginDetectorCanary.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const checks = ['encrypted-config-read', 'exact-hub-permission', 'opt-out-observed', 'hub-rebind-refused', 'credential-rotation-refused', 'malformed-source-refused'];
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
  ['missing check result', `parentPort.postMessage({passed:true,checks});`],
])('rejects %s without producing passing health', async (_name, body) => {
  const canary = await fixture(body);
  await canary.run();
  expect(canary.getHealth()).toMatchObject({ state: 'fail', attempts: 2, checks: [] });
});

it.each([
  ['missing cleanup', `parentPort.postMessage({type:'checks',passed:true,checks});`],
  ['failed cleanup', `parentPort.postMessage({type:'checks',passed:true,checks});parentPort.postMessage({type:'cleanup',verified:false});`],
  ['stalled cleanup', `parentPort.postMessage({type:'checks',passed:true,checks});setInterval(()=>{},1000);`],
  ['worker alive after acknowledgement', `parentPort.postMessage({type:'checks',passed:true,checks});parentPort.postMessage({type:'cleanup',verified:true});setInterval(()=>{},1000);`],
])('latches %s instead of repeating successful checks', async (_name, body) => {
  const canary = await fixture(body, { cleanupTimeoutMs: 100 });
  await canary.run();
  const health = canary.getHealth();
  expect(health).toMatchObject({ state: 'fail', reason: 'canary-cleanup-unverified', attempts: 1, checks: [] });
  await canary.run();
  expect(canary.getHealth()).toEqual(health);
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
  expect(canary.getHealth()).toMatchObject({ state: 'fail', reason: 'canary-cleanup-unverified', attempts: 1, checks: [] });
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
