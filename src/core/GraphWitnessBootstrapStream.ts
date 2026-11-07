/** Actual held-source upload into the existing witness staging engine. Public
 * counts/hashes are signed; private rows are read and released one at a time. */
import crypto from 'node:crypto';
import {GraphHeldSourceReader,GraphHeldSenderReadSession} from './ConversationGraphReplication.js';
import {GraphMemberLossHeldPreflight} from './GraphMemberLossHeldPreflight.js';
import {GraphPreparedTransferEnvelopes} from './GraphPreparedTransferEnvelopes.js';
import {GraphWitnessService,graphRecoveryUploadId,graphWitnessBootstrapCounts,type GraphWitnessBootstrapRequest,type GraphWitnessRecoveryRequest,type GraphBootstrapTransferPlan,type GraphBootstrapSection} from './GraphWitnessService.js';
import {graphMemberLossSourceImport} from './GraphMemberLossSourceImport.js';
import {canonicalHash,canonicalJson,signGraphRecord,type GraphMembershipActivationCertificate,type GraphAdoptionCertificate} from './GraphWitnessTypes.js';
type Metadata=Omit<GraphWitnessBootstrapRequest,'operations'|'bootstrapSignature'|'recovery'>&{recovery:Omit<GraphWitnessRecoveryRequest,'historicalRewraps'>};
const TOKEN=Symbol('actual-held-witness-bootstrap');const UPLOAD_TOKEN=Symbol('actual-staged-witness-upload');
type Result={activation:GraphMembershipActivationCertificate;adoptions:GraphAdoptionCertificate[]};
function freezePublic(value:unknown):void{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freezePublic(child);Object.freeze(value);}}
/** Mechanical staged bytes only. This handle grants no fresh human authority.
 * The server must recheck its actual Action after stage() and before finish(). */
export class GraphWitnessStagedUpload {
 #closed=false;#result:Result|null=null;#stream:GraphWitnessBootstrapStream;#service:GraphWitnessService;#complete:(()=>Result)|null;
 readonly agentId:string;readonly intentHash:string;readonly consentHash:string;readonly recoveryId:string;readonly stateRoot:string;
 constructor(token:symbol,stream:GraphWitnessBootstrapStream,service:GraphWitnessService,complete:()=>Result){
  if(token!==UPLOAD_TOKEN)throw new Error('witness-upload-actual-stage-required');this.#stream=stream;this.#service=service;this.#complete=complete;const loss=stream.metadata.recovery.memberLoss!;this.agentId=stream.metadata.recovery.newMembership.agentId;this.intentHash=canonicalHash(loss.intent);this.consentHash=canonicalHash(loss.consent);this.recoveryId=stream.metadata.recovery.authorization.recoveryId;this.stateRoot=stream.stateRoot;Object.freeze(this);
 }
 assertFor(stream:GraphWitnessBootstrapStream,service:GraphWitnessService):void{if(this.#closed||stream!==this.#stream||service!==this.#service)throw new Error('witness-upload-stage-scope-invalid');this.#stream.assertCurrent();}
 finish():Result{
  if(this.#closed)throw new Error('witness-upload-stage-closed');if(this.#result)return this.#result;
  // No await is permitted between the server's fresh admission check and this
  // final physical/native barrier plus the real SQLite finish transaction.
  this.#stream.assertFinalized();this.#stream.assertCurrent();const result=this.#complete!();freezePublic(result);this.#result=result;return result;
 }
 close():void{this.#closed=true;this.#complete=null;}
}
export class GraphWitnessBootstrapStream {
 private constructor(token:symbol,private readonly source:GraphHeldSourceReader,private readonly preflight:GraphMemberLossHeldPreflight,private readonly prepared:GraphPreparedTransferEnvelopes,readonly metadata:Metadata,readonly plan:GraphBootstrapTransferPlan,readonly recoveryHash:string,private readonly session?:GraphHeldSenderReadSession){if(token!==TOKEN)throw new Error('witness-bootstrap-actual-stream-required');}
 static async prepare(source:GraphHeldSourceReader,preflight:GraphMemberLossHeldPreflight,prepared:GraphPreparedTransferEnvelopes,metadata:Metadata,ownerPrivateKey:crypto.KeyLike,session?:GraphHeldSenderReadSession):Promise<GraphWitnessBootstrapStream>{
  if(!(source instanceof GraphHeldSourceReader)||!(preflight instanceof GraphMemberLossHeldPreflight)||!(prepared instanceof GraphPreparedTransferEnvelopes))throw new Error('witness-bootstrap-actual-stream-required');
  if(session!==undefined&&!(session instanceof GraphHeldSenderReadSession))throw new Error('witness-bootstrap-actual-read-session-required');if(session)session.assertForSource(source,preflight,prepared);else preflight.assertCurrent();const reader=session??source;
  const loss=metadata.recovery.memberLoss,previous=metadata.memberships.at(-1),inventory=loss?.sourceInventories.find(row=>row.machineId===source.machineId);if(!loss||!previous||source.intentHash!==canonicalHash(loss.intent)||source.membershipHash!==canonicalHash(previous)||preflight.stateRoot!==source.stateRoot||preflight.agentId!==source.agentId||preflight.intentHash!==source.intentHash||canonicalHash(preflight.previousMembership)!==source.membershipHash||canonicalHash(preflight.newMembership)!==canonicalHash(metadata.recovery.newMembership)||inventory?.inventoryHash!==preflight.inventoryHash||inventory.erasureInventoryHash!==preflight.erasureInventoryHash)throw new Error('witness-bootstrap-held-loss-scope-mismatch');
  if(session){session.assertForSource(source,preflight,prepared);session.assertFinalized();}else{prepared.assertForSource(source,metadata.recovery.authorization.recoveryId,metadata.recovery.newMembership);source.assertFinalized();}
  const retained=structuredClone(metadata),digest=crypto.createHash('sha256');digest.update('[');let operationCount=0;
  for(const descriptor of reader.descriptors()){const record=await reader.readRecord(descriptor.eventId);try{if(record.preparationProof||record.erasedControlProof||record.certificate||record.cancellationCertificate){if(operationCount++)digest.update(',');digest.update(canonicalJson(graphMemberLossSourceImport(record)));}}finally{reader.releasePrivateViews();}}
  digest.update(']');const operationsHash=digest.digest('hex'),rewrapCount=prepared.inventory().filter(row=>row.rewrapHash!==canonicalHash(null)).length;
  const recoveryHash=await GraphWitnessBootstrapStream.hashRecovery(retained.recovery,prepared,session),request={...retained,recovery:{...retained.recovery,historicalRewraps:[]},operations:[]},counts={...graphWitnessBootstrapCounts(request,operationCount),'historical-rewrap':rewrapCount};
  const payload={v:1 as const,countsHash:canonicalHash(counts),recoveryHash,membershipsHash:canonicalHash(retained.memberships),operationsHash,erasuresHash:canonicalHash(retained.erasures),previousFenceEpoch:retained.previousFenceEpoch,...(retained.backupAttestations?{backupAttestationsHash:canonicalHash(retained.backupAttestations)}:{}),...(retained.archive?{archiveHash:canonicalHash(retained.archive)}:{})},bootstrapSignature=signGraphRecord('graph-witness-bootstrap-v1',payload,ownerPrivateKey),plan={transferId:canonicalHash({payload,signature:bootstrapSignature}),payload,bootstrapSignature,counts};
  freezePublic(retained);freezePublic(plan);if(session){session.assertFinalized();session.assertForSource(source,preflight,prepared);}else{source.assertFinalized();prepared.assertCurrent();}return new GraphWitnessBootstrapStream(TOKEN,source,preflight,prepared,retained,plan,recoveryHash,session);
 }
 private static async hashRecovery(metadata:Metadata['recovery'],prepared:GraphPreparedTransferEnvelopes,session?:GraphHeldSenderReadSession):Promise<string>{const request={...metadata,historicalRewraps:[]},digest=crypto.createHash('sha256');digest.update('{');let first=true;for(const key of Object.keys(request).sort().filter(key=>(request as unknown as Record<string,unknown>)[key]!==undefined)){if(!first)digest.update(',');first=false;digest.update(JSON.stringify(key)+':');if(key==='historicalRewraps'){digest.update('[');let rowFirst=true;for await(const row of (session??prepared).envelopes())if(row.rewrap){if(!rowFirst)digest.update(',');rowFirst=false;digest.update(canonicalJson(row));}digest.update(']');}else digest.update(canonicalJson((request as unknown as Record<string,unknown>)[key]));}digest.update('}');return digest.digest('hex');}
 assertCurrent():void{if(this.session){this.session.assertForSource(this.source,this.preflight,this.prepared);return;}this.preflight.assertCurrent();this.source.assertCurrent();this.prepared.assertForSource(this.source,this.metadata.recovery.authorization.recoveryId,this.metadata.recovery.newMembership);}
 get stateRoot():string{return this.source.stateRoot;}
 assertFinalized():void{if(this.session)this.session.assertFinalized();else this.source.assertFinalized();}
 async stage(service:GraphWitnessService,mode:'bootstrap'|'recover'):Promise<GraphWitnessStagedUpload>{
  if(!(service instanceof GraphWitnessService))throw new Error('witness-bootstrap-actual-service-required');this.assertCurrent();const m=this.metadata,r=m.recovery,reader=this.session??this.source;
  const {revalidations,stateTransferReceipts,sourceManifest,...control}=r;
  const upload=(section:GraphBootstrapSection,index:number,value:unknown)=>{this.assertCurrent();const receipt=service.putBootstrapRow(r.newMembership.agentId,this.plan.transferId,section,index,value);if(receipt.hash!==canonicalHash(value))throw new Error('witness-bootstrap-stream-row-mismatch');};
  if(mode==='bootstrap'){
   service.beginBootstrapTransfer(r.newMembership.agentId,this.plan);
   for(let i=0;i<m.memberships.length;i++)upload('membership',i,m.memberships[i]);
   if(m.archive){for(let i=0;i<m.archive.activations.length;i++)upload('activation',i,m.archive.activations[i]);let offset=0;for(const context of m.archive.contexts){const count=context.manifest.entries.length,pages=Math.max(1,Math.ceil(count/16)),epoch=context.activation.newMembership.epoch;upload('context',epoch-2,{epoch,context:{...context,manifest:{...context.manifest,entries:[]},rewrapInventory:[]},entryCount:count,pageOffset:offset,pageCount:pages});for(let i=0;i<pages;i++)upload('context-page',offset+i,{epoch,index:i,entries:context.manifest.entries.slice(i*16,i*16+16),rewrapInventory:context.rewrapInventory.slice(i*16,i*16+16)});offset+=pages;}}
   upload('control',0,{...control,sourceManifest:{...sourceManifest,entries:[]}});let i=0;
   for(const descriptor of reader.descriptors()){const record=await reader.readRecord(descriptor.eventId);try{if(record.preparationProof||record.erasedControlProof||record.certificate||record.cancellationCertificate)upload('operation',i++,graphMemberLossSourceImport(record));}finally{reader.releasePrivateViews();}}
   for(let i=0;i<m.erasures.length;i++)upload('erasure',i,m.erasures[i]);for(let i=0;i<(m.backupAttestations?.length??0);i++)upload('backup',i,m.backupAttestations![i]);for(let i=0;i<sourceManifest.entries.length;i++)upload('entry',i,sourceManifest.entries[i]);for(let i=0;i<revalidations.length;i++)upload('revalidation',i,revalidations[i]);for(let i=0;i<stateTransferReceipts.length;i++)upload('receipt',i,stateTransferReceipts[i]);i=0;for await(const row of (this.session??this.prepared).envelopes())if(row.rewrap)upload('historical-rewrap',i++,row);this.assertFinalized();this.assertCurrent();return new GraphWitnessStagedUpload(UPLOAD_TOKEN,this,service,()=>service.finishBootstrapTransfer(r.newMembership.agentId,this.plan.transferId));
  }
  const request={...r,historicalRewraps:[]},transferId=graphRecoveryUploadId(request),plan={kind:'recovery' as const,transferId,requestHash:this.recoveryHash,header:{...control,sourceManifest:{...sourceManifest,entries:[]}},hasHistoricalRewraps:true,counts:{entry:sourceManifest.entries.length,revalidation:revalidations.length,receipt:stateTransferReceipts.length,'historical-rewrap':this.plan.counts['historical-rewrap']!}};service.beginRecoveryUpload(r.newMembership.agentId,plan);
  const put=(section:'entry'|'revalidation'|'receipt'|'historical-rewrap',index:number,value:unknown)=>{this.assertCurrent();const receipt=service.putRecoveryUpload(r.newMembership.agentId,transferId,section,index,value);if(receipt.hash!==canonicalHash(value))throw new Error('witness-recovery-stream-row-mismatch');};for(let i=0;i<sourceManifest.entries.length;i++)put('entry',i,sourceManifest.entries[i]);for(let i=0;i<revalidations.length;i++)put('revalidation',i,revalidations[i]);for(let i=0;i<stateTransferReceipts.length;i++)put('receipt',i,stateTransferReceipts[i]);let i=0;for await(const row of (this.session??this.prepared).envelopes())if(row.rewrap)put('historical-rewrap',i++,row);this.assertFinalized();this.assertCurrent();return new GraphWitnessStagedUpload(UPLOAD_TOKEN,this,service,()=>{const result=service.finishRecoveryUpload(r.newMembership.agentId,transferId);return {activation:result.activation,adoptions:Array.from({length:result.adoptionCount},(_,i)=>service.recoveryUploadAdoption(r.newMembership.agentId,transferId,i))};});
 }
 /** Mechanical compatibility helper; production server orchestration uses
  * stage(), then actual fresh owner admission, then synchronous finish(). */
 async apply(service:GraphWitnessService,mode:'bootstrap'|'recover'):Promise<Result>{const staged=await this.stage(service,mode);try{return staged.finish();}finally{staged.close();}}
 close():void{this.session?.close();this.source.close();this.prepared.close();}
}
