/**
 * Route-level tests for the outbound-advisory surface
 * (spec outbound-jargon-filepath-gap §2.4, §6 integration matrix):
 *
 *  - POST /messaging/preflight: 200 with advisories for an automated
 *    raw-path text (never a content-4xx); empty advisories for a `reply`
 *    kind; disabled flag honored live; unrecognized kind coerced.
 *  - /telegram/reply DELIVERS a raw-path automated message exactly as today
 *    (the server never blocks — the advisory loop is script-side).
 *  - metadata.advisoryAck → the server writes the `acked` audit row.
 *  - The jargon + filePath signals reach the gate on an automated send, and
 *    jargon is NOT computed for a conversational reply (§2.2 scope).
 *
 * Built on the minimal createRoutes(ctx) harness (same pattern as
 * localhost-link-guard-route.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';

let dir: string;
let server: { url: string; close: () => Promise<void> };
let sendToTopic: ReturnType<typeof vi.fn>;
let reviewCalls: Array<{ text: string; context: any }>;
let liveValues: Record<string, unknown>;

async function boot(opts: { withGate?: boolean } = {}) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'advisory-routes-'));
  fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
  sendToTopic = vi.fn().mockResolvedValue({ messageId: 42, topicId: 12476 });
  reviewCalls = [];
  liveValues = {};
  const ctx: any = {
    telegram: { sendToTopic },
    sessionManager: { clearInjectionTracker: vi.fn() },
    state: { listSessions: () => [] },
    config: { authToken: 't', stateDir: path.join(dir, '.instar'), port: 0 },
    liveConfig: {
      get: <T,>(p: string, def: T): T => (p in liveValues ? (liveValues[p] as T) : def),
    },
    ...(opts.withGate
      ? {
          messagingToneGate: {
            review: async (text: string, context: any) => {
              reviewCalls.push({ text, context });
              return { pass: true, rule: '', issue: '', suggestion: '', latencyMs: 1 };
            },
          },
        }
      : {}),
  };
  const app = express();
  app.use(express.json());
  app.use(createRoutes(ctx));
  server = await new Promise((resolve) => {
    const srv = app.listen(0, () =>
      resolve({
        url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
        close: () => new Promise<void>((r) => srv.close(() => r())),
      }),
    );
  });
}

afterEach(async () => {
  await server?.close();
});

async function preflight(body: Record<string, unknown>) {
  return fetch(`${server.url}/messaging/preflight`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function reply(text: string, metadata?: Record<string, unknown>) {
  return fetch(`${server.url}/telegram/reply/12476`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(metadata ? { text, metadata } : { text }),
  });
}

const RAW_PATH_TEXT = 'Reminder: review /Users/justin/projects/overdue.md — 3 items pending';

describe('POST /messaging/preflight', () => {
  beforeEach(() => boot());

  it('returns 200 with advisories for an automated raw-path text (never a content-4xx)', async () => {
    const res = await preflight({
      text: RAW_PATH_TEXT,
      messageKind: 'automated',
      topicId: 12476,
      jobSlug: 'evolution-overdue-check',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.advisories.length).toBeGreaterThan(0);
    expect(body.advisories[0].code).toBe('RAW_FILE_PATH');
    expect(body.advisories[0].guidance).toBeTruthy();
  });

  it('returns empty advisories for the SAME text as a reply kind (§2.2 scope)', async () => {
    const res = await preflight({ text: RAW_PATH_TEXT, messageKind: 'reply' });
    expect(res.status).toBe(200);
    expect((await res.json()).advisories).toEqual([]);
  });

  it('clean automated text returns empty advisories', async () => {
    const res = await preflight({
      text: 'Your weekly summary is ready — three items need your eyes.',
      messageKind: 'automated',
      topicId: 12476,
      jobSlug: 'weekly-summary',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).advisories).toEqual([]);
  });

  it('disabled via live config → behaves like a clean preflight (rollback lever, no restart)', async () => {
    liveValues['messaging.outboundAdvisory.enabled'] = false;
    const res = await preflight({
      text: RAW_PATH_TEXT,
      messageKind: 'automated',
      topicId: 12476,
      jobSlug: 'evolution-overdue-check',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.advisories).toEqual([]);
    expect(body.disabled).toBe(true);
  });

  it('an unrecognized messageKind is coerced (treated as non-automated, empty advisories)', async () => {
    const res = await preflight({ text: RAW_PATH_TEXT, messageKind: 'totally-bogus' });
    expect(res.status).toBe(200);
    expect((await res.json()).advisories).toEqual([]);
  });

  it('missing text is the only hard 400', async () => {
    const res = await preflight({ messageKind: 'automated', topicId: 1, jobSlug: 'x' });
    expect(res.status).toBe(400);
  });

  it('automated without topicId/jobSlug is refused (audit keying) — fail-open script-side', async () => {
    const res = await preflight({ text: RAW_PATH_TEXT, messageKind: 'automated' });
    expect(res.status).toBe(400);
  });

  it('writes the advised audit row readable via GET /messaging/advisory-log', async () => {
    await preflight({
      text: RAW_PATH_TEXT,
      messageKind: 'automated',
      topicId: 12476,
      jobSlug: 'evolution-overdue-check',
    });
    const res = await fetch(`${server.url}/messaging/advisory-log?limit=5`);
    expect(res.status).toBe(200);
    const { entries } = await res.json();
    expect(entries.length).toBe(1);
    expect(entries[0].action).toBe('advised');
    expect(entries[0].jobSlug).toBe('evolution-overdue-check');
    expect(entries[0].advisories).toEqual(['RAW_FILE_PATH']);
  });
});

describe('/telegram/reply — the server NEVER blocks on the advisory surface', () => {
  beforeEach(() => boot());

  it('DELIVERS a raw-path automated message exactly as today (advisory loop is script-side)', async () => {
    const res = await reply(RAW_PATH_TEXT, {
      messageKind: 'automated',
      senderClass: 'llm-session',
      jobSlug: 'evolution-overdue-check',
    });
    expect(res.status).toBe(200);
    expect(sendToTopic).toHaveBeenCalledTimes(1);
  });

  it('metadata.advisoryAck → the server writes the acked audit row (single writer)', async () => {
    const res = await reply(RAW_PATH_TEXT, {
      messageKind: 'automated',
      senderClass: 'llm-session',
      jobSlug: 'evolution-overdue-check',
      advisoryAck: true,
      advisoryCodes: ['RAW_FILE_PATH'],
    });
    expect(res.status).toBe(200);
    const logRes = await fetch(`${server.url}/messaging/advisory-log?limit=5`);
    const { entries } = await logRes.json();
    const acked = entries.filter((e: any) => e.action === 'acked');
    expect(acked).toHaveLength(1);
    expect(acked[0].advisories).toEqual(['RAW_FILE_PATH']);
    expect(acked[0].jobSlug).toBe('evolution-overdue-check');
  });

  it('a preemptive ack on a clean message audits acked with empty codes (itself a signal)', async () => {
    await reply('All done — the weekly check finished cleanly.', {
      messageKind: 'automated',
      senderClass: 'llm-session',
      jobSlug: 'weekly-check',
      advisoryAck: true,
      advisoryCodes: [],
    });
    const logRes = await fetch(`${server.url}/messaging/advisory-log?limit=5`);
    const { entries } = await logRes.json();
    expect(entries[0].action).toBe('acked');
    expect(entries[0].advisories).toEqual([]);
  });
});

describe('signals reaching the gate (§2.2/§2.3 consumers)', () => {
  beforeEach(() => boot({ withGate: true }));

  it('automated send: jargon + filePath signals reach the authority, kind threaded', async () => {
    const res = await reply('the cron job for src/core/Foo.ts exited with code 1', {
      messageKind: 'automated',
      senderClass: 'llm-session',
      jobSlug: 'some-job',
    });
    expect(res.status).toBe(200);
    expect(reviewCalls).toHaveLength(1);
    const { context } = reviewCalls[0];
    expect(context.messageKind).toBe('automated');
    expect(context.signals.jargon).toBeDefined();
    expect(context.signals.filePath).toBeDefined();
    expect(context.signals.filePath.match).toContain('src/core/Foo.ts');
  });

  it('conversational reply: jargon NOT computed (over-block scope), filePath still a signal', async () => {
    const res = await reply('I changed src/core/Foo.ts — the watchdog logic is cleaner now');
    expect(res.status).toBe(200);
    expect(reviewCalls).toHaveLength(1);
    const { context } = reviewCalls[0];
    expect(context.signals.jargon).toBeUndefined();
    expect(context.signals.filePath).toBeDefined();
  });

  it('jargonAlways:false kills the jargon signal live (rollback without restart)', async () => {
    liveValues['messaging.outboundFloor.jargonAlways'] = false;
    await reply('the cron job exited with code 1', {
      messageKind: 'automated',
      senderClass: 'llm-session',
      jobSlug: 'some-job',
    });
    expect(reviewCalls[0].context.signals.jargon).toBeUndefined();
  });

  it('an unrecognized metadata.messageKind is coerced to unknown end-to-end', async () => {
    await reply('hello there, just checking in', { messageKind: 'bogus-kind' });
    expect(reviewCalls[0].context.messageKind).toBe('unknown');
  });
});

describe('cross-channel single-sourcing (§2.2 — the computation lives in evaluateOutbound)', () => {
  beforeEach(() => boot({ withGate: true }));

  it('a NON-telegram (slack) automated send gets the jargon + filePath signals uniformly', async () => {
    // The harness ctx has no slack adapter — add one for this test by booting
    // a fresh app whose ctx carries a stub slack.
    await server.close();
    const slackSend = vi.fn().mockResolvedValue('ts-1');
    const ctx: any = {
      telegram: { sendToTopic },
      slack: { sendToChannel: slackSend, resolveRoutingKey: (c: string) => c },
      sessionManager: { clearInjectionTracker: vi.fn() },
      state: { listSessions: () => [] },
      config: { authToken: 't', stateDir: path.join(dir, '.instar'), port: 0 },
      messagingToneGate: {
        review: async (text: string, context: any) => {
          reviewCalls.push({ text, context });
          return { pass: true, rule: '', issue: '', suggestion: '', latencyMs: 1 };
        },
      },
    };
    const app = express();
    app.use(express.json());
    app.use(createRoutes(ctx));
    server = await new Promise((resolve) => {
      const srv = app.listen(0, () =>
        resolve({
          url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
          close: () => new Promise<void>((r) => srv.close(() => r())),
        }),
      );
    });

    const res = await fetch(`${server.url}/slack/reply/C123`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'the cron job for src/core/Foo.ts exited with code 1',
        metadata: { messageKind: 'automated' },
      }),
    });
    expect(res.status).toBe(200);
    expect(reviewCalls).toHaveLength(1);
    expect(reviewCalls[0].context.channel).toBe('slack');
    expect(reviewCalls[0].context.messageKind).toBe('automated');
    expect(reviewCalls[0].context.signals.jargon).toBeDefined();
    expect(reviewCalls[0].context.signals.filePath).toBeDefined();
  });
});
