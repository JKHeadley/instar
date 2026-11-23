import net from 'node:net';
import { CAPACITY_CAUSES } from './OriginCapacityEvidence.js';
import { chmodSync, lstatSync } from 'node:fs';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';
import type { TelegramOriginOutageNotifier, OutageNoticeState } from './TelegramOriginOutageNotifier.js';
import type { OriginCapacityAuthority, OriginCapacityGrant, OriginCapacityRefusal, OriginCapacityRefusalCause } from './OriginEgressCapacity.js';

/** Same-OS-principal IPC. The filesystem-protected local socket exposes fixed
 * notice triggers/readback and bounded credential capacity grants. It never
 * accepts message content, notice permits, credentials or origin claims.
 */
export async function listenOriginNotices(socketPath: string, notifier: TelegramOriginOutageNotifier,
  authorizedIds: () => string[], capacity?: OriginCapacityAuthority): Promise<() => Promise<void>> {
  // A hard-killed process can leave its socket pathname behind. Only an
  // explicit connection refusal permits removing it; a live or indeterminate
  // owner is never displaced and no old notice permit is transferred.
  let stale = false;
  try {
    if (!lstatSync(socketPath).isSocket()) throw new Error('origin-notice: occupied non-socket path');
    stale = await new Promise<boolean>(resolve => {
      const probe = net.createConnection(socketPath);
      const timer = setTimeout(() => { probe.destroy(); resolve(false); }, 250);
      probe.once('connect', () => { clearTimeout(timer); probe.destroy(); resolve(false); });
      probe.once('error', error => { clearTimeout(timer); probe.destroy(); resolve((error as NodeJS.ErrnoException).code === 'ECONNREFUSED'); });
    });
    if (!stale) throw new Error('origin-notice: another owner is live or unverifiable');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (stale) SafeFsExecutor.safeUnlinkSync(socketPath, { operation: 'telegram-origin.stale-notice-socket' });
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    if (sockets.size >= 32) { socket.destroy(); return; }
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy()); socket.setTimeout(1000, () => socket.destroy());
    let buffer = '';
    socket.on('data', async bytes => {
      buffer += bytes.toString('utf8');
      if (Buffer.byteLength(buffer) > 1024) { socket.destroy(); return; }
      if (!buffer.endsWith('\n')) return;
      socket.removeAllListeners('data');
      try {
        const input = JSON.parse(buffer);
        if (capacity && input?.op === 'capacity-reserve' && Object.keys(input).sort().join(',') === 'accountId,op' &&
          typeof input.accountId === 'string' && input.accountId.length <= 128) {
          const decision = capacity.reserveExplained ? await capacity.reserveExplained(input.accountId) : { grant: await capacity.reserve(input.accountId) };
          socket.end(JSON.stringify(decision) + '\n'); return;
        }
        if (capacity && input?.op === 'capacity-consume' && Object.keys(input).sort().join(',') === 'grant,op' &&
          validCapacityGrant(input.grant)) {
          const decision = capacity.consumeExplained ? await capacity.consumeExplained(input.grant) : { consumed: await capacity.consume(input.grant) };
          socket.end(JSON.stringify(decision) + '\n'); return;
        }
        if (!input || Object.keys(input).sort().join(',') !== 'destinationId,op' ||
          !['request', 'status'].includes(input.op) || !authorizedIds().includes(input.destinationId)) {
          socket.end('{"error":"invalid-notice-request"}\n'); return;
        }
        const state = input.op === 'request' ? notifier.requestHoldNotice(input.destinationId) : notifier.getState(input.destinationId);
        socket.end(JSON.stringify(state) + '\n');
      } catch { socket.end('{"error":"invalid-notice-request"}\n'); }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      try { chmodSync(socketPath, 0o600); resolve(); }
      catch (error) { server.close(); reject(error); }
    });
  });
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
}
function validCapacityGrant(value: unknown): value is OriginCapacityGrant {
  if (!value || typeof value !== 'object') return false;
  const v = value as OriginCapacityGrant;
  return Object.keys(v).sort().join(',') === 'accountId,expiresAt,nonce,ownerBootId' &&
    ['accountId', 'nonce', 'ownerBootId'].every(key => typeof v[key as keyof OriginCapacityGrant] === 'string' &&
      String(v[key as keyof OriginCapacityGrant]).length > 0 && String(v[key as keyof OriginCapacityGrant]).length <= 128) &&
    Number.isSafeInteger(v.expiresAt);
}
/** Nonwaiting reservations share the fixed owner's socket and bounded request
 * budget; no body, token or origin claim crosses this interface. */
function parsedRefusal(value: unknown, stage: 'reserve' | 'consume'): OriginCapacityRefusal | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as OriginCapacityRefusal;
  const liveness = ['owner-closed', 'owner-not-ready', 'lease-not-held', 'account-unknown', 'owner-check-failed'];
  const allowed = stage === 'reserve' ? [...liveness, 'rate-window-full']
    : [...liveness, 'grant-expired', 'wrong-owner', 'unknown-grant', 'already-consumed', 'grant-mismatch', 'consume-refused'];
  if (Object.keys(v).sort().join(',') !== 'cause,leaseFreshness' || !CAPACITY_CAUSES.includes(v.cause) || !allowed.includes(v.cause)) return null;
  const f = v.leaseFreshness;
  if (f !== null) {
    if (!f || typeof f !== 'object' || Object.keys(f).sort().join(',') !== 'msSinceConfirmedRenewal,ttlMs,verdict' ||
      !['holding', 'suspended', 'not-current-holder', 'renewal-lapsed', 'superseded'].includes(f.verdict) ||
      !Number.isSafeInteger(f.ttlMs) || f.ttlMs < 0 ||
      !(f.msSinceConfirmedRenewal === null || Number.isFinite(f.msSinceConfirmedRenewal) && f.msSinceConfirmedRenewal >= 0)) return null;
  }
  if (v.cause === 'lease-not-held' && f?.verdict === 'holding') return null;
  if (v.cause !== 'lease-not-held' && f !== null) return null;
  return { cause: v.cause, leaseFreshness: f === null ? null : { ...f } };
}
class CapacityIpcError extends Error { constructor(readonly cause: OriginCapacityRefusalCause) { super(cause); } }
export function originCapacityClient(socketPath: string): OriginCapacityAuthority {
  const call = (input: object): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath); let buffer = '', settled = false;
    const finish = (value?: Record<string, unknown>, cause?: OriginCapacityRefusalCause) => {
      if (settled) return; settled = true; clearTimeout(timer); socket.destroy();
      if (cause) reject(new CapacityIpcError(cause)); else resolve(value!);
    };
    const timer = setTimeout(() => finish(undefined, 'ipc-timeout'), 1000);
    socket.once('error', () => finish(undefined, 'ipc-unavailable'));
    socket.once('close', () => { if (!settled) finish(undefined, 'ipc-unavailable'); });
    socket.once('connect', () => socket.write(JSON.stringify(input) + '\n'));
    socket.on('data', bytes => { buffer += bytes.toString('utf8'); if (Buffer.byteLength(buffer) > 1024) finish(undefined, 'ipc-protocol'); });
    socket.once('end', () => { try {
      const value: unknown = JSON.parse(buffer);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return finish(undefined, 'ipc-protocol');
      finish(value as Record<string, unknown>);
    } catch { finish(undefined, 'ipc-protocol'); } });
  });
  const no = (cause: OriginCapacityRefusalCause): OriginCapacityRefusal => ({ cause, leaseFreshness: null });
  const quality = (r: Record<string, unknown>, positive: boolean, stage: 'reserve' | 'consume') => {
    if (!Object.hasOwn(r, 'refusal')) return { refusal: positive ? null : no('legacy-unexplained'), explanation: 'legacy-unexplained' as const };
    if (positive) return { refusal: null, explanation: r.refusal === null ? 'complete' as const : 'invalid' as const };
    const refusal = parsedRefusal(r.refusal, stage);
    return { refusal: refusal ?? no('legacy-unexplained'), explanation: refusal ? 'complete' as const : 'invalid' as const };
  };
  const client: OriginCapacityAuthority = {
    diagnosticTransport: 'ipc',
    reserve: async accountId => (await client.reserveExplained!(accountId)).grant,
    consume: async grant => (await client.consumeExplained!(grant)).consumed,
    reserveExplained: async accountId => {
      try {
        const r = await call({ op: 'capacity-reserve', accountId });
        if (r.grant !== null && (!validCapacityGrant(r.grant) || r.grant.accountId !== accountId)) throw new CapacityIpcError('ipc-protocol');
        if (r.grant === null) return { grant: null, ...quality(r, false, 'reserve') } as import('./OriginEgressCapacity.js').OriginCapacityDecision;
        return { grant: r.grant as OriginCapacityGrant, refusal: null, explanation: quality(r, true, 'reserve').explanation };
      } catch (e) { return { grant: null, refusal: no(e instanceof CapacityIpcError ? e.cause : 'ipc-unavailable') }; }
    },
    consumeExplained: async grant => {
      try {
        const r = await call({ op: 'capacity-consume', grant });
        if (typeof r.consumed !== 'boolean') throw new CapacityIpcError('ipc-protocol');
        return { consumed: r.consumed, ...quality(r, r.consumed, 'consume') };
      } catch (e) { return { consumed: false, refusal: no(e instanceof CapacityIpcError ? e.cause : 'ipc-unavailable') }; }
    },
  };
  return client;
}

export async function callOriginNotice(socketPath: string, destinationId: string,
  op: 'request' | 'status'): Promise<OutageNoticeState> {
  if (destinationId.length > 256) throw new Error('origin-notice: invalid destination');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath); let buffer = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('origin-notice: IPC timeout')); }, 1000);
    socket.once('error', () => { clearTimeout(timer); reject(new Error('origin-notice: IPC unavailable')); });
    socket.once('connect', () => socket.write(JSON.stringify({ destinationId, op }) + '\n'));
    socket.on('data', bytes => {
      buffer += bytes.toString('utf8');
      if (Buffer.byteLength(buffer) > 4096) socket.destroy(new Error('origin-notice: IPC response too large'));
    });
    socket.once('end', () => {
      clearTimeout(timer); socket.destroy();
      try {
        const result = JSON.parse(buffer) as OutageNoticeState;
        if (result.alertDestinationId !== destinationId || typeof result.notificationAttempted !== 'boolean') throw new Error('invalid response');
        resolve(result);
      } catch { reject(new Error('origin-notice: invalid IPC response')); }
    });
  });
}
