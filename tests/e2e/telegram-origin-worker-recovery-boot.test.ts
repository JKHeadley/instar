import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { bootTelegramOrigin } from '../../src/messaging/telegram-origin/TelegramOriginBoot.js';
import { createRoutes } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import { compileStallableOriginWorker } from '../helpers/telegramOriginStore.js';

// Production-path proof for the 2026-09-26 incident: the server booted while the
// host was still catching up and the origin worker's first generation failed.
// Previously that latched every Telegram send until a manual restart; now the
// production restart policy brings the worker back inside the same process and
// the authed /health surface says so.
let worker: URL;
beforeAll(async () => { worker = await compileStallableOriginWorker(); });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close(); }
  finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
}, 30_000);

describe('Telegram origin worker recovery on the production boot path', () => {
  it('a worker that fails during boot catch-up recovers by itself and is visible on /health', async () => {
    const report = vi.spyOn(DegradationReporter.getInstance(), 'report').mockImplementation(() => undefined);
    const root = await mkdtemp('/tmp/origin-worker-recovery-boot-');
    cleanup.push(async () => { await SafeFsExecutor.safeRm(root, { recursive: true, force: true, operation: 'test:origin-worker-recovery-boot:cleanup' }); });
    const stateDir = path.join(root, '.instar'); await mkdir(path.join(stateDir, 'state'), { recursive: true });
    const config = { projectDir: root, stateDir, projectName: 'echo', port: 0, authToken: 'fixture-auth',
      messaging: [{ type: 'telegram', enabled: true, config: { token: '123:recovery-fixture', chatId: '-100123', lifelineTopicId: 7848 } }] };
    await writeFile(path.join(stateDir, 'config.json'), JSON.stringify(config));
    // The first two worker generations (store and spool share this counter) fail to start.
    await writeFile(path.join(stateDir, 'origin-worker-fail-starts'), '2');
    const boot = await bootTelegramOrigin({ config: config as never, token: '123:recovery-fixture', noticeOwner: true,
      workerUrl: worker, holdsLease: () => true, isSessionLive: () => true,
      attachSessionLifecycle: () => undefined, diagnoseUnknown: vi.fn(async () => undefined), onNoticeState: vi.fn() });
    cleanup.push(() => boot.close());
    const store = boot.runtime.store;
    // Production restart policy (1s, 2s, ... backoff) — no reopen, no process restart.
    await vi.waitFor(() => {
      const health = boot.runtime.storageHealth();
      expect(health.store.state).toBe('ready'); expect(health.spool.state).toBe('ready');
    }, { timeout: 15_000, interval: 100 });
    await boot.runtime.confirmRecordingHealthy();
    expect(boot.runtime.store).toBe(store);
    const health = boot.runtime.storageHealth();
    expect(health.store.restarts + health.spool.restarts).toBe(2);
    expect(health.store.maxRestartAttempts).toBeGreaterThan(0);

    const app = express(); app.use(express.json());
    app.use(createRoutes({ config, telegramOrigin: boot.runtime, startTime: new Date(),
      sessionManager: { clearInjectionTracker: () => undefined, getCachedRunningSessions: () => ({ count: 0 }) },
      state: { getJobState: () => null }, scheduler: null } as never));
    const response = await request(app).get('/health').set('Authorization', 'Bearer fixture-auth');
    expect(response.status).toBe(200);
    expect(response.body.telegramOriginStorage.store).toMatchObject({ mode: 'store', state: 'ready' });
    expect(response.body.telegramOriginStorage.spool).toMatchObject({ mode: 'spool', state: 'ready' });
    // Unauthenticated callers never see the worker posture.
    expect((await request(app).get('/health')).body.telegramOriginStorage).toBeUndefined();
    expect(report).toHaveBeenCalled();
  }, 60_000);
});
