/**
 * B27_SPEC_REVIEW_UNLINKED and the override chain through the real POST /telegram/reply route
 * (docs/specs/spec-review-link-at-delivery.md §1-§2). Only the IntelligenceProvider is mocked:
 * the route opt-in, the switch, the detector, the gate, the per-call accepted citations, the chain
 * memory and the 422 plumbing are real.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { MessagingToneGate } from '../../src/core/MessagingToneGate.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const SECTION = '=== B27 A SPEC HANDED OVER FOR REVIEW CARRIES A READABLE LINK ===';
const ACKED = '=== ALREADY ACKNOWLEDGED ON THIS TEXT ===';
const PASS = { pass: true, rule: '', issue: '', suggestion: '' };
const B27 = { pass: false, rule: 'B27_SPEC_REVIEW_UNLINKED', issue: 'No readable link to the spec.', suggestion: 'Publish the companion and add its link.' };
const B25 = { pass: false, rule: 'B25_SPEC_APPROVAL_UNCHECKED', issue: 'No constitution check result.', suggestion: 'Run the check.' };
const B2 = { pass: false, rule: 'B2_FILE_PATH', issue: 'A raw path.', suggestion: 'Say it in words.' };
const UNLINKED = 'Ready for your review: docs/specs/spec-review-link-at-delivery.md, converged at the cap.';
const LINKED = 'Ready for your review: https://echo.example.dev/docs/abc12345-c4e6-4636-b97f-2e6ea4e32af9 (the spec, converged at the cap).';
const REASON = 'The operator asked for the repository path only, not a document.';

type Verdict = typeof PASS | typeof B27 | typeof B25 | typeof B2;
/** True when the prompt's ALREADY ACKNOWLEDGED section names this rule. */
const acked = (prompt: string, rule: string): boolean => new RegExp(`acknowledged these rules[^\\n]*${rule}`).test(prompt);

describe('B27 through POST /telegram/reply', () => {
  let close: () => Promise<void> = async () => {};
  afterEach(async () => { await close(); });

  async function start(o: { verdict: (prompt: string, n: number) => Verdict; developmentAgent?: boolean; enabled?: boolean; docs?: Record<string, { tombstoned: boolean; purged: boolean }>; views?: string[] }) {
    const sent: string[] = [];
    const prompts: string[] = [];
    const provider = { evaluate: vi.fn(async (prompt: string) => { prompts.push(prompt); return JSON.stringify(o.verdict(prompt, prompts.length)); }) } as unknown as IntelligenceProvider;
    const app = express();
    app.use(express.json());
    const ctx: any = {
      config: {
        authToken: 'test', stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'b27-route-')), port: 0, projectName: 'test', projectDir: os.tmpdir(),
        developmentAgent: o.developmentAgent ?? true,
        messaging: [{ type: 'telegram', config: { chatId: '-1001234567890' } }],
        ...(o.enabled === undefined ? {} : { toneGate: { specReviewLinks: { enabled: o.enabled } } }),
      },
      messagingToneGate: new MessagingToneGate(provider),
      telegram: {
        getChatId: () => '-1001234567890',
        sendToTopic: async (_t: number, text: string) => { sent.push(text); return { messageId: sent.length + 100, topicId: _t }; },
        findLoggedMessages: async (refs: Array<{ topicId: number | null; messageId: number }>) => refs.map((r) => ({ ...r, found: false })),
        searchLog: () => [],
      },
      sessionManager: { clearInjectionTracker: () => {} },
      documentFacts: (id: string) => o.docs?.[id] ?? null,
      viewer: { get: (id: string) => ((o.views ?? []).includes(id) ? { id } : null) },
      tunnel: { getExternalUrl: (p: string) => `https://echo.example.dev${p}` },
    };
    app.use(createRoutes(ctx));
    const srv = app.listen(0);
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    close = () => new Promise<void>((r) => srv.close(() => r()));
    const reply = async (text: string, metadata?: Record<string, unknown>) => {
      const res = await fetch(`${url}/telegram/reply/42`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(metadata ? { text, metadata } : { text }) });
      return { status: res.status, body: await res.json().catch(() => ({})) as any };
    };
    return { reply, sent, prompts };
  }

  it('an unlinked handoff is handed back as a B27 nudge, unsent, with the detector facts in the prompt', async () => {
    const h = await start({ verdict: (p) => (p.includes(SECTION) ? B27 : PASS) });
    const r = await h.reply(UNLINKED);
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('tone-gate-advisory');
    expect(r.body.rule).toBe('B27_SPEC_REVIEW_UNLINKED');
    expect(h.sent).toEqual([]);
    expect(h.prompts[0]).toContain(SECTION);
    expect(h.prompts[0]).toContain('spec-reference: "docs/specs/spec-review-link-at-delivery.md"');
  });

  it('the revision with a readable link sends', async () => {
    const h = await start({ verdict: (p) => (p.includes('/docs/abc12345') ? PASS : B27) });
    expect((await h.reply(UNLINKED)).status).toBe(422);
    const r = await h.reply(LINKED, { toneAdvisoryComplied: 'B27_SPEC_REVIEW_UNLINKED' });
    expect(r.status).toBe(200);
    expect(h.sent).toEqual([LINKED]);
  });

  it('is rendered on every eligible reply while the switch is on, and never when it is off or on the fleet', async () => {
    const on = await start({ verdict: () => PASS });
    await on.reply('Morning. The build is green.');
    expect(on.prompts[0]).toContain(SECTION);
    await close();
    const off = await start({ verdict: () => PASS, enabled: false });
    await off.reply(UNLINKED);
    expect(off.prompts[0]).not.toContain(SECTION);
    await close();
    const fleet = await start({ verdict: () => PASS, developmentAgent: false });
    await fleet.reply(UNLINKED);
    expect(fleet.prompts[0]).not.toContain(SECTION);
  });

  it('chain: a B27 override is re-reviewed without B27, and a B25 hold there keeps the message unsent', async () => {
    const h = await start({ verdict: (p) => (p.includes(SECTION) ? B27 : B25) });
    expect((await h.reply(UNLINKED)).status).toBe(422);
    const r = await h.reply(UNLINKED, { toneAdvisoryAck: 'B27_SPEC_REVIEW_UNLINKED', toneAdvisoryAckReason: REASON });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('tone-gate-blocked');
    expect(r.body.rule).toBe('B25_SPEC_APPROVAL_UNCHECKED');
    expect(h.sent).toEqual([]);
    const reReview = h.prompts[h.prompts.length - 1];
    expect(reReview).not.toContain(SECTION);
    expect(reReview).toContain(ACKED);
    expect(reReview).toContain('B27_SPEC_REVIEW_UNLINKED');
  });

  it('chain: B27, ack, B2 on the re-review, ack, then a passing review sends once, and B27 is never cited again', async () => {
    const h = await start({
      verdict: (p) => {
        if (p.includes(SECTION)) return B27;
        if (!acked(p, 'B2_FILE_PATH')) return B2;
        return PASS;
      },
    });
    expect((await h.reply(UNLINKED)).body.rule).toBe('B27_SPEC_REVIEW_UNLINKED');
    const second = await h.reply(UNLINKED, { toneAdvisoryAck: 'B27_SPEC_REVIEW_UNLINKED', toneAdvisoryAckReason: REASON });
    expect(second.status).toBe(422);
    expect(second.body.rule).toBe('B2_FILE_PATH');
    expect(h.sent).toEqual([]);
    const third = await h.reply(UNLINKED, { toneAdvisoryAck: 'B2_FILE_PATH', toneAdvisoryAckReason: REASON });
    expect(third.status).toBe(200);
    expect(h.sent).toEqual([UNLINKED]);
    // The ack's own first review (prompt 1) still shows B27, which is what makes the ack match;
    // after the chain opened, no review showed B27 again.
    expect(h.prompts[1]).toContain(SECTION);
    expect(h.prompts.slice(2).every((p) => !p.includes(SECTION))).toBe(true);
  });

  it('chain in the reverse order: B2 first, ack, B27, ack, then B25 holds', async () => {
    const h = await start({
      verdict: (p) => {
        if (!acked(p, 'B2_FILE_PATH')) return B2;
        if (p.includes(SECTION)) return B27;
        return B25;
      },
    });
    expect((await h.reply(UNLINKED)).body.rule).toBe('B2_FILE_PATH');
    const second = await h.reply(UNLINKED, { toneAdvisoryAck: 'B2_FILE_PATH', toneAdvisoryAckReason: REASON });
    expect(second.status).toBe(422);
    expect(second.body.rule).toBe('B27_SPEC_REVIEW_UNLINKED');
    const third = await h.reply(UNLINKED, { toneAdvisoryAck: 'B27_SPEC_REVIEW_UNLINKED', toneAdvisoryAckReason: REASON });
    expect(third.status).toBe(422);
    expect(third.body.rule).toBe('B25_SPEC_APPROVAL_UNCHECKED');
    expect(h.sent).toEqual([]);
  });

  it('own-host document and view links carry a local existence fact: yes, no (deleted here), unknown (absent here)', async () => {
    const LIVE = 'abc12345-c4e6-4636-b97f-2e6ea4e32af9';
    const GONE = 'bbc12345-c4e6-4636-b97f-2e6ea4e32af9';
    const ELSEWHERE = 'cbc12345-c4e6-4636-b97f-2e6ea4e32af9';
    const h = await start({
      verdict: () => PASS,
      docs: { [LIVE]: { tombstoned: false, purged: false }, [GONE]: { tombstoned: true, purged: false } },
      views: ['deadbeef01'],
    });
    await h.reply(`Ready for your review: docs/specs/a.md at https://echo.example.dev/docs/${LIVE}, https://echo.example.dev/docs/${GONE}, https://echo.example.dev/docs/${ELSEWHERE}, https://echo.example.dev/view/deadbeef01 and https://example.com/x`);
    expect(h.prompts[0]).toContain('L1 shape=doc own-host exists=yes; L2 shape=doc own-host exists=no; L3 shape=doc own-host exists=unknown; L4 shape=view own-host exists=yes; L5 shape=other');
  });

  it('an override with no reason is still refused, chain or not', async () => {
    const h = await start({ verdict: (p) => (p.includes(SECTION) ? B27 : PASS) });
    await h.reply(UNLINKED);
    const r = await h.reply(UNLINKED, { toneAdvisoryAck: 'B27_SPEC_REVIEW_UNLINKED' });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('tone-gate-advisory-reason-required');
    expect(h.sent).toEqual([]);
  });
});
