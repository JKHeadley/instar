/**
 * Tier-2 integration: the PREVENTION LAYER wired end-to-end. Drives the rate-limit
 * false-positive matrix through the REAL LiveTestHarness → LiveTestArtifactStore
 * (signed) → LiveTestGate, and proves the gate would have BLOCKED the live incident:
 *   - a clean run (no spurious throttle nudge) → signed artifact → gate ALLOWS;
 *   - a regressed run (a throttle-resume nudge lands in the window) → the regression
 *     scenario FAILs → gate VETOES in veto mode.
 * This is the structural answer to "catch the compounding side-effect before deploy":
 * a background message that should not appear is now a gate-blocking, signed FAIL.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { LiveTestArtifactStore } from '../../src/core/LiveTestArtifactStore.js';
import { LiveTestGate } from '../../src/core/LiveTestGate.js';
import { LiveTestHarness, type ChannelDriver, type ReplyResult, type Surface } from '../../src/core/LiveTestHarness.js';
import { buildRateLimitFalsePositiveMatrix } from '../../src/core/rateLimitFalsePositiveMatrix.js';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const sign = (d: string) => crypto.sign(null, Buffer.from(d), privateKey).toString('base64');
const verify = (d: string, s: string) => crypto.verify(null, Buffer.from(d), publicKey, Buffer.from(s, 'base64'));

const FEATURE = 'rate-limit-false-positive-fix';

/** Fake real-channel: replies normally; collectMessages returns whatever the run scripts. */
function driver(spuriousByChannel: Record<string, ReplyResult[]>): ChannelDriver {
  let n = 0;
  const demo = new Set<string>(['telegram:tg-demo', 'slack:sl-demo']);
  return {
    isDemoChannel: (s: Surface, c: string) => demo.has(`${s}:${c}`),
    async send() { return { messageId: `m${++n}` }; },
    async awaitReply() { return { text: 'Yep, I am here.', messageId: `r${++n}` }; },
    async collectMessages(_s, c) { return spuriousByChannel[c] ?? []; },
  };
}

describe('rate-limit false-positive prevention (harness → gate)', () => {
  let dir: string;
  let store: LiveTestArtifactStore;
  let gate: LiveTestGate;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-prev-'));
    store = new LiveTestArtifactStore({ stateDir: dir, machineId: 'mac', signerFingerprint: 'fp', sign, verify });
    gate = new LiveTestGate(store);
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/rate-limit-false-positive-prevention.test.ts:cleanup' }));

  function runMatrix(d: ChannelDriver) {
    const harness = new LiveTestHarness({ store, driver: d, runnerFingerprint: 'fp', defaultTimeoutMs: 50 });
    const matrix = buildRateLimitFalsePositiveMatrix({ featureId: FEATURE, telegramTopicId: 'tg-demo', slackChannelId: 'sl-demo', absenceWindowMs: 10 });
    return harness.run(matrix);
  }

  it('clean run → signed artifact verifies → gate ALLOWS', async () => {
    const { artifact } = await runMatrix(driver({})); // no spurious messages anywhere
    expect(artifact.scenarios.every(s => s.verdict === 'PASS')).toBe(true);

    // The signed artifact verifies from disk (gate reads disk, not the transcript).
    const v = store.verifyEntry(FEATURE, artifact.runId);
    expect(v.ok).toBe(true);

    const result = gate.evaluate({ featureId: FEATURE, userFacing: true, goalText: 'fix false rate-limit nudges', requiredSurfaces: ['telegram', 'slack'], mode: 'veto' });
    expect(result.outcome).toBe('allow');
    expect(result.blocks).toBe(false);
  });

  it('regressed run (spurious throttle nudge lands) → gate VETOES', async () => {
    const spurious: ReplyResult = { text: 'The temporary server throttle should have cleared — please continue where you left off.', messageId: 'spur1' };
    // The nudge lands on BOTH channels (the bug was fleet-wide / both surfaces).
    const { artifact } = await runMatrix(driver({ 'tg-demo': [spurious], 'sl-demo': [spurious] }));

    const regression = artifact.scenarios.find(s => s.riskCategory === 'regression')!;
    expect(regression.verdict).toBe('FAIL');

    const result = gate.evaluate({ featureId: FEATURE, userFacing: true, goalText: 'fix false rate-limit nudges', requiredSurfaces: ['telegram', 'slack'], mode: 'veto' });
    expect(result.outcome).toBe('veto');
    expect(result.blocks).toBe(true);
  });
});
