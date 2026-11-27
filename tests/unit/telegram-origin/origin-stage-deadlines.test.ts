/**
 * The recording stages' time budgets are settable (OriginServiceOptions.stageDeadlines).
 *
 * Why: the budgets were literals (250 ms store, 500 ms spool, 1000 ms admission). They are real
 * waits on disk commits, and on a saturated disk a healthy commit outlasts them: the send is
 * held as `all-durable-recording-sinks-unavailable` or `execution-admission-unavailable` with
 * nothing broken. End-to-end tests that run beside a full suite failed unrelated changes that
 * way (2026-11-12/13). Defaults are unchanged; these tests pin both sides of each budget.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { OriginStore } from '../../../src/messaging/telegram-origin/OriginStore.js';
import { OriginSessionRegistry } from '../../../src/messaging/telegram-origin/OriginSessionRegistry.js';
import { RuntimeOriginObserver } from '../../../src/messaging/telegram-origin/RuntimeOriginObserver.js';
import {
  ORIGIN_STAGE_DEADLINE_MAX_MS, ORIGIN_STAGE_DEADLINES_MS, TelegramOriginService, type OriginStageDeadlines,
} from '../../../src/messaging/telegram-origin/TelegramOriginService.js';
import { resolveOriginStageDeadline, setOriginStageDeadlineProcessDefaults } from '../../../src/messaging/telegram-origin/OriginStageDeadlines.js';
import { compileOriginWorker, temporaryState, SLOW_DISK_STORE_REQUEST_TIMEOUT_MS } from '../../helpers/telegramOriginStore.js';
import { fixtureOriginContentDedup } from '../../helpers/originContentDedup.js';

const key = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
let worker: URL;
const stores: OriginStore[] = [];
beforeAll(async () => { worker = await compileOriginWorker(); });
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(stores.splice(0).map(s => s.close())); });

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const GENEROUS = 20_000;
const ALL_GENEROUS: OriginStageDeadlines = { storeEvidenceMs: GENEROUS, spoolEvidenceMs: GENEROUS, peerEvidenceMs: GENEROUS, verifiedEvidenceMs: GENEROUS, admitMs: GENEROUS };
/**
 * Every stage generous except the one under test, which keeps its production default. Each
 * test measures one budget; the others must not be able to trip on a loaded machine, or this
 * file would flake in the very way it exists to prevent.
 */
const defaultOnlyFor = (stage: keyof OriginStageDeadlines): Partial<OriginStageDeadlines> => {
  const rest: Partial<OriginStageDeadlines> = { ...ALL_GENEROUS }; delete rest[stage]; return rest;
};
// The suite's setup file lifts this process's default budgets for every test file. This file
// is about the production budgets themselves, so it puts them back for its own run.
beforeEach(() => { setOriginStageDeadlineProcessDefaults(null); });

async function harness(stageDeadlines?: Partial<OriginStageDeadlines>) {
  const stateDir = temporaryState();
  // The store's own request deadline is lifted too: otherwise a commit slower than 2 s on a
  // loaded machine rejects underneath a generous stage budget, and these tests would flake.
  const store = await OriginStore.open({ stateDir, agentId: 'echo', requestTimeoutMs: SLOW_DISK_STORE_REQUEST_TIMEOUT_MS }, worker); stores.push(store);
  const sessions = new OriginSessionRegistry({ stateDir, agentId: 'echo', machineId: 'studio', isSessionLive: () => true });
  await sessions.initialize();
  const spoolEvidence = vi.fn(async (): Promise<unknown> => { throw new Error('spool unavailable'); });
  const service = new TelegramOriginService({ store, sessions, observer: new RuntimeOriginObserver(),
    sendPolicy: { review: async () => ({ ok: true }), authorizeDispatch: () => ({ ok: true }), ...fixtureOriginContentDedup(stateDir) },
    identity: { agentId: 'echo', agentName: 'Echo', originMachineId: 'studio', originMachineName: 'Mac Studio' },
    signingKey: { privateKey: key, keyEpoch: 1, keyId: 'studio-1' }, ownerBootId: 'boot-1',
    display: () => ({ agent: { enabled: true } }), authorize: async () => true, onHold: vi.fn(), spoolEvidence,
    reviewLegacyRecovery: async () => true, ...(stageDeadlines ? { stageDeadlines } : {}) });
  const input = { method: 'sendMessage', accountId: 'bot-1', params: { chat_id: '-100123', message_thread_id: 42, text: 'Original answer' } };
  const network = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {
    message_id: 7, chat: { id: -100123 }, message_thread_id: 42,
  } }), { status: 200 }));
  const send = () => service.runAsAutomation('telegram-server', () => service.sendBot(input, network));
  /** Make a store method take `ms` longer and then do its real work. */
  const slow = (method: 'putEvidence' | 'admit', ms: number) => {
    const real = (store[method] as (...args: unknown[]) => Promise<unknown>).bind(store);
    return vi.spyOn(store, method as never).mockImplementation((async (...args: unknown[]) => { await sleep(ms); return real(...args); }) as never);
  };
  return { store, service, network, send, spoolEvidence, slow };
}

describe('defaults', () => {
  it('are the budgets the service always had', () => {
    expect(ORIGIN_STAGE_DEADLINES_MS).toEqual({ storeEvidenceMs: 250, spoolEvidenceMs: 500, peerEvidenceMs: 1250, verifiedEvidenceMs: 1000, admitMs: 1000 });
    expect(Object.isFrozen(ORIGIN_STAGE_DEADLINES_MS)).toBe(true);
  });
});

describe('evidence into the store (default 250 ms)', () => {
  it('default: a commit slower than the budget falls to the spool, and with the spool down the send is held', async () => {
    const h = await harness(defaultOnlyFor('storeEvidenceMs'));
    h.slow('putEvidence', 600);
    await expect(h.send()).rejects.toMatchObject({ reason: 'all-durable-recording-sinks-unavailable', outcome: 'held' });
    expect(h.spoolEvidence).toHaveBeenCalledOnce();
    expect(h.network).not.toHaveBeenCalled();
  });

  it('with a generous budget the same slow commit is simply waited for, and the send goes out', async () => {
    const h = await harness(ALL_GENEROUS);
    h.slow('putEvidence', 600);
    await h.send();
    expect(h.spoolEvidence).not.toHaveBeenCalled();
    expect(h.network).toHaveBeenCalledOnce();
  });

  it('a budget set on service.options after construction takes effect', async () => {
    const h = await harness();
    h.service.options.stageDeadlines = { ...ALL_GENEROUS };
    h.slow('putEvidence', 600);
    await h.send();
    expect(h.network).toHaveBeenCalledOnce();
  });
});

describe('evidence into the spool (default 500 ms)', () => {
  const brokenStoreSlowSpool = async (stageDeadlines?: Partial<OriginStageDeadlines>) => {
    const h = await harness(stageDeadlines);
    vi.spyOn(h.store, 'putEvidence').mockRejectedValue(new Error('database unavailable'));
    h.spoolEvidence.mockImplementation(async () => { await sleep(1000); return undefined; });
    return h;
  };
  it('default: a spool write slower than the budget holds the send', async () => {
    const h = await brokenStoreSlowSpool(defaultOnlyFor('spoolEvidenceMs'));
    await expect(h.send()).rejects.toMatchObject({ reason: 'all-durable-recording-sinks-unavailable' });
    expect(h.network).not.toHaveBeenCalled();
  });
  it('with a generous budget the slow spool write is waited for and counts as recorded', async () => {
    const h = await brokenStoreSlowSpool(ALL_GENEROUS);
    // Only the store's evidence write is broken in this fixture; with the spool copy recorded,
    // admission goes through the store as usual and the send completes.
    await h.send();
    expect(h.spoolEvidence).toHaveBeenCalledOnce();
    expect(h.network).toHaveBeenCalledOnce();
  });
});

describe('admission (default 1000 ms)', () => {
  it('default: an admission slower than the budget holds the send', async () => {
    const h = await harness(defaultOnlyFor('admitMs'));
    h.slow('admit', 1600);
    await expect(h.send()).rejects.toMatchObject({ reason: 'execution-admission-unavailable', outcome: 'held' });
    expect(h.network).not.toHaveBeenCalled();
  });
  it('with a generous budget the slow admission is waited for and the send goes out', async () => {
    const h = await harness(ALL_GENEROUS);
    h.slow('admit', 1600);
    await h.send();
    expect(h.network).toHaveBeenCalledOnce();
  });
});

describe('a bad value never widens or removes a budget', () => {
  it.each([
    ['zero', 0], ['negative', -5], ['not a number', Number.NaN], ['infinite', Number.POSITIVE_INFINITY],
    ['fractional', 5000.5], ['over the maximum', ORIGIN_STAGE_DEADLINE_MAX_MS + 1], ['a string', '20000' as unknown as number],
    ['null', null as unknown as number],
  ])('%s falls back to the default', async (_name, value) => {
    const h = await harness({ ...ALL_GENEROUS, storeEvidenceMs: value });
    h.slow('putEvidence', 600);
    // Default 250 ms applies: the slow commit is abandoned for the (failing) spool, and the send is held.
    await expect(h.send()).rejects.toMatchObject({ reason: 'all-durable-recording-sinks-unavailable' });
    expect(h.spoolEvidence).toHaveBeenCalledOnce();
  });

  it('the maximum itself is accepted', async () => {
    const h = await harness({ ...ALL_GENEROUS, storeEvidenceMs: ORIGIN_STAGE_DEADLINE_MAX_MS });
    h.slow('putEvidence', 600);
    await h.send();
    expect(h.network).toHaveBeenCalledOnce();
  });

  it('the minimum of 1 ms is accepted: a budget can be shortened as well as lengthened', async () => {
    const h = await harness({ ...ALL_GENEROUS, storeEvidenceMs: 1 });
    // 100 ms is well inside the default 250 ms, so with the default this send would go out.
    // With a 1 ms budget the store is abandoned for the (failing) spool and the send is held.
    h.slow('putEvidence', 100);
    await expect(h.send()).rejects.toMatchObject({ reason: 'all-durable-recording-sinks-unavailable' });
    expect(h.spoolEvidence).toHaveBeenCalledOnce();
  });
});

describe('process-wide defaults (what the suite setup file uses)', () => {
  it('a process default applies to a service that sets no budget of its own', async () => {
    setOriginStageDeadlineProcessDefaults({ ...ALL_GENEROUS });
    const h = await harness();
    h.slow('putEvidence', 600);
    await h.send();
    expect(h.spoolEvidence).not.toHaveBeenCalled();
    expect(h.network).toHaveBeenCalledOnce();
  });

  it("a service's own budget wins over the process default", async () => {
    setOriginStageDeadlineProcessDefaults({ ...ALL_GENEROUS });
    const h = await harness({ storeEvidenceMs: ORIGIN_STAGE_DEADLINES_MS.storeEvidenceMs });
    h.slow('putEvidence', 600);
    await expect(h.send()).rejects.toMatchObject({ reason: 'all-durable-recording-sinks-unavailable' });
  });

  it('null restores the production budgets, and invalid fields are ignored stage by stage', () => {
    setOriginStageDeadlineProcessDefaults({ storeEvidenceMs: 5000, spoolEvidenceMs: 0, admitMs: ORIGIN_STAGE_DEADLINE_MAX_MS + 1,
      peerEvidenceMs: Number.NaN, verifiedEvidenceMs: '9000' as unknown as number });
    expect(resolveOriginStageDeadline('storeEvidenceMs')).toBe(5000);
    expect(resolveOriginStageDeadline('spoolEvidenceMs')).toBe(500);
    expect(resolveOriginStageDeadline('admitMs')).toBe(1000);
    expect(resolveOriginStageDeadline('peerEvidenceMs')).toBe(1250);
    expect(resolveOriginStageDeadline('verifiedEvidenceMs')).toBe(1000);
    setOriginStageDeadlineProcessDefaults(null);
    expect(resolveOriginStageDeadline('storeEvidenceMs')).toBe(250);
  });

  it('nothing under src/ calls the process-default setter: production keeps its budgets', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx|js|mjs)$/.test(entry.name) || full.endsWith(path.join('telegram-origin', 'OriginStageDeadlines.ts'))) continue;
        if (fs.readFileSync(full, 'utf8').includes('setOriginStageDeadlineProcessDefaults')) offenders.push(path.relative(process.cwd(), full));
      }
    };
    walk(path.resolve('src'));
    expect(offenders).toEqual([]);
  });

  it('the budgets module imports nothing: the suite setup file loads it before any vi.mock applies', () => {
    // tests/vitest-setup.ts imports this module in every test file. An import here would be
    // cached ahead of that file's vi.mock calls (the incident recorded in
    // scripts/lint-no-direct-destructive.js: a src import in the setup file cached
    // node:child_process and turned three suites red).
    const source = fs.readFileSync(path.resolve('src/messaging/telegram-origin/OriginStageDeadlines.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bimport\b|\brequire\s*\(/);
  });
});
