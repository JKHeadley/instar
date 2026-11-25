import type { ClientHttp2Session } from 'node:http2';
import { connect } from 'node:net';
import { FencedLease } from '../core/FencedLease.js';
import { MachineIdentityManager, sign, verify } from '../core/MachineIdentity.js';
import type { LeaseRecord } from '../core/types.js';
import type { HostedRelayLease } from './leaseAdmission.js';
import { normalizeHostedRelayHostname } from './clientHello.js';
import { runHostedRelayReconnect } from './reconnect.js';

type Code = { code: string; expiresInSeconds: number };
type ReconnectOptions = Parameters<typeof runHostedRelayReconnect>[0];

async function requestCode(session: ClientHttp2Session, signal: AbortSignal): Promise<Code> {
  signal.throwIfAborted();
  const stream = session.request({ ':method': 'POST', ':path': '/relay/v1/rendezvous/issue' });
  const closed = new Promise<void>(resolve => stream.once('close', resolve));
  const cancel = () => stream.destroy(new Error('relay-unavailable'));
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const response = new Promise<Code>((resolve, reject) => {
      let accepted = false;
      let text = '';
      stream.once('error', reject);
      stream.once('close', () => reject(new Error('relay-unreachable')));
      stream.once('response', headers => {
        accepted = headers[':status'] === 201 && headers['cache-control'] === 'no-store'
          && headers['content-type'] === 'application/json';
        if (headers[':status'] === 403) reject(new Error('relay-unavailable'));
        else if (!accepted) reject(new Error('relay-unreachable'));
      });
      stream.setEncoding('utf8');
      stream.on('data', part => {
        if (Buffer.byteLength(text) + Buffer.byteLength(part) > 256) {
          stream.destroy(new Error('relay-unreachable'));
          return;
        }
        text += part;
      });
      stream.once('end', () => {
        try {
          const value = JSON.parse(text);
          if (accepted && value && typeof value === 'object' && Object.keys(value).length === 2
            && typeof value.code === 'string' && /^[A-Za-z0-9_-]{32}$/.test(value.code)
            && Number.isSafeInteger(value.expiresInSeconds) && value.expiresInSeconds > 0 && value.expiresInSeconds <= 600) {
            resolve({ code: value.code, expiresInSeconds: value.expiresInSeconds });
          } else reject(new Error('relay-unreachable'));
        } catch { reject(new Error('relay-unreachable')); }
      });
    });
    stream.end();
    return await response;
  } finally {
    signal.removeEventListener('abort', cancel);
    stream.destroy();
    await closed;
  }
}

/** Explicit opt-in runtime adapter. No machine identity is created and no
 * listener is opened. The supplied port belongs to the runtime TLS endpoint. */
export function startHostedRelayRuntime(options: {
  enabled: boolean;
  stateDir: string;
  hostname: string;
  assignment: string;
  localTlsPort: number;
  signal: AbortSignal;
  /** Read the boot-owned committed store, never the coordinator effective view. */
  readCommittedLease(): LeaseRecord | undefined;
  /** The coordinator may already know of lease loss before the store catches up. */
  holdsLocalAuthority(): boolean;
  connectVerified: ReconnectOptions['connectVerified'];
}) {
  if (!options.enabled || options.signal.aborted) return undefined;
  const { hostname, assignment, localTlsPort } = options;
  if (normalizeHostedRelayHostname(hostname) !== hostname || !/^[a-f0-9]{64}$/.test(assignment)) {
    throw new Error('invalid-relay-runtime-assignment');
  }
  if (!Number.isInteger(localTlsPort) || localTlsPort < 1 || localTlsPort > 65535) {
    throw new Error('invalid-relay-local-tls-port');
  }
  const identity = new MachineIdentityManager(options.stateDir);
  const { machineId: holder } = identity.loadIdentity();
  const loadedPublicKey = identity.getSigningPublicKeyPem(holder);
  if (!loadedPublicKey) throw new Error('relay-machine-signing-key-unavailable');
  const publicKey = loadedPublicKey;
  const scope = { hostname, assignment, holder };
  function currentLease(): HostedRelayLease | undefined {
    try {
      if (!options.holdsLocalAuthority()) return undefined;
      const lease = options.readCommittedLease();
      if (!lease || lease.released || lease.holder !== holder
        || !Number.isSafeInteger(lease.epoch) || lease.epoch < 1
        || !verify(FencedLease.canonicalize(lease), lease.signature, publicKey)) return undefined;
      const expiresAt = Date.parse(lease.expiresAt);
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return undefined;
      return { ...scope, epoch: lease.epoch, expiresAt };
    } catch { return undefined; } // @silent-fallback-ok — absence of committed authority closes relay access
  }
  let admitted: { session: ClientHttp2Session; lease: HostedRelayLease; signal: AbortSignal; issuing: boolean } | undefined;
  function liveAdmission() {
    const entry = admitted;
    if (!entry || entry.signal.aborted || entry.session.closed || entry.session.destroyed) return undefined;
    const latest = currentLease();
    if (admitted !== entry || entry.signal.aborted
      || latest?.epoch !== entry.lease.epoch || latest.expiresAt !== entry.lease.expiresAt) return undefined;
    return entry;
  }
  const closed = runHostedRelayReconnect({
    scope, signal: options.signal, currentLease, connectVerified: options.connectVerified,
    sign: message => sign(message, identity.loadSigningKey()),
    openLocalTls: () => connect(localTlsPort, '127.0.0.1'),
    onAdmission(session, lease, signal) {
      const entry = { session, lease, signal, issuing: false };
      admitted = entry;
      signal.addEventListener('abort', () => { if (admitted === entry) admitted = undefined; }, { once: true });
    },
  });
  return {
    available: () => !!liveAdmission(),
    async issuePairingCode(): Promise<Code> {
      const entry = liveAdmission();
      if (!entry) throw new Error('relay-unavailable');
      if (entry.issuing) throw new Error('relay-busy');
      entry.issuing = true;
      try {
        const result = await requestCode(entry.session, AbortSignal.any([entry.signal, AbortSignal.timeout(5000)]));
        if (liveAdmission() !== entry) throw new Error('relay-unavailable');
        return result;
      } catch (error) {
        if (liveAdmission() !== entry) throw new Error('relay-unavailable');
        throw error;
      } finally {
        entry.issuing = false;
      }
    },
    closed,
  };
}
