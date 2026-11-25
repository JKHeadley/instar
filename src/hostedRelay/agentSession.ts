import type { ClientHttp2Session, ClientHttp2Stream } from 'node:http2';
import { performance } from 'node:perf_hooks';
import type { Duplex } from 'node:stream';
import { hostedRelayLeaseMessage, type HostedRelayLease } from './leaseAdmission.js';

const offerCount = 4;
const handshakeLimit = 1024;
const handshakeMs = 10_000;

/** One opt-in outbound session. The caller supplies a verified relay
 * connection, a current signed-lease snapshot and a fixed local TLS target. */
export function startHostedRelayAgentSession(options: {
  session: ClientHttp2Session;
  lease: HostedRelayLease;
  sign(message: string): string;
  openLocalTls(): Duplex | undefined;
}): Promise<{ stop(): void }> {
  const { session } = options;
  return new Promise((resolve, reject) => {
    const active = new Map<ClientHttp2Stream, Duplex | undefined>();
    let stopped = false, admitted = false, challenged = false, started = false;
    let pending = Buffer.alloc(0);
    let control: ClientHttp2Stream | undefined;
    const timeout = setTimeout(stop, handshakeMs);
    timeout.unref();

    function stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(timeout);
      pending.fill(0);
      for (const [stream, local] of active) {
        local?.destroy();
        stream.destroy();
      }
      active.clear();
      control?.destroy();
      session.destroy();
      if (!started) reject(new Error('hosted-relay-agent-unavailable'));
    }

    function offer() {
      if (stopped) return;
      let stream: ClientHttp2Stream;
      try { stream = session.request({ ':method': 'POST', ':path': '/relay/v1/offer' }, { endStream: false }); }
      catch { stop(); return; } // @silent-fallback-ok — a failed outbound session closes
      const offeredAt = performance.now();
      let matched = false;
      active.set(stream, undefined);
      stream.on('error', stop);
      function finish() {
        if (!active.delete(stream)) return;
        if (!stopped && !matched && performance.now() - offeredAt < 1000) stop();
        if (!stopped) offer();
      }
      stream.once('close', () => {
        const local = active.get(stream);
        if (local && !local.closed) {
          if (!stream.readableEnded) local.destroy();
          return;
        }
        finish();
      });
      stream.once('response', headers => {
        if (stopped || headers[':status'] !== 200) { stop(); return; }
        matched = true;
        let local: Duplex | undefined;
        try { local = options.openLocalTls(); }
        catch { stop(); return; } // @silent-fallback-ok — a failed local socket closes
        if (!local || stopped || stream.destroyed || local.destroyed) { local?.destroy(); stop(); return; }
        active.set(stream, local);
        local.once('error', () => stream.destroy());
        const destination = local;
        destination.once('close', () => {
          if (stream.closed) finish();
          else if (!destination.readableEnded) stream.destroy();
        });
        destination.pipe(stream).pipe(destination);
      });
    }

    function frame(bytes: Buffer) {
      const frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('invalid control frame');
      const fields = Object.keys(frame).length;
      if (frame.type === 'challenge' && fields === 2 && !challenged
        && typeof frame.nonce === 'string' && /^[a-f0-9]{64}$/.test(frame.nonce)) {
        challenged = true;
        const { hostname, assignment, holder, epoch, expiresAt } = options.lease;
        const lease = { hostname, assignment, holder, epoch, expiresAt };
        const signature = options.sign(hostedRelayLeaseMessage(lease, frame.nonce));
        control!.write(JSON.stringify({ ...lease, challenge: frame.nonce, signature }) + '\n');
      } else if (frame.type === 'admitted' && fields === 1 && challenged && !admitted) {
        admitted = true;
        clearTimeout(timeout);
        for (let i = 0; i < offerCount; i++) offer();
        if (!stopped) { started = true; resolve({ stop }); }
      } else {
        stop();
      }
    }

    session.on('error', stop);
    session.once('close', stop);
    try {
      control = session.request({ ':method': 'POST', ':path': '/relay/v1/control' }, { endStream: false });
      control.on('error', stop);
      control.once('close', stop);
      control.once('end', stop);
      control.once('response', headers => { if (headers[':status'] !== 200) stop(); });
      control.on('data', (chunk: Buffer) => {
        if (stopped || chunk.length + pending.length > handshakeLimit) { stop(); return; }
        const previous = pending;
        pending = Buffer.concat([previous, chunk]);
        previous.fill(0);
        try {
          let newline: number;
          while (!stopped && (newline = pending.indexOf(10)) >= 0) {
            frame(pending.subarray(0, newline));
            pending.fill(0, 0, newline + 1);
            pending = pending.subarray(newline + 1);
          }
        } catch { stop(); } // @silent-fallback-ok — malformed control cannot admit data
      });
    } catch { stop(); } // @silent-fallback-ok — unusable session cannot be started
  });
}
