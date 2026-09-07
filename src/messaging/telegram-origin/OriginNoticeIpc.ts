import net from 'node:net';
import { chmodSync, lstatSync } from 'node:fs';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';
import type { TelegramOriginOutageNotifier, OutageNoticeState } from './TelegramOriginOutageNotifier.js';
import type { OriginCapacityAuthority, OriginCapacityGrant } from './OriginEgressCapacity.js';

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
          socket.end(JSON.stringify({ grant: await capacity.reserve(input.accountId) }) + '\n'); return;
        }
        if (capacity && input?.op === 'capacity-consume' && Object.keys(input).sort().join(',') === 'grant,op' &&
          validCapacityGrant(input.grant)) {
          socket.end(JSON.stringify({ consumed: await capacity.consume(input.grant) }) + '\n'); return;
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
export function originCapacityClient(socketPath: string): OriginCapacityAuthority {
  const call = (input: object): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath); let buffer = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('origin-capacity: IPC timeout')); }, 1000);
    socket.once('error', () => { clearTimeout(timer); reject(new Error('origin-capacity: IPC unavailable')); });
    socket.once('connect', () => socket.write(JSON.stringify(input) + '\n'));
    socket.on('data', bytes => { buffer += bytes.toString('utf8'); if (Buffer.byteLength(buffer) > 1024) socket.destroy(new Error('response too large')); });
    socket.once('end', () => { clearTimeout(timer); socket.destroy(); try { resolve(JSON.parse(buffer)); } catch { reject(new Error('invalid response')); } });
  });
  return {
    reserve: async accountId => {
      try { const result = await call({ op: 'capacity-reserve', accountId });
        return validCapacityGrant(result.grant) && result.grant.accountId === accountId ? result.grant : null;
      } catch { return null; }
    },
    consume: async grant => { try { return (await call({ op: 'capacity-consume', grant })).consumed === true; } catch { return false; } },
  };
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
