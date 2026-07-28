/**
 * Tier-2 integration test for the GrowthDigestPublisher delivery path.
 *
 * Exercises the REAL route-layer funnel: createRoutes attaches the production
 * `postToUpdatesTopic` (which runs the shared `evaluateOutbound` chokepoint) to a
 * real publisher via `attachSender`. Then we drive the publisher's `publishOnce`
 * and assert what actually reaches telegram.sendToTopic — proving the publisher
 * delivers through the guarded Updates-topic path, never a raw second send path.
 *
 * Also a regression on the funnel extraction: POST /telegram/post-update still
 * 400s with no Updates topic and 422s on a localhost link (the route adapter still
 * maps evaluateOutbound's decision to the same statuses/bodies).
 */

import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import {
  GrowthDigestPublisher,
  type GrowthDigestAuditEntry,
} from '../../src/monitoring/GrowthDigestPublisher.js';
import type { GrowthDigest } from '../../src/monitoring/GrowthMilestoneAnalyst.js';
import type { ToneReviewResult } from '../../src/core/MessagingToneGate.js';

const UPDATES_TOPIC_ID = 777;
const NOW = new Date('2026-06-10T17:30:00.000Z');

function activeDigest(): GrowthDigest {
  return {
    generatedAt: '2026-06-08T11:00:00.000Z',
    calm: false,
    summary: 'Growth digest: 1 stalling.',
    findings: [
      { rule: 'R3', priority: 'normal', subjectId: 'feat-x', title: 'Feature X', detail: 'No movement in 18 days.', suggestedAction: 'review' },
    ],
    counts: { incubating: 1, promotionReady: 0, expiredUnproven: 0, stalling: 1, specPatterns: 0, correctionPatterns: 0, devGateDark: 0 },
  };
}

interface Built {
  publisher: GrowthDigestPublisher;
  audits: GrowthDigestAuditEntry[];
  sends: { topicId: number; text: string }[];
  ctx: Record<string, unknown>;
}

function build(opts: {
  mode?: 'off' | 'dry-run' | 'live';
  noTopic?: boolean;
  toneBlock?: boolean;
  digest?: GrowthDigest;
} = {}): Built {
  const audits: GrowthDigestAuditEntry[] = [];
  const sends: { topicId: number; text: string }[] = [];
  const publisher = new GrowthDigestPublisher({
    buildDigest: () => opts.digest ?? activeDigest(),
    cron: '0 11 * * 1',
    mode: opts.mode ?? 'live',
    now: () => NOW,
    audit: (e) => audits.push(e),
    // send intentionally NOT set — createRoutes attaches the guarded sender.
  });
  const review = async (): Promise<ToneReviewResult> =>
    opts.toneBlock
      ? { pass: false, rule: 'B1', issue: 'blocked', suggestion: 'fix', latencyMs: 1 }
      : { pass: true, rule: '', issue: '', suggestion: '', latencyMs: 1 };
  const ctx: Record<string, unknown> = {
    config: { authToken: 'test', stateDir: '/tmp', port: 0 },
    state: { get: (k: string) => (k === 'agent-updates-topic' && !opts.noTopic ? UPDATES_TOPIC_ID : undefined) },
    messagingToneGate: { review },
    telegram: { sendToTopic: async (topicId: number, text: string) => { sends.push({ topicId, text }); } },
    growthDigestPublisher: publisher,
  };
  // Registering the routes attaches postToUpdatesTopic to the publisher.
  createRoutes(ctx as never);
  return { publisher, audits, sends, ctx };
}

describe('GrowthDigestPublisher — guarded delivery path (integration)', () => {
  it('live + Updates topic → exactly one send to the Updates topic + "sent" audit', async () => {
    const b = build({ mode: 'live' });
    await b.publisher.publishOnce(NOW, 'manual');
    expect(b.sends).toHaveLength(1);
    expect(b.sends[0].topicId).toBe(UPDATES_TOPIC_ID);
    expect(b.sends[0].text).toContain('Growth check-in');
    expect(b.sends[0].text).toContain('Feature X');
    expect(b.audits.find((a) => a.action === 'sent')).toBeDefined();
  });

  it('no Updates topic → publisher records send-blocked(no-updates-topic), nothing sent (never a fallback topic)', async () => {
    const b = build({ mode: 'live', noTopic: true });
    await b.publisher.publishOnce(NOW, 'manual');
    expect(b.sends).toHaveLength(0);
    expect(b.audits.find((a) => a.action === 'send-blocked')?.reason).toBe('no-updates-topic');
  });

  it('dry-run → nothing sent, "dry-run" audit carries the would-send text', async () => {
    const b = build({ mode: 'dry-run' });
    await b.publisher.publishOnce(NOW, 'manual');
    expect(b.sends).toHaveLength(0);
    const dry = b.audits.find((a) => a.action === 'dry-run');
    expect(dry?.wouldSend).toContain('Growth check-in');
  });

  it('tone gate blocks → publisher records send-blocked(tone-gate-blocked), nothing sent', async () => {
    const b = build({ mode: 'live', toneBlock: true });
    await b.publisher.publishOnce(NOW, 'manual');
    expect(b.sends).toHaveLength(0);
    expect(b.audits.find((a) => a.action === 'send-blocked')?.reason).toBe('tone-gate-blocked');
  });
});

// ── Route regression: POST /telegram/post-update after the funnel extraction ──

describe('POST /telegram/post-update — behavior preserved by the funnel extraction', () => {
  let srv: { url: string; close: () => Promise<void> } | undefined;
  afterEach(async () => {
    await srv?.close();
    srv = undefined;
  });

  async function listen(ctx: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use(createRoutes(ctx as never));
    return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
      const s = app.listen(0, () => {
        const port = (s.address() as AddressInfo).port;
        resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => s.close(() => r())) });
      });
    });
  }

  it('400s when no Updates topic is configured (never a fallback topic)', async () => {
    const ctx = {
      config: { authToken: 'test', stateDir: '/tmp', port: 0 },
      state: { get: () => undefined },
      telegram: { sendToTopic: async () => {} },
    };
    srv = await listen(ctx);
    const res = await fetch(srv.url + '/telegram/post-update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(400);
  });

  it('422s on a localhost link (localhost-link-guard still wired through evaluateOutbound)', async () => {
    const sends: unknown[] = [];
    const ctx = {
      config: { authToken: 'test', stateDir: '/tmp', port: 0 },
      state: { get: (k: string) => (k === 'agent-updates-topic' ? UPDATES_TOPIC_ID : undefined) },
      telegram: { sendToTopic: async () => { sends.push(1); } },
    };
    srv = await listen(ctx);
    const res = await fetch(srv.url + '/telegram/post-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'open http://localhost:4040/dashboard now' }),
    });
    const body = await res.json().catch(() => ({}));
    expect(res.status).toBe(422);
    expect(body.blockedBy).toBe('localhost-link-guard');
    expect(sends).toHaveLength(0);
  });
});
