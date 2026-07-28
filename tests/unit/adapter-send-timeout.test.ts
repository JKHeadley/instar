/**
 * sendWithAdapterTimeout — Tier-1 unit (spec slack-outbound-robustness R8-M1
 * Arm B, §2.4).
 *
 * Both sides of the boundary:
 *  - a send that resolves within the budget returns its value verbatim;
 *  - a send that outlives the budget rejects with AdapterSendTimeoutError
 *    (the ambiguous class the route maps to 408, never a 500 → retry →
 *    double-post).
 */
import { describe, it, expect } from 'vitest';
import {
  sendWithAdapterTimeout,
  AdapterSendTimeoutError,
  SLACK_ADAPTER_SEND_TIMEOUT_MS,
} from '../../src/server/routes.js';

describe('sendWithAdapterTimeout (R8-M1 Arm B)', () => {
  it('returns the send result when it resolves within the budget', async () => {
    const ts = await sendWithAdapterTimeout(async () => '1700000001.000001', 1000);
    expect(ts).toBe('1700000001.000001');
  });

  it('throws AdapterSendTimeoutError when the send outlives the budget', async () => {
    const hang = () => new Promise<string>(() => {}); // never resolves
    await expect(sendWithAdapterTimeout(hang, 20)).rejects.toBeInstanceOf(
      AdapterSendTimeoutError,
    );
  });

  it('propagates a real send error unchanged (not a timeout)', async () => {
    const boom = async () => {
      throw new Error('channel_not_found');
    };
    await expect(sendWithAdapterTimeout(boom, 1000)).rejects.toThrow('channel_not_found');
  });

  it('pins the adapter budget strictly below the §2.4 reservation TTL (30s < 60s)', () => {
    expect(SLACK_ADAPTER_SEND_TIMEOUT_MS).toBe(30_000);
    expect(SLACK_ADAPTER_SEND_TIMEOUT_MS).toBeLessThan(60_000);
  });
});
