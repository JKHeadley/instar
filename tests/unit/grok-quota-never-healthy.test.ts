import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { frameworkHasNoUsageSurface } from '../../src/core/frameworkFacts.js';

/**
 * "grok quota is always unknown, never healthy" was a stated guarantee, and
 * round-21 measured that it rested entirely on one optional field staying
 * null. A quota snapshot supplied through an ordinary authenticated account
 * update was stored verbatim — no shape check, no framework check — and the
 * headroom calculation downstream then read it and emitted a numeric
 * percentage with `degraded: false`, bypassing the unknown branch completely.
 * One update was enough to make an unmeasurable account report full headroom.
 *
 * The refusal lives in the STORE rather than the route, because a guarantee
 * enforced at one caller is a guarantee about that caller.
 */

const DIRS: string[] = [];
afterAll(() => {
  for (const d of DIRS) {
    try { SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, sourceTreeOverride: true }); } catch { /* leave it */ }
  }
});

function pool(): SubscriptionPool {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-quota-'));
  DIRS.push(dir);
  return new SubscriptionPool({ stateDir: dir });
}

/** A snapshot that would read as plenty of headroom if it were ever stored. */
const HEALTHY_LOOKING = {
  fiveHour: { utilizationPct: 0, resetsAt: '2026-08-16T00:00:00.000Z' },
  sevenDay: { utilizationPct: 0, resetsAt: '2026-08-22T00:00:00.000Z' },
};

describe('a framework with no usage surface can never carry a quota reading', () => {
  it('names grok-build, and CONTROL: does not name a framework that has one', () => {
    expect(frameworkHasNoUsageSurface('grok-build')).toBe(true);
    expect(frameworkHasNoUsageSurface('claude-code')).toBe(false);
    expect(frameworkHasNoUsageSurface('codex-cli')).toBe(false);
    expect(frameworkHasNoUsageSurface(undefined)).toBe(false);
  });

  it('REFUSES a quota snapshot written against a grok-build account', () => {
    const p = pool();
    const acct = p.addFixture({
      id: 'groky', nickname: 'Groky', email: 'groky@example.test',
      provider: 'xai', framework: 'grok-build', configHome: '/tmp/grok-home',
    } as never);

    expect(() => p.update(acct.id, { lastQuota: HEALTHY_LOOKING } as never))
      .toThrow(/exposes no usage surface/);

    // The refusal must actually leave the field unset — a throw that still
    // mutated would be the same defect with a louder log line.
    expect(p.get('groky')?.lastQuota ?? null).toBeNull();
  });

  it('CONTROL: the same snapshot IS stored for a framework that reports usage', () => {
    // Without this, the test above would pass equally well against an update()
    // that had simply stopped storing quota for everyone.
    const p = pool();
    const acct = p.addFixture({
      id: 'claude-main', nickname: 'Main', email: 'main@example.test',
      provider: 'anthropic', framework: 'claude-code', configHome: '/tmp/claude-home',
    } as never);

    p.update(acct.id, { lastQuota: HEALTHY_LOOKING } as never);
    expect(p.get('claude-main')?.lastQuota?.sevenDay?.utilizationPct).toBe(0);
  });
});
