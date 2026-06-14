// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Integration tests (Tier 2) — the full Option-B receiving pipeline over REAL HTTP:
 *
 *   handleFeedbackSubmit (ported intake defenses)
 *     → BlobInboxStore → BlobInboxClient → [fake Vercel Blob HTTP server]
 *     → InboxDrainer → JsonlFeedbackStore (real, on disk)
 *
 * The fake Blob server implements the pinned wire protocol (PUT pathname with
 * random suffix, GET /?prefix= list, GET content by URL, POST /delete) so both
 * halves of the pipeline are exercised through real sockets, not stubs.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHmac } from 'node:crypto';
import { handleFeedbackSubmit } from '../../src/feedback-factory/receiver/handlers.js';
import { BlobInboxStore } from '../../src/feedback-factory/receiver/BlobInboxStore.js';
import { BlobInboxClient } from '../../src/feedback-factory/inbox/BlobInboxClient.js';
import { InboxDrainer } from '../../src/feedback-factory/inbox/InboxDrainer.js';
import { JsonlFeedbackStore } from '../../src/feedback-factory/store/JsonlFeedbackStore.js';
import { RateLimiter, RATE_LIMITS } from '../../src/feedback-factory/receiver/defense.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

/** Minimal in-process Vercel-Blob-protocol fake (the pinned REST surface). */
export class FakeBlobServer {
  private server: http.Server;
  private objects = new Map<string, string>(); // storedPathname -> content
  baseUrl = '';
  private suffixCounter = 0;

  constructor() {
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const addr = this.server.address() as { port: number };
    this.baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  count(prefix: string): number {
    return [...this.objects.keys()].filter((p) => p.startsWith(prefix)).length;
  }

  seed(pathname: string, content: string): void {
    this.objects.set(pathname, content);
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url ?? '/', this.baseUrl);
      if (req.method === 'PUT') {
        const pathname = url.pathname.replace(/^\//, '');
        const suffixed = req.headers['x-add-random-suffix'] === '1'
          ? pathname.replace(/(\.json)?$/, `-s${this.suffixCounter++}$1`)
          : pathname;
        this.objects.set(suffixed, body);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ url: `${this.baseUrl}/${suffixed}`, pathname: suffixed }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/delete') {
        const { urls } = JSON.parse(body) as { urls: string[] };
        for (const u of urls) this.objects.delete(new URL(u).pathname.replace(/^\//, ''));
        res.end('{}');
        return;
      }
      if (req.method === 'GET' && url.pathname === '/') {
        const prefix = url.searchParams.get('prefix') ?? '';
        const limit = Number(url.searchParams.get('limit') ?? 1000);
        const blobs = [...this.objects.entries()]
          .filter(([p]) => p.startsWith(prefix))
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(0, limit)
          .map(([p, c]) => ({ url: `${this.baseUrl}/${p}`, pathname: p, size: c.length, uploadedAt: new Date().toISOString() }));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ blobs, hasMore: false }));
        return;
      }
      if (req.method === 'GET') {
        const pathname = url.pathname.replace(/^\//, '');
        const content = this.objects.get(pathname);
        if (content === undefined) {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        res.end(content);
        return;
      }
      res.statusCode = 405;
      res.end();
    });
  }
}

const NOW = () => Date.now();
const UA = { 'user-agent': 'instar/1.3.0' };
const SECRET = 'integration-secret';

describe('feedback-inbox pipeline (Tier 2) — accept → durable inbox → drain → canonical store', () => {
  let blob: FakeBlobServer;
  let dataDir: string;

  beforeAll(async () => {
    blob = new FakeBlobServer();
    await blob.start();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-pipeline-'));
  });

  afterAll(async () => {
    await blob.stop();
    SafeFsExecutor.safeRmSync(dataDir, { recursive: true, force: true, operation: 'tests/integration/feedback-inbox-pipeline.test.ts' });
  });

  it('an HMAC-signed report flows end-to-end into the durable JSONL store', async () => {
    const client = new BlobInboxClient({ token: 'tok', apiBase: blob.baseUrl });

    // ── Front half: the ported intake pipeline writes the durable inbox object. ──
    const reportBody = { type: 'bug', title: 'integration title', description: 'a sufficiently long description', feedbackId: 'fb-integ-001' };
    const ts = String(NOW());
    const sig = createHmac('sha256', SECRET).update(`${ts}.${JSON.stringify(reportBody)}`).digest('hex');
    const out = await handleFeedbackSubmit(
      { headers: { ...UA, 'x-instar-signature': sig, 'x-instar-timestamp': ts }, body: reportBody },
      { store: new BlobInboxStore(client), rateLimiter: new RateLimiter(RATE_LIMITS), secret: SECRET, now: NOW() },
    );
    expect(out.status).toBe(200);
    expect(out.json).toMatchObject({ id: 'fb-integ-001', received: true });
    expect(blob.count('inbox/')).toBe(1); // durable BEFORE any operated machine is involved

    // ── Operated half: the drainer ingests into the REAL durable store. ──
    const store = new JsonlFeedbackStore(dataDir);
    const drainer = new InboxDrainer({ client, store });
    const pass = await drainer.drainOnce();
    expect(pass).toMatchObject({ drained: 1, errors: 0 });
    expect(blob.count('inbox/')).toBe(0); // inbox cleared after commit

    // Durable on disk — a fresh store over the same dir sees the verified row.
    const reread = new JsonlFeedbackStore(dataDir);
    expect(reread.hasFeedback('fb-integ-001')).toBe(true);
    const row = reread.getUnprocessedFeedback()[0];
    expect(row).toMatchObject({ feedbackId: 'fb-integ-001', verified: true, status: 'unprocessed' });
    expect(typeof row.receivedAt).toBe('string');
  });

  it('a retransmit after drain is deduped at ingest (at-least-once made idempotent)', async () => {
    const client = new BlobInboxClient({ token: 'tok', apiBase: blob.baseUrl });
    const store = new JsonlFeedbackStore(dataDir); // already holds fb-integ-001

    // Retransmit lands in the inbox again (front-side dedup can't see drained ids — by design).
    const out = await handleFeedbackSubmit(
      { headers: UA, body: { type: 'bug', title: 'integration title', description: 'a sufficiently long description', feedbackId: 'fb-integ-001' } },
      { store: new BlobInboxStore(client), rateLimiter: new RateLimiter(RATE_LIMITS), secret: SECRET, now: NOW() },
    );
    expect(out.status).toBe(200);
    expect(blob.count('inbox/')).toBe(1);

    const drainer = new InboxDrainer({ client, store });
    const pass = await drainer.drainOnce();
    expect(pass).toMatchObject({ drained: 0, duplicates: 1 });
    expect(blob.count('inbox/')).toBe(0);
    // Still exactly one unprocessed row for the id.
    expect(store.getUnprocessedFeedback().filter((f) => f.feedbackId === 'fb-integ-001')).toHaveLength(1);
  });

  it('front-side dedup over the wire: same feedbackId while still in the inbox → duplicate:true', async () => {
    const client = new BlobInboxClient({ token: 'tok', apiBase: blob.baseUrl });
    const deps = () => ({ store: new BlobInboxStore(client), rateLimiter: new RateLimiter(RATE_LIMITS), secret: SECRET, now: NOW() });
    const body = { type: 'bug', title: 'dup title', description: 'a sufficiently long description', feedbackId: 'fb-dup-0001' };

    const first = await handleFeedbackSubmit({ headers: UA, body }, deps());
    expect(first.json).toMatchObject({ id: 'fb-dup-0001', received: true });
    const second = await handleFeedbackSubmit({ headers: UA, body }, deps());
    expect(second.json).toMatchObject({ id: 'fb-dup-0001', duplicate: true });
    expect(blob.count('inbox/fb-dup-0001')).toBe(1); // exactly one durable object

    // Clean up for other tests.
    const drainer = new InboxDrainer({ client, store: new JsonlFeedbackStore(dataDir) });
    await drainer.drainOnce();
  });

  it('a poison inbox object is quarantined over the wire (preserved, inbox cleared)', async () => {
    const client = new BlobInboxClient({ token: 'tok', apiBase: blob.baseUrl });
    blob.seed('inbox/poison-1.json', '<<<not json>>>');

    const drainer = new InboxDrainer({ client, store: new JsonlFeedbackStore(dataDir) });
    const pass = await drainer.drainOnce();
    expect(pass.quarantined).toBe(1);
    expect(blob.count('inbox/')).toBe(0);
    expect(blob.count('quarantine/')).toBe(1);
  });
});
