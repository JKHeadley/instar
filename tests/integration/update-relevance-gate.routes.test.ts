/**
 * Integration test — Update-Relevance Gate wired into the two update-class routes
 * that share the Agent Updates topic chokepoint:
 *   - POST /telegram/post-update        (the self-narration path)
 *   - POST /telegram/reply/:topicId     (used by the upgrade-notify session)
 *
 * Verifies the full HTTP pipeline:
 *   1. post-update, internal text      → 200 {suppressed:true}, NOT sent, audited
 *   2. post-update, user-relevant text → 200 {topicId}, sent UNCHANGED
 *   3. post-update, jargon text        → 200 {topicId}, sent as the PLAIN REWRITE
 *   4. post-update, gate disabled      → 200 {topicId}, sent unchanged, gate never invoked
 *   5. reply to a NON-Updates topic    → strict no-op: gate never invoked, sent unchanged
 *   6. reply to the Updates topic, internal text → 200 {suppressed:true}, NOT sent
 *
 * Same minimal-ctx + createRoutes harness as attention-route-tone-gate.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { UpdateRelevanceGate } from '../../src/core/UpdateRelevanceGate.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';

interface TestServer {
  url: string;
  close: () => Promise<void>;
}

async function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => srv.close(() => r())),
      });
    });
  });
}

const UPDATES_TOPIC = 42;

interface SendRecord {
  topicId: number;
  text: string;
}

function buildApp(opts: {
  provider: IntelligenceProvider;
  enabled: boolean;
  stateDir: string;
  sends: SendRecord[];
}): express.Express {
  const app = express();
  app.use(express.json());

  const ctx: any = {
    config: {
      authToken: 'test',
      stateDir: opts.stateDir,
      projectName: 'echo-test',
      port: 0,
      developmentAgent: opts.enabled,
    },
    state: {
      get: (key: string) => (key === 'agent-updates-topic' ? UPDATES_TOPIC : undefined),
    },
    telegram: {
      sendToTopic: async (topicId: number, text: string) => {
        opts.sends.push({ topicId, text });
        return { messageId: 1 };
      },
      // willRelay intentionally absent → typeof check is false → not relaying.
    },
    sessionManager: {
      clearInjectionTracker: () => {},
    },
    updateRelevanceGate: new UpdateRelevanceGate(opts.provider),
    // messagingToneGate intentionally absent → checkOutboundMessage passes through,
    // so we isolate the relevance gate's behavior (it runs BEFORE the tone gate).
  };

  app.use(createRoutes(ctx));
  return app;
}

function providerReturning(verdict: string, plainText = '', reason = 'test'): {
  provider: IntelligenceProvider;
  calls: () => number;
} {
  const evaluate = vi.fn(async (_prompt: string, _opts?: IntelligenceOptions) =>
    JSON.stringify({ verdict, reason, plainText }),
  );
  return { provider: { evaluate }, calls: () => evaluate.mock.calls.length };
}

describe('Update-Relevance Gate — route wiring', () => {
  let server: TestServer;
  let stateDir: string;
  let sends: SendRecord[];

  async function postUpdate(text: string) {
    const res = await fetch(server.url + '/telegram/post-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  async function reply(topicId: number, text: string) {
    const res = await fetch(server.url + `/telegram/reply/${topicId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  beforeEach(() => {
    sends = [];
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-relevance-')) + '/state';
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(async () => {
    await server?.close();
  });

  it('1. post-update with internal text → suppressed (200), not sent, audited', async () => {
    const { provider, calls } = providerReturning('internal', '', 'agent-internal plumbing');
    server = await listen(buildApp({ provider, enabled: true, stateDir, sends }));

    const r = await postUpdate(
      'Sibling Agent Server Control — I can now restart other agents’ servers during fleet maintenance.',
    );

    expect(r.status).toBe(200);
    expect(r.body.suppressed).toBe(true);
    expect(r.body.ok).toBe(true);
    expect(calls()).toBe(1);
    expect(sends.length).toBe(0); // never reached the user

    // "Nothing vanishes silently": the suppression is recorded to the audit trail.
    const auditPath = path.join(stateDir, '..', 'logs', 'update-relevance.jsonl');
    expect(fs.existsSync(auditPath)).toBe(true);
    const audit = fs.readFileSync(auditPath, 'utf8').trim();
    expect(audit).toContain('"verdict":"internal"');
    expect(audit).toContain('"deliver":false');
  });

  it('2. post-update with user-relevant text → sent unchanged', async () => {
    const { provider } = providerReturning('user-relevant');
    server = await listen(buildApp({ provider, enabled: true, stateDir, sends }));

    const text = 'Your dashboard now works on your phone — same PIN, just open the link I send you.';
    const r = await postUpdate(text);

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.topicId).toBe(UPDATES_TOPIC);
    expect(sends).toEqual([{ topicId: UPDATES_TOPIC, text }]);
  });

  it('3. post-update with jargon text → sent as the plain-language rewrite', async () => {
    const rewrite = 'You can now open your private reports from your phone — I’ll send a tap-to-open link.';
    const { provider } = providerReturning('jargon', rewrite);
    server = await listen(buildApp({ provider, enabled: true, stateDir, sends }));

    const r = await postUpdate('Added a tunnelUrl field to the private-view response payload.');

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(sends.length).toBe(1);
    expect(sends[0].text).toBe(rewrite); // the rewrite, not the jargon original
  });

  it('4. post-update with the gate DISABLED → byte-identical passthrough, gate never invoked', async () => {
    const { provider, calls } = providerReturning('internal'); // would suppress if it ran
    server = await listen(buildApp({ provider, enabled: false, stateDir, sends }));

    const text = 'Apprenticeship cycle recording (stricter) — internal-sounding text.';
    const r = await postUpdate(text);

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(calls()).toBe(0); // disabled → short-circuits before the LLM
    expect(sends).toEqual([{ topicId: UPDATES_TOPIC, text }]); // sent unchanged
  });

  it('5. reply to a NON-Updates topic → strict no-op: gate never invoked, sent unchanged', async () => {
    const { provider, calls } = providerReturning('internal'); // would suppress on the Updates topic
    server = await listen(buildApp({ provider, enabled: true, stateDir, sends }));

    const text = 'Hey — here is the answer to your question about the calendar sync.';
    const r = await reply(999, text); // 999 ≠ UPDATES_TOPIC

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(calls()).toBe(0); // off the Updates topic the gate is a strict no-op
    expect(sends).toEqual([{ topicId: 999, text }]);
  });

  it('6. reply TO the Updates topic with internal text → suppressed, not sent', async () => {
    const { provider, calls } = providerReturning('internal', '', 'agent-internal plumbing');
    server = await listen(buildApp({ provider, enabled: true, stateDir, sends }));

    const r = await reply(
      UPDATES_TOPIC,
      'Wired the SocketDisconnectSentinel into server startup.',
    );

    expect(r.status).toBe(200);
    expect(r.body.suppressed).toBe(true);
    expect(calls()).toBe(1);
    expect(sends.length).toBe(0);
  });
});
