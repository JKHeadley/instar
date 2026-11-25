import { constants, type Http2Session, type IncomingHttpHeaders, type ServerHttp2Stream } from 'node:http2';
import type { Socket } from 'node:net';
import type { HostedRelayLeaseAdmission, HostedRelayLeaseClaim } from './leaseAdmission.js';
import { HostedRelayOutboundTransport } from './outboundTransport.js';
import { HostedRelayStreamCustody } from './streamCustody.js';
import { HostedRelayRendezvous } from './rendezvous.js';
import { routeHostedRelaySocket } from './tlsPassthrough.js';

const controlPath = '/relay/v1/control';
const offerPath = '/relay/v1/offer';
const issuePath = '/relay/v1/rendezvous/issue';
const redeemPath = '/relay/v1/rendezvous/redeem';
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
  hostname?: string;
  detach?: () => void;
}

function respondJson(stream: ServerHttp2Stream, status: number, value: object): void {
  if (stream.destroyed || stream.closed) return;
  stream.respond({ ':status': status, 'cache-control': 'no-store', 'content-type': 'application/json' });
  stream.end(JSON.stringify(value));
}

function readBounded(stream: ServerHttp2Stream, maximum: number, receive: (data: Buffer | undefined) => void): void {
  const chunks: Buffer[] = [];
  let bytes = 0, finished = false;
  function finish(complete: boolean) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    const body = complete ? Buffer.concat(chunks, bytes) : undefined;
    for (const chunk of chunks) chunk.fill(0);
    chunks.length = 0;
    try { receive(body); } finally { body?.fill(0); }
  }
  const timer = setTimeout(() => {
    finish(false);
    if (!stream.closed && !stream.destroyed) stream.close(constants.NGHTTP2_CANCEL);
  }, 2000);
  timer.unref();
  stream.on('data', (chunk: Buffer) => {
    if (finished) return;
    if (bytes + chunk.length > maximum) {
      finish(false);
      if (!stream.closed && !stream.destroyed) stream.close(constants.NGHTTP2_CANCEL);
      return;
    }
    bytes += chunk.length;
    chunks.push(chunk);
  });
  stream.once('end', () => finish(true));
  stream.once('close', () => finish(false));
  stream.on('error', () => stream.destroy());
}

function parseCode(bytes: Buffer | undefined): unknown {
  if (!bytes) return undefined;
  try {
    const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return input && typeof input === 'object' && !Array.isArray(input)
      && Object.keys(input).length === 1 && Object.hasOwn(input, 'code') ? input.code : undefined;
  } catch { return undefined; } // @silent-fallback-ok — unreadable codes receive the normal refusal
}

/** Integration entry points for isolated relay listeners. The caller owns
 * socket creation, trustworthy lease sources and aggregate ingress limits. */
export function createDisposableHostedRelay(leases: HostedRelayLeaseAdmission) {
  const custody = new HostedRelayStreamCustody(leases);
  const rendezvous = new HostedRelayRendezvous(hostname => custody.currentAssignment(hostname));
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
      state.hostname = claim.hostname;
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
      if (headers[':path'] === issuePath) {
        readBounded(stream, 0, body => {
          if (!body || stopped || stream.closed || stream.destroyed) return;
          const active = controls.get(session);
          const { hostname, transport } = active ?? {};
          const assignment = hostname && transport && custody.currentAssignment(hostname, transport);
          const issued = assignment && hostname && transport
            ? rendezvous.issue(hostname, assignment, () => custody.currentAssignment(hostname, transport) === assignment)
            : undefined;
          respondJson(stream, issued ? 201 : 403, issued ?? { error: 'relay-rendezvous-unavailable' });
        });
        return;
      }
      if (headers[':path'] === redeemPath) {
        const peer = session.socket.remoteAddress ?? '';
        readBounded(stream, 128, body => {
          const selected = stopped ? undefined : rendezvous.redeem(peer, parseCode(body));
          respondJson(stream, selected ? 200 : 404, selected ?? { error: 'relay-rendezvous-unavailable' });
        });
        return;
      }
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
