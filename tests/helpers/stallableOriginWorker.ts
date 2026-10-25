// Test-only wrapper around the real origin store worker. Control files in the
// store's stateDir inject the two production failure shapes without touching
// the shipped worker: a synchronous stall (a slow disk inside one request) and
// a failed generation startup.
//   origin-worker-fail-starts  N  → the next N generations report ready:false
//   origin-worker-stall-ms     ms → the next request (one-shot) busy-waits ms first
//   origin-worker-stall-n      "N,ms" → each of the next N requests busy-waits ms first
import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

const stateDir = (workerData as { options: { stateDir: string } }).options.stateDir;
const control = (name: string) => path.join(stateDir, `origin-worker-${name}`);
const take = (name: string): number => {
  try { return Number(fs.readFileSync(control(name), 'utf8')) || 0; } catch { return 0; }
};

const failStarts = take('fail-starts');
if (failStarts > 0) {
  fs.writeFileSync(control('fail-starts'), String(failStarts - 1));
  parentPort!.postMessage({ ready: false, error: 'injected-startup-failure' });
  parentPort!.close();
} else {
  // Registered before the real worker's listener, so the stall precedes the operation.
  parentPort!.on('message', (message: { method?: string }) => {
    if (!message?.method || message.method === 'close') return;
    let stallMs = take('stall-ms');
    if (stallMs > 0) fs.writeFileSync(control('stall-ms'), '0');
    else {
      let spec = '';
      try { spec = fs.readFileSync(control('stall-n'), 'utf8'); } catch { /* no counted stall */ }
      const [count, ms] = spec.split(',').map(Number);
      if (count > 0 && ms > 0) { fs.writeFileSync(control('stall-n'), `${count - 1},${ms}`); stallMs = ms; }
    }
    if (stallMs <= 0) return;
    const until = Date.now() + stallMs;
    while (Date.now() < until) { /* synchronous stall, like a blocked disk write */ }
  });
  await import('../../src/messaging/telegram-origin/OriginStore.worker.js');
}
