/**
 * Receives the response to one confirmed personal export. This module runs in the local worker.
 * A notice and its link are secret, transient values. Only DeliveryResult may leave the worker.
 * The caller's sink must discard partial bytes if the stream fails and publish only after EOF.
 */
import type { ImportSource } from './exportParsers.js';
import { MAX_ZIP_BYTES } from './safeZip.js';

export interface DeliveryBinding {
  jobId: string;
  provider: ImportSource;
  account: string;
  workspace: 'personal';
  requestedAt: number;
}

export interface ExportNotice {
  provider: ImportSource;
  recipient: string;
  workspace?: string;
  receivedAt: number;
  /** Supplied only by the local, authorized source after verifying message provenance. */
  authenticatedSenderDomain: string;
  link: string;
}

export type NoticeResult =
  | { kind: 'waiting' }
  | { kind: 'human-action'; reason: 'mail-access' | 'ambiguous-notice' | 'open-message' }
  | { kind: 'notice'; notice: ExportNotice };

export type DeliveryResult<T> =
  | Exclude<NoticeResult, { kind: 'notice' }>
  | { kind: 'human-action'; reason: 'verify-account' | 'provider-sign-in' | 'expired' }
  | { kind: 'refused'; reason: 'untrusted-notice' | 'unsupported-link' | 'invalid-archive' | 'size-limit' }
  | { kind: 'interrupted'; reason: 'cancelled' | 'timeout' | 'unavailable' }
  | { kind: 'staged'; archive: T };

interface VerifiedIdentity { provider: ImportSource; account: string; workspace: string }
export interface DeliveryDeps<T> {
  readNotice(binding: Readonly<DeliveryBinding>, signal: AbortSignal): Promise<NoticeResult>;
  /** Re-read the selected account and workspace in the provider's bound profile immediately before redemption. */
  verifyIdentity(binding: Readonly<DeliveryBinding>, signal: AbortSignal): Promise<VerifiedIdentity | null>;
  /** Reviewed exact route paths, from the provider's delivery recipe. Never accept these from a chat or route body. */
  resourcePaths: readonly string[];
  stage(bytes: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<T>;
  /** A dedicated browser transport must obey manual redirects. Default HTTP transport sends no credentials. */
  fetch?: typeof fetch;
  signal?: AbortSignal;
  now?: () => number;
  maxBytes?: number;
  timeoutMs?: number;
}

const ROLES: Record<ImportSource, { origins: readonly string[]; senderDomains: readonly string[] }> = {
  chatgpt: { origins: ['https://chatgpt.com', 'https://chat.openai.com'], senderDomains: ['openai.com'] },
  claude: { origins: ['https://claude.ai'], senderDomains: ['anthropic.com', 'claude.com'] },
};

function email(s: string) { return s.trim().toLowerCase(); }
function senderMatches(provider: ImportSource, domain: string): boolean {
  return ROLES[provider].senderDomains.some(d => domain === d || domain.endsWith('.' + d));
}

function exportUrl(raw: string, provider: ImportSource, paths: readonly string[], relativeTo?: URL): URL | null {
  if (raw.length > 16_384 || /[\s\\\x00-\x1f\x7f]/.test(raw)) return null;
  try {
    const url = new URL(raw, relativeTo);
    if (url.username || url.password || url.hash || !ROLES[provider].origins.includes(url.origin)) return null;
    if (!paths.includes(url.pathname)) return null;
    return url;
  } catch { return null; }
}

class BadArchive extends Error {
  constructor(readonly reason: 'invalid-archive' | 'size-limit') { super(reason); }
}

async function* zipBytes(response: Response, limit: number, signal: AbortSignal, end: { complete: boolean }) {
  if (!response.body) throw new BadArchive('invalid-archive');
  const reader = response.body.getReader();
  const interrupt = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', interrupt, { once: true });
  const magic = Buffer.alloc(4);
  let total = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const item = await reader.read();
      if (item.done) break;
      const chunk = item.value;
      const headStart = total;
      total += chunk.byteLength;
      if (total > limit) throw new BadArchive('size-limit');
      if (headStart < magic.length) {
        magic.set(chunk.subarray(0, magic.length - headStart), headStart);
        if (total >= magic.length && magic.readUInt32LE(0) !== 0x04034b50) throw new BadArchive('invalid-archive');
      }
      yield chunk;
    }
    signal.throwIfAborted();
    if (total < 22) throw new BadArchive('invalid-archive');
    end.complete = true;
  } finally {
    signal.removeEventListener('abort', interrupt);
    try { await reader.cancel(); } catch { /* network failure is already represented by the result */ }
    reader.releaseLock();
  }
}

export async function receiveExportDelivery<T>(binding: Readonly<DeliveryBinding>, deps: DeliveryDeps<T>): Promise<DeliveryResult<T>> {
  const now = deps.now ?? Date.now;
  const timeout = AbortSignal.timeout(Math.min(10 * 60_000, Math.max(1, deps.timeoutMs ?? 10 * 60_000)));
  const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
  const limit = Math.min(deps.maxBytes ?? MAX_ZIP_BYTES, MAX_ZIP_BYTES);
  let response: Response | undefined;
  try {
    signal.throwIfAborted();
    if (binding.workspace !== 'personal' || !binding.account.trim() || !Number.isSafeInteger(binding.requestedAt) ||
        binding.requestedAt <= 0 || binding.requestedAt > now() || !Number.isSafeInteger(limit) || limit < 22) {
      return { kind: 'refused', reason: 'untrusted-notice' };
    }
    const incoming = await deps.readNotice(binding, signal);
    if (incoming.kind === 'waiting') return { kind: 'waiting' };
    if (incoming.kind === 'human-action') {
      const reason = ['mail-access', 'ambiguous-notice', 'open-message'].includes(incoming.reason) ? incoming.reason : 'open-message';
      return { kind: 'human-action', reason };
    }
    const n = incoming.notice;
    if (n.provider !== binding.provider || email(n.recipient) !== email(binding.account) ||
        (n.workspace !== undefined && n.workspace !== 'personal') ||
        !Number.isSafeInteger(n.receivedAt) || n.receivedAt < binding.requestedAt || n.receivedAt > now() ||
        !senderMatches(binding.provider, n.authenticatedSenderDomain)) {
      return { kind: 'refused', reason: 'untrusted-notice' };
    }
    if (now() - n.receivedAt >= 24 * 60 * 60_000) return { kind: 'human-action', reason: 'expired' };
    const initial = exportUrl(n.link, binding.provider, deps.resourcePaths);
    if (!initial) return { kind: 'refused', reason: 'unsupported-link' };
    const identity = await deps.verifyIdentity(binding, signal);
    if (!identity || identity.provider !== binding.provider || email(identity.account) !== email(binding.account) ||
        identity.workspace !== 'personal') return { kind: 'human-action', reason: 'verify-account' };
    let url: URL = initial;
    const load = deps.fetch ?? fetch;
    for (let hop = 0; hop <= 3; hop++) {
      signal.throwIfAborted();
      response = await load(url, { method: 'GET', redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', signal,
        headers: { Accept: 'application/zip, application/octet-stream' } });
      if (response.redirected || response.type === 'opaqueredirect') return { kind: 'refused', reason: 'unsupported-link' };
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        const next: URL | null = location ? exportUrl(location, binding.provider, deps.resourcePaths, url) : null;
        if (!next || hop === 3) return { kind: 'refused', reason: 'unsupported-link' };
        await response.body?.cancel();
        response = undefined;
        url = next;
        continue;
      }
      if (response.status === 401 || response.status === 403) return { kind: 'human-action', reason: 'provider-sign-in' };
      if (response.status === 410) return { kind: 'human-action', reason: 'expired' };
      if (response.status !== 200) return { kind: 'interrupted', reason: 'unavailable' };
      const len = response.headers.get('content-length');
      if (len !== null && (!/^\d+$/.test(len) || Number(len) > limit)) return { kind: 'refused', reason: 'size-limit' };
      const done = { complete: false };
      const bytes = zipBytes(response, limit, signal, done);
      try {
        const archive = await deps.stage(bytes, signal);
        signal.throwIfAborted();
        if (!done.complete) throw new BadArchive('invalid-archive');
        return { kind: 'staged', archive };
      } finally { await bytes.return(undefined); }
    }
    return { kind: 'refused', reason: 'unsupported-link' };
  } catch (err) {
    if (deps.signal?.aborted) return { kind: 'interrupted', reason: 'cancelled' };
    if (timeout.aborted) return { kind: 'interrupted', reason: 'timeout' };
    if (err instanceof BadArchive) return { kind: 'refused', reason: err.reason };
    return { kind: 'interrupted', reason: 'unavailable' };
  } finally {
    try { await response?.body?.cancel(); } catch { /* Already consumed, cancelled or errored. */ }
  }
}
