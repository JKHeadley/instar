import { describe, expect, it, vi } from 'vitest';
import { makeZip } from '../helpers/exportZip.js';
import { receiveExportDelivery, type DeliveryBinding, type DeliveryDeps, type ExportNotice } from '../../src/import/exportDelivery.js';
import { createGmailExportNoticeSource } from '../../src/import/gmailExportNotice.js';

const binding: DeliveryBinding = { jobId: 'test-id', account: 'owner@example.test', workspace: 'personal', provider: 'chatgpt', requestedAt: 1_800_000_000_000 };
const sender = 'export@tm.openai.com'; // synthetic test account and message, never a release recipe
const subject = 'Test personal export ready';
const path = '/test-export-resource';
const secret = 'fake-signature-keep-local';
const link = 'https://chatgpt.com' + path + '?sig=' + secret;
const notice: ExportNotice = { provider: 'chatgpt', recipient: binding.account,
  authenticatedSenderDomain: 'tm.openai.com', receivedAt: binding.requestedAt + 1, link };
const archive = makeZip([{ name: 'conversations.json', data: '[]' }]);

function setup(n = notice) {
  const request = vi.fn(async () => new Response(new Uint8Array(archive)));
  const stage = vi.fn(async (chunks: AsyncIterable<Uint8Array>) => {
    const all = [];
    for await (const chunk of chunks) all.push(chunk);
    expect(Buffer.concat(all)).toEqual(archive);
    return 'private-receipt';
  });
  const deps: DeliveryDeps<string> = {
    now: () => binding.requestedAt + 1000,
    readNotice: async () => ({ kind: 'notice', notice: n }),
    verifyIdentity: async () => binding, resourcePaths: [path], fetch: request, stage,
  };
  return { deps, request, stage };
}

describe('bounded personal export redemption', () => {
  it('delivers exact ZIP bytes only to staging; no URL or cookies leave the adapter', async () => {
    const { deps, request } = setup();
    expect(await receiveExportDelivery(binding, deps)).toEqual({ kind: 'staged', archive: 'private-receipt' });
    expect(request).toHaveBeenCalledWith(new URL(link), expect.objectContaining({ credentials: 'omit', redirect: 'manual', referrerPolicy: 'no-referrer' }));
  });
  it.each([
    { recipient: 'other@example.test' }, { workspace: 'team' }, { provider: 'claude' }, { receivedAt: binding.requestedAt - 1 },
    { authenticatedSenderDomain: 'notopenai.com' }, { link: 'https://elsewhere.test' + path }, { link: 'https://chatgpt.com/another' },
  ])('refuses mismatched notice before opening it (%o)', async (change) => {
    const { deps, request } = setup({ ...notice, ...change } as ExportNotice);
    expect((await receiveExportDelivery(binding, deps)).kind).toBe('refused');
    expect(request).not.toHaveBeenCalled();
  });
  it('checks the active provider identity on redemption even with a valid authenticated message', async () => {
    const { deps, request } = setup();
    deps.verifyIdentity = async () => ({ ...binding, workspace: 'managed' });
    expect(await receiveExportDelivery(binding, deps)).toEqual({ kind: 'human-action', reason: 'verify-account' });
    expect(request).not.toHaveBeenCalled();
  });
  it('declines expired links before spending them', async () => {
    const { deps, request } = setup();
    deps.now = () => notice.receivedAt + 86_400_000;
    expect((await receiveExportDelivery(binding, deps))).toEqual({ kind: 'human-action', reason: 'expired' });
    expect(request).not.toHaveBeenCalled();
  });
  it('checks each redirect before a second request and refuses an unknown host', async () => {
    const { deps, request } = setup();
    request.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://other.test' + path } }));
    expect(await receiveExportDelivery(binding, deps)).toEqual({ kind: 'refused', reason: 'unsupported-link' });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('supports a relative redirect back to a vetted route', async () => {
    const { deps, request } = setup();
    request.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: path + '?next' } }));
    expect((await receiveExportDelivery(binding, deps)).kind).toBe('staged');
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('bounds streamed bytes even when the server omits size', async () => {
    const { deps } = setup();
    deps.maxBytes = 22;
    expect(await receiveExportDelivery(binding, deps)).toEqual({ kind: 'refused', reason: 'size-limit' });
  });
  it('refuses a successful HTML response, an early-returning sink and a cancelled run', async () => {
    const { deps, request } = setup();
    request.mockResolvedValueOnce(new Response('<html>' + secret + '</html>'));
    expect(await receiveExportDelivery(binding, deps)).toEqual({ kind: 'refused', reason: 'invalid-archive' });
    deps.stage = async () => 'should-not-be-published';
    expect(await receiveExportDelivery(binding, deps)).toEqual({ kind: 'refused', reason: 'invalid-archive' });
    deps.signal = AbortSignal.abort();
    expect(await receiveExportDelivery(binding, deps)).toEqual({ kind: 'interrupted', reason: 'cancelled' });
  });
  it('interrupts a pending stream read and never publishes partial bytes after cancellation', async () => {
    const { deps, request } = setup();
    const stop = new AbortController();
    const cancel = vi.fn();
    let announceStart!: () => void;
    const started = new Promise<void>(resolve => { announceStart = resolve; });
    request.mockResolvedValue(new Response(new ReadableStream({
      start(c) { c.enqueue(new Uint8Array(archive).slice(0, 32)); }, cancel,
    })));
    let published = false;
    deps.signal = stop.signal;
    deps.stage = async chunks => {
      for await (const part of chunks) if (part.length) announceStart();
      published = true;
      return 'private-receipt';
    };
    const pending = receiveExportDelivery(binding, deps);
    await started;
    stop.abort();
    expect(await pending).toEqual({ kind: 'interrupted', reason: 'cancelled' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(published).toBe(false);
  });
  it('redacts transport and source exceptions', async () => {
    const { deps, request } = setup();
    request.mockRejectedValue(new Error(link));
    expect(await receiveExportDelivery(binding, deps)).toEqual({ kind: 'interrupted', reason: 'unavailable' });
    deps.readNotice = async () => { throw new Error(secret); };
    expect(await receiveExportDelivery(binding, deps)).toEqual({ kind: 'interrupted', reason: 'unavailable' });
  });
});

const fields = [
  { name: 'Delivered-To', value: binding.account }, { name: 'From', value: 'Exports <' + sender + '>' },
  { name: 'Subject', value: subject }, { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass (p=REJECT) header.from=tm.openai.com' },
];
function mailbox(change: { account?: string; headers?: typeof fields; matches?: number; nextPage?: string; grantJob?: string; selected?: string; attested?: boolean } = {}) {
  const fetched: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); fetched.push(url.searchParams.get('format') || url.pathname.split('/').pop()!);
    expect(url.origin).toBe('https://gmail.googleapis.com');
    expect(init).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer synthetic-grant' } });
    if (url.pathname.endsWith('/profile')) return Response.json({ emailAddress: change.account || binding.account });
    if (url.pathname.endsWith('/messages')) {
      expect(url.searchParams.get('q')).toContain('to:' + binding.account + ' from:' + sender);
      return Response.json({ messages: Array.from({ length: change.matches ?? 1 }, (_, i) => ({ id: 'ab' + i })), nextPageToken: change.nextPage });
    }
    return Response.json({ id: url.pathname.split('/').pop(), internalDate: String(notice.receivedAt), payload: { mimeType: 'text/plain',
      headers: change.headers ?? fields, body: { data: Buffer.from(link).toString('base64url') } } });
  };
  const read = createGmailExportNoticeSource({ fetch: fetcher, subject, sender, linkPaths: [path],
    attestIncoming: async () => change.attested ?? true,
    grant: async () => ({ jobId: change.grantJob || binding.jobId, account: binding.account, selectedMessageId: change.selected, accessToken: 'synthetic-grant' }) });
  return { read, fetched };
}

describe('explicit account-specific Gmail export grant', () => {
  it('verifies the actual mailbox and notification metadata before reading one message body', async () => {
    const m = mailbox();
    const { deps } = setup();
    deps.readNotice = m.read;
    expect((await receiveExportDelivery(binding, deps)).kind).toBe('staged');
    expect(m.fetched).toEqual(['profile', 'messages', 'metadata', 'full']);
  });
  it('uses only the exact owner-selected message and never lists the inbox for that grant', async () => {
    const m = mailbox({ selected: 'ab1' });
    expect((await m.read(binding, new AbortController().signal)).kind).toBe('notice');
    expect(m.fetched).toEqual(['profile', 'metadata', 'full']);
  });
  it('plausible authentication headers in an imported message cannot by themselves authorize reading or redeeming it', async () => {
    const m = mailbox({ attested: false });
    expect(await m.read(binding, new AbortController().signal)).toEqual({ kind: 'human-action', reason: 'open-message' });
    expect(m.fetched).toEqual(['profile', 'messages', 'metadata']);
  });
  it('another job grant makes zero Gmail requests; a wrong mailbox reads no messages', async () => {
    const other = mailbox({ grantJob: 'foreign' });
    expect((await other.read(binding, new AbortController().signal)).kind).toBe('human-action');
    expect(other.fetched).toEqual([]);
    const wrong = mailbox({ account: 'other@example.test' });
    expect((await wrong.read(binding, new AbortController().signal)).kind).toBe('human-action');
    expect(wrong.fetched).toEqual(['profile']);
  });
  it('untrusted, duplicated or wrong-recipient headers cannot release a message body', async () => {
    for (const headers of [
      fields.filter(h => h.name !== 'Authentication-Results'), [...fields, fields[3]], [{ ...fields[0], value: 'other@example.test' }, ...fields.slice(1)],
      [...fields.slice(0, 3), { ...fields[3], value: 'foreign.test; dmarc=pass header.from=tm.openai.com' }],
    ]) {
      const m = mailbox({ headers });
      expect((await m.read(binding, new AbortController().signal)).kind).toBe('waiting');
      expect(m.fetched).not.toContain('full');
    }
  });
  it('ambiguous dated candidates or additional pages ask for the particular message without reading bodies', async () => {
    for (const args of [{ matches: 2 }, { nextPage: 'page' }]) {
      const m = mailbox(args);
      expect(await m.read(binding, new AbortController().signal)).toEqual({ kind: 'human-action', reason: 'ambiguous-notice' });
      expect(m.fetched).not.toContain('full');
    }
  });
});
