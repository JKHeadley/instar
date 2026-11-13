import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import type { OriginAdmission } from '../../src/messaging/telegram-origin/StoreTypes.js';

export const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
/**
 * Lift the origin service's own recording budgets out of the way (20 s a stage, where
 * production has 250 ms to 1250 ms). For fixtures that run beside a full suite: on a saturated
 * disk a healthy SQLite commit outlasts the production budgets and the send is held as a
 * recording outage that never happened.
 *
 * What then bounds a slow stage: in a runtime or boot fixture the store AND the spool are
 * OriginStore instances, whose every request has its own deadline (`requestTimeoutMs`, 2 s by
 * default). A fixture that passes storage options should also set
 * SLOW_DISK_STORE_REQUEST_TIMEOUT_MS (below); then the 20 s stage budget is the bound. A
 * fixture built through `bootTelegramOrigin` cannot, and for it the effective allowance is
 * about 2 s (8x and 4x the 250 and 500 ms budgets). A sink that REJECTS still fails at once, so
 * tests of real outages keep their meaning.
 */
/**
 * The store's own per-request deadline for fixtures that can set storage options (the maximum
 * the store accepts; production default 2 s). With `allowSlowOriginRecording` it lets a healthy
 * commit take as long as a saturated disk needs. Fixtures built through `bootTelegramOrigin`
 * cannot set it and keep the 2 s request deadline.
 */
export const SLOW_DISK_STORE_REQUEST_TIMEOUT_MS = 30_000;
export function allowSlowOriginRecording(service: { options: { stageDeadlines?: Partial<Record<'storeEvidenceMs' | 'spoolEvidenceMs' | 'peerEvidenceMs' | 'verifiedEvidenceMs' | 'admitMs', number>> } }): void {
  service.options.stageDeadlines = { storeEvidenceMs: 20_000, spoolEvidenceMs: 20_000, peerEvidenceMs: 20_000, verifiedEvidenceMs: 20_000, admitMs: 20_000 };
}
export const temporaryState = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'instar-origin-store-'));
// Confined feedback verification mounts node_modules read-only. Keep generated
// workers in the writable, ignored test cache under the repo: native imports
// (such as better-sqlite3) still need to resolve from this repo's node_modules.
const workerOutput = (name: string): string => path.resolve('.vitest/telegram-origin-tests', randomUUID(), name);
export async function compileOriginWorker(): Promise<URL> {
  const output = workerOutput('OriginStore.worker.mjs');
  await build({ entryPoints: [path.resolve('src/messaging/telegram-origin/OriginStore.worker.ts')], outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' });
  return pathToFileURL(output);
}
/** The real worker behind a test-only fault-injection wrapper (see stallableOriginWorker.ts). */
export async function compileStallableOriginWorker(): Promise<URL> {
  const output = workerOutput('StallableOriginStore.worker.mjs');
  await build({ entryPoints: [path.resolve('tests/helpers/stallableOriginWorker.ts')], outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' });
  return pathToFileURL(output);
}
export async function compileOriginConfigWorker(): Promise<URL> {
  const output = workerOutput('OriginConfigReader.worker.mjs');
  await build({ entryPoints: [path.resolve('src/messaging/telegram-origin/OriginConfigReader.worker.ts')], outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' });
  return pathToFileURL(output);
}
export async function compileOriginDetectorCanaryWorker(): Promise<URL> {
  const output = workerOutput('OriginDetectorCanary.worker.mjs');
  await build({ entryPoints: [path.resolve('src/messaging/telegram-origin/OriginDetectorCanary.worker.ts')], outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' });
  return pathToFileURL(output);
}
export function admission(name = randomUUID(), now = Date.now(), children = 1): OriginAdmission {
  const envelopeJson = JSON.stringify({ originId: `origin-${name}`, machineId: 'studio', contentDigest: hash(name) });
  return {
    record: { originId: `origin-${name}`, machineId: 'studio', createdAt: now, envelopeJson, envelopeDigest: hash(envelopeJson), harnessId: 'codex', evidenceStatus: 'observed' },
    operationId: `operation-${name}`, preparedAt: now, deadlineAt: now + 6 * 60 * 60_000, maxAttempts: 9, payloadBytes: 4096 * children,
    children: Array.from({ length: children }, (_, n) => {
      const requestJson = JSON.stringify({ chat_id: '-100123', text: `message ${name} ${n}` });
      return { childId: `child-${name}-${n}`, deliveryId: `delivery-${name}-${n}`, destinationJson: JSON.stringify({ transport: 'bot-api', accountId: 'bot-1', chatId: '-100123', topicId: '12' }), canonicalContentDigest: hash(name), allowedDerivations: ['signature-renewal'], materializations: [{ materializationId: `materialization-${name}-${n}`, requestJson, requestDigest: hash(requestJson) }] };
    }),
  };
}
