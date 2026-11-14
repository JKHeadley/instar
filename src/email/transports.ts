/**
 * The two ways an agent sends mail (docs/specs/backup-email-sending.md, Transports).
 *
 * Both are bound to one recipient at construction and refuse any other `to`. Neither ever sets cc, bcc,
 * reply-to, custom headers, attachments or HTML. Provider error text never leaves this file: every result
 * carries a fixed reason.
 */
import nodemailer from 'nodemailer';
import {
  RESEND_API, RESEND_SHARED_SENDER, SMTP_PRESETS, mapResendSend, mapResendStatus, mapSmtpCode,
  type Delivery, type EmailCredential, type EmailFixedReason, type TransportResult,
} from './emailCore.js';

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  /** The outbox row id. Resend deduplicates a repeated attempt on it. */
  idempotencyKey: string;
}

export interface EmailTransport {
  readonly kind: 'resend' | 'smtp';
  /** The one address this transport will send to. */
  readonly recipient: string;
  send(message: OutboundEmail): Promise<TransportResult>;
  /** Resend only: the delivery status of a sent message. Null when it can't be read. */
  status?(providerId: string): Promise<{ delivery: Delivery; reason: EmailFixedReason } | 'pending' | null>;
  /** The regular check: sends nothing. */
  verify(): Promise<{ result: 'pass' | 'fail' | 'unknown'; reason: EmailFixedReason; detail: string }>;
}

export class RecipientRefusedError extends Error {
  constructor() { super('email transport: recipient is not the bound owner address'); }
}

export interface ResendOptions {
  apiKey: string;
  recipient: string;
  from?: string;
  fetch?: typeof fetch;
  timeoutMs: number;
}

export class ResendTransport implements EmailTransport {
  readonly kind = 'resend' as const;
  readonly recipient: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: ResendOptions) {
    this.recipient = opts.recipient;
    this.doFetch = opts.fetch ?? fetch;
  }

  async send(message: OutboundEmail): Promise<TransportResult> {
    if (message.to !== this.recipient) throw new RecipientRefusedError();
    let res: Response;
    try {
      res = await this.doFetch(`${RESEND_API}/emails`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': message.idempotencyKey,
        },
        // Exactly these fields. Never cc, bcc, reply_to, headers, attachments or html.
        body: JSON.stringify({ from: this.opts.from ?? RESEND_SHARED_SENDER, to: [this.recipient], subject: message.subject, text: message.text }),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      return { outcome: 'unknown', reason: isTimeout(err) ? 'timeout' : 'network' };
    }
    const body = await res.json().catch(() => null);
    return mapResendSend(res.status, body);
  }

  async status(providerId: string): Promise<{ delivery: Delivery; reason: EmailFixedReason } | 'pending' | null> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(providerId)) return null;
    try {
      const res = await this.doFetch(`${RESEND_API}/emails/${providerId}`, {
        headers: { Authorization: `Bearer ${this.opts.apiKey}` },
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
      if (!res.ok) return null;
      const body = (await res.json().catch(() => null)) as { last_event?: unknown } | null;
      return mapResendStatus(body?.last_event) ?? 'pending';
    } catch {
      return null; // @silent-fallback-ok — an unreadable status is "unknown so far"; the status window decides the fallback
    }
  }

  /** GET /domains: 200 with no domains passes; any domain fails (it would remove Resend's own recipient wall). */
  async verify(): Promise<{ result: 'pass' | 'fail' | 'unknown'; reason: EmailFixedReason; detail: string }> {
    try {
      const res = await this.doFetch(`${RESEND_API}/domains`, {
        headers: { Authorization: `Bearer ${this.opts.apiKey}` },
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
      if (res.status === 401 || res.status === 403) return { result: 'fail', reason: 'credential-refused', detail: `Resend refused the key (${res.status}).` };
      if (!res.ok) return { result: 'unknown', reason: 'provider-error', detail: `Resend answered ${res.status}.` };
      const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
      if (!body || !Array.isArray(body.data)) return { result: 'unknown', reason: 'provider-error', detail: 'Resend gave an answer I could not read.' };
      if (body.data.length > 0) return { result: 'fail', reason: 'provider-error', detail: 'The Resend account has a domain on it, which would let it email people other than you. This version only works with no domain.' };
      return { result: 'pass', reason: 'ok', detail: 'Resend accepted the key, and the account has no domain on it.' };
    } catch (err) {
      return { result: 'unknown', reason: isTimeout(err) ? 'timeout' : 'network', detail: 'Resend could not be reached.' };
    }
  }
}

/** What nodemailer's createTransport returns, narrowed to what this file uses (tests pass a stand-in). */
export interface SmtpClient {
  sendMail(mail: Record<string, unknown>): Promise<{ response?: string; messageId?: string; accepted?: unknown[] }>;
  verify(): Promise<unknown>;
  close?(): void;
}
export type SmtpClientFactory = (options: Record<string, unknown>) => SmtpClient;

export interface SmtpOptions {
  credential: EmailCredential;
  recipient: string;
  timeoutMs: number;
  createClient?: SmtpClientFactory;
}

/** The exact options handed to nodemailer: preset host and port, certificate checked against that host, AUTH never in the clear. */
export function smtpClientOptions(credential: EmailCredential, timeoutMs: number): Record<string, unknown> {
  const preset = SMTP_PRESETS[credential.preset ?? 'gmail'];
  return {
    host: preset.host,
    port: preset.port,
    secure: preset.secure,
    requireTLS: !preset.secure,
    ignoreTLS: false,
    tls: { servername: preset.host, rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    auth: { user: credential.username, pass: credential.secret },
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
  };
}

export class SmtpTransport implements EmailTransport {
  readonly kind = 'smtp' as const;
  readonly recipient: string;
  private readonly factory: SmtpClientFactory;

  constructor(private readonly opts: SmtpOptions) {
    this.recipient = opts.recipient;
    this.factory = opts.createClient ?? ((o) => nodemailer.createTransport(o as never) as unknown as SmtpClient);
  }

  async send(message: OutboundEmail): Promise<TransportResult> {
    if (message.to !== this.recipient) throw new RecipientRefusedError();
    const client = this.factory(smtpClientOptions(this.opts.credential, this.opts.timeoutMs));
    try {
      await client.sendMail({
        from: this.opts.credential.username,
        to: this.recipient,
        // The RCPT line is bound too, not only the header.
        envelope: { from: this.opts.credential.username, to: [this.recipient] },
        subject: message.subject,
        text: message.text,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      return { outcome: 'accepted', reason: 'ok' };
    } catch (err) {
      return smtpErrorResult(err);
    } finally {
      try { client.close?.(); } catch { /* @silent-fallback-ok — closing a finished connection */ }
    }
  }

  /** Connect, TLS, AUTH, QUIT: 235 passes, 535 fails, anything else is unknown. Sends nothing. */
  async verify(): Promise<{ result: 'pass' | 'fail' | 'unknown'; reason: EmailFixedReason; detail: string }> {
    const client = this.factory(smtpClientOptions(this.opts.credential, this.opts.timeoutMs));
    try {
      await client.verify();
      return { result: 'pass', reason: 'ok', detail: 'The mail server accepted the sign-in.' };
    } catch (err) {
      const r = smtpErrorResult(err);
      if (r.reason === 'provider-refuses-app-passwords') return { result: 'fail', reason: r.reason, detail: 'This account does not allow app passwords (an administrator turned them off).' };
      if (r.reason === 'credential-refused') return { result: 'fail', reason: r.reason, detail: 'The mail server refused the sign-in.' };
      return { result: 'unknown', reason: r.reason, detail: 'The mail server could not be checked just now.' };
    } finally {
      try { client.close?.(); } catch { /* @silent-fallback-ok — closing a finished connection */ }
    }
  }
}

function smtpErrorResult(err: unknown): TransportResult {
  const e = err as { responseCode?: unknown; code?: unknown; response?: unknown } | null;
  const code = typeof e?.responseCode === 'number' ? e.responseCode : undefined;
  const response = typeof e?.response === 'string' ? e.response : '';
  // Google Workspace with app passwords disabled answers 534 5.7.9 "Application-specific password required" or
  // "web login required"; read by class only.
  if ((code === 534 || code === 535) && /application-specific password required|web ?login required|app passwords? (are )?(not|disabled)/i.test(response)) {
    return { outcome: 'refused', reason: 'provider-refuses-app-passwords' };
  }
  if (code !== undefined) return mapSmtpCode(code, 'send');
  const c = typeof e?.code === 'string' ? e.code : '';
  if (c === 'ETIMEDOUT' || c === 'ETIMEOUT') return { outcome: 'unknown', reason: 'timeout' };
  if (c === 'EAUTH') return { outcome: 'refused', reason: 'credential-refused' };
  return { outcome: 'unknown', reason: 'network' };
}

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/** Builds the transport for a stored credential and the owner's address. */
export function buildTransport(input: {
  credential: EmailCredential;
  recipient: string;
  timeoutMs: number;
  fetch?: typeof fetch;
  createSmtpClient?: SmtpClientFactory;
}): EmailTransport {
  return input.credential.transport === 'resend'
    ? new ResendTransport({ apiKey: input.credential.secret, recipient: input.recipient, fetch: input.fetch, timeoutMs: input.timeoutMs })
    : new SmtpTransport({ credential: input.credential, recipient: input.recipient, timeoutMs: input.timeoutMs, createClient: input.createSmtpClient });
}
