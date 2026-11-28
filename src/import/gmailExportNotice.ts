/**
 * Read only the provider's matching export notification from an explicitly granted Gmail
 * account. The worker supplies a live, job-specific grant. No credential discovery,
 * refresh-token persistence, mailbox mutations, attachments, or general inbox endpoint.
 */
import type { DeliveryBinding, NoticeResult } from './exportDelivery.js';

export interface GmailExportGrant {
  account: string;
  jobId: string;
  accessToken: string;
  /** When the owner opened one particular notification, do not search the mailbox. */
  selectedMessageId?: string;
}

export interface GmailNoticeOptions {
  grant(binding: Readonly<DeliveryBinding>): Promise<GmailExportGrant | null>;
  /** The connector corroborates the exact message and sender with trusted ingress evidence,
   * e.g. its delivery-time, DKIM-aligned SMTP receipt. A mailbox can also contain imported
   * messages: Authentication-Results text alone is not proof of how a message entered it. */
  attestIncoming(binding: Readonly<DeliveryBinding>, message: Readonly<{
    id: string; sender: string; recipient: string; receivedAt: number;
  }>, signal: AbortSignal): Promise<boolean>;
  /** Recorded from an authenticated test-account notification before enabling this recipe. */
  subject: string;
  sender: string;
  linkPaths: readonly string[];
  fetch?: typeof fetch;
}

interface Part {
  mimeType?: string;
  filename?: string;
  headers?: { name?: string; value?: string }[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: Part[];
}
interface Message { id?: string; internalDate?: string; payload?: Part }

const API = 'https://gmail.googleapis.com/gmail/v1/users/me/';
const ADDRESS = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
const MAX_JSON = 512 * 1024;

function address(value: string): string | null {
  const v = value.trim();
  const bracket = /^(?:[^<>\r\n]* )?<([^<>]+)>$/.exec(v);
  const mail = bracket?.[1] ?? v;
  return ADDRESS.test(mail) ? mail.toLowerCase() : null;
}

class MissingMailGrant extends Error {}

async function gmail<T>(fetcher: typeof fetch, path: string, token: string, signal: AbortSignal): Promise<T> {
  const res = await fetcher(API + path, { headers: { Authorization: 'Bearer ' + token }, redirect: 'error', signal });
  try {
    if (res.status === 401 || res.status === 403) throw new MissingMailGrant();
    if (!res.ok || !res.body) throw new Error('mail-unavailable');
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_JSON) throw new Error('mail-unavailable');
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } finally { try { await res.body?.cancel(); } catch { /* Body already ended. */ } }
}

function headerValues(part: Part, name: string): string[] {
  return (part.headers ?? []).filter(h => h.name?.toLowerCase() === name).map(h => (h.value ?? '').trim());
}

/** Gmail's own result must uniquely attest DMARC for the visible sender domain. */
function trustedMetadata(message: Message, binding: Readonly<DeliveryBinding>, sender: string, subject: string): number | null {
  const p = message.payload;
  if (!p) return null;
  const one = (name: string) => {
    const values = headerValues(p, name);
    return values.length === 1 ? values[0] : '';
  };
  if (address(one('from')) !== sender || one('subject') !== subject ||
      address(one('delivered-to')) !== binding.account.toLowerCase()) return null;
  const received = Number(message.internalDate);
  if (!Number.isSafeInteger(received) || received < binding.requestedAt) return null;
  const domain = sender.split('@')[1];
  const results = headerValues(p, 'authentication-results').filter(v => /^mx\.google\.com\s*;/i.test(v));
  if (results.length !== 1) return null;
  const dmarc = results[0].split(';').map(s => s.trim()).filter(s => /^dmarc=/i.test(s));
  if (dmarc.length !== 1 || !/^dmarc=pass\b/i.test(dmarc[0])) return null;
  const authenticatedDomain = /\bheader\.from=([a-z\d.-]+)(?:\s|$)/i.exec(dmarc[0])?.[1]?.toLowerCase();
  return authenticatedDomain === domain ? received : null;
}

function candidateLinks(part: Part, binding: Readonly<DeliveryBinding>, paths: readonly string[]): string[] {
  const links = new Set<string>();
  const allowed = binding.provider === 'claude' ? ['https://claude.ai'] : ['https://chatgpt.com', 'https://chat.openai.com'];
  const parts = [part];
  for (let n = 0; parts.length && n < 64; n++) {
    const p = parts.pop()!;
    if (p.filename || p.body?.attachmentId) continue;
    if (p.mimeType?.startsWith('multipart/')) {
      parts.push(...(p.parts ?? []));
    } else if (p.mimeType === 'text/plain' && p.body?.data && p.body.data.length < MAX_JSON) {
      const text = Buffer.from(p.body.data, 'base64url').toString('utf8');
      for (const m of text.matchAll(/https:\/\/[^\s<>"']+/g)) {
        try {
          const u = new URL(m[0]);
          if (!u.username && !u.password && !u.hash && allowed.includes(u.origin) && paths.includes(u.pathname)) links.add(u.href);
        } catch { /* Other prose isn't a resource link. */ }
      }
    }
  }
  return parts.length ? [] : [...links];
}

export function createGmailExportNoticeSource(opts: GmailNoticeOptions) {
  const read = async (binding: Readonly<DeliveryBinding>, signal: AbortSignal): Promise<NoticeResult> => {
    const account = address(binding.account);
    const sender = address(opts.sender);
    const domain = sender?.split('@')[1];
    const official = binding.provider === 'claude' ? ['anthropic.com', 'claude.com'] : ['openai.com'];
    if (!account || !sender || !domain || !official.some(d => domain === d || domain.endsWith('.' + d)) ||
        !opts.subject || opts.subject.length > 160 || /[\x00-\x1f"\\]/.test(opts.subject) || !opts.linkPaths.length) {
      return { kind: 'human-action', reason: 'mail-access' };
    }
    const grant = await opts.grant(binding);
    if (!grant || !grant.accessToken || grant.jobId !== binding.jobId || address(grant.account) !== account) {
      return { kind: 'human-action', reason: 'mail-access' };
    }
    const load = opts.fetch ?? fetch;
    const get = <T>(p: string) => gmail<T>(load, p, grant.accessToken, signal);
    const profile = await get<{ emailAddress?: string }>('profile?fields=emailAddress');
    if (address(profile.emailAddress ?? '') !== account) return { kind: 'human-action', reason: 'mail-access' };
    const query = new URLSearchParams({
      q: 'after:' + Math.floor(binding.requestedAt / 1000) + ' to:' + account + ' from:' + sender + ' subject:"' + opts.subject + '"',
      maxResults: '5', fields: 'messages(id),nextPageToken',
    });
    const selected = grant.selectedMessageId;
    if (selected !== undefined && !/^[0-9a-f]{1,32}$/i.test(selected)) return { kind: 'human-action', reason: 'open-message' };
    const list: { messages?: { id: string }[]; nextPageToken?: string } = selected === undefined
      ? await get('messages?' + query) : { messages: [{ id: selected }] };
    if (list.nextPageToken || (list.messages?.length ?? 0) > 5) return { kind: 'human-action', reason: 'ambiguous-notice' };
    const matches: { id: string; receivedAt: number }[] = [];
    for (const { id } of list.messages ?? []) {
      if (!/^[0-9a-f]{1,32}$/i.test(id)) continue;
      const params = new URLSearchParams({ format: 'metadata', fields: 'id,internalDate,payload/headers' });
      for (const name of ['From', 'Subject', 'Delivered-To', 'Authentication-Results']) params.append('metadataHeaders', name);
      const msg = await get<Message>('messages/' + id + '?' + params);
      const at = trustedMetadata(msg, binding, sender, opts.subject);
      if (msg.id === id && at !== null) matches.push({ id, receivedAt: at });
    }
    if (!matches.length) return { kind: 'waiting' };
    if (matches.length !== 1) return { kind: 'human-action', reason: 'ambiguous-notice' };
    const match = matches[0];
    const attested = await opts.attestIncoming(binding, { id: match.id, sender, recipient: account, receivedAt: match.receivedAt }, signal);
    if (!attested) return { kind: 'human-action', reason: 'open-message' };
    const message = await get<Message>('messages/' + match.id + '?format=full&fields=id,internalDate,payload');
    if (message.id !== match.id || trustedMetadata(message, binding, sender, opts.subject) !== match.receivedAt) {
      return { kind: 'human-action', reason: 'open-message' };
    }
    const links = candidateLinks(message.payload!, binding, opts.linkPaths);
    if (links.length !== 1) return { kind: 'human-action', reason: 'open-message' };
    return { kind: 'notice', notice: { provider: binding.provider, receivedAt: match.receivedAt, recipient: account,
      authenticatedSenderDomain: domain, link: links[0] } };
  };
  return async (binding: Readonly<DeliveryBinding>, signal: AbortSignal): Promise<NoticeResult> => {
    try {
      return await read(binding, signal);
    } catch (error) {
      if (error instanceof MissingMailGrant) return { kind: 'human-action', reason: 'mail-access' };
      // A fetcher's own error may contain headers or partially decoded mail.
      throw new Error('mail-unavailable');
    }
  };
}
