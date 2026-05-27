/**
 * Unit tests for the AgentTelegramComms primitive.
 * Spec: docs/specs/MENTOR-LIVE-READINESS-SPEC.md §Fix 2a + §Testing 1-4.
 *
 * Covers the security-critical pure logic: strict marker parse/format, the full routing
 * matrix (every drop branch, incl. the user-spoof defense + per-source role acceptance),
 * and cycle-detection. These are the assertions that make the anti-loop + spoof defenses
 * real rather than aspirational.
 */
import { describe, it, expect } from 'vitest';
import {
  A2A_VERSION,
  parseMarker,
  formatMarker,
  decideRoute,
  cycleKey,
  CycleDetector,
  type RecipientConfig,
  type IncomingContext,
} from '../../../src/messaging/AgentTelegramComms.js';

const NOW = 1_779_900_000_000;

function marker(overrides: Partial<Record<string, string | number>> = {}): string {
  const f = {
    from: 'echo',
    to: 'instar-codey',
    role: 'mentor',
    id: 'id-abc',
    corr: 'id-abc',
    ts: NOW,
    ...overrides,
  };
  return `[a2a:from=${f.from} to=${f.to} role=${f.role} id=${f.id} corr=${f.corr} ts=${f.ts} v=${A2A_VERSION}]\n\nhello codey`;
}

const cfg: RecipientConfig = {
  localAgent: 'instar-codey',
  knownAgents: { echo: { botId: 'echo-mentor-bot' } },
  acceptRoles: { echo: ['mentor'] },
  skewWindowMs: 24 * 60 * 60 * 1000,
  maxVersion: A2A_VERSION,
};

function ctx(raw: string, over: Partial<IncomingContext> = {}): IncomingContext {
  return {
    raw,
    senderIsBot: true,
    senderBotId: 'echo-mentor-bot',
    now: NOW,
    ...over,
  };
}

const deps = (over: Partial<{ processed: Set<string>; roles: Set<string> }> = {}) => ({
  isProcessed: (id: string) => (over.processed ?? new Set<string>()).has(id),
  knownRole: (r: string) => (over.roles ?? new Set(['mentor', 'mentor-reply'])).has(r),
});

describe('AgentTelegramComms — marker parse/format', () => {
  it('parses a well-formed marker + body', () => {
    const r = parseMarker(marker());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.msg).toMatchObject({ from: 'echo', to: 'instar-codey', role: 'mentor', id: 'id-abc', corr: 'id-abc', ts: NOW, v: A2A_VERSION });
      expect(r.msg.body).toBe('hello codey');
    }
  });

  it('returns no-marker for ordinary user text (fall through)', () => {
    const r = parseMarker('hey echo, can you help with X?');
    expect(r).toEqual({ ok: false, kind: 'no-marker' });
  });

  it('returns malformed (NOT no-marker) for marker-prefixed-but-broken — drop, never fall through', () => {
    // Missing corr.
    const noCorr = `[a2a:from=echo to=instar-codey role=mentor id=x ts=${NOW} v=1]\n\nbody`;
    expect(parseMarker(noCorr)).toMatchObject({ ok: false, kind: 'malformed' });
    // Missing ts.
    const noTs = `[a2a:from=echo to=instar-codey role=mentor id=x corr=x v=1]\n\nbody`;
    expect(parseMarker(noTs)).toMatchObject({ ok: false, kind: 'malformed' });
    // Charset violation (space in id).
    const badId = `[a2a:from=echo to=instar-codey role=mentor id=a b corr=x ts=${NOW} v=1]\n\nbody`;
    expect(parseMarker(badId)).toMatchObject({ ok: false, kind: 'malformed' });
    // No blank-line separator.
    const noSep = `[a2a:from=echo to=instar-codey role=mentor id=x corr=x ts=${NOW} v=1]body`;
    expect(parseMarker(noSep)).toMatchObject({ ok: false, kind: 'malformed' });
  });

  it('formatMarker round-trips through parseMarker', () => {
    const body = 'multi\nline\nbody';
    const out = formatMarker({ from: 'echo', to: 'instar-codey', role: 'mentor-reply', id: 'r1', corr: 'id-abc', ts: NOW }, body);
    const r = parseMarker(out);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.msg.role).toBe('mentor-reply');
      expect(r.msg.corr).toBe('id-abc');
      expect(r.msg.body).toBe(body);
    }
  });

  it('formatMarker rejects charset-violating field values', () => {
    expect(() => formatMarker({ from: 'echo', to: 'codey', role: 'men tor', id: 'x', corr: 'x', ts: NOW }, 'b')).toThrow(/charset/);
  });
});

describe('AgentTelegramComms — routing matrix', () => {
  it('routes a valid, allowlisted, in-window, unique mentor message', () => {
    const d = decideRoute(ctx(marker()), cfg, deps());
    expect(d.action).toBe('route');
  });

  it('falls through on no marker (ordinary user message)', () => {
    expect(decideRoute(ctx('just a normal message'), cfg, deps()).action).toBe('fall-through');
  });

  it('drops malformed markers (never falls through)', () => {
    const d = decideRoute(ctx(`[a2a:from=echo broken`), cfg, deps());
    expect(d).toMatchObject({ action: 'drop', reason: 'agent-marker-malformed' });
  });

  it('drops stale/future markers (replay defense)', () => {
    const stale = marker({ ts: NOW - 25 * 60 * 60 * 1000 });
    expect(decideRoute(ctx(stale), cfg, deps())).toMatchObject({ action: 'drop', reason: 'agent-marker-stale-or-future' });
  });

  it('SECURITY: drops a human-typed marker (not a bot, no sender_chat) even if from/id match the allowlist', () => {
    const d = decideRoute(ctx(marker(), { senderIsBot: false, senderChatId: undefined, senderBotId: 'echo-mentor-bot' }), cfg, deps());
    expect(d).toMatchObject({ action: 'drop', reason: 'agent-marker-spoofed-by-user' });
  });

  it('accepts a group bot-as-channel relay (sender_chat present) from an allowlisted bot', () => {
    const d = decideRoute(ctx(marker(), { senderIsBot: false, senderChatId: 'echo-mentor-bot', senderBotId: 'echo-mentor-bot' }), cfg, deps());
    expect(d.action).toBe('route');
  });

  it('drops wrong-recipient', () => {
    expect(decideRoute(ctx(marker({ to: 'some-other-agent' })), cfg, deps())).toMatchObject({ action: 'drop', reason: 'agent-marker-wrong-recipient' });
  });

  it('drops unsupported version (dead-letter, not crash)', () => {
    const v2 = `[a2a:from=echo to=instar-codey role=mentor id=x corr=x ts=${NOW} v=2]\n\nbody`;
    expect(decideRoute(ctx(v2), cfg, deps())).toMatchObject({ action: 'drop', reason: 'agent-marker-unsupported-version' });
  });

  it('drops unknown sender / bot-id mismatch (spoof defense)', () => {
    expect(decideRoute(ctx(marker({ from: 'mallory' })), cfg, deps())).toMatchObject({ action: 'drop', reason: 'agent-marker-unknown' });
    expect(decideRoute(ctx(marker(), { senderBotId: 'WRONG-bot' }), cfg, deps())).toMatchObject({ action: 'drop', reason: 'agent-marker-unknown' });
  });

  it('drops duplicate id (idempotency against Telegram retry / restart)', () => {
    const d = decideRoute(ctx(marker({ id: 'dup1', corr: 'dup1' })), cfg, deps({ processed: new Set(['dup1']) }));
    expect(d).toMatchObject({ action: 'drop', reason: 'agent-marker-duplicate' });
  });

  it('SECURITY: drops a role not allowed FROM THIS SOURCE even if accepted from another', () => {
    // notify is a known role, but echo is only allowed to send `mentor` here.
    const d = decideRoute(ctx(marker({ role: 'notify' })), cfg, deps({ roles: new Set(['mentor', 'notify']) }));
    expect(d).toMatchObject({ action: 'drop', reason: 'agent-marker-role-not-allowed-from-source' });
  });

  it('drops an entirely-unknown role', () => {
    const d = decideRoute(ctx(marker({ role: 'gibberish' })), cfg, deps({ roles: new Set(['mentor']) }));
    expect(d).toMatchObject({ action: 'drop', reason: 'agent-marker-unknown-role' });
  });
});

describe('AgentTelegramComms — cycle detection', () => {
  it('cycleKey never collapses (corr always present)', () => {
    const k1 = cycleKey({ fromBotId: 'a', toBotId: 'b', topicId: 5, role: 'mentor', corr: 'c1' });
    const k2 = cycleKey({ fromBotId: 'a', toBotId: 'b', topicId: 5, role: 'mentor', corr: 'c2' });
    expect(k1).not.toBe(k2); // different corr → different key, no false collision
  });

  it('trips within the window, clears after it', () => {
    const cd = new CycleDetector(5000);
    const k = cycleKey({ fromBotId: 'a', toBotId: 'b', topicId: 1, role: 'mentor', corr: 'c' });
    cd.mark(k, NOW);
    expect(cd.wouldTrip(k, NOW + 1000)).toBe(true); // within 5s
    expect(cd.wouldTrip(k, NOW + 6000)).toBe(false); // past 5s
  });

  it('does not trip unrelated keys', () => {
    const cd = new CycleDetector(5000);
    cd.mark(cycleKey({ fromBotId: 'a', toBotId: 'b', topicId: 1, role: 'mentor', corr: 'c1' }), NOW);
    const other = cycleKey({ fromBotId: 'a', toBotId: 'b', topicId: 1, role: 'mentor', corr: 'c2' });
    expect(cd.wouldTrip(other, NOW + 1000)).toBe(false);
  });
});
