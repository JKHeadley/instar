/**
 * Route-level tests for "PR links request their reviewer" at the shared
 * outbound evaluator, driven through /telegram/reply (the minimal
 * createRoutes(ctx) harness, same pattern as localhost-link-guard-route).
 * Spec: docs/specs/pr-link-requests-reviewer.md.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { PrLinkReviewerCheck } from '../../src/core/PrLinkReviewerCheck.js';

const PR_URL = 'https://api.github.com/repos/JKHeadley/instar/pulls/3050';
const LINK = 'https://github.com/JKHeadley/instar/pull/3050';
const HEAD = 'c'.repeat(40);

function openPr() {
  return {
    state: 'open', merged: false, user: { login: 'EchoOfDawn' }, head: { sha: HEAD }, requested_reviewers: [],
    base: { repo: { owner: { login: 'JKHeadley', type: 'User' }, permissions: { push: true } } },
  };
}

describe('PR-link reviewer request — /telegram/reply chokepoint', () => {
  let server: { url: string; close: () => Promise<void> };
  let sendToTopic: ReturnType<typeof vi.fn>;
  let stateDir: string;
  let postStatus: number;
  let posts: Array<{ reviewers: string[] }>;
  let config: Record<string, unknown>;
  let verifiedUid: number | null;

  async function start(extraConfig: Record<string, unknown>, telegramExtra: Record<string, unknown> = {}) {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-link-reviewer-'));
    sendToTopic = vi.fn().mockResolvedValue({ messageId: 42, topicId: 12476 });
    posts = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const method = init.method ?? 'GET';
      if (method === 'GET' && url === PR_URL) return new Response(JSON.stringify(openPr()), { status: 200 });
      if (method === 'GET' && url === `${PR_URL}/reviews?per_page=100`) return new Response('[]', { status: 200 });
      if (method === 'POST' && url === `${PR_URL}/requested_reviewers`) {
        const body = JSON.parse(String(init.body)) as { reviewers: string[] };
        posts.push(body);
        return postStatus === 201
          ? new Response(JSON.stringify({ requested_reviewers: body.reviewers.map((login) => ({ login })) }), { status: 201 })
          : new Response(JSON.stringify({ message: 'nope' }), { status: postStatus });
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    config = { authToken: 't', stateDir, port: 0, ...extraConfig };
    const ctx: any = {
      telegram: { sendToTopic, ...telegramExtra },
      sessionManager: { clearInjectionTracker: vi.fn() },
      config,
      stateDir,
      state: { get: (k: string) => (k === 'agent-updates-topic' ? 999 : undefined), findSessionByTmux: () => undefined, getSession: () => undefined },
      topicOperatorStore: { asVerifiedOperator: () => (verifiedUid === null ? null : { uid: verifiedUid }) },
      prLinkReviewerCheck: new PrLinkReviewerCheck({ resolveToken: () => 'tok', fetchImpl }),
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

  beforeEach(() => {
    postStatus = 201;
    verifiedUid = null;
  });

  afterEach(async () => {
    await server.close();
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/pr-link-reviewer-route.test.ts' });
  });

  async function reply(text: string, metadata?: Record<string, unknown>) {
    return fetch(`${server.url}/telegram/reply/12476`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata ? { text, metadata } : { text }),
    });
  }

  it('on a development agent: requests the repo owner, then sends', async () => {
    await start({ developmentAgent: true });
    const res = await reply(`Ready for your review: ${LINK}`);
    expect(res.status).toBe(200);
    expect(posts).toEqual([{ reviewers: ['JKHeadley'] }]);
    expect(sendToTopic).toHaveBeenCalledTimes(1);
  });

  it('holds a conversational reply with a plain reason when the request fails, and never sends', async () => {
    await start({ developmentAgent: true });
    postStatus = 422;
    const res = await reply(`Ready for your review: ${LINK}`);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.blockedBy).toBe('pr-link-reviewer');
    expect(body.notSent).toBe(true);
    expect(body.pr).toBe('JKHeadley/instar#3050');
    expect(body.error).toContain('Not sent yet');
    // A 422 from GitHub recurs on retry: the sender is told so.
    expect(body.retryable).toBe(false);
    expect(sendToTopic).not.toHaveBeenCalled();
  });

  it('a transient GitHub failure on a reply is held as retryable', async () => {
    await start({ developmentAgent: true });
    postStatus = 502;
    const res = await reply(`Ready for your review: ${LINK}`);
    expect(res.status).toBe(422);
    expect((await res.json()).retryable).toBe(true);
  });

  it('an Agent Updates ship notice is delivered even when the request fails (availability first)', async () => {
    await start({ developmentAgent: true });
    postStatus = 502;
    const res = await fetch(`${server.url}/telegram/post-update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `Shipped: ${LINK}` }),
    });
    expect(res.status).toBe(200);
    expect(posts).toHaveLength(1);
    expect(sendToTopic).toHaveBeenCalledTimes(1);
  });

  it('an automated send is delivered even when the request fails (never silence a health alert)', async () => {
    await start({ developmentAgent: true });
    postStatus = 500;
    const res = await reply(`CI note: ${LINK}`, { messageKind: 'automated' });
    expect(res.status).toBe(200);
    expect(sendToTopic).toHaveBeenCalledTimes(1);
  });

  it('dark on the fleet: no GitHub call, message sends', async () => {
    await start({});
    const res = await reply(`Ready: ${LINK}`);
    expect(res.status).toBe(200);
    expect(posts).toEqual([]);
    expect(sendToTopic).toHaveBeenCalledTimes(1);
  });

  it('explicit enabled:false force-darks a development agent', async () => {
    await start({ developmentAgent: true, prLinkReviewer: { enabled: false } });
    postStatus = 422;
    expect((await reply(`Ready: ${LINK}`)).status).toBe(200);
    expect(posts).toEqual([]);
  });

  it('team: the verified recipient with a mapped GitHub login is the reviewer', async () => {
    verifiedUid = 777;
    await start({ developmentAgent: true, prLinkReviewer: { githubLogins: { '777': 'alice' }, reviewer: 'bob' } });
    expect((await reply(`For you: ${LINK}`)).status).toBe(200);
    expect(posts).toEqual([{ reviewers: ['alice'] }]);
  });

  it('a configured default reviewer beats the repo owner when the recipient has no mapping', async () => {
    verifiedUid = 1;
    await start({ developmentAgent: true, prLinkReviewer: { githubLogins: { '777': 'alice' }, reviewer: 'bob' } });
    expect((await reply(`For you: ${LINK}`)).status).toBe(200);
    expect(posts).toEqual([{ reviewers: ['bob'] }]);
  });

  it('a pool standby that relays to the lease holder makes no GitHub call (the holder checks on receipt)', async () => {
    await start({ developmentAgent: true }, { willRelay: () => true });
    postStatus = 422;
    const res = await reply(`Ready: ${LINK}`);
    expect(res.status).toBe(200);
    expect(posts).toEqual([]);
    expect(sendToTopic).toHaveBeenCalledTimes(1);
    expect(sendToTopic.mock.calls[0][2]).toMatchObject({ gateSkippedForRelay: true });
  });

  it('a message with no PR link is untouched', async () => {
    await start({ developmentAgent: true });
    postStatus = 500;
    expect((await reply('Merged, see https://github.com/JKHeadley/instar/issues/1')).status).toBe(200);
    expect(posts).toEqual([]);
  });
});
