// safe-fs-allow: test file — tmpdir fixtures only, cleaned via SafeFsExecutor.

/**
 * E2E lifecycle tests for the GuardPostureTripwire.
 *
 * Tier 3 ("is the feature actually alive?"): exercises the production shape —
 * two consecutive boots over real on-disk state with the real module, then a
 * WIRED source guard pinning the server.ts invocation so the feature cannot
 * silently become dead code.
 *
 * Spec context: 2026-06-05 meltdown load-shed batch-flip (issue #882 + the
 * EXO AUP-wedge evening) — five guards off, one noticed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGuardPostureTripwire, type AttentionItemInput } from '../../src/monitoring/GuardPostureTripwire.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('GuardPostureTripwire E2E — two-boot lifecycle over real disk state', () => {
  let dir: string;
  let stateDir: string;
  let logsDir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-guardposture-e2e-'));
    stateDir = path.join(dir, '.instar');
    logsDir = path.join(dir, 'logs');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, {
      recursive: true,
      force: true,
      operation: 'tests/e2e/guard-posture-tripwire-lifecycle.test.ts:cleanup',
    });
  });

  it('boot 1 baselines; boot 2 after a flip writes the breadcrumb + raises ONE aggregated item', async () => {
    const emitted: AttentionItemInput[] = [];
    const emit = async (item: AttentionItemInput) => { emitted.push(item); };

    // Boot 1 — healthy posture.
    const boot1 = await runGuardPostureTripwire({
      config: { monitoring: { contextWedgeSentinel: { enabled: true }, failureLearning: { enabled: true } }, scheduler: { enabled: true } },
      stateDir, logsDir, emitAttention: emit, log: () => {},
    });
    expect(boot1.firstBoot).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'state', 'guard-posture.json'))).toBe(true);

    // Operator hand-edit between boots (the incident shape).
    // Boot 2 — two guards off.
    const boot2 = await runGuardPostureTripwire({
      config: { monitoring: { contextWedgeSentinel: { enabled: false }, failureLearning: { enabled: false } }, scheduler: { enabled: true } },
      stateDir, logsDir, emitAttention: emit, log: () => {},
    });
    expect(boot2.disabled).toEqual([
      'monitoring.contextWedgeSentinel.enabled',
      'monitoring.failureLearning.enabled',
    ]);
    expect(boot2.attentionEmitted).toBe(true);
    expect(emitted).toHaveLength(1); // aggregated, never per-guard

    const rows = fs.readFileSync(path.join(logsDir, 'guard-posture.jsonl'), 'utf-8')
      .trim().split('\n').map(l => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('guard-posture-change');
    expect(rows[0].disabled).toHaveLength(2);
  });
});

describe('GuardPostureTripwire E2E — WIRED into server.ts (dead-code guard)', () => {
  const serverSrc = fs.readFileSync(
    path.join(process.cwd(), 'src/commands/server.ts'),
    'utf-8',
  );

  it('server.ts runs the tripwire at boot', () => {
    expect(serverSrc).toContain('runGuardPostureTripwire(');
  });

  it('server.ts passes the Telegram attention callback when available', () => {
    const block = serverSrc.slice(serverSrc.indexOf('GuardPostureTripwire'));
    expect(block).toContain('createAttentionItem');
  });

  it('server.ts surfaces a disabled-guard boot line', () => {
    expect(serverSrc).toContain('Guard-posture tripwire');
  });
});
