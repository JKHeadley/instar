/**
 * Unit tests — topicProfileIngress (TOPIC-PROFILE-SPEC §10.1 / §8 / §10.4).
 *
 * The deterministic trigger grammar (closed set, whole-message anchored) and
 * the shared armed-confirm slot: TTL, platform-message-id ordering (ties
 * refused), supersession, re-proposal rate bound + churn cooldown,
 * forwarded-content rejection.
 */

import { describe, it, expect } from 'vitest';
import {
  parseProfileTrigger,
  ProfileConfirmSlots,
  platformMessageIdFrom,
} from '../../src/core/topicProfileIngress.js';

describe('parseProfileTrigger — the closed grammar (§10.1, Tier 0)', () => {
  it('recognizes framework switches in the documented phrasings', () => {
    expect(parseProfileTrigger('use codex here')).toEqual({ kind: 'write', patch: { framework: 'codex-cli' } });
    expect(parseProfileTrigger('Use Claude here.')).toEqual({ kind: 'write', patch: { framework: 'claude-code' } });
    expect(parseProfileTrigger('switch this topic to codex')).toEqual({ kind: 'write', patch: { framework: 'codex-cli' } });
    expect(parseProfileTrigger('switch to gemini for this topic')).toEqual({ kind: 'write', patch: { framework: 'gemini-cli' } });
  });

  it('recognizes literal model-id pins (names like "Fable" are out-of-grammar)', () => {
    expect(parseProfileTrigger('pin this topic to claude-opus-4-8')).toEqual({
      kind: 'write',
      patch: { model: 'claude-opus-4-8', modelTier: null },
    });
    // alias words map to the tier arm
    expect(parseProfileTrigger('pin this topic to escalated')).toEqual({
      kind: 'write',
      patch: { modelTier: 'escalated', model: null },
    });
    // a display name is NOT a trigger — it rides propose-confirm
    expect(parseProfileTrigger('pin this topic to Fable 5')).toBeNull();
  });

  it('recognizes thinking-mode pins', () => {
    expect(parseProfileTrigger('set high thinking on this topic')).toEqual({
      kind: 'write', patch: { thinkingMode: 'high' },
    });
    expect(parseProfileTrigger('set thinking to max')).toEqual({
      kind: 'write', patch: { thinkingMode: 'max' },
    });
  });

  it('suppress requires the explicit instruction; inherit restores', () => {
    expect(parseProfileTrigger("don't escalate this topic")).toEqual({
      kind: 'write', patch: { escalationOverride: 'suppress' },
    });
    expect(parseProfileTrigger('re-enable escalation here')).toEqual({
      kind: 'write', patch: { escalationOverride: 'inherit' },
    });
    // ambiguity defaults to NO match (the mandate is preserved, §9)
    expect(parseProfileTrigger('maybe stop escalating so much')).toBeNull();
  });

  it('recognizes readout / undo / clear / re-apply / switch-now / confirm', () => {
    expect(parseProfileTrigger('what is this topic pinned to')?.kind).toBe('readout');
    expect(parseProfileTrigger("that wasn't me — undo")?.kind).toBe('undo');
    expect(parseProfileTrigger('undo the profile change')?.kind).toBe('undo');
    expect(parseProfileTrigger("clear this topic's profile")?.kind).toBe('clear');
    expect(parseProfileTrigger('re-apply')?.kind).toBe('reapply');
    expect(parseProfileTrigger('reapply the parked pin')?.kind).toBe('reapply');
    expect(parseProfileTrigger('switch now')?.kind).toBe('switch-now');
    expect(parseProfileTrigger('yes')?.kind).toBe('confirm');
    expect(parseProfileTrigger('do it')?.kind).toBe('confirm');
  });

  it('a bare "undo" is normal conversation — never hijacked', () => {
    expect(parseProfileTrigger('undo')).toBeNull();
    expect(parseProfileTrigger('undo that')).toBeNull();
  });

  it('triggers are whole-message anchored — quoted prose never fires', () => {
    expect(parseProfileTrigger('he told me to use codex here but I disagree')).toBeNull();
    expect(parseProfileTrigger('what does "switch this topic to codex" do?')).toBeNull();
  });

  it('over-length messages never match', () => {
    expect(parseProfileTrigger(`use codex here${' '.repeat(150)}x`)).toBeNull();
  });
});

describe('ProfileConfirmSlots — the ONE armed slot per topic (§10.1/§10.4)', () => {
  function slots(nowRef: { t: number }, ttlMs = 1000) {
    return new ProfileConfirmSlots({
      ttlMs: () => ttlMs,
      now: () => nowRef.t,
      maxProposalsPerWindow: 3,
      proposalWindowMs: 10_000,
    });
  }

  it('arms, records the echo id, and fires on a postdating confirm', () => {
    const now = { t: 1000 };
    const s = slots(now);
    expect(s.arm('23', 'propose-confirm', { thinkingMode: 'high' }, 'echo', 'agent-composed').ok).toBe(true);
    s.recordEchoMessageId('23', 500);
    const match = s.matchConfirm('23', { platformMessageId: 501, forwarded: false });
    expect(match.ok).toBe(true);
    if (match.ok) expect(match.armed.patch).toEqual({ thinkingMode: 'high' });
    // slot consumed
    expect(s.matchConfirm('23', { platformMessageId: 502, forwarded: false })).toEqual({ ok: false, reason: 'none-armed' });
  });

  it('refuses a confirm whose platform id ties or predates the echo (stale-order)', () => {
    const now = { t: 1000 };
    const s = slots(now);
    s.arm('23', 'propose-confirm', { thinkingMode: 'high' }, 'echo', 'agent-composed');
    s.recordEchoMessageId('23', 500);
    expect(s.matchConfirm('23', { platformMessageId: 500, forwarded: false })).toEqual({ ok: false, reason: 'stale-order' });
    expect(s.matchConfirm('23', { platformMessageId: 499, forwarded: false })).toEqual({ ok: false, reason: 'stale-order' });
    // still armed — a later confirm can fire
    expect(s.matchConfirm('23', { platformMessageId: 501, forwarded: false }).ok).toBe(true);
  });

  it('refuses toward re-echo when the echo id is unknown (no-echo-id)', () => {
    const now = { t: 1000 };
    const s = slots(now);
    s.arm('23', 'propose-confirm', { thinkingMode: 'high' }, 'echo', 'agent-composed');
    expect(s.matchConfirm('23', { platformMessageId: 999, forwarded: false })).toEqual({ ok: false, reason: 'no-echo-id' });
  });

  it('forwarded content never matches (round-5)', () => {
    const now = { t: 1000 };
    const s = slots(now);
    s.arm('23', 'propose-confirm', { thinkingMode: 'high' }, 'echo', 'agent-composed');
    s.recordEchoMessageId('23', 500);
    expect(s.matchConfirm('23', { platformMessageId: 501, forwarded: true })).toEqual({ ok: false, reason: 'forwarded' });
  });

  it('expires on TTL and tears the slot down', () => {
    const now = { t: 1000 };
    const s = slots(now, 1000);
    s.arm('23', 'propose-confirm', { thinkingMode: 'high' }, 'echo', 'agent-composed');
    s.recordEchoMessageId('23', 500);
    now.t += 1500;
    expect(s.matchConfirm('23', { platformMessageId: 501, forwarded: false })).toEqual({ ok: false, reason: 'expired' });
    expect(s.peek('23')).toBeNull();
  });

  it('a re-proposal supersedes — the confirm answers only the LATEST echo', () => {
    const now = { t: 1000 };
    const s = slots(now);
    s.arm('23', 'propose-confirm', { thinkingMode: 'high' }, 'echo-1', 'agent-composed');
    s.recordEchoMessageId('23', 500);
    const second = s.arm('23', 'propose-confirm', { framework: 'codex-cli' }, 'echo-2', 'agent-composed');
    expect(second).toEqual({ ok: true, superseded: true });
    // The new slot's echo id is unrecorded → a confirm is refused toward re-echo
    expect(s.matchConfirm('23', { platformMessageId: 501, forwarded: false })).toEqual({ ok: false, reason: 'no-echo-id' });
    s.recordEchoMessageId('23', 510);
    const match = s.matchConfirm('23', { platformMessageId: 511, forwarded: false });
    expect(match.ok).toBe(true);
    if (match.ok) expect(match.armed.patch).toEqual({ framework: 'codex-cli' });
  });

  it('rate-bounds re-proposals and cools down (churn is a suspicion signal, round-7)', () => {
    const now = { t: 1000 };
    const events: Record<string, unknown>[] = [];
    const s = new ProfileConfirmSlots({
      ttlMs: () => 60_000,
      now: () => now.t,
      maxProposalsPerWindow: 2,
      proposalWindowMs: 10_000,
      audit: (e) => events.push(e),
    });
    expect(s.arm('23', 'propose-confirm', {}, 'e1', 'agent-composed').ok).toBe(true);
    expect(s.arm('23', 'propose-confirm', {}, 'e2', 'agent-composed').ok).toBe(true);
    const tripped = s.arm('23', 'propose-confirm', {}, 'e3', 'agent-composed');
    expect(tripped).toEqual({ ok: false, reason: 'proposal-churn-cooldown' });
    // the armed proposal is torn down — a bare yes fires nothing
    expect(s.peek('23')).toBeNull();
    expect(events.some(e => e.type === 'proposal-churn-trip')).toBe(true);
    // still cooling down
    now.t += 5000;
    expect(s.arm('23', 'propose-confirm', {}, 'e4', 'agent-composed').ok).toBe(false);
    // cooldown over
    now.t += 6000;
    expect(s.arm('23', 'propose-confirm', {}, 'e5', 'agent-composed').ok).toBe(true);
  });

  it('different topics have independent slots', () => {
    const now = { t: 1000 };
    const s = slots(now);
    s.arm('23', 'propose-confirm', { thinkingMode: 'high' }, 'echo', 'agent-composed');
    expect(s.matchConfirm('99', { platformMessageId: 1, forwarded: false })).toEqual({ ok: false, reason: 'none-armed' });
  });
});

describe('platformMessageIdFrom', () => {
  it('parses tg-prefixed ids and refuses anything else', () => {
    expect(platformMessageIdFrom('tg-12345')).toBe(12345);
    expect(platformMessageIdFrom('slack-1.2')).toBeNull();
    expect(platformMessageIdFrom(undefined)).toBeNull();
  });
});
