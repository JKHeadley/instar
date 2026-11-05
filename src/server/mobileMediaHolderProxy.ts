/**
 * Streams a file from the machine that holds a Slack conversation, for the owner's phone
 * (docs/specs/mobile-remote-media.md). A Slack file lives on the machine whose registry minted the
 * conversation, and a phone is signed for one host, so without this a row held elsewhere can show
 * its attachment but never open it.
 *
 * The holder comes only from the trusted peer list, never from the request. One GET, the whole
 * file, no Range: bytes pass through as they arrive, with backpressure and a byte ceiling. The
 * caller's `isCurrent` is read before every dial, before the first byte, on a timer throughout and
 * before the last byte. A phone only ever gets a complete response for a file whose hash matched: the last
 * chunk is held back until the hash is known, so a bad or cut stream ends as a broken connection.
 */
import crypto from 'node:crypto';
import { once } from 'node:events';
import type { Response as ExpressResponse } from 'express';
import { MAX_FILE_BYTES, isInlineSafe, safeFileName } from '../core/appMediaTypes.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { isPeerUrlAllowedForCredentials, type PeerEndpointKind } from './peerUrlGuard.js';
import { poolPeerFetch, PoolPeerAdmissionError, type PoolPeerTarget, type RopeResultRecorder } from './poolPeerFetch.js';

/** The holder's mark that it answered as a hop; an older holder refuses a bearer download outright. */
export const HOLDER_MEDIA_HEADER = 'x-instar-holder-media';
export const HOLDER_MEDIA_FIRST_BYTE_MS = 15_000;
export const HOLDER_MEDIA_IDLE_MS = 20_000;
/** 50 MiB in this time needs about 1.4 Mbit/s end to end; a read cut here restarts, with no Range. */
export const HOLDER_MEDIA_DEADLINE_MS = 300_000;
export const HOLDER_MEDIA_MAX_IN_FLIGHT = 6;
/** Per holder, so one dead machine cannot take every slot. Separate from the history read's slots. */
export const HOLDER_MEDIA_MAX_PER_HOLDER = 2;
/** How often a running stream rereads the owner check, whatever the bytes are doing. */
export const HOLDER_MEDIA_OWNER_RECHECK_MS = 200;
const SMALL_ANSWER_BYTES = 8_192;

export interface HolderMediaRequest {
  sha256: string;
  ref: string;
  machine: string;
  isCurrent: () => boolean;
}
export type HolderMedia = (request: HolderMediaRequest, res: ExpressResponse) => Promise<void>;

export interface HolderMediaDeps {
  peers: () => PoolPeerTarget[];
  allowlist?: () => readonly string[] | undefined;
  token: () => string | undefined;
  selfMachineId: () => string;
  record?: RopeResultRecorder;
  fetchImpl?: typeof fetch;
  firstByteMs?: number;
  idleMs?: number;
  deadlineMs?: number;
  maxBytes?: number;
  recheckMs?: number;
}

function reportFailure(reason: string): void {
  try {
    DegradationReporter.getInstance().report({
      feature: 'MobileMediaHolderProxy.stream',
      primary: 'the owner\'s phone opens a Slack file from the machine that holds it',
      fallback: 'the phone says the file could not be opened and the owner can retry',
      reason,
      impact: 'This file cannot be opened from the phone until the holder answers.',
    });
  } catch { /* @silent-fallback-ok — reporting must never turn a refusal into a crash */ }
}

const FAILED_DETAIL = 'The machine that holds this file could not answer. Try again.';
function failed(res: ExpressResponse, status: number, error: string, detail = FAILED_DETAIL): void {
  reportFailure(error);
  if (res.headersSent) { res.destroy(); return; }
  res.status(status).json({ error, detail });
}
const ownerOnly = (res: ExpressResponse): void => {
  if (res.headersSent) { res.destroy(); return; }
  res.status(403).json({ error: 'owner-only', detail: 'Only the agent\'s owner can open this file from the app.' });
};

/** A small JSON answer up to the limit; null past it or when it is not an object. */
async function smallJson(response: Response): Promise<Record<string, unknown> | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > SMALL_ANSWER_BYTES) { await reader.cancel().catch(() => undefined); return null; } // @silent-fallback-ok — releasing an oversized body; the caller refuses it
    chunks.push(value);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; } // @silent-fallback-ok — an unreadable refusal reads as the holder failing
}

/** The file name from the holder's header, made safe again here: a holder's text is never trusted. */
function holderFileName(disposition: string | null, mediaType: string): string {
  const m = disposition ? /filename="([^"]{1,255})"/.exec(disposition) : null;
  return safeFileName(m?.[1] ?? 'file', mediaType);
}

export function buildMediaHolderStream(deps: HolderMediaDeps): HolderMedia {
  let inFlight = 0;
  const perHolder = new Map<string, number>();
  const maxBytes = deps.maxBytes ?? MAX_FILE_BYTES;
  const recheckMs = deps.recheckMs ?? HOLDER_MEDIA_OWNER_RECHECK_MS;

  return async (q, res) => {
    const peer = deps.peers().find((p) => p.machineId === q.machine);
    if (!peer) { res.status(409).json({ error: 'wrong-machine', servedBy: deps.selfMachineId(), detail: 'This file belongs to a machine this one does not know.' }); return; }
    if (!isPeerUrlAllowedForCredentials({ url: peer.url, kind: (peer.kind ?? 'last-known-url') as PeerEndpointKind }, deps.allowlist?.()).ok) { failed(res, 502, 'holder-untrusted'); return; }
    const token = deps.token();
    if (!token) { failed(res, 503, 'holder-unavailable'); return; }
    const mine = perHolder.get(q.machine) ?? 0;
    // Full is a wait, not a fault: a conversation of photos asks for several at once, and the app
    // already polls this answer.
    if (inFlight >= HOLDER_MEDIA_MAX_IN_FLIGHT || mine >= HOLDER_MEDIA_MAX_PER_HOLDER) { res.status(202).json({ state: 'fetching', retryAfterMs: 2_000 }); return; }
    inFlight++;
    perHolder.set(q.machine, mine + 1);

    const abort = new AbortController();
    // A phone that hangs up stops the holder's read too.
    const onClose = () => { if (!res.writableFinished) abort.abort(new DOMException('client closed', 'AbortError')); };
    res.on('close', onClose);
    const deadline = setTimeout(() => abort.abort(new DOMException('deadline', 'TimeoutError')), deps.deadlineMs ?? HOLDER_MEDIA_DEADLINE_MS);
    let idle: NodeJS.Timeout | null = null;
    const wait = (ms: number) => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => abort.abort(new DOMException('idle', 'TimeoutError')), ms);
    };
    wait(deps.firstByteMs ?? HOLDER_MEDIA_FIRST_BYTE_MS);
    // On a clock, not on arriving bytes: a stalled holder or a phone that stopped reading still
    // gets cut off when the owner check fails.
    let revoked = false;
    const watch = setInterval(() => {
      let current = false;
      try { current = q.isCurrent(); } catch { current = false; } // @silent-fallback-ok — an owner check that cannot answer refuses
      if (revoked || current) return;
      revoked = true;
      abort.abort(new DOMException('owner check failed', 'AbortError'));
    }, recheckMs > 0 ? recheckMs : 50);
    watch.unref?.();

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const path = `/mobile/media/${q.sha256}?ref=${encodeURIComponent(q.ref)}&machine=${encodeURIComponent(q.machine)}&holderHop=1`;
      const ownerFetch: typeof fetch = async (input, init) => {
        if (!q.isCurrent()) throw new PoolPeerAdmissionError('owner-phone-required');
        return (deps.fetchImpl ?? fetch)(input, init);
      };
      const r = await poolPeerFetch(deps.record, peer, path, {
        headers: { Authorization: `Bearer ${token}` }, redirect: 'manual', signal: abort.signal,
      }, ownerFetch);
      if (r.status >= 300 && r.status < 400) { await r.body?.cancel().catch(() => undefined); failed(res, 502, 'holder-redirected'); return; } // @silent-fallback-ok — releasing a refused body
      if (r.status !== 200) {
        const body = await smallJson(r);
        if (!q.isCurrent()) { ownerOnly(res); return; }
        const code = typeof body?.error === 'string' ? body.error : '';
        if (r.status === 202 && body?.state === 'fetching') {
          const ms = typeof body.retryAfterMs === 'number' && Number.isFinite(body.retryAfterMs) ? Math.min(30_000, Math.max(2_000, body.retryAfterMs)) : 2_000;
          res.status(202).json({ state: 'fetching', retryAfterMs: ms });
        } else if (r.status === 404 && code === 'media-unavailable') res.status(404).json({ error: code, detail: 'This file is not on the machine that holds it.' });
        else if (r.status === 404) res.status(404).json({ error: 'not-found' });
        else if (r.status === 410) res.status(410).json({ error: 'media-unavailable', detail: 'This file was damaged on the machine that holds it.' });
        else if (r.status === 503 && code === 'media-off') res.status(503).json({ error: 'media-off', detail: 'Files are turned off on the machine that holds this one.' });
        else if (r.status === 403 && code === 'operator-device-required') failed(res, 502, 'holder-outdated', 'The machine that holds this file needs updating before the phone can open it.');
        else failed(res, 502, 'holder-failed');
        return;
      }
      if (r.headers.get(HOLDER_MEDIA_HEADER) !== '1') { await r.body?.cancel().catch(() => undefined); failed(res, 502, 'holder-outdated', 'The machine that holds this file needs updating before the phone can open it.'); return; } // @silent-fallback-ok — releasing a refused body
      const lengthHeader = r.headers.get('content-length');
      const length = lengthHeader !== null && /^[0-9]{1,16}$/.test(lengthHeader) ? Number(lengthHeader) : null;
      if (length !== null && length > maxBytes) { await r.body?.cancel().catch(() => undefined); failed(res, 502, 'holder-too-large'); return; } // @silent-fallback-ok — releasing a refused body
      reader = r.body?.getReader();
      if (!reader) { failed(res, 502, 'holder-bad-answer'); return; }

      const hash = crypto.createHash('sha256');
      let total = 0;
      let held: Uint8Array | null = null;
      let started = false;
      const start = () => {
        const declared = (r.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
        const inline = isInlineSafe(declared);
        res.setHeader('Content-Type', inline ? declared : 'application/octet-stream');
        if (!inline) res.setHeader('Content-Disposition', `attachment; filename="${holderFileName(r.headers.get('content-disposition'), declared)}"`);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        res.setHeader('Accept-Ranges', 'none');
        if (length !== null) res.setHeader('Content-Length', String(length));
        started = true;
      };
      const send = async (chunk: Uint8Array) => {
        if (!started) start();
        if (res.write(chunk)) return;
        // A slow phone is not a stalled holder: the overall deadline bounds this wait.
        if (idle) clearTimeout(idle);
        await once(res, 'drain', { signal: abort.signal });
        wait(deps.idleMs ?? HOLDER_MEDIA_IDLE_MS);
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        wait(deps.idleMs ?? HOLDER_MEDIA_IDLE_MS);
        total += value.byteLength;
        if (total > maxBytes || (length !== null && total > length)) { abort.abort(); failed(res, 502, 'holder-too-large'); return; }
        hash.update(value);
        if (!started && !q.isCurrent()) { abort.abort(); ownerOnly(res); return; }
        if (held) await send(held);
        held = value;
      }
      if ((length !== null && total !== length) || hash.digest('hex') !== q.sha256) { failed(res, 502, 'holder-bad-file'); return; }
      if (!q.isCurrent()) { ownerOnly(res); return; }
      if (held) await send(held);
      else if (!started) start();
      res.end();
    } catch (err) {
      if (err instanceof PoolPeerAdmissionError || revoked) { ownerOnly(res); return; }
      if (res.destroyed) return;
      const name = (err as { name?: string } | null)?.name;
      const reasonName = (abort.signal.reason as { name?: string } | undefined)?.name;
      const timedOut = name === 'TimeoutError' || reasonName === 'TimeoutError';
      failed(res, timedOut ? 504 : 502, timedOut ? 'holder-timeout' : 'holder-unreachable');
    } finally {
      clearTimeout(deadline);
      clearInterval(watch);
      if (idle) clearTimeout(idle);
      res.off('close', onClose);
      void reader?.cancel().catch(() => undefined); // @silent-fallback-ok — a finished or aborted read has nothing to release
      inFlight--;
      const left = (perHolder.get(q.machine) ?? 1) - 1;
      if (left > 0) perHolder.set(q.machine, left); else perHolder.delete(q.machine);
    }
  };
}
