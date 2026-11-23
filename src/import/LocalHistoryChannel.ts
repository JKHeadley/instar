/** Purpose-separated selected-history records. This primitive authenticates bytes;
 * it never grants owner permission, establishes target trust or extends a grant.
 * Callers must independently verify the signed handshake and current admission.
 */
import crypto from 'node:crypto';
import { CHUNK_BYTES } from '../core/appMediaTypes.js';

export const LOCAL_HISTORY_WIRE_BYTES = CHUNK_BYTES;
export const LOCAL_HISTORY_PLAINTEXT_BYTES = LOCAL_HISTORY_WIRE_BYTES - 24;
const MAX_SEQUENCE = (1n << 64n) - 1n;
export interface LocalHistoryChannelScope {
  channelId: string;
  machineId: string;
  bootId: string;
  deviceKeyHash: string;
}
export interface LocalHistoryChannelRoute { method: 'GET' | 'POST' | 'PUT'; path: string }
type Direction = 'request' | 'response';
type Pending = { kind: 'sent' | 'received'; sequence: bigint; route: LocalHistoryChannelRoute };

export class LocalHistoryChannel {
  private readonly requestKey: Buffer;
  private readonly responseKey: Buffer;
  private readonly scope: Readonly<LocalHistoryChannelScope>;
  private next = 1n;
  private pending: Pending | undefined;
  private disposed = false;

  constructor(keys: { request: Buffer; response: Buffer }, scope: LocalHistoryChannelScope,
    private readonly role: 'client' | 'server') {
    if (role !== 'client' && role !== 'server') throw new Error('local-history-channel-invalid-role');
    if (keys.request.length !== 32 || keys.response.length !== 32 || keys.request.equals(keys.response)) {
      throw new Error('local-history-channel-invalid-key');
    }
    for (const field of ['channelId', 'machineId', 'bootId', 'deviceKeyHash'] as const) {
      if (typeof scope[field] !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(scope[field])) {
        throw new Error('local-history-channel-invalid-scope');
      }
    }
    this.requestKey = Buffer.from(keys.request);
    this.responseKey = Buffer.from(keys.response);
    this.scope = Object.freeze({ channelId: scope.channelId, machineId: scope.machineId,
      bootId: scope.bootId, deviceKeyHash: scope.deviceKeyHash });
  }

  sealRequest(plaintext: Buffer, route: LocalHistoryChannelRoute): Buffer {
    this.assertActive();
    if (this.role !== 'client') throw new Error('local-history-channel-role');
    if (this.pending || this.next > MAX_SEQUENCE) throw new Error('local-history-channel-busy-or-exhausted');
    const canonical = this.route(route);
    const record = this.seal(plaintext, 'request', this.next, canonical);
    this.pending = { kind: 'sent', sequence: this.next++, route: canonical };
    return record;
  }

  openRequest(record: Buffer, route: LocalHistoryChannelRoute): Buffer {
    this.assertActive();
    if (this.role !== 'server') throw new Error('local-history-channel-role');
    if (this.pending || this.next > MAX_SEQUENCE) throw new Error('local-history-channel-busy-or-exhausted');
    const canonical = this.route(route);
    const plaintext = this.open(record, 'request', this.next, canonical);
    // Synchronous authentication and consumption precede any caller dispatch.
    this.pending = { kind: 'received', sequence: this.next++, route: canonical };
    return plaintext;
  }

  sealResponse(plaintext: Buffer, route: LocalHistoryChannelRoute): Buffer {
    this.assertActive();
    if (this.role !== 'server') throw new Error('local-history-channel-role');
    const pending = this.requirePending('received', route);
    const record = this.seal(plaintext, 'response', pending.sequence, pending.route);
    this.pending = undefined; // A different response may never reuse this nonce.
    return record;
  }

  openResponse(record: Buffer, route: LocalHistoryChannelRoute): Buffer {
    this.assertActive();
    if (this.role !== 'client') throw new Error('local-history-channel-role');
    const pending = this.requirePending('sent', route);
    const plaintext = this.open(record, 'response', pending.sequence, pending.route);
    this.pending = undefined;
    return plaintext;
  }

  dispose(): void {
    this.requestKey.fill(0);
    this.responseKey.fill(0);
    this.pending = undefined;
    this.disposed = true;
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('local-history-channel-disposed');
  }

  private route(route: LocalHistoryChannelRoute): LocalHistoryChannelRoute {
    if (!['GET', 'POST', 'PUT'].includes(route.method)
      || !/^\/mobile\/imported-history\/local(?:\/[A-Za-z0-9_-]+)*$/.test(route.path)
      || route.path.length > 1024) throw new Error('local-history-channel-invalid-route');
    return { method: route.method, path: route.path };
  }

  private requirePending(kind: Pending['kind'], route: LocalHistoryChannelRoute): Pending {
    const canonical = this.route(route);
    if (!this.pending || this.pending.kind !== kind || this.pending.route.method !== canonical.method
      || this.pending.route.path !== canonical.path) throw new Error('local-history-channel-no-matching-request');
    return this.pending;
  }

  private nonce(direction: Direction, sequence: bigint): Buffer {
    const nonce = Buffer.alloc(12);
    nonce.writeUInt32BE(direction === 'request' ? 1 : 2, 0);
    nonce.writeBigUInt64BE(sequence, 4);
    return nonce;
  }

  private aad(direction: Direction, sequence: bigint, route: LocalHistoryChannelRoute): Buffer {
    return Buffer.from(JSON.stringify(['instar-local-history-channel-v1', this.scope.channelId,
      this.scope.machineId, this.scope.bootId, this.scope.deviceKeyHash, direction,
      route.method, route.path, sequence.toString()]));
  }

  private seal(plaintext: Buffer, direction: Direction, sequence: bigint, route: LocalHistoryChannelRoute): Buffer {
    if (plaintext.length > LOCAL_HISTORY_PLAINTEXT_BYTES) throw new Error('local-history-channel-size');
    const cipher = crypto.createCipheriv('aes-256-gcm', direction === 'request' ? this.requestKey : this.responseKey,
      this.nonce(direction, sequence));
    cipher.setAAD(this.aad(direction, sequence, route));
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const header = Buffer.alloc(8);
    header.writeBigUInt64BE(sequence);
    return Buffer.concat([header, encrypted, cipher.getAuthTag()]);
  }

  private open(record: Buffer, direction: Direction, sequence: bigint, route: LocalHistoryChannelRoute): Buffer {
    if (record.length < 24 || record.length > LOCAL_HISTORY_WIRE_BYTES) throw new Error('local-history-channel-size');
    if (record.readBigUInt64BE(0) !== sequence) throw new Error('local-history-channel-sequence');
    const decipher = crypto.createDecipheriv('aes-256-gcm', direction === 'request' ? this.requestKey : this.responseKey,
      this.nonce(direction, sequence));
    decipher.setAAD(this.aad(direction, sequence, route));
    decipher.setAuthTag(record.subarray(record.length - 16));
    let partial: Buffer | undefined;
    let final: Buffer | undefined;
    try {
      partial = decipher.update(record.subarray(8, record.length - 16));
      final = decipher.final();
      return Buffer.concat([partial, final]);
    } catch {
      throw new Error('local-history-channel-authentication');
    } finally {
      partial?.fill(0);
      final?.fill(0);
    }
  }
}
