import { constants, type Http2Session, type ServerHttp2Stream } from 'node:http2';
import type { HostedRelayTunnel } from './streamCustody.js';

const maxPending = 64;
const offerTimeoutMs = 15_000;

/** Reverse streams are offered over the holder's one outbound HTTP/2 session.
 * The caller must authenticate its control stream before constructing this
 * adapter and dispatch only the fixed stream-offer endpoint to offer(). */
export class HostedRelayOutboundTransport implements HostedRelayTunnel {
  private readonly pending = new Map<ServerHttp2Stream, ReturnType<typeof setTimeout>>();
  private stopped = false;
  private readonly session: Http2Session;

  constructor(private readonly control: ServerHttp2Stream,
    private readonly notify: (reason: Parameters<HostedRelayTunnel['disconnect']>[0]) => void) {
    const session = control.session;
    if (!session || session.closed || session.destroyed || control.closed || control.destroyed) {
      throw new Error('hosted-relay-control-closed');
    }
    this.session = session;
    session.once('close', () => this.releasePending());
    control.once('close', () => {
      if (this.stopped) return;
      this.stopped = true;
      this.releasePending();
      session.destroy();
    });
  }

  offer(stream: ServerHttp2Stream): boolean {
    if (this.stopped || this.session.closed || this.session.destroyed || stream.session !== this.session
      || stream === this.control || stream.closed || stream.destroyed || stream.headersSent || this.pending.has(stream) || this.pending.size >= maxPending) return false;
    stream.pause();
    const timer = setTimeout(() => stream.close(constants.NGHTTP2_CANCEL), offerTimeoutMs);
    timer.unref();
    this.pending.set(stream, timer);
    stream.once('close', () => this.remove(stream));
    stream.on('error', () => stream.destroy());
    return true;
  }

  openStream(): ServerHttp2Stream | undefined {
    if (this.stopped || this.session.closed || this.session.destroyed) return undefined;
    for (const stream of this.pending.keys()) {
      this.remove(stream);
      if (stream.closed || stream.destroyed || stream.headersSent) continue;
      try {
        stream.respond({ ':status': 200, 'cache-control': 'no-store' });
        return stream;
      } catch {
        stream.destroy(); // @silent-fallback-ok — closed offers cannot carry data
      }
    }
    return undefined;
  }

  disconnect(reason: Parameters<HostedRelayTunnel['disconnect']>[0]): void {
    if (this.stopped) return;
    this.stopped = true;
    this.releasePending();
    try { if (!this.control.closed && !this.control.destroyed) this.notify(reason); }
    catch { /* @silent-fallback-ok — an unavailable control stream cannot block disconnect */ }
    finally {
      if (!this.session.destroyed) {
        const timer = setTimeout(() => this.session.destroy(), 1_000);
        timer.unref();
        this.session.once('close', () => clearTimeout(timer));
        this.session.close();
      }
    }
  }

  private remove(stream: ServerHttp2Stream): void {
    const timer = this.pending.get(stream);
    if (timer) clearTimeout(timer);
    this.pending.delete(stream);
  }

  private releasePending(): void {
    for (const stream of this.pending.keys()) {
      this.remove(stream);
      if (!stream.destroyed && !stream.closed) stream.close(constants.NGHTTP2_CANCEL);
    }
  }
}
