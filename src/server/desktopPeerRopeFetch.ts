/**
 * desktopPeerRopeFetch — remote-desktop calls to a peer machine try EVERY rope
 * that peer advertises, in the resolver's order, instead of only the first.
 *
 * Why this exists. `resolvePeerUrls()` hands each fan-out site ONE selection per
 * machine: the best rope the ordinary credential guard admits. The desktop gate
 * (`desktopPeerUrlAllowed`) admits one more rope than that guard — plain-http
 * Tailscale proven by the local daemon — so for a machine whose Tailscale rope is
 * the only live one (a Windows PC under WSL, whose `lan` rope is the WSL-internal
 * NAT address and whose quick tunnel went stale), the selection the desktop code
 * received was the dead LAN rope, the call failed, and the guided setup reported
 * "Can't reach" a machine that answered fine over Tailscale (2026-11-02).
 *
 * Retry rule. A rope is abandoned for the next one ONLY when the request provably
 * never reached a server: a short TCP connect check failed before the request was
 * sent, or the request itself failed with a connect-class error (refused, no route,
 * DNS failure, connect timeout). Any HTTP reply — whatever its status — is
 * authoritative and returned as-is, and an ambiguous failure (an abort or timeout
 * after the connection opened, a reset mid-request) is rethrown without trying
 * another rope: these requests are signed and some of them act on the target.
 *
 * The connect check runs only when an admissible rope remains after the current
 * one, so a single-rope peer behaves exactly as before. The whole call, including
 * the checks, stays inside the caller's time budget.
 */
import { connect } from 'node:net';
import { desktopPeerUrlAllowed } from './DesktopPeerUrlGate.js';
import type { PeerEndpointKind } from './peerUrlGuard.js';
import { poolPeerFetch, type RopeResultRecorder } from './poolPeerFetch.js';

export interface DesktopRope { url: string; kind: PeerEndpointKind }

/** The shape `resolvePeerUrls()` returns: the selected rope, the ropes the
 *  credential guard skipped ahead of it, and (when wired) every rope in order. */
export interface DesktopPeerEntry extends DesktopRope {
  machineId: string;
  ropes?: DesktopRope[];
  ropeRefusals?: Array<{ url: string; kind: PeerEndpointKind }>;
}

/** Every rope for this peer, in priority order, de-duplicated by URL. With no
 *  full list wired, the refused ropes come first: the resolver ranked them
 *  above the selection. */
export function desktopPeerRopes(peer: DesktopPeerEntry): DesktopRope[] {
  const ordered = peer.ropes && peer.ropes.length > 0
    ? peer.ropes
    : [...(peer.ropeRefusals ?? []), { url: peer.url, kind: peer.kind }];
  const seen = new Set<string>();
  const out: DesktopRope[] = [];
  for (const rope of ordered) {
    if (!rope || typeof rope.url !== 'string' || seen.has(rope.url)) continue;
    seen.add(rope.url);
    out.push({ url: rope.url, kind: rope.kind });
  }
  return out;
}

const CONNECT_CLASS_CODES = new Set([
  'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** True only for failures that prove the request never left this machine. */
export function isConnectClassFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && CONNECT_CLASS_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Can a TCP connection to this rope's host and port be opened in time? */
export function tcpConnectCheck(url: string, timeoutMs: number): Promise<boolean> {
  let parsed: URL;
  try { parsed = new URL(url); } catch {
    // @silent-fallback-ok — a malformed rope URL is treated as unreachable; the gate refuses it anyway.
    return Promise.resolve(false);
  }
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  return new Promise(resolve => {
    let settled = false;
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), Math.max(1, timeoutMs));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export interface DesktopRopeFetchOptions {
  machineId: string;
  ropes: DesktopRope[];
  path: string;
  /** Request init without `signal`; the helper supplies the time budget. */
  init: Omit<RequestInit, 'signal'>;
  /** Total time for the whole call, every rope and check included. */
  budgetMs: number;
  /** Longest a connect check may take before the next rope is tried. */
  connectCheckCapMs: number;
  /** Caller cancellation (e.g. a desktop Stop). */
  signal?: AbortSignal;
  record?: RopeResultRecorder;
  fetchImpl?: typeof fetch;
  allowed?: (rope: DesktopRope) => Promise<boolean>;
  connectCheck?: (url: string, timeoutMs: number) => Promise<boolean>;
  now?: () => number;
}

export class DesktopPeerUnreachableError extends Error {
  constructor() { super('desktop-peer-unreachable'); this.name = 'DesktopPeerUnreachableError'; }
}

/**
 * Send one desktop request to a peer over the first rope that carries it.
 * Returns the response and the rope that answered. Throws
 * `DesktopPeerUnreachableError` when no rope is admissible or none could be
 * reached, and rethrows an ambiguous failure from the rope that was in use.
 */
export async function fetchDesktopPeerOverRopes(o: DesktopRopeFetchOptions): Promise<{ response: Response; rope: DesktopRope }> {
  const now = o.now ?? Date.now;
  const deadline = now() + o.budgetMs;
  const allowed = o.allowed ?? desktopPeerUrlAllowed;
  const check = o.connectCheck ?? tcpConnectCheck;
  const admissible: DesktopRope[] = [];
  for (const rope of o.ropes) {
    if (now() >= deadline) break;
    if (await allowed(rope)) admissible.push(rope);
  }
  for (let index = 0; index < admissible.length; index++) {
    const rope = admissible[index];
    const remaining = deadline - now();
    if (remaining <= 0) break;
    const hasNext = index < admissible.length - 1;
    if (hasNext) {
      const started = now();
      const reachable = await check(rope.url, Math.min(o.connectCheckCapMs, remaining));
      if (!reachable) {
        if (rope.kind !== 'last-known-url') o.record?.(o.machineId, rope.kind, false, now() - started, rope.url);
        continue;
      }
    }
    const left = deadline - now();
    if (left <= 0) break;
    const timeout = AbortSignal.timeout(left);
    try {
      const response = await poolPeerFetch(o.record,
        { machineId: o.machineId, url: rope.url.replace(/\/+$/, ''), kind: rope.kind }, o.path,
        { ...o.init, signal: o.signal ? AbortSignal.any([o.signal, timeout]) : timeout }, o.fetchImpl);
      return { response, rope };
    } catch (error) {
      if (hasNext && !o.signal?.aborted && isConnectClassFailure(error)) continue;
      throw error;
    }
  }
  throw new DesktopPeerUnreachableError();
}
