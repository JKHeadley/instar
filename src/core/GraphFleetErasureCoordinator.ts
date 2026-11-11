/** Priority deletion of graph-captured application custody. It does not erase
 * original platform/legacy transcripts or phone downloads. */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {SafeFsExecutor} from './SafeFsExecutor.js';
import {GraphWitnessClient} from './GraphWitnessClient.js';
import {canonicalHash,canonicalJson,exactFields,opaque,hash,iso,validateGraphErasureIdentity,verifyMembershipEpoch,signGraphRecord,verifyGraphRecord,unsigned,witnessActionPayload,GRAPH_SIGNATURE_DOMAINS as D,
 type GraphMembershipEpoch,type GraphErasureIdentity,type GraphWitnessErasure,type GraphWitnessLease} from './GraphWitnessTypes.js';
import type {LeaseRecord} from './types.js';
import {GRAPH_ERASURE_DOMAINS,GRAPH_ERASURE_SCOPES,signGraphErasureIngress,verifyGraphErasureIngress,verifyGraphErasureMemberReceipt,
 type GraphErasureIngress,type GraphErasureFleetStatus,type GraphErasureMemberReceipt} from './GraphErasureProtocol.js';
export interface GraphFleetErasureOptions {
 directory:string;agentId:string;machineId:string;signingKey:crypto.KeyLike;ownerPublicKey:crypto.KeyLike;
 membership():GraphMembershipEpoch;witness:GraphWitnessClient;
 actuation():{lease:GraphWitnessLease;originalLease:LeaseRecord};
 /** Concrete runtime port drains and inspects all four graph-custody engines. */
 localDeny?(target:GraphErasureIdentity):Promise<void>;
 localPurge(target:GraphErasureIdentity,proof?:GraphWitnessErasure,ingress?:GraphErasureIngress):Promise<{purgeInventoryHash:string}>;
 localDenied(target:GraphErasureIdentity):boolean;
 peerCall(machineId:string,action:'erase-forward'|'erase-purge',body:unknown):Promise<unknown>;
 machineName?(machineId:string):string;
 now?():number;
}
export interface GraphFleetErasureView {
 waitingCopyCount:number;memberBackupDebtCount:number;nextOffset:number|null;
 requestId:string;target:GraphErasureIdentity;state:'local-hidden'|'purging'|'complete';localHidden:boolean;
 capturedGraphCopiesComplete:boolean;liveGraphStoresPurged:boolean;fleetComplete:boolean;debtInventoryKnown:boolean;
 memberBackupDebt:Array<{recipientId:string;machineId:string;name:string;state:'unknown'}>;
 waitingMachines:Array<{machineId:string;name:string;retired:boolean;recipientId:string}>;
 witnessPurge:{walPurged:boolean;externalBackupsVerified:boolean};
 coveredScopes:readonly string[];outsideScope:readonly string[];localIngressDebt:number;
}
const OUTSIDE_SCOPE=['legacy-original-transcripts','platform-sent-copies','phone-downloads'] as const;
export interface GraphErasureLocalDiscovery {requestId:string;ingress:GraphErasureIngress;verification:{kind:'registered-member-signature';membershipHash:string;publication:'published'|'signed-scratch'}}
export class GraphFleetErasureCoordinator {
 private closing=false;
 private readonly activeTemporary=new Set<string>();
 private readonly jobs=new Set<Promise<unknown>>();
 private readonly corruptLocalDebt=new Set<string>();
 private track<T>(work:()=>Promise<T>):Promise<T>{if(this.closing)return Promise.reject(new Error('fleet-erasure-stopped'));const job=Promise.resolve().then(work);this.jobs.add(job);job.finally(()=>this.jobs.delete(job)).catch(()=>{});return job;}
 async close():Promise<void>{this.closing=true;while(this.jobs.size)await Promise.allSettled([...this.jobs]);}
 private readonly running=new Map<string,Promise<GraphFleetErasureView>>();
 constructor(private readonly options:GraphFleetErasureOptions){}
 private file(requestId:string){return path.join(this.options.directory,canonicalHash({agentId:this.options.agentId,requestId})+'.ingress.json');}
 acceptOwner(input:{requestId:string;target:GraphErasureIdentity;principalKey:string;authenticationMethod:GraphErasureIngress['authenticationMethod']}):Promise<GraphFleetErasureView>{return this.track(()=>this.acceptOwnerCore(input));}
 forwardIngress(ingress:GraphErasureIngress,membership:GraphMembershipEpoch):Promise<GraphFleetErasureView>{return this.track(()=>this.forwardIngressCore(ingress,membership));}
 purgeRequest(request:{requestId:string}):Promise<GraphFleetErasureView>{return this.track(()=>this.purgeRequestCore(request));}
 status(requestId:string,options:{offset?:number}={}):Promise<GraphFleetErasureView>{const offset=options.offset??0;if(!Number.isSafeInteger(offset)||offset<0||offset>8192)return Promise.reject(new Error('erasure-status-page-invalid'));return this.track(()=>this.statusCore(requestId,offset));}
 retry():Promise<void>{return this.track(()=>this.retryCore());}
 /** Read-only local discovery. A key pin is described only as a registered
  * member signature, never as proof of historical activation or W acceptance. */
 lookupByTarget(target:GraphErasureIdentity,principalKey:string):Promise<GraphErasureLocalDiscovery|null>{return this.track(async()=>{
  if(!validateGraphErasureIdentity(target)||!opaque(principalKey))throw new Error('erasure-discovery-invalid');
  const membership=this.options.membership();if(!verifyMembershipEpoch(membership,this.options.ownerPublicKey))throw new Error('erasure-discovery-evidence-missing');
  let names:string[];try{names=await fs.readdir(this.options.directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}if(names.length>20000)throw new Error('erasure-discovery-evidence-missing');
  const matches:GraphErasureLocalDiscovery[]=[];
  for(const name of names.sort()){if(!/^[a-f0-9]{64}\.ingress\.json(?:\.[0-9a-f-]{36}\.tmp)?$/.test(name))continue;const file=path.join(this.options.directory,name);let value:GraphErasureIngress;try{value=await this.readFile(file);}catch{continue;}
   if(value?.agentId!==this.options.agentId||value?.principalKey!==principalKey||canonicalHash(value?.target??null)!==canonicalHash(target))continue;
   if(!this.structurallyValid(value,value.requestId)||!file.startsWith(this.file(value.requestId)))throw new Error('erasure-discovery-evidence-missing');
   const member=membership.members.find(member=>member.machineId===value.acceptedBy);
   if(!member||!verifyGraphRecord(GRAPH_ERASURE_DOMAINS.ingress,unsigned(value),value.signature,member.signingPublicKey))throw new Error('erasure-discovery-evidence-missing');
   if([...this.activeTemporary].some(temporary=>temporary.startsWith(this.file(value.requestId)+'.')))throw new Error('erasure-discovery-evidence-missing');
   matches.push({requestId:value.requestId,ingress:value,verification:{kind:'registered-member-signature',membershipHash:canonicalHash(membership),publication:name.endsWith('.tmp')?'signed-scratch':'published'}});
  }
  if(!matches.length)return null;const ids=new Set(matches.map(value=>value.requestId));if(ids.size>1)throw new Error('erasure-discovery-multiple-requests');return matches.find(value=>value.verification.publication==='published')??matches[0];
 });}
 private async syncDirectory():Promise<void>{const dir=await fs.open(this.options.directory,'r');try{await dir.sync();}finally{await dir.close();}}
 private structurallyValid(value:GraphErasureIngress,requestId:string):boolean{return !!value&&exactFields(value,['v','agentId','requestId','target','principalKey','authenticationMethod','acceptedBy','membershipEpoch','membershipHash','acceptedAt','signature'])&&value.v===1&&value.agentId===this.options.agentId&&value.requestId===requestId&&opaque(requestId)&&validateGraphErasureIdentity(value.target)&&opaque(value.principalKey)&&opaque(value.acceptedBy)&&hash(value.membershipHash)&&Number.isSafeInteger(value.membershipEpoch)&&value.membershipEpoch>0&&iso(value.acceptedAt)&&['owner-device','owner-dashboard','owner-callback'].includes(value.authenticationMethod)&&typeof value.signature==='string'&&/^[A-Za-z0-9_-]{86}$/.test(value.signature);}
 private async readFile(file:string):Promise<GraphErasureIngress>{const fd=await fs.open(file,'r');try{if((await fd.stat()).size>65536)throw new Error('erasure-ingress-size');return JSON.parse(await fd.readFile('utf8')) as GraphErasureIngress;}finally{await fd.close();}}
 private async quarantine(file:string):Promise<void>{
  const quarantine=`${file}.${crypto.randomUUID()}.corrupt`;try{await fs.link(file,quarantine);await this.syncDirectory();await SafeFsExecutor.safeUnlink(file,{operation:'graph-erasure:quarantine-torn-ingress'});await this.syncDirectory();this.corruptLocalDebt.add(path.basename(quarantine));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 }
 private async saveIngress(ingress:GraphErasureIngress):Promise<void>{
  await fs.mkdir(this.options.directory,{recursive:true,mode:0o700});const parent=await fs.open(path.dirname(this.options.directory),'r');try{await parent.sync();}finally{await parent.close();}const file=this.file(ingress.requestId),temporary=`${file}.${crypto.randomUUID()}.tmp`;
  const existing=await this.readIngress(ingress.requestId);if(existing){if(canonicalHash(existing)!==canonicalHash(ingress))throw new Error('erasure-request-id-conflict');const retained=await fs.open(file,'r');try{await retained.sync();}finally{await retained.close();}await this.syncDirectory();const check=await this.readFile(file);if(canonicalHash(check)!==canonicalHash(ingress))throw new Error('erasure-ingress-durability-changed');return;}
  this.activeTemporary.add(temporary);
  try{const fd=await fs.open(temporary,'wx',0o600);try{await fd.writeFile(canonicalJson(ingress));await fd.sync();}finally{await fd.close();}
   try{await fs.link(temporary,file);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const prior=await this.readIngress(ingress.requestId);if(!prior||canonicalHash(prior)!==canonicalHash(ingress))throw new Error('erasure-request-id-conflict');}
   await this.syncDirectory();
  }finally{this.activeTemporary.delete(temporary);await SafeFsExecutor.safeUnlink(temporary,{operation:'graph-erasure:ingress-temporary-cleanup'});}
 }
 private async readIngress(requestId:string):Promise<GraphErasureIngress|null>{
  const file=this.file(requestId);
  try{const value=await this.readFile(file);if(!this.structurallyValid(value,requestId))throw new Error('erasure-ingress-corrupt');const current=this.options.membership();if(current.epoch===value.membershipEpoch&&canonicalHash(current)===value.membershipHash&&!verifyGraphErasureIngress(value,current,this.options.ownerPublicKey))throw new Error('erasure-ingress-signature-corrupt');return value;}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')await this.quarantine(file);}
  // A process may die after a complete fsynced temporary but before publication.
  // Recover ONLY its actual signed owner receipt, never infer a grant from deny.
  let names:string[];try{names=await fs.readdir(this.options.directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  if(names.length>20000)throw new Error('erasure-local-ledger-bound');
  const prefix=path.basename(file)+'.';
  for(const name of names.sort()){if(!name.startsWith(prefix)||!name.endsWith('.tmp'))continue;const temporary=path.join(this.options.directory,name);if(this.activeTemporary.has(temporary))continue;let value:GraphErasureIngress;
   try{value=await this.readFile(temporary);if(!this.structurallyValid(value,requestId))throw new Error('erasure-ingress-corrupt');}catch{await this.quarantine(temporary);continue;}
   let membership:GraphMembershipEpoch;try{const current=this.options.membership();membership=current.epoch===value.membershipEpoch?current:await this.options.witness.membership(value.membershipEpoch);}catch{continue;}
   if(!verifyGraphErasureIngress(value,membership,this.options.ownerPublicKey)){await this.quarantine(temporary);continue;}
   const durable=await fs.open(temporary,'r');try{await durable.sync();}finally{await durable.close();}
   try{await fs.link(temporary,file);await this.syncDirectory();}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const prior=await this.readFile(file);if(!this.structurallyValid(prior,requestId))throw new Error('erasure-ingress-conflict');return prior;}
   await SafeFsExecutor.safeUnlink(temporary,{operation:'graph-erasure:recover-published-ingress'});await this.syncDirectory();return value;
  }return null;
 }
 /** Called only by the authenticated owner route after resolving its real
  * principal. No owner/grant assertion is accepted from an external body. */
 private async acceptOwnerCore(input:{requestId:string;target:GraphErasureIdentity;principalKey:string;authenticationMethod:GraphErasureIngress['authenticationMethod']}):Promise<GraphFleetErasureView>{
  const o=this.options;if(!opaque(input.requestId)||!opaque(input.principalKey)||!validateGraphErasureIdentity(input.target)||!['owner-device','owner-dashboard','owner-callback'].includes(input.authenticationMethod))throw new Error('erasure-request-invalid');
  const existing=await this.readIngress(input.requestId);
  if(existing&&(canonicalHash(existing.target)!==canonicalHash(input.target)||existing.principalKey!==input.principalKey))throw new Error('erasure-request-id-conflict');
  // Real local serving deny happens before the ordinary mutation queue, W, or
  // any peer call. The disk inspection also completes before returning hide.
  if(o.localDeny)await o.localDeny(input.target);else await o.localPurge(input.target);
  const membership=o.membership();if(!verifyMembershipEpoch(membership,o.ownerPublicKey))throw new Error('erasure-membership-invalid');
  const ingress=existing??signGraphErasureIngress({v:1,agentId:o.agentId,requestId:input.requestId,target:input.target,principalKey:input.principalKey,authenticationMethod:input.authenticationMethod,acceptedBy:o.machineId,membershipEpoch:membership.epoch,membershipHash:canonicalHash(membership),acceptedAt:new Date(o.now?.()??Date.now()).toISOString()},o.signingKey);
  if(!existing&&!verifyGraphErasureIngress(ingress,membership,o.ownerPublicKey))throw new Error('erasure-ingress-invalid');
  await this.saveIngress(ingress);await o.localPurge(ingress.target,undefined,ingress);return this.drive(ingress);
 }
 private localView(ingress:Pick<GraphErasureIngress,'requestId'|'target'>,offset=0):GraphFleetErasureView {
  const membership=this.options.membership(),backup=membership.members.map(m=>({recipientId:canonicalHash({agentId:this.options.agentId,machineId:m.machineId,signingPublicKey:m.signingPublicKey}),machineId:m.machineId,name:this.options.machineName?.(m.machineId)??'An installed machine',state:'unknown' as const}));
  const waiting=backup.filter(m=>m.machineId!==this.options.machineId).map(m=>({recipientId:m.recipientId,machineId:m.machineId,name:m.name,retired:false}));
  return {waitingCopyCount:waiting.length,memberBackupDebtCount:backup.length,nextOffset:Math.max(waiting.length,backup.length)>offset+64?offset+64:null,requestId:ingress.requestId,target:ingress.target,state:'local-hidden',localHidden:this.options.localDenied(ingress.target),capturedGraphCopiesComplete:false,liveGraphStoresPurged:false,fleetComplete:false,debtInventoryKnown:false,memberBackupDebt:backup.slice(offset,offset+64),waitingMachines:waiting.slice(offset,offset+64),witnessPurge:{walPurged:false,externalBackupsVerified:false},coveredScopes:GRAPH_ERASURE_SCOPES,outsideScope:OUTSIDE_SCOPE,localIngressDebt:this.corruptLocalDebt.size};
 }

 private async forwardIngressCore(ingress:GraphErasureIngress,membership:GraphMembershipEpoch):Promise<GraphFleetErasureView>{
  const o=this.options;if(!verifyGraphErasureIngress(ingress,membership,o.ownerPublicKey)||ingress.agentId!==o.agentId)throw new Error('erasure-ingress-invalid');
  // An old removed key cannot create a fresh owner claim after retirement.
  const original=membership.members.find(m=>m.machineId===ingress.acceptedBy),current=o.membership().members.find(m=>m.machineId===ingress.acceptedBy);
  if(!original||!current||original.signingPublicKey!==current.signingPublicKey)throw new Error('erasure-ingress-retired-authority');
  const active=await o.witness.membership(ingress.membershipEpoch);if(canonicalHash(active)!==canonicalHash(membership))throw new Error('erasure-ingress-unactivated-membership');if(active.epoch>1)await o.witness.activation(active.epoch);
  const prior=await this.readIngress(ingress.requestId);if(prior&&canonicalHash(prior)!==canonicalHash(ingress))throw new Error('erasure-request-id-conflict');
  if(o.localDeny)await o.localDeny(ingress.target);else await o.localPurge(ingress.target);await this.saveIngress(ingress);await o.localPurge(ingress.target,undefined,ingress);
  o.actuation();return this.drive(ingress,true);
 }
 private drive(ingress:GraphErasureIngress,holderOnly=false):Promise<GraphFleetErasureView>{
  const prior=this.running.get(ingress.requestId);if(prior)return prior;
  const run=this.driveCore(ingress,holderOnly).finally(()=>this.running.delete(ingress.requestId));this.running.set(ingress.requestId,run);return run;
 }
 private async driveCore(ingress:GraphErasureIngress,holderOnly:boolean):Promise<GraphFleetErasureView>{
  const o=this.options;
  try{
   let known:GraphErasureFleetStatus|null=null;try{known=await o.witness.fleetErasureStatus(ingress.requestId);}catch{/* A never-registered intent still needs native-holder admission. */}
   if(known){if(canonicalHash(known.proof.target)!==canonicalHash(ingress.target))throw new Error('erasure-request-id-conflict');await this.purgeVerified(known);for(const member of o.membership().members){if(member.machineId===o.machineId)continue;try{await o.peerCall(member.machineId,'erase-purge',{requestId:ingress.requestId});}catch{/* Existing signed erasure debt remains. */}}return this.statusCore(ingress.requestId);}
   const current=o.actuation(),membership=await o.witness.membership(ingress.membershipEpoch);if(canonicalHash(membership)!==ingress.membershipHash||!verifyGraphErasureIngress(ingress,membership,o.ownerPublicKey))throw new Error('erasure-ingress-invalid');if(membership.epoch>1)await o.witness.activation(membership.epoch);
   const fields={requestId:ingress.requestId,target:ingress.target,bundleHashes:[],authorizationReceiptHash:canonicalHash(ingress)};
   const status=await o.witness.beginFleetErasure(ingress,[],current.lease,current.originalLease,signGraphRecord(D.action,witnessActionPayload('erase',fields,current.lease),o.signingKey));
   await this.purgeVerified(status);
   for(const member of o.membership().members){if(member.machineId===o.machineId)continue;try{await o.peerCall(member.machineId,'erase-purge',{requestId:ingress.requestId});}catch{/* A sleeping copy remains a named durable obligation. */}}
   return this.statusCore(ingress.requestId);
  }catch{
   if(!holderOnly){for(const member of o.membership().members){if(member.machineId===o.machineId)continue;try{
      await o.peerCall(member.machineId,'erase-forward',{ingress,membership:await o.witness.membership(ingress.membershipEpoch)});return await this.statusCore(ingress.requestId);
     }catch{/* Only a real admitted holder may advance the request. */}}}
   return this.localView(ingress);
  }
 }
 private async purgeVerified(status:GraphErasureFleetStatus):Promise<void>{
  const o=this.options,current=o.membership();if(status.plan.activatedEpochs.length<current.epoch||status.plan.activatedEpochs[current.epoch-1]?.membershipHash!==canonicalHash(current))throw new Error('erasure-membership-rollback');
  const inventory=await o.localPurge(status.proof.target,status.proof);
  const key=crypto.createPublicKey(o.signingKey).export({type:'spki',format:'pem'}).toString();
  const own=status.plan.requiredRecipients.filter(recipient=>recipient.machineId===o.machineId&&recipient.signingPublicKey===key);
  if(!own.length)throw new Error('erasure-recipient-key-not-enrolled');
  for(const recipient of own){if(status.receipts.some(r=>r.recipientId===recipient.recipientId))continue;
   const value={v:1 as const,agentId:o.agentId,requestId:status.proof.requestId,ingressHash:status.proof.authorizationReceiptHash,erasureHash:canonicalHash(status.proof),target:status.proof.target,recipientId:recipient.recipientId,machineId:o.machineId,coveredScopes:[...GRAPH_ERASURE_SCOPES],uncoveredScopes:[],purgeInventoryHash:inventory.purgeInventoryHash,purgedAt:new Date(o.now?.()??Date.now()).toISOString()};
   const receipt:GraphErasureMemberReceipt={...value,signature:signGraphRecord(GRAPH_ERASURE_DOMAINS.receipt,value,o.signingKey)};if(!verifyGraphErasureMemberReceipt(receipt,status))throw new Error('erasure-receipt-self-check-failed');await o.witness.acknowledgeFleetErasure(status.proof.requestId,receipt);
  }
 }
 private async purgeRequestCore(request:{requestId:string}):Promise<GraphFleetErasureView>{if(!opaque(request?.requestId))throw new Error('erasure-request-invalid');const status=await this.options.witness.fleetErasureStatus(request.requestId);await this.purgeVerified(status);return this.statusCore(request.requestId);}
 private async statusCore(requestId:string,offset=0):Promise<GraphFleetErasureView>{
  const o=this.options;if(!opaque(requestId))throw new Error('erasure-request-invalid');
  try{let status=await o.witness.fleetErasureStatus(requestId);if(status.plan.activatedEpochs.length<o.membership().epoch||status.plan.activatedEpochs[o.membership().epoch-1]?.membershipHash!==canonicalHash(o.membership()))throw new Error('erasure-membership-rollback');await this.purgeVerified(status);status=await o.witness.fleetErasureStatus(requestId);const acked=new Set(status.receipts.filter(receipt=>!receipt.uncoveredScopes.length).map(receipt=>receipt.recipientId));
   const waiting=status.plan.requiredRecipients.filter(r=>!acked.has(r.recipientId)).map(r=>({recipientId:r.recipientId,machineId:r.machineId,name:o.machineName?.(r.machineId)??r.machineId,retired:!o.membership().members.some(m=>m.machineId===r.machineId&&m.signingPublicKey===r.signingPublicKey)}));
   let walPurged=false,externalBackupsVerified=false;try{const checkpoint=await o.witness.checkpointErasure(requestId);walPurged=checkpoint.walPurged;externalBackupsVerified=checkpoint.externalBackupsVerified;}catch{/* No physical or provider proof is invented. */}
   const memberBackupDebt=status.plan.requiredRecipients.map(r=>({recipientId:r.recipientId,machineId:r.machineId,name:o.machineName?.(r.machineId)??'An earlier installed machine',state:'unknown' as const}));
   // No installed-machine snapshot/backup exclusion or purge policy has been
   // independently verified. W-domain backup evidence cannot release this debt.
   const complete=!waiting.length&&!memberBackupDebt.length&&walPurged&&externalBackupsVerified;return {waitingCopyCount:waiting.length,memberBackupDebtCount:memberBackupDebt.length,nextOffset:Math.max(waiting.length,memberBackupDebt.length)>offset+64?offset+64:null,requestId,target:status.proof.target,state:complete?'complete':'purging',localHidden:o.localDenied(status.proof.target),capturedGraphCopiesComplete:!waiting.length,liveGraphStoresPurged:!waiting.length,fleetComplete:complete,debtInventoryKnown:true,memberBackupDebt:memberBackupDebt.slice(offset,offset+64),waitingMachines:waiting.slice(offset,offset+64),witnessPurge:{walPurged,externalBackupsVerified},coveredScopes:GRAPH_ERASURE_SCOPES,outsideScope:OUTSIDE_SCOPE,localIngressDebt:this.corruptLocalDebt.size};
  }catch(error){const ingress=await this.readIngress(requestId);if(ingress)return this.localView(ingress,offset);throw error;}
 }
 /** Real runtime timer/boot invokes this; requests survive crash in fsynced
  * opaque ingress files and independent W tombstones/debt. */
 private async retryCore():Promise<void>{
  let ids:string[]=[];try{ids=await this.options.witness.pendingFleetErasures();}catch{/* Local requests still retry when W returns. */}
  for(const requestId of ids){try{await this.purgeRequestCore({requestId});}catch{/* Retain deletion debt; never turn absence into a receipt. */}}
  let files:string[]=[];try{files=await fs.readdir(this.options.directory);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(files.length>20000)throw new Error('erasure-local-ledger-bound');
  for(const file of files){
   if(file.endsWith('.corrupt')){this.corruptLocalDebt.add(file);continue;}
   if(!/^[a-f0-9]{64}\.ingress\.json(?:\.[0-9a-f-]{36}\.tmp)?$/.test(file))continue;
   const full=path.join(this.options.directory,file);if(this.activeTemporary.has(full))continue;
   try{const raw=await this.readFile(full);if(!this.structurallyValid(raw,raw.requestId)||!full.startsWith(this.file(raw.requestId)))throw new Error('erasure-local-ledger-corrupt');const value=await this.readIngress(raw.requestId);if(value)await this.drive(value);}
   catch{try{await this.quarantine(full);}catch{this.corruptLocalDebt.add(file);/* Unmovable evidence remains debt, never an invented owner grant. */}/* One torn slot never suppresses other accepted deletion requests. */}
  }
 }
}
