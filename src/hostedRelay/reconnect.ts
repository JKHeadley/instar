import type { ClientHttp2Session } from 'node:http2';
import { performance } from 'node:perf_hooks';
import type { Duplex } from 'node:stream';
import { setTimeout as wait } from 'node:timers/promises';
import { startHostedRelayAgentSession } from './agentSession.js';
import type { HostedRelayLease } from './leaseAdmission.js';

type Scope = Pick<HostedRelayLease, 'hostname' | 'assignment' | 'holder'>;
const maxAttempts = 6;
const stableMs = 30_000;

/** Explicitly started reconnect lifecycle. Each attempt obtains the local
 * holder's current lease and a newly verified relay connection. The opener
 * must verify the configured relay identity and return actual close tracking
 * registered at socket creation. On rejection it must settle any owned socket. */
export async function runHostedRelayReconnect(options: {
  scope: Scope;
  signal: AbortSignal;
  currentLease(): HostedRelayLease | undefined;
  connectVerified(signal: AbortSignal): Promise<{ session: ClientHttp2Session; closed: Promise<void> }>;
  sign(message: string): string;
  openLocalTls(): Duplex | undefined;
  onAdmission?(session: ClientHttp2Session, lease: HostedRelayLease, lifetime: AbortSignal): void;
}): Promise<'stopped' | 'lease-unavailable' | 'attempts-exhausted'> {
  const scope = { ...options.scope };
  const { signal } = options;
  let highestEpoch = 0;
  function current(): HostedRelayLease | undefined {
    let lease: HostedRelayLease | undefined;
    try { lease = options.currentLease(); }
    catch { return undefined; } // @silent-fallback-ok — unavailable authority cannot reconnect
    if (!lease || lease.hostname !== scope.hostname || lease.assignment !== scope.assignment || lease.holder !== scope.holder
      || !Number.isSafeInteger(lease.epoch) || lease.epoch < Math.max(1, highestEpoch) || !Number.isSafeInteger(lease.expiresAt) || lease.expiresAt <= Date.now()) return undefined;
    highestEpoch = lease.epoch;
    return { ...lease };
  }

  let attempt = 0, retrying = false;
  while (attempt < maxAttempts) {
    if (signal.aborted) return 'stopped';
    if (retrying) {
      try { await wait(Math.min(250 * 2 ** Math.max(0, attempt - 1), 4000), undefined, { signal }); }
      catch { return 'stopped'; } // @silent-fallback-ok — abort cancels a pending reconnect
    }
    attempt++;
    retrying = true;
    let session: ClientHttp2Session | undefined;
    let presentedClose: Promise<void> | undefined;
    try {
      if (!current()) return 'lease-unavailable';
      const connectSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      const connected = await options.connectVerified(connectSignal);
      session = connected.session;
      presentedClose = connected.closed;
      if (session.closed || session.destroyed) continue;
      if (signal.aborted) return 'stopped';
      if (connectSignal.aborted) continue;
      const refreshed = current();
      if (!refreshed) return 'lease-unavailable';
      const active = await startHostedRelayAgentSession({ session, lease: refreshed, signal,
        sign: options.sign, openLocalTls: options.openLocalTls });
      const liveSince = performance.now();
      const admission = new AbortController();
      const lifetime = AbortSignal.any([signal, admission.signal]);
      const admittedEpoch = refreshed.epoch;
      const admittedExpiry = refreshed.expiresAt;
      function guardAdmission() {
        const lease = current();
        if (!lease || lease.epoch !== admittedEpoch || lease.expiresAt !== admittedExpiry) {
          admission.abort();
          active.stop();
        }
      }
      const monitor = setInterval(guardAdmission, 250);
      monitor.unref();
      try {
        guardAdmission();
        if (!lifetime.aborted) options.onAdmission?.(session, refreshed, lifetime);
        await active.closed;
      } finally {
        clearInterval(monitor);
        admission.abort();
      }
      if (performance.now() - liveSince >= stableMs) attempt = 0;
    } catch {
      if (signal.aborted) return 'stopped'; // @silent-fallback-ok — a failed attempt retries within its bound
    } finally {
      session?.destroy();
      await presentedClose;
    }
  }
  return signal.aborted ? 'stopped' : 'attempts-exhausted';
}
