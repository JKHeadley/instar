/**
 * Tier-1 unit tests for the attention lifecycle rules
 * (docs/specs/attention-lifecycle-close-on-cause.md §3.1 / §3.4): condition
 * identity, expiry classes, reopen rules, supersession planning. Pure logic.
 */
import { describe, it, expect } from 'vitest';
import {
  attentionConditionKeyOf, attentionIdSkeleton, classifyAttentionLifecycle, decideAttentionExpiry,
  mayReopenInPlace, planAttentionSupersessions, resolveAttentionLifecycleConfig, ATTENTION_LIFECYCLE_DEFAULTS,
  type AttentionLifecycleItem,
} from '../../src/core/AttentionLifecycle.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-25T12:00:00Z');
const cfg = resolveAttentionLifecycleConfig(undefined);

function row(over: Partial<AttentionLifecycleItem> & { id: string }): AttentionLifecycleItem {
  // Age is measured from the LAST touch, so a row's createdAt must not be
  // newer than the updatedAt a test backdates.
  const created = over.updatedAt ?? new Date(NOW - 20 * DAY).toISOString();
  return { title: 'T', category: 'general', priority: 'NORMAL', status: 'OPEN', createdAt: created, updatedAt: created, ...over };
}

describe('id skeleton — only per-episode tokens are blanked', () => {
  it('blanks ISO datetimes, epoch ms/s, ep-N and dotted attempt suffixes', () => {
    expect(attentionIdSkeleton('telegram-origin-held:12345:1761400000000')).toBe('telegram-origin-held:12345:#');
    expect(attentionIdSkeleton('credential-identity-drift-acct-2026-10-01T10:00:00.000Z')).toBe('credential-identity-drift-acct-#');
    expect(attentionIdSkeleton('stale-owner-release:ambiguity:m_abc:owner:ep-7')).toBe('stale-owner-release:ambiguity:m_abc:owner:ep#');
    expect(attentionIdSkeleton('dup-reconciler-echo:2026-10-25T17')).toBe('dup-reconciler-echo:#');
    expect(attentionIdSkeleton('subscription-relogin-x-suggested-1.r2.o1')).toBe('subscription-relogin-x-suggested');
    expect(attentionIdSkeleton('foo-1761400000')).toBe('foo-#');
  });
  it('keeps topic ids, CMT ids, machine ids, UUIDs and hex runs (they can be the thing that needs action)', () => {
    expect(attentionIdSkeleton('standdown-latched:49701')).toBe('standdown-latched:49701');
    expect(attentionIdSkeleton('promise-escalation:CMT-123')).toBe('promise-escalation:CMT-123');
    expect(attentionIdSkeleton('stale-owner:m_cc2ec651a91f03f85abb19bfe5e7e8f7-1')).toBe('stale-owner:m_cc2ec651a91f03f85abb19bfe5e7e8f7-1');
    const a = attentionIdSkeleton('telegram-origin-held:1:expired:0b2d5d1e-2c3f-4a5b-8c6d-0e1f2a3b4c5d');
    const b = attentionIdSkeleton('telegram-origin-held:1:expired:1b2d5d1e-2c3f-4a5b-8c6d-0e1f2a3b4c5e');
    expect(a).not.toBe(b);
  });
});

describe('condition key', () => {
  it('a producer key wins over derivation', () => {
    expect(attentionConditionKeyOf({ id: 'x-123', title: 'A', category: 'c', conditionKey: ' sign-in:acct:m1 ' })).toBe('k:sign-in:acct:m1');
  });
  it('same source/category/title and the same stable id part → one key; different title or topic → different keys', () => {
    const a = attentionConditionKeyOf({ id: 'held:777:1761400000000', title: 'Reply held', category: 'telegram-origin', sourceContext: 'origin' });
    const b = attentionConditionKeyOf({ id: 'held:777:1761500000000', title: 'reply  HELD ', category: 'telegram-origin', sourceContext: 'origin' });
    const c = attentionConditionKeyOf({ id: 'held:778:1761500000000', title: 'Reply held', category: 'telegram-origin', sourceContext: 'origin' });
    const d = attentionConditionKeyOf({ id: 'held:777:1761500000000', title: 'Reply held for account 2', category: 'telegram-origin', sourceContext: 'origin' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
  });
});

describe('class + expiry', () => {
  it('security never expires, however old — matched on category, source or title, or sticky', () => {
    for (const r of [
      row({ id: 's1', category: 'security', updatedAt: new Date(NOW - 400 * DAY).toISOString() }),
      row({ id: 's2', title: 'Rotate exposed GitHub access token', updatedAt: new Date(NOW - 400 * DAY).toISOString() }),
      row({ id: 's3', sticky: true, updatedAt: new Date(NOW - 400 * DAY).toISOString() }),
    ]) {
      const d = decideAttentionExpiry(r, cfg, NOW);
      expect(d.cls).toBe('security');
      expect(d.expire).toBe(false);
    }
  });
  it('operator-asked (agent-raised / needsUser / decision category / URGENT) expires at 30 days, not 14', () => {
    const at = (days: number) => new Date(NOW - days * DAY).toISOString();
    const agent = row({ id: 'a1', sourceContext: 'agent', updatedAt: at(20) });
    expect(classifyAttentionLifecycle(agent)).toBe('operator-asked');
    expect(decideAttentionExpiry(agent, cfg, NOW).expire).toBe(false);
    expect(decideAttentionExpiry(row({ id: 'a1', sourceContext: 'agent', updatedAt: at(31) }), cfg, NOW)).toMatchObject({ expire: true, cls: 'operator-asked' });
    expect(classifyAttentionLifecycle(row({ id: 'n', needsUser: true }))).toBe('operator-asked');
    expect(classifyAttentionLifecycle(row({ id: 'd', category: 'decision' }))).toBe('operator-asked');
    expect(classifyAttentionLifecycle(row({ id: 'u', priority: 'URGENT' }))).toBe('operator-asked');
    expect(classifyAttentionLifecycle(row({ id: 'r', sourceContext: 'assisted-subscription-relogin', priority: 'HIGH' }))).toBe('operator-asked');
  });
  it('automated expires after 14 untouched days, measured from the last touch (updatedAt or lastSeenAt)', () => {
    const old = row({ id: 'x', sourceContext: 'rope-health', updatedAt: new Date(NOW - 15 * DAY).toISOString() });
    expect(decideAttentionExpiry(old, cfg, NOW)).toMatchObject({ expire: true, cls: 'automated' });
    expect(decideAttentionExpiry(old, cfg, NOW).resolution).toMatch(/expired: never confirmed cleared; untouched for 14 days/);
    const seen = { ...old, lastSeenAt: new Date(NOW - 2 * DAY).toISOString() };
    expect(decideAttentionExpiry(seen, cfg, NOW).expire).toBe(false);
    expect(decideAttentionExpiry({ ...old, updatedAt: new Date(NOW - 13 * DAY).toISOString() }, cfg, NOW).expire).toBe(false);
  });
  it('ACKNOWLEDGED / IN_PROGRESS / closed rows, active conditions and unparseable dates never expire', () => {
    const old = new Date(NOW - 100 * DAY).toISOString();
    expect(decideAttentionExpiry(row({ id: '1', status: 'ACKNOWLEDGED', updatedAt: old }), cfg, NOW).expire).toBe(false);
    expect(decideAttentionExpiry(row({ id: '2', status: 'IN_PROGRESS', updatedAt: old }), cfg, NOW).expire).toBe(false);
    expect(decideAttentionExpiry(row({ id: '3', status: 'DONE', updatedAt: old }), cfg, NOW).expire).toBe(false);
    expect(decideAttentionExpiry(row({ id: '4', updatedAt: old }), cfg, NOW, { conditionActive: true }).expire).toBe(false);
    expect(decideAttentionExpiry(row({ id: '5', updatedAt: 'garbage', createdAt: 'garbage' }), cfg, NOW).expire).toBe(false);
  });
  it('config: windows are tunable, nonsense clamps to defaults, enabled defaults true', () => {
    const c = resolveAttentionLifecycleConfig({ expiry: { automatedDays: 3, operatorAskedDays: -1 }, enabled: false });
    expect(c).toMatchObject({ enabled: false, automatedDays: 3, operatorAskedDays: ATTENTION_LIFECYCLE_DEFAULTS.operatorAskedDays });
    expect(resolveAttentionLifecycleConfig({}).enabled).toBe(true);
  });
});

describe('reopen + supersession', () => {
  it('a closed row may reopen; an operator WONT_DO holds the condition for 30 days', () => {
    const done = row({ id: 'd', status: 'DONE', updatedAt: new Date(NOW - DAY).toISOString() });
    expect(mayReopenInPlace(done, cfg, NOW)).toBe(true);
    const wont = row({ id: 'w', status: 'WONT_DO', updatedAt: new Date(NOW - 10 * DAY).toISOString() });
    expect(mayReopenInPlace(wont, cfg, NOW)).toBe(false);
    expect(mayReopenInPlace({ ...wont, updatedAt: new Date(NOW - 31 * DAY).toISOString() }, cfg, NOW)).toBe(true);
    expect(mayReopenInPlace(row({ id: 'o' }), cfg, NOW)).toBe(false);
  });
  it('plans one keeper (newest) per condition with duplicates; closed rows and singletons are ignored', () => {
    const t = (d: number) => new Date(NOW - d * DAY).toISOString();
    const items = [
      row({ id: 'held:1:1761400000000', title: 'Reply held', updatedAt: t(5) }),
      row({ id: 'held:1:1761500000000', title: 'Reply held', updatedAt: t(1) }),
      row({ id: 'held:1:1761300000000', title: 'Reply held', updatedAt: t(9), status: 'DONE' }),
      row({ id: 'held:2:1761500000000', title: 'Reply held', updatedAt: t(1) }),
    ];
    const plans = planAttentionSupersessions(items);
    expect(plans).toHaveLength(1);
    expect(plans[0].keep.id).toBe('held:1:1761500000000');
    expect(plans[0].close.map((r) => r.id)).toEqual(['held:1:1761400000000']);
  });
});
