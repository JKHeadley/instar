import { describe, it, expect, vi, afterEach } from 'vitest';
import { relayOutbound, isRelayRefusal } from '../../src/core/TelegramRelay.js';

/**
 * CMT-1247. `relayOutbound` classifies a holder response as a REFUSAL only on 422; every other
 * non-ok status collapses to `null`, which the standby's send path reports as
 * "telegram outbound relay failed (tokenless standby, router unreachable)".
 *
 * That is the conflation TelegramRelay's own header records having fixed for tone-gate nudges — a
 * refusal reported as a transport failure is unanswerable, because the agent sees a network error
 * instead of the rule and how to proceed. The fix was applied to 422 and the CONTRACT was left
 * narrow, so any refusal the holder expresses with a different status still conflates.
 *
 * The invisible-payload guard is one such refusal: the holder-side route does not classify
 * `InvisiblePayloadRefusedError` at all (it appears in neither routes.ts nor server.ts), so a
 * content refusal there does not emerge as 422.
 *
 * These tests PIN the current behaviour rather than assert the desired one, so the suite stays
 * green while the defect stays visible and precisely located. When CMT-1247 lands — by normalising
 * the holder's content refusal to 422, which is the narrower change than widening this client to
 * accept 400 (a status that legitimately also means "malformed request") — the second test is the
 * one that must flip, and its message says so.
 */
const deps = (fetchImpl: typeof fetch) => {
  vi.stubGlobal('fetch', fetchImpl);
  return {
    leaseHolder: () => 'holder-machine',
    selfMachineId: 'standby-machine',
    peerUrl: () => 'https://holder.invalid',
    authToken: () => 'tok',
    log: () => {},
  } as unknown as Parameters<typeof relayOutbound>[3];
};

afterEach(() => vi.unstubAllGlobals());

describe('relay refusal recognition — status contract (CMT-1247)', () => {
  it('a 422 from the holder is carried back as an actionable refusal', () => {
    const d = deps((async () => new Response(JSON.stringify({ error: 'tone-gate-advisory' }), { status: 422 })) as typeof fetch);
    return relayOutbound(7, 'hello', undefined, d).then((r) => {
      expect(isRelayRefusal(r)).toBe(true);
      expect((r as { body: Record<string, unknown> }).body.error).toBe('tone-gate-advisory');
    });
  });

  it('CURRENT, DEFECTIVE: a refusal expressed with any other status becomes indistinguishable from unreachable', async () => {
    const f = vi.fn(async () => new Response(
      JSON.stringify({ error: 'invisible-payload', refused: true }), { status: 400 },
    ));
    const d = deps(f as unknown as typeof fetch);
    const r = await relayOutbound(7, '​', undefined, d);
    // Prove the null came from the STATUS CLASSIFICATION, not from an early return before the
    // request was ever made — otherwise this test would pass for a reason that has nothing to do
    // with the defect it claims to pin.
    expect(f, 'the holder must actually have been called').toHaveBeenCalledTimes(1);
    // The holder said "refused", with a reason, in the body. The client cannot tell that apart from
    // a dead router, so the standby will report "router unreachable" for a CONTENT refusal.
    expect(
      r,
      'CMT-1247 fixed? Then the holder now expresses content refusals as 422 and this must become a '
      + 'RelayRefusal — update this test rather than widening the client to accept 400.',
    ).toBeNull();
    expect(isRelayRefusal(r)).toBe(false);
  });

  it('a genuine transport failure is also null — which is exactly why the above is ambiguous', async () => {
    const d = deps((async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch);
    expect(await relayOutbound(7, 'hello', undefined, d)).toBeNull();
  });
});
