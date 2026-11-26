/**
 * Wiring integrity — the production composition of the Codex device-limit tripwire
 * (spec docs/specs/codex-device-limit-tripwire.md, "Testing: Wiring integrity").
 *
 * `buildCodexDeviceLimitWiring` is the exact function server.ts calls, so this drives it with the
 * REAL SubscriptionPool (temp dir), the REAL SubscriptionLoginLedger, and the REAL QuotaPoller;
 * only the outside world is faked: the Codex app-server read (`codexLiveUsageReaderDetailed`), the
 * TypeSafe (Jev) HTTP endpoint (global fetch: the wiring does not plumb a fetchImpl into the judge),
 * and the side-effect sinks (swap / endRepairs / raiseNotice / clearNotice) as spies.
 *
 * It proves the deps are not null and not no-ops: a refusal read on the poller reaches the judge,
 * and a bench reaches endRepairs, swap and raiseNotice. The tripwire's 5-minute confirmation timer
 * is the real one, driven with fake setTimeout; the decision clock is the injected `now`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { SubscriptionLoginLedger } from '../../src/core/SubscriptionLoginLedger.js';
import { QuotaPoller } from '../../src/core/QuotaPoller.js';
import {
  buildCodexDeviceLimitWiring, deviceLimitConditionKey, DEVICE_LIMIT_ATTENTION_CATEGORY,
  type CodexDeviceLimitWiring,
} from '../../src/core/codexDeviceLimitWiring.js';
import type { DeviceLimitMoverSession } from '../../src/core/DeviceLimitSessionMover.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const MACHINE = 'm-wiring-test';
const REFUSAL = 'Device limit reached: this device has reached the maximum number of ChatGPT Plus accounts that can be signed in.';
const FIVE_MIN = 5 * 60_000;

type JevLabel = 'device_limit' | 'signed_out' | 'other' | 'cannot_tell';

interface Harness {
  dir: string;
  pool: SubscriptionPool;
  ledger: SubscriptionLoginLedger | null;
  poller: QuotaPoller;
  wiring: CodexDeviceLimitWiring;
  clock: { t: number };
  cfg: { enabled: boolean; ignoreAccounts: string[] };
  refusing: Set<string>;
  homeA: string;
  homeB: string;
  reader: ReturnType<typeof vi.fn>;
  jevCalls: Array<{ url: string; body: Record<string, unknown> }>;
  setJev: (label: JevLabel) => void;
  sessions: DeviceLimitMoverSession[];
  swap: ReturnType<typeof vi.fn>;
  endRepairs: ReturnType<typeof vi.fn>;
  raiseNotice: ReturnType<typeof vi.fn>;
  clearNotice: ReturnType<typeof vi.fn>;
  reportDegradation: ReturnType<typeof vi.fn>;
}

const dirs: string[] = [];
const ledgers: SubscriptionLoginLedger[] = [];

function okSnapshot(atMs: number) {
  return {
    source: 'codex-app-server' as const, rolloutPath: '', threadId: null,
    capturedAt: new Date(atMs).toISOString(), model: null, planType: 'plus', rateLimitReachedType: null,
    primary: { usedPercent: 10, windowMinutes: 300, resetsAtIso: new Date(atMs + 3 * 3_600_000).toISOString() },
    secondary: null,
  };
}

function build(opts: { withLedger?: boolean } = {}): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-wiring-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  const logsDir = path.join(dir, 'logs');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  const homeA = path.join(dir, '.codex-a');
  const homeB = path.join(dir, '.codex-b');
  const pool = new SubscriptionPool({ stateDir });
  pool.addFixture({ id: 'codex-a', nickname: 'Plus A', email: 'a@example.test', provider: 'openai', framework: 'codex-cli', configHome: homeA });
  pool.addFixture({ id: 'codex-b', nickname: 'Plus B', email: 'b@example.test', provider: 'openai', framework: 'codex-cli', configHome: homeB });
  const ledger = opts.withLedger === false ? null : new SubscriptionLoginLedger({ stateDir, machineId: MACHINE, writeEnabled: true });
  if (ledger) ledgers.push(ledger);
  const clock = { t: Date.parse('2026-10-31T12:00:00.000Z') };
  const now = () => clock.t;
  const refusing = new Set<string>();
  const reader = vi.fn(async (o?: { codexHome?: string }) => (o?.codexHome && refusing.has(o.codexHome)
    ? { kind: 'auth-failed' as const, refusal: { stage: 'read' as const, text: REFUSAL } }
    : { kind: 'ok' as const, snapshot: okSnapshot(clock.t) }));
  const poller = new QuotaPoller({
    pool, now,
    codexLiveUsageReaderDetailed: reader as never,
    codexUsageReader: async () => null, // never read a real rollout tail
  });

  let jevLabel: JevLabel = 'device_limit';
  const jevCalls: Harness['jevCalls'] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: { body?: unknown }) => {
    jevCalls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    return {
      ok: true, status: 200,
      json: async () => ({ model: 'jev-1.13.0', usage: { input_tokens: 40 },
        answers: { lockout: { choice: jevLabel, probabilities: { [jevLabel]: 0.96 } } } }),
    };
  }));

  const sessions: DeviceLimitMoverSession[] = [];
  const swap = vi.fn(async () => ({ swapped: true, toAccountId: 'codex-b' }));
  const endRepairs = vi.fn(async () => [] as unknown[]);
  const raiseNotice = vi.fn();
  const clearNotice = vi.fn();
  const reportDegradation = vi.fn();
  const cfg = { enabled: true, ignoreAccounts: [] as string[] };
  const wiring = buildCodexDeviceLimitWiring({
    pool, ledger, quotaPoller: poller, machineId: MACHINE, stateDir, logsDir,
    config: () => cfg,
    judgeConfig: () => undefined,
    readKey: () => 'typesafe-test-key',
    referee: null,
    listSessions: () => sessions,
    swap, endRepairs, raiseNotice, clearNotice, reportDegradation,
    now,
  });
  return { dir, pool, ledger, poller, wiring, clock, cfg, refusing, homeA, homeB, reader, jevCalls,
    setJev: (l) => { jevLabel = l; }, sessions, swap, endRepairs, raiseNotice, clearNotice, reportDegradation };
}

/** Let the async judge queue, the stubbed Jev response and the verdict handler run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r));
}

/** B reads clean (the machine floor), A is refused once and judged: A becomes suspected. */
async function suspectA(h: Harness): Promise<void> {
  h.refusing.add(h.homeA);
  expect(await h.poller.requestCodexCheck('codex-b')).toBe(true);
  expect(await h.poller.requestCodexCheck('codex-a')).toBe(false);
  await settle();
}

/** The real 5-minute confirmation timer fires, A is refused again and freshly judged: benched. */
async function confirmA(h: Harness): Promise<void> {
  h.clock.t += FIVE_MIN;
  await vi.advanceTimersByTimeAsync(FIVE_MIN);
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const l of ledgers.splice(0)) { try { l.close(); } catch { /* @silent-fallback-ok: already closed */ } }
  for (const d of dirs.splice(0)) {
    SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/codex-device-limit-wiring.test.ts:cleanup' });
  }
});

describe('buildCodexDeviceLimitWiring — production composition (wiring integrity)', () => {
  it('attaches the tripwire to the quota poller: a refused live read reaches the judge (Jev)', async () => {
    const h = build();
    expect(h.wiring.judge).toBeTruthy();
    expect(h.wiring.tripwire).toBeTruthy();
    expect(h.wiring.mover).toBeTruthy();
    await suspectA(h);
    // The read went through the injected reader for A's home…
    expect(h.reader.mock.calls.some(([o]) => (o as { codexHome?: string })?.codexHome === h.homeA)).toBe(true);
    // …and the refusal reached the judge, which asked Jev with the prepared (fenced) snippet.
    expect(h.jevCalls).toHaveLength(1);
    expect(h.jevCalls[0].url).toContain('typesafe');
    expect(h.jevCalls[0].body.model).toBe('jev-1.13.0');
    expect(String(h.jevCalls[0].body.state)).toContain('Device limit reached');
    expect(String(h.jevCalls[0].body.state)).not.toContain('a@example.test');
    // A fresh device_limit verdict on a first refusal: suspected, not benched.
    const a = h.pool.get('codex-a')!;
    expect(a.deviceLimitSuspectedAt).toBeTruthy();
    expect(a.status).toBe('active');
    expect(a.statusCause).toBeUndefined();
    expect(h.raiseNotice).not.toHaveBeenCalled();
  });

  it('a clean read never asks the judge', async () => {
    const h = build();
    expect(await h.poller.requestCodexCheck('codex-a')).toBe(true);
    await settle();
    expect(h.jevCalls).toHaveLength(0);
    expect(h.pool.get('codex-a')!.deviceLimitSuspectedAt).toBeUndefined();
  });

  it('deps are not no-ops: a bench reaches endRepairs, swap (interactive only) and raiseNotice', async () => {
    const h = build();
    h.sessions.push(
      { tmuxSession: 'echo-topic-1', name: 'topic 1', subscriptionAccountId: 'codex-a', jobSlug: null, protected: false },
      { tmuxSession: 'job-nightly', name: 'nightly', subscriptionAccountId: 'codex-a', jobSlug: 'nightly', protected: false },
      { tmuxSession: 'echo-topic-2', name: 'topic 2', subscriptionAccountId: 'codex-b', jobSlug: null, protected: false },
    );
    await suspectA(h);
    await confirmA(h);
    const a = h.pool.get('codex-a')!;
    expect(a.status).toBe('needs-reauth');
    expect(a.statusCause).toBe('codex-device-limit');
    expect(a.deviceLimitSince).toBeTruthy();
    expect(a.deviceLimitSuspectedAt).toBeUndefined();
    expect(h.pool.get('codex-b')!.status).toBe('active');

    expect(h.endRepairs).toHaveBeenCalledWith('codex-a');
    expect(h.swap).toHaveBeenCalledTimes(1);
    expect(h.swap.mock.calls[0][0]).toMatchObject({ sessionName: 'echo-topic-1', exhaustedAccountId: 'codex-a' });
    expect(h.wiring.mover.counters.moved).toBe(1);

    expect(h.raiseNotice).toHaveBeenCalledTimes(1);
    expect(h.raiseNotice.mock.calls[0][0]).toMatchObject({
      machineId: MACHINE, conditionKey: deviceLimitConditionKey(MACHINE),
      category: DEVICE_LIMIT_ATTENTION_CATEGORY, priority: 'normal', silent: false,
    });
    expect(String(h.raiseNotice.mock.calls[0][0].body)).toContain('Plus A');

    // The ledger delegate is the real one: an open episode with the device-limit cause.
    const open = h.ledger!.listEpisodes({ accountId: 'codex-a' }).filter((e) => e.closedAt === null);
    expect(open).toHaveLength(1);
    expect(open[0].causeClass).toBe('codex-device-limit');
    expect(h.reportDegradation).not.toHaveBeenCalled();
  });

  it('a missing ledger never blocks the bench: it stands on the pool record and a degradation is raised', async () => {
    const h = build({ withLedger: false });
    await suspectA(h);
    await confirmA(h);
    expect(h.pool.get('codex-a')!.statusCause).toBe('codex-device-limit');
    expect(h.reportDegradation).toHaveBeenCalledWith(expect.objectContaining({ feature: 'CodexDeviceLimitTripwire.ledger' }));
  });

  it('regression: a repair the bench could not end now raises a settleRepairs degradation', async () => {
    const h = build();
    h.endRepairs.mockResolvedValue([{ id: 'ep-1', ended: false, reason: 'episode-version-conflict' }]);
    await suspectA(h);
    await confirmA(h);
    expect(h.pool.get('codex-a')!.statusCause).toBe('codex-device-limit'); // the bench stands
    expect(h.reportDegradation).toHaveBeenCalledWith(expect.objectContaining({
      feature: 'CodexDeviceLimitTripwire.settleRepairs',
      reason: expect.stringContaining('episode-version-conflict'),
    }));
  });

  it('deviceLimitHold: false before, true while suspected and benched, false when the switch is off (read live)', async () => {
    const h = build();
    expect(h.wiring.deviceLimitHold('codex-a')).toBe(false);
    await suspectA(h);
    expect(h.wiring.deviceLimitHold('codex-a')).toBe(true);
    expect(h.wiring.deviceLimitHold('codex-b')).toBe(false);
    await confirmA(h);
    expect(h.wiring.deviceLimitHold('codex-a')).toBe(true);
    h.cfg.enabled = false;
    expect(h.wiring.deviceLimitHold('codex-a')).toBe(false);
    expect(h.wiring.deviceLimitHold('no-such-account')).toBe(false);
  });

  it('judgeDeviceLimitPage resolves true only for a fresh device_limit verdict', async () => {
    const h = build();
    expect(await h.wiring.judgeDeviceLimitPage('codex-a', 'You have reached the device limit for paid accounts on this device.')).toBe(true);
    // Same text again: a page verdict is state-changing, so it is judged fresh, never served from the cache.
    expect(await h.wiring.judgeDeviceLimitPage('codex-a', 'You have reached the device limit for paid accounts on this device.')).toBe(true);
    expect(h.jevCalls).toHaveLength(2);
    h.setJev('signed_out');
    expect(await h.wiring.judgeDeviceLimitPage('codex-a', 'Your session has expired. Please log in again.')).toBe(false);
    h.setJev('cannot_tell'); // no referee ⇒ undecided
    expect(await h.wiring.judgeDeviceLimitPage('codex-a', 'Something went wrong.')).toBe(false);
    const callsBefore = h.jevCalls.length;
    h.cfg.enabled = false;
    h.setJev('device_limit');
    expect(await h.wiring.judgeDeviceLimitPage('codex-a', 'You have reached the device limit.')).toBe(false);
    expect(h.jevCalls).toHaveLength(callsBefore); // switch off ⇒ nothing leaves the machine
  });

  it('a signed_out verdict on a refusal changes nothing (today\'s path)', async () => {
    const h = build();
    h.setJev('signed_out');
    await suspectA(h);
    expect(h.jevCalls).toHaveLength(1);
    expect(h.pool.get('codex-a')!.deviceLimitSuspectedAt).toBeUndefined();
    expect(h.wiring.deviceLimitHold('codex-a')).toBe(false);
  });

  it('resolveNotice: unknown outside its category or for another machine; cleared/active for this machine', async () => {
    const h = build();
    const key = deviceLimitConditionKey(MACHINE);
    expect(h.wiring.resolveNotice({ category: 'subscription-relogin', conditionKey: key })).toBe('unknown');
    expect(h.wiring.resolveNotice({ category: DEVICE_LIMIT_ATTENTION_CATEGORY, conditionKey: deviceLimitConditionKey('m-other') })).toBe('unknown');
    expect(h.wiring.resolveNotice({})).toBe('unknown');
    expect(h.wiring.resolveNotice({ category: DEVICE_LIMIT_ATTENTION_CATEGORY, conditionKey: key })).toBe('cleared');
    await suspectA(h);
    await confirmA(h);
    expect(h.wiring.resolveNotice({ category: DEVICE_LIMIT_ATTENTION_CATEGORY, conditionKey: key })).toBe('active');
  });

  it('onSessionSigninSighting requests a real read when on, and nothing when the switch is off', async () => {
    const h = build();
    expect(await h.wiring.onSessionSigninSighting({ accountId: 'codex-a', session: 'echo-topic-1' })).toBe(true);
    expect(h.reader).toHaveBeenCalledTimes(1);
    h.cfg.enabled = false;
    h.clock.t += 11 * 60_000; // past the trigger floor
    expect(await h.wiring.onSessionSigninSighting({ accountId: 'codex-a', session: 'echo-topic-1' })).toBe(false);
    expect(h.reader).toHaveBeenCalledTimes(1);
  });

  it('onDeviceLimitStopped records the stopped repair on the machine notice (low) and asks for a read', async () => {
    const h = build();
    h.wiring.onDeviceLimitStopped('codex-a');
    await settle();
    expect(h.raiseNotice).toHaveBeenCalledTimes(1);
    expect(h.raiseNotice.mock.calls[0][0]).toMatchObject({ priority: 'low', conditionKey: deviceLimitConditionKey(MACHINE) });
    expect(h.reader.mock.calls.some(([o]) => (o as { codexHome?: string })?.codexHome === h.homeA)).toBe(true);
    // A repair stop never benches.
    expect(h.pool.get('codex-a')!.statusCause).toBeUndefined();
  });

  it('status() carries the tripwire, judge and mover counters and the executable Codex account count', async () => {
    const h = build();
    const before = h.wiring.status();
    expect(before).toMatchObject({
      enabled: true, suspectedNow: 0, benchedNow: 0, refusingAlike: false, stoppedRepairsNow: 0,
      totals: expect.objectContaining({ suspected: 0, benched: 0, released: 0 }),
      judge: expect.objectContaining({ judged: 0, cacheHits: 0, verdicts: { device_limit: 0, not_device_limit: 0, undecided: 0 } }),
      mover: { queued: 0, moved: 0, refused: 0, skipped: 0 },
      executableCodexAccounts: 2,
    });
    expect(typeof (before.judge as { capRemaining: unknown }).capRemaining).toBe('number');
    await suspectA(h);
    expect(h.wiring.status()).toMatchObject({ suspectedNow: 1, benchedNow: 0 });
    await confirmA(h);
    const after = h.wiring.status();
    expect(after).toMatchObject({ suspectedNow: 0, benchedNow: 1, executableCodexAccounts: 1,
      totals: expect.objectContaining({ suspected: 1, benched: 1 }) });
    expect((after.judge as { verdicts: Record<string, number> }).verdicts.device_limit).toBe(2);
    // Content-free: no refusal wording in the status block.
    expect(JSON.stringify(after)).not.toContain('Device limit reached');
  });
});
