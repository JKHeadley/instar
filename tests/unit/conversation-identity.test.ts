/**
 * conversationIdentity — the SINGLE hash + identity surface (spec
 * durable-conversation-identity §3.1/§3.3/§4, §10 Tier-1).
 *
 * Golden parity is the load-bearing assertion: the mint candidate must
 * reproduce the EXACT ids of the legacy hash copies (zero-loss adoption +
 * mixed-fleet skew convergence both depend on byte-identical values), and the
 * frozen schema-v1 constants must match their pinned values (R3-M10).
 */
import { describe, it, expect } from 'vitest';
import {
  candidateIdForRoutingKey,
  canonicalKeyFor,
  HLC_ABS_MAX,
  HLC_ABS_MIN,
  MAX_PROBE_DISTANCE,
  parseCanonicalKey,
  PROBE_DIRECTION,
  routingKeyForTuple,
  sumShiftHash,
  tupleForRoutingKey,
  tupleKeyFor,
  walkDisplacement,
} from '../../src/core/conversationIdentity.js';
import { slackRoutingKeySyntheticId } from '../../src/core/slackRefreshBinding.js';

describe('conversationIdentity — golden parity + frozen constants (§10)', () => {
  it('candidateIdForRoutingKey reproduces the legacy slackRoutingKeySyntheticId EXACTLY (channel-level)', () => {
    for (const key of ['C0BA4F4E0FP', 'C12345ABCDE', 'D0AAAA11111', 'G0ZZZZ99999']) {
      expect(candidateIdForRoutingKey(key)).toBe(slackRoutingKeySyntheticId(key));
      expect(candidateIdForRoutingKey(key)).toBeLessThan(0);
    }
  });

  it('candidateIdForRoutingKey reproduces the legacy hash for THREAD keys (thread-aware — the slackRoutingKeySyntheticId semantics)', () => {
    const key = 'C0BA4F4E0FP:1751412345.123456';
    expect(candidateIdForRoutingKey(key)).toBe(slackRoutingKeySyntheticId(key));
  });

  it('pins the frozen schema-v1 constants (R3-M10 — changed only by a versioned migration)', () => {
    expect(MAX_PROBE_DISTANCE).toBe(64);
    expect(PROBE_DIRECTION).toBe(-1); // probe direction DOWN, frozen forever
    expect(HLC_ABS_MIN).toBe(1767225600000); // 2026-01-01T00:00:00Z, ms since epoch
    expect(HLC_ABS_MAX).toBe(4102444800000); // 2100-01-01T00:00:00Z
  });

  it('0 is unmintable: -(abs+1) is ≥ 1 in magnitude even for the empty-hash input', () => {
    expect(sumShiftHash('')).toBe(0);
    expect(candidateIdForRoutingKey('')).toBe(-1);
  });
});

describe('conversationIdentity — tuple/key forms (§3.1)', () => {
  it('parses a channel-level routing key into a tuple and round-trips', () => {
    const t = tupleForRoutingKey('C0BA4F4E0FP');
    expect(t).toEqual({ platform: 'slack', channelId: 'C0BA4F4E0FP', threadTs: null });
    expect(routingKeyForTuple(t!)).toBe('C0BA4F4E0FP');
  });

  it('parses a thread-level routing key and round-trips', () => {
    const t = tupleForRoutingKey('C0BA4F4E0FP:1751412345.123456');
    expect(t).toEqual({ platform: 'slack', channelId: 'C0BA4F4E0FP', threadTs: '1751412345.123456' });
    expect(routingKeyForTuple(t!)).toBe('C0BA4F4E0FP:1751412345.123456');
  });

  it('DM/group ids (D…/G…) are just channels — no special identity (§3.2)', () => {
    expect(tupleForRoutingKey('D0AAAA11111')).not.toBeNull();
    expect(tupleForRoutingKey('G0ZZZZ99999')).not.toBeNull();
  });

  it('refuses malformed shapes (the §7 mesh-forward guard, security-M1c)', () => {
    expect(tupleForRoutingKey('lowercase123')).toBeNull();
    expect(tupleForRoutingKey('X0BADPREFIX')).toBeNull();
    expect(tupleForRoutingKey('C0OK11111:not-a-ts')).toBeNull();
    expect(tupleForRoutingKey('C0OK11111:123.456')).toBeNull(); // too-short ts
    expect(tupleForRoutingKey('')).toBeNull();
  });

  it('canonical key carries the workspace segment, `_` when unknown, and parses back', () => {
    const t = { platform: 'slack' as const, channelId: 'C0BA4F4E0FP', threadTs: null };
    expect(canonicalKeyFor(t, 'T0BA1DR0U3D')).toBe('slack:T0BA1DR0U3D:C0BA4F4E0FP');
    expect(canonicalKeyFor(t, undefined)).toBe('slack:_:C0BA4F4E0FP');
    const thread = { platform: 'slack' as const, channelId: 'C0BA4F4E0FP', threadTs: '1751412345.123456' };
    const key = canonicalKeyFor(thread, 'T0BA1DR0U3D');
    expect(key).toBe('slack:T0BA1DR0U3D:C0BA4F4E0FP:1751412345.123456');
    expect(parseCanonicalKey(key)).toEqual({ tuple: thread, workspaceId: 'T0BA1DR0U3D' });
    expect(parseCanonicalKey('slack:_:C0BA4F4E0FP')).toEqual({ tuple: t, workspaceId: '_' });
    expect(parseCanonicalKey('telegram:123')).toBeNull();
    expect(parseCanonicalKey('slack:bad team:C1')).toBeNull();
  });

  it('tupleKey byte-form: null threadTs compares as the EMPTY string — the channel-level tuple sorts BEFORE its own threads (§3.5.1 R3-minor)', () => {
    const channel = tupleKeyFor({ platform: 'slack', channelId: 'C0BA4F4E0FP', threadTs: null });
    const thread = tupleKeyFor({ platform: 'slack', channelId: 'C0BA4F4E0FP', threadTs: '1751412345.123456' });
    expect(channel < thread).toBe(true);
  });
});

describe('conversationIdentity — the ONE shared displacement implementation (§3.3 = §3.5.1 step 2)', () => {
  it('no collision → the candidate itself, zero probes', () => {
    const r = walkDisplacement(-100, () => false);
    expect(r).toEqual({ ok: true, id: -100, probes: 0 });
  });

  it('probes DOWN through the frozen sequence to the first free offset', () => {
    const taken = new Set([-100, -101, -102]);
    const r = walkDisplacement(-100, (id) => taken.has(id));
    expect(r).toEqual({ ok: true, id: -103, probes: 3 });
  });

  it('is bounded by MAX_PROBE_DISTANCE — a >64 walk degrades to overflow (the pending-mint path), never a peer-un-ingestable id', () => {
    const r = walkDisplacement(-100, () => true);
    expect(r).toEqual({ ok: false, overflow: true });
  });

  it('a walk of exactly MAX_PROBE_DISTANCE probes still succeeds (local-probe-distance ≤ ingest-bound invariant)', () => {
    let calls = 0;
    const r = walkDisplacement(-100, () => ++calls <= 64);
    expect(r).toEqual({ ok: true, id: -164, probes: 64 });
  });
});
