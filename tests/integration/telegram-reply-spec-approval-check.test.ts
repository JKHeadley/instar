// safe-fs-allow: test file — tmp state dirs only.
/**
 * Integration test — B24_SPEC_APPROVAL_UNCHECKED through the real POST /telegram/reply
 * route (Echo Bugs topic 10000002750).
 *
 * Proves the wiring end-to-end: the route reads this machine's constitution-check
 * ledger on a reply with NO phrase pre-filter, the gate adds the B24 rule and the
 * records to the prompt, and a B24 verdict HOLDS the founding message (422, not
 * sent) — and an acknowledgement cannot push it through. A request carrying its
 * check result is delivered. Only the IntelligenceProvider is faked.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { MessagingToneGate } from '../../src/core/MessagingToneGate.js';
import { recordSpecConstitutionCheck } from '../../src/core/specConstitutionCheckLedger.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const FOUNDING =
  'The design spec for the Work Board handoff is written and reviewed. Can you approve it so I start building?';
const RIGHT_SHAPE =
  'The design spec for the Work Board handoff is ready. Constitution check: ran 03:20, nothing at risk. Approve it so I start building?';

function capture(response: { pass: boolean; rule: string; issue: string; suggestion: string }) {
  const prompts: string[] = [];
  const provider = {
    evaluate: vi.fn(async (p: string) => { prompts.push(p); return JSON.stringify(response); }),
  } as unknown as IntelligenceProvider;
  return { provider, prompts };
}

async function start(toneGate: MessagingToneGate, sent: string[], stateDir: string) {
  const app = express();
  app.use(express.json());
  const ctx: any = {
    config: { authToken: 'test', stateDir, port: 0, projectName: 'echo' },
    messagingToneGate: toneGate,
    telegram: {
      sendToTopic: async (topicId: number, text: string) => { sent.push(text); return { messageId: sent.length, topicId }; },
    },
    sessionManager: { clearInjectionTracker: () => {} },
  };
  app.use(createRoutes(ctx));
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

async function reply(url: string, body: Record<string, unknown>) {
  const res = await fetch(`${url}/telegram/reply/142440`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
}

describe('B24 SPEC APPROVAL through POST /telegram/reply', () => {
  let server: { url: string; close: () => Promise<void> } | undefined;
  afterEach(async () => { await server?.close(); server = undefined; });

  it('the founding ask reaches the gate with the rule and the ledger records, and a B24 verdict holds it', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-approval-route-'));
    recordSpecConstitutionCheck(stateDir, {
      slug: 'other-spec',
      markdown: '# Some other spec',
      report: { findings: [], standardsChecked: 98, degraded: false, checkedAt: new Date().toISOString() },
    });
    const { provider, prompts } = capture({
      pass: false,
      rule: 'B24_SPEC_APPROVAL_UNCHECKED',
      issue: 'asks approval of a design spec with no constitution check result',
      suggestion: 'run the built-in constitution check and carry its result',
    });
    const sent: string[] = [];
    server = await start(new MessagingToneGate(provider), sent, stateDir);
    const res = await reply(server.url, { text: FOUNDING });
    const p = prompts.find((x) => x.includes('B24 SPEC APPROVAL NEEDS ITS CONSTITUTION CHECK')) ?? '';
    expect(p).not.toBe('');
    expect(p).toContain('"slug":"other-spec"');
    expect(res.status).toBe(422);
    expect(res.body.rule).toBe('B24_SPEC_APPROVAL_UNCHECKED');
    expect(sent).toHaveLength(0);

    // An acknowledgement cannot push it through: B24 is a hold, not a nudge.
    const acked = await reply(server.url, { text: FOUNDING, metadata: { toneAdvisoryAck: 'B24_SPEC_APPROVAL_UNCHECKED', toneAdvisoryAckReason: 'I think it is fine' } });
    expect(acked.status).toBe(422);
    expect(sent).toHaveLength(0);
  });

  it('a request carrying its check result is delivered', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-approval-route-'));
    const { provider, prompts } = capture({ pass: true, rule: '', issue: '', suggestion: '' });
    const sent: string[] = [];
    server = await start(new MessagingToneGate(provider), sent, stateDir);
    const res = await reply(server.url, { text: RIGHT_SHAPE });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(prompts.some((x) => x.includes('no built-in constitution check is recorded'))).toBe(true);
  });
});
