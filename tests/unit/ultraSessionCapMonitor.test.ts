/**
 * §8 UltraSessionCapMonitor unit tests — mid-run daily-cap visibility
 * (spec: docs/specs/FABLE-MODEL-ESCALATION-SPEC.md §8 / §11).
 *
 * Load-bearing contracts:
 *  - cap crossing raises ONE HIGH Attention item per (session-instance, UTC
 *    day) — never once per tick (round-3 Adversarial-NEW-7);
 *  - cap null (default) / no ledger / no escalated ids ⇒ strict no-op;
 *  - rides BurnDetector's tick (wiring pinned) — no own poller.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UltraSessionCapMonitor,
  startOfUtcDayMs,
  type UltraCapAttentionItem,
} from '../../src/monitoring/UltraSessionCapMonitor.js';
import {
  DEFAULT_TIER_ESCALATION_CONFIG,
  normalizeTierEscalationConfig,
  type TierEscalationConfig,
} from '../../src/core/ModelTierEscalation.js';
import type { Session } from '../../src/core/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function ultraSession(overrides?: Partial<Session>): Session {
  return {
    id: 'inst-9',
    name: 'build-model-tier',
    status: 'running',
    tmuxSession: 'proj-build-model-tier',
    startedAt: new Date().toISOString(),
    framework: 'claude-code',
    model: 'claude-fable-5',
    claudeSessionId: 'claude-uuid-9',
    ...overrides,
  };
}

describe('UltraSessionCapMonitor', () => {
  let cfg: TierEscalationConfig;
  let sessions: Session[];
  let tokensBySession: Record<string, number>;
  let queries: string[];
  let attention: UltraCapAttentionItem[];
  let nowMs: number;

  beforeEach(() => {
    cfg = normalizeTierEscalationConfig({
      ...DEFAULT_TIER_ESCALATION_CONFIG,
      enabled: true,
    });
    cfg.costGuards.dailyUltraTokenCap = 1_000_000;
    sessions = [ultraSession()];
    tokensBySession = { 'claude-uuid-9': 2_000_000 };
    queries = [];
    attention = [];
    nowMs = Date.parse('2026-06-10T15:00:00Z');
  });

  function monitor(ledgerNull = false): UltraSessionCapMonitor {
    return new UltraSessionCapMonitor({
      ledger: ledgerNull
        ? null
        : {
            sessionActivitySince: (sessionId, sinceMs) => {
              queries.push(`${sessionId}@${sinceMs}`);
              return { tokens: tokensBySession[sessionId] ?? 0 };
            },
          },
      listRunningSessions: () => sessions,
      getConfig: () => cfg,
      attention: item => attention.push(item),
      now: () => nowMs,
    });
  }

  it('raises ONE HIGH item per (instance, UTC day) — repeated ticks never re-fire', () => {
    const m = monitor();
    m.tick();
    m.tick();
    m.tick();
    expect(attention).toHaveLength(1);
    expect(attention[0].priority).toBe('HIGH');
    expect(attention[0].id).toBe('model-tier-ultra-cap-inst-9-2026-06-10');
  });

  it('a NEW UTC day re-arms the alert (fresh dedup key)', () => {
    const m = monitor();
    m.tick();
    nowMs += 24 * 60 * 60 * 1000;
    m.tick();
    expect(attention).toHaveLength(2);
    expect(attention[1].id).toBe('model-tier-ultra-cap-inst-9-2026-06-11');
  });

  it('queries token attribution from the start of the UTC day', () => {
    monitor().tick();
    expect(queries).toEqual([`claude-uuid-9@${Date.parse('2026-06-10T00:00:00Z')}`]);
  });

  it('under the cap ⇒ silent', () => {
    tokensBySession['claude-uuid-9'] = 999_999;
    monitor().tick();
    expect(attention).toHaveLength(0);
  });

  it('cap null (default), null ledger, non-escalated model, missing claudeSessionId ⇒ strict no-op', () => {
    cfg.costGuards.dailyUltraTokenCap = null;
    monitor().tick();
    cfg.costGuards.dailyUltraTokenCap = 1_000_000;
    monitor(true).tick(); // null ledger
    sessions = [ultraSession({ model: 'claude-opus-4-8' })]; // default-tier session
    monitor().tick();
    sessions = [ultraSession({ claudeSessionId: undefined })]; // unattributable
    monitor().tick();
    expect(attention).toHaveLength(0);
  });

  it('escalated:null frameworks produce no ultra ids ⇒ no-op even with a cap', () => {
    cfg.frameworks['claude-code'] = { default: 'claude-opus-4-8', escalated: null };
    monitor().tick();
    expect(attention).toHaveLength(0);
    expect(queries).toHaveLength(0);
  });

  it('startOfUtcDayMs is UTC-midnight, not local', () => {
    expect(startOfUtcDayMs(Date.parse('2026-06-10T23:59:59.999Z'))).toBe(Date.parse('2026-06-10T00:00:00Z'));
  });
});

describe('wiring pin — rides BurnDetector tick, no own poller', () => {
  it('BurnDetector invokes ultraCapMonitor.tick() before its early-returns', async () => {
    const { BurnDetector } = await import('../../src/monitoring/BurnDetector.js');
    let ticks = 0;
    const detector = new BurnDetector({
      ledger: { byAttributionKey: () => [], summary: () => ({}) } as never,
      reporter: { report: () => {} },
      ultraCapMonitor: { tick: () => { ticks++; } },
    });
    detector.tick(); // empty ledger — the monitor must STILL have run
    expect(ticks).toBe(1);
  });

  it('UltraSessionCapMonitor has no setInterval of its own (no new poller)', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'monitoring', 'UltraSessionCapMonitor.ts'),
      'utf-8',
    );
    expect(src).not.toContain('setInterval');
  });
});
