/**
 * Owner email runs the outbound check (docs/specs/spec-review-link-at-delivery.md §3) through the
 * real POST /email/send-to-owner wiring in createRoutes. Only the IntelligenceProvider and the
 * email service are faked: the switch, the metadata allowlist, checkOutboundMessage, the gate,
 * the override chain, the email-specific localhost refusal and the forward order are real.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { MessagingToneGate } from '../../src/core/MessagingToneGate.js';
import { buildRequestTimeoutOverrides, OUTBOUND_MESSAGING_TIMEOUT_MS } from '../../src/server/middleware.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const PASS = { pass: true, rule: '', issue: '', suggestion: '' };
const B2 = { pass: false, rule: 'B2_FILE_PATH', issue: 'A raw path.', suggestion: 'Say it in words.' };
const acked = (prompt: string, rule: string): boolean => new RegExp(`acknowledged these rules[^\\n]*${rule}`).test(prompt);
const REASON = 'The owner asked for the exact path in this email.';
const REPORT = 'The nightly report: 3 jobs ran, all green.';

describe('POST /email/send-to-owner with the outbound check', () => {
  let close: () => Promise<void> = async () => {};
  afterEach(async () => { await close(); });

  async function start(o: { verdict?: (prompt: string) => typeof PASS | typeof B2; enabled?: boolean; holder?: boolean } = {}) {
    const prompts: string[] = [];
    const submitted: Array<{ subject: string; ownerText: string }> = [];
    const forwarded: Array<{ id: string }> = [];
    const dedupChecks: string[] = [];
    const verdict = o.verdict ?? (() => PASS);
    const provider = { evaluate: vi.fn(async (prompt: string) => { prompts.push(prompt); return JSON.stringify(verdict(prompt)); }) } as unknown as IntelligenceProvider;
    const app = express();
    app.use(express.json());
    const ctx: any = {
      config: {
        authToken: 'test', stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'email-tone-')), port: 0, projectName: 'test', projectDir: os.tmpdir(),
        developmentAgent: true,
        messaging: [{ type: 'telegram', config: { chatId: '-1001234567890' } }],
        ...(o.enabled === undefined ? {} : { toneGate: { ownerEmailCheck: { enabled: o.enabled } } }),
      },
      messagingToneGate: new MessagingToneGate(provider),
      emailService: {
        submit: (row: { id: string; subject: string; ownerText: string }) => { submitted.push(row); return { ok: true, id: row.id, status: 'pending' }; },
        outboxRows: () => [],
        status: () => ({}),
      },
      conversationBindAuth: { verify: (t: string) => (t === 'good-token' ? { bootstrapConversationIds: [42] } : null) },
      sessionManager: { clearInjectionTracker: () => {}, memoryAudienceKind: () => 'owner' },
      coordinator: { enabled: true, holdsLease: () => o.holder ?? true },
      emailForwardToHolder: async (input: { id: string }) => { forwarded.push(input); return { ok: true, id: input.id }; },
      topicMemory: { getRecentMessages: () => [{ fromUser: false, text: REPORT, timestamp: new Date().toISOString() }] },
      outboundDedupGate: { check: ({ text }: { text: string }) => { dedupChecks.push(text); return { duplicate: true, similarity: 1, matchedText: text }; } },
      telegram: {
        getChatId: () => '-1001234567890',
        sendToTopic: async (t: number) => ({ messageId: 1, topicId: t }),
        findLoggedMessages: async () => [],
        searchLog: () => [],
      },
    };
    app.use(createRoutes(ctx));
    const srv = app.listen(0);
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    close = () => new Promise<void>((r) => srv.close(() => r()));
    const send = async (body: Record<string, unknown>) => {
      const res = await fetch(`${url}/email/send-to-owner`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Instar-Request': '1', 'X-Instar-Bind-Token': 'good-token' }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json().catch(() => ({})) as any };
    };
    return { send, prompts, submitted, forwarded, dedupChecks };
  }

  it('switch off: today\'s route — no review, and metadata is not read', async () => {
    const h = await start({ enabled: false, verdict: () => B2 });
    const r = await h.send({ subject: 'Report', text: 'see src/foo.ts', metadata: { anything: 1 } });
    expect(r.status).toBe(200);
    expect(h.prompts).toHaveLength(0);
    expect(h.submitted).toHaveLength(1);
  });

  it('switch on: a nudge is a 422 advisory and nothing is submitted; an ack with a reason sends after a clean re-review', async () => {
    const h = await start({ verdict: (p) => (acked(p, 'B2_FILE_PATH') ? PASS : B2) });
    const first = await h.send({ subject: 'Report', text: 'see src/foo.ts' });
    expect(first.status).toBe(422);
    expect(first.body.error).toBe('tone-gate-advisory');
    expect(h.submitted).toHaveLength(0);
    // The gate renders the candidate JSON-encoded: subject and text joined by a blank line.
    expect(h.prompts[0]).toContain(JSON.stringify('Report\n\nsee src/foo.ts'));
    const second = await h.send({ subject: 'Report', text: 'see src/foo.ts', metadata: { toneAdvisoryAck: 'B2_FILE_PATH', toneAdvisoryAckReason: REASON } });
    expect(second.status).toBe(200);
    expect(h.submitted).toHaveLength(1);
  });

  it('a metadata key outside the four tone keys is a 400, and so is a non-string value', async () => {
    const h = await start();
    expect((await h.send({ subject: 's', text: 't', metadata: { allowLocalhostLink: true } })).status).toBe(400);
    expect((await h.send({ subject: 's', text: 't', metadata: { toneAdvisoryAck: 7 } })).status).toBe(400);
    expect(h.submitted).toHaveLength(0);
  });

  it('a loopback link gets the email-specific refusal, with no metadata escape', async () => {
    const h = await start();
    const r = await h.send({ subject: 's', text: 'open http://localhost:4040/dashboard' });
    expect(r.status).toBe(422);
    expect(r.body.blockedBy).toBe('localhost-link-guard');
    expect(r.body.error).toContain('Email not sent');
    expect(r.body.error).not.toContain('allowLocalhostLink');
  });

  it('a standby judges before it forwards: a nudge never reaches the holder; a pass forwards once', async () => {
    const nudged = await start({ holder: false, verdict: () => B2 });
    expect((await nudged.send({ subject: 's', text: 'see src/foo.ts' })).status).toBe(422);
    expect(nudged.forwarded).toHaveLength(0);
    await close();
    const clean = await start({ holder: false });
    const r = await clean.send({ subject: 's', text: 'All green.' });
    expect(r.status).toBe(200);
    expect(clean.forwarded).toHaveLength(1);
    expect(clean.prompts).toHaveLength(1);
  });

  it('an email repeating a recent chat report is never compared against the chat (no duplicate check)', async () => {
    const h = await start();
    const r = await h.send({ subject: 'Report', text: REPORT });
    expect(r.status).toBe(200);
    expect(h.dedupChecks).toHaveLength(0);
  });

  it('the route carries the messaging timeout', () => {
    expect(buildRequestTimeoutOverrides()['/email/send-to-owner']).toBe(OUTBOUND_MESSAGING_TIMEOUT_MS);
  });
});
