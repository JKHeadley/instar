import { describe, it, expect, vi } from 'vitest';
import { RelayRefusedError, isRelayRefusal, relayOutbound } from '../../src/core/TelegramRelay.js';

/**
 * A holder REFUSAL is not a transport failure.
 *
 * On a tokenless standby the tone gate runs on the lease HOLDER, so an advisory
 * nudge arrives as the holder's 422. The relay used to collapse every non-2xx
 * to `null`, which the adapter turned into "router unreachable" — so a relayed
 * topic saw a network error instead of the rule, the decisionRef and how to
 * proceed, and could never answer the nudge. Under the advisory migration that
 * turns every judgment catch on a relayed topic into a permanently unsendable
 * message, which is precisely the failure the migration exists to remove.
 */
function deps(fetchImpl: typeof fetch) {
  return {
    leaseHolder: () => 'holder-machine',
    selfMachineId: 'standby-machine',
    peerUrl: () => 'http://holder.local:4042',
    authToken: 'tok',
    timeoutMs: 5_000,
    fetchImpl,
    log: () => {},
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('relay holder refusal', () => {
  it('returns a typed REFUSAL (not null) when the holder answers 422', async () => {
    const body = {
      error: 'tone-gate-advisory',
      notSent: true,
      rule: 'B2_FILE_PATH',
      decisionRef: 'd-abc12345-0000-4000-8000-000000000001',
      howToProceed: 'revise, or re-send with an ack + reason',
    };
    const r = await relayOutbound(42, 'a message', undefined, deps(vi.fn(async () => jsonResponse(422, body)) as never));

    expect(isRelayRefusal(r)).toBe(true);
    // The whole point: the agent-actionable fields survive the hop.
    expect((r as { body: Record<string, unknown> }).body).toMatchObject({
      error: 'tone-gate-advisory',
      rule: 'B2_FILE_PATH',
      decisionRef: 'd-abc12345-0000-4000-8000-000000000001',
    });
  });

  it('carries the credential wall across the hop as a refusal too', async () => {
    const body = { error: 'Message blocked: …', blockedBy: 'credential-exposure-guard', overridable: false };
    const r = await relayOutbound(42, 'leak', undefined, deps(vi.fn(async () => jsonResponse(422, body)) as never));
    expect(isRelayRefusal(r)).toBe(true);
    expect((r as { body: Record<string, unknown> }).body.blockedBy).toBe('credential-exposure-guard');
  });

  it('still returns NULL for a genuine transport-class failure (500) — the distinction is the point', async () => {
    const r = await relayOutbound(42, 'x', undefined, deps(vi.fn(async () => jsonResponse(500, {})) as never));
    expect(r).toBeNull();
    expect(isRelayRefusal(r)).toBe(false);
  });

  it('forwards the tone-advisory reaction fields to the holder', async () => {
    // Without this the holder re-cites the advisory on every attempt and the
    // ack can never reach it — an unanswerable loop.
    const fetchSpy = vi.fn(async () => jsonResponse(200, { messageId: 7 }));
    await relayOutbound(
      42,
      'a message',
      {
        kindMetadata: {
          toneAdvisoryAck: 'B2_FILE_PATH',
          toneAdvisoryAckReason: 'the operator asked for the exact path',
          toneAdvisoryDecisionRef: 'd-abc12345-0000-4000-8000-000000000001',
        },
      },
      deps(fetchSpy as never),
    );

    const sentBody = JSON.parse((fetchSpy.mock.calls[0]![1] as { body: string }).body);
    expect(sentBody.metadata).toMatchObject({
      toneAdvisoryAck: 'B2_FILE_PATH',
      toneAdvisoryAckReason: 'the operator asked for the exact path',
      toneAdvisoryDecisionRef: 'd-abc12345-0000-4000-8000-000000000001',
    });
  });

  it('RelayRefusedError preserves the holder status and body for re-emission', () => {
    const err = new RelayRefusedError({ refused: true, status: 422, body: { error: 'tone-gate-advisory' } });
    expect(err.status).toBe(422);
    expect(err.body).toEqual({ error: 'tone-gate-advisory' });
    expect(err).toBeInstanceOf(Error);
  });
});
