/**
 * Tier-1 tests for the rate-limit false-positive user-role matrix + the harness
 * ABSENCE capability that backs it. Proves: the matrix builder shapes the right
 * scenarios; the harness FAILS when a spurious throttle-resume nudge lands in the
 * window, PASSES when none does, and BLOCKS (never silently passes) when the driver
 * cannot verify absence. (live incident 2026-06-24)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { LiveTestArtifactStore, type Surface } from '../../src/core/LiveTestArtifactStore.js';
import { LiveTestHarness, type ChannelDriver, type ReplyResult } from '../../src/core/LiveTestHarness.js';
import { buildRateLimitFalsePositiveMatrix, THROTTLE_RESUME_NUDGE_FRAGMENT } from '../../src/core/rateLimitFalsePositiveMatrix.js';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const sign = (d: string) => crypto.sign(null, Buffer.from(d), privateKey).toString('base64');
const verify = (d: string, s: string) => crypto.verify(null, Buffer.from(d), publicKey, Buffer.from(s, 'base64'));

/** Fake driver: replies to a normal send, and returns a scripted message list for collectMessages. */
function fakeDriver(opts: {
  reply?: ReplyResult | null;
  collected?: ReplyResult[];
  supportsCollect?: boolean;
}): ChannelDriver {
  let n = 0;
  const base: ChannelDriver = {
    isDemoChannel: () => true,
    async send() { return { messageId: `m${++n}` }; },
    async awaitReply() { return opts.reply ?? { text: 'I am here.', messageId: `r${++n}` }; },
  };
  if (opts.supportsCollect !== false) {
    base.collectMessages = async () => opts.collected ?? [];
  }
  return base;
}

describe('buildRateLimitFalsePositiveMatrix', () => {
  it('shapes telegram-only happy-path + absence-regression scenarios', () => {
    const m = buildRateLimitFalsePositiveMatrix({ telegramTopicId: 'tg1' });
    expect(m.featureId).toBe('rate-limit-false-positive-fix');
    expect(m.surfaces).toEqual(['telegram']);
    expect(m.riskCategories).toEqual(['happy-path', 'regression']);
    expect(m.scenarios.map(s => s.id)).toEqual(['rl-happy-path-normal-reply', 'rl-finished-session-no-throttle-nudge']);
    const absence = m.scenarios.find(s => s.id === 'rl-finished-session-no-throttle-nudge')!;
    expect(absence.absenceWindowMs).toBeGreaterThan(0);
    expect(absence.expect.noMessageMatching).toBe(THROTTLE_RESUME_NUDGE_FRAGMENT);
  });

  it('adds a Slack channel-parity absence scenario when a Slack channel is given', () => {
    const m = buildRateLimitFalsePositiveMatrix({ telegramTopicId: 'tg1', slackChannelId: 'sl1' });
    expect(m.surfaces).toEqual(['telegram', 'slack']);
    expect(m.riskCategories).toContain('channel-parity');
    expect(m.scenarios.some(s => s.surface === 'slack' && s.expect.noMessageMatching === THROTTLE_RESUME_NUDGE_FRAGMENT)).toBe(true);
  });
});

describe('LiveTestHarness — absence assertion', () => {
  let dir: string;
  let store: LiveTestArtifactStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-fp-'));
    store = new LiveTestArtifactStore({ stateDir: dir, machineId: 'mac', signerFingerprint: 'fp', sign, verify });
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/rate-limit-false-positive-matrix.test.ts:cleanup' }));

  function run(driver: ChannelDriver) {
    const harness = new LiveTestHarness({ store, driver, runnerFingerprint: 'fp', defaultTimeoutMs: 50 });
    return harness.run(buildRateLimitFalsePositiveMatrix({ telegramTopicId: 'tg1', absenceWindowMs: 10 }));
  }

  it('PASSES the absence scenario when no spurious nudge lands in the window', async () => {
    const { artifact } = await run(fakeDriver({ collected: [{ text: 'just a normal follow-up', messageId: 'x1' }] }));
    const row = artifact.scenarios.find(s => s.id === 'rl-finished-session-no-throttle-nudge')!;
    expect(row.verdict).toBe('PASS');
  });

  it('FAILS the absence scenario when a throttle-resume nudge lands in the window', async () => {
    const spurious: ReplyResult = { text: 'The temporary server throttle should have cleared — please continue.', messageId: 'x2' };
    const { artifact } = await run(fakeDriver({ collected: [spurious] }));
    const row = artifact.scenarios.find(s => s.id === 'rl-finished-session-no-throttle-nudge')!;
    expect(row.verdict).toBe('FAIL');
    expect(row.blockedReason).toContain(THROTTLE_RESUME_NUDGE_FRAGMENT);
  });

  it('BLOCKS (never silently passes) the absence scenario when the driver cannot collect messages', async () => {
    const { artifact } = await run(fakeDriver({ supportsCollect: false }));
    const row = artifact.scenarios.find(s => s.id === 'rl-finished-session-no-throttle-nudge')!;
    expect(row.verdict).toBe('BLOCKED');
    expect(row.blockedReason).toContain('collectMessages');
  });

  it('happy-path scenario passes on a normal reply and flags a reply that contains the forbidden nudge', async () => {
    const ok = await run(fakeDriver({ reply: { text: 'Yes, I am here.', messageId: 'r1' }, collected: [] }));
    expect(ok.artifact.scenarios.find(s => s.id === 'rl-happy-path-normal-reply')!.verdict).toBe('PASS');

    const bad = await run(fakeDriver({ reply: { text: 'The temporary server throttle should have cleared — continue.', messageId: 'r2' }, collected: [] }));
    expect(bad.artifact.scenarios.find(s => s.id === 'rl-happy-path-normal-reply')!.verdict).toBe('FAIL');
  });
});
