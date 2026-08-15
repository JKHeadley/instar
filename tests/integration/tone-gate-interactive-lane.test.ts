/**
 * Operator replies must claim the interactive spawn reserve.
 *
 * The host spawn cap reserves slots for a lane the tone gate is explicitly named
 * for — a synchronous, user-blocking review. The gate claims that reserve only
 * when its caller says BOTH that the recipient is the operator AND that a human
 * is waiting on THIS message.
 *
 * It always received the first. Nothing ever sent the second, so the lane was
 * permanently background and the reserved slots were never claimed: operator
 * replies queued behind background work and were held closed under load.
 * Observed, not theorised — 12 refusals in ~15 minutes during a live demo, with
 * the limiter reporting liveInteractive: 0 the whole time.
 *
 * This is the integration tier deliberately, because the unit tier cannot see the
 * defect: the gate's lane logic was already correct and already tested. What was
 * broken was the WIRING, and only driving the real route through the real gate
 * shows whether the flag arrives.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { MessagingToneGate } from '../../src/core/MessagingToneGate.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';

interface TestServer {
  port: number;
  close: () => Promise<void>;
}

async function listen(app: express.Express): Promise<TestServer> {
  return await new Promise<TestServer>((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ port, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

/** Captures the attribution every review call carries — the thing under test. */
function capturingProvider(seen: IntelligenceOptions['attribution'][]): IntelligenceProvider {
  return {
    evaluate: async (_prompt: string, options?: IntelligenceOptions) => {
      seen.push(options?.attribution);
      return JSON.stringify({ pass: true, rule: '', issue: '', suggestion: '' });
    },
  };
}

/** A topic whose verified operator is a single known uid → recipientClass 'operator'. */
function operatorStore(uid = 'uid-operator'): unknown {
  return {
    asVerifiedOperator: () => ({ uid, displayName: 'Justin' }),
    all: () => ({ 29723: { uid, displayName: 'Justin' } }),
  };
}

function buildApp(opts: {
  toneGate: MessagingToneGate | null;
  sent: Array<{ topicId: number; text: string }>;
  topicOperatorStore?: unknown;
}): express.Express {
  const app = express();
  app.use(express.json());
  const ctx: any = {
    config: {
      authToken: 'test',
      stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'interactive-lane-')),
      port: 0,
      projectName: 'echo',
    },
    messagingToneGate: opts.toneGate,
    topicOperatorStore: opts.topicOperatorStore ?? operatorStore(),
    telegram: {
      sendToTopic: async (topicId: number, text: string) => {
        opts.sent.push({ topicId, text });
      },
    },
    sessionManager: { clearInjectionTracker: () => {} },
  };
  app.use(createRoutes(ctx));
  return app;
}

async function postReply(
  port: number,
  topicId: number,
  body: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  // The topic is a PATH parameter on this route, not a body field.
  const res = await fetch(`http://127.0.0.1:${port}/telegram/reply/${topicId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.text() };
}

describe('POST /telegram/reply — interactive spawn reserve', () => {
  let server: TestServer;
  let seen: IntelligenceOptions['attribution'][];
  let sent: Array<{ topicId: number; text: string }>;

  beforeEach(() => {
    seen = [];
    sent = [];
  });

  afterEach(async () => {
    await server?.close();
  });

  it('THE FIX: an operator reply is marked as the interactive lane', async () => {
    const app = buildApp({ toneGate: new MessagingToneGate(capturingProvider(seen)), sent });
    server = await listen(app);

    const r = await postReply(server.port, 29723, { text: 'a normal conversational reply to your message' });
    expect(r.status, r.body).toBe(200);

    expect(seen.length).toBeGreaterThan(0);
    const attr = seen[0]!;
    expect(attr?.component).toBe('MessagingToneGate');
    // The load-bearing assertion: without this the reserved slots are never
    // claimed and the reply competes with background work for the same cap.
    expect((attr as { lane?: string })?.lane).toBe('interactive');
  });

  it('CONTROL: an AUTOMATED send stays on the background lane', async () => {
    // Proactive cadence sends have nobody blocked on them. If this also claimed
    // the reserve, the reserve would be meaningless — so this control is what
    // makes the test above mean something narrower than "everything is interactive".
    const app = buildApp({ toneGate: new MessagingToneGate(capturingProvider(seen)), sent });
    server = await listen(app);

    await postReply(server.port, 29723, {
      text: 'a scheduled cadence update nobody is waiting on',
      metadata: { messageKind: 'automated' },
    });

    expect(seen.length).toBeGreaterThan(0);
    expect((seen[0] as { lane?: string })?.lane).not.toBe('interactive');
  });

  it('CONTROL: a NON-operator recipient never claims the reserve, even for a reply', async () => {
    // The reserve exists for the operator-facing path. A topic with no verified
    // operator resolves 'external' and must stay on the background lane, so a
    // stray external conversation cannot eat the operator's protected capacity.
    const app = buildApp({
      toneGate: new MessagingToneGate(capturingProvider(seen)),
      sent,
      topicOperatorStore: { asVerifiedOperator: () => null, all: () => ({}) },
    });
    server = await listen(app);

    await postReply(server.port, 29723, { text: 'a reply to someone who is not the operator' });

    expect(seen.length).toBeGreaterThan(0);
    expect((seen[0] as { lane?: string })?.lane).not.toBe('interactive');
  });

  it('the message still sends — the lane is capacity routing, not a verdict', async () => {
    const app = buildApp({ toneGate: new MessagingToneGate(capturingProvider(seen)), sent });
    server = await listen(app);

    await postReply(server.port, 29723, { text: 'a normal conversational reply' });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.topicId).toBe(29723);
  });
});
