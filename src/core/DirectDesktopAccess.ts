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
import { desktopVideoContract } from './DesktopVideo.js';
import { encodeDesktopH264 } from './DesktopVideo.js';
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
  videoCodec: 'jpeg' | 'h264';
  operatorSessionHash: string;
  operatorSessionToken?: string;
  codeHash: Buffer;
  createdAt: number;
  status: 'pending' | 'approved' | 'interrupted' | 'revoked';
  interruptedAt?: number;
  resumeCount?: number;
  resumeAttemptId?: string;
  resumePayloadHash?: string;
  admitPending?: Promise<void>;
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
  ticketPlaintext?: string;
  ticketProofHash?: string;
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
  videoCodec?: 'jpeg' | 'h264';
  previousVideoCodec?: 'jpeg' | 'h264';
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
    private readonly isDashboardOperatorSession: (token: string, browserPublicKey: string) => boolean,
    private readonly sendChallenge: (topicId: number, text: string) => Promise<void>,
    private readonly closeGrant: (grantId: string) => void,
    private readonly now: () => number = Date.now,
    private readonly audit?: DesktopAccessAudit,
    private readonly approvalMode: 'telegram' | 'pin' = 'telegram',
    private readonly isRelayIssuer?: (operatorSessionToken: string, machineId: string) => boolean,
  ) {
    this.host.setInputFailureHandler?.(() => {
      const row = [...this.requests.values()].find(item => item.grantId === this.activeGrantId);
      if (row) this.revokeRow(row);
    });
  }

  requiresTelegramStepUp(): boolean { return this.approvalMode === 'telegram'; }

  targetInfo(): { machineId: string; label: string } {
    return { machineId: this.machineId, label: this.machineLabel };
  }

  targetSigningPublicKey(): string { return this.targetIdentity.publicKey.toString('base64'); }

  private sessionHash(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private assertViewer(row: DirectRequest, token: string): void {
    if (!this.isDashboardOperatorSession(token, row.browserPublicKey)
      || !crypto.timingSafeEqual(Buffer.from(this.sessionHash(token)), Buffer.from(row.operatorSessionHash))) {
      throw new Error('dashboard operator session unavailable');
    }
  }

  private signedPayload(row: DirectRequest): Buffer {
    return Buffer.from(JSON.stringify(['direct-desktop-grant-v1', row.grantId, row.id,
      row.operatorUid, row.topicId, row.machineId, row.browserPublicKey,
      row.browserEcdhPublicKey, row.targetEcdhPublicKey, row.salt,
      row.browserNonce, row.videoCodec, desktopVideoContract(row.videoCodec),
      row.connectionNonce, row.approvedAt, (row.approvedAt ?? 0) + GRANT_MS]));
  }

  private targetPayload(row: DirectRequest): Buffer {
    return Buffer.from(JSON.stringify(['desktop-target-key-v1', row.id, row.machineId,
      row.browserPublicKey, row.browserEcdhPublicKey,
      row.targetEcdhPublicKey, row.salt, row.videoCodec, desktopVideoContract(row.videoCodec),
      row.connectionNonce, (row.approvedAt ?? 0) + GRANT_MS]));
  }

  private validGrant(row: DirectRequest): boolean {
    return !this.disabled && row.status === 'approved' && !!row.grantId
      && this.activeGrantId === row.grantId && !!row.grantSignature
      && !!row.approvedAt && this.now() >= row.approvedAt && this.now() < row.approvedAt + GRANT_MS
      && !!row.lastActivity && this.now() - row.lastActivity < IDLE_MS
      && (this.approvalMode === 'pin'
        ? !!row.operatorSessionToken && this.isDashboardOperatorSession(row.operatorSessionToken, row.browserPublicKey)
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
      || !this.isDashboardOperatorSession(input.operatorSessionToken, input.browserPublicKey)
      || (this.requiresTelegramStepUp() && (input.scopeConfirmed !== true
        || !Number.isSafeInteger(input.topicId) || input.topicId <= 0
        || !/^\d{1,30}$/.test(input.operatorUid)
        || !this.isVerifiedOperator(input.topicId, input.operatorUid)))
      || !/^[A-Za-z0-9_-]{16,128}$/.test(input.browserNonce)
      || (input.videoCodec !== undefined && input.videoCodec !== 'jpeg' && input.videoCodec !== 'h264')) {
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
      browserNonce: input.browserNonce, videoCodec: input.videoCodec ?? 'jpeg',
      operatorSessionHash: this.sessionHash(input.operatorSessionToken),
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

  private approveRow(row: DirectRequest, preserveDeadline = false): boolean {
    if (this.activeGrantId) {
      const active = [...this.requests.values()].find(other => other.grantId === this.activeGrantId);
      if (active && this.validGrant(active)) return false;
      if (active) this.revokeRow(active);
    }
    // A Telegram code is consumed by changing the row state before signing.
    try {
      row.status = 'approved';
      row.grantId = crypto.randomUUID();
      row.approvedAt = preserveDeadline ? row.approvedAt : this.now();
      row.lastActivity = preserveDeadline ? row.lastActivity : row.approvedAt;
      row.connectionNonce = crypto.randomBytes(24).toString('base64url');
      row.ticketHash = undefined;
      row.ticketPlaintext = undefined;
      row.ticketProofHash = undefined;
      row.ticketExpiresAt = undefined;
      row.ticketUsed = false;
      row.connected = false;
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
    videoCodec?: 'jpeg' | 'h264';
  } {
    const row = this.requests.get(requestId);
    if (!row) throw new Error('desktop request unavailable');
    this.assertViewer(row, operatorSessionToken);
    if (row.status === 'pending' && this.now() - row.createdAt >= CHALLENGE_MS) row.status = 'revoked';
    if (row.status === 'approved' && !this.validGrant(row)) this.revokeRow(row);
    if (row.status === 'interrupted' && !this.validInterrupted(row)) this.revokeRow(row);
    return row.status === 'approved'
      ? { status: 'approved', connectionNonce: row.connectionNonce,
        targetEcdhPublicKey: row.targetEcdhPublicKey, salt: row.salt,
        targetSigningPublicKey: this.targetIdentity.publicKey.toString('base64'),
        targetSignature: row.targetSignature?.toString('base64'), machineId: row.machineId,
        videoCodec: row.videoCodec, expiresAt: (row.approvedAt ?? 0) + GRANT_MS }
      : { status: row.status };
  }

  private validInterrupted(row: DirectRequest): boolean {
    return !this.disabled && row.status === 'interrupted' && !!row.approvedAt
      && this.now() >= row.approvedAt && this.now() < row.approvedAt + GRANT_MS
      && !!row.lastActivity && this.now() - row.lastActivity < IDLE_MS
      && !!row.interruptedAt && this.now() - row.interruptedAt < 30_000
      && (row.resumeCount ?? 0) < 3 && !!row.operatorSessionToken
      && this.isDashboardOperatorSession(row.operatorSessionToken, row.browserPublicKey);
  }

  /** Same logical session and original deadlines; one idempotent replacement per attempt. */
  async resume(requestId: string, token: string, input: Pick<DirectDesktopRequestInput,
    'browserPublicKey' | 'browserEcdhPublicKey' | 'browserNonce' | 'videoCodec' | 'previousVideoCodec'>, attemptId: string,
    previousConnectionNonce: string, previousSignature: string): Promise<ReturnType<DirectDesktopAccess['status']>> {
    const row = this.requests.get(requestId);
    if (!row) throw new Error('desktop request unavailable');
    this.assertViewer(row, token);
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(attemptId)) throw new Error('resume attempt invalid');
    const previousVideoCodec = input.previousVideoCodec ?? row.videoCodec;
    const nextVideoCodec = input.videoCodec ?? row.videoCodec;
    if ((previousVideoCodec !== 'jpeg' && previousVideoCodec !== 'h264')
      || (nextVideoCodec !== 'jpeg' && nextVideoCodec !== 'h264')
      || (previousVideoCodec === 'jpeg' && nextVideoCodec === 'h264')) throw new Error('desktop video codec invalid');
    const resumePayload = Buffer.from(JSON.stringify(['desktop-resume-v1', requestId,
      previousConnectionNonce, attemptId, input.browserPublicKey, input.browserEcdhPublicKey,
      input.browserNonce, previousVideoCodec, nextVideoCodec]));
    const payloadHash = crypto.createHash('sha256').update(resumePayload).digest('hex');
    if (row.status === 'approved' && row.resumeAttemptId === attemptId) {
      if (row.resumePayloadHash !== payloadHash) throw new Error('desktop resume attempt changed');
      return this.status(requestId, token);
    }
    if (this.approvalMode !== 'pin' || (row.resumeCount ?? 0) >= 3 || !(this.validInterrupted(row)
      || (row.connected && this.validGrant(row)))) throw new Error('desktop resume unavailable');
    if (previousVideoCodec !== row.videoCodec) throw new Error('desktop video generation changed');
    if (previousConnectionNonce !== row.connectionNonce) throw new Error('desktop resume generation changed');
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(input.browserNonce)) throw new Error('browser nonce invalid');
    let browserKey: crypto.KeyObject;
    try { browserKey = crypto.createPublicKey({ key: Buffer.from(input.browserPublicKey, 'base64'), format: 'der', type: 'spki' }); }
    catch { throw new Error('browser key invalid'); }
    if (browserKey.asymmetricKeyType !== 'ed25519') throw new Error('browser key invalid');
    const browserEcdh = Buffer.from(input.browserEcdhPublicKey, 'base64');
    if (browserEcdh.length !== 65 || browserEcdh[0] !== 4) throw new Error('browser ECDH key invalid');
    try { const check = crypto.createECDH('prime256v1'); check.generateKeys(); check.computeSecret(browserEcdh); }
    catch { throw new Error('browser ECDH key invalid'); }
    const previousBrowserKey = row.browserPublicKey;
    let previousProofValid = false;
    try {
      const key = crypto.createPublicKey({ key: Buffer.from(previousBrowserKey, 'base64'), format: 'der', type: 'spki' });
      previousProofValid = key.asymmetricKeyType === 'ed25519'
        && crypto.verify(null, resumePayload, key, Buffer.from(previousSignature, 'base64'));
    } catch { previousProofValid = false; }
    if (!previousProofValid) throw new Error('previous browser proof invalid');
    // A ticket may have been consumed while the local indicator is still
    // starting. Do not replace that generation until admission settles.
    if (row.admitPending) await row.admitPending.catch(() => {});
    if (!(await this.probe()).ready) throw new Error('desktop host is not ready');
    // The probe yields. Recheck both authority and the revocation state before activation.
    this.assertViewer(row, token);
    if (row.status === 'approved' && row.resumeAttemptId === attemptId) {
      if (row.resumePayloadHash !== payloadHash) throw new Error('desktop resume attempt changed');
      return this.status(requestId, token);
    }
    if ((row.resumeCount ?? 0) >= 3 || row.browserPublicKey !== previousBrowserKey
      || row.connectionNonce !== previousConnectionNonce) throw new Error('desktop resume unavailable');
    if (row.connected && this.validGrant(row)) this.interruptRow(row);
    if (!this.validInterrupted(row)) throw new Error('desktop resume unavailable');
    row.browserPublicKey = input.browserPublicKey;
    row.browserEcdhPublicKey = input.browserEcdhPublicKey;
    row.browserNonce = input.browserNonce;
    row.videoCodec = nextVideoCodec;
    row.resumeAttemptId = attemptId;
    row.resumePayloadHash = payloadHash;
    row.resumeCount = (row.resumeCount ?? 0) + 1;
    row.interruptedAt = undefined;
    if (!this.approveRow(row, true)) throw new Error('desktop resume unavailable');
    return this.status(requestId, token);
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
    if (!this.validGrant(row) || row.connected || nonce !== row.connectionNonce) {
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
    const proofHash = this.sessionHash(signature);
    if (row.ticketHash) {
      if (!row.ticketUsed && row.ticketExpiresAt && this.now() < row.ticketExpiresAt
        && row.ticketProofHash === proofHash && row.ticketPlaintext
        && this.sessionHash(row.ticketPlaintext) === row.ticketHash) return row.ticketPlaintext;
      throw new Error('desktop ticket unavailable');
    }
    const ticket = crypto.randomBytes(32).toString('base64url');
    row.ticketHash = this.sessionHash(ticket);
    row.ticketPlaintext = ticket;
    row.ticketProofHash = proofHash;
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
    const relayMachineId = (request as IncomingMessage & { desktopRelayMachineId?: string }).desktopRelayMachineId;
    if (!tlsSocket && !loopback && !relayMachineId) throw new Error('desktop transport must use the local tunnel');
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
    if (relayMachineId && (!row.operatorSessionToken
      || !this.isRelayIssuer?.(row.operatorSessionToken, relayMachineId))) {
      throw new Error('desktop relay issuer invalid');
    }
    row.ticketUsed = true;
    row.ticketPlaintext = undefined;
    row.ticketProofHash = undefined;
    row.connected = true;
    const admittedGrantId = row.grantId!;
    const admittedAead = row.aead!;
    const indicatorPending = this.host.startIndicator(() => {
      if (row.grantId === admittedGrantId) this.revokeRow(row);
    });
    row.admitPending = indicatorPending;
    try {
      await indicatorPending;
      if (row.grantId !== admittedGrantId || !this.validGrant(row)) throw new Error('desktop grant unavailable');
      this.audit?.record({ kind: 'start', grantId: admittedGrantId, machineId: row.machineId,
        operatorUid: row.operatorUid, authMethod: this.approvalMode });
    }
    catch {
      if (row.grantId === admittedGrantId) this.revokeRow(row);
      throw new Error('desktop local indicator unavailable');
    }
    finally { if (row.admitPending === indicatorPending) row.admitPending = undefined; }
    let lastHostProbeAt = -Infinity;
    let hostProbe: Promise<boolean> | null = null;
    const assertActive = async () => {
      if (row.grantId !== admittedGrantId || !this.validGrant(row)) {
        if (row.grantId === admittedGrantId) this.revokeRow(row);
        throw new Error('desktop grant unavailable');
      }
      // The native capture and input helpers check the OS session at each
      // operation. Share the slower process-level readiness probe briefly so
      // a 15 fps stream does not spawn three probes per frame.
      if (performance.now() - lastHostProbeAt < 500) return;
      if (!hostProbe) {
        hostProbe = this.probe().then(result => result.ready, () => false)
          .finally(() => { hostProbe = null; });
      }
      const ready = await hostProbe;
      if (!ready || row.grantId !== admittedGrantId || !this.validGrant(row)) {
        if (row.grantId === admittedGrantId) this.revokeRow(row);
        throw new Error('desktop grant unavailable');
      }
      lastHostProbeAt = performance.now();
    };
    let lastQueuedFrameDigest: Buffer | null = null;
    let candidateFrameDigest: Buffer | null = null;
    let activeCodec = row.videoCodec;
    let forceKeyframe = true;
    let candidateVideoKeyframe = false;
    let lastQueuedGeometry = '';
    let candidateGeometry = '';
    return {
      grantId: admittedGrantId, assertActive,
      captureEncrypted: async () => {
        await assertActive();
        if (activeCodec === 'h264' && this.host.captureH264) {
          try {
            const frame = await this.host.captureH264(forceKeyframe);
            if (!frame) return null;
            candidateGeometry = `${frame.width}x${frame.height}`;
            if ((forceKeyframe || (lastQueuedGeometry && candidateGeometry !== lastQueuedGeometry))
              && !frame.keyframe) { forceKeyframe = true; return null; }
            candidateVideoKeyframe = frame.keyframe;
            return admittedAead.encryptFrame(encodeDesktopH264(frame));
          } catch (error) {
            // A Stop/takeover can cancel the native read while it is awaited.
            // Never turn that cancellation into a new JPEG helper launch.
            if (row.grantId !== admittedGrantId || !this.validGrant(row)
              || (error as Error).message === 'mac-desktop-host-capture-cancelled') throw error;
            // Hardware encoding is optional. Downgrade this logical session
            // without changing its controller lock or input authority.
            activeCodec = 'jpeg';
            candidateVideoKeyframe = false;
            lastQueuedGeometry = '';
          }
        } else if (activeCodec === 'h264') activeCodec = 'jpeg';
        if (row.grantId !== admittedGrantId || !this.validGrant(row)) {
          throw new Error('desktop grant unavailable');
        }
        const image = await this.host.capture();
        const digest = crypto.createHash('sha256').update(image).digest();
        if (lastQueuedFrameDigest?.equals(digest)) return null;
        candidateFrameDigest = digest;
        return admittedAead.encryptFrame(image);
      },
      frameQueued: () => {
        if (activeCodec === 'h264') {
          if (candidateVideoKeyframe) forceKeyframe = false;
          if (candidateGeometry) lastQueuedGeometry = candidateGeometry;
          candidateVideoKeyframe = false;
          candidateGeometry = '';
          return;
        }
        if (candidateFrameDigest) lastQueuedFrameDigest = candidateFrameDigest;
        candidateFrameDigest = null;
      },
      frameDropped: () => {
        if (activeCodec === 'h264') forceKeyframe = true;
        candidateVideoKeyframe = false;
        candidateGeometry = '';
        candidateFrameDigest = null;
      },
      requestKeyframe: () => { if (activeCodec === 'h264') forceKeyframe = true; },
      fallbackVideo: () => { activeCodec = 'jpeg'; candidateFrameDigest = null; },
      decryptCommand: (record: Buffer) => {
        if (row.grantId !== admittedGrantId) throw new Error('desktop grant unavailable');
        const value = admittedAead.decryptInput(record);
        if (!value || typeof value !== 'object'
          || !['stop', 'ping', 'input', 'keyframe', 'video-fallback'].includes((value as { type?: string }).type ?? '')) {
          throw new Error('desktop command invalid');
        }
        return value as { type: 'stop' | 'ping' | 'input' | 'keyframe' | 'video-fallback'; action?: DesktopInput };
      },
      input: async (action: DesktopInput) => {
        await assertActive();
        // The OS probe above yields. Recheck synchronously at the native spawn
        // boundary so a revoke during that probe cannot launch late input.
        if (row.grantId !== admittedGrantId || !this.validGrant(row)) throw new Error('desktop grant unavailable');
        await this.host.input(action);
        row.inputCount = (row.inputCount ?? 0) + 1;
        row.lastActivity = this.now();
      },
      revoke: async () => { if (row.grantId === admittedGrantId) this.revokeRow(row); },
      release: reason => {
        if (row.grantId !== admittedGrantId) return;
        if (reason === 'transport-lost' && this.validGrant(row)) this.interruptRow(row);
        else this.revokeRow(row);
      },
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
    row.ticketPlaintext = undefined;
    row.ticketProofHash = undefined;
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

  private interruptRow(row: DirectRequest): void {
    if (!this.validGrant(row) || !row.grantId) { this.revokeRow(row); return; }
    const oldGrantId = row.grantId;
    const count = row.inputCount ?? 0;
    const inputBucket = count === 0 ? 'none' : count < 10 ? '1-9' : count < 100 ? '10-99' : '100+';
    row.status = 'interrupted';
    row.interruptedAt = this.now();
    row.connected = false;
    row.ticketHash = undefined;
    row.ticketPlaintext = undefined;
    row.ticketProofHash = undefined;
    row.ticketUsed = true;
    this.host.cancelInput();
    this.host.stopIndicator();
    row.desktopKey?.fill(0);
    row.desktopKey = undefined;
    row.aead = undefined;
    row.grantSignature = undefined;
    row.targetSignature = undefined;
    row.grantId = undefined;
    this.activeGrantId = null;
    try { this.audit?.record({ kind: 'stop', grantId: oldGrantId, machineId: row.machineId,
      operatorUid: row.operatorUid, authMethod: this.approvalMode, inputBucket }); }
    catch { /* @silent-fallback-ok — containment takes priority over audit failure */ }
    this.closeGrant(oldGrantId);
  }
}
