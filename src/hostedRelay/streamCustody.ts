import type { Duplex } from 'node:stream';
import type { HostedRelayLeaseAdmission, HostedRelayLeaseClaim } from './leaseAdmission.js';

type Admission = NonNullable<ReturnType<HostedRelayLeaseAdmission['admit']>>;
type Handshake = ReturnType<HostedRelayLeaseAdmission['challenge']>;
type Reason = 'displaced' | 'expired' | 'shutdown';

export interface HostedRelayTunnel {
  /** Return a fresh stream on this already-authenticated outbound connection. */
  openStream(): Duplex | undefined;
  disconnect(reason: Reason): void;
}

interface ActiveTunnel {
  connection: Admission['connection'];
  tunnel: HostedRelayTunnel;
  streams: Set<Duplex>;
  closed: boolean;
  opening: number;
}

const maxStreamsPerTunnel = 64;

/** Local stream ownership for a disposable relay. The transport owns listener
 * limits and must sweep while active. Multi-host displacement requires a shared
 * coordinator and prompt notification to the process retaining the socket. */
export class HostedRelayStreamCustody {
  private readonly tunnels = new Map<string, ActiveTunnel>();
  private stopped = false;

  constructor(private readonly leases: HostedRelayLeaseAdmission) {}

  attach(claim: HostedRelayLeaseClaim, handshake: Handshake, tunnel: HostedRelayTunnel): (() => void) | undefined {
    if (this.stopped) return undefined;
    const admission = this.leases.admit(claim, handshake);
    if (!admission) return undefined;
    const { connection } = admission;
    const active = { connection, tunnel, streams: new Set<Duplex>(), closed: false, opening: 0 };
    if (this.stopped) {
      this.close(active, 'shutdown');
      return undefined;
    }
    const previous = this.tunnels.get(connection.hostname);
    this.tunnels.set(connection.hostname, active);
    if (previous) this.close(previous, 'displaced');
    if (!this.leases.canServe(connection) || this.tunnels.get(connection.hostname) !== active) {
      this.close(active, 'expired');
      return undefined;
    }
    return () => this.close(active, 'shutdown');
  }

  openStream(hostname: string): Duplex | undefined {
    const active = this.tunnels.get(hostname);
    if (!active || this.stopped || active.streams.size + active.opening >= maxStreamsPerTunnel) return undefined;
    active.opening++;
    try {
      if (!this.leases.canServe(active.connection) || this.tunnels.get(hostname) !== active) {
        this.close(active, 'expired');
        return undefined;
      }
      let stream: Duplex | undefined;
      try { stream = active.tunnel.openStream(); }
      catch { this.close(active, 'shutdown'); return undefined; } // @silent-fallback-ok — an unavailable tunnel cannot accept a stream
      if (!stream || stream.destroyed) return undefined;
      if (!this.leases.canServe(active.connection) || this.tunnels.get(hostname) !== active) {
        stream.destroy();
        this.close(active, 'expired');
        return undefined;
      }
      if (active.streams.has(stream)) {
        this.close(active, 'shutdown');
        return undefined;
      }
      const opened = stream;
      active.streams.add(opened);
      opened.once('close', () => active.streams.delete(opened));
      opened.on('error', () => opened.destroy());
      return opened;
    } finally {
      active.opening--;
    }
  }

  sweep(): void {
    for (const active of this.tunnels.values()) {
      if (!this.leases.canServe(active.connection)) this.close(active, 'expired');
    }
  }

  stop(): void {
    this.stopped = true;
    for (const active of this.tunnels.values()) this.close(active, 'shutdown');
  }

  private close(active: ActiveTunnel, reason: Reason): void {
    if (this.tunnels.get(active.connection.hostname) === active) this.tunnels.delete(active.connection.hostname);
    if (active.closed) return;
    active.closed = true;
    for (const stream of active.streams) stream.destroy();
    active.streams.clear();
    try { active.tunnel.disconnect(reason); }
    catch { /* @silent-fallback-ok — route and streams already detached */ }
  }
}
