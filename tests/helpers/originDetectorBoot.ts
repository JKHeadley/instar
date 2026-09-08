import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bootTelegramOrigin } from '../../src/messaging/telegram-origin/TelegramOriginBoot.js';
import { migrateSecrets } from '../../src/core/SecretMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { compileOriginWorker, compileOriginConfigWorker, compileOriginDetectorCanaryWorker } from './telegramOriginStore.js';
export async function detectorWorkers() { return { workerUrl: await compileOriginWorker(), configWorkerUrl: await compileOriginConfigWorker(), detectorCanaryWorkerUrl: await compileOriginDetectorCanaryWorker() }; }
export async function detectorFixture(workers: Awaited<ReturnType<typeof detectorWorkers>>) {
  const stateDir = await mkdtemp('/tmp/origin-detector-boot-'); await mkdir(path.join(stateDir, 'state'));
  const config = { projectDir: stateDir, stateDir, projectName: 'canary-fixture', port: 0,
    messaging: [{ type: 'telegram', enabled: true, config: { token: '123:detector-fixture', chatId: '-100123',
      messageOrigin: { detectorCanary: { intervalMs: 60_000 } } } }] };
  const configPath = path.join(stateDir, 'config.json');
  await writeFile(configPath, JSON.stringify(config)); await writeFile(path.join(stateDir, 'state/agent-attention-topic.json'), '42');
  migrateSecrets(configPath, stateDir);
  return { stateDir, configPath, config, options: { config: config as never, token: '123:detector-fixture', noticeOwner: true,
    ...workers, holdsLease: () => true, diagnoseUnknown: async () => undefined, onNoticeState: () => undefined },
    boot: () => bootTelegramOrigin({ config: config as never, token: '123:detector-fixture', noticeOwner: true,
      ...workers, nativeModelCanary: async () => ({ state: 'unavailable', cleanupVerified: true }), holdsLease: () => true, diagnoseUnknown: async () => undefined, onNoticeState: () => undefined }),
    cleanup: async () => { await SafeFsExecutor.safeRm(stateDir, { recursive: true, force: true, operation: 'origin-detector-fixture-cleanup' }); } };
}
