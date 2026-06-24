/**
 * Tier-1 tests for the REAL-channel absence-proof path: `collectMessages` on the live
 * senders + RealChannelDriver, and the harness mapping of an unsupported surface to
 * BLOCKED (not FAIL). This is what lets the absence assertion (no spurious background
 * nudge) run over a REAL Telegram/Slack channel instead of only a fake driver — closing
 * the live-drive gap on the false-rate-limit fix (live incident 2026-06-24).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramLiveSender, type TelegramHistoryEntry } from '../../src/core/TelegramLiveSender.js';
import { SlackLiveSender, type SlackCaller } from '../../src/core/SlackLiveSender.js';
import { RealChannelDriver, type SurfaceSender } from '../../src/core/RealChannelDriver.js';
import { LiveTestHarness, DriverCapabilityError, AbsenceUnverifiableError, HarnessVolatileChannelError, type HarnessMatrix } from '../../src/core/LiveTestHarness.js';
import { LiveTestArtifactStore } from '../../src/core/LiveTestArtifactStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const noSleep = async () => {};

describe('TelegramLiveSender.collectMessages', () => {
  it('collects EVERY agent message after the prompt, skipping inbound + pre-marker, oldest-first', async () => {
    const history: TelegramHistoryEntry[] = [
      { messageId: 100, text: 'old agent (before prompt)', fromUser: false },
      { messageId: 200, text: 'the demo prompt', fromUser: true },
      { messageId: 201, text: 'legit reply', fromUser: false },
      { messageId: 250, text: 'another user msg', fromUser: true },
      { messageId: 260, text: 'throttle should have cleared', fromUser: false },
    ];
    const s = new TelegramLiveSender({ postAsDemoUser: async () => ({ messageId: 200 }), getHistory: () => history, sleep: noSleep });
    const msgs = await s.collectMessages('13481', { windowMs: 0, afterMessageId: '200' });
    expect(msgs.map(m => m.messageId)).toEqual(['201', '260']); // 100 (pre-marker) + user msgs excluded
    expect(msgs.map(m => m.text)).toEqual(['legit reply', 'throttle should have cleared']);
  });

  it('polls across the window so a LATE nudge (after a legit reply) is still captured', async () => {
    let calls = 0;
    const getHistory = () => {
      calls++;
      const base: TelegramHistoryEntry[] = [
        { messageId: 200, text: 'prompt', fromUser: true },
        { messageId: 201, text: 'legit reply', fromUser: false },
      ];
      // The spurious nudge only appears on the 3rd poll — a single read would miss it.
      return calls >= 3 ? [...base, { messageId: 300, text: 'LATE NUDGE', fromUser: false }] : base;
    };
    let nowVal = 0;
    const s = new TelegramLiveSender({ postAsDemoUser: async () => ({ messageId: 200 }), getHistory, sleep: noSleep, pollIntervalMs: 1, now: () => (nowVal += 100) });
    const msgs = await s.collectMessages('1', { windowMs: 1000, afterMessageId: '200' });
    expect(msgs.some(m => m.text === 'LATE NUDGE')).toBe(true);
  });

  it('dedupes a message seen across multiple polls (no duplicate ids)', async () => {
    const history: TelegramHistoryEntry[] = [
      { messageId: 200, text: 'prompt', fromUser: true },
      { messageId: 201, text: 'reply', fromUser: false },
    ];
    let nowVal = 0;
    const s = new TelegramLiveSender({ postAsDemoUser: async () => ({ messageId: 200 }), getHistory: () => history, sleep: noSleep, pollIntervalMs: 1, now: () => (nowVal += 100) });
    const msgs = await s.collectMessages('1', { windowMs: 500, afterMessageId: '200' });
    expect(msgs.filter(m => m.messageId === '201')).toHaveLength(1);
  });
});

describe('SlackLiveSender.collectMessages', () => {
  function caller(messages: Array<{ ts: string; user?: string; text?: string }>): SlackCaller {
    return { call: vi.fn(async () => ({ ok: true, messages })) };
  }
  it('collects EVERY agent-authored message after the prompt ts, skipping the user', async () => {
    const api = caller([
      { ts: '100.0', user: 'BOT', text: 'before prompt' },
      { ts: '200.0', user: 'USER', text: 'prompt' },
      { ts: '201.0', user: 'BOT', text: 'legit reply' },
      { ts: '202.0', user: 'USER', text: 'another user' },
      { ts: '203.0', user: 'BOT', text: 'throttle should have cleared' },
    ]);
    const s = new SlackLiveSender({ api, agentBotUserId: 'BOT', sleep: noSleep });
    const msgs = await s.collectMessages('C1', { windowMs: 0, afterMessageId: '200.0' });
    expect(msgs.map(m => m.text)).toEqual(['legit reply', 'throttle should have cleared']);
  });
});

describe('RealChannelDriver.collectMessages', () => {
  const demoNo = { isDemoChannel: () => false };

  it('delegates to the surface sender that supports it', async () => {
    const collect = vi.fn(async () => [{ messageId: 'm1', text: 'a' }, { messageId: 'm2', text: 'b' }]);
    const tg: SurfaceSender = { send: vi.fn(async () => ({ messageId: 's' })), awaitReply: vi.fn(async () => null), collectMessages: collect };
    const driver = new RealChannelDriver({ senders: { telegram: tg }, demoRegistry: demoNo, resolveResponderMachine: async () => null });
    const msgs = await driver.collectMessages('telegram', '13481', { windowMs: 5, afterMessageId: 's0' });
    expect(msgs.map(m => m.text)).toEqual(['a', 'b']);
    expect(collect).toHaveBeenCalledWith('13481', { windowMs: 5, afterMessageId: 's0' });
  });

  it('raises DriverCapabilityError (→ harness BLOCKED) when the surface sender cannot collect', async () => {
    const dash: SurfaceSender = { send: vi.fn(async () => ({ messageId: 's' })), awaitReply: vi.fn(async () => null) }; // no collectMessages
    const driver = new RealChannelDriver({ senders: { dashboard: dash }, demoRegistry: demoNo, resolveResponderMachine: async () => null });
    await expect(driver.collectMessages('dashboard', 'd1', { windowMs: 1 })).rejects.toBeInstanceOf(DriverCapabilityError);
  });

  it('throws the loud config error when no sender is wired for the surface at all', async () => {
    const driver = new RealChannelDriver({ senders: {}, demoRegistry: demoNo, resolveResponderMachine: async () => null });
    await expect(driver.collectMessages('telegram', 'x', { windowMs: 1 })).rejects.toThrow(/no real sender configured/);
  });
});

describe('LiveTestHarness absence over a RealChannelDriver (end-to-end)', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const sign = (data: string) => crypto.sign(null, Buffer.from(data), privateKey).toString('base64');
  const verify = (data: string, sig: string) => crypto.verify(null, Buffer.from(data), publicKey, Buffer.from(sig, 'base64'));
  let dir: string;
  let store: LiveTestArtifactStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-collect-'));
    store = new LiveTestArtifactStore({ stateDir: dir, machineId: 'laptop', signerFingerprint: 'fp', sign, verify });
  });
  afterEach(() => { try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'test-cleanup' }); } catch { /* */ } });

  const NUDGE = 'throttle should have cleared';
  function tgSender(history: TelegramHistoryEntry[]): SurfaceSender {
    return new TelegramLiveSender({ postAsDemoUser: async () => ({ messageId: 500 }), getHistory: () => history, sleep: noSleep });
  }
  function driverWith(senders: Partial<Record<'telegram' | 'dashboard', SurfaceSender>>): RealChannelDriver {
    return new RealChannelDriver({ senders, demoRegistry: { isDemoChannel: () => true }, resolveResponderMachine: async () => null });
  }
  function absenceMatrix(surface: 'telegram' | 'dashboard', channelId: string): HarnessMatrix {
    return {
      featureId: 'rc-collect-test', surfaces: [surface], riskCategories: ['failure-rollback'],
      scenarios: [{ id: 'a1', description: 'no spurious nudge', surface, riskCategory: 'failure-rollback', volatility: 'safe', channelId, input: 'hi', expect: { noMessageMatching: NUDGE }, absenceWindowMs: 0 }],
    };
  }

  it('clean real channel → PASS (no spurious nudge collected)', async () => {
    const driver = driverWith({ telegram: tgSender([{ messageId: 501, text: 'all good', fromUser: false }]) });
    const harness = new LiveTestHarness({ store, driver, runnerFingerprint: 'fp', defaultTimeoutMs: 5 });
    const { artifact } = await harness.run(absenceMatrix('telegram', '13481'));
    expect(artifact.scenarios[0].verdict).toBe('PASS');
  });

  it('spurious nudge on the real channel → FAIL (the regression signature)', async () => {
    const driver = driverWith({ telegram: tgSender([{ messageId: 501, text: 'all good', fromUser: false }, { messageId: 502, text: NUDGE, fromUser: false }]) });
    const harness = new LiveTestHarness({ store, driver, runnerFingerprint: 'fp', defaultTimeoutMs: 5 });
    const { artifact } = await harness.run(absenceMatrix('telegram', '13481'));
    expect(artifact.scenarios[0].verdict).toBe('FAIL');
    expect(artifact.scenarios[0].blockedReason).toContain(NUDGE);
  });

  it('surface whose sender cannot collect → BLOCKED (never a false PASS), via DriverCapabilityError', async () => {
    const dash: SurfaceSender = { send: async () => ({ messageId: 's' }), awaitReply: async () => null }; // no collectMessages
    const driver = driverWith({ dashboard: dash });
    const harness = new LiveTestHarness({ store, driver, runnerFingerprint: 'fp', defaultTimeoutMs: 5 });
    const { artifact } = await harness.run(absenceMatrix('dashboard', 'demo-dash'));
    expect(artifact.scenarios[0].verdict).toBe('BLOCKED');
    expect(artifact.scenarios[0].blockedReason).toMatch(/absence unverifiable on surface/);
  });
});

describe('absence-proof soundness guards (round-2 review fixes)', () => {
  const noSleepLocal = async () => {};

  it('Telegram: a FULL page whose OLDEST entry is after the marker (marker scrolled off) → AbsenceUnverifiableError', async () => {
    // 100 entries all AFTER the marker (id 1) → the marker scrolled off the tail → truncated.
    const full: TelegramHistoryEntry[] = Array.from({ length: 100 }, (_, i) => ({ messageId: 1000 + i, text: `m${i}`, fromUser: false }));
    const s = new TelegramLiveSender({ postAsDemoUser: async () => ({ messageId: 1 }), getHistory: () => full, sleep: noSleepLocal });
    await expect(s.collectMessages('1', { windowMs: 0, afterMessageId: '1' })).rejects.toBeInstanceOf(AbsenceUnverifiableError);
  });

  it('Telegram: a FULL page on a long-lived demo topic with the marker IN-PAGE does NOT block (round-2 mis-fire fix)', async () => {
    // 100 lifetime entries 900..999; marker is 990 → entries 900..990 are <= marker (in-page),
    // so the read is complete: only 991..999 are post-marker agent messages. Must NOT throw.
    const full: TelegramHistoryEntry[] = Array.from({ length: 100 }, (_, i) => ({ messageId: 900 + i, text: i >= 91 ? `post-${i}` : `old-${i}`, fromUser: false }));
    const s = new TelegramLiveSender({ postAsDemoUser: async () => ({ messageId: 990 }), getHistory: () => full, sleep: noSleepLocal });
    const msgs = await s.collectMessages('1', { windowMs: 0, afterMessageId: '990' });
    expect(msgs.map(m => m.messageId)).toEqual(['991', '992', '993', '994', '995', '996', '997', '998', '999']);
  });

  it('Telegram: edit-laundering is caught — BOTH text versions of a messageId are returned', async () => {
    let calls = 0;
    const getHistory = () => {
      calls++;
      // Poll 1: the id carries the offending text; poll 2: it has been EDITED to benign.
      return calls < 2
        ? [{ messageId: 200, text: 'prompt', fromUser: true }, { messageId: 300, text: 'OFFENDING', fromUser: false }]
        : [{ messageId: 200, text: 'prompt', fromUser: true }, { messageId: 300, text: 'now benign', fromUser: false }];
    };
    let nowVal = 0;
    const s = new TelegramLiveSender({ postAsDemoUser: async () => ({ messageId: 200 }), getHistory, sleep: noSleepLocal, pollIntervalMs: 1, now: () => (nowVal += 100) });
    const msgs = await s.collectMessages('1', { windowMs: 500, afterMessageId: '200' });
    expect(msgs.some(m => m.text === 'OFFENDING')).toBe(true); // the edit cannot launder it out
  });

  it('Slack: ok:false (failed read) → AbsenceUnverifiableError (no vacuous PASS)', async () => {
    const api: SlackCaller = { call: vi.fn(async () => ({ ok: false, messages: [] })) };
    const s = new SlackLiveSender({ api, agentBotUserId: 'BOT', sleep: noSleepLocal });
    await expect(s.collectMessages('C1', { windowMs: 0, afterMessageId: '1.0' })).rejects.toBeInstanceOf(AbsenceUnverifiableError);
  });

  it('Slack: a next_cursor (more pages) → AbsenceUnverifiableError (truncation)', async () => {
    const api: SlackCaller = { call: vi.fn(async () => ({ ok: true, messages: [{ ts: '2.0', user: 'BOT', text: 'x' }], response_metadata: { next_cursor: 'PAGE2' } })) };
    const s = new SlackLiveSender({ api, agentBotUserId: 'BOT', sleep: noSleepLocal });
    await expect(s.collectMessages('C1', { windowMs: 0, afterMessageId: '1.0' })).rejects.toBeInstanceOf(AbsenceUnverifiableError);
  });

  it('Slack: a background nudge carrying only bot_id (no user) IS collected when agentBotId is set', async () => {
    const api: SlackCaller = { call: vi.fn(async () => ({ ok: true, messages: [
      { ts: '2.0', user: 'USER', text: 'prompt' },
      { ts: '3.0', bot_id: 'B123', text: 'throttle nudge via webhook' }, // no `user`
    ] })) };
    const s = new SlackLiveSender({ api, agentBotUserId: 'BOT', agentBotId: 'B123', sleep: noSleepLocal });
    const msgs = await s.collectMessages('C1', { windowMs: 0, afterMessageId: '1.0' });
    expect(msgs.map(m => m.text)).toContain('throttle nudge via webhook');
  });

  it('harness: a SAFE absence scenario on a NON-demo channel is refused (§5.3, never polls a live channel)', async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const sign = (d: string) => crypto.sign(null, Buffer.from(d), privateKey).toString('base64');
    const verify = (d: string, sig: string) => crypto.verify(null, Buffer.from(d), publicKey, Buffer.from(sig, 'base64'));
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-53-'));
    try {
      const store2 = new LiveTestArtifactStore({ stateDir: dir2, machineId: 'laptop', signerFingerprint: 'fp', sign, verify });
      const tg: SurfaceSender = { send: async () => ({ messageId: 's' }), awaitReply: async () => null, collectMessages: async () => [] };
      const driver = new RealChannelDriver({ senders: { telegram: tg }, demoRegistry: { isDemoChannel: () => false }, resolveResponderMachine: async () => null });
      const harness = new LiveTestHarness({ store: store2, driver, runnerFingerprint: 'fp', defaultTimeoutMs: 5 });
      const m: HarnessMatrix = { featureId: 'f', surfaces: ['telegram'], riskCategories: ['failure-rollback'], scenarios: [
        { id: 'a', description: 'absence on live channel', surface: 'telegram', riskCategory: 'failure-rollback', volatility: 'safe', channelId: 'LIVE-operator', input: 'hi', expect: { noMessageMatching: 'x' }, absenceWindowMs: 0 },
      ] };
      await expect(harness.run(m)).rejects.toBeInstanceOf(HarnessVolatileChannelError);
    } finally {
      try { SafeFsExecutor.safeRmSync(dir2, { recursive: true, force: true, operation: 'test-cleanup' }); } catch { /* */ }
    }
  });
});
