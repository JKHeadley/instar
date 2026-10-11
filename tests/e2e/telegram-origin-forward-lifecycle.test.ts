/**
 * a2a-single-agent-identity §4 (ACT-058) — Tier 3: the feature is ALIVE on the
 * production init path (`bootTelegramOrigin` + `createRoutes`, mirroring
 * server.ts), and the migration parity rows land once and idempotently.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { bootTelegramOrigin } from '../../src/messaging/telegram-origin/TelegramOriginBoot.js';
import { createRoutes } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { telegramOriginForwardAwareness } from '../../src/messaging/telegram-origin/OriginAwareness.js';
import { HOLD_REASON_LEASE_NOT_HELD } from '../../src/messaging/telegram-origin/OriginForwardToHolder.js';
import { fixtureOriginContentDedup } from '../helpers/originContentDedup.js';
import { compileOriginWorker } from '../helpers/telegramOriginStore.js';

let worker: URL;
beforeAll(async () => { worker = await compileOriginWorker(); });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close(); }
  finally { vi.unstubAllGlobals(); }
}, 30_000);

describe('forward-to-holder lifecycle (production init path)', () => {
  it('a standby boot exposes durable held forwards on /telegram/origins/status and /health (200, never 503) and names lease-not-held', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'origin-forward-e2e-'));
    cleanup.push(async () => { await SafeFsExecutor.safeRm(root, { recursive: true, force: true, operation: 'test:origin-forward-e2e:cleanup' }); });
    const stateDir = path.join(root, '.instar'); await mkdir(path.join(stateDir, 'state'), { recursive: true });
    const config = { projectDir: root, stateDir, projectName: 'echo', port: 0, authToken: 'fixture-auth',
      messaging: [{ type: 'telegram', enabled: true, config: { token: '123:forward-fixture', chatId: '-100123', lifelineTopicId: 7848, messageOrigin: { forwardToHolder: { enabled: true } } } }] };
    await writeFile(path.join(stateDir, 'config.json'), JSON.stringify(config));
    // A STANDBY: it holds the bot token but not the serving lease.
    const holdsLease = vi.fn(() => false);
    const boot = await bootTelegramOrigin({ config: config as never, token: '123:forward-fixture', noticeOwner: true, workerUrl: worker,
      holdsLease, isSessionLive: () => true, diagnoseUnknown: vi.fn(async () => undefined), onNoticeState: vi.fn() });
    cleanup.push(() => boot.close());
    boot.runtime.attachSendPolicy({ review: async () => ({ ok: true }), authorizeDispatch: () => ({ ok: true }), ...fixtureOriginContentDedup(stateDir) });
    // Wiring integrity: the lease predicate reaches both the runtime (holder-side submit) and the service (hold reason).
    expect(boot.runtime.options.holdsLease).toBe(holdsLease);
    expect(boot.runtime.service.options.holdsLease).toBe(holdsLease);
    const app = express(); app.use(express.json());
    // The minimum route context `/health` reads (mirrors the other route fixtures).
    const routeCtx = { startTime: new Date(), sessionManager: { listRunningSessions: () => [], getCachedRunningSessions: () => ({ count: 0, sessions: [] }) },
      state: { getJobState: () => null, getSession: () => null }, scheduler: null, telegram: null };
    app.use(createRoutes({ ...routeCtx, config: config as never, telegramOrigin: boot.runtime, verifyDashboardOperatorSession: (proof: string | undefined) => proof === 'operator' } as never));
    const server = await new Promise<import('node:http').Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    cleanup.push(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const status = async () => { const r = await fetch(`${url}/telegram/origins/status`, { headers: { Authorization: 'Bearer fixture-auth', 'X-Instar-Operator-Session': 'operator' } }); return { status: r.status, body: await r.json() as { held: Array<Record<string, unknown>>; heldForward: Record<string, unknown> } }; };
    const health = async () => { const r = await fetch(`${url}/health`, { headers: { Authorization: 'Bearer fixture-auth' } }); return { status: r.status, body: await r.json() as { telegramOrigin?: { heldForward?: { count: number; topics: string[] } } } }; };
    // Alive before any hold: 200 with the new fields, not 503.
    const initial = await status();
    expect(initial.status).toBe(200);
    expect(initial.body.held).toEqual([]);
    expect(initial.body.heldForward).toMatchObject({ count: 0, topics: [] });
    const h0 = await health();
    expect(h0.status).toBe(200);
    expect(h0.body.telegramOrigin?.heldForward).toMatchObject({ count: 0, topics: [] });
    // A real send on the standby: the production `authorize` refuses because the lease is not held → lease-not-held, durably.
    await vi.waitFor(() => { boot.runtime.service.options.display({ accountId: '123', chatId: '-100123', topicId: '42' }); }, { timeout: 20_000, interval: 100 });
    const network = vi.fn();
    await expect(boot.runtime.service.runAsAutomation('telegram-server', () => boot.runtime.service.sendBot(
      { method: 'sendMessage', accountId: '123', params: { chat_id: '-100123', message_thread_id: 42, text: 'A reply from the standby.' } }, network)))
      .rejects.toMatchObject({ reason: HOLD_REASON_LEASE_NOT_HELD });
    expect(network).not.toHaveBeenCalled();
    await boot.runtime.refreshHeldForward({ force: true });
    const after = await status();
    expect(after.status).toBe(200);
    expect(after.body.held).toContainEqual(expect.objectContaining({ hold_reason: 'lease-not-held', durable: true, topicId: '42' }));
    expect(after.body.heldForward).toMatchObject({ count: 1, topics: ['42'] });
    expect((await health()).body.telegramOrigin?.heldForward).toMatchObject({ count: 1, topics: ['42'] });
    // The durable row survives a runtime restart on the same state dir.
    await boot.close(); cleanup.pop();
    const again = await bootTelegramOrigin({ config: config as never, token: '123:forward-fixture', noticeOwner: true, workerUrl: worker,
      holdsLease, isSessionLive: () => true, diagnoseUnknown: vi.fn(async () => undefined), onNoticeState: vi.fn() });
    cleanup.push(() => again.close());
    expect(await again.runtime.store.listHeldOperations({ holdReason: 'lease-not-held' })).toHaveLength(1);
  }, 60_000);
});

describe('migration parity (array-aware config + CLAUDE.md, idempotent)', () => {
  it('an existing agent gains forwardToHolder {enabled:true} and the awareness section exactly once', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-forward-migrate-'));
    cleanup.push(async () => { await SafeFsExecutor.safeRm(root, { recursive: true, force: true, operation: 'test:origin-forward-migrate:cleanup' }); });
    const stateDir = path.join(root, '.instar'); fs.mkdirSync(stateDir, { recursive: true });
    const configPath = path.join(stateDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ projectName: 'echo', port: 4042,
      messaging: [{ type: 'telegram', enabled: true, config: { token: 't', chatId: '-1', messageOrigin: { display: { enabled: true } } } }, { type: 'slack', config: {} }] }, null, 2));
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# CLAUDE.md — echo\n');
    const migrator = new PostUpdateMigrator({ port: 4042, stateDir, projectDir: root, hasTelegram: true, projectName: 'echo' } as never) as unknown as {
      migrateConfig(r: unknown): void; migrateClaudeMd(r: unknown): void };
    const result = () => ({ upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] });
    const first = result(); migrator.migrateConfig(first); migrator.migrateClaudeMd(first);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.messaging[0].config.messageOrigin.forwardToHolder).toEqual({ enabled: true });
    expect(config.messaging[1].config).toEqual({});
    expect(first.upgraded.some(line => line.includes('forward-to-holder'))).toBe(true);
    const claude = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
    expect(claude).toContain(telegramOriginForwardAwareness(4042));
    expect(claude.split('replies are forwarded to the holder').length).toBe(2);
    const second = result(); migrator.migrateConfig(second); migrator.migrateClaudeMd(second);
    expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).toBe(claude);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).messaging[0].config.messageOrigin.forwardToHolder).toEqual({ enabled: true });
    expect(second.upgraded.some(line => line.includes('forward-to-holder'))).toBe(false);
    // A fresh agent gets the same section from the template.
    expect(generateClaudeMd('echo', 'Echo', 4042, true)).toContain(telegramOriginForwardAwareness(4042));
  });
  it('an operator opt-out survives migration', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'origin-forward-optout-'));
    cleanup.push(async () => { await SafeFsExecutor.safeRm(root, { recursive: true, force: true, operation: 'test:origin-forward-optout:cleanup' }); });
    const stateDir = path.join(root, '.instar'); await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'echo', port: 4042,
      messaging: [{ type: 'telegram', enabled: true, config: { token: 't', chatId: '-1', messageOrigin: { forwardToHolder: { enabled: false } } } }] }));
    const migrator = new PostUpdateMigrator({ port: 4042, stateDir, projectDir: root, hasTelegram: true, projectName: 'echo' } as never) as unknown as { migrateConfig(r: unknown): void };
    migrator.migrateConfig({ upgraded: [], skipped: [], errors: [] });
    expect(JSON.parse(await readFile(path.join(stateDir, 'config.json'), 'utf8')).messaging[0].config.messageOrigin.forwardToHolder).toEqual({ enabled: false });
  });
});
