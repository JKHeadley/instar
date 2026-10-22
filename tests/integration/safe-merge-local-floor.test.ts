/**
 * safe-merge local floor against a stub agent server (real HTTP on loopback,
 * the real `makeServerGet` client with its Bearer header) and a fake `gh`:
 * selectSafeMergeFloor → checkLocalFloor end to end
 * (docs/specs/local-verify-merge-authority.md §3).
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkLocalFloor, makeServerGet, makeServerPost, selectSafeMergeFloor, UNMEASURABLE } from '../../scripts/safe-merge.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const MAIN = 'c'.repeat(40);
const REPO = 'JKHeadley/instar';
const TOKEN = 'test-token';
const ELI16 = `## ELI16\n${'This explains the change in plain words for a reader. '.repeat(6)}\n`;

interface StubState {
  status: { code: number; body: unknown };
  record: { code: number; body: unknown };
  executor: { code: number; body: unknown };
  post: { code: number; body: unknown } | 'hangup';
  posted: unknown[];
  seenPaths: string[];
  sawAuth: string[];
}

function record(over: Record<string, unknown> = {}) {
  return {
    repo: REPO, pr: 42, headSha: HEAD, baseSha: BASE, baseRefName: 'main', outcome: 'success',
    lanes: [{ name: 'unit', gating: true, files: 3, tests: 30, failed: 0, seconds: 9 }],
    harnessChanging: false, protectedPath: false, skipsAdded: false, testsRemoved: false, ...over,
  };
}

let server: http.Server;
let port: number;
let st: StubState;

beforeEach(async () => {
  st = {
    status: { code: 200, body: { floor: { configured: 'local', effective: 'local', reason: 'ok' }, mainHealth: { state: 'healthy', mainHead: MAIN } } },
    record: { code: 200, body: { record: record() } },
    executor: { code: 503, body: { error: 'feedback executor unavailable' } },
    post: { code: 202, body: { ok: true, status: 'queued', position: 0 } },
    posted: [],
    seenPaths: [],
    sawAuth: [],
  };
  server = http.createServer((req, res) => {
    st.seenPaths.push(req.url ?? '');
    st.sawAuth.push(String(req.headers.authorization ?? ''));
    const send = (r: { code: number; body: unknown }) => { res.writeHead(r.code, { 'content-type': 'application/json' }); res.end(JSON.stringify(r.body)); };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send({ code: 401, body: { error: 'unauthorized' } });
    const u = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'POST' && u.pathname === '/local-verify') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        st.posted.push(JSON.parse(raw || 'null'));
        if (st.post === 'hangup') { req.socket.destroy(); return; }
        send(st.post);
      });
      return;
    }
    if (u.pathname === '/local-verify/status') return send(st.status);
    if (u.pathname === '/local-verify/record') return send(st.record);
    if (u.pathname === '/feedback-factory/execute/status') return send(st.executor);
    return send({ code: 404, body: {} });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => { await new Promise<void>((r) => server.close(() => r())); });

const agent = () => ({ port, tokenSource: 'inline', inlineToken: TOKEN, floor: 'local', repo: REPO, expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley' });

function fakeGh(over: { reviews?: unknown[]; files?: unknown[]; head?: string; fail?: string } = {}) {
  const ghJson = (args: string[]) => {
    const joined = args.join(' ');
    if (over.fail && joined.includes(over.fail)) throw new Error(`gh failed: ${over.fail}`);
    if (args[0] === 'pr' && args[1] === 'view') {
      return { headRefOid: over.head ?? HEAD, baseRefName: 'main', state: 'OPEN', title: 'docs: thing', body: ELI16, author: { login: 'EchoOfDawn', is_bot: false } };
    }
    if (joined.includes('/files')) return [over.files ?? [{ filename: 'docs/a.md', status: 'modified' }]];
    if (joined.includes('/reviews')) return [over.reviews ?? []];
    throw new Error(`unexpected gh ${joined}`);
  };
  const ghText = () => null;
  return { ghJson, ghText };
}

async function run(ghOver: Parameters<typeof fakeGh>[0] = {}) {
  const serverGet = makeServerGet({ port, token: TOKEN });
  const view = { author: { login: 'EchoOfDawn' }, isCrossRepository: false };
  const sel = await selectSafeMergeFloor({ repo: REPO, view, agent: agent(), override: undefined, serverGet });
  if (sel.floor !== 'local' || sel.refusal) return { sel, verdict: null };
  const { ghJson, ghText } = fakeGh(ghOver);
  const serverPost = makeServerPost({ port, token: TOKEN });
  const verdict = await checkLocalFloor({ repo: REPO, pr: 42, pinnedHead: HEAD, status: sel.status, agent: agent(), serverGet, serverPost, ghJson, ghText });
  return { sel, verdict };
}

describe('safe-merge local floor against a stub agent server', () => {
  it('admits a green record and sends the Bearer token from config', async () => {
    const { verdict } = await run();
    expect(verdict).toEqual({ ok: true });
    expect(st.seenPaths.some((p) => p.startsWith(`/local-verify/record?pr=42&head=${HEAD}&base=main`))).toBe(true);
    expect(st.sawAuth.every((a) => a === `Bearer ${TOKEN}`)).toBe(true);
  });

  it.each([
    [202, { ok: true, status: 'queued', position: 0 }, 'queued'],
    [202, { ok: true, status: 'already-queued', position: 1 }, 'already-queued'],
    [202, { ok: true, status: 'in-flight' }, 'in-flight'],
    [403, { ok: false, code: 'untrusted-head' }, 'untrusted-head'],
    [429, { ok: false, code: 'queue-full' }, 'queue-full'],
  ])('no record → POSTs /local-verify {pr} and answers verify-pending (POST %s → %s)', async (code, body, label) => {
    st.record = { code: 404, body: { error: 'no record' } };
    st.post = { code, body };
    const { verdict } = await run();
    expect(verdict?.result).toBe('refused:verify-pending');
    expect(verdict?.problems.join(' ')).toContain(`verify request: ${label}`);
    expect(st.posted).toEqual([{ pr: 42 }]);
  });

  it('no record and the POST answers without a readable outcome → unmeasurable', async () => {
    st.record = { code: 404, body: { error: 'no record' } };
    st.post = { code: 500, body: { error: 'boom' } };
    expect((await run()).verdict?.result).toBe(UNMEASURABLE);
  });

  it('no record and the POST connection fails → unmeasurable', async () => {
    st.record = { code: 404, body: { error: 'no record' } };
    st.post = 'hangup';
    expect((await run()).verdict?.result).toBe(UNMEASURABLE);
  });

  it('a present record never POSTs', async () => {
    await run();
    expect(st.posted).toEqual([]);
  });

  it('a server error on the record read is unmeasurable', async () => {
    st.record = { code: 500, body: {} };
    expect((await run()).verdict?.result).toBe(UNMEASURABLE);
  });

  it('server down → the floor selection itself refuses as unmeasurable', async () => {
    await new Promise<void>((r) => server.close(() => r()));
    const serverGet = makeServerGet({ port, token: TOKEN, timeoutMs: 2000 });
    const sel = await selectSafeMergeFloor({ repo: REPO, view: { author: { login: 'EchoOfDawn' }, isCrossRepository: false }, agent: agent(), serverGet });
    expect(sel.refusal?.result).toBe(UNMEASURABLE);
    server = http.createServer(); await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); // for afterEach
  });

  it('the server effective floor of actions returns the Actions floor (the rollback)', async () => {
    st.status = { code: 200, body: { floor: { configured: 'local', effective: 'actions', reason: 'rollback' }, mainHealth: { state: 'healthy', mainHead: MAIN } } };
    const { sel } = await run();
    expect(sel.floor).toBe('actions');
  });

  it('a moved head refuses before the record is read', async () => {
    const { verdict } = await run({ head: 'd'.repeat(40) });
    expect(verdict?.result).toBe('refused:head-moved');
  });

  it('a GitHub read failure is unmeasurable', async () => {
    expect((await run({ fail: '/files' })).verdict?.result).toBe(UNMEASURABLE);
  });

  it('main-red: an older record is refused, a record verified against the current main head admitted', async () => {
    st.status = { code: 200, body: { floor: { configured: 'local', effective: 'local', reason: 'ok' }, mainHealth: { state: 'main-red', mainHead: MAIN } } };
    expect((await run()).verdict?.result).toBe('refused:main-red');
    st.record = { code: 200, body: { record: record({ baseSha: MAIN }) } };
    expect((await run()).verdict).toEqual({ ok: true });
  });

  it('a harness-changing record: no operator approval → refused; approved but executor not constructed → approver-dependent', async () => {
    st.record = { code: 200, body: { record: record({ harnessChanging: true }) } };
    expect((await run()).verdict?.result).toBe('refused:needs-operator-approval');
    const approved = [{ user: { login: 'JKHeadley' }, state: 'APPROVED', commit_id: HEAD, submitted_at: '2026-10-21T00:00:00Z' }];
    const r = await run({ reviews: approved });
    expect(r.verdict?.result).toBe('refused:approver-dependent');
    expect(r.verdict?.problems.join(' ')).toMatch(/executor-not-constructed/);
  });

  it('a harness-changing record with the operator approval and a matching executor acceptance merges', async () => {
    st.record = { code: 200, body: { record: record({ harnessChanging: true }) } };
    st.executor = { code: 200, body: { availability: { approver: 'JKHeadley', independence: { independent: false, reasons: ['browser-profile-account'], accepted: true } } } };
    const approved = [{ user: { login: 'JKHeadley' }, state: 'APPROVED', commit_id: HEAD, submitted_at: '2026-10-21T00:00:00Z' }];
    expect((await run({ reviews: approved })).verdict).toEqual({ ok: true });
  });

  it('a failing merge-time body check refuses (src change without a decision record)', async () => {
    const { verdict } = await run({ files: [{ filename: 'src/x.ts', status: 'modified' }] });
    expect(verdict?.result).toBe('refused:body-checks');
  });
});
