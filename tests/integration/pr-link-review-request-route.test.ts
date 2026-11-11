/**
 * pr-link-review-request-route — the real /telegram/reply route (real origin boot,
 * real createRoutes) requests the operator as reviewer on a PR link before the
 * reply goes out (Echo Bugs topic 10000002537). Only the Telegram wire and gh are faked.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { bootTelegramOrigin } from '../../src/messaging/telegram-origin/TelegramOriginBoot.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { createRoutes } from '../../src/server/routes.js';
import type { OriginSessionLifecycle } from '../../src/messaging/telegram-origin/OriginSessionRegistry.js';
import type { AuthenticatedGhExec } from '../../src/core/githubRuntime.js';
import { originLeaseDependencyFixture } from '../helpers/originLeaseDependency.js';
import { compileOriginWorker } from '../helpers/telegramOriginStore.js';
import { waitForOriginDisplayReady } from '../helpers/telegramOriginReady.js';

let worker: URL;
beforeAll(async () => { worker = await compileOriginWorker(); });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close(); } finally { vi.unstubAllGlobals(); }
}, 30_000);

const LINK = 'The standards PR is ready for your approval: https://github.com/JKHeadley/instar/pull/3046';

function fakeGh(opts: { postFails?: boolean }) {
  const requested: string[] = [];
  const calls: string[][] = [];
  const gh: AuthenticatedGhExec = async (args) => {
    calls.push(args);
    const ok = (body: unknown) => ({ code: 0, stdout: JSON.stringify(body), stderr: '' });
    const p = args[1] === '-X' ? args[3] : args[1];
    if (p === 'user') return { code: 0, stdout: 'EchoOfDawn\n', stderr: '' };
    if (p === 'repos/JKHeadley/instar/pulls/3046') return ok({ state: 'open', user: { login: 'EchoOfDawn' }, head: { sha: 'h' },
      requested_reviewers: requested.map(login => ({ login })), base: { repo: { owner: { login: 'JKHeadley', type: 'User' } } } });
    if (p.endsWith('/reviews?per_page=100')) return ok([{ user: { login: 'JKHeadley' }, state: 'DISMISSED', commit_id: 'old' }]);
    if (p === 'repos/JKHeadley/instar/pulls/3046/requested_reviewers') {
      if (args[1] === '-X') {
        if (opts.postFails) return { code: 1, stdout: '', stderr: 'gh: Validation Failed (HTTP 422)' };
        requested.push('JKHeadley'); return ok({});
      }
      return ok({ users: requested.map(login => ({ login })) });
    }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  return { gh, calls, requested };
}

async function replyApp(gh: AuthenticatedGhExec) {
  const lease = await originLeaseDependencyFixture();
  cleanup.push(lease.close);
  const telegramConfig = { token: '123:pr-link-fixture', chatId: '-100123', messageOrigin: { display: { enabled: false } } };
  const config = { projectDir: lease.root, stateDir: lease.stateDir, projectName: 'echo', port: 0, authToken: 'fixture-auth',
    messaging: [{ type: 'telegram', enabled: true, config: telegramConfig }] };
  await writeFile(path.join(lease.stateDir, 'config.json'), JSON.stringify(config));
  let lifecycle: OriginSessionLifecycle | undefined;
  const boot = await bootTelegramOrigin({ config: config as never, token: telegramConfig.token, workerUrl: worker,
    noticeOwner: true, holdsLease: () => true, isSessionLive: () => true,
    attachSessionLifecycle: value => { lifecycle = value; }, diagnoseUnknown: async () => undefined, onNoticeState: () => undefined });
  cleanup.push(() => boot.close());
  const token = await lifecycle!.issue({ sessionId: 'session', harnessId: 'codex-cli', projectDir: lease.root, configuredModel: 'fixture-model' });
  const telegram = new TelegramAdapter(telegramConfig, lease.stateDir, { suppressLifelineAutoCreate: true });
  const app = express(); app.use(express.json());
  app.use(createRoutes({ state: { getSession: () => undefined }, config, telegramOrigin: boot.runtime, telegram,
    sessionManager: { clearInjectionTracker: () => undefined }, prLinkReviewGh: gh } as never));
  await waitForOriginDisplayReady(boot.runtime, { chatId: '-100123', topicId: '42' });
  const wire = vi.fn(async (_url: unknown, _init?: { body?: string }) => new Response(JSON.stringify({ ok: true, result: { message_id: 10, chat: { id: -100123 }, message_thread_id: 42 } })));
  vi.stubGlobal('fetch', wire);
  const reply = (text: string) => request(app).post('/telegram/reply/42').set('X-Instar-Origin-Session', token).send({ text });
  const sentText = () => wire.mock.calls.map(c => String(JSON.parse(String(c[1]?.body ?? '{}')).text ?? '')).join('\n');
  return { reply, wire, sentText };
}

describe('/telegram/reply requests the reviewer on a PR link before sending', () => {
  it('requests and verifies the reviewer, then sends the reply unchanged', async () => {
    const g = fakeGh({});
    const { reply, sentText } = await replyApp(g.gh);
    const res = await reply(LINK);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(g.requested).toEqual(['JKHeadley']);
    expect(g.calls.filter(c => c[1] === '-X' && c[2] === 'POST')).toHaveLength(1);
    expect(sentText()).toContain('pull/3046');
    expect(sentText()).not.toContain('could not confirm');
  }, 60_000);

  it('when GitHub refuses, the reply still goes out and says the request is unconfirmed', async () => {
    const g = fakeGh({ postFails: true });
    const { reply, sentText } = await replyApp(g.gh);
    const res = await reply(LINK);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(sentText()).toContain('could not confirm JKHeadley as a reviewer on PR #3046');
  }, 60_000);

  it('a reply without a PR link never touches GitHub', async () => {
    const g = fakeGh({});
    const { reply } = await replyApp(g.gh);
    expect((await reply('Plain status update with no links at all, just words.')).status).toBe(200);
    expect(g.calls).toHaveLength(0);
  }, 60_000);
});
