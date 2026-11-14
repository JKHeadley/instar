/**
 * Sending email from an agent: the pure parts (docs/specs/backup-email-sending.md).
 *
 * Send only, to the owner only. Everything here is deterministic and dependency-free so the
 * owner-only rule, the fixed reasons and the delivery mapping are tested on their own.
 */
import crypto from 'node:crypto';

/** The closed set of reasons a send or a check can carry. Provider error text never surfaces: it can echo a credential. */
export const EMAIL_FIXED_REASONS = [
  'ok',
  'provider-rate-limited',
  'budget-exhausted',
  'credential-refused',
  'provider-recipient-refused',
  'provider-refuses-app-passwords',
  'credential-exposure',
  'recipient-mismatch',
  'not-set-up',
  'not-set-up-here',
  'unproven',
  'breaker-open',
  'timeout',
  'network',
  'provider-error',
  'bounced',
  'complained',
  'status-window-ended',
  'handoff',
  'disabled',
] as const;
export type EmailFixedReason = (typeof EMAIL_FIXED_REASONS)[number];

export type TransportOutcome = 'accepted' | 'refused' | 'unknown';
export interface TransportResult {
  outcome: TransportOutcome;
  providerId?: string;
  reason: EmailFixedReason;
}

/** `accepted-unproven` is SMTP's final 250: the submission server queued it, nothing more is known, and nothing ever upgrades it. */
export type Delivery = 'delivered' | 'accepted-unproven' | 'failed' | 'unknown';

export type EmailShape = 'A' | 'B' | 'C';
export type SmtpPresetId = 'gmail' | 'icloud';

export interface SmtpPreset {
  id: SmtpPresetId;
  host: string;
  port: number;
  /** true = implicit TLS (465); false = STARTTLS with requireTLS (587). */
  secure: boolean;
  /** The provider's published daily sending cap, re-checked at build time (2026-11-08). */
  dailyCap: number;
}

/** Presets only: a session never picks a host or a port. No Outlook.com: app-password SMTP is retired for personal accounts. */
export const SMTP_PRESETS: Readonly<Record<SmtpPresetId, SmtpPreset>> = Object.freeze({
  gmail: { id: 'gmail', host: 'smtp.gmail.com', port: 465, secure: true, dailyCap: 500 },
  icloud: { id: 'icloud', host: 'smtp.mail.me.com', port: 587, secure: false, dailyCap: 1000 },
});

/** Resend's free tier at build time (2026-11-08): 100 a day, 3,000 a month. The provider's 429 is the authority. */
export const RESEND_DAILY_CAP = 100;
export const RESEND_SHARED_SENDER = 'onboarding@resend.dev';
export const RESEND_API = 'https://api.resend.com';

/** Vault names. `email_sending` is the credential JSON; `email_recipient` is the owner-typed address. */
export const EMAIL_SECRET = 'email_sending';
export const EMAIL_RECIPIENT_SECRET = 'email_recipient';
export const EMAIL_PROVIDER_ACCOUNT_SECRET = 'email_provider_account';

/** Bounds (spec: decision points table). */
export const OWNER_TEXT_MAX_BYTES = 16 * 1024;
export const TOPIC_TEXT_MAX_BYTES = 8 * 1024;
export const SUBJECT_MAX_CHARS = 200;
export const EMAIL_OUTBOX_MAX_ENTRY_BYTES = 24 * 1024;
export const STATUS_LINE_MAX_BYTES = 300;

/**
 * One bare address, lowercased: no display name, no comma, no angle brackets, at most 254 characters
 * (RFC 5321). Null when it is anything else. Deliberately strict: the recipient is the one harm this
 * feature can do to someone else.
 */
export function normalizeRecipient(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (!v || v.length > 254) return null;
  if (/[\s,<>;"'()\[\]\\]/.test(v)) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(v)) return null;
  const at = v.lastIndexOf('@');
  if (at < 1 || at !== v.indexOf('@')) return null;
  const local = v.slice(0, at);
  const domain = v.slice(at + 1);
  if (local.length > 64 || !/^[a-z0-9.!#$%&*+/=?^_`{|}~-]+$/.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) return null;
  return v;
}

/** Keyed hash of the recipient, so a replicated row is not dictionary-reversible. */
export function recipientHash(key: string | Buffer, recipient: string): string {
  return crypto.createHmac('sha256', key).update(`email-recipient\u0000${recipient}`).digest('hex');
}

/** A masked recipient for status surfaces: `j***@example.com`. */
export function maskRecipient(recipient: string | null): string | null {
  if (!recipient) return null;
  const at = recipient.indexOf('@');
  if (at < 1) return null;
  return `${recipient[0]}***${recipient.slice(at)}`;
}

export function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** Cuts a string to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function cutToBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let out = Buffer.from(s, 'utf8').subarray(0, maxBytes).toString('utf8');
  // A split multi-byte character decodes as U+FFFD at the end; drop it.
  while (out.endsWith('�')) out = out.slice(0, -1);
  return out;
}

/** The subject: a fixed `<agent name>: ` prefix, CR/LF and other control characters removed, 200 characters at most. */
export function buildSubject(agentName: string, subject: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = (s: string) => s.replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const full = `${clean(agentName) || 'Your agent'}: ${clean(subject) || 'Report'}`;
  return full.length > SUBJECT_MAX_CHARS ? `${full.slice(0, SUBJECT_MAX_CHARS - 1)}…` : full;
}

/**
 * Telegram markdown to plain text, by a fixed converter: code fences and inline code lose their markers but keep
 * their text, emphasis markers go, links keep text and address, headings lose their hashes. Plain text only.
 */
export function toPlainText(markdown: string): string {
  let t = markdown.replace(/\r\n?/g, '\n');
  t = t.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, body: string) => body.replace(/\n$/, ''));
  t = t.replace(/```/g, '');
  t = t.replace(/`([^`\n]+)`/g, '$1');
  t = t.replace(/\[([^\]\n]+)\]\((\S+?)\)/g, '$1 ($2)');
  t = t.replace(/^#{1,6}\s+/gm, '');
  t = t.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2');
  t = t.replace(/(^|[\s(])[*_](?=\S)([^*_\n]*?\S)[*_](?=$|[\s).,!?:;])/gm, '$1$2');
  t = t.replace(/~~(?=\S)([^~\n]*?\S)~~/g, '$1');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

/** Resend's `last_event` (GET /emails/{id}) to a delivery. Only `delivered` is delivered. */
export function mapResendStatus(lastEvent: unknown): { delivery: Delivery; reason: EmailFixedReason } | null {
  if (lastEvent === 'delivered') return { delivery: 'delivered', reason: 'ok' };
  if (lastEvent === 'bounced') return { delivery: 'failed', reason: 'bounced' };
  if (lastEvent === 'complained') return { delivery: 'failed', reason: 'complained' };
  // `opened` and `clicked` come only after `delivered`, so they prove arrival too. Everything else (sent, queued,
  // scheduled, delivery_delayed) is still pending.
  if (lastEvent === 'opened' || lastEvent === 'clicked') return { delivery: 'delivered', reason: 'ok' };
  return null;
}

/**
 * Resend's answer to POST /emails. A 403 naming the recipient restriction (a domain-less account refusing a
 * `to` other than its own address) is its own reason and never trips the credential breaker.
 */
export function mapResendSend(status: number, body: unknown): TransportResult {
  if (status >= 200 && status < 300) {
    const id = (body as { id?: unknown } | null)?.id;
    return typeof id === 'string' && id ? { outcome: 'accepted', providerId: id, reason: 'ok' } : { outcome: 'unknown', reason: 'provider-error' };
  }
  if (status === 429) return { outcome: 'refused', reason: 'provider-rate-limited' };
  if (status === 401) return { outcome: 'refused', reason: 'credential-refused' };
  if (status === 403) return { outcome: 'refused', reason: isResendRecipientRestriction(body) ? 'provider-recipient-refused' : 'credential-refused' };
  if (status >= 400 && status < 500) return { outcome: 'refused', reason: 'provider-error' };
  return { outcome: 'unknown', reason: 'provider-error' };
}

/** Resend's domain-less refusal says it can only send testing emails to the account's own address. Read by class, never surfaced. */
export function isResendRecipientRestriction(body: unknown): boolean {
  const b = body as { name?: unknown; message?: unknown } | null;
  const msg = typeof b?.message === 'string' ? b.message.toLowerCase() : '';
  const name = typeof b?.name === 'string' ? b.name.toLowerCase() : '';
  return name === 'validation_error' && /own email address|only send testing emails|verify a domain/.test(msg);
}

/** SMTP response code to a transport result. `250` is accepted (and stays unproven). */
export function mapSmtpCode(code: number | undefined, kind: 'auth' | 'send'): TransportResult {
  if (code === undefined) return { outcome: 'unknown', reason: 'network' };
  if (kind === 'send' && code >= 200 && code < 300) return { outcome: 'accepted', reason: 'ok' };
  if (code === 535 || code === 534 || code === 530) return { outcome: 'refused', reason: 'credential-refused' };
  if (code === 421 || code === 450 || code === 451 || code === 452) return { outcome: 'refused', reason: 'provider-rate-limited' };
  if (code >= 500) return { outcome: 'refused', reason: 'provider-error' };
  return { outcome: 'unknown', reason: 'provider-error' };
}

/** A credential refusal opens the breaker. Budget, rate and recipient refusals do not. */
export function isCredentialRefusal(reason: EmailFixedReason): boolean {
  return reason === 'credential-refused' || reason === 'provider-refuses-app-passwords';
}

/** What setup stores under `email_sending`. Never a recipient: the owner types that on the confirm page. */
export interface EmailCredential {
  shape: EmailShape;
  transport: 'resend' | 'smtp';
  /** Resend: the full-access API key. SMTP: the app password. */
  secret: string;
  /** SMTP only. */
  preset?: SmtpPresetId;
  /** SMTP only: the login. For shape B it must be the owner-typed recipient. */
  username?: string;
}

export type CredentialParse = { ok: true; credential: EmailCredential; providerAccountPassword?: string } | { ok: false; error: string };

/**
 * Parses the key route's body for this service. Refuses a `recipient` field (the recipient is never set by a
 * session), a host or a port (presets only), and a shape/transport mismatch.
 */
export function parseEmailCredential(raw: string): CredentialParse {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return { ok: false, error: 'invalid-json' }; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'invalid-json' };
  const o = v as Record<string, unknown>;
  const allowed = new Set(['shape', 'transport', 'secret', 'preset', 'username', 'providerAccountPassword']);
  if ('recipient' in o || 'to' in o) return { ok: false, error: 'recipient-not-accepted' };
  if ('host' in o || 'port' in o) return { ok: false, error: 'presets-only' };
  for (const k of Object.keys(o)) if (!allowed.has(k)) return { ok: false, error: `unknown-field` };
  const { shape, transport, secret, preset, username, providerAccountPassword } = o;
  if (shape !== 'A' && shape !== 'B' && shape !== 'C') return { ok: false, error: 'invalid-shape' };
  if (typeof secret !== 'string' || !secret.trim() || secret.length > 512) return { ok: false, error: 'invalid-secret' };
  if (shape === 'A') {
    if (transport !== 'resend') return { ok: false, error: 'shape-a-is-resend' };
    if (preset !== undefined || username !== undefined) return { ok: false, error: 'resend-takes-no-login' };
    if (providerAccountPassword !== undefined && (typeof providerAccountPassword !== 'string' || !providerAccountPassword || providerAccountPassword.length > 512)) return { ok: false, error: 'invalid-provider-account' };
    return { ok: true, credential: { shape, transport: 'resend', secret: secret.trim() }, ...(typeof providerAccountPassword === 'string' ? { providerAccountPassword } : {}) };
  }
  if (transport !== 'smtp') return { ok: false, error: 'shape-b-c-are-smtp' };
  if (preset !== 'gmail' && preset !== 'icloud') return { ok: false, error: 'invalid-preset' };
  const user = normalizeRecipient(username);
  if (!user) return { ok: false, error: 'invalid-username' };
  if (providerAccountPassword !== undefined) return { ok: false, error: 'smtp-takes-no-provider-account' };
  // App passwords are shown with spaces; SMTP AUTH takes them without.
  return { ok: true, credential: { shape, transport: 'smtp', secret: secret.replace(/\s+/g, ''), preset, username: user } };
}

export function readEmailCredential(raw: string | null): EmailCredential | null {
  if (!raw) return null;
  const parsed = parseEmailCredential(raw);
  return parsed.ok ? parsed.credential : null;
}

/** The version a proof binds to: the stored credential value and the recipient together. */
export function credentialVersion(rawCredential: string, recipHash: string): string {
  return sha256(`${sha256(rawCredential)}\u0000${recipHash}`);
}

/** The daily cap for a stored credential: the provider's published figure. */
export function providerCap(cred: EmailCredential): number {
  return cred.transport === 'resend' ? RESEND_DAILY_CAP : SMTP_PRESETS[cred.preset ?? 'gmail'].dailyCap;
}

/** The agent's email day, in one timezone for every holder. Falls back to UTC on an unknown zone. */
export function emailDay(nowMs: number, timeZone: string | undefined): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(nowMs));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return new Date(nowMs).toISOString().slice(0, 10); // @silent-fallback-ok — an unknown zone name reads as UTC, one day for every holder still
  }
}

/** The fallback line for each cause, plain and complete. */
export function fallbackLine(cause: 'not-set-up' | 'not-set-up-here' | 'refused' | 'unproven' | 'unknown', reason?: EmailFixedReason): string {
  switch (cause) {
    case 'not-set-up': return 'I was asked to email you this, but email isn’t set up, so here it is instead.';
    case 'not-set-up-here': return 'I was asked to email you this, but email isn’t set up on the machine sending it, so here it is instead.';
    case 'unproven': return 'I was asked to email you this, but email isn’t confirmed working yet, so here it is instead.';
    case 'unknown': return 'I couldn’t be sure the email arrived, so you also get it here.';
    case 'refused':
    default:
      return reason === 'budget-exhausted' || reason === 'provider-rate-limited'
        ? 'Today’s email limit is used up, so here it is instead.'
        : reason === 'credential-exposure'
          ? 'This report had something that looked like a password or key in it, so I didn’t email it. Here it is instead.'
          : 'The email didn’t go through, so here it is instead.';
  }
}
