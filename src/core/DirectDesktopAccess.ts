/** Operator-initiated, single-machine remote desktop authority.
 * All requests, grants and tickets are memory-only: a restart revokes access.
 * A PIN session may authorize access directly; the legacy Telegram challenge
 * remains available only when explicitly selected by the caller. */
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { DesktopHost, DesktopInput } from './DesktopHost.js';
import type { RemoteStepUpLockoutPort } from './RemoteStepUpLockouts.js';
import type { DesktopStreamSession } from '../server/DesktopStreamManager.js';
import { DesktopAead, deriveDesktopKey } from './DesktopAead.js';
import type { DesktopAccessAudit } from './DesktopAccessAudit.js';
import { isLoopbackPeer } from './desktopTransport.js';

const CHALLENGE_MS = 2 * 60_000;
const GRANT_MS = 10 * 60_000;
const TICKET_MS = 30_000;
const IDLE_MS = 2 * 60_000;

interface DirectRequest {
  id: string;
  operatorUid: string;
  topicId: number;
  machineId: string;
  machineLabel: string;
  browserPublicKey: string;
  browserEcdhPublicKey: string;
  browserNonce: string;
  operatorSessionHash: string;
  operatorSessionToken?: string;
  codeHash: Buffer;
  createdAt: number;
  status: 'pending' | 'approved' | 'revoked';
  grantId?: string;
  grantSignature?: Buffer;
  targetSignature?: Buffer;
  approvedAt?: number;
  connectionNonce?: string;
  targetEcdhPublicKey?: string;
  salt?: string;
  desktopKey?: Buffer;
  aead?: DesktopAead;
  ticketHash?: string;
  ticketExpiresAt?: number;
  ticketUsed?: boolean;
  connected?: boolean;
  lastActivity?: number;
  inputCount?: number;
}

export interface DirectDesktopRequestInput {
  machineId: string;
  topicId: number;
  operatorUid: string;
  operatorSessionToken: string;
  browserPublicKey: string;
  browserEcdhPublicKey: string;
  browserNonce: string;
  scopeConfirmed: boolean;
}

export interface DesktopTargetIdentity {
  /** DER SPKI Ed25519 public key pinned to this physical machine. */
  publicKey: Buffer;
  sign(payload: Buffer): Buffer;
}

export class DirectDesktopAccess {
  private readonly requests = new Map<string, DirectRequest>();
  private readonly lastRequestAt = new Map<string, number>();
  private readonly keyPair = crypto.generateKeyPairSync('ed25519');
  private activeGrantId: string | null = null;
  private disabled = false;

  constructor(
    private readonly machineId: string,
    private readonly machineLabel: string,
    private readonly host: DesktopHost,
    private readonly lockouts: RemoteStepUpLockoutPort,
    private readonly targetIdentity: DesktopTargetIdentity,
    private readonly isVerifiedOperator: (topicId: number, uid: string) => boolean,
    private readonly isDashboardOperatorSession: (token: string) => boolean,
    private readonly sendChallenge: (topicId: number, text: string) => Promise<void>,
    private readonly closeGrant: (grantId: string) => void,
    private readonly now: () => number = Date.now,
    private readonly audit?: DesktopAccessAudit,
    private readonly approvalMode: 'telegram' | 'pin' = 'telegram',
  ) {}

  requiresTelegramStepUp(): boolean { return this.approvalMode === 'telegram'; }

  targetInfo(): { machineId: string; label: string } {
    return { machineId: this.machineId, label: this.machineLabel };
  }

  private sessionHash(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private assertViewer(row: DirectRequest, token: string): void {
    if (!this.isDashboardOperatorSession(token)
      || !crypto.timingSafeEqual(Buffer.from(this.sessionHash(token)), Buffer.from(row.operatorSessionHash))) {
      throw new Error('dashboard operator session unavailable');
    }
  }

  private signedPayload(row: DirectRequest): Buffer {
    return Buffer.from(JSON.stringify(['direct-desktop-grant-v1', row.grantId, row.id,
      row.operatorUid, row.topicId, row.machineId, row.browserPublicKey,
      row.browserEcdhPublicKey, row.targetEcdhPublicKey, row.salt,
      row.browserNonce, row.approvedAt, (row.approvedAt ?? 0) + GRANT_MS]));
  }

  private targetPayload(row: DirectRequest): Buffer {
    return Buffer.from(JSON.stringify(['desktop-target-key-v1', row.id, row.machineId,
      row.browserPublicKey, row.browserEcdhPublicKey,
      row.targetEcdhPublicKey, row.salt, (row.approvedAt ?? 0) + GRANT_MS]));
  }

  private validGrant(row: DirectRequest): boolean {
    return !this.disabled && row.status === 'approved' && !!row.grantId
      && this.activeGrantId === row.grantId && !!row.grantSignature
      && !!row.approvedAt && this.now() >= row.approvedAt && this.now() < row.approvedAt + GRANT_MS
      && !!row.lastActivity && this.now() - row.lastActivity < IDLE_MS
      && (this.approvalMode === 'pin'
        ? !!row.operatorSessionToken && this.isDashboardOperatorSession(row.operatorSessionToken)
        : this.isVerifiedOperator(row.topicId, row.operatorUid))
      && crypto.verify(null, this.signedPayload(row), this.keyPair.publicKey, row.grantSignature)
      && !!row.targetSignature
      && crypto.verify(null, this.targetPayload(row), crypto.createPublicKey({
        key: this.targetIdentity.publicKey, format: 'der', type: 'spki',
      }), row.targetSignature);
  }

  async probe(): Promise<{ ready: boolean; screenPermission: boolean; inputPermission: boolean; displayCount: number; sessionActive: boolean }> {
    if (this.disabled) return { ready: false, screenPermission: false, inputPermission: false, displayCount: 0, sessionActive: false };
    const state = await this.host.probe();
    return { ...state, ready: state.screenPermission && state.inputPermission && state.displayCount > 0 && state.sessionActive };
  }

  async begin(input: DirectDesktopRequestInput): Promise<{ requestId: string }> {
    if (this.disabled || input.machineId !== this.machineId
      || !this.isDashboardOperatorSession(input.operatorSessionToken)
      || (this.requiresTelegramStepUp() && (input.scopeConfirmed !== true
        || !Number.isSafeInteger(input.topicId) || input.topicId <= 0
        || !/^\d{1,30}$/.test(input.operatorUid)
        || !this.isVerifiedOperator(input.topicId, input.operatorUid)))
      || !/^[A-Za-z0-9_-]{16,128}$/.test(input.browserNonce)) {
      throw new Error(this.requiresTelegramStepUp()
        ? 'verified operator and full desktop confirmation required'
        : 'recent dashboard PIN session required');
    }
    let browserKey: crypto.KeyObject;
    try {
      browserKey = crypto.createPublicKey({ key: Buffer.from(input.browserPublicKey, 'base64'), format: 'der', type: 'spki' });
    } catch { throw new Error('browser key invalid'); }
    if (browserKey.asymmetricKeyType !== 'ed25519') throw new Error('browser key invalid');
    const browserEcdh = Buffer.from(input.browserEcdhPublicKey, 'base64');
    if (browserEcdh.length !== 65 || browserEcdh[0] !== 4) throw new Error('browser ECDH key invalid');
    try {
      const check = crypto.createECDH('prime256v1');
      check.generateKeys();
      check.computeSecret(browserEcdh);
    } catch { throw new Error('browser ECDH key invalid'); }
    if (!(await this.probe()).ready) throw new Error('desktop host is not ready');
    const lockoutKey = this.requiresTelegramStepUp()
      ? `${input.operatorUid}:${input.machineId}`
      : `${this.sessionHash(input.operatorSessionToken)}:${input.machineId}`;
    if (this.requiresTelegramStepUp() && this.lockouts.get(lockoutKey) > this.now()) throw new Error('desktop approval is locked');
    for (const [id, row] of this.requests) {
      if (this.now() - row.createdAt > 60 * 60_000) this.requests.delete(id);
    }
    for (const [key, at] of this.lastRequestAt) {
      if (this.now() - at > 60 * 60_000) this.lastRequestAt.delete(key);
    }
    if (this.requests.size >= 100) throw new Error('desktop request capacity reached');
    const previousRequest = this.lastRequestAt.get(lockoutKey) ?? 0;
    if (this.now() - previousRequest < 10_000) throw new Error('wait before requesting another desktop session');
    for (const [id, row] of this.requests) {
      if (row.operatorSessionHash === this.sessionHash(input.operatorSessionToken)
        && row.machineId === input.machineId && row.status === 'pending') {
        this.requests.delete(id);
      }
    }
    const id = crypto.randomUUID();
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const salt = crypto.randomBytes(32);
    const digest = crypto.createHash('sha256').update(salt).update(code).digest();
    const row: DirectRequest = {
      id, operatorUid: this.requiresTelegramStepUp() ? input.operatorUid
        : `dashboard-pin:${this.sessionHash(input.operatorSessionToken).slice(0, 16)}`,
      topicId: this.requiresTelegramStepUp() ? input.topicId : 0, machineId: input.machineId,
      machineLabel: this.machineLabel, browserPublicKey: input.browserPublicKey,
      browserEcdhPublicKey: input.browserEcdhPublicKey,
      browserNonce: input.browserNonce, operatorSessionHash: this.sessionHash(input.operatorSessionToken),
      operatorSessionToken: this.requiresTelegramStepUp() ? undefined : input.operatorSessionToken,
      codeHash: Buffer.concat([salt, digest]), createdAt: this.now(), status: 'pending',
    };
    this.requests.set(id, row);
    this.lastRequestAt.set(lockoutKey, this.now());
    if (!this.requiresTelegramStepUp()) {
      if (!this.approveRow(row)) { this.requests.delete(id); throw new Error('desktop grant unavailable'); }
      return { requestId: id };
    }
    try {
      // The code is delivered to the already verified operator's private DM.
      // The caller must use an unlogged send path; the reply is intercepted
      // before normal Telegram message history.
      if (!this.isVerifiedOperator(input.topicId, input.operatorUid)) throw new Error('operator binding changed');
      await this.sendChallenge(input.topicId,
        `Remote desktop request for ${this.machineLabel}. This grants full human control of the logged-in desktop for up to 10 minutes. Target key fingerprint: ${crypto.createHash('sha256').update(this.targetIdentity.publicKey).digest('hex').slice(0, 32)}. In your verified Instar Telegram topic ${input.topicId}, reply exactly:\n/desktop ${id} ${code}\nExpires in 2 minutes. Do not share this code.`);
    } catch (error) { this.requests.delete(id); throw error; }
    return { requestId: id };
  }

  /** Must be called only from TelegramAdapter after its authenticated sender check. */
  acceptAuthenticatedTelegramReply(input: { requestId: string; code: string; topicId: number; senderUid: string }): boolean {
    const row = this.requests.get(input.requestId);
    if (!row || row.status !== 'pending' || this.disabled) return false;
    if (row.topicId !== input.topicId || row.operatorUid !== input.senderUid
      || !this.isVerifiedOperator(row.topicId, row.operatorUid)) return false;
    const lockoutKey = `${row.operatorUid}:${row.machineId}`;
    if (this.lockouts.get(lockoutKey) > this.now()) return false;
    if (this.now() < row.createdAt || this.now() - row.createdAt > CHALLENGE_MS) {
      row.status = 'revoked'; return false;
    }
    const candidate = crypto.createHash('sha256').update(row.codeHash.subarray(0, 32)).update(input.code).digest();
    if (!/^\d{6}$/.test(input.code) || !crypto.timingSafeEqual(candidate, row.codeHash.subarray(32))) {
      try {
        const failure = this.lockouts.recordFailure(lockoutKey, this.now());
        if (failure.attempts >= 3) row.status = 'revoked';
      } catch { this.disabled = true; /* @silent-fallback-ok — lockout storage failed; disable all desktop admission. */ }
      return false;
    }
    return this.approveRow(row);
  }

  private approveRow(row: DirectRequest): boolean {
    if (this.activeGrantId) {
      const active = [...this.requests.values()].find(other => other.grantId === this.activeGrantId);
      if (active && this.validGrant(active)) return false;
      if (active) this.revokeRow(active);
    }
    // A Telegram code is consumed by changing the row state before signing.
    try {
      row.status = 'approved';
      row.grantId = crypto.randomUUID();
      row.approvedAt = this.now();
      row.lastActivity = row.approvedAt;
      row.connectionNonce = crypto.randomBytes(24).toString('base64url');
      const ecdh = deriveDesktopKey(Buffer.from(row.browserEcdhPublicKey, 'base64'), row.id, row.machineId);
      row.desktopKey = ecdh.key;
      row.targetEcdhPublicKey = ecdh.targetPublicKey.toString('base64');
      row.salt = ecdh.salt.toString('base64');
      row.aead = new DesktopAead(ecdh.key, row.id);
      row.grantSignature = crypto.sign(null, this.signedPayload(row), this.keyPair.privateKey);
      row.targetSignature = this.targetIdentity.sign(this.targetPayload(row));
      this.activeGrantId = row.grantId;
      return true;
    } catch {
      this.revokeRow(row);
      return false;
    }
  }

  status(requestId: string, operatorSessionToken: string): {
    status: string; connectionNonce?: string; targetEcdhPublicKey?: string; salt?: string;
    targetSigningPublicKey?: string; targetSignature?: string; machineId?: string; expiresAt?: number;
  } {
    const row = this.requests.get(requestId);
    if (!row) throw new Error('desktop request unavailable');
    this.assertViewer(row, operatorSessionToken);
    if (row.status === 'pending' && this.now() - row.createdAt >= CHALLENGE_MS) row.status = 'revoked';
    if (row.status === 'approved' && !this.validGrant(row)) this.revokeRow(row);
    return row.status === 'approved'
      ? { status: 'approved', connectionNonce: row.connectionNonce,
        targetEcdhPublicKey: row.targetEcdhPublicKey, salt: row.salt,
        targetSigningPublicKey: this.targetIdentity.publicKey.toString('base64'),
        targetSignature: row.targetSignature?.toString('base64'), machineId: row.machineId,
        expiresAt: (row.approvedAt ?? 0) + GRANT_MS }
      : { status: row.status };
  }

  async cursor(requestId: string, operatorSessionToken: string): Promise<{ x: number; y: number }> {
    const row = this.requests.get(requestId);
    if (!row) throw new Error('desktop request unavailable');
    this.assertViewer(row, operatorSessionToken);
    if (!this.validGrant(row) || !this.host.cursor) throw new Error('desktop cursor unavailable');
    const point = await this.host.cursor();
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)
      || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1
      || !this.validGrant(row)) throw new Error('desktop cursor unavailable');
    return point;
  }

  ticket(requestId: string, operatorSessionToken: string, nonce: string, signature: string): string {
    const row = this.requests.get(requestId);
    if (!row) throw new Error('desktop request unavailable');
    this.assertViewer(row, operatorSessionToken);
    if (!this.validGrant(row) || row.connected || row.ticketHash || nonce !== row.connectionNonce) {
      throw new Error('desktop grant or browser challenge unavailable');
    }
    let browserProofValid = false;
    try {
      const browserKey = crypto.createPublicKey({ key: Buffer.from(row.browserPublicKey, 'base64'), format: 'der', type: 'spki' });
      const payload = Buffer.from(JSON.stringify(['desktop-browser-possession-v1', row.id, nonce]));
      browserProofValid = browserKey.asymmetricKeyType === 'ed25519'
        && crypto.verify(null, payload, browserKey, Buffer.from(signature, 'base64'));
    } catch { browserProofValid = false; }
    if (!browserProofValid) throw new Error('browser possession proof invalid');
    const ticket = crypto.randomBytes(32).toString('base64url');
    row.ticketHash = this.sessionHash(ticket);
    row.ticketExpiresAt = this.now() + TICKET_MS;
    return ticket;
  }

  async admit(request: IncomingMessage): Promise<DesktopStreamSession> {
    const origin = request.headers.origin;
    const host = request.headers.host;
    const forwarded = request.headers['x-forwarded-proto'];
    const tlsSocket = !!request.socket && 'encrypted' in request.socket
      && request.socket.encrypted === true;
    const loopback = isLoopbackPeer(request.socket?.remoteAddress);
    if (!tlsSocket && !loopback) throw new Error('desktop transport must use the local tunnel');
    const expectedScheme = tlsSocket || (loopback && forwarded === 'https') ? 'https' : 'http';
    if (!origin || !host || origin !== `${expectedScheme}://${host}`) {
      throw new Error('desktop origin invalid');
    }
    const protocols = request.headers['sec-websocket-protocol'];
    const offered = typeof protocols === 'string' ? protocols.split(',').map(value => value.trim()) : [];
    if (offered[0] !== 'instar-desktop-v1' || offered.length !== 2) {
      throw new Error('desktop protocol invalid');
    }
    const ticket = offered[1].startsWith('ticket.') ? offered[1].slice(7) : '';
    if (!ticket || !/^[A-Za-z0-9_-]{40,60}$/.test(ticket)) throw new Error('desktop ticket missing');
    const hash = this.sessionHash(ticket);
    const row = [...this.requests.values()].find(item => item.ticketHash === hash);
    if (!row || !row.ticketExpiresAt || this.now() >= row.ticketExpiresAt
      || row.ticketUsed || row.connected || !this.validGrant(row)) throw new Error('desktop ticket invalid');
    row.ticketUsed = true;
    row.connected = true;
    try {
      await this.host.startIndicator(() => this.revokeRow(row));
      this.audit?.record({ kind: 'start', grantId: row.grantId!, machineId: row.machineId,
        operatorUid: row.operatorUid, authMethod: this.approvalMode });
    }
    catch { this.revokeRow(row); throw new Error('desktop local indicator unavailable'); }
    const assertActive = async () => {
      if (!this.validGrant(row) || !(await this.probe()).ready) {
        this.revokeRow(row);
        throw new Error('desktop grant unavailable');
      }
    };
    return {
      grantId: row.grantId!, assertActive,
      captureEncrypted: async () => { await assertActive(); return row.aead!.encryptFrame(await this.host.capture()); },
      decryptCommand: (record: Buffer) => {
        const value = row.aead!.decryptInput(record);
        if (!value || typeof value !== 'object' || !['stop', 'ping', 'input'].includes((value as { type?: string }).type ?? '')) {
          throw new Error('desktop command invalid');
        }
        return value as { type: 'stop' | 'ping' | 'input'; action?: DesktopInput };
      },
      input: async (action: DesktopInput) => {
        await assertActive();
        // The OS probe above yields. Recheck synchronously at the native spawn
        // boundary so a revoke during that probe cannot launch late input.
        if (!this.validGrant(row)) throw new Error('desktop grant unavailable');
        await this.host.input(action);
        row.inputCount = (row.inputCount ?? 0) + 1;
        row.lastActivity = this.now();
      },
      revoke: async () => { this.revokeRow(row); },
      release: () => { this.revokeRow(row); },
    };
  }

  revoke(requestId: string, operatorSessionToken: string): void {
    const row = this.requests.get(requestId);
    if (!row) throw new Error('desktop request unavailable');
    this.assertViewer(row, operatorSessionToken);
    this.revokeRow(row);
  }

  killSwitch(): void {
    this.disabled = true;
    for (const row of this.requests.values()) this.revokeRow(row);
    this.host.cancelInput();
    this.host.stopIndicator();
  }

  private revokeRow(row: DirectRequest): void {
    if (row.status === 'revoked') return;
    row.status = 'revoked';
    row.operatorSessionToken = undefined;
    row.ticketHash = undefined;
    const ownsActiveHost = !!row.grantId && this.activeGrantId === row.grantId;
    if (ownsActiveHost) {
      this.host.cancelInput();
      this.host.stopIndicator();
    }
    row.desktopKey?.fill(0);
    if (row.connected && row.grantId) {
      const count = row.inputCount ?? 0;
      const inputBucket = count === 0 ? 'none' : count < 10 ? '1-9' : count < 100 ? '10-99' : '100+';
      try { this.audit?.record({ kind: 'stop', grantId: row.grantId, machineId: row.machineId,
        operatorUid: row.operatorUid, authMethod: this.approvalMode, inputBucket }); } catch { /* @silent-fallback-ok — containment takes priority over audit failure */ }
    }
    if (row.grantId) {
      if (ownsActiveHost) this.activeGrantId = null;
      this.closeGrant(row.grantId);
    }
  }
}
