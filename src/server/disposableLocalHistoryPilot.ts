import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { deviceKeyHashOf, type MachineSigner } from '../core/AppRecordSignatures.js';
import { assertLocalHistoryDisposablePilotState, LOCAL_HISTORY_DISPOSABLE_PILOT_LINES } from '../import/LocalHistoryDisposablePilot.js';
import { LocalHistoryChannelRegistry, type LocalHistoryChannelExchange } from '../import/LocalHistoryChannelRegistry.js';
import { LOCAL_HISTORY_PLAINTEXT_BYTES } from '../import/LocalHistoryChannel.js';
import { withLocalHistoryExchange } from '../import/LocalHistoryExchange.js';
import { LocalHistoryUploadStaging, LocalHistoryUploadStagingRefused } from '../import/LocalHistoryUploadStaging.js';
import { activeOwnerPhone } from './mobileConsoleTicket.js';
import type { MobilePairingService } from './mobilePairingRoutes.js';
import { SIGNED_LOCAL_HISTORY_PREFIX, type SignedLocalHistoryIntakeRequest, type SignedLocalHistoryIntakeReply,
  type SignedLocalHistoryIntakeService } from './signedLocalHistoryIntake.js';

const fixture = Buffer.from(LOCAL_HISTORY_DISPOSABLE_PILOT_LINES.join('\n'));
const digest = createHash('sha256').update(fixture).digest('hex');
const channelQuery = /^\?channelId=([0-9a-f-]{36})&sequence=([1-9][0-9]{0,19})$/;
const oneOperationPath = /^\/(operations|uploads)\/([a-f0-9]{32})(\/complete|\/files\/fixture\/chunks\/0)?$/;
const MiB = 1024 ** 2;

function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) throw new Error('disposable-history-request');
  return value as Record<string, unknown>;
}
const decode = (body: Buffer): unknown => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
const json = (status: number, result: object): SignedLocalHistoryIntakeReply =>
  ({ status, type: 'application/json', body: Buffer.from(JSON.stringify(result)) });

export class DisposableLocalHistoryPilot implements SignedLocalHistoryIntakeService {
  private readonly staging: LocalHistoryUploadStaging;
  private readonly channels: LocalHistoryChannelRegistry;
  private selection: string | undefined;
  private preview: string | undefined;
  private stopped = false;

  constructor(private readonly options: {
    stateDir: string;
    agentId: string;
    origin: string;
    pairing: MobilePairingService;
    signer: MachineSigner;
    enabled(): boolean;
  }) {
    this.assertActive();
    const issuer = () => ({ agentId: options.agentId, machineId: options.signer.machineId(),
      bootId: options.pairing.bootId, signingKeyHash: options.signer.signerKeyHash(), origin: options.origin });
    const principal = (device: SignedLocalHistoryIntakeRequest['device'] | Pick<SignedLocalHistoryIntakeRequest['device'], 'deviceId' | 'deviceKeyHash'>) => {
      if (this.stopped || !options.enabled() || !activeOwnerPhone(options.pairing, device.deviceId)) return null;
      const current = options.pairing.devices.get(device.deviceId);
      if (!current?.publicKey || current.userId !== 'synthetic-owner' || deviceKeyHashOf(current.publicKey) !== device.deviceKeyHash) return null;
      return { ...device, ownerUserId: current.userId };
    };
    this.staging = new LocalHistoryUploadStaging({ stateDir: options.stateDir, issuer, principal });
    this.channels = new LocalHistoryChannelRegistry({ issuer, principal, sign: bytes => options.signer.sign(bytes.toString('utf8')).sig });
  }

  private assertActive() {
    if (this.stopped || !this.options.enabled()) throw new Error('disposable-history-stopped');
    assertLocalHistoryDisposablePilotState(this.options.stateDir);
  }

  async withExchange(work: () => Promise<void>): Promise<boolean> {
    this.assertActive();
    return (await withLocalHistoryExchange(this.options.stateDir, work)).accepted;
  }

  async dispatch(request: SignedLocalHistoryIntakeRequest): Promise<SignedLocalHistoryIntakeReply> {
    this.assertActive();
    if (request.device.ownerUserId !== 'synthetic-owner' || request.signal.aborted) throw new Error('disposable-history-owner');
    const route = request.pathname.slice(SIGNED_LOCAL_HISTORY_PREFIX.length);
    if (request.method === 'GET' && route === '/targets' && !request.query) {
      return json(200, { machineId: this.options.signer.machineId(), signingKeyHash: this.options.signer.signerKeyHash(),
        agentId: this.options.agentId, bootId: this.options.pairing.bootId, origin: this.options.origin, importAvailable: false });
    }
    if (request.method === 'POST' && route === '/channels' && !request.query) {
      const input = fields(decode(request.body), ['machineId', 'clientPublicKey', 'clientNonce']);
      const { machineId, clientPublicKey, clientNonce } = input;
      if (typeof machineId !== 'string' || typeof clientPublicKey !== 'string' || typeof clientNonce !== 'string') throw new Error('disposable-history-channel');
      return json(200, this.channels.issue(request.device, { machineId, clientPublicKey, clientNonce }));
    }
    const match = channelQuery.exec(request.query);
    if (!match || !['GET', 'POST', 'PUT'].includes(request.method)) throw new Error('disposable-history-channel');
    const encoded = request.recordHeader;
    if (request.method === 'GET' && (!encoded || !/^[A-Za-z0-9+/]{32}$/.test(encoded))) throw new Error('disposable-history-record');
    const record = request.method === 'GET' ? Buffer.from(encoded!, 'base64') : request.body;
    let exchange: LocalHistoryChannelExchange | undefined;
    request.onDispose(() => exchange?.close());
    try {
      if (record.length < 24 || record.readBigUInt64BE().toString() !== match[2]) throw new Error('disposable-history-record');
      exchange = this.channels.open(request.device, match[1],
        { method: request.method as 'GET' | 'POST' | 'PUT', path: request.pathname }, record);
    } finally { if (request.method === 'GET') record.fill(0); }
    const signal = AbortSignal.any([request.signal, exchange.signal]);
    let status = 200, result: object;
    try {
      result = await this.route(route, request, exchange.plaintext, signal);
      if (request.method === 'POST' && route === '/uploads') status = 201;
      if (request.method === 'POST' && route.endsWith('/complete')) status = 202;
    } catch (error) {
      status = error instanceof LocalHistoryUploadStagingRefused
        ? { unavailable: 503, invalid: 400, 'not-found': 404, busy: 409, capacity: 507, expired: 410, conflict: 409 }[error.reason]
        : 503;
      result = { error: 'disposable-history-refused' };
    }
    if (signal.aborted) throw new Error('disposable-history-disconnected');
    const plaintext = Buffer.from(JSON.stringify(result));
    try {
      if (plaintext.length > LOCAL_HISTORY_PLAINTEXT_BYTES) throw new Error('disposable-history-response');
      return { status, type: 'application/octet-stream', body: exchange.sealResponse(plaintext) };
    } finally { plaintext.fill(0); }
  }

  private async route(route: string, request: SignedLocalHistoryIntakeRequest, body: Buffer, signal: AbortSignal): Promise<object> {
    const { device, method } = request, selected = oneOperationPath.exec(route);
    if (signal.aborted) throw new Error('disposable-history-disconnected');
    if (method === 'GET' && selected?.[1] === 'operations' && !selected[3] && body.length === 0) {
      return this.staging.status(device, selected[2]);
    }
    if (method === 'PUT' && selected?.[1] === 'uploads' && selected[3] === '/files/fixture/chunks/0' && body.equals(fixture)) {
      return this.staging.write(device, selected[2], 'fixture', 0, body);
    }
    if (method !== 'POST') throw new Error('disposable-history-route');
    const input = decode(body);
    if (route === '/challenge') {
      fields(input, []);
      return this.staging.challenge(device);
    }
    if (route === '/uploads') {
      const manifest = fields(input, ['bootId', 'targetMachineId', 'selectionChallenge', 'selectionRequestId', 'purpose', 'project', 'files']);
      if (this.selection || manifest.project !== '/synthetic/project' || !Array.isArray(manifest.files) || manifest.files.length !== 1) throw new Error('disposable-history-fixture');
      const file = fields(manifest.files[0], ['source', 'fileId', 'expectedSessionId', 'displayName', 'bytes', 'sha256']);
      if (file.source !== 'codex' || file.fileId !== 'fixture' || file.expectedSessionId !== 'synthetic-session'
        || file.displayName !== 'synthetic.jsonl' || file.bytes !== fixture.length || file.sha256 !== digest) throw new Error('disposable-history-fixture');
      const grant = this.staging.admit(device, manifest);
      this.selection = grant.operationId;
      return grant;
    }
    if (selected?.[1] === 'uploads' && selected[3] === '/complete') {
      fields(input, []);
      const { operationId } = this.staging.complete(device, selected[2]);
      await this.waitForPhase(device, operationId, ['verifying', 'uploading'], 'verified', signal);
      this.staging.prepare(device, operationId);
      return this.staging.status(device, operationId);
    }
    if (route === '/preview') {
      const { operationId } = fields(input, ['operationId']);
      if (typeof operationId !== 'string' || operationId !== this.selection) throw new Error('disposable-history-preview');
      const result = await this.staging.publishPreparedPreview(device, operationId);
      this.preview = result.previewId;
      return { previewId: result.previewId, machineId: result.machineId, expiresAt: result.expiresAt,
        confirmation: result.confirmation, projects: result.projects, warnings: [] };
    }
    if (route === '/apply') {
      const intent = fields(input, ['previewId', 'machineId', 'bootId', 'confirmationChallenge', 'applyRequestId']);
      if (!this.selection || !this.preview || intent.previewId !== this.preview) throw new Error('disposable-history-preview');
      const blockBytes = fs.statfsSync(this.options.stateDir).bsize;
      const result = await this.staging.applyDisposableFirstClaim(device, this.selection, intent, {
        bootstrapBytes: 64 * MiB, ceiling: 256 * MiB,
        firstClaimPolicy: { blockBytes, perWriteMetadataBytes: MiB, maxReservationBytes: 256 * MiB, maxAttachments: 32 },
      }, signal);
      return { ...result, phase: 'interrupted' };
    }
    if (route === '/cancel') {
      const { operationId } = fields(input, ['operationId']);
      if (typeof operationId !== 'string') throw new Error('disposable-history-operation');
      return this.staging.cancel(device, operationId);
    }
    throw new Error('disposable-history-route');
  }

  private async waitForPhase(device: SignedLocalHistoryIntakeRequest['device'], operationId: string,
    pending: readonly string[], done: string, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!signal.aborted && Date.now() < deadline) {
      const { phase } = this.staging.status(device, operationId);
      if (phase === done) return;
      if (!pending.includes(phase)) break;
      await wait(25, undefined, { signal });
    }
    throw new Error('disposable-history-phase');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.channels.stop();
    await this.staging.stop();
  }
}
