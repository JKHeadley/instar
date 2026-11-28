import { X509Certificate, createHash, timingSafeEqual } from 'node:crypto';
import http2, { type ClientHttp2Session } from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';

type VerifiedSession = { session: ClientHttp2Session; closed: Promise<void> };

/** Create a dialer for a fixed relay endpoint. Normal certificate and hostname
 * verification must pass before the additional configured SPKI pin is checked. */
export function createHostedRelayVerifiedDialer(options: {
  origin: string;
  spkiSha256: string;
  ca?: string | Buffer;
}): (signal: AbortSignal) => Promise<VerifiedSession> {
  const relay = new URL(options.origin);
  if (relay.protocol !== 'https:' || relay.origin !== options.origin || !/^[a-f0-9]{64}$/.test(options.spkiSha256)) {
    throw new Error('hosted-relay-dial-config');
  }
  const host = relay.hostname.replace(/^\[|\]$/g, '');
  const pin = Buffer.from(options.spkiSha256, 'hex');
  const ca = Buffer.isBuffer(options.ca) ? Buffer.from(options.ca) : options.ca;
  return signal => {
    if (signal.aborted) return Promise.reject(new Error('hosted-relay-dial-aborted'));
    return new Promise((resolve, reject) => {
      let session: ClientHttp2Session | undefined;
      let sessionClose: Promise<void> | undefined;
      let settled = false;
      const socket = tls.connect({
        host, port: relay.port ? Number(relay.port) : 443,
        servername: net.isIP(host) ? undefined : host,
        rejectUnauthorized: true, minVersion: 'TLSv1.2', ALPNProtocols: ['h2'], ca,
        checkServerIdentity(_name, certificate) {
          const identityError = tls.checkServerIdentity(host, certificate);
          if (identityError) return identityError;
          try {
            const key = new X509Certificate(certificate.raw).publicKey.export({ type: 'spki', format: 'der' });
            const actual = createHash('sha256').update(key).digest();
            if (timingSafeEqual(actual, pin)) return undefined;
          } catch { /* @silent-fallback-ok — malformed certificates cannot match the pin */ }
          return new Error('hosted-relay-certificate-pin');
        },
      });
      const socketClose = new Promise<void>(done => socket.once('close', () => done()));
      const timeout = setTimeout(() => fail('timeout'), 10_000);
      timeout.unref();
      function clear() {
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
      }
      function fail(reason: string) {
        if (settled) return;
        settled = true;
        clear();
        session?.destroy();
        socket.destroy();
        void Promise.all([socketClose, sessionClose]).then(() => reject(new Error('hosted-relay-dial-' + reason)));
      }
      function abort() { fail('aborted'); }
      signal.addEventListener('abort', abort, { once: true });
      socket.on('error', () => fail('certificate-or-connection'));
      socket.once('close', () => fail('closed'));
      socket.once('secureConnect', () => {
        if (settled) return;
        if (!socket.authorized || socket.alpnProtocol !== 'h2') { fail('protocol'); return; }
        try {
          const connected = http2.connect(relay.origin, { createConnection: () => socket });
          session = connected;
          sessionClose = new Promise<void>(done => connected.once('close', () => done()));
          connected.on('error', () => fail('http2'));
          connected.once('close', () => fail('closed'));
          connected.once('connect', () => {
            if (settled) return;
            if (signal.aborted || connected.closed || connected.destroyed) { fail('closed'); return; }
            settled = true;
            clear();
            const closed = Promise.all([socketClose, sessionClose]).then(() => undefined);
            resolve({ session: connected, closed });
          });
        } catch { fail('http2'); } // @silent-fallback-ok — unusable sessions are closed before rejection
      });
    });
  };
}
