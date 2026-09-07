import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import type { OriginAdmission } from '../../src/messaging/telegram-origin/StoreTypes.js';

export const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
export const temporaryState = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'instar-origin-store-'));
export async function compileOriginWorker(): Promise<URL> {
  const output = path.resolve('node_modules/.cache/telegram-origin-tests', randomUUID(), 'OriginStore.worker.mjs');
  await build({ entryPoints: [path.resolve('src/messaging/telegram-origin/OriginStore.worker.ts')], outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' });
  return pathToFileURL(output);
}
export async function compileOriginConfigWorker(): Promise<URL> {
  const output = path.resolve('node_modules/.cache/telegram-origin-tests', randomUUID(), 'OriginConfigReader.worker.mjs');
  await build({ entryPoints: [path.resolve('src/messaging/telegram-origin/OriginConfigReader.worker.ts')], outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' });
  return pathToFileURL(output);
}
export async function compileOriginDetectorCanaryWorker(): Promise<URL> {
  const output = path.resolve('node_modules/.cache/telegram-origin-tests', randomUUID(), 'OriginDetectorCanary.worker.mjs');
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
