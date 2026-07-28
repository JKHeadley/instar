/**
 * §7/§8 EscalationGovernor unit tests
 * (spec: docs/specs/FABLE-MODEL-ESCALATION-SPEC.md §11 Unit bullet).
 *
 * Load-bearing contracts:
 *  - quota unavailable/errored ⇒ fail CLOSED (refuse).
 *  - lease is crash-safe: TTL expiry + dead-holder reclaim + release-on-reap;
 *    a hard-crashed escalated session can never permanently wedge a slot.
 *  - hourly budget counts once per (instance, transition) episode; canary
 *    retries never multiply the count (accounting fails toward counting).
 *  - free-window expiry emits exactly ONE audit note (no silent cost cliff).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  EscalationGovernor,
  QUOTA_HEADROOM_MAX_UTILIZATION_PCT,
  type QuotaSnapshotLike,
} from '../../src/core/EscalationGovernor.js';
import {
  DEFAULT_TIER_ESCALATION_CONFIG,
  normalizeTierEscalationConfig,
  type TierEscalationConfig,
} from '../../src/core/ModelTierEscalation.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const BASE = Date.parse('2026-06-10T12:00:00Z');

function enabledCfg(overrides?: Partial<TierEscalationConfig['costGuards']>): TierEscalationConfig {
  const cfg = normalizeTierEscalationConfig({ ...DEFAULT_TIER_ESCALATION_CONFIG, enabled: true });
  // Default unit posture: no quota requirement unless the test opts in.
  cfg.costGuards = { ...cfg.costGuards, requireQuotaHeadroom: false, ...(overrides ?? {}) };
  return cfg;
}

describe('EscalationGovernor', () => {
  let stateDir: string;
  let nowMs: number;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-esc-gov-'));
    nowMs = BASE;
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(stateDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/escalationGovernor.test.ts:cleanup',
    });
  });

  function governor(opts?: {
    cfg?: TierEscalationConfig;
    quota?: (accountId: string) => QuotaSnapshotLike | null;
    ultraToday?: () => number | null;
    isHolderLive?: (id: string) => boolean;
  }): EscalationGovernor {
    return new EscalationGovernor({
      stateDir,
      getConfig: () => opts?.cfg ?? enabledCfg(),
      quotaSnapshot: opts?.quota,
      ultraTokensTodayUtc: opts?.ultraToday,
      isHolderLive: opts?.isHolderLive,
      now: () => nowMs,
    });
  }

  const admitInput = (instanceId: string) => ({
    instanceId,
    modelId: 'claude-fable-5',
    transition: 'default→escalated',
  });

  it('refuses when disabled (enabled:false wins, fail-closed)', () => {
    const g = governor({ cfg: normalizeTierEscalationConfig(DEFAULT_TIER_ESCALATION_CONFIG) });
    expect(g.admitEscalation(admitInput('s1'))).toEqual({ allow: false, reason: 'disabled' });
  });

  it('refuses without an instance id', () => {
    const g = governor();
    expect(g.admitEscalation(admitInput('')).reason).toBe('no-instance-id');
  });

  describe('lease (§7)', () => {
    it('caps concurrent escalated sessions per account', () => {
      const g = governor();
      expect(g.admitEscalation(admitInput('s1')).allow).toBe(true);
      expect(g.admitEscalation(admitInput('s2')).allow).toBe(true);
      expect(g.admitEscalation(admitInput('s3'))).toMatchObject({ allow: false, reason: 'lease-capacity' });
    });

    it('re-admission of the SAME instance is idempotent (no extra slot consumed)', () => {
      const g = governor();
      expect(g.admitEscalation(admitInput('s1')).allow).toBe(true);
      expect(g.admitEscalation(admitInput('s1')).allow).toBe(true);
      expect(g.activeLeases()).toHaveLength(1);
    });

    it('release on session reap frees the slot', () => {
      const g = governor();
      g.admitEscalation(admitInput('s1'));
      g.admitEscalation(admitInput('s2'));
      g.releaseLease('s1');
      expect(g.admitEscalation(admitInput('s3')).allow).toBe(true);
    });

    it('CRASH-SAFETY: a TTL-expired lease is reclaimed lazily — no permanent wedge', () => {
      const g = governor();
      g.admitEscalation(admitInput('s1'));
      g.admitEscalation(admitInput('s2'));
      // hard crash: no release ever happens; advance past maxEscalationTtlMs
      nowMs += DEFAULT_TIER_ESCALATION_CONFIG.costGuards.maxEscalationTtlMs + 1;
      expect(g.admitEscalation(admitInput('s3')).allow).toBe(true);
    });

    it('CRASH-SAFETY: a lease whose holder is not live is reclaimable before TTL', () => {
      const live = new Set(['s1', 's2', 's3']);
      const g = governor({ isHolderLive: id => live.has(id) });
      g.admitEscalation(admitInput('s1')); // will die
      g.admitEscalation(admitInput('s2'));
      live.delete('s1'); // s1 hard-crashed
      expect(g.admitEscalation(admitInput('s3')).allow).toBe(true);
      const holders = g.activeLeases().map(l => l.instanceId).sort();
      expect(holders).toEqual(['s2', 's3']);
    });

    it('survives process restart (file-backed state)', () => {
      governor().admitEscalation(admitInput('s1'));
      const g2 = governor(); // fresh instance, same stateDir
      expect(g2.activeLeases().map(l => l.instanceId)).toEqual(['s1']);
    });
  });

  describe('hourly budget — once per (instance, transition) episode (§8)', () => {
    it('exhausts after maxEscalationsPerHour distinct episodes', () => {
      const cfg = enabledCfg({ maxEscalationsPerHour: 2, maxConcurrentEscalatedPerAccount: 100 });
      const g = governor({ cfg });
      g.recordInjection('s1', 'default→escalated');
      g.recordInjection('s2', 'default→escalated');
      expect(g.admitEscalation(admitInput('s3'))).toMatchObject({ allow: false, reason: 'hourly-budget-exhausted' });
    });

    it('canary retries within one episode never multiply the count', () => {
      const cfg = enabledCfg({ maxEscalationsPerHour: 2, maxConcurrentEscalatedPerAccount: 100 });
      const g = governor({ cfg });
      expect(g.recordInjection('s1', 'default→escalated')).toBe(true);
      // N canary retries re-record the same episode
      expect(g.recordInjection('s1', 'default→escalated')).toBe(false);
      expect(g.recordInjection('s1', 'default→escalated')).toBe(false);
      // budget still has room for a second DISTINCT episode
      expect(g.admitEscalation(admitInput('s2')).allow).toBe(true);
    });

    it('an already-counted episode is re-admitted even at budget (idempotent admission)', () => {
      const cfg = enabledCfg({ maxEscalationsPerHour: 1, maxConcurrentEscalatedPerAccount: 100 });
      const g = governor({ cfg });
      g.admitEscalation(admitInput('s1'));
      g.recordInjection('s1', 'default→escalated');
      // same episode re-derived next turn — must not refuse
      expect(g.admitEscalation(admitInput('s1')).allow).toBe(true);
      // but a NEW episode is over budget
      expect(g.admitEscalation(admitInput('s2')).reason).toBe('hourly-budget-exhausted');
    });

    it('episodes age out of the hourly window', () => {
      const cfg = enabledCfg({ maxEscalationsPerHour: 1, maxConcurrentEscalatedPerAccount: 100 });
      const g = governor({ cfg });
      g.recordInjection('s1', 'default→escalated');
      nowMs += 3_600_001;
      expect(g.admitEscalation(admitInput('s2')).allow).toBe(true);
    });
  });

  describe('quota headroom — fail closed (§7)', () => {
    it('quota unavailable ⇒ refuse', () => {
      const cfg = enabledCfg({ requireQuotaHeadroom: true });
      const g = governor({ cfg, quota: () => null });
      expect(g.admitEscalation(admitInput('s1'))).toMatchObject({ allow: false, reason: 'quota-unavailable' });
    });

    it('quota provider missing entirely ⇒ refuse', () => {
      const cfg = enabledCfg({ requireQuotaHeadroom: true });
      const g = governor({ cfg });
      expect(g.admitEscalation(admitInput('s1')).reason).toBe('quota-unavailable');
    });

    it('quota provider THROWS ⇒ refuse (errored = unavailable)', () => {
      const cfg = enabledCfg({ requireQuotaHeadroom: true });
      const g = governor({ cfg, quota: () => { throw new Error('boom'); } });
      expect(g.admitEscalation(admitInput('s1')).reason).toBe('quota-unavailable');
    });

    it('capped account ⇒ refuse; healthy account ⇒ admit', () => {
      const cfg = enabledCfg({ requireQuotaHeadroom: true });
      const capped = governor({
        cfg,
        quota: () => ({ fiveHour: { utilizationPct: QUOTA_HEADROOM_MAX_UTILIZATION_PCT } }),
      });
      expect(capped.admitEscalation(admitInput('s1')).reason).toBe('quota-capped');
      const healthy = governor({
        cfg,
        quota: () => ({ fiveHour: { utilizationPct: 40 }, sevenDay: { utilizationPct: 55 } }),
      });
      expect(healthy.admitEscalation(admitInput('s2')).allow).toBe(true);
    });
  });

  describe('daily ultra-token cap as admission control (§8)', () => {
    it('cap crossed ⇒ refuse new escalations', () => {
      const cfg = enabledCfg({ dailyUltraTokenCap: 1_000_000 });
      const g = governor({ cfg, ultraToday: () => 1_000_001 });
      expect(g.admitEscalation(admitInput('s1')).reason).toBe('daily-cap-exhausted');
    });

    it('cap configured but spend unreadable ⇒ refuse (fail closed)', () => {
      const cfg = enabledCfg({ dailyUltraTokenCap: 1_000_000 });
      const g = governor({ cfg, ultraToday: () => null });
      expect(g.admitEscalation(admitInput('s1')).reason).toBe('daily-cap-exhausted');
    });

    it('cap null (default) ⇒ no daily-cap admission check', () => {
      const g = governor({ ultraToday: () => null });
      expect(g.admitEscalation(admitInput('s1')).allow).toBe(true);
    });
  });

  describe('free windows (§8)', () => {
    it('reports freeWindow:true inside the window', () => {
      const g = governor();
      expect(g.admitEscalation(admitInput('s1')).freeWindow).toBe(true); // 2026-06-10 < 2026-06-22
    });

    it('emits exactly ONE audit note when the window expires (no silent cost cliff)', () => {
      nowMs = Date.parse('2026-06-23T01:00:00Z'); // past the window
      const g = governor();
      g.admitEscalation(admitInput('s1'));
      g.admitEscalation(admitInput('s2'));
      const audit = fs.readFileSync(
        path.join(stateDir, 'state', 'model-tier-escalation', 'audit.jsonl'),
        'utf-8',
      );
      const notes = audit.split('\n').filter(l => l.includes('free-window-expired'));
      expect(notes).toHaveLength(1);
    });
  });

  it('audit records carry structured fields only (no raw operator text field)', () => {
    const g = governor();
    g.admitEscalation(admitInput('s1'));
    const audit = fs.readFileSync(
      path.join(stateDir, 'state', 'model-tier-escalation', 'audit.jsonl'),
      'utf-8',
    ).trim().split('\n').map(l => JSON.parse(l));
    for (const entry of audit) {
      expect(Object.keys(entry).sort()).toEqual(
        expect.not.arrayContaining(['prompt', 'text', 'turnText']),
      );
      expect(typeof entry.ts).toBe('string');
    }
  });
});
