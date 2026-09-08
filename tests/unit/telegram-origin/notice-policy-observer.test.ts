import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { temporaryState, compileOriginConfigWorker } from '../../helpers/telegramOriginStore.js';
import { OriginConfigReader } from '../../../src/messaging/telegram-origin/OriginConfigReader.js';
import { migrateSecrets } from '../../../src/core/SecretMigrator.js';
import { SecretStore } from '../../../src/core/SecretStore.js';
import { OriginNoticePolicyObserver } from '../../../src/messaging/telegram-origin/OriginNoticePolicyObserver.js';

const destination = { accountId: '123', chatId: '-100123', topicId: '7848' };
let configWorker: URL;
beforeAll(async () => { configWorker = await compileOriginConfigWorker(); });
const readers: OriginConfigReader[] = [];
const observers: OriginNoticePolicyObserver[] = [];
afterEach(() => { for (const observer of observers.splice(0)) observer.close(); for (const reader of readers.splice(0)) reader.close(); });
async function harness(notice: unknown = undefined, vault = false) {
  const stateDir = temporaryState(); await mkdir(path.join(stateDir, 'state'), { recursive: true });
  const config = { messaging: [{ type: 'telegram', enabled: true,
    config: { token: '123:fixture', chatId: '-100123', messageOrigin: notice === undefined ? undefined : { outageNotice: notice } } }] };
  const save = () => writeFile(path.join(stateDir, 'config.json'), JSON.stringify(config));
  await save(); await writeFile(path.join(stateDir, 'state/agent-attention-topic.json'), '7848');
  if (vault) migrateSecrets(path.join(stateDir, 'config.json'), stateDir);
  const configReader = new OriginConfigReader(stateDir, configWorker); readers.push(configReader);
  let now = Date.now();
  const observer = await OriginNoticePolicyObserver.open({ stateDir, accountId: '123', token: '123:fixture', configReader, now: () => now }); observers.push(observer);
  return { observer, config, save, stateDir, advance: (ms: number) => { now += ms; } };
}
async function expectReady(h: Awaited<ReturnType<typeof harness>>) {
  // open() can return while a migration-triggered revision retry is still
  // pending. Await actual automatic observation, not a forced refresh. The
  // bound covers the independent five-second cadence and two-second read.
  await vi.waitFor(() => expect(h.observer.read(destination)).toMatchObject({
    authorized: true, optedOut: false, observerHealthy: true,
  }), { timeout: 8000 });
  return h.observer.read(destination)!;
}
describe('independent application outage-notice authority', () => {
  it('defaults on for exactly the configured hub and truthfully delegates private client preferences', async () => {
    const h = await harness(); const p = await expectReady(h);
    expect(p).toMatchObject({ authorized: true, optedOut: false, clientPreferences: 'telegram-managed', observerHealthy: true });
    for (const unobserved of ['muted', 'archived', 'deleted']) expect(p).not.toHaveProperty(unobserved);
    expect(h.observer.read({ ...destination, topicId: '42' })).toBeNull();
    expect(h.observer.read({ ...destination, accountId: '456' })).toBeNull();
    expect(h.observer.read({ ...destination, chatId: '-100999' })).toBeNull();
  });
  it('observes real encrypted secret placeholders and invalidates same-account credential rotation', async () => {
    const h = await harness(undefined, true);
    await expectReady(h);
    new SecretStore({ stateDir: h.stateDir, forceFileKey: true }).set('messaging.0.config.token', '123:rotated');
    await vi.waitFor(() => expect(h.observer.read(destination)).toBeNull(), { timeout: 8000 });
    await h.observer.refresh(); expect(h.observer.read(destination)).toBeNull();
  });
  it('bounds a stalled secret worker while leaving the event loop responsive', async () => {
    const h = await harness(undefined, true);
    await expectReady(h);
    const blocked = new OriginConfigReader(h.stateDir, new URL('data:text/javascript,import { parentPort } from "node:worker_threads"; parentPort.on("message", () => {});'));
    readers.push(blocked);
    let responsive = false;
    const timer = setTimeout(() => { responsive = true; }, 20);
    const start = Date.now();
    await expect(blocked.read()).rejects.toThrow(/origin-config-(reader-timeout|secret-source-unavailable)/);
    clearTimeout(timer); expect(responsive).toBe(true); expect(Date.now() - start).toBeLessThan(4000);
  });
  it('invalidates unreadable secret data rather than refreshing a stale merged credential', async () => {
    const h = await harness(undefined, true);
    await expectReady(h);
    await writeFile(path.join(h.stateDir, 'secrets/config.secrets.enc'), 'corrupt-fixture');
    await vi.waitFor(() => expect(h.observer.read(destination)).toBeNull(), { timeout: 8000 });
    await h.observer.refresh(); expect(h.observer.read(destination)).toBeNull();
  });
  it('treats omitted messaging enabled as unauthorized, matching the adapter startup authority', async () => {
    const h = await harness(); await expectReady(h);
    delete (h.config.messaging[0] as any).enabled; await h.save();
    await vi.waitFor(() => expect(h.observer.read(destination)?.authorized).toBe(false), { timeout: 8000 });
  });
  it('never renews a snapshot by reading it and expires at thirty seconds', async () => {
    const h = await harness(); const first = await expectReady(h);
    h.advance(29_999); expect(h.observer.read(destination)).toEqual(first);
    h.advance(1); expect(h.observer.read(destination)).toBeNull();
    await h.observer.refresh(); const next = h.observer.read(destination)!;
    expect(next.version).not.toBe(first.version); expect(next.observedAt).toBe(first.observedAt + 30_000);
    h.observer.close(); expect(h.observer.read(destination)).toBeNull();
  });
  it('observes explicit opt-out through independent automatic source refresh', async () => {
    const h = await harness({ enabled: true }); const first = await expectReady(h);
    h.config.messaging[0].config.messageOrigin = { outageNotice: { enabled: false } }; await h.save();
    await vi.waitFor(() => expect(h.observer.read(destination)?.optedOut).toBe(true), { timeout: 8000 });
    expect(h.observer.read(destination)!.version).not.toBe(first.version);
  });
  it.each([null, false, { enabled: 'yes' }])('rejects malformed permission %j instead of inferring opt-in', async notice => {
    const h = await harness(notice); expect(h.observer.read(destination)).toBeNull();
  });
  it('invalidates malformed source and changed credential account', async () => {
    const h = await harness();
    await expectReady(h);
    await writeFile(path.join(h.stateDir, 'config.json'), '{');
    await vi.waitFor(() => expect(h.observer.read(destination)).toBeNull(), { timeout: 8000 });
    h.config.messaging[0].config.token = '456:rotated'; await h.save(); await h.observer.refresh();
    expect(h.observer.read(destination)).toBeNull();
  });
  it('invalidates a rebound hub rather than allowing the old reservation destination', async () => {
    const h = await harness(); await expectReady(h);
    await writeFile(path.join(h.stateDir, 'state/agent-attention-topic.json'), '999');
    await vi.waitFor(() => expect(h.observer.read({ ...destination, topicId: '999' })).not.toBeNull(), { timeout: 8000 });
    expect(h.observer.read(destination)).toBeNull();
  });
});
