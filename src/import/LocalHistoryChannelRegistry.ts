/** In-memory lifecycle for target-authenticated private channels. Device
 * signatures and importer exchange admission MUST precede this registry's
 * dispatch. It grants no upload/copy authority and mounts no HTTP endpoint.
 */
import { LocalHistoryChannel, type LocalHistoryChannelRoute } from './LocalHistoryChannel.js';
import { createLocalHistoryHandshake, type LocalHistoryHandshakeGrant, type LocalHistoryHandshakeRequest } from './LocalHistoryHandshake.js';

export interface LocalHistoryAuthenticatedDevice { deviceId: string; deviceKeyHash: string }
export interface LocalHistoryChannelPrincipal extends LocalHistoryAuthenticatedDevice { ownerUserId: string }
export interface LocalHistoryChannelIssuer { agentId: string; machineId: string; bootId: string; signingKeyHash: string }
export interface LocalHistoryChannelRegistryDeps {
  /** Real current unique native-owner resolution, never a body role or bearer. */
  principal(device: Readonly<LocalHistoryAuthenticatedDevice>): LocalHistoryChannelPrincipal | null;
  issuer(): LocalHistoryChannelIssuer;
  sign(bytes: Buffer): string;
  now?: () => number;
  capacity?: number;
}
export interface LocalHistoryChannelExchange {
  readonly plaintext: Buffer;
  readonly signal: AbortSignal;
  sealResponse(plaintext: Buffer): Buffer;
  /** Call only after owned request/response buffers and transport are disposed. */
  close(): void;
}
export class LocalHistoryChannelRegistryRefused extends Error {
  constructor(readonly reason: 'unavailable' | 'busy' | 'capacity' | 'invalid') { super('local-history-channel-' + reason); }
}
interface Entry {
  grant: LocalHistoryHandshakeGrant;
  principal: Readonly<LocalHistoryChannelPrincipal>;
  issuer: Readonly<LocalHistoryChannelIssuer>;
  channel: LocalHistoryChannel;
  issuedAt: number;
  active: boolean;
  inFlight: boolean;
  disposed: boolean;
  abort: AbortController;
  timer: ReturnType<typeof setTimeout>;
}
function refuse(reason: LocalHistoryChannelRegistryRefused['reason']): never { throw new LocalHistoryChannelRegistryRefused(reason); }
const samePrincipal = (a: LocalHistoryChannelPrincipal, b: LocalHistoryChannelPrincipal) =>
  a.ownerUserId === b.ownerUserId && a.deviceId === b.deviceId && a.deviceKeyHash === b.deviceKeyHash;
const sameIssuer = (a: LocalHistoryChannelIssuer, b: LocalHistoryChannelIssuer) =>
  a.agentId === b.agentId && a.machineId === b.machineId && a.bootId === b.bootId && a.signingKeyHash === b.signingKeyHash;

export class LocalHistoryChannelRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly currentDevice = new Map<string, string>();
  private readonly now: () => number;
  private readonly capacity: number;
  private stopped = false;
  private issuing = false;
  constructor(private readonly deps: LocalHistoryChannelRegistryDeps) {
    if (![deps?.principal, deps?.issuer, deps?.sign].every(value => typeof value === 'function')) refuse('invalid');
    this.now = deps.now ?? Date.now;
    this.capacity = deps.capacity ?? 32;
    if (typeof this.now !== 'function' || !Number.isSafeInteger(this.capacity) || this.capacity < 1 || this.capacity > 128) refuse('invalid');
  }
  private clock(): number {
    let now: number;
    try { now = this.now(); } catch { return refuse('unavailable'); }
    if (!Number.isSafeInteger(now) || now < 0) refuse('unavailable');
    return now;
  }
  private scope(device: LocalHistoryAuthenticatedDevice): { principal: Readonly<LocalHistoryChannelPrincipal>; issuer: Readonly<LocalHistoryChannelIssuer> } {
    if (this.stopped || !device || typeof device.deviceId !== 'string' || !device.deviceId || typeof device.deviceKeyHash !== 'string' || !device.deviceKeyHash) refuse('unavailable');
    try {
      const found = this.deps.principal(Object.freeze({ deviceId: device.deviceId, deviceKeyHash: device.deviceKeyHash }));
      const issuer = this.deps.issuer();
      if (!found || found.deviceId !== device.deviceId || found.deviceKeyHash !== device.deviceKeyHash
        || typeof found.ownerUserId !== 'string' || !found.ownerUserId.trim() || found.ownerUserId.includes('\0')
        || Buffer.byteLength(found.ownerUserId) > 256 || !issuer || !/^[a-f0-9]{64}$/.test(issuer.signingKeyHash)
        || !['agentId', 'machineId', 'bootId'].every(field => typeof issuer[field as keyof LocalHistoryChannelIssuer] === 'string'
          && /^[\x21-\x7e]{1,256}$/.test(issuer[field as keyof LocalHistoryChannelIssuer]))) refuse('unavailable');
      return { principal: Object.freeze({ ownerUserId: found.ownerUserId, deviceId: found.deviceId, deviceKeyHash: found.deviceKeyHash }),
        issuer: Object.freeze({ agentId: issuer.agentId, machineId: issuer.machineId, bootId: issuer.bootId, signingKeyHash: issuer.signingKeyHash }) };
    } catch { return refuse('unavailable'); }
  }
  issue(device: LocalHistoryAuthenticatedDevice, request: LocalHistoryHandshakeRequest): LocalHistoryHandshakeGrant {
    if (this.issuing) refuse('busy');
    this.issuing = true;
    try { return this.issueReserved(device, request); }
    finally { this.issuing = false; }
  }
  private issueReserved(device: LocalHistoryAuthenticatedDevice, request: LocalHistoryHandshakeRequest): LocalHistoryHandshakeGrant {
    const scope = this.scope(device), now = this.clock();
    const old = this.currentDevice.get(scope.principal.deviceId);
    const oldEntry = old ? this.entries.get(old) : undefined;
    // Reserve an additional retained slot, or atomically replace an idle slot,
    // BEFORE ECDH/signing. No await or reentrant issuance can steal this slot.
    const replaceable = oldEntry && !oldEntry.inFlight ? 1 : 0;
    if (this.entries.size - replaceable >= this.capacity) refuse('capacity');
    let created: ReturnType<typeof createLocalHistoryHandshake>;
    try { created = createLocalHistoryHandshake(request, { ...scope.issuer, deviceId: scope.principal.deviceId,
      deviceKeyHash: scope.principal.deviceKeyHash }, this.deps.sign, now); }
    catch { return refuse('invalid'); }
    try {
      const afterSigning = this.clock();
      if (afterSigning < now || afterSigning >= created.grant.expiresAt) refuse('unavailable');
      if (old) this.invalidate(old);
      const current = this.scope(device);
      if (!samePrincipal(scope.principal, current.principal) || !sameIssuer(scope.issuer, current.issuer)) refuse('unavailable');
      // Abort callbacks can close/stop; do not publish after their invalidation.
      if (this.entries.size >= this.capacity) refuse('capacity');
      const { grant, keys } = created;
      const publicationNow = this.clock();
      if (publicationNow < afterSigning || publicationNow >= grant.expiresAt) refuse('unavailable');
      const channel = new LocalHistoryChannel(keys, { channelId: grant.channelId, machineId: grant.machineId,
        bootId: grant.bootId, deviceKeyHash: grant.deviceKeyHash }, 'server');
      const timer = setTimeout(() => this.invalidate(grant.channelId), grant.expiresAt - publicationNow);
      timer.unref();
      const entry: Entry = { grant: Object.freeze({ ...grant }), principal: scope.principal, issuer: scope.issuer,
        channel, issuedAt: now, active: true, inFlight: false, disposed: false, abort: new AbortController(), timer };
      this.entries.set(grant.channelId, entry);
      this.currentDevice.set(scope.principal.deviceId, grant.channelId);
      return { ...grant };
    } finally { created.keys.request.fill(0); created.keys.response.fill(0); }
  }
  private current(entry: Entry): void {
    let authorized = false;
    try {
      const scope = this.scope(entry.principal), now = this.clock();
      authorized = entry.active && !entry.disposed && now >= entry.issuedAt && now < entry.grant.expiresAt
        && this.currentDevice.get(entry.principal.deviceId) === entry.grant.channelId
        && samePrincipal(scope.principal, entry.principal) && sameIssuer(scope.issuer, entry.issuer);
    } catch { /* finite fail-closed refusal below */ }
    if (!authorized) { this.invalidate(entry.grant.channelId); refuse('unavailable'); }
  }
  open(device: LocalHistoryAuthenticatedDevice, channelId: string, route: LocalHistoryChannelRoute, record: Buffer): LocalHistoryChannelExchange {
    const entry = this.entries.get(channelId);
    // Foreign IDs/principals get one refusal shape and cannot invalidate the
    // rightful device's channel. The route must supply an authenticated device.
    if (!entry || entry.principal.deviceId !== device?.deviceId || entry.principal.deviceKeyHash !== device?.deviceKeyHash) refuse('unavailable');
    if (this.issuing) refuse('busy');
    this.current(entry);
    if (entry.inFlight) refuse('busy');
    let plaintext: Buffer;
    try { plaintext = entry.channel.openRequest(record, route); }
    catch { this.invalidate(channelId); return refuse('invalid'); }
    entry.inFlight = true;
    let closed = false, sealed = false;
    let response: Buffer | undefined;
    return {
      plaintext,
      signal: entry.abort.signal,
      sealResponse: bytes => {
        try {
          if (closed || sealed) refuse('invalid');
          this.current(entry);
          try { response = entry.channel.sealResponse(bytes, route); }
          catch { return refuse('invalid'); }
          sealed = true;
          return response;
        } finally { bytes.fill(0); }
      },
      close: () => {
        if (closed) return;
        closed = true;
        plaintext.fill(0); record.fill(0); response?.fill(0);
        entry.inFlight = false;
        if (!sealed) this.invalidate(channelId);
        if (!entry.active) this.dispose(entry);
      },
    };
  }
  invalidateDevice(deviceId: string): void {
    for (const [id, entry] of this.entries) if (entry.principal.deviceId === deviceId) this.invalidate(id);
  }
  private invalidate(channelId: string): void {
    const entry = this.entries.get(channelId);
    if (!entry || entry.disposed) return;
    entry.active = false;
    clearTimeout(entry.timer);
    entry.abort.abort();
    if (!entry.inFlight) this.dispose(entry);
  }
  private dispose(entry: Entry): void {
    if (entry.disposed) return;
    entry.disposed = true;
    entry.channel.dispose();
    this.entries.delete(entry.grant.channelId);
    if (this.currentDevice.get(entry.principal.deviceId) === entry.grant.channelId) this.currentDevice.delete(entry.principal.deviceId);
  }
  stop(): void { this.stopped = true; for (const id of this.entries.keys()) this.invalidate(id); }
  /** Resource observability only; never exposed as another owner's metadata. */
  resources(): { retained: number; active: number; inFlight: number } {
    const rows = [...this.entries.values()];
    return { retained: rows.length, active: rows.filter(row => row.active).length, inFlight: rows.filter(row => row.inFlight).length };
  }
}
