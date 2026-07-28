/**
 * Wiring-integrity test for live-matrix finding A1 (2026-06-06):
 *
 * The quota COLLECTOR (which WRITES quota-state.json) and the QuotaManager that
 * drives its adaptive polling were nested inside the
 * `if (telegramConfig && !skipTelegram && !isStandbyTelegram && !lifelineOwnsPolling)`
 * server-owns-Telegram-polling block. On any agent whose LIFELINE owns polling
 * (the normal production topology — echo logs "lifeline owns polling"), that
 * block is skipped, so the collector never started, quota-state.json was never
 * written, and quota-aware placement (#804) stayed permanently fail-open — the
 * exact EXO rate-limit-stall hazard it exists to prevent.
 *
 * This test structurally guarantees the pipeline lives OUTSIDE that block, so a
 * future refactor can't silently re-nest it. (Source-structure assertion — the
 * same technique session-pool-activation-wiring.test.ts uses, because the boot
 * path is one monolithic async function not unit-instantiable in isolation.)
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SERVER = path.join(process.cwd(), 'src/commands/server.ts');

describe('A1 — quota collector runs independent of Telegram-polling ownership', () => {
  const src = fs.readFileSync(SERVER, 'utf-8');

  it('quotaManager.start() is reached OUTSIDE (before) the !lifelineOwnsPolling Telegram block', () => {
    const startIdx = src.indexOf('quotaManager.start()');
    const blockIdx = src.indexOf('if (telegramConfig && !skipTelegram && !isStandbyTelegram && !lifelineOwnsPolling)');
    expect(startIdx).toBeGreaterThan(0);
    expect(blockIdx).toBeGreaterThan(0);
    // The collector pipeline must run before the polling-ownership gate, so a
    // send-only (lifeline-owns-polling) server still collects quota.
    expect(startIdx).toBeLessThan(blockIdx);
  });

  it('the collector pipeline is gated only on quotaTracker, with the A1 rationale recorded', () => {
    expect(src).toContain('finding A1');
    // The construction must sit after the scheduler exists (migration wiring is
    // real) but its only runtime gate is the tracker. Anchor on the actual
    // construction line, not the doc comment.
    const ctorIdx = src.indexOf('const accountSwitcher = new AccountSwitcher();');
    const schedIdx = src.indexOf('scheduler = new JobScheduler(');
    expect(ctorIdx).toBeGreaterThan(0);
    expect(schedIdx).toBeGreaterThan(0);
    expect(ctorIdx).toBeGreaterThan(schedIdx);
  });

  it('does NOT re-construct the QuotaManager a second time inside the Telegram block (no double-start)', () => {
    const occurrences = src.split('quotaManager = new QuotaManager(').length - 1;
    expect(occurrences).toBe(1);
  });
});
