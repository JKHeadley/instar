import {DegradationReporter} from '../monitoring/DegradationReporter.js';
/**
 * Authenticated live delegation ingress, Conversations v3 §3/§7.2 increment A.
 *
 * This produces ONLY a proposed delegates-to placement. The graph pending/witness
 * pipeline still owns Saved, certification and replay. A source signature alone
 * is never a commit certificate and a generic API bearer is not a source proof.
 *
 * Source records are captured after a real persisted spawn and bind both session
 * bootstrap capabilities, typed source identities, scope and the writer's signed
 * lease. No prompt, title, token, message text or external sender id is retained.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { base64ToSigningPem, MachineIdentityManager, sign, verify } from './MachineIdentity.js';
import { IdentityStore } from './IdentityStore.js';
import { FencedLease } from './FencedLease.js';
import type { LeaseCoordinator } from './LeaseCoordinator.js';
import type { LeaseRecord } from './types.js';
import type { SessionOwnershipRecord } from './SessionOwnership.js';
import type { StateManager } from './StateManager.js';
import type { WriteAdmission } from './WriteAdmission.js';
import type { ConversationBindAuth } from './conversationBindToken.js';
import type { ConversationRegistry } from './ConversationRegistry.js';
import { canonicalJson, canonicalHash, graphOperationKey, signGraphRecord, verifyMembershipEpoch, verifyFencedLeaseBridge,
  type GraphMembershipEpoch, type GraphWitnessLease } from './GraphWitnessTypes.js';
import type { GraphAuthorizationProof, GraphAuthorizationReceipt } from './ConversationGraphReplicationProof.js';

export type GraphDelegationConversationRef =
  | { kind: 'conversation'; platform: 'telegram'; chatId: string; topicId: number }
  | { kind: 'conversation'; platform: 'slack'; channelId: string; threadTs?: string }
  | { kind: 'conversation'; platform: 'app'; conversationKey: string };

export type DelegationOwnershipSnapshot = Pick<SessionOwnershipRecord, 'sessionKey' | 'ownerMachineId' | 'ownershipEpoch' | 'status' | 'updatedAt'>;
export function delegationOwnershipSnapshot(record: SessionOwnershipRecord): DelegationOwnershipSnapshot {
  return { sessionKey: record.sessionKey, ownerMachineId: record.ownerMachineId, ownershipEpoch: record.ownershipEpoch, status: record.status, updatedAt: record.updatedAt };
}
export function validDelegationOwnership(value: unknown): value is DelegationOwnershipSnapshot {
  const r = value as Record<string, unknown>;
  return !!r && typeof r === 'object' && !Array.isArray(r) && exactKeys(r, ['sessionKey', 'ownerMachineId', 'ownershipEpoch', 'status', 'updatedAt'])
    && typeof r.sessionKey === 'string' && /^[A-Za-z0-9_:.-]{1,200}$/.test(r.sessionKey) && safeId(r.ownerMachineId)
    && Number.isSafeInteger(r.ownershipEpoch) && Number(r.ownershipEpoch) > 0 && r.status === 'active' && iso(r.updatedAt);
}
function validPlacementCore(core: unknown): core is GraphDelegationPlacementCore {
  const c = core as Record<string, unknown>;
  return !!c && typeof c === 'object' && !Array.isArray(c) && exactKeys(c, ['schemaVersion', 'eventId', 'op', 'subject', 'parent', 'relation',
    'replacesPlacementEventIds', 'principal', 'authority', 'receipt', 'machineId', 'createdAt']);
}

export interface GraphDelegationSourceCore {
  version: 1;
  kind: 'successful-session-spawn';
  sourceId: string;
  agentId: string;
  parentSessionId: string;
  workerSessionId: string;
  parentRef: GraphDelegationConversationRef;
  workerRef: GraphDelegationConversationRef;
  parentOwnership: DelegationOwnershipSnapshot;
  workerOwnership: DelegationOwnershipSnapshot;
  parentProjectId: string | null;
  workerProjectId: string | null;
  sourceMachineId: string;
  sourceKeyEpoch: number;
  sourceEpoch: number;
  capturedAt: string;
  lease: LeaseRecord;
}

export interface SignedGraphDelegationSource extends GraphDelegationSourceCore { signature: string }

export interface DelegationPlacementHead {
  eventId: string;
  authority: 'owner' | 'delegation' | 'import' | 'inference';
}

export interface GraphDelegationPlacementCore {
  schemaVersion: 1;
  eventId: string;
  op: 'set-primary-placement';
  subject: GraphDelegationConversationRef;
  parent: GraphDelegationConversationRef;
  relation: 'delegates-to';
  replacesPlacementEventIds: string[];
  principal: 'internal-session-spawn' | 'remote-session-spawn';
  authority: 'delegation';
  receipt: { kind: 'dispatch-record'; id: string };
  machineId: string;
  createdAt: string;
}

export interface GraphDelegationAuthorizationReceipt {
  version: 1;
  authMethod: 'verified-live-spawn';
  acceptingMachineId: string;
  keyEpoch: number;
  admissionEpoch: number;
  idempotencyKey: string;
  coreHash: string;
  sourceHash: string;
  leaseHash: string;
  acceptingLease: LeaseRecord;
  signature: string;
}

export type DelegationResult =
  | { status: 'proposed'; core: GraphDelegationPlacementCore; authorizationReceipt: GraphDelegationAuthorizationReceipt; source: SignedGraphDelegationSource }
  | { status: 'suggestion'; sourceId: string; reason: 'owner-placement-exists' | 'non-agent-placement-exists' }
  | { status: 'refused'; reason: string };

export const delegationCanonical = canonicalJson;
const digest = canonicalHash;
const sourceBytes = (core: GraphDelegationSourceCore) => `instar:conversation-graph:delegation-source:v1\n${delegationCanonical(core)}`;
const receiptBytes = (receipt: Omit<GraphDelegationAuthorizationReceipt, 'signature'>) => `instar:conversation-graph:delegation-authorization:v1\n${delegationCanonical(receipt)}`;
const safeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const iso = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).sort().join(',') === keys.sort().join(',');

function durableCreate(file: string, value: unknown): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const dfd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
}

function readRecord(file: string): unknown {
  const max = 64 * 1024;
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > max) throw new Error('delegation-record-too-large');
    const data = Buffer.alloc(Math.min(stat.size + 1, max + 1));
    let offset = 0;
    while (offset < data.length) {
      const read = fs.readSync(fd, data, offset, data.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    if (offset > max || offset !== stat.size) throw new Error('delegation-record-changed-during-read');
    return JSON.parse(data.subarray(0, offset).toString('utf8'));
  } finally { fs.closeSync(fd); }
}

export function validDelegationConversationRef(value: unknown): value is GraphDelegationConversationRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  if (ref.kind !== 'conversation') return false;
  if (ref.platform === 'telegram') return exactKeys(ref, ['kind', 'platform', 'chatId', 'topicId'])
    && typeof ref.chatId === 'string' && /^-?[1-9]\d{0,19}$/.test(ref.chatId)
    && Number.isSafeInteger(ref.topicId) && Number(ref.topicId) > 0;
  if (ref.platform === 'slack') return exactKeys(ref, ref.threadTs === undefined ? ['kind', 'platform', 'channelId'] : ['kind', 'platform', 'channelId', 'threadTs'])
    && typeof ref.channelId === 'string' && /^[CDG][A-Z0-9]{1,79}$/.test(ref.channelId)
    && (ref.threadTs === undefined || typeof ref.threadTs === 'string' && /^\d{1,20}\.\d{1,10}$/.test(ref.threadTs));
  return ref.platform === 'app' && exactKeys(ref, ['kind', 'platform', 'conversationKey'])
    && typeof ref.conversationKey === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(ref.conversationKey);
}

function validLease(lease: unknown): lease is LeaseRecord {
  if (!lease || typeof lease !== 'object' || Array.isArray(lease)) return false;
  const l = lease as Record<string, unknown>;
  return safeId(l.holder) && Number.isSafeInteger(l.epoch) && Number(l.epoch) >= 0 && iso(l.acquiredAt) && iso(l.expiresAt)
    && Number.isSafeInteger(l.nonce) && Number(l.nonce) >= 0 && typeof l.signature === 'string'
    && (l.released === undefined || l.released === false) && Object.keys(l).every((k) => ['holder', 'epoch', 'acquiredAt', 'expiresAt', 'nonce', 'signature', 'released'].includes(k));
}

function sourceCore(raw: unknown): GraphDelegationSourceCore | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  if (!exactKeys(s, ['version', 'kind', 'sourceId', 'agentId', 'parentSessionId', 'workerSessionId', 'parentRef', 'workerRef',
    'parentOwnership', 'workerOwnership', 'parentProjectId', 'workerProjectId', 'sourceMachineId', 'sourceKeyEpoch', 'sourceEpoch', 'capturedAt', 'lease', 'signature'])) return null;
  if (s.version !== 1 || s.kind !== 'successful-session-spawn' || !safeId(s.sourceId) || !safeId(s.agentId)
    || !safeId(s.parentSessionId) || !safeId(s.workerSessionId) || !safeId(s.sourceMachineId)
    || s.parentSessionId === s.workerSessionId || !validDelegationConversationRef(s.parentRef) || !validDelegationConversationRef(s.workerRef)
    || delegationCanonical(s.parentRef) === delegationCanonical(s.workerRef)
    || !Number.isSafeInteger(s.sourceEpoch) || Number(s.sourceEpoch) < 0 || !Number.isSafeInteger(s.sourceKeyEpoch) || Number(s.sourceKeyEpoch) < 0
    || !validDelegationOwnership(s.parentOwnership) || !validDelegationOwnership(s.workerOwnership)
    || s.parentOwnership.ownerMachineId !== s.sourceMachineId || s.workerOwnership.ownerMachineId !== s.sourceMachineId
    || !iso(s.capturedAt) || !validLease(s.lease) || typeof s.signature !== 'string'
    || (s.parentProjectId !== null && !safeId(s.parentProjectId)) || (s.workerProjectId !== null && !safeId(s.workerProjectId))) return null;
  const { signature: _signature, ...core } = s;
  return core as unknown as GraphDelegationSourceCore;
}

interface DelegationBaseDeps {
  agentId: string;
  identity: MachineIdentityManager;
  admission: WriteAdmission;
  coordinator: Pick<LeaseCoordinator, 'holdsLease' | 'currentEpoch' | 'currentLease'>;
  now?: () => number;
  ownershipForConversation: (ref: GraphDelegationConversationRef) => SessionOwnershipRecord | null;
}

/** Verification reads the real paired-key history, never a caller-supplied key. */
export function verifyGraphDelegationSource(raw: unknown, identity: MachineIdentityManager, agentId: string):
  { ok: true; core: GraphDelegationSourceCore; hash: string } | { ok: false; reason: string } {
  const core = sourceCore(raw);
  if (!core) return { ok: false, reason: 'invalid-source-record' };
  if (core.agentId !== agentId) return { ok: false, reason: 'wrong-agent' };
  if (core.lease.holder !== core.sourceMachineId || core.lease.epoch !== core.sourceEpoch) return { ok: false, reason: 'source-lease-mismatch' };
  const at = Date.parse(core.capturedAt);
  if (at < Date.parse(core.lease.acquiredAt) || at > Date.parse(core.lease.expiresAt)) return { ok: false, reason: 'source-outside-lease-window' };
  try {
    const keys = new IdentityStore({ stateDir: identity.baseDir }).signingKeyHistory(core.sourceMachineId);
    const key = keys.find((k) => k.epoch === core.sourceKeyEpoch
      && (k.validFrom === null || at >= Date.parse(k.validFrom))
      && (k.validUntil === null || at <= Date.parse(k.validUntil))
      && (k.revokedAt === null || at < Date.parse(k.revokedAt)));
    if (!key) return { ok: false, reason: 'source-key-untrusted' };
    const pem = base64ToSigningPem(key.publicKey);
    if (!verify(FencedLease.canonicalize(core.lease), core.lease.signature, pem)) return { ok: false, reason: 'invalid-source-lease-signature' };
    if (!verify(sourceBytes(core), (raw as SignedGraphDelegationSource).signature, pem)) return { ok: false, reason: 'invalid-source-signature' };
    return { ok: true, core, hash: digest(core) };
  } catch { /* @silent-fallback-ok — unavailable source proof returns an explicit typed refusal, never a placement. */ return { ok: false, reason: 'source-verification-unavailable' }; }
}

/** Pure receive-side source proof. The caller pins this public key through the
 * owner-signed membership epoch, never from the source record being checked. */
export function verifyGraphDelegationCoreSource(core: unknown, raw: unknown, publicKey: crypto.KeyLike,
  agentId: string, expectedWriterId: string): boolean {
  try {
    const source = sourceCore(raw);
    if (!source || source.agentId !== agentId || source.sourceMachineId !== expectedWriterId
      || source.lease.holder !== expectedWriterId || source.lease.epoch !== source.sourceEpoch) return false;
    const at = Date.parse(source.capturedAt);
    if (at < Date.parse(source.lease.acquiredAt) || at >= Date.parse(source.lease.expiresAt)) return false;
    if (!crypto.verify(null, Buffer.from(FencedLease.canonicalize(source.lease)), publicKey, Buffer.from(source.lease.signature, 'base64'))
      || !crypto.verify(null, Buffer.from(sourceBytes(source)), publicKey, Buffer.from((raw as SignedGraphDelegationSource).signature, 'base64'))) return false;
    if (!core || typeof core !== 'object' || Array.isArray(core)) return false;
    const c = core as GraphDelegationPlacementCore;
    return validPlacementCore(c) && c.schemaVersion === 1 && c.op === 'set-primary-placement' && c.relation === 'delegates-to'
      && c.principal === 'internal-session-spawn' && c.authority === 'delegation' && c.machineId === source.sourceMachineId
      && c.eventId === `delegation-${digest({ agentId, sourceId: source.sourceId })}`
      && c.createdAt === source.capturedAt
      && delegationCanonical(c.subject) === delegationCanonical(source.workerRef)
      && delegationCanonical(c.parent) === delegationCanonical(source.parentRef)
      && Array.isArray(c.replacesPlacementEventIds) && c.replacesPlacementEventIds.every(safeId)
      && delegationCanonical(c.receipt) === delegationCanonical({ kind: 'dispatch-record', id: source.sourceId });
  } catch { /* @silent-fallback-ok — invalid delegation signature or authority is a negative verification result. */ return false; }
}

function writer(deps: DelegationBaseDeps): { machineId: string; keyEpoch: number; lease: LeaseRecord } | null {
  const store = deps.admission.guardStoreWrite('conversationGraph.append');
  if (store.enforce === 'refuse' || !deps.admission.evaluate('cluster-shared').admit || !deps.coordinator.holdsLease()) return null;
  const local = deps.identity.loadIdentity();
  const lease = deps.coordinator.currentLease();
  if (!lease || !validLease(lease) || lease.holder !== local.machineId || lease.epoch !== deps.coordinator.currentEpoch()
    || !deps.identity.isMachineActive(local.machineId)) return null;
  const pem = deps.identity.getSigningPublicKeyPem(local.machineId);
  if (!pem || !verify(FencedLease.canonicalize(lease), lease.signature, pem)) return null;
  return { machineId: local.machineId, keyEpoch: local.keyEpoch ?? 0, lease };
}

export interface DelegationCaptureInput {
  sourceId: string;
  parentSessionId: string;
  workerSessionId: string;
  parentRef: GraphDelegationConversationRef;
  workerRef: GraphDelegationConversationRef;
  parentBindToken: string;
  workerBindToken: string;
}

export interface DelegationSourceDeps extends DelegationBaseDeps {
  state: StateManager;
  bindAuth: ConversationBindAuth;
  conversations: ConversationRegistry;
  telegramChatId: string | null;
  /** Live adapter/session registry bindings, including headless records whose
   * Session JSON does not carry a topic. This must not read request-body ids. */
  conversationIdsForSession: (tmuxSession: string) => readonly number[];
  /** Existing binding authority, not a value supplied in the spawn request. */
  projectForConversation: (ref: GraphDelegationConversationRef) => string | null;
}

/** Local, fsynced capture of successful spawn provenance. Never an HTTP handler. */
export class ConversationGraphDelegationSource {
  constructor(private readonly deps: DelegationSourceDeps) {}

  /** Repair/retry reads preserve the original signature after sessions finish. */
  readCaptured(sourceId: string): SignedGraphDelegationSource | null {
    if (!safeId(sourceId)) return null;
    try {
      const file = path.join(this.deps.state.baseDir, 'state', 'conversation-graph-delegation-sources',
        `${digest({ agentId: this.deps.agentId, sourceId })}.json`);
      const raw = readRecord(file);
      return verifyGraphDelegationSource(raw, this.deps.identity, this.deps.agentId).ok ? raw as SignedGraphDelegationSource : null;
    } catch (error) { if((error as NodeJS.ErrnoException).code!=='ENOENT'){DegradationReporter.getInstance().report({feature:'Conversations.delegation',primary:'Verified delegation intake',fallback:'Retain pending source without claiming Saved',reason:'delegation-intake-unavailable',impact:'Delegation remains unavailable until repair',internalOnly:true});} return null; }
  }

  capturedSources():SignedGraphDelegationSource[]{
    const dir=path.join(this.deps.state.baseDir,'state','conversation-graph-delegation-sources');if(!fs.existsSync(dir))return [];
    const files=fs.readdirSync(dir);if(files.length>4096)throw new Error('graph-delegation-source-inventory-bound');
    const result:SignedGraphDelegationSource[]=[];
    for(const file of files){if(!/^[a-f0-9]{64}\.json$/.test(file))continue;const raw=readRecord(path.join(dir,file));
      if(!verifyGraphDelegationSource(raw,this.deps.identity,this.deps.agentId).ok)throw new Error('graph-delegation-source-invalid');result.push(raw as SignedGraphDelegationSource);}
    return result;
  }
  private bound(sessionId: string, ref: GraphDelegationConversationRef, token: string): boolean {
    const session = this.deps.state.getSession(sessionId);
    const proof = this.deps.bindAuth.verify(token);
    if (!session || session.status !== 'running' || !proof || proof.sessionName !== session.tmuxSession) return false;
    const boundIds = this.deps.conversationIdsForSession(session.tmuxSession);
    return proof.bootstrapConversationIds.some((id) => {
      if (!boundIds.includes(id)) return false;
      const resolved = this.deps.conversations.resolve(id);
      if (!resolved || resolved.platform !== ref.platform) return false;
      if (ref.platform === 'telegram' && resolved.platform === 'telegram') return this.deps.telegramChatId === ref.chatId
        && resolved.topicId === ref.topicId && (session.telegramTopicId === undefined || session.telegramTopicId === ref.topicId);
      if (ref.platform === 'slack' && resolved.platform === 'slack') return resolved.channelId === ref.channelId
        && (resolved.threadTs ?? null) === (ref.threadTs ?? null) && (session.slackChannelId === undefined || session.slackChannelId === ref.channelId);
      return ref.platform === 'app' && resolved.platform === 'app' && resolved.conversationKey === ref.conversationKey;
    });
  }

  captureSuccessfulSpawn(input: DelegationCaptureInput): { status: 'captured-local'; source: SignedGraphDelegationSource } | { status: 'refused'; reason: string } {
    if (!safeId(input.sourceId) || !safeId(input.parentSessionId) || !safeId(input.workerSessionId)
      || input.parentSessionId === input.workerSessionId || !validDelegationConversationRef(input.parentRef) || !validDelegationConversationRef(input.workerRef)
      || delegationCanonical(input.parentRef) === delegationCanonical(input.workerRef)) return { status: 'refused', reason: 'invalid-spawn-context' };
    try {
      const current = writer(this.deps);
      if (!current) return { status: 'refused', reason: 'write-admission-required' };
      if (!this.bound(input.parentSessionId, input.parentRef, input.parentBindToken)
        || !this.bound(input.workerSessionId, input.workerRef, input.workerBindToken)) return { status: 'refused', reason: 'session-bootstrap-proof-required' };
      const parentOwner = this.deps.ownershipForConversation(input.parentRef);
      const workerOwner = this.deps.ownershipForConversation(input.workerRef);
      if (!parentOwner || !workerOwner || !validDelegationOwnership(delegationOwnershipSnapshot(parentOwner))
        || !validDelegationOwnership(delegationOwnershipSnapshot(workerOwner)) || parentOwner.ownerMachineId !== current.machineId
        || workerOwner.ownerMachineId !== current.machineId) return { status: 'refused', reason: 'session-ownership-required' };
      const parentOwnership = delegationOwnershipSnapshot(parentOwner), workerOwnership = delegationOwnershipSnapshot(workerOwner);
      const parentProjectId = this.deps.projectForConversation(input.parentRef);
      const workerProjectId = this.deps.projectForConversation(input.workerRef);
      if (parentProjectId !== null && workerProjectId !== null && parentProjectId !== workerProjectId) return { status: 'refused', reason: 'project-scope-mismatch' };
      if ((parentProjectId !== null && !safeId(parentProjectId)) || (workerProjectId !== null && !safeId(workerProjectId))) return { status: 'refused', reason: 'invalid-project-scope' };
      const dir = path.join(this.deps.state.baseDir, 'state', 'conversation-graph-delegation-sources');
      const file = path.join(dir, `${digest({ agentId: this.deps.agentId, sourceId: input.sourceId })}.json`);
      const sameIntent = (old: SignedGraphDelegationSource) => old.agentId === this.deps.agentId && old.sourceId === input.sourceId
        && old.parentSessionId === input.parentSessionId && old.workerSessionId === input.workerSessionId
        && delegationCanonical(old.parentRef) === delegationCanonical(input.parentRef) && delegationCanonical(old.workerRef) === delegationCanonical(input.workerRef)
        && delegationCanonical(old.parentOwnership) === delegationCanonical(parentOwnership)
        && delegationCanonical(old.workerOwnership) === delegationCanonical(workerOwnership) && old.parentProjectId === parentProjectId && old.workerProjectId === workerProjectId;
      if (fs.existsSync(file)) {
        const old = readRecord(file) as SignedGraphDelegationSource;
        const verified = verifyGraphDelegationSource(old, this.deps.identity, this.deps.agentId);
        return verified.ok && sameIntent(old) ? { status: 'captured-local', source: old } : { status: 'refused', reason: 'source-id-conflict' };
      }
      const core: GraphDelegationSourceCore = {
        version: 1, kind: 'successful-session-spawn', sourceId: input.sourceId, agentId: this.deps.agentId,
        parentSessionId: input.parentSessionId, workerSessionId: input.workerSessionId,
        parentRef: structuredClone(input.parentRef), workerRef: structuredClone(input.workerRef), parentOwnership, workerOwnership, parentProjectId, workerProjectId,
        sourceMachineId: current.machineId, sourceKeyEpoch: current.keyEpoch, sourceEpoch: current.lease.epoch,
        capturedAt: new Date((this.deps.now ?? Date.now)()).toISOString(), lease: structuredClone(current.lease),
      };
      const source = { ...core, signature: sign(sourceBytes(core), this.deps.identity.loadSigningKey()) };
      if (!verifyGraphDelegationSource(source, this.deps.identity, this.deps.agentId).ok) return { status: 'refused', reason: 'source-signature-self-check-failed' };
      durableCreate(file, source);
      return { status: 'captured-local', source };
    } catch { return { status: 'refused', reason: 'source-capture-unavailable' }; }
  }
}

export interface DelegationIngressDeps extends DelegationBaseDeps {
  stateDir: string;
  /** Must read canonical VERIFIED heads from the graph store, never request data. */
  verifiedHeadsFor: (worker: GraphDelegationConversationRef) => DelegationPlacementHead[];
  /** Nearest ancestor effort scope, read from the same authorized graph snapshot. */
  parentProjectScope: (parent: GraphDelegationConversationRef) => string[];
  /** Live binding lookup; a signed old project binding does not authorize a new one. */
  currentProjectForConversation: (ref: GraphDelegationConversationRef) => string | null;
}

export class ConversationGraphDelegationIngress {
  constructor(private readonly deps: DelegationIngressDeps) {}

  private preparedFile(sourceId: string): string {
    return path.join(this.deps.stateDir, 'state', 'conversation-graph-delegation-prepared',
      `${digest({ agentId: this.deps.agentId, sourceId })}.json`);
  }

  /** Repair reads a locally prepared intent; this is not a committed-state read. */
  readPrepared(sourceId: string): Extract<DelegationResult, { status: 'proposed' }> | null {
    if (!safeId(sourceId)) return null;
    try {
      const value = readRecord(this.preparedFile(sourceId)) as Extract<DelegationResult, { status: 'proposed' }>;
      return value.status === 'proposed' && value.source.agentId === this.deps.agentId && value.source.sourceId === sourceId
        && verifyGraphDelegationAuthorization(value.core, value.authorizationReceipt, value.source, this.deps.identity) ? value : null;
    } catch (error) { if((error as NodeJS.ErrnoException).code!=='ENOENT'){DegradationReporter.getInstance().report({feature:'Conversations.delegation',primary:'Verified delegation intake',fallback:'Retain pending source without claiming Saved',reason:'delegation-intake-unavailable',impact:'Delegation remains unavailable until repair',internalOnly:true});} return null; }
  }

  prepare(raw: unknown): DelegationResult {
    try {
      const verified = verifyGraphDelegationSource(raw, this.deps.identity, this.deps.agentId);
      if (!verified.ok) return { status: 'refused', reason: verified.reason };
      const current = writer(this.deps);
      if (!current) return { status: 'refused', reason: 'write-admission-required' };
      const { core: source } = verified;
      // Historical source verification is useful for repair. NEW intake needs a
      // current writer/source epoch; historical graph receipts replay elsewhere.
      if (source.sourceEpoch !== current.lease.epoch || source.sourceMachineId !== current.machineId) return { status: 'refused', reason: 'source-epoch-fenced' };
      const parentOwner = this.deps.ownershipForConversation(source.parentRef), workerOwner = this.deps.ownershipForConversation(source.workerRef);
      if (!parentOwner || !workerOwner || delegationCanonical(delegationOwnershipSnapshot(parentOwner)) !== delegationCanonical(source.parentOwnership)
        || delegationCanonical(delegationOwnershipSnapshot(workerOwner)) !== delegationCanonical(source.workerOwnership))
        return { status: 'refused', reason: 'source-session-ownership-changed' };
      const parentProject = this.deps.currentProjectForConversation(source.parentRef);
      const workerProject = this.deps.currentProjectForConversation(source.workerRef);
      if (parentProject !== source.parentProjectId || workerProject !== source.workerProjectId) return { status: 'refused', reason: 'source-project-binding-changed' };
      const scope = this.deps.parentProjectScope(source.parentRef);
      if (workerProject && scope.length && !scope.includes(workerProject)) return { status: 'refused', reason: 'project-scope-mismatch' };
      const heads = this.deps.verifiedHeadsFor(source.workerRef);
      if (heads.some((h) => h.authority === 'owner')) return { status: 'suggestion', sourceId: source.sourceId, reason: 'owner-placement-exists' };
      if (heads.some((h) => h.authority !== 'delegation')) return { status: 'suggestion', sourceId: source.sourceId, reason: 'non-agent-placement-exists' };
      if (heads.some((h) => !safeId(h.eventId))) return { status: 'refused', reason: 'invalid-head-evidence' };
      const file = this.preparedFile(source.sourceId);
      if (fs.existsSync(file)) {
        const prepared = this.readPrepared(source.sourceId);
        return prepared && prepared.authorizationReceipt.sourceHash === verified.hash ? prepared : { status: 'refused', reason: 'prepared-source-conflict' };
      }
      const core: GraphDelegationPlacementCore = {
        schemaVersion: 1, eventId: `delegation-${digest({ agentId: source.agentId, sourceId: source.sourceId })}`,
        op: 'set-primary-placement', subject: structuredClone(source.workerRef), parent: structuredClone(source.parentRef), relation: 'delegates-to',
        replacesPlacementEventIds: [...new Set(heads.map((h) => h.eventId))].sort(), principal: 'internal-session-spawn',
        authority: 'delegation', receipt: { kind: 'dispatch-record', id: source.sourceId }, machineId: source.sourceMachineId,
        createdAt: source.capturedAt,
      };
      const receipt: Omit<GraphDelegationAuthorizationReceipt, 'signature'> = {
        version: 1, authMethod: 'verified-live-spawn', acceptingMachineId: current.machineId, keyEpoch: current.keyEpoch,
        admissionEpoch: current.lease.epoch, idempotencyKey: `${source.agentId}:${source.sourceId}`,
        coreHash: digest(core), sourceHash: verified.hash, leaseHash: digest(current.lease),
        acceptingLease: structuredClone(current.lease),
      };
      const proposed: Extract<DelegationResult, { status: 'proposed' }> = { status: 'proposed', core, authorizationReceipt: { ...receipt,
        signature: sign(receiptBytes(receipt), this.deps.identity.loadSigningKey()) }, source: structuredClone(raw) as SignedGraphDelegationSource };
      durableCreate(file, proposed);
      return proposed;
    } catch { DegradationReporter.getInstance().report({feature:'Conversations.delegation',primary:'Verified delegation intake',fallback:'Retain pending source without claiming Saved',reason:'delegation-intake-unavailable',impact:'Delegation remains unavailable until repair',internalOnly:true}); return { status: 'refused', reason: 'delegation-intake-unavailable' }; }
  }
}

export function verifyGraphDelegationAuthorization(core: GraphDelegationPlacementCore, receipt: GraphDelegationAuthorizationReceipt,
  source: SignedGraphDelegationSource, identity: MachineIdentityManager): boolean {
  try {
    const verified = verifyGraphDelegationSource(source, identity, source.agentId);
    if (!verified.ok || !validPlacementCore(core) || !exactKeys(receipt as unknown as Record<string, unknown>, ['version', 'authMethod', 'acceptingMachineId', 'keyEpoch', 'admissionEpoch', 'idempotencyKey', 'coreHash', 'sourceHash', 'leaseHash', 'acceptingLease', 'signature']) || core.op !== 'set-primary-placement' || core.relation !== 'delegates-to'
      || core.authority !== 'delegation' || core.principal !== 'internal-session-spawn' || core.machineId !== source.sourceMachineId
      || delegationCanonical(core.subject) !== delegationCanonical(source.workerRef) || delegationCanonical(core.parent) !== delegationCanonical(source.parentRef)
      || core.eventId !== `delegation-${digest({ agentId: source.agentId, sourceId: source.sourceId })}`
      || receipt.coreHash !== digest(core) || receipt.sourceHash !== verified.hash || receipt.admissionEpoch !== source.sourceEpoch
      || receipt.idempotencyKey !== `${source.agentId}:${source.sourceId}` || receipt.acceptingMachineId !== source.sourceMachineId
      || !validLease(receipt.acceptingLease) || receipt.acceptingLease.holder !== receipt.acceptingMachineId
      || receipt.acceptingLease.epoch !== receipt.admissionEpoch || receipt.leaseHash !== digest(receipt.acceptingLease)
      || receipt.authMethod !== 'verified-live-spawn') return false;
    const keys = new IdentityStore({ stateDir: identity.baseDir }).signingKeyHistory(receipt.acceptingMachineId);
    const key = keys.find((k) => k.epoch === receipt.keyEpoch);
    if (!key) return false;
    const { signature, ...unsigned } = receipt;
    const pem = base64ToSigningPem(key.publicKey);
    return verifyGraphDelegationCoreSource(core, source, pem, source.agentId, source.sourceMachineId)
      && verify(FencedLease.canonicalize(receipt.acceptingLease), receipt.acceptingLease.signature, pem)
      && verify(receiptBytes(unsigned), signature, pem);
  } catch { /* @silent-fallback-ok — invalid delegation signature or authority is a negative verification result. */ return false; }
}

/** Bridge the verified local ingress into the ONE replication/witness receipt
 * schema. It does not create a packet, acknowledge Saved, or certify a commit. */
export function buildGraphDelegationAuthorizationProof(proposed: Extract<DelegationResult, { status: 'proposed' }>, options: {
  identity: MachineIdentityManager;
  membership: GraphMembershipEpoch;
  lease: GraphWitnessLease;
  originalLease: LeaseRecord;
  ownerPublicKey: crypto.KeyLike;
  acceptedAt: string;
}): GraphAuthorizationProof & { dispatchSource: SignedGraphDelegationSource } {
  const { core, authorizationReceipt: local, source } = proposed;
  const id = options.identity.loadIdentity();
  if (!verifyGraphDelegationAuthorization(core, local, source, options.identity)
    || !verifyMembershipEpoch(options.membership, options.ownerPublicKey)
    || !verifyFencedLeaseBridge(options.lease, options.originalLease, options.membership)
    || options.membership.agentId !== source.agentId
    || !options.membership.members.some((member) => member.machineId === id.machineId
      && member.signingPublicKey === options.identity.getSigningPublicKeyPem(id.machineId))
    || options.lease.writerId !== id.machineId || options.lease.leaseEpoch !== source.sourceEpoch
    || !iso(options.acceptedAt) || Date.parse(options.acceptedAt) < Date.parse(options.originalLease.acquiredAt)
    || Date.parse(options.acceptedAt) >= Date.parse(options.originalLease.expiresAt)) throw new Error('graph-delegation-replication-proof-invalid');
  const unsigned: Omit<GraphAuthorizationReceipt, 'signature'> = {
    v: 1, agentId: source.agentId, eventId: graphOperationKey('graph-event',core.eventId), coreHash: canonicalHash(core), actorPrincipal: core.principal,
    receiptId: core.receipt.id,
    authenticationMethod: 'dispatch', membershipEpoch: options.membership.epoch, leaseEpoch: options.lease.leaseEpoch,
    idempotencyKey: local.idempotencyKey, writerId: id.machineId, fencedLeaseHash: canonicalHash(options.originalLease), acceptedAt: options.acceptedAt,
  };
  const receipt: GraphAuthorizationReceipt = { ...unsigned,
    signature: signGraphRecord('graph-authorization-receipt-v1', unsigned, options.identity.loadSigningKey()) };
  return { receipt, membership: options.membership, lease: options.lease, originalLease: options.originalLease, dispatchSource: source };
}
