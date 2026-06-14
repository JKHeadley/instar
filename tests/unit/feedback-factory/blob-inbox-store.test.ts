/**
 * Unit tests (Tier 1) — BlobInboxStore: the canonical front's ReceiverStore.
 *
 * Pins: addFeedback writes ONE JSON object under inbox/<feedbackId>.json stamped
 * with receivedAt + status, hasFeedback is a prefix list (both decision sides),
 * and the full async handler path accepts + persists through it.
 */

import { describe, it, expect } from 'vitest';
import { BlobInboxStore, INBOX_PREFIX } from '../../../src/feedback-factory/receiver/BlobInboxStore.js';
import { handleFeedbackSubmit } from '../../../src/feedback-factory/receiver/handlers.js';
import { RateLimiter, RATE_LIMITS } from '../../../src/feedback-factory/receiver/defense.js';
import type { BlobInboxClient } from '../../../src/feedback-factory/inbox/BlobInboxClient.js';

class FakeClient {
  puts: Array<{ pathname: string; content: string }> = [];
  existingPrefixes = new Set<string>();

  async put(pathname: string, content: string) {
    this.puts.push({ pathname, content });
    return { url: `https://fake/${pathname}`, pathname };
  }

  async list(prefix: string) {
    const hit = [...this.existingPrefixes].some((p) => p.startsWith(prefix));
    return { blobs: hit ? [{ url: 'u', pathname: prefix, size: 1, uploadedAt: 'x' }] : [], hasMore: false };
  }
}

const NOW = 1_000_000_000_000;
const UA = { 'user-agent': 'instar/1.3.0' };

describe('BlobInboxStore', () => {
  it('addFeedback writes inbox/<feedbackId>.json with receivedAt + unprocessed status', async () => {
    const client = new FakeClient();
    const store = new BlobInboxStore(client as unknown as BlobInboxClient, () => '2026-06-11T20:00:00Z');
    await store.addFeedback({ feedbackId: 'fb-1', title: 't', description: 'd', type: 'bug' });

    expect(client.puts).toHaveLength(1);
    expect(client.puts[0].pathname).toBe(`${INBOX_PREFIX}fb-1.json`);
    expect(JSON.parse(client.puts[0].content)).toMatchObject({
      feedbackId: 'fb-1', receivedAt: '2026-06-11T20:00:00Z', status: 'unprocessed',
    });
  });

  it('hasFeedback: true when an inbox blob exists for the id, false when not', async () => {
    const client = new FakeClient();
    const store = new BlobInboxStore(client as unknown as BlobInboxClient);
    expect(await store.hasFeedback('fb-1')).toBe(false);
    client.existingPrefixes.add(`${INBOX_PREFIX}fb-1-suffix.json`);
    expect(await store.hasFeedback('fb-1')).toBe(true);
  });

  it('the full async handler path persists an accepted report through the Blob store', async () => {
    const client = new FakeClient();
    const store = new BlobInboxStore(client as unknown as BlobInboxClient);
    const deps = { store, rateLimiter: new RateLimiter(RATE_LIMITS, () => NOW), secret: 'sec', now: NOW, generateFeedbackId: () => 'fb-gen-1' };

    const r = await handleFeedbackSubmit(
      { headers: UA, body: { type: 'bug', title: 'a real title', description: 'a sufficiently long description' } },
      deps,
    );
    expect(r.status).toBe(200);
    expect(client.puts).toHaveLength(1);
    expect(JSON.parse(client.puts[0].content)).toMatchObject({ feedbackId: 'fb-gen-1', verified: false });
  });

  it('the handler dedups against an existing inbox blob (duplicate:true, no second write)', async () => {
    const client = new FakeClient();
    client.existingPrefixes.add(`${INBOX_PREFIX}fb-abc123-suffix.json`);
    const store = new BlobInboxStore(client as unknown as BlobInboxClient);
    const deps = { store, rateLimiter: new RateLimiter(RATE_LIMITS, () => NOW), secret: 'sec', now: NOW };

    const r = await handleFeedbackSubmit(
      { headers: UA, body: { type: 'bug', title: 'a real title', description: 'a sufficiently long description', feedbackId: 'fb-abc123' } },
      deps,
    );
    expect(r.json).toMatchObject({ id: 'fb-abc123', duplicate: true });
    expect(client.puts).toHaveLength(0);
  });
});
