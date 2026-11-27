import {verifyGraphMemberLossSettlement,verifyGraphMemberLossActivationPins,type GraphMemberLossActivationPin,type GraphMemberLossSettlementProof} from './GraphMemberLossActivation.js';
import {verifyGraphMemberLossNegativeCustody} from './GraphMemberLossNegativeCustody.js';
import {verifyGraphCustodyAllocationHold,type GraphCustodyHoldIntent,type GraphCustodyAllocationHold} from './GraphCustodyProfileAuthority.js';
import {createGraphNativeSourceUpload,type GraphNativeSourceUploadSigner} from './GraphNativeSourceUpload.js';
import {verifyGraphCustodyRetirement,type GraphCustodyRetirementProof} from './GraphCustodyProfileAuthority.js';
import type {GraphCustodyTransport} from './GraphCustodyTransport.js';
import crypto from 'node:crypto';
import {graphRecoveryUploadId,type GraphRecoveryUploadPlan,validWitnessMaterializationRef,graphWitnessBootstrapCounts,graphWitnessBootstrapPayload,type GraphBootstrapTransferPlan,type GraphBootstrapSection,type GraphWitnessRecoveryContext} from './GraphWitnessService.js';
import {verifyGraphHistoricalMaterializationContext,verifyGraphHistoricalMaterializationEntry,type GraphHistoricalMaterialization} from './ConversationGraphHistoricalMaterialization.js';
import type { LeaseRecord } from './types.js';
import {verifyGraphErasureAuthority,type GraphErasureAuthority,type GraphErasureActiveEndorsement,verifyGraphErasureWitnessPurge,type GraphErasureWitnessPurgeReceipt,verifyGraphErasureIngress,verifyGraphErasurePlan,verifyGraphErasureMemberReceipt,type GraphErasureIngress,type GraphErasureFleetStatus,type GraphErasureMemberReceipt} from './GraphErasureProtocol.js';
import {verifyGraphControlCapsule,verifyGraphWitnessCustody} from './GraphWitnessControl.js';
import type { GraphWitnessPrepareRequest, GraphWitnessOperation, GraphWitnessAdoptionRequest, GraphWitnessRecoveryRequest, GraphWitnessBootstrapRequest,GraphWitnessArchive } from './GraphWitnessService.js';
import { verifyFencedLeaseBridge,graphRewrapInventoryHash,erasureCoversPacket,sameGraphErasureIdentity,verifyBundleRewrap, canonicalHash, verifyBackupErasureAttestation, verifyWitnessInventory, exactFields, GRAPH_SIGNATURE_DOMAINS as D, unsigned, verifyCommitCertificate, verifyCancellationCertificate, verifyGraphRecord, verifyMembershipEpoch, verifyMemberReceipt, verifyWitnessCancellation, verifyWitnessErasure, verifyAdoptionCertificate, verifyMembershipActivation, validateRecoverySourceManifest,
  type GraphErasureIdentity,type GraphCommitCertificate, type GraphCancellationCertificate, type GraphEncryptedBundle, type GraphMemberReceipt, type GraphMembershipEpoch,
  type GraphWitnessCancellation, type GraphWitnessErasure, type GraphWitnessLease, type GraphWitnessPrepareProof, type GraphAdoptionCertificate,
  type GraphMembershipActivationCertificate, type GraphRecoverySourceManifest } from './GraphWitnessTypes.js';

export interface GraphWitnessClientOptions {
  baseUrl?: string; transport?:GraphCustodyTransport; agentId: string; bearerToken: string; witnessId: string; witnessPublicKey: string;
  expectedFailureDomain: string; timeoutMs?: number;
  ownerPublicKey?: string;
  backupPolicyAuditorPublicKey?: string;
  historicalWitnessPublicKeys?:Record<string,string>;
  /** Explicit test-only loopback transport. Never accepted for a remote failure-domain proof. */
  allowLoopbackHttpForTests?: boolean;
}
function freezeWitnessValue<T>(value:T):T{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freezeWitnessValue(child);Object.freeze(value);}return value;}
export class GraphWitnessClient {
  private readonly base: string;
  private remoteBackupEvidence:import('./GraphWitnessTypes.js').GraphBackupErasureAttestation[]=[];
  backupPolicyEvidence():import('./GraphWitnessTypes.js').GraphBackupErasureAttestation[]{return structuredClone(this.remoteBackupEvidence);}
  private readonly recoveryContexts=new Map<number,GraphWitnessRecoveryContext>();
  private readonly contextBindings=new Map<number,{hashes:Record<string,string>;entries:Map<string,GraphRecoverySourceManifest['entries'][number]>;keys:Map<string,GraphHistoricalMaterialization['rewrapInventory'][number]>}>();
  private readonly activations=new Map<number,GraphMembershipActivationCertificate|null>();
  private readonly memberships = new Map<number, GraphMembershipEpoch>();
  constructor(private readonly options: GraphWitnessClientOptions) {
    const {transport,...pins}=options;this.options=freezeWitnessValue({...structuredClone(pins),...(transport?{transport}: {})});
    if(transport){if(transport.agentId!==options.agentId||transport.witnessId!==options.witnessId)throw new Error('custody-transport-scope-invalid');this.base='';return;}
    if(!this.options.baseUrl)throw new Error('witness-url-required');
    const url = new URL(this.options.baseUrl);
    if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('witness-url-invalid');
    if (url.protocol !== 'https:' && !(options.allowLoopbackHttpForTests && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('witness-https-required');
    this.base = url.origin;
  }
  private witnessKey(id:string):string {
    const key=id===this.options.witnessId?this.options.witnessPublicKey:this.options.historicalWitnessPublicKeys?.[id];
    if(!key)throw new Error('witness-historical-key-unpinned');return key;
  }
  private prefix(): string { return `/v1/agents/${encodeURIComponent(this.options.agentId)}`; }
  private async request<T>(path: string, body?: unknown): Promise<T> {
    if(this.options.transport){const response=await this.options.transport.request(body===undefined?'GET':'POST',path,body);if(Buffer.byteLength(response.json)>3*1024*1024)throw new Error('witness-response-too-large');const value=JSON.parse(response.json);if(response.status<200||response.status>=300)throw new Error(typeof value.code==='string'?value.code:'witness-request-refused');return value as T;}
    const response = await fetch(this.base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${this.options.bearerToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error',
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 10000) });
    const reader = response.body?.getReader();
    if (!reader) throw new Error('witness-response-unreadable');
    const chunks: Uint8Array[] = []; let length = 0;
    while (true) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.byteLength;
      if (length > 3 * 1024 * 1024) { await reader.cancel(); throw new Error('witness-response-too-large'); }
      chunks.push(next.value);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as T & { code?: string };
    if (!response.ok) throw new Error(typeof data.code === 'string' ? data.code : 'witness-request-refused');
    return data;
  }
  async verifyRemote(): Promise<void> {
    const result = await this.request<{ witnessId: string; publicKey: string; failureDomain: string }>('/health');
    if (result.witnessId !== this.options.witnessId || result.publicKey !== this.options.witnessPublicKey || result.failureDomain !== this.options.expectedFailureDomain) throw new Error('witness-identity-mismatch');
  }
  private verifyProfilePin(membership:GraphMembershipEpoch):void{
    const profile=membership.custodyProfile;if(profile&&profile.witnessPublicKey!==this.witnessKey(membership.witnessId))throw new Error('custody-profile-key-unpinned');
    if(this.options.transport&&membership.epoch===this.options.transport.membershipEpoch&&(!profile||profile.mode!=='owned-machine'||canonicalHash(profile)!==this.options.transport.profileHash||profile.witnessPublicKey!==this.options.witnessPublicKey))throw new Error('custody-transport-profile-invalid');
  }
  async registerMembership(membership: GraphMembershipEpoch): Promise<void> {
    if (membership.agentId !== this.options.agentId || membership.witnessId !== this.options.witnessId || membership.failureDomain !== this.options.expectedFailureDomain) throw new Error('witness-membership-mismatch');
    this.verifyProfilePin(membership);
    const result = await this.request<{ membershipHash: string }>(`${this.prefix()}/membership`, { membership });
    if (result.membershipHash !== canonicalHash(membership)) throw new Error('witness-membership-hash-mismatch');
    if (this.options.ownerPublicKey && verifyMembershipEpoch(membership, this.options.ownerPublicKey)) this.memberships.set(membership.epoch, freezeWitnessValue(structuredClone(membership)));
  }
  private async verifyFleetErasure(value:GraphErasureFleetStatus):Promise<GraphErasureFleetStatus>{
    if(!this.options.ownerPublicKey||!value||!Array.isArray(value.plan?.activatedEpochs)||!value.plan.activatedEpochs.length||value.plan.activatedEpochs.length>128||value.proof.agentId!==this.options.agentId||!verifyWitnessErasure(value.proof,this.witnessKey(value.proof.witnessId)))throw new Error('fleet-erasure-proof-invalid');
    const history:GraphMembershipEpoch[]=[];
    for(let index=0;index<value.plan.activatedEpochs.length;index++){const epoch=index+1,membership=await this.trustedMembership(epoch);if(epoch>1)await this.activation(epoch);history.push(membership);}
    if(value.ingress&&!verifyGraphErasureIngress(value.ingress,history[value.ingress.membershipEpoch-1],this.options.ownerPublicKey))throw new Error('fleet-erasure-ingress-invalid');
    if(value.plan.witnessId!==this.options.witnessId||!verifyGraphErasurePlan(value.plan,value.ingress,value.proof,history,this.options.witnessPublicKey)||!Array.isArray(value.receipts)||value.receipts.length>8192||new Set(value.receipts.map(r=>r.recipientId)).size!==value.receipts.length||value.receipts.some(receipt=>!verifyGraphErasureMemberReceipt(receipt,value)))throw new Error('fleet-erasure-plan-invalid');return value;
  }
  async beginFleetErasure(ingress:GraphErasureIngress,bundleHashes:string[],lease:GraphWitnessLease,originalLease:LeaseRecord,actionSignature:string):Promise<GraphErasureFleetStatus>{await this.request(`${this.prefix()}/fleet-erasures`,{ingress,bundleHashes,lease,originalLease,actionSignature});return this.fleetErasureStatus(ingress.requestId);}
  async fleetErasureStatus(requestId:string):Promise<GraphErasureFleetStatus>{
    const prefix=`${this.prefix()}/fleet-erasures/${encodeURIComponent(requestId)}`;
    const header=await this.request<GraphErasureFleetStatus&{recipientCount:number;receiptCount:number;recipientsHash:string;receiptsHash:string}>(prefix);
    if(!Number.isSafeInteger(header.recipientCount)||header.recipientCount<1||header.recipientCount>8192||!Number.isSafeInteger(header.receiptCount)||header.receiptCount<0||header.receiptCount>8192||header.plan?.requiredRecipients?.length!==0||header.receipts?.length!==0)throw new Error('fleet-erasure-header-invalid');
    for(const kind of ['recipients','receipts'] as const){const count=kind==='recipients'?header.recipientCount:header.receiptCount,items:unknown[]=[];for(let offset=0;offset<count;offset+=64){const page=await this.request<{items:unknown[]}>(`${prefix}/pages/${kind}?offset=${offset}`);if(!Array.isArray(page.items)||page.items.length!==Math.min(64,count-offset))throw new Error('fleet-erasure-page-stale');items.push(...page.items);}if(canonicalHash(items)!==(kind==='recipients'?header.recipientsHash:header.receiptsHash))throw new Error('fleet-erasure-page-stale');if(kind==='recipients')header.plan.requiredRecipients=items as typeof header.plan.requiredRecipients;else header.receipts=items as typeof header.receipts;}
    return this.verifyFleetErasure({ingress:header.ingress,proof:header.proof,plan:header.plan,receipts:header.receipts});
  }
  async acknowledgeFleetErasure(requestId:string,receipt:GraphErasureMemberReceipt):Promise<GraphErasureFleetStatus>{await this.request(`${this.prefix()}/fleet-erasures/${encodeURIComponent(requestId)}/receipt`,{receipt});return this.fleetErasureStatus(requestId);}
  async pendingFleetErasures():Promise<string[]>{const result:string[]=[];for(let offset=0;offset<=20000;){const page=await this.request<{requestIds:string[];nextOffset:number|null}>(`${this.prefix()}/fleet-erasures?offset=${offset}`);if(!Array.isArray(page.requestIds)||page.requestIds.length>128||page.requestIds.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_.:-]{1,200}$/.test(id))||(page.nextOffset!==null&&page.nextOffset!==offset+128))throw new Error('fleet-erasure-inventory-invalid');result.push(...page.requestIds);if(result.length>20000)throw new Error('fleet-erasure-inventory-bound');if(page.nextOffset===null)return result;offset=page.nextOffset;}throw new Error('fleet-erasure-inventory-bound');}
  async erasureAuthority(proof:GraphWitnessErasure):Promise<GraphErasureAuthority>{
    const challenge=crypto.randomBytes(32).toString('base64url'),endorsement=await this.request<GraphErasureActiveEndorsement>(`${this.prefix()}/erasures/${encodeURIComponent(proof.requestId)}/authority`,{challenge});
    if(endorsement.challenge!==challenge||endorsement.witnessId!==this.options.witnessId||!Number.isSafeInteger(endorsement.membershipEpoch)||endorsement.membershipEpoch<1||endorsement.membershipEpoch>128)throw new Error('erasure-authority-endpoint-invalid');
    const membership=await this.trustedMembership(endorsement.membershipEpoch),activations:GraphMembershipActivationCertificate[]=[];for(let epoch=2;epoch<=membership.epoch;epoch++)activations.push((await this.activation(epoch))!);
    const result={membership,activations,endorsement},keys=new Map<string,string>(Object.entries(this.options.historicalWitnessPublicKeys??{}));keys.set(this.options.witnessId,this.options.witnessPublicKey);
    if(!this.options.ownerPublicKey||!verifyGraphErasureAuthority(result,proof,membership,this.options.ownerPublicKey,keys))throw new Error('erasure-authority-invalid');return result;
  }
  async activation(epoch:number):Promise<GraphMembershipActivationCertificate|null>{
    if(this.activations.has(epoch))return this.activations.get(epoch)!;
    const membership=await this.trustedMembership(epoch);
    const value=await this.request<GraphMembershipActivationCertificate|null>(`${this.prefix()}/membership-activations/${epoch}`);
    if(epoch===1){if(value!==null)throw new Error('witness-genesis-activation-invalid');this.activations.set(epoch,null);return null;}
    if(!value||!this.options.ownerPublicKey||canonicalHash(value.newMembership)!==canonicalHash(membership)
      ||canonicalHash(value.previousMembership)!==canonicalHash(await this.trustedMembership(epoch-1))
      ||!verifyMembershipActivation(value,this.options.ownerPublicKey,this.witnessKey(value.witnessId)))throw new Error('witness-activation-invalid');
    this.activations.set(epoch,freezeWitnessValue(value));return value;
  }
  async admitErasedControl(request:Omit<GraphWitnessPrepareRequest,'encryptedSourceBundle'>):Promise<GraphWitnessOperation>{
    const operation=await this.request<GraphWitnessOperation>(`${this.prefix()}/erased-control`,request);
    await this.verifyOperation(operation,request.packet.idempotencyKey);
    if(canonicalHash(operation.packet)!==canonicalHash(request.packet))throw new Error('witness-erased-control-conflict');
    return operation;
  }
  async holdOwnedProfile(intent:GraphCustodyHoldIntent):Promise<GraphCustodyAllocationHold>{if(!this.options.ownerPublicKey||intent.agentId!==this.options.agentId)throw new Error('witness-agent-mismatch');const proof=await this.request<GraphCustodyAllocationHold>(`${this.prefix()}/hold-owned-profile`,{intent});if(proof.witnessId!==this.options.witnessId||!verifyGraphCustodyAllocationHold(proof,intent,this.options.ownerPublicKey))throw new Error('witness-allocation-hold-invalid');return proof;}
  async retireOwnedProfile(request:Parameters<import('./GraphWitnessService.js').GraphWitnessService['retireOwnedProfile']>[1]):Promise<GraphCustodyRetirementProof>{
    if(!this.options.ownerPublicKey||request.stage.agentId!==this.options.agentId)throw new Error('witness-agent-mismatch');
    const proof=await this.request<GraphCustodyRetirementProof>(`${this.prefix()}/retire-owned-profile`,request);
    if(!verifyGraphCustodyRetirement(proof,request.stage,request.holds,this.options.ownerPublicKey)||proof.witnessId!==this.options.witnessId)throw new Error('witness-retirement-invalid');return proof;
  }
  async recoverPositiveSource(request:import('./GraphWitnessService.js').GraphWitnessRecoveredSourceRequest,signUpload:GraphNativeSourceUploadSigner):Promise<GraphWitnessOperation>{
    if(request.packet.agentId!==this.options.agentId)throw new Error('witness-agent-mismatch');
    const {plan,chunks}=createGraphNativeSourceUpload(request,signUpload);await this.request(`${this.prefix()}/native-source-uploads`,plan);for(let index=0;index<chunks.length;index++){const received=await this.request<{hash:string}>(`${this.prefix()}/native-source-uploads/${plan.transferId}/chunks/${index}`,{value:chunks[index]});if(received.hash!==plan.chunkHashes[index])throw new Error('native-source-upload-chunk-hash-invalid');}
    const operation=await this.request<GraphWitnessOperation>(`${this.prefix()}/native-source-uploads/${plan.transferId}/finish`,{});await this.verifyOperation(operation,request.packet.idempotencyKey);
    if(canonicalHash(operation.packet)!==canonicalHash(request.packet)||!operation.prepareProof||(!(operation.certificate||operation.cancellationCertificate)&&(!operation.adoption||canonicalHash(operation.adoption.currentLease)!==canonicalHash(request.lease))))throw new Error('witness-recovered-source-conflict');return operation;
  }
  async prepare(request: GraphWitnessPrepareRequest): Promise<GraphWitnessPrepareProof> {
    if (request.packet.agentId !== this.options.agentId) throw new Error('witness-agent-mismatch');
    const proof = await this.request<GraphWitnessPrepareProof>(`${this.prefix()}/operations/${encodeURIComponent(request.packet.idempotencyKey)}/prepare`, request);
    if (proof.witnessId !== this.options.witnessId || proof.operationHash !== canonicalHash(request.packet) || proof.agentId !== this.options.agentId
      || proof.eventId !== request.packet.eventId || proof.membershipEpoch !== request.packet.membershipEpoch || proof.leaseEpoch !== request.packet.leaseEpoch
      || !verifyGraphRecord(D.prepare, unsigned(proof), proof.signature, this.options.witnessPublicKey)) throw new Error('witness-prepare-proof-invalid');
    return proof;
  }
  observeLease(lease: GraphWitnessLease, originalLease: LeaseRecord): Promise<{ membershipHash: string; leaseEpoch: number }> {
    return this.request(`${this.prefix()}/lease`, { lease, originalLease });
  }
  async adoptPending(request: GraphWitnessAdoptionRequest): Promise<GraphAdoptionCertificate[]> {
    const packets = new Map();
    for (const item of request.revalidations) packets.set(item.proof.idempotencyKey, (await this.operation(item.proof.idempotencyKey)).packet);
    const result = await this.request<GraphAdoptionCertificate[]>(`${this.prefix()}/adopt-pending`, request);
    if (!Array.isArray(result) || result.length !== packets.size || !this.options.ownerPublicKey) throw new Error('witness-adoption-response-invalid');
    const seen = new Set<string>();
    for (const adoption of result) {
      const packet = packets.get(adoption.idempotencyKey);
      if (!packet || seen.has(adoption.idempotencyKey) || !verifyAdoptionCertificate(adoption, packet, await this.trustedMembership(packet.membershipEpoch), this.options.ownerPublicKey, this.options.witnessPublicKey)) throw new Error('witness-adoption-response-invalid');
      seen.add(adoption.idempotencyKey);
    }
    return result;
  }
  async inventory(challenge: string): Promise<import('./GraphWitnessTypes.js').GraphWitnessInventoryCheckpoint> {
    const header=await this.request<{v:number;exportId:string;checkpoint:import('./GraphWitnessTypes.js').GraphWitnessInventoryCheckpoint;pageCount:number;entryCount:number;erasureCount:number;backupAttestationCount:number;backupAttestationsHash:string;signature:string}>(`${this.prefix()}/inventory-exports`,{challenge});
    if(!exactFields(header,['v','exportId','checkpoint','pageCount','entryCount','erasureCount','backupAttestationCount','backupAttestationsHash','signature'])||header.v!==1||!Number.isSafeInteger(header.pageCount)||header.pageCount<1||header.pageCount>1250
      ||!Number.isSafeInteger(header.entryCount)||header.entryCount<0||header.entryCount>20000||!Number.isSafeInteger(header.erasureCount)||header.erasureCount<0||header.erasureCount>20000
      ||header.checkpoint.challenge!==challenge||!verifyGraphRecord('graph-inventory-export-v1',unsigned(header),header.signature,this.options.witnessPublicKey))throw new Error('witness-inventory-header-invalid');
    const backupEvidence:import('./GraphWitnessTypes.js').GraphBackupErasureAttestation[]=[];
    const headerHash=canonicalHash(header);const checkpoint=structuredClone(header.checkpoint);checkpoint.manifest.entries=[];checkpoint.erasures=[];
    for(let index=0;index<header.pageCount;index++){
      const page=await this.request<{v:number;exportId:string;index:number;headerHash:string;entries:GraphRecoverySourceManifest['entries'];erasures:GraphWitnessErasure[];backupAttestations:import('./GraphWitnessTypes.js').GraphBackupErasureAttestation[];signature:string}>(`${this.prefix()}/inventory-exports/${encodeURIComponent(header.exportId)}/pages/${index}`);
      if(!exactFields(page,['v','exportId','index','headerHash','entries','erasures','backupAttestations','signature'])||page.v!==1||page.exportId!==header.exportId||page.index!==index||page.headerHash!==headerHash
        ||!Array.isArray(page.entries)||page.entries.length>16||!Array.isArray(page.erasures)||page.erasures.length>16||!Array.isArray(page.backupAttestations)||page.backupAttestations.length>16||!verifyGraphRecord('graph-inventory-page-v1',unsigned(page),page.signature,this.options.witnessPublicKey))throw new Error('witness-inventory-page-invalid');
      checkpoint.manifest.entries.push(...page.entries);checkpoint.erasures.push(...page.erasures);backupEvidence.push(...page.backupAttestations);
    }
    if(backupEvidence.length!==header.backupAttestationCount||canonicalHash(backupEvidence)!==header.backupAttestationsHash)throw new Error('witness-backup-evidence-inventory-invalid');
    this.remoteBackupEvidence=backupEvidence;
    if(checkpoint.manifest.entries.length!==header.entryCount||checkpoint.erasures.length!==header.erasureCount)throw new Error('witness-inventory-page-count-invalid');
    if (!verifyWitnessInventory(checkpoint, challenge, this.options.agentId, this.options.witnessId, this.options.witnessPublicKey, this.options.historicalWitnessPublicKeys)) throw new Error('witness-inventory-invalid');
    const membership = await this.trustedMembership(checkpoint.membershipEpoch);
    for(let epoch=2;epoch<=membership.epoch;epoch++)await this.activation(epoch);
    if (canonicalHash(membership) !== checkpoint.activeMembershipHash) throw new Error('witness-inventory-membership-invalid');
    return checkpoint;
  }
  async recoveryManifest(): Promise<GraphRecoverySourceManifest> {
    const manifest = (await this.inventory(crypto.randomBytes(32).toString('base64url'))).manifest;
    if (!validateRecoverySourceManifest(manifest) || manifest.agentId !== this.options.agentId) throw new Error('witness-source-manifest-invalid');
    return manifest;
  }
  async bootstrap(request:GraphWitnessBootstrapRequest):Promise<{activation:GraphMembershipActivationCertificate;adoptions:GraphAdoptionCertificate[]}> {
    const transferId=canonicalHash({payload:graphWitnessBootstrapPayload(request),signature:request.bootstrapSignature});
    const plan:GraphBootstrapTransferPlan={transferId,payload:graphWitnessBootstrapPayload(request) as GraphBootstrapTransferPlan['payload'],bootstrapSignature:request.bootstrapSignature,
      counts:graphWitnessBootstrapCounts(request)};
    await this.request(`${this.prefix()}/bootstrap-transfers`,plan);
    const upload=async(section:GraphBootstrapSection,values:unknown[])=>{for(let index=0;index<values.length;index++){const receipt=await this.request<{hash:string}>(`${this.prefix()}/bootstrap-transfers/${transferId}/chunks/${section}/${index}`,{value:values[index]});if(receipt.hash!==canonicalHash(values[index]))throw new Error('witness-bootstrap-chunk-hash-invalid');}};
    await upload('membership',request.memberships);
    if(request.archive){await upload('activation',request.archive.activations);let pageOffset=0;for(const context of request.archive.contexts){const entryCount=context.manifest.entries.length,pageCount=Math.max(1,Math.ceil(entryCount/16));
      const epoch=context.activation.newMembership.epoch,index=epoch-2,header={epoch,context:{...context,manifest:{...context.manifest,entries:[]},rewrapInventory:[]},entryCount,pageOffset,pageCount};
      const stored=await this.request<{hash:string}>(`${this.prefix()}/bootstrap-transfers/${transferId}/chunks/context/${index}`,{value:header});if(stored.hash!==canonicalHash(header))throw new Error('bootstrap-context-header-hash-invalid');
      for(let page=0;page<pageCount;page++){const value={epoch,index:page,entries:context.manifest.entries.slice(page*16,page*16+16),rewrapInventory:context.rewrapInventory.slice(page*16,page*16+16)},receipt=await this.request<{hash:string}>(`${this.prefix()}/bootstrap-transfers/${transferId}/chunks/context-page/${pageOffset+page}`,{value});if(receipt.hash!==canonicalHash(value))throw new Error('bootstrap-context-page-hash-invalid');}pageOffset+=pageCount;
    }}

    const {revalidations,stateTransferReceipts,sourceManifest,historicalRewraps,...control}=request.recovery;
    await upload('control',[{...control,sourceManifest:{...sourceManifest,entries:[]}}]);
    await upload('operation',request.operations);await upload('erasure',request.erasures);if(request.backupAttestations)await upload('backup',request.backupAttestations);await upload('entry',sourceManifest.entries);await upload('revalidation',revalidations);if(historicalRewraps)await upload('historical-rewrap',historicalRewraps);await upload('receipt',stateTransferReceipts);
    const header=await this.request<{activation:GraphMembershipActivationCertificate;adoptionCount:number}>(`${this.prefix()}/bootstrap-transfers/${transferId}/finish`,{});
    if(header.adoptionCount!==request.recovery.revalidations.length)throw new Error('witness-bootstrap-result-count-invalid');
    const result={activation:header.activation,adoptions:[] as GraphAdoptionCertificate[]};
    for(let index=0;index<header.adoptionCount;index++)result.adoptions.push(await this.request<GraphAdoptionCertificate>(`${this.prefix()}/bootstrap-transfers/${transferId}/adoptions/${index}`));
    if(!this.options.ownerPublicKey||!verifyMembershipActivation(result.activation,this.options.ownerPublicKey,this.options.witnessPublicKey)
      ||canonicalHash(result.activation.ownerAuthorization)!==canonicalHash(request.recovery.authorization)||result.adoptions.length!==request.recovery.revalidations.length)throw new Error('witness-bootstrap-response-invalid');
    const seen=new Set<string>();
    for(const adoption of result.adoptions){const original=request.operations.find(row=>row.operation.packet.idempotencyKey===adoption.idempotencyKey)?.operation.packet;
      const membership=original?request.memberships.find(m=>m.epoch===original.membershipEpoch):undefined;
      if(!original||!membership||seen.has(adoption.idempotencyKey)||!verifyAdoptionCertificate(adoption,original,membership,this.options.ownerPublicKey,this.options.witnessPublicKey))throw new Error('witness-bootstrap-adoption-invalid');seen.add(adoption.idempotencyKey);
    }
    for(const membership of [...request.memberships,request.recovery.newMembership]){if(!verifyMembershipEpoch(membership,this.options.ownerPublicKey))throw new Error('witness-bootstrap-membership-invalid');this.memberships.set(membership.epoch,membership);}
    return result;
  }
  async recoverPending(request: GraphWitnessRecoveryRequest): Promise<{ activation: GraphMembershipActivationCertificate; adoptions: GraphAdoptionCertificate[] }> {
    const packets = new Map();
    for (const item of request.revalidations) packets.set(item.proof.idempotencyKey, (await this.operation(item.proof.idempotencyKey)).packet);
    const {revalidations,stateTransferReceipts,sourceManifest,historicalRewraps,...control}=request,transferId=graphRecoveryUploadId(request);
    const plan:GraphRecoveryUploadPlan={kind:'recovery',transferId,requestHash:canonicalHash(request),header:{...control,sourceManifest:{...sourceManifest,entries:[]}},hasHistoricalRewraps:historicalRewraps!==undefined,counts:{entry:sourceManifest.entries.length,revalidation:revalidations.length,receipt:stateTransferReceipts.length,'historical-rewrap':historicalRewraps?.length??0}};
    await this.request(`${this.prefix()}/recovery-uploads`,plan);
    for(const [section,rows]of [['entry',sourceManifest.entries],['revalidation',revalidations],['receipt',stateTransferReceipts],['historical-rewrap',historicalRewraps??[]]] as const)for(let index=0;index<rows.length;index++){const received=await this.request<{hash:string}>(`${this.prefix()}/recovery-uploads/${transferId}/chunks/${section}/${index}`,{value:rows[index]});if(received.hash!==canonicalHash(rows[index]))throw new Error('recovery-upload-chunk-hash-invalid');}
    const completed=await this.request<{activation:GraphMembershipActivationCertificate;adoptionCount:number}>(`${this.prefix()}/recovery-uploads/${transferId}/finish`,{});if(completed.adoptionCount!==revalidations.length)throw new Error('recovery-upload-result-count-invalid');
    const result={activation:completed.activation,adoptions:[] as GraphAdoptionCertificate[]};for(let index=0;index<completed.adoptionCount;index++)result.adoptions.push(await this.request<GraphAdoptionCertificate>(`${this.prefix()}/recovery-uploads/${transferId}/adoptions/${index}`));
    if (!this.options.ownerPublicKey || !verifyMembershipActivation(result.activation, this.options.ownerPublicKey, this.options.witnessPublicKey)
      || canonicalHash(result.activation.ownerAuthorization) !== canonicalHash(request.authorization)
      || !Array.isArray(result.adoptions) || result.adoptions.length !== packets.size) throw new Error('witness-membership-activation-invalid');
    const seen = new Set<string>();
    for (const adoption of result.adoptions) {
      const packet = packets.get(adoption.idempotencyKey);
      if (!packet || seen.has(adoption.idempotencyKey) || !verifyAdoptionCertificate(adoption, packet, await this.trustedMembership(packet.membershipEpoch), this.options.ownerPublicKey, this.options.witnessPublicKey)) throw new Error('witness-adoption-response-invalid');
      seen.add(adoption.idempotencyKey);
    }
    this.memberships.set(request.newMembership.epoch, request.newMembership);
    return result;
  }
  async commit(request: GraphWitnessPrepareRequest, membership: GraphMembershipEpoch, receipts: GraphMemberReceipt[]): Promise<GraphCommitCertificate> {
    const certificate = await this.request<GraphCommitCertificate>(`${this.prefix()}/operations/${encodeURIComponent(request.packet.idempotencyKey)}/commit`,
      { lease: request.lease, originalLease: request.originalLease, receipts });
    if (!verifyCommitCertificate(certificate, request.packet, membership, this.options.witnessPublicKey, this.options.ownerPublicKey)) throw new Error('witness-certificate-invalid');
    return certificate;
  }
  async cancel(key: string, lease: GraphWitnessLease, originalLease: LeaseRecord, actionSignature: string): Promise<GraphWitnessCancellation> {
    const operation = await this.operation(key);
    const proof = await this.request<GraphWitnessCancellation>(`${this.prefix()}/operations/${encodeURIComponent(key)}/cancel`, { lease, originalLease, actionSignature });
    if (proof.agentId !== this.options.agentId || proof.witnessId !== this.options.witnessId || proof.operationHash !== canonicalHash(operation.packet)
      || proof.eventId !== operation.packet.eventId || !verifyGraphRecord(D.cancellation, unsigned(proof), proof.signature, this.options.witnessPublicKey)) throw new Error('witness-cancel-proof-invalid');
    return proof;
  }
  async settleMemberLoss(activation:GraphMembershipActivationCertificate,pins:GraphMemberLossActivationPin[],lease:GraphWitnessLease,originalLease:LeaseRecord):Promise<GraphMemberLossSettlementProof>{
    if(!this.options.ownerPublicKey||activation.agentId!==this.options.agentId||activation.witnessId!==this.options.witnessId||!verifyMembershipActivation(activation,this.options.ownerPublicKey,this.options.witnessPublicKey)||!activation.memberLoss||!verifyGraphMemberLossActivationPins(pins,activation))throw new Error('witness-member-loss-settlement-input-invalid');
    const proof=await this.request<GraphMemberLossSettlementProof>(`${this.prefix()}/settle-member-loss`,{activationHash:canonicalHash(activation),pins,lease,originalLease});
    if(!verifyGraphMemberLossSettlement(proof,activation,this.options.witnessPublicKey,pins))throw new Error('witness-member-loss-settlement-invalid');return proof;
  }
  async certifyCancellation(request: Pick<GraphWitnessPrepareRequest,'packet'|'lease'|'originalLease'>, membership: GraphMembershipEpoch, receipts: GraphMemberReceipt[]): Promise<GraphCancellationCertificate> {
    const certificate = await this.request<GraphCancellationCertificate>(`${this.prefix()}/operations/${encodeURIComponent(request.packet.idempotencyKey)}/certify-cancellation`,
      { lease: request.lease, originalLease: request.originalLease, receipts });
    if (!verifyCancellationCertificate(certificate, request.packet, membership, this.options.witnessPublicKey, this.options.ownerPublicKey)) throw new Error('witness-terminal-certificate-invalid');
    return certificate;
  }
  acknowledgeCertificate(key: string, receipt: GraphMemberReceipt): Promise<{ allMembersPersisted: boolean }> {
    return this.request(`${this.prefix()}/operations/${encodeURIComponent(key)}/certificate-receipt`, { receipt });
  }
  async recoveryContext(epoch:number):Promise<GraphWitnessRecoveryContext>{
    let context=this.recoveryContexts.get(epoch);if(context)return context;
    if(!context){
      const header=await this.request<{v:number;agentId:string;epoch:number;witnessId:string;context:GraphWitnessRecoveryContext;entryCount:number;rewrapCount:number;pageCount:number;signature:string}>(`${this.prefix()}/recovery-contexts/${epoch}`);
      if(!exactFields(header,['v','agentId','epoch','witnessId','context','entryCount','rewrapCount','pageCount','signature'])||header.v!==1||header.agentId!==this.options.agentId||header.epoch!==epoch||header.witnessId!==this.options.witnessId
        ||!Number.isSafeInteger(header.entryCount)||header.entryCount<0||header.entryCount>20000||!Number.isSafeInteger(header.rewrapCount)||header.rewrapCount!==header.entryCount
        ||!Number.isSafeInteger(header.pageCount)||header.pageCount<1||header.pageCount>1250||!verifyGraphRecord('graph-recovery-context-header-v1',unsigned(header),header.signature,this.options.witnessPublicKey))throw new Error('witness-recovery-context-header-invalid');
      const headerHash=canonicalHash(header);context=structuredClone(header.context);context.manifest.entries=[];context.rewrapInventory=[];
      for(let index=0;index<header.pageCount;index++){
        const page=await this.request<{v:number;agentId:string;epoch:number;index:number;headerHash:string;entries:GraphRecoverySourceManifest['entries'];rewrapInventory:GraphHistoricalMaterialization['rewrapInventory'];signature:string}>(`${this.prefix()}/recovery-contexts/${epoch}/pages/${index}`);
        if(!exactFields(page,['v','agentId','epoch','index','headerHash','entries','rewrapInventory','signature'])||page.v!==1||page.agentId!==this.options.agentId||page.epoch!==epoch||page.index!==index||page.headerHash!==headerHash
          ||!Array.isArray(page.entries)||page.entries.length>16||!Array.isArray(page.rewrapInventory)||page.rewrapInventory.length>16||!verifyGraphRecord('graph-recovery-context-page-v1',unsigned(page),page.signature,this.options.witnessPublicKey))throw new Error('witness-recovery-context-page-invalid');
        context.manifest.entries.push(...page.entries);context.rewrapInventory.push(...page.rewrapInventory);
      }
      if(context.manifest.entries.length!==header.entryCount||context.rewrapInventory.length!==header.rewrapCount)throw new Error('witness-recovery-context-count-invalid');
    }
    const activation=await this.activation(epoch);if(!activation||!this.options.ownerPublicKey||!exactFields(context,['activation','manifest','rewrapInventory','currentLease','originalCurrentLease'])||canonicalHash(context.activation)!==canonicalHash(activation)||!validateRecoverySourceManifest(context.manifest)||canonicalHash(context.manifest)!==activation.ownerAuthorization.sourceManifestHash||graphRewrapInventoryHash(context.rewrapInventory)!==activation.ownerAuthorization.rewrapInventoryHash||!verifyFencedLeaseBridge(context.currentLease,context.originalCurrentLease,activation.newMembership)||context.currentLease.leaseEpoch!==activation.ownerAuthorization.fenceEpoch)throw new Error('witness-recovery-context-archive-invalid');
    const keys=new Map<string,string>(Object.entries(this.options.historicalWitnessPublicKeys??{}));keys.set(this.options.witnessId,this.options.witnessPublicKey);
    if(!verifyGraphHistoricalMaterializationContext({...context,rewrapHash:canonicalHash(null)},this.options.agentId,{ownerPublicKey:this.options.ownerPublicKey,witnessPublicKeys:keys}))throw new Error('witness-recovery-context-archive-invalid');
    freezeWitnessValue(context);
    this.contextBindings.set(epoch,{hashes:{activationHash:canonicalHash(context.activation),manifestHash:canonicalHash(context.manifest),rewrapInventoryHash:context.activation.ownerAuthorization.rewrapInventoryHash,leaseHash:canonicalHash(context.currentLease),originalLeaseHash:canonicalHash(context.originalCurrentLease)},entries:new Map(context.manifest.entries.map(row=>[row.eventId,row])),keys:new Map(context.rewrapInventory.map(row=>[row.eventId,row]))});
    this.recoveryContexts.set(epoch,context);return context;
  }
  async recoveryArchive():Promise<GraphWitnessArchive>{
    const current=await this.inventory(crypto.randomBytes(32).toString('base64url')),archive:GraphWitnessArchive={activations:[],contexts:[]};
    for(let epoch=2;epoch<=current.membershipEpoch;epoch++){archive.activations.push((await this.activation(epoch))!);archive.contexts.push(await this.recoveryContext(epoch));}return archive;
  }
  async historicalMaterialization(operation:GraphWitnessOperation):Promise<GraphHistoricalMaterialization|null>{
    const ref=operation.materialization;if(!ref)return null;
    if(!validWitnessMaterializationRef(ref))throw new Error('witness-materialization-ref-invalid');
    const context=await this.recoveryContext(ref.epoch);
    const binding=this.contextBindings.get(ref.epoch)!;
    if(operation.packet.agentId!==this.options.agentId||Object.entries(binding.hashes).some(([name,digest])=>ref[name as keyof typeof ref]!==digest)||context.activation.newMembership.epoch!==ref.epoch)throw new Error('witness-recovery-context-ref-mismatch');
    const proof={...context,rewrapHash:ref.rewrapHash};
    if(!binding.entries.has(operation.packet.eventId)||!binding.keys.has(operation.packet.eventId))throw new Error('witness-recovery-materialization-invalid');
    if(!verifyGraphHistoricalMaterializationEntry(proof,{packet:operation.packet,...(operation.certificate?{certificate:operation.certificate}:{}),...(operation.cancellationCertificate?{cancellationCertificate:operation.cancellationCertificate}:{})},binding.entries.get(operation.packet.eventId),binding.keys.get(operation.packet.eventId)))throw new Error('witness-recovery-materialization-invalid');
    return proof;
  }
  membership(epoch:number):Promise<GraphMembershipEpoch>{return this.trustedMembership(epoch);}
  private async trustedMembership(epoch: number): Promise<GraphMembershipEpoch> {
    if (!this.options.ownerPublicKey) throw new Error('witness-owner-trust-unavailable');
    let membership = this.memberships.get(epoch);
    if (!membership) {
      membership = await this.request<GraphMembershipEpoch>(`${this.prefix()}/memberships/${epoch}`);
      if (membership.agentId !== this.options.agentId || membership.epoch !== epoch || !verifyMembershipEpoch(membership, this.options.ownerPublicKey)) throw new Error('witness-membership-proof-invalid');
      this.verifyProfilePin(membership);
      this.memberships.set(epoch, freezeWitnessValue(membership));
    }
    return membership;
  }
  private async verifyOperation(operation: GraphWitnessOperation, key: string): Promise<void> {
    if (!exactFields(operation, ['packet','packetSignature','controlCapsule','prepareProof','erasedControlProof','state','certificate','cancellation','cancellationCertificate','erasure','stateProof','adoption','rewrap','materialization','certificatePersistenceReceipts'])) throw new Error('witness-operation-shape-invalid');
    const originalMembership=await this.trustedMembership(operation.packet.membershipEpoch);
    const custodyMembership=operation.erasedControlProof?await this.trustedMembership(operation.erasedControlProof.custodyMembershipEpoch):originalMembership;
    for(let epoch=2;epoch<=Math.max(originalMembership.epoch,custodyMembership.epoch);epoch++)await this.activation(epoch);
    const lossNegative=!!this.options.ownerPublicKey&&!!operation.adoption&&verifyGraphMemberLossNegativeCustody(operation,originalMembership,this.options.ownerPublicKey,this.witnessKey(operation.adoption.witnessId));
    if(operation.packet.agentId!==this.options.agentId||operation.packet.idempotencyKey!==key||(!lossNegative&&!verifyGraphWitnessCustody(operation.prepareProof,operation.erasedControlProof,operation.packet,custodyMembership.witnessId,this.witnessKey(custodyMembership.witnessId),operation.erasure)))throw new Error('witness-operation-proof-invalid');
    const state = operation.stateProof;
    if (!exactFields(state, ['v','agentId','idempotencyKey','operationHash','packetSignatureHash','erasedControlProofHash','state','certificateHash','cancellationHash','cancellationCertificateHash','erasureHash','adoptionHash','certificatePersistenceHash','rewrapHash','materializationHash','witnessId','observedAt','signature'])
      || state.agentId !== this.options.agentId || state.idempotencyKey !== key || state.operationHash !== canonicalHash(operation.packet)
      || state.erasedControlProofHash!==(operation.erasedControlProof?canonicalHash(operation.erasedControlProof):null)
      || state.packetSignatureHash!==canonicalHash(operation.packetSignature)
      || state.state !== operation.state || state.witnessId !== this.options.witnessId
      || state.certificateHash !== (operation.certificate ? canonicalHash(operation.certificate) : null)
      || state.cancellationHash !== (operation.cancellation ? canonicalHash(operation.cancellation) : null)
      || state.cancellationCertificateHash !== (operation.cancellationCertificate ? canonicalHash(operation.cancellationCertificate) : null)
      || state.erasureHash !== (operation.erasure ? canonicalHash(operation.erasure) : null)
      || state.materializationHash!==(operation.materialization?canonicalHash(operation.materialization):null)
      || state.rewrapHash !== (operation.rewrap?canonicalHash(operation.rewrap):null)
      || state.adoptionHash !== (operation.adoption ? canonicalHash(operation.adoption) : null)
      || !Array.isArray(operation.certificatePersistenceReceipts) || state.certificatePersistenceHash !== canonicalHash(operation.certificatePersistenceReceipts)
      || !verifyGraphRecord(D.operationState, unsigned(state), state.signature, this.options.witnessPublicKey)) throw new Error('witness-operation-state-invalid');
    if (operation.state === 'certified' && !operation.certificate) throw new Error('witness-operation-certificate-missing');
    if (operation.state === 'canceled' && !operation.cancellation) throw new Error('witness-operation-cancellation-missing');
    if (operation.state === 'erased' && !operation.erasure) throw new Error('witness-operation-erasure-missing');
    if(!this.options.ownerPublicKey||!verifyGraphControlCapsule(operation.controlCapsule,operation.packet,this.options.ownerPublicKey)||canonicalHash(operation.controlCapsule.authorizationProof.membership)!==canonicalHash(originalMembership))throw new Error('witness-operation-control-invalid');
    const originalWriter=originalMembership.members.find(member=>member.machineId===operation.packet.writerId);
    if(!originalWriter||!verifyGraphRecord(D.packet,operation.packet,operation.packetSignature,originalWriter.signingPublicKey))throw new Error('witness-operation-packet-signature-invalid');
    const context = operation.adoption ? { membershipEpoch: operation.adoption.newMembership.epoch, leaseEpoch: operation.adoption.currentLease.leaseEpoch } : undefined;
    if (operation.adoption) {
      const membership = await this.trustedMembership(operation.packet.membershipEpoch);
      if (!this.options.ownerPublicKey || !verifyAdoptionCertificate(operation.adoption, operation.packet, membership, this.options.ownerPublicKey, this.witnessKey(operation.adoption.witnessId))) throw new Error('witness-operation-adoption-invalid');
    }
    if(operation.materialization)await this.historicalMaterialization(operation);
    if(operation.rewrap&&((!operation.materialization&&!operation.adoption)||canonicalHash(operation.rewrap)!==(operation.materialization?.rewrapHash??operation.adoption?.rewrapHash)||operation.erasure))throw new Error('witness-operation-rewrap-invalid');
    if (operation.cancellation && !verifyWitnessCancellation(operation.cancellation, operation.packet, this.witnessKey(operation.cancellation.witnessId), context)) throw new Error('witness-operation-cancellation-invalid');
    if (operation.erasure && (operation.erasure.agentId !== this.options.agentId || !erasureCoversPacket(operation.erasure,operation.packet)
      || !verifyWitnessErasure(operation.erasure, this.witnessKey(operation.erasure.witnessId)))) throw new Error('witness-operation-erasure-invalid');
    if (operation.certificate || operation.cancellationCertificate) {
      const membership = await this.trustedMembership(operation.packet.membershipEpoch);
      if (operation.certificate && !verifyCommitCertificate(operation.certificate, operation.packet, membership, this.witnessKey(operation.certificate.witnessId), this.options.ownerPublicKey)) throw new Error('witness-operation-certificate-invalid');
      if (operation.cancellationCertificate && !verifyCancellationCertificate(operation.cancellationCertificate, operation.packet, membership, this.witnessKey(operation.cancellationCertificate.witnessId), this.options.ownerPublicKey)) throw new Error('witness-operation-terminal-invalid');
      const effective = operation.adoption?.newMembership ?? membership;
      const certificate = operation.certificate ?? operation.cancellationCertificate!;
      const seen = new Set<string>();
      for (const receipt of operation.certificatePersistenceReceipts) {
        if (seen.has(receipt.machineId) || !verifyMemberReceipt(receipt, operation.packet, effective, 'certificate', canonicalHash(certificate), context)) throw new Error('witness-operation-persistence-invalid');
        seen.add(receipt.machineId);
      }
    } else if (operation.certificatePersistenceReceipts.length) {
      throw new Error('witness-operation-persistence-without-certificate');
    }
  }
  async operation(key: string): Promise<GraphWitnessOperation> {
    const operation = await this.request<GraphWitnessOperation>(`${this.prefix()}/operations/${encodeURIComponent(key)}`);
    await this.verifyOperation(operation, key); return operation;
  }
  async recover(key: string): Promise<{ operation: GraphWitnessOperation; encryptedSourceBundle: GraphEncryptedBundle | null; erasure: GraphWitnessErasure | null;materialization:GraphHistoricalMaterialization|null }> {
    const result = await this.request<{ operation: GraphWitnessOperation; encryptedSourceBundle: GraphEncryptedBundle | null; erasure: GraphWitnessErasure | null }>(`${this.prefix()}/operations/${encodeURIComponent(key)}/recover`);
    await this.verifyOperation(result.operation, key);
    if (result.encryptedSourceBundle && canonicalHash(result.encryptedSourceBundle) !== result.operation.packet.sourceBundleHash) throw new Error('witness-recovery-hash-invalid');
    const materialization=await this.historicalMaterialization(result.operation);
    if(result.operation.rewrap&&(!result.encryptedSourceBundle||!verifyBundleRewrap(result.operation.rewrap,result.encryptedSourceBundle,materialization?.activation.newMembership??result.operation.adoption!.newMembership)))throw new Error('witness-recovery-rewrap-invalid');
    if (result.erasure && (result.erasure.agentId !== this.options.agentId || !erasureCoversPacket(result.erasure,result.operation.packet)
      || !verifyWitnessErasure(result.erasure, this.witnessKey(result.erasure.witnessId)))) throw new Error('witness-recovery-erasure-invalid');
    return {...result,materialization};
  }
  async erase(requestId: string,target:GraphErasureIdentity, bundleHashes: string[], authorizationReceiptHash: string, lease: GraphWitnessLease, originalLease: LeaseRecord, actionSignature: string): Promise<GraphWitnessErasure> {
    const proof = await this.request<GraphWitnessErasure>(`${this.prefix()}/erasures`, { requestId,target, bundleHashes, authorizationReceiptHash, lease, originalLease, actionSignature });
    if (proof.agentId !== this.options.agentId || proof.requestId !== requestId
      || !sameGraphErasureIdentity(proof.target,target)||proof.authorizationReceiptHash !== authorizationReceiptHash
      || canonicalHash([...proof.bundleHashes].sort()) !== canonicalHash([...bundleHashes].sort()) || !verifyWitnessErasure(proof, this.witnessKey(proof.witnessId))) throw new Error('witness-erasure-proof-invalid');
    await this.erasureAuthority(proof);
    return proof;
  }
  async attestBackupErasure(proof:import('./GraphWitnessTypes.js').GraphBackupErasureAttestation):Promise<void> {
    await this.request(`${this.prefix()}/backup-erasure-attestation`,proof);
  }
  async checkpointErasure(requestId: string): Promise<{ proof: GraphWitnessErasure; walPurged: boolean; externalBackupsVerified: boolean; backupAttestation:import('./GraphWitnessTypes.js').GraphBackupErasureAttestation|null }> {
    const challenge=crypto.randomBytes(32).toString('base64url');
    const result=await this.request<{proof:GraphWitnessErasure;walPurged:boolean;localPurgeReceipt:GraphErasureWitnessPurgeReceipt|null;externalBackupsVerified:boolean;backupAttestation:import('./GraphWitnessTypes.js').GraphBackupErasureAttestation|null}>(`${this.prefix()}/erasures/${encodeURIComponent(requestId)}/checkpoint`, {challenge});
    if(!verifyWitnessErasure(result.proof,this.witnessKey(result.proof.witnessId))||result.proof.requestId!==requestId||result.proof.agentId!==this.options.agentId)throw new Error('witness-erasure-proof-invalid');
    result.walPurged=verifyGraphErasureWitnessPurge(result.localPurgeReceipt,result.proof,challenge,this.options.witnessId,this.options.expectedFailureDomain,this.options.witnessPublicKey);
    // The client independently verifies the attestation; the server boolean never grants completion.
    result.externalBackupsVerified=!!result.backupAttestation&&!!this.options.backupPolicyAuditorPublicKey&&verifyBackupErasureAttestation(result.backupAttestation,result.proof,this.options.expectedFailureDomain,this.options.backupPolicyAuditorPublicKey,Date.now());
    return result;
  }
}
