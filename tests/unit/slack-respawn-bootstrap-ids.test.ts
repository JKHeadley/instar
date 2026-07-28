/**
 * Unit (Tier 1) — slack-respawn-bind-token fix.
 *
 * A FRESH Slack spawn passes `bootstrapConversationIds: [conversationId]` so the session
 * mints INSTAR_BIND_TOKEN + INSTAR_CONVERSATION_ID and can open durable state bound to its
 * minted id. The RESPAWN path (refresh/quota-swap/restart → SessionRefresh → slackRespawner)
 * previously omitted it, so a refreshed Slack session came up token-less and its durable
 * commitment binds were refused → ephemeral-timer fallback (the live-proven S7 gap).
 * `slackRespawnBootstrapIds` restores parity by resolving the id from the routing key.
 */
import { describe, it, expect, vi } from 'vitest';
import { slackRespawnBootstrapIds } from '../../src/core/slackRefreshBinding.js';

describe('slackRespawnBootstrapIds', () => {
  it('resolves the minted conversation id → [id] (parity with the fresh Slack spawn)', () => {
    const mint = vi.fn().mockReturnValue({ id: -1734007126 });
    expect(slackRespawnBootstrapIds('C0BA4F4E0FP', mint)).toEqual([-1734007126]);
    expect(mint).toHaveBeenCalledWith('C0BA4F4E0FP');
  });

  it('passes the full routing key (channel:thread) through to mintForInbound', () => {
    const mint = vi.fn().mockReturnValue({ id: -42 });
    expect(slackRespawnBootstrapIds('C0BA4F4E0FP:1783198568.171129', mint)).toEqual([-42]);
    expect(mint).toHaveBeenCalledWith('C0BA4F4E0FP:1783198568.171129');
  });

  it('returns undefined when the registry yields a null id (no minted id) — no bind opt', () => {
    expect(slackRespawnBootstrapIds('C0X', () => ({ id: null }))).toBeUndefined();
  });

  it('FAILS TOWARD RESPAWN: a throwing registry → undefined, never rethrows (a refresh must not be blocked)', () => {
    const mint = vi.fn(() => {
      throw new Error('registry unavailable');
    });
    expect(() => slackRespawnBootstrapIds('C0X', mint)).not.toThrow();
    expect(slackRespawnBootstrapIds('C0X', mint)).toBeUndefined();
  });
});
