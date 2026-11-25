import { constants, type Http2Session, type IncomingHttpHeaders, type ServerHttp2Stream } from 'node:http2';
import type { Socket } from 'node:net';
import type { HostedRelayLeaseAdmission, HostedRelayLeaseClaim } from './leaseAdmission.js';
import { HostedRelayOutboundTransport } from './outboundTransport.js';
import { HostedRelayStreamCustody } from './streamCustody.js';
import { routeHostedRelaySocket } from './tlsPassthrough.js';

const controlPath = '/relay/v1/control';
const offerPath = '/relay/v1/offer';
const maxClaimBytes = 4096;
const maxControlSessions = 64;
const maxClientSockets = 256;
const claimFields = ['hostname', 'assignment', 'holder', 'epoch', 'expiresAt', 'challenge', 'signature'];

function decodeClaim(bytes: Buffer): HostedRelayLeaseClaim | undefined {
  try {
    const claim = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!claim || typeof claim !== 'object' || Array.isArray(claim) || Object.keys(claim).length !== claimFields.length
      || !claimFields.every(field => Object.hasOwn(claim, field))) return undefined;
    return claim as HostedRelayLeaseClaim;
  } catch { return undefined; } // @silent-fallback-ok — malformed claims are refused
}

interface Control {
  stream: ServerHttp2Stream;
  transport?: HostedRelayOutboundTransport;
  detach?: () => void;
}

/** Integration entry points for isolated relay listeners. The caller owns
 * socket creation, trustworthy lease sources and aggregate ingress limits. */
export function createDisposableHostedRelay(leases: HostedRelayLeaseAdmission) {
  const custody = new HostedRelayStreamCustody(leases);
  const controls = new Map<Http2Session, Control>();
  const clients = new Set<Socket>();
  let stopped = false;

  function control(stream: ServerHttp2Stream, session: Http2Session): void {
    const state: Control = { stream };
    controls.set(session, state);
    const handshake = leases.challenge();
    let pending = Buffer.alloc(0);
    let receivedClaim = false;
    const timeout = setTimeout(() => session.destroy(), 10_000);
    timeout.unref();

    function release() {
      clearTimeout(timeout);
      pending.fill(0);
      controls.delete(session);
      state.detach?.();
    }
    function refuse() {
      stream.end(JSON.stringify({ type: 'refused' }) + '\n', () => session.close());
      const timer = setTimeout(() => session.destroy(), 1_000);
      timer.unref();
      session.once('close', () => clearTimeout(timer));
    }
    stream.once('close', release);
    stream.once('end', () => session.destroy());
    stream.on('error', () => session.destroy());
    stream.respond({ ':status': 200, 'cache-control': 'no-store', 'content-type': 'application/x-ndjson' });
    stream.write(JSON.stringify({ type: 'challenge', nonce: handshake.nonce }) + '\n');
    stream.on('data', (chunk: Buffer) => {
      if (receivedClaim || chunk.length + pending.length > maxClaimBytes) {
        session.destroy();
        return;
      }
      const previous = pending;
      pending = Buffer.concat([previous, chunk]);
      previous.fill(0);
      const delimiter = pending.indexOf(10);
      if (delimiter === -1) return;
      receivedClaim = true;
      clearTimeout(timeout);
      if (delimiter !== pending.length - 1) {
        session.destroy();
        return;
      }
      const claim = decodeClaim(pending.subarray(0, delimiter));
      pending.fill(0);
      if (!claim) { refuse(); return; }
      const transport = new HostedRelayOutboundTransport(stream, reason => {
        stream.end(JSON.stringify({ type: reason }) + '\n');
      });
      const detach = custody.attach(claim, handshake, transport);
      if (!detach) { refuse(); return; }
      state.transport = transport;
      state.detach = detach;
      stream.write(JSON.stringify({ type: 'admitted' }) + '\n');
    });
  }

  return {
    acceptOutbound(stream: ServerHttp2Stream, headers: IncomingHttpHeaders) {
      const session = stream.session;
      if (!session || stopped || headers[':method'] !== 'POST') { stream.respond({ ':status': 404 }, { endStream: true }); return; }
      if (headers[':path'] === controlPath && !controls.has(session) && controls.size < maxControlSessions) {
        control(stream, session);
        return;
      }
      if (headers[':path'] === offerPath && controls.get(session)?.transport?.offer(stream)) return;
      stream.respond({ ':status': 403 }, { endStream: true });
      stream.close(constants.NGHTTP2_CANCEL);
    },
    acceptClient(socket: Socket) {
      if (stopped || clients.size >= maxClientSockets) { socket.destroy(); return; }
      clients.add(socket);
      socket.once('close', () => clients.delete(socket));
      routeHostedRelaySocket(socket, name => custody.openStream(name));
    },
    sweep() { custody.sweep(); },
    stop() {
      stopped = true;
      custody.stop();
      for (const session of controls.keys()) session.destroy();
      controls.clear();
      for (const socket of clients) socket.destroy();
      clients.clear();
    },
  };
}
