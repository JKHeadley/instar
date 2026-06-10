/**
 * Wiring-integrity test for the GrowthDigestPublisher (Testing Integrity Standard
 * — DI deps are not null, not no-ops, and delegate to the real implementations).
 *
 * Proves the three things the Slice-2 convergence review hardened:
 *  1. SINGLE FUNNEL — the publisher's sender is the SAME guarded path the route
 *     uses: the identical ctx.messagingToneGate that blocks the route's
 *     post-update also blocks the publisher's send (no un-guarded second path).
 *  2. SENDER NOT A NO-OP — `attachSender` actually wires the guarded sender:
 *     before registration a live send is 'no-sender'; after createRoutes it
 *     reaches telegram.sendToTopic.
 *  3. LEASE GATE WIRED — a standby coordinator (isAwake:false) yields ZERO sends.
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { GrowthDigestPublisher, type GrowthDigestAuditEntry } from '../../src/monitoring/GrowthDigestPublisher.js';
import type { GrowthDigest } from '../../src/monitoring/GrowthMilestoneAnalyst.js';
import type { ToneReviewResult } from '../../src/core/MessagingToneGate.js';

const UPDATES_TOPIC_ID = 4242;
const NOW = new Date('2026-06-10T17:30:00.000Z');

function digest(): GrowthDigest {
  return {
    generatedAt: '2026-06-08T11:00:00.000Z',
    calm: false,
    summary: 'Growth digest: 1 stalling.',
    findings: [{ rule: 'R3', priority: 'normal', subjectId: 's1', title: 'Stalled thing', detail: 'No movement.', suggestedAction: 'review' }],
    counts: { incubating: 0, promotionReady: 0, expiredUnproven: 0, stalling: 1, specPatterns: 0, correctionPatterns: 0, devGateDark: 0 },
  };
}

function mkPublisher(opts: { isAwake?: () => boolean } = {}): { pub: GrowthDigestPublisher; audits: GrowthDigestAuditEntry[] } {
  const audits: GrowthDigestAuditEntry[] = [];
  const pub = new GrowthDigestPublisher({
    buildDigest: () => digest(),
    cron: '0 11 * * 1',
    mode: 'live',
    now: () => NOW,
    isAwake: opts.isAwake,
    audit: (e) => audits.push(e),
  });
  return { pub, audits };
}

function mkCtx(pub: GrowthDigestPublisher | null, opts: { toneBlock?: boolean } = {}) {
  const sends: { topicId: number; text: string }[] = [];
  const review = async (): Promise<ToneReviewResult> =>
    opts.toneBlock
      ? { pass: false, rule: 'B2', issue: 'blocked', suggestion: 'x', latencyMs: 1 }
      : { pass: true, rule: '', issue: '', suggestion: '', latencyMs: 1 };
  const ctx = {
    config: { authToken: 'test', stateDir: '/tmp', port: 0 },
    state: { get: (k: string) => (k === 'agent-updates-topic' ? UPDATES_TOPIC_ID : undefined) },
    messagingToneGate: { review },
    telegram: { sendToTopic: async (topicId: number, text: string) => { sends.push({ topicId, text }); } },
    growthDigestPublisher: pub,
  };
  return { ctx, sends };
}

describe('GrowthDigestPublisher — wiring integrity', () => {
  it('SINGLE FUNNEL: the same tone gate that blocks the route ALSO blocks the publisher', async () => {
    const { pub, audits } = mkPublisher();
    const { ctx, sends } = mkCtx(pub, { toneBlock: true });

    // Route path: POST /telegram/post-update is blocked 422 by this gate.
    const app = express();
    app.use(express.json());
    app.use(createRoutes(ctx as never));
    const srv = await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
      const s = app.listen(0, () => {
        const port = (s.address() as AddressInfo).port;
        resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => s.close(() => r())) });
      });
    });
    const routeRes = await fetch(srv.url + '/telegram/post-update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'weekly check-in' }),
    });
    expect(routeRes.status).toBe(422);

    // Publisher path: the SAME gate blocks it — proving one shared chokepoint.
    await pub.publishOnce(NOW, 'manual');
    expect(sends).toHaveLength(0);
    expect(audits.find((a) => a.action === 'send-blocked')?.reason).toBe('tone-gate-blocked');
    await srv.close();
  });

  it('SENDER NOT A NO-OP: unattached → no-sender; after createRoutes → reaches telegram', async () => {
    // Unattached publisher (createRoutes never ran) → 'no-sender'.
    const lone = mkPublisher();
    await lone.pub.publishOnce(NOW, 'manual');
    expect(lone.audits.find((a) => a.action === 'send-blocked')?.reason).toBe('no-sender');

    // Attached via route registration → a live send reaches telegram.sendToTopic.
    const { pub, audits } = mkPublisher();
    const { ctx, sends } = mkCtx(pub);
    createRoutes(ctx as never); // registration attaches the guarded sender
    await pub.publishOnce(NOW, 'manual');
    expect(sends).toHaveLength(1);
    expect(sends[0].topicId).toBe(UPDATES_TOPIC_ID);
    expect(audits.find((a) => a.action === 'sent')).toBeDefined();
  });

  it('LEASE GATE WIRED: a standby coordinator (isAwake:false) yields ZERO sends', async () => {
    const { pub, audits } = mkPublisher({ isAwake: () => false });
    const { ctx, sends } = mkCtx(pub);
    createRoutes(ctx as never);
    await pub.publishOnce(NOW, 'cron');
    expect(sends).toHaveLength(0);
    expect(audits.find((a) => a.action === 'skipped-standby')).toBeDefined();
  });
});
