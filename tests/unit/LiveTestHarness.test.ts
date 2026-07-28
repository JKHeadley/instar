/**
 * Tier-1 tests for LiveTestHarness (spec §5): the user-role live-test runner.
 * Drives a scenario matrix over a FAKE ChannelDriver and proves: a passing run
 * writes a gate-satisfying artifact; the §5.3 demo-channel guard refuses a volatile
 * scenario on a live channel BEFORE any send; deterministic expectations produce
 * FAIL on a wrong reply / wrong responder machine; a timeout is FAIL. Closes the
 * loop end-to-end (harness → artifact → LiveTestGate allow).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { LiveTestArtifactStore, type Surface } from '../../src/core/LiveTestArtifactStore.js';
import { LiveTestGate } from '../../src/core/LiveTestGate.js';
import { LiveTestHarness, HarnessVolatileChannelError, type ChannelDriver, type HarnessMatrix, type ReplyResult } from '../../src/core/LiveTestHarness.js';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const sign = (data: string) => crypto.sign(null, Buffer.from(data), privateKey).toString('base64');
const verify = (data: string, sig: string) => crypto.verify(null, Buffer.from(data), publicKey, Buffer.from(sig, 'base64'));

/** A scripted driver: per (surface,channelId) the reply to return (or null=timeout). */
function fakeDriver(opts: {
  demo?: Array<[Surface, string]>;
  reply?: (surface: Surface, channelId: string, input: string) => ReplyResult | null;
}): ChannelDriver & { sent: Array<{ surface: Surface; channelId: string; text: string }> } {
  const demo = new Set((opts.demo ?? []).map(([s, c]) => `${s}:${c}`));
  const sent: Array<{ surface: Surface; channelId: string; text: string }> = [];
  let n = 0;
  return {
    sent,
    isDemoChannel: (s, c) => demo.has(`${s}:${c}`),
    async send(s, c, text) { sent.push({ surface: s, channelId: c, text }); return { messageId: `m${++n}` }; },
    async awaitReply(s, c, _o) { return opts.reply ? opts.reply(s, c, '') : null; },
  };
}

function matrix(over: Partial<HarnessMatrix> = {}): HarnessMatrix {
  return {
    featureId: 'transfer',
    surfaces: ['telegram', 'slack'],
    riskCategories: ['happy-path', 'channel-parity'],
    scenarios: [
      { id: 't', description: 'tg happy', surface: 'telegram', riskCategory: 'happy-path', volatility: 'safe', channelId: 'tg1', input: 'you there?', expect: { replyContains: 'here', responderMachine: 'mini' } },
      { id: 's', description: 'sl happy', surface: 'slack', riskCategory: 'happy-path', volatility: 'safe', channelId: 'sl1', input: 'you there?', expect: { replyContains: 'here', responderMachine: 'mini' } },
      { id: 'p', description: 'parity', surface: 'slack', riskCategory: 'channel-parity', volatility: 'safe', channelId: 'sl1', input: 'ping', expect: { replyNotEmpty: true } },
    ],
    ...over,
  };
}

describe('LiveTestHarness', () => {
  let dir: string;
  let store: LiveTestArtifactStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-'));
    store = new LiveTestArtifactStore({ stateDir: dir, machineId: 'laptop', signerFingerprint: 'fp', sign, verify });
  });
  afterEach(() => { try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: "live-test-cleanup" }); } catch { /* */ } });

  it('a passing run writes a gate-satisfying artifact (end-to-end harness→artifact→gate)', async () => {
    const driver = fakeDriver({ reply: () => ({ text: "I'm here", messageId: 'r1', responderMachineId: 'mini' }) });
    const harness = new LiveTestHarness({ store, driver, runnerFingerprint: 'fp', now: () => 1_000 });
    const { artifact } = await harness.run(matrix(), { runId: 'run-1' });

    expect(artifact.scenarios.every((s) => s.verdict === 'PASS')).toBe(true);
    // The gate now allows "done" for this feature off the written artifact.
    const gate = new LiveTestGate(store);
    const r = gate.evaluate({ featureId: 'transfer', userFacing: true, goalText: 'move the seat', mode: 'veto' });
    expect(r.outcome).toBe('allow');
  });

  it('§5.3: refuses a volatile scenario on a NON-demo channel before any send (structural guard)', async () => {
    const driver = fakeDriver({ reply: () => ({ text: 'ok', messageId: 'r', responderMachineId: 'mini' }) });
    const harness = new LiveTestHarness({ store, driver, runnerFingerprint: 'fp' });
    const m = matrix({ scenarios: [
      { id: 'danger', description: 'permission grant', surface: 'slack', riskCategory: 'permission-volatile', volatility: 'permission', channelId: 'LIVE-operator', input: 'grant admin', expect: {} },
    ] });
    await expect(harness.run(m)).rejects.toBeInstanceOf(HarnessVolatileChannelError);
    expect(driver.sent).toHaveLength(0); // refused BEFORE any send
  });

  it('allows a volatile scenario when the channel IS a demo channel', async () => {
    const driver = fakeDriver({ demo: [['slack', 'demo-ws']], reply: () => ({ text: 'granted', messageId: 'r', responderMachineId: 'mini' }) });
    const harness = new LiveTestHarness({ store, driver, runnerFingerprint: 'fp' });
    const m = matrix({ scenarios: [
      { id: 'danger', description: 'permission grant', surface: 'slack', riskCategory: 'permission-volatile', volatility: 'permission', channelId: 'demo-ws', input: 'grant', expect: { replyContains: 'granted' } },
    ] });
    const { artifact } = await harness.run(m, { runId: 'r' });
    expect(artifact.scenarios[0].verdict).toBe('PASS');
  });

  it('deterministic FAIL when the reply is missing expected content', async () => {
    const driver = fakeDriver({ reply: () => ({ text: 'something else', messageId: 'r', responderMachineId: 'mini' }) });
    const harness = new LiveTestHarness({ store, driver, runnerFingerprint: 'fp' });
    const { artifact } = await harness.run(matrix(), { runId: 'r' });
    expect(artifact.scenarios[0].verdict).toBe('FAIL');
    expect(artifact.scenarios[0].blockedReason).toContain('missing');
  });

  it('deterministic FAIL when the WRONG machine answered (the transfer bug signature)', async () => {
    // Reply came from the laptop, but the scenario expects the mini (the seat didn't move).
    const driver = fakeDriver({ reply: () => ({ text: "I'm here", messageId: 'r', responderMachineId: 'laptop' }) });
    const harness = new LiveTestHarness({ store, driver, runnerFingerprint: 'fp' });
    const { artifact } = await harness.run(matrix(), { runId: 'r' });
    const tg = artifact.scenarios.find((s) => s.id === 't')!;
    expect(tg.verdict).toBe('FAIL');
    expect(tg.blockedReason).toContain('laptop');
  });

  it('a reply timeout is recorded FAIL (not auto-BLOCKED) after retries', async () => {
    const driver = fakeDriver({ reply: () => null }); // always times out
    const harness = new LiveTestHarness({ store, driver, runnerFingerprint: 'fp', maxReplyRetries: 1, defaultTimeoutMs: 5 });
    const { artifact } = await harness.run(matrix({ scenarios: [matrix().scenarios[0]] }), { runId: 'r' });
    expect(artifact.scenarios[0].verdict).toBe('FAIL');
    expect(artifact.scenarios[0].blockedReason).toContain('no reply');
  });
});
