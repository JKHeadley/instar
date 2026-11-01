// safe-fs-allow: test file — writes only to its own tmp dir.
/**
 * E2E lifecycle — Codex device-limit tripwire, "the feature is alive"
 * (spec docs/specs/codex-device-limit-tripwire.md, "Testing: E2E"; docs/E2E-TESTING-STANDARD.md).
 *
 * WHAT THIS BOOTS, honestly: not a full AgentServer. A full boot would need tmux, a Telegram
 * adapter and the whole server graph to reach code that takes four plain objects. Instead this is
 * the closest production-path composition, the same convention as
 * tests/e2e/interactive-login-expired-lifecycle.test.ts:
 *   1. WIRED: a source check that server.ts composes the tripwire through the shared
 *      `buildCodexDeviceLimitWiring`, installs it for the routes, and hands its hooks to the session
 *      monitor, the attention resolver and the sign-in repair runtime.
 *   2. ALIVE: the production component set — a REAL SubscriptionPool and SubscriptionLoginLedger on
 *      disk, the REAL QuotaPoller, `buildCodexDeviceLimitWiring` itself, a REAL sign-in repair runtime
 *      wired the way server.ts wires it (endRepairs + deviceLimitHold + judgeDeviceLimitPage +
 *      onDeviceLimitStopped), the REAL admission policy, and the REAL HTTP routes — driven by a fake
 *      `codex` app-server reader (account A's `account/rateLimits/read` refused with a device-limit
 *      message, account B clean) and a fake Jev endpoint (global fetch; the wiring has no fetchImpl).
 *
 * Time: the tripwire's own 5-minute confirmation timers are the real ones, driven with fake
 * setTimeout; the decision clock is the injected `now`. HTTP reads run on real timers.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { SubscriptionLoginLedger } from '../../src/core/SubscriptionLoginLedger.js';
import { QuotaPoller } from '../../src/core/QuotaPoller.js';
import {
  buildCodexDeviceLimitWiring, installCodexDeviceLimitWiring, deviceLimitConditionKey, DEVICE_LIMIT_ATTENTION_CATEGORY,
} from '../../src/core/codexDeviceLimitWiring.js';
import { createSubscriptionReloginRuntime, subscriptionReloginRouteContext } from '../../src/core/SubscriptionReloginRuntime.js';
import { evaluateSubscriptionReloginAdmission } from '../../src/core/SubscriptionReloginPolicy.js';
import { PlaywrightSeatLease } from '../../src/core/PlaywrightSeatLease.js';
import type { EnrollmentWizard } from '../../src/core/EnrollmentWizard.js';
import type { IdentityOracle } from '../../src/core/CredentialLocationLedger.js';
import type { PlaywrightProfileRegistry } from '../../src/core/PlaywrightProfileRegistry.js';
import type { ClaudePasteBackController } from '../../src/core/ClaudePasteBackController.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const SERVER = fs.readFileSync(path.join(__dirname, '../../src/commands/server.ts'), 'utf8');
const MACHINE = 'm-e2e';
const TOKEN = 'device-limit-e2e-token';
const FIVE_MIN = 5 * 60_000;
const DEVICE_LIMIT_REFUSAL = JSON.stringify({ code: -32001, message: 'You have reached the maximum number of devices for paid ChatGPT accounts on this device. Sign out of another account to continue.' });
const SIGNED_OUT_REFUSAL = JSON.stringify({ code: -32001, message: 'Authentication required: your session has expired. Run `codex login`.' });

type JevLabel = 'device_limit' | 'signed_out';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  installCodexDeviceLimitWiring(null);
  for (const c of cleanups.splice(0).reverse()) { try { await c(); } catch { /* @silent-fallback-ok: best-effort teardown */ } }
});

async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r));
}

function boot(opts: { jev: JevLabel; refusal: string }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-e2e-'));
  cleanups.push(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/codex-device-limit-lifecycle.test.ts:cleanup' }));
  const logsDir = path.join(dir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const homeA = path.join(dir, '.codex-plus-a');
  const homeB = path.join(dir, '.codex-plus-b');
  const pool = new SubscriptionPool({ stateDir: dir });
  pool.addFixture({ id: 'codex-plus-a', nickname: 'Plus A', email: 'plus-a@example.test', provider: 'openai', framework: 'codex-cli', configHome: homeA });
  pool.addFixture({ id: 'codex-plus-b', nickname: 'Plus B', email: 'plus-b@example.test', provider: 'openai', framework: 'codex-cli', configHome: homeB });
  const ledger = new SubscriptionLoginLedger({ stateDir: dir, machineId: MACHINE, writeEnabled: true });
  cleanups.push(() => ledger.close());

  const clock = { t: Date.parse('2026-10-31T13:31:00.000Z') };
  const now = () => clock.t;
  // The fake `codex app-server`: A's account/rateLimits/read is refused while `aRefusing`.
  const state = { aRefusing: true };
  const readsByHome = new Map<string, number>();
  const reader = async (o?: { codexHome?: string }) => {
    const home = o?.codexHome ?? '';
    readsByHome.set(home, (readsByHome.get(home) ?? 0) + 1);
    if (home === homeA && state.aRefusing) return { kind: 'auth-failed' as const, refusal: { stage: 'read' as const, text: opts.refusal } };
    return { kind: 'ok' as const, snapshot: {
      source: 'codex-app-server' as const, rolloutPath: '', threadId: null, capturedAt: new Date(clock.t).toISOString(),
      model: null, planType: 'plus', rateLimitReachedType: null,
      primary: { usedPercent: 12, windowMinutes: 300, resetsAtIso: new Date(clock.t + 3 * 3_600_000).toISOString() }, secondary: null,
    } };
  };
  const poller = new QuotaPoller({ pool, now, codexLiveUsageReaderDetailed: reader as never, codexUsageReader: async () => null });

  // The fake Jev (TypeSafe) endpoint: high confidence for the configured label.
  let jevCalls = 0;
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    if (!String(url).startsWith('https://api.typesafe.ai/')) return realFetch(url as string, init);
    jevCalls++;
    return { ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', usage: { input_tokens: 50 },
      answers: { lockout: { choice: opts.jev, probabilities: { [opts.jev]: 0.97 } } } }) };
  }));

  // The attention sink, as the Telegram adapter would hold it: one row per condition key.
  const raised: Array<Record<string, unknown>> = [];
  const cleared: Array<{ conditionKey: string; resolution: string }> = [];
  const attention = new Map<string, Record<string, unknown>>();

  let runtimeRef: ReturnType<typeof createSubscriptionReloginRuntime> | null = null;
  const wiring = buildCodexDeviceLimitWiring({
    pool, ledger, quotaPoller: poller, machineId: MACHINE, stateDir: dir, logsDir,
    config: () => ({ enabled: true, ignoreAccounts: [] }),
    judgeConfig: () => undefined,
    readKey: () => 'typesafe-e2e-key',
    referee: null,
    listSessions: () => [],
    swap: async () => ({ swapped: false, reason: 'no-sessions' }),
    endRepairs: (accountId) => runtimeRef?.endForDeviceLimit(accountId),
    raiseNotice: (n) => { raised.push({ ...n }); attention.set(n.conditionKey, { ...n }); },
    clearNotice: (conditionKey, resolution) => { cleared.push({ conditionKey, resolution }); attention.delete(conditionKey); },
    now,
  });
  installCodexDeviceLimitWiring(wiring);

  // The sign-in repair runtime, built after the poller and wired to the tripwire as server.ts does.
  const runtime = createSubscriptionReloginRuntime({ stateDir: dir, projectDir: dir, machineId: MACHINE,
    seatLease: new PlaywrightSeatLease({ filePath: path.join(dir, 'seat-lease.json') }),
    mode: 'unattended', pool, ledger,
    enrollment: { getById: () => null, start: vi.fn(), refresh: vi.fn() } as unknown as EnrollmentWizard,
    profiles: { resolve: () => ({ profile: null }), listProfiles: () => [] } as unknown as PlaywrightProfileRegistry,
    quotaPoller: poller,
    identityOracle: { resolveSlotTenant: vi.fn() } as unknown as IdentityOracle,
    pasteBack: { finish: vi.fn() } as unknown as ClaudePasteBackController,
    createBrowser: () => { throw new Error('a benched account must never open a sign-in browser'); },
    resolveSecret: async () => null, supervise: async ({ allowedActions }) => allowedActions[0],
    deviceLimitHold: wiring.deviceLimitHold,
    judgeDeviceLimitPage: wiring.judgeDeviceLimitPage,
    onDeviceLimitStopped: wiring.onDeviceLimitStopped,
  });
  runtimeRef = runtime;
  cleanups.push(() => runtime.close());

  const servers: http.Server[] = [];
  cleanups.push(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))).then(() => undefined));
  const http = async (p: string) => {
    if (servers.length === 0) {
      const app = express();
      app.use(express.json());
      app.use(createRoutes({
        config: { authToken: TOKEN, stateDir: dir, port: 0, dashboardPin: '123456' }, startTime: new Date(),
        subscriptionPool: pool, subscriptionLoginLedger: ledger, quotaPoller: poller,
        subscriptionIdentityOracle: { resolveSlotTenant: async () => ({ email: 'x@example.test' }) },
        subscriptionEmailBarrier: { isBlocking: () => false },
        subscriptionRelogin: subscriptionReloginRouteContext(runtime),
      } as never));
      const srv = app.listen(0);
      servers.push(srv);
      await new Promise((r) => srv.once('listening', r));
    }
    const port = (servers[0].address() as AddressInfo).port;
    // The routes are read on real timers; the fake-timer phases resume afterwards.
    vi.useRealTimers();
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    return { status: r.status, body: await r.json() as any };
  };

  return { dir, pool, ledger, poller, wiring, runtime, clock, state, readsByHome, homeA, homeB,
    jevCalls: () => jevCalls, raised, cleared, attention, http };
}

describe('Codex device-limit tripwire — production wiring', () => {
  it('server.ts composes the tripwire through the shared wiring and hands its hooks to every consumer', () => {
    expect(SERVER).toMatch(/codexDeviceLimit = buildCodexDeviceLimitWiring\(\{\s*pool: subscriptionPool,\s*ledger: subscriptionLoginLedger \?\? null,\s*quotaPoller,/);
    expect(SERVER).toContain('installCodexDeviceLimitWiring(codexDeviceLimit)');
    expect(SERVER).toMatch(/endRepairs: \(accountId\) => subscriptionReloginRuntimeRef\?\.endForDeviceLimit\(accountId\)/);
    expect(SERVER).toMatch(/return _quotaAwareScheduler\.onQuotaPressure\(args\)/);
    expect(SERVER).toContain('sessionManager.setCodexSigninTriggerSink((input) => dl.onSessionSigninSighting(input))');
    expect(SERVER).toContain("registerAttentionConditionResolver('subscription-device-limit', (item) => dl.resolveNotice(item))");
    expect(SERVER).toContain('deviceLimitHold: codexDeviceLimit.deviceLimitHold');
    expect(SERVER).toContain('judgeDeviceLimitPage: codexDeviceLimit.judgeDeviceLimitPage');
    expect(SERVER).toContain('onDeviceLimitStopped: codexDeviceLimit.onDeviceLimitStopped');
    expect(SERVER).toContain("'subscriptionPool.codexDeviceLimit'");
    expect(SERVER).toContain('resolveDevAgentGate(typeof raw?.enabled');
  });
});

describe('Codex device-limit tripwire — alive (suspect → bench → notice → refuse repair → release)', () => {
  it('a Jev-judged device-limit refusal benches A on this machine after the 5-minute confirmation, and two clean reads restore it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const s = boot({ jev: 'device_limit', refusal: DEVICE_LIMIT_REFUSAL });
    const key = deviceLimitConditionKey(MACHINE);

    // ── t0: B reads clean (the machine floor); A's first refusal is judged → suspected only. ──
    expect(await s.poller.requestCodexCheck('codex-plus-b')).toBe(true);
    expect(await s.poller.requestCodexCheck('codex-plus-a')).toBe(false);
    await settle();
    expect(s.jevCalls()).toBe(1);
    let a = s.pool.get('codex-plus-a')!;
    expect(a.deviceLimitSuspectedAt).toBe(new Date(s.clock.t).toISOString());
    expect(a.status).toBe('active');
    expect(a.statusCause).toBeUndefined();
    expect(s.raised).toHaveLength(0);
    expect(s.wiring.deviceLimitHold('codex-plus-a')).toBe(true); // slow retries held while suspected

    // ── t0+5m: the tripwire's own confirmation read; A refused again and freshly judged → benched. ──
    s.clock.t += FIVE_MIN;
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    await settle();
    expect(s.readsByHome.get(s.homeA)).toBe(2);
    expect(s.jevCalls()).toBe(2);
    a = s.pool.get('codex-plus-a')!;
    expect(a.status).toBe('needs-reauth');
    expect(a.statusCause).toBe('codex-device-limit');
    expect(a.deviceLimitSince).toBe(new Date(s.clock.t).toISOString());
    expect(s.pool.get('codex-plus-b')!.status).toBe('active');
    // Persisted: a fresh reader of the pool file sees the bench.
    expect(new SubscriptionPool({ stateDir: s.dir }).get('codex-plus-a')!.statusCause).toBe('codex-device-limit');

    // Exactly one notice for this machine.
    expect(s.raised).toHaveLength(1);
    expect(s.raised[0]).toMatchObject({ conditionKey: key, category: DEVICE_LIMIT_ATTENTION_CATEGORY, machineId: MACHINE, priority: 'normal' });
    expect([...s.attention.keys()]).toEqual([key]);
    expect(s.wiring.resolveNotice({ category: DEVICE_LIMIT_ATTENTION_CATEGORY, conditionKey: key })).toBe('active');

    // The ledger carries the bench as an open episode with the device-limit cause.
    const openEpisodes = s.ledger.listEpisodes({ accountId: 'codex-plus-a' }).filter((e) => e.closedAt === null);
    expect(openEpisodes.map((e) => e.causeClass)).toEqual(['codex-device-limit']);

    // Repair admission refuses A — the real policy on the real pool record, both sides of the boundary.
    const admissionInput = (statusCause: string | null) => ({
      configuredMode: 'unattended' as const, poolAuthority: 'ready' as const,
      account: { id: a.id, machineId: MACHINE, status: a.status, framework: a.framework, provider: a.provider, identityHash: 'h', statusCause },
      sourceEpisode: { ...openEpisodes[0], causeClass: 'exchange-failed' as never },
      hasLiveRepair: false, hasLivePendingLogin: false, profile: null, breakerOpen: false,
    });
    expect(evaluateSubscriptionReloginAdmission(admissionInput(a.statusCause ?? null) as never)).toEqual({ admitted: false, reason: 'device-limit-benched' });
    const notBenched = evaluateSubscriptionReloginAdmission(admissionInput(null) as never);
    expect(notBenched.admitted === false && notBenched.reason).not.toBe('device-limit-benched');
    // …and the runtime admits no repair episode, and says why.
    await s.runtime.service.tick();
    expect(s.runtime.store.list()).toEqual([]);
    expect(await s.runtime.blockers()).toEqual([
      { accountId: 'codex-plus-a', machineId: MACHINE, framework: 'codex-cli', reason: 'device-limit-benched' },
    ]);

    // Alive over HTTP: 200 (never 503), the cause on the row, the machine block, the blocker.
    const pool = await s.http('/subscription-pool');
    expect(pool.status).toBe(200);
    expect(pool.body.accounts.find((x: any) => x.id === 'codex-plus-a').statusCause).toBe('codex-device-limit');
    expect(pool.body.accounts.find((x: any) => x.id === 'codex-plus-b').statusCause).toBeNull();
    expect(pool.body.deviceLimit).toMatchObject({ enabled: true, benchedNow: 1, totals: expect.objectContaining({ benched: 1 }) });
    const relogin = await s.http('/subscription-relogin');
    expect(relogin.status).toBe(200);
    expect(relogin.body.episodes).toEqual([]);
    expect(relogin.body.blockers.map((b: any) => b.reason)).toEqual(['device-limit-benched']);

    // ── Release: the provider stops refusing. One clean read is not enough; the second releases. ──
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    s.state.aRefusing = false;
    s.clock.t += 60 * 60_000 + 1_000; // past the 1 h benched-read backoff
    await s.poller.pollAll(); // the scheduled read of A runs (backoff elapsed) and reads clean
    await settle();
    expect(s.pool.get('codex-plus-a')!.statusCause).toBe('codex-device-limit'); // still benched after one clean read
    expect(s.cleared).toHaveLength(0);
    s.clock.t += FIVE_MIN;
    await vi.advanceTimersByTimeAsync(FIVE_MIN); // the tripwire's own release-confirmation read
    await settle();
    a = s.pool.get('codex-plus-a')!;
    expect(a.status).toBe('active');
    expect(a.statusCause).toBeUndefined();
    expect(a.deviceLimitSince).toBeUndefined();
    // The notice is cleared and the resolver agrees; every raise was the same single row.
    expect(s.cleared).toEqual([expect.objectContaining({ conditionKey: key })]);
    expect(s.attention.size).toBe(0);
    expect(new Set(s.raised.map((r) => r.conditionKey))).toEqual(new Set([key]));
    expect(s.wiring.resolveNotice({ category: DEVICE_LIMIT_ATTENTION_CATEGORY, conditionKey: key })).toBe('cleared');
    // The ledger episode is closed by the release.
    expect(s.ledger.listEpisodes({ accountId: 'codex-plus-a' }).filter((e) => e.closedAt === null)).toEqual([]);
    expect(s.wiring.status()).toMatchObject({ benchedNow: 0, totals: expect.objectContaining({ benched: 1, released: 1 }) });
    // Over HTTP too.
    const after = await s.http('/subscription-pool');
    expect(after.body.accounts.find((x: any) => x.id === 'codex-plus-a').statusCause).toBeNull();
    expect((await s.http('/subscription-relogin')).body.blockers).toEqual([]);
  });

  it('a refusal Jev labels signed_out takes today\'s path: no suspicion, no confirmation read, no bench, no notice', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const s = boot({ jev: 'signed_out', refusal: SIGNED_OUT_REFUSAL });
    expect(await s.poller.requestCodexCheck('codex-plus-b')).toBe(true);
    expect(await s.poller.requestCodexCheck('codex-plus-a')).toBe(false);
    await settle();
    expect(s.jevCalls()).toBe(1);
    expect(s.pool.get('codex-plus-a')!.deviceLimitSuspectedAt).toBeUndefined();
    expect(s.wiring.deviceLimitHold('codex-plus-a')).toBe(false);

    s.clock.t += FIVE_MIN;
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    await settle();
    expect(s.readsByHome.get(s.homeA)).toBe(1); // no confirmation read was scheduled
    const a = s.pool.get('codex-plus-a')!;
    expect(a.status).toBe('active');
    expect(a.statusCause).toBeUndefined();
    expect(s.raised).toHaveLength(0);
    expect(s.wiring.status()).toMatchObject({ suspectedNow: 0, benchedNow: 0,
      judge: expect.objectContaining({ verdicts: expect.objectContaining({ not_device_limit: 1, device_limit: 0 }) }) });
    const pool = await s.http('/subscription-pool');
    expect(pool.status).toBe(200);
    expect(pool.body.accounts.every((x: any) => x.statusCause === null)).toBe(true);
  });
});
