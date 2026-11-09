/**
 * docs/specs/backup-email-sending.md, Transports: each transport is bound to one recipient and refuses another;
 * Resend sends exactly from/to/subject/text with an idempotency key; SMTP uses a fixed preset with TLS checked
 * against its host and binds the RCPT line (envelope.to); provider error text never leaves the transport.
 */
import { describe, it, expect } from 'vitest';
import { ResendTransport, SmtpTransport, RecipientRefusedError, smtpClientOptions, buildTransport, type SmtpClient } from '../../src/email/transports.js';
import type { EmailCredential } from '../../src/email/emailCore.js';

const OWNER = 'owner@example.com';

function fakeFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string, init: RequestInit = {}) => { calls.push({ url, init }); return handler(String(url), init); }) as unknown as typeof fetch;
  return { f, calls };
}

describe('Resend', () => {
  it('sends exactly from, to, subject and text, with the row id as the idempotency key', async () => {
    const { f, calls } = fakeFetch(() => new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 }));
    const t = new ResendTransport({ apiKey: 're_key', recipient: OWNER, fetch: f, timeoutMs: 5000 });
    const r = await t.send({ to: OWNER, subject: 'Echo: hi', text: 'body', idempotencyKey: 'em-row-1' });
    expect(r).toEqual({ outcome: 'accepted', providerId: 'msg_1', reason: 'ok' });
    expect(calls[0].url).toBe('https://api.resend.com/emails');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('em-row-1');
    expect(headers.Authorization).toBe('Bearer re_key');
    const body = JSON.parse(String(calls[0].init.body));
    expect(Object.keys(body).sort()).toEqual(['from', 'subject', 'text', 'to']);
    expect(body).toEqual({ from: 'onboarding@resend.dev', to: [OWNER], subject: 'Echo: hi', text: 'body' });
  });
  it('refuses any other recipient before a request leaves', async () => {
    const { f, calls } = fakeFetch(() => new Response('{}', { status: 200 }));
    const t = new ResendTransport({ apiKey: 'k', recipient: OWNER, fetch: f, timeoutMs: 5000 });
    await expect(t.send({ to: 'stranger@example.com', subject: 's', text: 't', idempotencyKey: 'em-row-2' })).rejects.toBeInstanceOf(RecipientRefusedError);
    expect(calls).toHaveLength(0);
  });
  it('reads a network failure or a timeout as unknown, never accepted', async () => {
    const t = new ResendTransport({ apiKey: 'k', recipient: OWNER, fetch: (async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; }) as unknown as typeof fetch, timeoutMs: 5000 });
    expect(await t.send({ to: OWNER, subject: 's', text: 't', idempotencyKey: 'em-row-3' })).toEqual({ outcome: 'unknown', reason: 'timeout' });
  });
  it('reads delivery status: delivered, bounced, pending, unreadable', async () => {
    let event: unknown = 'delivered';
    let status = 200;
    const { f } = fakeFetch(() => new Response(JSON.stringify({ last_event: event }), { status }));
    const t = new ResendTransport({ apiKey: 'k', recipient: OWNER, fetch: f, timeoutMs: 5000 });
    expect(await t.status('msg_1')).toEqual({ delivery: 'delivered', reason: 'ok' });
    event = 'bounced';
    expect(await t.status('msg_1')).toEqual({ delivery: 'failed', reason: 'bounced' });
    event = 'sent';
    expect(await t.status('msg_1')).toBe('pending');
    status = 500;
    expect(await t.status('msg_1')).toBeNull();
    expect(await t.status('../../domains')).toBeNull();
  });
  it('verify: no domain passes, a domain fails (it would remove Resend’s own recipient wall), 401 fails, 5xx is unknown', async () => {
    let answer: Response = new Response(JSON.stringify({ data: [] }), { status: 200 });
    const { f, calls } = fakeFetch(() => answer);
    const t = new ResendTransport({ apiKey: 'k', recipient: OWNER, fetch: f, timeoutMs: 5000 });
    expect((await t.verify()).result).toBe('pass');
    expect(calls[0].url).toBe('https://api.resend.com/domains');
    answer = new Response(JSON.stringify({ data: [{ name: 'example.com' }] }), { status: 200 });
    expect((await t.verify()).result).toBe('fail');
    answer = new Response('{}', { status: 401 });
    expect(await t.verify()).toMatchObject({ result: 'fail', reason: 'credential-refused' });
    answer = new Response('{}', { status: 502 });
    expect((await t.verify()).result).toBe('unknown');
  });
});

describe('SMTP', () => {
  const gmail: EmailCredential = { shape: 'B', transport: 'smtp', preset: 'gmail', username: OWNER, secret: 'apppassword' };
  const icloud: EmailCredential = { shape: 'C', transport: 'smtp', preset: 'icloud', username: 'agent@icloud.com', secret: 'apppassword' };

  it('uses only the preset: host, port, TLS checked against that host, no file or URL access', () => {
    expect(smtpClientOptions(gmail, 15000)).toMatchObject({ host: 'smtp.gmail.com', port: 465, secure: true, requireTLS: false, tls: { servername: 'smtp.gmail.com', rejectUnauthorized: true }, disableFileAccess: true, disableUrlAccess: true });
    expect(smtpClientOptions(icloud, 15000)).toMatchObject({ host: 'smtp.mail.me.com', port: 587, secure: false, requireTLS: true, ignoreTLS: false, tls: { servername: 'smtp.mail.me.com' } });
  });
  it('binds the RCPT line too (envelope.to) and never sets cc, bcc, reply-to, headers, attachments or html', async () => {
    const sent: Record<string, unknown>[] = [];
    const client: SmtpClient = { sendMail: async (m) => { sent.push(m); return { response: '250 OK' }; }, verify: async () => true };
    const t = new SmtpTransport({ credential: icloud, recipient: OWNER, timeoutMs: 15000, createClient: () => client });
    expect(await t.send({ to: OWNER, subject: 's', text: 't', idempotencyKey: 'em-row-4' })).toEqual({ outcome: 'accepted', reason: 'ok' });
    expect(sent[0]).toMatchObject({ from: 'agent@icloud.com', to: OWNER, envelope: { from: 'agent@icloud.com', to: [OWNER] }, subject: 's', text: 't' });
    for (const k of ['cc', 'bcc', 'replyTo', 'headers', 'attachments', 'html']) expect(sent[0][k]).toBeUndefined();
    await expect(t.send({ to: 'stranger@example.com', subject: 's', text: 't', idempotencyKey: 'em-row-5' })).rejects.toBeInstanceOf(RecipientRefusedError);
    expect(sent).toHaveLength(1);
  });
  it('maps a 535 to a credential refusal, a disabled-app-passwords answer to its own reason, and a timeout to unknown', async () => {
    const failing = (err: unknown): SmtpClient => ({ sendMail: async () => { throw err; }, verify: async () => { throw err; } });
    const mk = (err: unknown) => new SmtpTransport({ credential: gmail, recipient: OWNER, timeoutMs: 15000, createClient: () => failing(err) });
    expect((await mk({ responseCode: 535, response: '535 5.7.8 Username and Password not accepted' }).send({ to: OWNER, subject: 's', text: 't', idempotencyKey: 'em-row-6' })).reason).toBe('credential-refused');
    expect((await mk({ responseCode: 534, response: '534-5.7.9 Application-specific password required' }).send({ to: OWNER, subject: 's', text: 't', idempotencyKey: 'em-row-7' })).reason).toBe('provider-refuses-app-passwords');
    expect(await mk({ code: 'ETIMEDOUT' }).send({ to: OWNER, subject: 's', text: 't', idempotencyKey: 'em-row-8' })).toEqual({ outcome: 'unknown', reason: 'timeout' });
    expect(await mk({ responseCode: 535, response: '535 secret-echoing text' }).verify()).toEqual({ result: 'fail', reason: 'credential-refused', detail: 'The mail server refused the sign-in.' });
    expect((await mk({ code: 'ECONNREFUSED' }).verify()).result).toBe('unknown');
  });
  it('verify passes on the server’s sign-in answer and sends nothing', async () => {
    const sent: unknown[] = [];
    const t = new SmtpTransport({ credential: gmail, recipient: OWNER, timeoutMs: 15000, createClient: () => ({ sendMail: async (m) => { sent.push(m); return {}; }, verify: async () => true }) });
    expect((await t.verify()).result).toBe('pass');
    expect(sent).toHaveLength(0);
  });
  it('builds the transport the credential names', () => {
    expect(buildTransport({ credential: gmail, recipient: OWNER, timeoutMs: 1000 }).kind).toBe('smtp');
    expect(buildTransport({ credential: { shape: 'A', transport: 'resend', secret: 'k' }, recipient: OWNER, timeoutMs: 1000 }).kind).toBe('resend');
  });
});
