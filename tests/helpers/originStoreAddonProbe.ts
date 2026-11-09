/**
 * Runs in a FRESH node process (see sqlite-addon-hold.test.ts): a vitest test
 * process may already hold the SQLite addon from another import, which would hide
 * the defect. Prints one JSON line: which native addons the MAIN thread loaded
 * after the first store opened, and how many heavy store cycles completed.
 *
 * argv: <worker-url> <state-root> <cycles>
 */
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { OriginStore } from '../../src/messaging/telegram-origin/OriginStore.js';

const [workerHref, stateRoot, cyclesArg] = process.argv.slice(2);
const mainThreadAddons: string[] = [];
const dlopen = process.dlopen.bind(process);
// Only this (main) thread's process object is wrapped; a worker has its own.
process.dlopen = ((module: unknown, filename: string, ...rest: unknown[]) => {
  mainThreadAddons.push(path.basename(filename));
  return (dlopen as (...args: unknown[]) => unknown)(module, filename, ...rest);
}) as typeof process.dlopen;

const DAY = 24 * 60 * 60_000;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function bigEvidence(name: string) {
  const envelopeJson = JSON.stringify({ padding: 'x'.repeat(200 * 1024) });
  return { originId: `origin-${name}`, machineId: 'probe', createdAt: Date.now() - 10 * DAY, envelopeJson,
    envelopeDigest: hash(envelopeJson), harnessId: 'codex', evidenceStatus: 'observed' as const };
}

const worker = new URL(workerHref);
let cycles = 0, addonsAfterFirstOpen: string[] | null = null;
for (let c = 0; c < Number(cyclesArg); c++) {
  const stateDir = fs.mkdtempSync(path.join(stateRoot, 'cycle-'));
  const store = await OriginStore.open({ stateDir, agentId: 'echo', requestTimeoutMs: 20_000 }, worker);
  if (addonsAfterFirstOpen === null) addonsAfterFirstOpen = [...mainThreadAddons];
  // The heaviest store-retention case: two ~10 MB archives, then compaction.
  for (const batch of ['a', 'b']) {
    for (let i = 0; i < 50; i++) await store.putEvidence(bigEvidence(`${c}-${batch}-${i}`));
    await store.archive({ before: Date.now(), limit: 100 });
  }
  for (let i = 0; i < 4; i++) await store.compactArchives({ limit: 8 });
  await store.close();
  cycles++;
}
process.stdout.write(`${JSON.stringify({ addonsAfterFirstOpen, cycles })}\n`);
