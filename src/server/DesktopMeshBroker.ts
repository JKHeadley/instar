import { createHash, timingSafeEqual } from 'node:crypto';
import { mintDesktopOperatorAssertion } from '../core/DesktopOperatorAssertion.js';
import { sign as signMachinePayload } from '../core/MachineIdentity.js';
import { signRequest } from './machineAuth.js';
import type { PeerEndpointKind } from './peerUrlGuard.js';
import { desktopPeerUrlAllowed } from './DesktopPeerUrlGate.js';
import type { RopeResultRecorder } from './poolPeerFetch.js';

interface DesktopPeer { machineId: string; url: string; kind: PeerEndpointKind }
interface RemoteRequest {
  machineId: string;
  frontSessionDigest: string;
  targetSessionToken: string;
  expiresAtMs: number;
  timer: ReturnType<typeof setInterval>;
  inflight: Set<AbortController>;
}

export interface DesktopMeshBrokerDeps {
  selfMachineId: string;
  signingKeyPem: string;
  peers: () => DesktopPeer[];
  verifyFrontSession: (token: string) => boolean;
  now?: () => number;
  fetch?: typeof fetch;
  recordRopeResult?: RopeResultRecorder;
  onForget?: (requestId: string) => void;
  /** A new front process waits out target delegated-session liveness from a
   * previous incarnation before admitting fresh pool reservations. */
  startupQuarantineMs?: number;
}

/** Dashboard front for remote desktop. It handles routing and PIN-session
 * attestation, while the target alone mints grants and encrypts the stream. */
export class DesktopMeshBroker {
  private readonly requests = new Map<string, RemoteRequest>();
  private readonly tickets = new Map<string, { requestId: string; url: string; expiresAtMs: number }>();
  private readonly now: () => number;
  private readonly doFetch: typeof fetch;
  private readonly admissionAfterMs: number;
  private pendingBegins = 0;
  private closed = false;

  constructor(private readonly d: DesktopMeshBrokerDeps) {
    this.now = d.now ?? Date.now;
    this.doFetch = d.fetch ?? fetch;
    this.admissionAfterMs = this.now() + (d.startupQuarantineMs ?? 25_000);
  }

  hasRequest(requestId: string): boolean { return this.requests.has(requestId); }
  signingKeyPem(): string { return this.d.signingKeyPem; }

  async begin(frontSessionToken: string, input: {
    machineId: string; browserPublicKey: string; browserEcdhPublicKey: string;
    browserNonce: string; videoCodec?: 'jpeg' | 'h264';
  }): Promise<{ requestId: string }> {
    if (!this.d.verifyFrontSession(frontSessionToken)) throw new Error('recent dashboard PIN session required');
    // Reserve at most three remote slots, including in-flight admissions. The
    // fourth slot is always held for this front's own physical desktop.
    if (this.closed || this.now() < this.admissionAfterMs || input.machineId === this.d.selfMachineId
      || this.requests.size + this.pendingBegins >= 3
      || typeof input.browserEcdhPublicKey !== 'string' || input.browserEcdhPublicKey.length > 256
      || (input.videoCodec !== undefined && input.videoCodec !== 'jpeg' && input.videoCodec !== 'h264')) {
      throw new Error('desktop target unavailable');
    }
    this.pendingBegins++;
    try {
    const peer = await this.peer(input.machineId);
    if (this.closed) throw new Error('desktop front closed');
    const assertion = mintDesktopOperatorAssertion({
      issuerMachineId: this.d.selfMachineId, targetMachineId: input.machineId,
      browserPublicKey: input.browserPublicKey, browserNonce: input.browserNonce,
      nowMs: this.now(), sign: canonical => signMachinePayload(canonical, this.d.signingKeyPem),
    });
    const result = await this.post(peer, '/api/desktop/operator-begin', {
      assertion, browserPublicKey: input.browserPublicKey,
      browserEcdhPublicKey: input.browserEcdhPublicKey,
      browserNonce: input.browserNonce, videoCodec: input.videoCodec ?? 'h264',
    });
    if (this.closed) throw new Error('desktop front closed');
    if (!/^[a-f0-9-]{36}$/i.test(String(result.requestId ?? ''))
      || typeof result.targetSessionToken !== 'string' || result.targetSessionToken.length < 32
      || result.targetSessionToken.length > 128 || this.requests.has(result.requestId as string)) {
      throw new Error('desktop target response invalid');
    }
    const requestId = result.requestId as string;
    const timer = setInterval(() => { void this.refresh(requestId, frontSessionToken); }, 5_000);
    timer.unref?.();
    this.requests.set(requestId, {
      machineId: input.machineId, frontSessionDigest: this.digest(frontSessionToken),
      targetSessionToken: result.targetSessionToken, expiresAtMs: this.now() + 10 * 60_000, timer,
      inflight: new Set(),
    });
    return { requestId };
    } finally {
      this.pendingBegins--;
    }
  }

  async control(frontSessionToken: string, requestId: string,
    operation: 'status' | 'cursor' | 'ticket' | 'resume' | 'revoke',
    payload?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const row = this.request(frontSessionToken, requestId);
    if (operation === 'revoke') {
      // Stop is local and immediate. Peer discovery and target revocation are
      // best effort; a partition must never leave the front relay alive.
      this.forget(requestId);
      try {
        const peer = await this.peer(row.machineId);
        await this.post(peer, '/api/desktop/operator-command', {
          targetSessionToken: row.targetSessionToken, requestId, operation,
        });
      } catch {
        // @silent-fallback-ok — the relay is closed; target liveness expires
        // without keepalives even when target revocation cannot be delivered.
      }
      return { revoked: true };
    }
    const peer = await this.peer(row.machineId);
    if (this.requests.get(requestId) !== row || this.closed) throw new Error('desktop request unavailable');
    const controller = new AbortController();
    row.inflight.add(controller);
    let result: Record<string, unknown>;
    try {
      result = await this.post(peer, '/api/desktop/operator-command', {
        targetSessionToken: row.targetSessionToken, requestId, operation,
        ...(payload ? { payload } : {}),
      }, controller.signal);
    } finally { row.inflight.delete(controller); }
    // A Stop may have run while the target was answering. Never mint a fresh
    // relay ticket or report stale control state after local revocation.
    if (this.requests.get(requestId) !== row || this.closed) throw new Error('desktop request unavailable');
    if (operation === 'ticket') {
      if (result.machineId !== row.machineId || typeof result.ticket !== 'string'
        || result.ticket.length < 16 || result.ticket.length > 256) {
        throw new Error('desktop target ticket invalid');
      }
      this.tickets.set(result.ticket, { requestId, url: peer.url, expiresAtMs: this.now() + 20_000 });
    }
    if (operation === 'status' && result.status === 'revoked') this.forget(requestId);
    return result;
  }

  /** A ticket is one-use at this relay and at the target. */
  consumeTicket(ticket: string): { requestId: string; url: string } | null {
    const row = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!row || this.now() >= row.expiresAtMs || !this.requests.has(row.requestId)) return null;
    return { requestId: row.requestId, url: row.url };
  }

  close(): void {
    this.closed = true;
    for (const requestId of this.requests.keys()) this.forget(requestId);
  }

  private async refresh(requestId: string, frontSessionToken: string): Promise<void> {
    if (this.closed) return;
    const row = this.requests.get(requestId);
    if (!row) return;
    if (this.now() >= row.expiresAtMs || !this.d.verifyFrontSession(frontSessionToken)) {
      this.forget(requestId);
      // Losing the front PIN closes the relay now. Also tell the target to
      // revoke its grant; its liveness deadline is only the partition fallback.
      try {
        await this.post(await this.peer(row.machineId), '/api/desktop/operator-command', {
          targetSessionToken: row.targetSessionToken, requestId, operation: 'revoke',
        });
      } catch {
        // @silent-fallback-ok — relay is already closed, and the target
        // independently expires the delegated session after missed keepalives.
      }
      return;
    }
    try {
      const peer = await this.peer(row.machineId);
      if (this.closed || this.requests.get(requestId) !== row) return;
      const controller = new AbortController();
      row.inflight.add(controller);
      try {
        await this.post(peer, '/api/desktop/operator-keepalive', {
          targetSessionToken: row.targetSessionToken,
        }, controller.signal);
      } finally { row.inflight.delete(controller); }
    } catch {
      // @silent-fallback-ok — target's 20-second liveness expires closed after
      // a failed refresh; the next control call reports the failure directly.
    }
  }

  private request(frontSessionToken: string, requestId: string): RemoteRequest {
    const row = this.requests.get(requestId);
    if (this.closed || !row || !this.d.verifyFrontSession(frontSessionToken) || this.now() >= row.expiresAtMs
      || !this.equalDigest(this.digest(frontSessionToken), row.frontSessionDigest)) {
      throw new Error('desktop request unavailable');
    }
    return row;
  }

  private forget(requestId: string): void {
    const row = this.requests.get(requestId);
    if (row) {
      clearInterval(row.timer);
      for (const controller of row.inflight) controller.abort();
      row.inflight.clear();
    }
    this.requests.delete(requestId);
    if (row) this.d.onForget?.(requestId);
    for (const [ticket, entry] of this.tickets) if (entry.requestId === requestId) this.tickets.delete(ticket);
  }

  private async peer(machineId: string): Promise<DesktopPeer> {
    const peer = this.d.peers().find(candidate => candidate.machineId === machineId);
    if (!peer || !await desktopPeerUrlAllowed(peer)) {
      throw new Error('desktop target unavailable');
    }
    return peer;
  }

  private async post(peer: DesktopPeer, endpoint: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const started = this.now();
    let response: Response;
    try {
      response = await this.doFetch(new URL(endpoint, peer.url).toString(), {
        method: 'POST', headers: { 'Content-Type': 'application/json',
          ...signRequest(this.d.selfMachineId, this.d.signingKeyPem, body) },
        body: JSON.stringify(body), redirect: 'manual',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3_000)]) : AbortSignal.timeout(3_000),
      });
      if (peer.kind !== 'last-known-url') {
        this.d.recordRopeResult?.(peer.machineId, peer.kind, true, this.now() - started, peer.url);
      }
    } catch (error) {
      if (peer.kind !== 'last-known-url') {
        this.d.recordRopeResult?.(peer.machineId, peer.kind, false, this.now() - started, peer.url);
      }
      throw error;
    }
    if (!response.ok) throw new Error(response.status === 503 ? 'Remote desktop is unavailable on this machine.'
      : 'Remote desktop request was refused by the target.');
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > 8_192) throw new Error('desktop target response too large');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('desktop target response empty');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8_192) { await reader.cancel(); throw new Error('desktop target response too large'); }
      chunks.push(value);
    }
    const raw = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), size).toString('utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('desktop target response invalid');
    return parsed as Record<string, unknown>;
  }

  private digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
  private equalDigest(left: string, right: string): boolean {
    return timingSafeEqual(Buffer.from(left), Buffer.from(right));
  }
}
