/** Cross-machine live spawn provenance. Requester and worker sign separately;
 * the admitted graph writer never pretends to originate a remote source.
 *
 * Transport: existing recipient-bound MeshRpc deliverMessage carries the narrow
 * request at payload.graphDelegationRequest. A successful remote spawn callback
 * supplies the ORIGINAL envelope, not a caller's verified:true assertion. No
 * bootstrap HMAC secret/token, prompt or transcript crosses this proof boundary.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { StateManager } from './StateManager.js';
import type { ConversationRegistry } from './ConversationRegistry.js';
import type { ConversationBindAuth } from './conversationBindToken.js';
import type { LeaseCoordinator } from './LeaseCoordinator.js';
import type { WriteAdmission } from './WriteAdmission.js';
import type { SessionOwnershipRecord } from './SessionOwnership.js';
import type { LeaseRecord } from './types.js';
import { MachineIdentityManager, verify } from './MachineIdentity.js';
import { FencedLease } from './FencedLease.js';
import { canonicalizeEnvelope, type MeshEnvelope } from './MeshRpc.js';
import { canonicalHash, canonicalJson, graphOperationKey, signGraphRecord, verifyGraphRecord, unsigned, verifyMembershipEpoch, verifyFencedLeaseBridge,
  type GraphMembershipEpoch, type GraphWitnessLease } from './GraphWitnessTypes.js';
import { validDelegationConversationRef, validDelegationOwnership, delegationOwnershipSnapshot, type DelegationOwnershipSnapshot, type GraphDelegationConversationRef, type GraphDelegationPlacementCore,
  type DelegationPlacementHead } from './ConversationGraphDelegation.js';
import type { GraphAuthorizationProof, GraphAuthorizationReceipt } from './ConversationGraphReplicationProof.js';

const REQUEST_DOMAIN = 'graph-remote-spawn-request-v1';
const ADMISSION_DOMAIN = 'graph-remote-dispatch-admission-v1';
const ATTESTATION_DOMAIN = 'graph-remote-spawn-attestation-v1';
const CLOCK_TOLERANCE_MS = 30000;
const REQUEST_LIFETIME_MS = 120000;
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(v);
const at = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const keys = (value: unknown, expected: string[]) => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === expected.sort().join(',');
function originalLeaseValid(lease: LeaseRecord): boolean {
  return !!lease && keys(lease, ['holder', 'epoch', 'acquiredAt', 'expiresAt', 'nonce', 'signature', ...(lease.released === undefined ? [] : ['released'])])
    && id(lease.holder) && Number.isSafeInteger(lease.epoch) && lease.epoch > 0 && at(lease.acquiredAt) && at(lease.expiresAt)
    && Number.isSafeInteger(lease.nonce) && lease.nonce >= 0 && (lease.released === undefined || lease.released === false) && typeof lease.signature === 'string';
}

export interface RemoteGraphDelegationRequest {
  version: 1; kind: 'remote-spawn-request'; sourceId: string; agentId: string;
  membershipEpoch: number; membershipHash: string;
  requesterMachineId: string; targetMachineId: string; parentSessionId: string;
  parentRef: GraphDelegationConversationRef; workerRef: GraphDelegationConversationRef;
  parentOwnership: DelegationOwnershipSnapshot;
  workerOwnershipAtDispatch: Omit<DelegationOwnershipSnapshot, 'status'> & {status:'active'|'placing'};
  parentProjectId: string | null; requestedAt: string; expiresAt: string;
  graphLease: LeaseRecord; signature: string;
}
export interface RemoteGraphDelegationAttestation {
  version: 1; kind: 'remote-spawn-completed'; sourceId: string; agentId: string;
  membershipEpoch: number; membershipHash: string; requestHash: string;
  requesterMachineId: string; targetMachineId: string; workerSessionId: string;
  workerProjectId: string | null; workerRef: GraphDelegationConversationRef;
  ownership: { sessionKey: string; ownerMachineId: string; ownershipEpoch: number; status: 'active'; updatedAt: string };
  meshEnvelopeHash: string; workerStartedAt:string; capturedAt: string; signature: string;
}
export interface RemoteGraphDispatchAdmission {
 version:1;kind:'remote-dispatch-admission';sourceId:string;agentId:string;membershipEpoch:number;membershipHash:string;
 requestHash:string;requesterMachineId:string;targetMachineId:string;sessionKey:string;ownershipEpoch:number;
 envelopeHash:string;nonceHash:string;envelopeTimestamp:number;acceptedAt:string;signature:string;
}
export interface SignedRemoteGraphDelegationSource {
  version: 1; kind: 'remote-delegation-source';
  request: RemoteGraphDelegationRequest; admission:RemoteGraphDispatchAdmission; attestation: RemoteGraphDelegationAttestation;
}

function writeOnce(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const dir = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
function read(file: string): unknown {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 2 || size > 64 * 1024) throw new Error('remote-delegation-record-size');
    const bytes = Buffer.alloc(size + 1); const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (count !== size) throw new Error('remote-delegation-record-changed');
    return JSON.parse(bytes.subarray(0, count).toString());
  } finally { fs.closeSync(fd); }
}

function validDispatchOwnership(value: unknown): value is RemoteGraphDelegationRequest['workerOwnershipAtDispatch'] {
  if (!value || typeof value !== 'object') return false;
  const v=value as RemoteGraphDelegationRequest['workerOwnershipAtDispatch'];
  return (v.status==='active'||v.status==='placing') && validDelegationOwnership({...v,status:'active'});
}
function completesDispatch(request: RemoteGraphDelegationRequest, active: DelegationOwnershipSnapshot): boolean {
  const dispatched=request.workerOwnershipAtDispatch;
  return active.sessionKey===dispatched.sessionKey && active.ownerMachineId===dispatched.ownerMachineId
    && active.status==='active' && (dispatched.status==='active' ? same(active,dispatched)
      : active.ownershipEpoch===dispatched.ownershipEpoch+1 && Date.parse(active.updatedAt)>=Date.parse(dispatched.updatedAt));
}
function requestValid(request: RemoteGraphDelegationRequest, membership: GraphMembershipEpoch): boolean {
  try {
    const member = membership.members.find((m) => m.machineId === request.requesterMachineId);
    const writer = membership.members.find((m) => m.machineId === request.graphLease?.holder);
    return keys(request, ['version', 'kind', 'sourceId', 'agentId', 'membershipEpoch', 'membershipHash', 'requesterMachineId', 'targetMachineId',
      'parentSessionId', 'parentRef', 'workerRef', 'parentOwnership', 'workerOwnershipAtDispatch', 'parentProjectId', 'requestedAt', 'expiresAt', 'graphLease', 'signature'])
      && !!member && !!writer && membership.members.some((m) => m.machineId === request.targetMachineId)
      && request.requesterMachineId !== request.targetMachineId
      && request.version === 1 && request.kind === 'remote-spawn-request' && id(request.sourceId) && request.agentId === membership.agentId
      && request.membershipEpoch === membership.epoch && request.membershipHash === canonicalHash(membership)
      && validDispatchOwnership(request.workerOwnershipAtDispatch) && request.workerOwnershipAtDispatch.ownerMachineId === request.targetMachineId
      && validDelegationOwnership(request.parentOwnership) && request.parentOwnership.ownerMachineId === request.requesterMachineId
      && id(request.parentSessionId) && validDelegationConversationRef(request.parentRef) && validDelegationConversationRef(request.workerRef)
      && !same(request.parentRef, request.workerRef) && (request.parentProjectId === null || id(request.parentProjectId))
      && at(request.requestedAt) && at(request.expiresAt) && Date.parse(request.expiresAt) - Date.parse(request.requestedAt) === REQUEST_LIFETIME_MS
      && originalLeaseValid(request.graphLease) && request.graphLease.holder === writer.machineId && request.graphLease.released !== true
      && Number.isSafeInteger(request.graphLease.epoch) && request.graphLease.epoch > 0
      && Date.parse(request.requestedAt) >= Date.parse(request.graphLease.acquiredAt)
      && Date.parse(request.requestedAt) < Date.parse(request.graphLease.expiresAt)
      && verify(FencedLease.canonicalize(request.graphLease), request.graphLease.signature, writer.signingPublicKey)
      && verifyGraphRecord(REQUEST_DOMAIN, unsigned(request), request.signature, member.signingPublicKey);
  } catch { /* @silent-fallback-ok — malformed or untrusted delegation evidence is rejected, never default authority. */ return false; }
}

export function verifyDispatchAdmission(a:RemoteGraphDispatchAdmission,r:RemoteGraphDelegationRequest,m:GraphMembershipEpoch):boolean {
 try {const key=m.members.find(member=>member.machineId===r.targetMachineId)?.signingPublicKey;
 return keys(a,['version','kind','sourceId','agentId','membershipEpoch','membershipHash','requestHash','requesterMachineId','targetMachineId','sessionKey','ownershipEpoch','envelopeHash','nonceHash','envelopeTimestamp','acceptedAt','signature'])
 &&!!key&&requestValid(r,m)&&a.version===1&&a.kind==='remote-dispatch-admission'&&a.sourceId===r.sourceId&&a.agentId===r.agentId
 &&a.membershipEpoch===m.epoch&&a.membershipHash===canonicalHash(m)&&a.requestHash===canonicalHash(r)
 &&a.requesterMachineId===r.requesterMachineId&&a.targetMachineId===r.targetMachineId&&a.sessionKey===r.workerOwnershipAtDispatch.sessionKey
 &&a.ownershipEpoch===r.workerOwnershipAtDispatch.ownershipEpoch&&/^[a-f0-9]{64}$/.test(a.envelopeHash)&&/^[a-f0-9]{64}$/.test(a.nonceHash)
 &&Number.isSafeInteger(a.envelopeTimestamp)&&at(a.acceptedAt)&&Math.abs(Date.parse(a.acceptedAt)-a.envelopeTimestamp)<=CLOCK_TOLERANCE_MS
 &&Date.parse(a.acceptedAt)>=Date.parse(r.requestedAt)-CLOCK_TOLERANCE_MS&&Date.parse(a.acceptedAt)<=Date.parse(r.expiresAt)+CLOCK_TOLERANCE_MS
 &&verifyGraphRecord(ADMISSION_DOMAIN,unsigned(a),a.signature,key);
 }catch{/* @silent-fallback-ok — malformed delegation proof is a negative validation result. */return false;}
}

/** Historical source validation uses the owner-pinned membership snapshot. It
 * intentionally does not consult today's clock, allowing delayed valid replay. */
export function verifyRemoteGraphDelegationSource(source: unknown, membership: GraphMembershipEpoch): source is SignedRemoteGraphDelegationSource {
  try {
    const s = source as SignedRemoteGraphDelegationSource;
    if (!keys(s, ['version', 'kind', 'request', 'admission', 'attestation']) || s.version !== 1 || s.kind !== 'remote-delegation-source' || !requestValid(s.request, membership)) return false;
    const a = s.attestation; const r = s.request;
    if(!verifyDispatchAdmission(s.admission,r,membership))return false;
    const worker = membership.members.find((m) => m.machineId === r.targetMachineId);
    return keys(a, ['version', 'kind', 'sourceId', 'agentId', 'membershipEpoch', 'membershipHash', 'requestHash', 'requesterMachineId',
      'targetMachineId', 'workerSessionId', 'workerProjectId', 'workerRef', 'ownership', 'meshEnvelopeHash', 'workerStartedAt', 'capturedAt', 'signature'])
      && !!worker && a.version === 1 && a.kind === 'remote-spawn-completed' && a.agentId === r.agentId && a.sourceId === r.sourceId
      && a.membershipEpoch === membership.epoch && a.membershipHash === canonicalHash(membership) && a.requestHash === canonicalHash(r)
      && a.requesterMachineId === r.requesterMachineId && a.targetMachineId === r.targetMachineId && id(a.workerSessionId)
      && a.workerSessionId !== r.parentSessionId && validDelegationConversationRef(a.workerRef) && same(a.workerRef, r.workerRef)
      && (a.workerProjectId === null || id(a.workerProjectId)) && at(a.capturedAt)
      && at(a.workerStartedAt) && Date.parse(a.workerStartedAt)>=Date.parse(r.requestedAt)-CLOCK_TOLERANCE_MS
      && Date.parse(a.workerStartedAt)<=Date.parse(r.expiresAt)+CLOCK_TOLERANCE_MS && Date.parse(a.capturedAt)>=Date.parse(a.workerStartedAt)
      && a.meshEnvelopeHash===s.admission.envelopeHash && /^[0-9a-f]{64}$/.test(a.meshEnvelopeHash) && validDelegationOwnership(a.ownership)
      && a.ownership.status === 'active' && a.ownership.ownerMachineId === worker.machineId && completesDispatch(r,a.ownership)
      && typeof a.ownership.sessionKey === 'string' && a.ownership.sessionKey.length > 0 && a.ownership.sessionKey.length <= 200
      && Number.isSafeInteger(a.ownership.ownershipEpoch) && a.ownership.ownershipEpoch > 0 && at(a.ownership.updatedAt)
      && verifyGraphRecord(ATTESTATION_DOMAIN, unsigned(a), a.signature, worker.signingPublicKey);
  } catch { /* @silent-fallback-ok — malformed or untrusted delegation evidence is rejected, never default authority. */ return false; }
}

export function verifyRemoteGraphDelegationCoreSource(core: unknown, raw: unknown, membership: GraphMembershipEpoch, expectedWriterId: string): boolean {
  if (!verifyRemoteGraphDelegationSource(raw, membership) || !core || typeof core !== 'object') return false;
  const c = core as GraphDelegationPlacementCore; const r = raw.request;
  return keys(c, ['schemaVersion', 'eventId', 'op', 'subject', 'parent', 'relation', 'replacesPlacementEventIds',
    'authority', 'principal', 'receipt', 'machineId', 'createdAt'])
    && c.schemaVersion === 1 && c.op === 'set-primary-placement' && c.relation === 'delegates-to'
    && c.authority === 'delegation' && c.principal === 'remote-session-spawn' && c.machineId === expectedWriterId
    && c.eventId === `delegation-${canonicalHash({ agentId: r.agentId, sourceId: r.sourceId })}`
    && same(c.subject, r.workerRef) && same(c.parent, r.parentRef) && same(c.receipt, { kind: 'dispatch-record', id: r.sourceId })
    && c.createdAt === raw.attestation.capturedAt && Array.isArray(c.replacesPlacementEventIds) && c.replacesPlacementEventIds.every(id);
}

export interface RemoteDelegationCaptureDeps {
  agentId: string; identity: MachineIdentityManager; state: StateManager;
  bindAuth: ConversationBindAuth; conversations: ConversationRegistry;
  telegramChatId: string | null; conversationIdsForSession: (tmux: string) => readonly number[];
  projectForConversation: (ref: GraphDelegationConversationRef) => string | null;
  /** Real local session ownership projection/CAS substrate. */
  ownershipForConversation: (ref: GraphDelegationConversationRef) => SessionOwnershipRecord | null;
  ownerPublicKey: crypto.KeyLike; now?: () => number;
}

export class ConversationGraphRemoteDelegationSource {
  constructor(private readonly deps: RemoteDelegationCaptureDeps) {}
  private file(sourceId: string, stage: 'request' | 'completed' | 'admission'): string {
    return path.join(this.deps.state.baseDir, 'state', 'conversation-graph-remote-delegation',
      `${canonicalHash({ agentId: this.deps.agentId, sourceId })}.${stage}.json`);
  }
  /** Recovery forwards the original immutable source, never a newly invented
   * attestation after the worker has finished or the request has expired. */
  readCaptured(sourceId: string, membership: GraphMembershipEpoch): SignedRemoteGraphDelegationSource | null {
    try {
      if (!id(sourceId) || !verifyMembershipEpoch(membership, this.deps.ownerPublicKey)
        || membership.agentId !== this.deps.agentId) return null;
      const source = read(this.file(sourceId, 'completed'));
      return verifyRemoteGraphDelegationSource(source, membership) && source.request.sourceId === sourceId ? source : null;
    } catch { return null; }
  }
  pendingRequests(membership:GraphMembershipEpoch):RemoteGraphDelegationRequest[]{
    const dir=path.dirname(this.file('probe','request'));if(!fs.existsSync(dir))return [];
    const files=fs.readdirSync(dir);if(files.length>4096)throw new Error('remote-delegation-inventory-bound');
    return files.filter(file=>/^[a-f0-9]{64}\.request\.json$/.test(file)).map(file=>read(path.join(dir,file)) as RemoteGraphDelegationRequest)
      .filter(request=>requestValid(request,membership)&&request.targetMachineId===this.deps.identity.loadIdentity().machineId
       &&fs.existsSync(this.file(request.sourceId,'admission')));
  }
  private bound(sessionId: string, ref: GraphDelegationConversationRef, token: string): boolean {
    const session = this.deps.state.getSession(sessionId); const proof = this.deps.bindAuth.verify(token);
    if (!session || session.status !== 'running' || !proof || proof.sessionName !== session.tmuxSession) return false;
    const bound = this.deps.conversationIdsForSession(session.tmuxSession);
    return proof.bootstrapConversationIds.some((alias) => {
      if (!bound.includes(alias)) return false;
      const d = this.deps.conversations.resolve(alias);
      if (!d || d.platform !== ref.platform) return false;
      if (ref.platform === 'telegram' && d.platform === 'telegram') return ref.chatId === this.deps.telegramChatId && ref.topicId === d.topicId;
      if (ref.platform === 'slack' && d.platform === 'slack') return ref.channelId === d.channelId && (ref.threadTs ?? null) === d.threadTs;
      return ref.platform === 'app' && d.platform === 'app' && ref.conversationKey === d.conversationKey;
    });
  }
  createRequest(input: { sourceId: string; parentSessionId: string; parentBindToken: string;
    parentRef: GraphDelegationConversationRef; workerRef: GraphDelegationConversationRef; targetMachineId: string;
    membership: GraphMembershipEpoch; graphLease: LeaseRecord }): RemoteGraphDelegationRequest {
    const local = this.deps.identity.loadIdentity(); const now = (this.deps.now ?? Date.now)();
    if (!id(input.sourceId) || !validDelegationConversationRef(input.parentRef) || !validDelegationConversationRef(input.workerRef)
      || !verifyMembershipEpoch(input.membership, this.deps.ownerPublicKey) || input.membership.agentId !== this.deps.agentId
      || !this.deps.identity.isMachineActive(local.machineId) || !this.bound(input.parentSessionId, input.parentRef, input.parentBindToken)) throw new Error('remote-delegation-parent-proof-required');
    const ownership = this.deps.ownershipForConversation(input.parentRef);
    if (!ownership || !validDelegationOwnership(delegationOwnershipSnapshot(ownership)) || ownership.ownerMachineId !== local.machineId) throw new Error('remote-delegation-parent-not-owned');
    const workerOwnership=this.deps.ownershipForConversation(input.workerRef);
    const dispatched=workerOwnership ? {sessionKey:workerOwnership.sessionKey,ownerMachineId:workerOwnership.ownerMachineId,ownershipEpoch:workerOwnership.ownershipEpoch,status:workerOwnership.status,updatedAt:workerOwnership.updatedAt} : null;
    if (!validDispatchOwnership(dispatched) || dispatched.ownerMachineId!==input.targetMachineId) throw new Error('remote-delegation-worker-placement-required');
    const file = this.file(input.sourceId, 'request');
    if (fs.existsSync(file)) {
      const existing = read(file) as RemoteGraphDelegationRequest;
      if (!requestValid(existing, input.membership) || existing.parentSessionId !== input.parentSessionId || existing.targetMachineId !== input.targetMachineId
        || !same(existing.parentRef, input.parentRef) || !same(existing.workerRef, input.workerRef)
        || !same(existing.parentOwnership, delegationOwnershipSnapshot(ownership)) || !same(existing.workerOwnershipAtDispatch,dispatched)) throw new Error('remote-delegation-source-conflict');
      return existing;
    }
    const core: Omit<RemoteGraphDelegationRequest, 'signature'> = { version: 1, kind: 'remote-spawn-request', sourceId: input.sourceId,
      agentId: this.deps.agentId, membershipEpoch: input.membership.epoch, membershipHash: canonicalHash(input.membership),
      requesterMachineId: local.machineId, targetMachineId: input.targetMachineId, parentSessionId: input.parentSessionId,
      parentRef: structuredClone(input.parentRef), workerRef: structuredClone(input.workerRef), parentOwnership: delegationOwnershipSnapshot(ownership), workerOwnershipAtDispatch:dispatched, parentProjectId: this.deps.projectForConversation(input.parentRef),
      requestedAt: new Date(now).toISOString(), expiresAt: new Date(now + REQUEST_LIFETIME_MS).toISOString(), graphLease: structuredClone(input.graphLease) };
    const result = { ...core, signature: signGraphRecord(REQUEST_DOMAIN, core, this.deps.identity.loadSigningKey()) };
    if (!requestValid(result, input.membership)) throw new Error('remote-delegation-request-invalid');
    writeOnce(file, result); return result;
  }

  /** Synchronous pre-receipt custody: verifies the complete ORIGINAL frame once,
   * then persists a separately signed content-free receipt. It never claims a
   * stripped frame retains a valid Mesh signature. */
  admitDispatch(input:{request:RemoteGraphDelegationRequest;membership:GraphMembershipEpoch;originalMeshEnvelope:MeshEnvelope}):RemoteGraphDispatchAdmission {
    const local = this.deps.identity.loadIdentity(); const r = input.request; const env = input.originalMeshEnvelope;
    const now = (this.deps.now ?? Date.now)();
    const priorFile=this.file(r.sourceId,'admission');
    const prior=fs.existsSync(priorFile)?read(priorFile) as RemoteGraphDispatchAdmission:null;
    const replay=!!prior&&verifyDispatchAdmission(prior,r,input.membership);
    if (!verifyMembershipEpoch(input.membership, this.deps.ownerPublicKey) || input.membership.agentId !== this.deps.agentId
      || !requestValid(r, input.membership) || !this.deps.identity.isMachineActive(local.machineId) || r.targetMachineId !== local.machineId
      || (!replay&&(now > Date.parse(r.expiresAt) + CLOCK_TOLERANCE_MS || now < Date.parse(r.requestedAt) - CLOCK_TOLERANCE_MS))) throw new Error('remote-delegation-request-refused');
    const parentKey = input.membership.members.find((m) => m.machineId === r.requesterMachineId)?.signingPublicKey;
    const command = env.command;
    if (command.type !== 'deliverMessage' || !parentKey || env.sender !== r.requesterMachineId || env.recipient !== local.machineId || env.epoch !== command.ownershipEpoch
      || command.messageId !== r.sourceId || command.session!==r.workerOwnershipAtDispatch.sessionKey || command.ownershipEpoch!==r.workerOwnershipAtDispatch.ownershipEpoch
      || !verify(canonicalizeEnvelope(env), env.signature, parentKey) || Math.abs(now - env.timestamp) > CLOCK_TOLERANCE_MS
      || !command.payload || typeof command.payload !== 'object'
      || !same((command.payload as Record<string, unknown>).graphDelegationRequest, r)) throw new Error('remote-delegation-mesh-proof-invalid');
    const current=this.deps.ownershipForConversation(r.workerRef);
    if(!replay&&(!current||!(same({...r.workerOwnershipAtDispatch},delegationOwnershipSnapshot(current))||completesDispatch(r,delegationOwnershipSnapshot(current)))))throw new Error('remote-delegation-dispatch-ownership-changed');
    if(!replay)this.deps.projectForConversation(r.workerRef);
    const requestFile=this.file(r.sourceId,'request');
    if(fs.existsSync(requestFile)){if(!same(read(requestFile),r))throw new Error('remote-dispatch-request-conflict');}else writeOnce(requestFile,r);
    const file=this.file(r.sourceId,'admission');
    if(fs.existsSync(file)){const prior=read(file) as RemoteGraphDispatchAdmission;if(!verifyDispatchAdmission(prior,r,input.membership))throw new Error('remote-dispatch-admission-conflict');return prior;}
    const core:Omit<RemoteGraphDispatchAdmission,'signature'>={version:1,kind:'remote-dispatch-admission',sourceId:r.sourceId,agentId:r.agentId,
      membershipEpoch:input.membership.epoch,membershipHash:canonicalHash(input.membership),requestHash:canonicalHash(r),requesterMachineId:r.requesterMachineId,targetMachineId:local.machineId,
      sessionKey:command.session,ownershipEpoch:command.ownershipEpoch,envelopeHash:canonicalHash(env),nonceHash:canonicalHash(env.nonce),envelopeTimestamp:env.timestamp,acceptedAt:new Date(now).toISOString()};
    const result={...core,signature:signGraphRecord(ADMISSION_DOMAIN,core,this.deps.identity.loadSigningKey())};
    if(!verifyDispatchAdmission(result,r,input.membership))throw new Error('remote-dispatch-admission-invalid');writeOnce(file,result);return result;
  }
  attestSuccessfulSpawn(input: { request: RemoteGraphDelegationRequest; membership: GraphMembershipEpoch;
    originalMeshEnvelope?: MeshEnvelope; workerSessionId: string; workerBindToken: string }): SignedRemoteGraphDelegationSource {
    const local=this.deps.identity.loadIdentity();const r=input.request;const now=(this.deps.now??Date.now)();
    const admission=input.originalMeshEnvelope?this.admitDispatch({...input,originalMeshEnvelope:input.originalMeshEnvelope}):read(this.file(r.sourceId,'admission')) as RemoteGraphDispatchAdmission;
    if(!verifyMembershipEpoch(input.membership,this.deps.ownerPublicKey)||!verifyDispatchAdmission(admission,r,input.membership)||local.machineId!==r.targetMachineId)throw new Error('remote-dispatch-admission-invalid');
    const workerSession=this.deps.state.getSession(input.workerSessionId);
    const ownership = this.deps.ownershipForConversation(r.workerRef);
    if (!workerSession || !ownership || ownership.status !== 'active' || ownership.ownerMachineId !== local.machineId
      || admission.sessionKey !== ownership.sessionKey || admission.ownershipEpoch !== r.workerOwnershipAtDispatch.ownershipEpoch
      || !completesDispatch(r,delegationOwnershipSnapshot(ownership))
      || !this.bound(input.workerSessionId, r.workerRef, input.workerBindToken)) throw new Error('remote-delegation-worker-proof-required');
    const file = this.file(r.sourceId, 'completed');
    if (fs.existsSync(file)) {
      const existing = read(file);
      if (!verifyRemoteGraphDelegationSource(existing, input.membership) || existing.attestation.workerSessionId !== input.workerSessionId
        || !same(existing.request, r)) throw new Error('remote-delegation-source-conflict');
      return existing;
    }
    const core: Omit<RemoteGraphDelegationAttestation, 'signature'> = { version: 1, kind: 'remote-spawn-completed', sourceId: r.sourceId,
      agentId: r.agentId, membershipEpoch: input.membership.epoch, membershipHash: canonicalHash(input.membership), requestHash: canonicalHash(r),
      requesterMachineId: r.requesterMachineId, targetMachineId: local.machineId, workerSessionId: input.workerSessionId,
      workerProjectId: this.deps.projectForConversation(r.workerRef), workerRef: structuredClone(r.workerRef),
      ownership: { sessionKey: ownership.sessionKey, ownerMachineId: ownership.ownerMachineId, ownershipEpoch: ownership.ownershipEpoch,
        status: 'active', updatedAt: ownership.updatedAt }, meshEnvelopeHash: admission.envelopeHash, workerStartedAt:workerSession.startedAt, capturedAt: new Date(now).toISOString() };
    const source: SignedRemoteGraphDelegationSource = { version: 1, kind: 'remote-delegation-source', request: r, admission,
      attestation: { ...core, signature: signGraphRecord(ATTESTATION_DOMAIN, core, this.deps.identity.loadSigningKey()) } };
    if (!verifyRemoteGraphDelegationSource(source, input.membership)) throw new Error('remote-delegation-attestation-invalid');
    writeOnce(file, source); return source;
  }
}

export interface RemoteDelegationIngressDeps {
  agentId: string; stateDir: string; identity: MachineIdentityManager; admission: WriteAdmission;
  coordinator: Pick<LeaseCoordinator, 'holdsLease' | 'currentEpoch' | 'currentLease'>;
  ownerPublicKey: crypto.KeyLike; membership: () => GraphMembershipEpoch; leaseBridge: () => GraphWitnessLease;
  verifiedHeadsFor: (ref: GraphDelegationConversationRef) => DelegationPlacementHead[];
  parentProjectScope: (ref: GraphDelegationConversationRef) => string[];
  projectForConversation: (ref: GraphDelegationConversationRef) => string | null;
  ownershipForConversation: (ref: GraphDelegationConversationRef) => SessionOwnershipRecord | null;
  now?: () => number;
}
export type RemoteDelegationResult =
  | { status: 'proposed'; core: GraphDelegationPlacementCore; authorizationProof: GraphAuthorizationProof & { dispatchSource: SignedRemoteGraphDelegationSource } }
  | { status: 'suggestion'; sourceId: string; reason: 'owner-placement-exists' | 'non-agent-placement-exists' }
  | { status: 'refused'; reason: string };

export class ConversationGraphRemoteDelegationIngress {
  constructor(private readonly deps: RemoteDelegationIngressDeps) {}
  prepare(source: SignedRemoteGraphDelegationSource): RemoteDelegationResult {
    try {
      const m = this.deps.membership(); const local = this.deps.identity.loadIdentity(); const r = source.request; const a = source.attestation;
      if (!verifyMembershipEpoch(m, this.deps.ownerPublicKey) || m.agentId !== this.deps.agentId || !verifyRemoteGraphDelegationSource(source, m)) return { status: 'refused', reason: 'remote-source-invalid' };
      const guard = this.deps.admission.guardStoreWrite('conversationGraph.append'); const originalLease = this.deps.coordinator.currentLease(); const bridge = this.deps.leaseBridge();
      if (guard.enforce === 'refuse' || !this.deps.admission.evaluate('cluster-shared').admit || !this.deps.coordinator.holdsLease()
        || !this.deps.identity.isMachineActive(local.machineId) || !originalLease || !m.members.some((member) => member.machineId === local.machineId
          && member.signingPublicKey === this.deps.identity.getSigningPublicKeyPem(local.machineId)) || originalLease.holder !== local.machineId || originalLease.epoch !== this.deps.coordinator.currentEpoch()
        || !verifyFencedLeaseBridge(bridge, originalLease, m)) return { status: 'refused', reason: 'write-admission-required' };
      if (r.graphLease.epoch > originalLease.epoch) return { status: 'refused', reason: 'remote-source-future-epoch' };
      const parent = this.deps.ownershipForConversation(r.parentRef); const worker = this.deps.ownershipForConversation(r.workerRef);
      if (!parent || !same(delegationOwnershipSnapshot(parent), r.parentOwnership) || !worker || worker.status !== 'active'
        || !same(delegationOwnershipSnapshot(worker), a.ownership))
        return { status: 'refused', reason: 'remote-session-ownership-changed' };
      if (this.deps.projectForConversation(r.parentRef) !== r.parentProjectId || this.deps.projectForConversation(r.workerRef) !== a.workerProjectId)
        return { status: 'refused', reason: 'remote-project-binding-changed' };
      const scope = this.deps.parentProjectScope(r.parentRef);
      if (a.workerProjectId && scope.length && !scope.includes(a.workerProjectId)) return { status: 'refused', reason: 'project-scope-mismatch' };
      const heads = this.deps.verifiedHeadsFor(r.workerRef);
      if (heads.some((h) => h.authority === 'owner')) return { status: 'suggestion', sourceId: r.sourceId, reason: 'owner-placement-exists' };
      if (heads.some((h) => h.authority !== 'delegation')) return { status: 'suggestion', sourceId: r.sourceId, reason: 'non-agent-placement-exists' };
      const file = path.join(this.deps.stateDir, 'state', 'conversation-graph-remote-delegation', `${canonicalHash({ agentId: r.agentId, sourceId: r.sourceId })}.prepared.json`);
      if (fs.existsSync(file)) {
        const old = read(file) as Extract<RemoteDelegationResult, { status: 'proposed' }>;
        const proof = old.authorizationProof; const receipt = proof?.receipt;
        const member = m.members.find((member) => member.machineId === local.machineId);
        if (!keys(old, ['status', 'core', 'authorizationProof']) || old.status !== 'proposed'
          || !keys(proof, ['receipt', 'membership', 'lease', 'originalLease', 'dispatchSource'])
          || !keys(receipt, ['v', 'agentId', 'eventId', 'coreHash', 'actorPrincipal', 'authenticationMethod', 'receiptId',
            'membershipEpoch', 'leaseEpoch', 'idempotencyKey', 'writerId', 'fencedLeaseHash', 'acceptedAt', 'signature'])
          || !same(proof.dispatchSource, source) || !same(proof.membership, m)
          || !verifyFencedLeaseBridge(proof.lease, proof.originalLease, proof.membership)
          || !verifyRemoteGraphDelegationCoreSource(old.core, source, m, local.machineId)
          || !receipt || receipt.v !== 1 || receipt.agentId !== r.agentId || receipt.eventId !== graphOperationKey('graph-event',old.core.eventId)
          || receipt.coreHash !== canonicalHash(old.core) || receipt.receiptId !== r.sourceId
          || receipt.actorPrincipal !== 'remote-session-spawn' || receipt.authenticationMethod !== 'dispatch'
          || receipt.membershipEpoch !== m.epoch || receipt.leaseEpoch !== proof.originalLease.epoch || receipt.writerId !== local.machineId
          || receipt.idempotencyKey !== `${r.agentId}:${r.sourceId}` || receipt.fencedLeaseHash !== canonicalHash(proof.originalLease)
          || !at(receipt.acceptedAt) || Date.parse(receipt.acceptedAt) < Date.parse(proof.originalLease.acquiredAt)
          || Date.parse(receipt.acceptedAt) >= Date.parse(proof.originalLease.expiresAt) || !member
          || !verifyGraphRecord('graph-authorization-receipt-v1', unsigned(receipt), receipt.signature, member.signingPublicKey))
          return { status: 'refused', reason: 'remote-prepared-source-conflict' };
        return old;
      }
      const core: GraphDelegationPlacementCore = { schemaVersion: 1, eventId: `delegation-${canonicalHash({ agentId: r.agentId, sourceId: r.sourceId })}`,
        op: 'set-primary-placement', subject: r.workerRef, parent: r.parentRef, relation: 'delegates-to',
        replacesPlacementEventIds: [...new Set(heads.map((h) => h.eventId))].sort(), authority: 'delegation', principal: 'remote-session-spawn',
        receipt: { kind: 'dispatch-record', id: r.sourceId }, machineId: local.machineId, createdAt: a.capturedAt };
      if (core.replacesPlacementEventIds.some((head) => !id(head))) return { status: 'refused', reason: 'invalid-head-evidence' };
      const receipt: Omit<GraphAuthorizationReceipt, 'signature'> = { v: 1, agentId: r.agentId, eventId: graphOperationKey('graph-event',core.eventId), coreHash: canonicalHash(core),
        receiptId: r.sourceId, actorPrincipal: core.principal, authenticationMethod: 'dispatch', membershipEpoch: m.epoch,
        leaseEpoch: originalLease.epoch, idempotencyKey: `${r.agentId}:${r.sourceId}`, writerId: local.machineId,
        fencedLeaseHash: canonicalHash(originalLease), acceptedAt: new Date((this.deps.now ?? Date.now)()).toISOString() };
      const proposed: Extract<RemoteDelegationResult, { status: 'proposed' }> = { status: 'proposed', core, authorizationProof: {
        receipt: { ...receipt, signature: signGraphRecord('graph-authorization-receipt-v1', receipt, this.deps.identity.loadSigningKey()) },
        membership: m, lease: bridge, originalLease, dispatchSource: source } };
      writeOnce(file, proposed); return proposed;
    } catch { return { status: 'refused', reason: 'remote-delegation-intake-unavailable' }; }
  }
}
