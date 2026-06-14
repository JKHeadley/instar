/**
 * Unit tests (Tier 1) — InboxDrainer: the cloud-inbox → canonical-store mover.
 *
 * Pins the delivery semantics that make Option-B safe:
 *   - delete-AFTER-durable-commit ordering (crash window re-delivers, never loses)
 *   - at-least-once + feedbackId dedup ⇒ idempotent end-to-end
 *   - poison objects are QUARANTINED (preserved + cleared), never wedge the loop
 *   - one failing blob never aborts the pass; a list-level failure leaves blobs queued
 *   - pagination drains beyond one page
 */

import { describe, it, expect } from 'vitest';
import { InboxDrainer, parseInboxItem } from '../../../src/feedback-factory/inbox/InboxDrainer.js';
import type { BlobInboxClient, BlobEntry } from '../../../src/feedback-factory/inbox/BlobInboxClient.js';
import { InMemoryFeedbackStore } from '../../../src/feedback-factory/store/FeedbackStore.js';

/** In-memory fake of the BlobInboxClient surface the drainer uses. */
class FakeBlobClient {
  store = new Map<string, string>(); // url -> content
  ops: string[] = [];
  pageSizeOverride: number | null = null;
  failFetchUrls = new Set<string>();
  failList = false;

  seed(pathname: string, content: string): string {
    const url = `https://fake.blob/${pathname}`;
    this.store.set(url, content);
    return url;
  }

  async list(prefix: string, opts: { limit?: number; cursor?: string } = {}) {
    this.ops.push(`list:${prefix}:${opts.cursor ?? ''}`);
    if (this.failList) throw new Error('list boom');
    const all = [...this.store.entries()]
      .filter(([url]) => url.startsWith(`https://fake.blob/${prefix}`))
      .map(([url]) => ({ url, pathname: url.replace('https://fake.blob/', ''), size: 1, uploadedAt: 'x' } as BlobEntry))
      .sort((a, b) => a.url.localeCompare(b.url));
    const limit = this.pageSizeOverride ?? opts.limit ?? 100;
    const start = opts.cursor ? Number(opts.cursor) : 0;
    const page = all.slice(start, start + limit);
    const next = start + limit;
    return { blobs: page, cursor: next < all.length ? String(next) : undefined, hasMore: next < all.length };
  }

  async fetchContent(url: string) {
    this.ops.push(`fetch:${url}`);
    if (this.failFetchUrls.has(url)) throw new Error('fetch boom');
    const c = this.store.get(url);
    if (c === undefined) throw new Error('gone');
    return c;
  }

  async put(pathname: string, content: string) {
    this.ops.push(`put:${pathname}`);
    const url = `https://fake.blob/${pathname}`;
    this.store.set(url, content);
    return { url, pathname };
  }

  async del(urls: string[]) {
    this.ops.push(`del:${urls.join(',')}`);
    for (const u of urls) this.store.delete(u);
  }
}

const report = (id: string) =>
  JSON.stringify({ feedbackId: id, title: `t ${id}`, description: `a long enough description ${id}`, type: 'bug' });

function mk(opts: { pageSize?: number } = {}) {
  const client = new FakeBlobClient();
  const store = new InMemoryFeedbackStore();
  const drainer = new InboxDrainer({ client: client as unknown as BlobInboxClient, store, pageSize: opts.pageSize });
  return { client, store, drainer };
}

describe('InboxDrainer — drain semantics', () => {
  it('drains an inbox blob into the store, then deletes it (delete AFTER commit)', async () => {
    const { client, store, drainer } = mk();
    const url = client.seed('inbox/fb-1-abc.json', report('fb-1'));

    const pass = await drainer.drainOnce();
    expect(pass).toMatchObject({ drained: 1, duplicates: 0, quarantined: 0, errors: 0 });
    expect(store.hasFeedback('fb-1')).toBe(true);
    expect(client.store.has(url)).toBe(false);
    // Ordering invariant: the fetch precedes the delete, and the delete is LAST.
    const fetchIdx = client.ops.findIndex((o) => o.startsWith('fetch:'));
    const delIdx = client.ops.findIndex((o) => o.startsWith('del:'));
    expect(fetchIdx).toBeGreaterThanOrEqual(0);
    expect(delIdx).toBeGreaterThan(fetchIdx);
  });

  it('is idempotent: a re-delivered blob for a known feedbackId is dropped as duplicate (and still cleared)', async () => {
    const { client, store, drainer } = mk();
    store.addFeedback({ feedbackId: 'fb-1', title: 't', description: 'd', type: 'bug' });
    const url = client.seed('inbox/fb-1-redelivery.json', report('fb-1'));

    const pass = await drainer.drainOnce();
    expect(pass).toMatchObject({ drained: 0, duplicates: 1 });
    expect(client.store.has(url)).toBe(false); // inbox cleared, store untouched
  });

  it('quarantines a poison blob (preserved under quarantine/, cleared from inbox) and keeps draining', async () => {
    const { client, store, drainer } = mk();
    client.seed('inbox/aaa-poison.json', 'not json at all');
    client.seed('inbox/bbb-good.json', report('fb-2'));

    const pass = await drainer.drainOnce();
    expect(pass).toMatchObject({ drained: 1, quarantined: 1, errors: 0 });
    expect(store.hasFeedback('fb-2')).toBe(true);
    // Preserved, not destroyed:
    const quarantined = [...client.store.keys()].filter((u) => u.includes('quarantine/'));
    expect(quarantined).toHaveLength(1);
    expect(client.store.get(quarantined[0])).toBe('not json at all');
    // Inbox itself is fully cleared.
    expect([...client.store.keys()].filter((u) => u.includes('/inbox/'))).toHaveLength(0);
  });

  it('a per-blob failure leaves THAT blob queued (re-delivery next tick) and drains the rest', async () => {
    const { client, store, drainer } = mk();
    const bad = client.seed('inbox/aaa-flaky.json', report('fb-flaky'));
    client.failFetchUrls.add(bad);
    client.seed('inbox/bbb-good.json', report('fb-good'));

    const pass = await drainer.drainOnce();
    // The re-list loop may retry the failing blob within the pass — the invariant
    // is: the good blob drains, the bad one stays queued, errors are counted.
    expect(pass.drained).toBe(1);
    expect(pass.errors).toBeGreaterThanOrEqual(1);
    expect(client.store.has(bad)).toBe(true); // still queued
    expect(store.hasFeedback('fb-good')).toBe(true);

    // Next tick recovers it.
    client.failFetchUrls.clear();
    const second = await drainer.drainOnce();
    expect(second).toMatchObject({ drained: 1, errors: 0 });
    expect(store.hasFeedback('fb-flaky')).toBe(true);
  });

  it('a list-level failure ends the pass with everything still queued, and status records the error', async () => {
    const { client, drainer } = mk();
    client.seed('inbox/fb-1.json', report('fb-1'));
    client.failList = true;

    const pass = await drainer.drainOnce();
    expect(pass.errors).toBe(1);
    expect(client.store.size).toBe(1);
    expect(drainer.status().lastError).toContain('list boom');
  });

  it('paginates: drains past one page in a single pass', async () => {
    const { client, store, drainer } = mk({ pageSize: 2 });
    for (let i = 0; i < 5; i++) client.seed(`inbox/fb-${i}-x.json`, report(`fb-${i}`));

    const pass = await drainer.drainOnce();
    expect(pass.drained).toBe(5);
    for (let i = 0; i < 5; i++) expect(store.hasFeedback(`fb-${i}`)).toBe(true);
  });

  it('status() reflects counters and start/stop lifecycle', async () => {
    const { client, drainer } = mk();
    client.seed('inbox/fb-1.json', report('fb-1'));
    expect(drainer.status().running).toBe(false);
    await drainer.drainOnce();
    const s = drainer.status();
    expect(s).toMatchObject({ drained: 1, ticks: 1, running: false });
    expect(s.lastTickAt).toBeTruthy();
    expect(s.lastDrainAt).toBeTruthy();
    drainer.start();
    expect(drainer.status().running).toBe(true);
    drainer.stop();
    expect(drainer.status().running).toBe(false);
  });
});

describe('parseInboxItem — both sides of the quarantine boundary', () => {
  it('accepts the receiver-written shape', () => {
    expect(parseInboxItem(report('fb-1'))).toMatchObject({ feedbackId: 'fb-1' });
  });
  it.each([
    ['not json', 'zzz{'],
    ['non-object', '"str"'],
    ['missing feedbackId', '{"title":"t","description":"d"}'],
    ['empty feedbackId', '{"feedbackId":"","title":"t","description":"d"}'],
    ['missing title', '{"feedbackId":"fb-1","description":"d"}'],
    ['missing description', '{"feedbackId":"fb-1","title":"t"}'],
  ])('rejects %s', (_label, content) => {
    expect(parseInboxItem(content)).toBeNull();
  });
});
