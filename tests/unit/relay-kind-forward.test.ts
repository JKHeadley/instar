/**
 * Relay-hop kind forwarding (spec outbound-jargon-filepath-gap §2.5):
 * a relayed automated send must arrive at the holder with the kind
 * metadata intact — relayOutbound includes `metadata` in the POST body,
 * and a metadata-less relay produces the identical legacy body.
 */

import { describe, it, expect, vi } from 'vitest';
import { relayOutbound } from '../../src/core/TelegramRelay.js';

function deps(fetchImpl: typeof fetch) {
  return {
    leaseHolder: () => 'm_holder',
    selfMachineId: 'm_self',
    peerUrl: () => 'http://holder.test:4042',
    authToken: 'tok',
    timeoutMs: 2000,
    fetchImpl,
    log: () => {},
  };
}

describe('relayOutbound — kind metadata survives the hop', () => {
  it('forwards metadata in the holder POST body', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, messageId: 9 }), { status: 200 }),
    ) as unknown as typeof fetch;

    const kindMetadata = {
      messageKind: 'automated',
      senderClass: 'llm-session',
      jobSlug: 'evolution-overdue-check',
      advisoryAck: true,
      advisoryCodes: ['RAW_FILE_PATH'],
    };
    const result = await relayOutbound(12476, 'queued reminder', { kindMetadata }, deps(fetchImpl));
    expect(result).toEqual({ messageId: 9, topicId: 12476 });

    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.metadata).toEqual(kindMetadata);
    expect(body.text).toBe('queued reminder');
  });

  it('no metadata → identical legacy body (no metadata key)', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, messageId: 3 }), { status: 200 }),
    ) as unknown as typeof fetch;

    await relayOutbound(12476, 'plain reply', undefined, deps(fetchImpl));
    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ text: 'plain reply' });
  });
});
