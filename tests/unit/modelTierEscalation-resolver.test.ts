/**
 * §5.1 resolver unit tests — Model-Tier Escalation Policy
 * (spec: docs/specs/FABLE-MODEL-ESCALATION-SPEC.md §11 Unit bullet).
 *
 * The load-bearing contracts:
 *  - escalated:null ⇒ resolves to default ⇒ NO swap (backwards-compat).
 *  - unknown framework ⇒ null ⇒ no-op.
 *  - malicious/malformed ids (newline, `;`, `Enter`, >64 chars) ⇒ rejected,
 *    fail-closed, audited with escaped+truncated id.
 *  - the per-component routing surfaces cannot select the escalated id.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TIER_ESCALATION_CONFIG,
  KNOWN_CLAUDE_MODEL_IDS,
  KNOWN_MODEL_IDS,
  MODEL_ID_RE,
  SWAP_CAPABILITY,
  escalatedModelIds,
  escapeIdForAudit,
  hasEscalatedModel,
  isWithinFreeWindow,
  normalizeTierEscalationConfig,
  resolveTierModel,
  type ResolveAuditEvent,
  type TierEscalationConfig,
} from '../../src/core/ModelTierEscalation.js';

function cfgWith(overrides: Partial<TierEscalationConfig>): TierEscalationConfig {
  return normalizeTierEscalationConfig({ ...DEFAULT_TIER_ESCALATION_CONFIG, ...overrides });
}

describe('resolveTierModel — §5.1', () => {
  const cfg = DEFAULT_TIER_ESCALATION_CONFIG;

  it('resolves claude-code escalated → claude-fable-5 (first populated entry)', () => {
    expect(resolveTierModel('claude-code', 'escalated', cfg)).toBe('claude-fable-5');
  });

  it('resolves claude-code default → claude-opus-4-8', () => {
    expect(resolveTierModel('claude-code', 'default', cfg)).toBe('claude-opus-4-8');
  });

  it('escalated:null resolves to default ⇒ no swap (backwards-compat contract)', () => {
    const c = cfgWith({
      frameworks: { 'claude-code': { default: 'claude-opus-4-8', escalated: null } },
    });
    expect(resolveTierModel('claude-code', 'escalated', c)).toBe('claude-opus-4-8');
    expect(hasEscalatedModel('claude-code', c)).toBe(false);
    expect(escalatedModelIds(c).size).toBe(0);
  });

  it('default:null + escalated:null (codex/gemini/pi defaults) ⇒ null ⇒ account default, strict no-op', () => {
    for (const fw of ['codex-cli', 'gemini-cli', 'pi-cli']) {
      expect(resolveTierModel(fw, 'default', cfg)).toBeNull();
      expect(resolveTierModel(fw, 'escalated', cfg)).toBeNull();
      expect(hasEscalatedModel(fw, cfg)).toBe(false);
    }
  });

  it('unknown framework ⇒ null ⇒ no-op (enum-guarded)', () => {
    const events: ResolveAuditEvent[] = [];
    expect(resolveTierModel('rogue-cli', 'escalated', cfg, e => events.push(e))).toBeNull();
    expect(events).toEqual([{ framework: 'rogue-cli', tier: 'escalated', reason: 'unknown-framework' }]);
  });

  it('absent framework entry ⇒ null, audited', () => {
    const c = cfgWith({ frameworks: {} as never });
    // normalize backfills defaults; bypass it to test the raw path
    const raw: TierEscalationConfig = { ...c, frameworks: {} };
    const events: ResolveAuditEvent[] = [];
    expect(resolveTierModel('claude-code', 'escalated', raw, e => events.push(e))).toBeNull();
    expect(events[0]?.reason).toBe('no-framework-entry');
  });

  it('prototype-pollution keys cannot smuggle an entry (own-property lookup)', () => {
    const polluted = JSON.parse(
      '{"frameworks": {}}',
    ) as TierEscalationConfig;
    // simulate Object.prototype pollution
    const proto = Object.prototype as unknown as Record<string, unknown>;
    proto['claude-code'] = { default: 'claude-fable-5', escalated: 'claude-fable-5' };
    try {
      expect(resolveTierModel('claude-code', 'escalated', polluted)).toBeNull();
    } finally {
      delete proto['claude-code'];
    }
  });

  describe('malicious / malformed ids fail closed (Sec-F1/F2)', () => {
    const malicious = [
      'claude-fable-5\nEnter',
      'claude; rm -rf /',
      'claude-fable-5 Enter',
      'a'.repeat(65),
      '',
      'claude/fable', // slash — also why pi-cli provider/id patterns are refused
      '/model claude-fable-5',
      'claude`id`',
      'claude$PATH',
      'claude\rfable',
      'модель', // non-ASCII
    ];
    for (const bad of malicious) {
      it(`rejects ${JSON.stringify(bad.slice(0, 30))}`, () => {
        const c = cfgWith({
          frameworks: { 'claude-code': { default: 'claude-opus-4-8', escalated: bad } },
        });
        const events: ResolveAuditEvent[] = [];
        expect(resolveTierModel('claude-code', 'escalated', c, e => events.push(e))).toBeNull();
        expect(events).toHaveLength(1);
        expect(events[0].reason).toBe(bad && MODEL_ID_RE.test(bad) ? 'id-not-in-closed-enum' : 'invalid-id-shape');
        // audit must never carry an unescaped/unbounded raw value
        if (events[0].rejectedId) {
          expect(events[0].rejectedId).not.toContain('\n');
          expect(events[0].rejectedId.length).toBeLessThanOrEqual(80 + '…(truncated)'.length);
        }
      });
    }
  });

  it('a well-shaped id OUTSIDE the closed enum is rejected (closed enumeration)', () => {
    const c = cfgWith({
      frameworks: { 'claude-code': { default: 'claude-opus-4-8', escalated: 'claude-fable-6' } },
    });
    const events: ResolveAuditEvent[] = [];
    expect(resolveTierModel('claude-code', 'escalated', c, e => events.push(e))).toBeNull();
    expect(events[0]?.reason).toBe('id-not-in-closed-enum');
    expect(events[0]?.rejectedId).toBe('claude-fable-6');
  });

  it('pi-cli enum is CLOSED-EMPTY — no pi id can ever resolve (§5.6 strict no-op)', () => {
    expect(KNOWN_MODEL_IDS['pi-cli']).toEqual([]);
    const c = cfgWith({
      frameworks: { 'pi-cli': { default: null, escalated: 'gpt-5.5' } },
    });
    expect(resolveTierModel('pi-cli', 'escalated', c)).toBeNull();
  });

  it('undefined config fails closed to null everywhere', () => {
    expect(resolveTierModel('claude-code', 'escalated', undefined)).toBeNull();
  });
});

describe('closed enums + capability declarations', () => {
  it('claude-fable-5 and claude-opus-4-8 are in the claude closed enum', () => {
    expect(KNOWN_CLAUDE_MODEL_IDS).toContain('claude-fable-5');
    expect(KNOWN_CLAUDE_MODEL_IDS).toContain('claude-opus-4-8');
  });

  it('declares swap capability per adapter (§5.6) — claude mid-session, others launch-time-only', () => {
    expect(SWAP_CAPABILITY['claude-code']).toBe('mid-session');
    expect(SWAP_CAPABILITY['codex-cli']).toBe('launch-time-only');
    expect(SWAP_CAPABILITY['gemini-cli']).toBe('launch-time-only');
    expect(SWAP_CAPABILITY['pi-cli']).toBe('launch-time-only');
  });
});

describe('§3/§11 — per-component routing surfaces cannot select the escalated id', () => {
  it('anthropic-headless tier maps exclude claude-fable-5', async () => {
    const mod = await import('../../src/providers/adapters/anthropic-headless/models.js');
    const values = JSON.stringify(mod);
    expect(values).not.toContain('claude-fable-5');
  });

  it('openai-codex + gemini tier maps exclude claude-fable-5', async () => {
    const codex = await import('../../src/providers/adapters/openai-codex/models.js');
    const gemini = await import('../../src/providers/adapters/gemini-cli/models.js');
    expect(JSON.stringify(codex)).not.toContain('claude-fable-5');
    expect(JSON.stringify(gemini)).not.toContain('claude-fable-5');
  });

  it('the interactive-launch tier resolver never maps a TIER to the escalated id', async () => {
    const { resolveModelForFramework } = await import('../../src/core/frameworkSessionLaunch.js');
    for (const tier of ['fast', 'balanced', 'capable', 'haiku', 'sonnet', 'opus']) {
      for (const fw of ['claude-code', 'codex-cli', 'gemini-cli', 'pi-cli'] as const) {
        expect(resolveModelForFramework(fw, tier)).not.toBe('claude-fable-5');
      }
    }
  });
});

describe('isWithinFreeWindow — §8 UTC-date semantics, inclusive through the named day', () => {
  const guards = { ...DEFAULT_TIER_ESCALATION_CONFIG.costGuards, respectFreeWindows: { 'claude-fable-5': '2026-06-22' } };

  it('open during and on the named UTC day', () => {
    expect(isWithinFreeWindow('claude-fable-5', guards, Date.parse('2026-06-10T12:00:00Z'))).toBe(true);
    expect(isWithinFreeWindow('claude-fable-5', guards, Date.parse('2026-06-22T23:59:59Z'))).toBe(true);
  });

  it('closed from the next UTC day', () => {
    expect(isWithinFreeWindow('claude-fable-5', guards, Date.parse('2026-06-23T00:00:00Z'))).toBe(false);
  });

  it('unlisted model / malformed date ⇒ not in window', () => {
    expect(isWithinFreeWindow('claude-opus-4-8', guards, Date.parse('2026-06-10T00:00:00Z'))).toBe(false);
    const bad = { ...guards, respectFreeWindows: { 'claude-fable-5': 'June 22' } };
    expect(isWithinFreeWindow('claude-fable-5', bad, Date.parse('2026-06-10T00:00:00Z'))).toBe(false);
  });
});

describe('normalizeTierEscalationConfig', () => {
  it('absent/garbage raw ⇒ full §9 defaults (enabled:false, dryRun:true)', () => {
    for (const raw of [undefined, null, 42, 'x', []]) {
      const c = normalizeTierEscalationConfig(raw);
      expect(c.enabled).toBe(false);
      expect(c.dryRun).toBe(true);
      expect(c.costGuards.maxEscalationsPerHour).toBe(8);
      expect(c.frameworks['claude-code']?.escalated).toBe('claude-fable-5');
    }
  });

  it('operator enabled/dryRun are preserved, missing fields backfilled', () => {
    const c = normalizeTierEscalationConfig({ enabled: true, dryRun: false });
    expect(c.enabled).toBe(true);
    expect(c.dryRun).toBe(false);
    expect(c.costGuards.maxConcurrentEscalatedPerAccount).toBe(2);
  });
});

describe('escapeIdForAudit', () => {
  it('escapes control characters and truncates past 80 chars', () => {
    expect(escapeIdForAudit('a\nb')).toBe('a\\nb');
    const long = escapeIdForAudit('x'.repeat(200));
    expect(long.endsWith('…(truncated)')).toBe(true);
  });
});
