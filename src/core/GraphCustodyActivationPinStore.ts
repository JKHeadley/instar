/** Actual installed-member ACT import durability. This store never unlocks a
 * profile itself; the authority requires the complete verified pin set. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {MachineIdentityManager} from './MachineIdentity.js';
import {IdentityStore} from './IdentityStore.js';
import {ConversationGraphReplicationTransfer,type GraphSourceTransferStage} from './ConversationGraphReplicationTransfer.js';
import {GraphTransferCustodyReader} from './ConversationGraphTransferCustody.js';
import {GraphCustodyProfileAuthority,type GraphOwnedTransitionProof} from './GraphCustodyProfileAuthority.js';
import {syncOwnedGraphIdentityDurably} from './GraphCustodyDurability.js';
import {assertGraphLocalPath,ensureGraphLocalDirectory} from './GraphLocalFiles.js';
import {SafeFsExecutor} from './SafeFsExecutor.js';
import {canonicalHash,canonicalJson,type GraphMembershipEpoch,type GraphMembershipActivationCertificate} from './GraphWitnessTypes.js';
import {signGraphCustodyImportedState,signGraphCustodyActivationPin,verifyGraphCustodyActivationPin,type GraphCustodyActivationPin} from './GraphCustodyActivationPinTypes.js';
export class GraphCustodyActivationPinStore {
 private readonly root:string;private readonly directory:string;private queue:Promise<unknown>=Promise.resolve();
 constructor(private readonly options:{stateDir:string;identity:MachineIdentityManager;identities:IdentityStore;authority:GraphCustodyProfileAuthority;transfer:ConversationGraphReplicationTransfer}){
  if(!(options.identity instanceof MachineIdentityManager)||!(options.identities instanceof IdentityStore)||!(options.authority instanceof GraphCustodyProfileAuthority)||!(options.transfer instanceof ConversationGraphReplicationTransfer))throw new Error('graph-custody-pin-actual-stores-required');
  this.root=fs.realpathSync(options.stateDir);if(this.root!==options.authority.stateRoot||fs.realpathSync(options.identity.baseDir)!==this.root||fs.realpathSync(path.dirname(options.identities.epochPath))!==path.join(this.root,'state')||path.basename(options.identities.epochPath)!=='identity-epochs.json')throw new Error('graph-custody-pin-state-mismatch');this.directory=path.join(this.root,'conversation-graph','activation-pins',canonicalHash(options.authority.agentId));
 }
 private self(membership:GraphMembershipEpoch):string{const {identity,identities}=this.options,machineId=identity.loadIdentity().machineId,member=membership.members.find(row=>row.machineId===machineId);if(!member||identities.getEpoch(machineId).revokedAt||identity.getSigningPublicKeyPem(machineId)!==member.signingPublicKey||identity.getEncryptionPublicKeyPem(machineId)!==member.sealingPublicKey)throw new Error('graph-custody-pin-recipient-not-current');return machineId;}
 private file(digest:string):string{const file=path.join(this.directory,digest+'.json');assertGraphLocalPath(this.root,file);return file;}
 private read(file:string):GraphCustodyActivationPin|null{try{assertGraphLocalPath(this.root,file);const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw new Error('graph-custody-pin-file-invalid');return JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}
 private persist(file:string,pin:GraphCustodyActivationPin):void{ensureGraphLocalDirectory(this.root,this.directory);const bytes=canonicalJson(pin);if(Buffer.byteLength(bytes)>65536)throw new Error('graph-custody-pin-capacity');const temporary=file+'.'+crypto.randomUUID()+'.pending',fd=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}try{try{fs.linkSync(temporary,file);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||canonicalJson(this.read(file))!==bytes)throw new Error('graph-custody-pin-conflict');}}finally{SafeFsExecutor.safeUnlinkSync(temporary,{operation:'graph-custody-pin:scratch'});}
  const before=fs.lstatSync(file),retained=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));try{const opened=fs.fstatSync(retained);if(!opened.isFile()||before.isSymbolicLink()||opened.ino!==before.ino||opened.dev!==before.dev)throw new Error('graph-custody-pin-file-changed');fs.fsyncSync(retained);}finally{fs.closeSync(retained);}for(let directory=this.directory;;directory=path.dirname(directory)){const handle=fs.openSync(directory,'r');try{fs.fsyncSync(handle);}finally{fs.closeSync(handle);}if(path.dirname(directory)===directory)break;}if(canonicalHash(this.read(file))!==canonicalHash(pin))throw new Error('graph-custody-pin-readback-invalid');
 }
 pin(transition:GraphOwnedTransitionProof,activation:GraphMembershipActivationCertificate,sourceStage:GraphSourceTransferStage):Promise<GraphCustodyActivationPin>{const retainedTransition=structuredClone(transition),retainedActivation=structuredClone(activation),retainedSourceStage=structuredClone(sourceStage),views=this.options.transfer.retainPrivateStageViews(retainedSourceStage);const run=this.queue.then(()=>this.pinCore(retainedTransition,retainedActivation,retainedSourceStage)).finally(()=>{try{views.close();}finally{for(const record of retainedSourceStage.records){record.encryptedSourceBundle=null;delete record.rewrap;}retainedSourceStage.records.length=0;retainedSourceStage.rewraps.length=0;}});this.queue=run.catch(()=>{/* @silent-fallback-ok: failed pin remains rejected to its caller; queue tail only permits a truthful retry */});return run;}
 /** Import only the actual retained owner plan, one private row at a time.
  * Root stage/union holds/old-role retirement and ACT remain unchanged. */
 pinRetained(transition:GraphOwnedTransitionProof,activation:GraphMembershipActivationCertificate,reader:GraphTransferCustodyReader):Promise<GraphCustodyActivationPin>{
  if(!(reader instanceof GraphTransferCustodyReader))throw new Error('graph-custody-pin-actual-reader-required');const retainedTransition=structuredClone(transition),retainedActivation=structuredClone(activation),run=this.queue.then(()=>this.pinRetainedCore(retainedTransition,retainedActivation,reader)).finally(()=>reader.close());this.queue=run.catch(()=>{/* @silent-fallback-ok: failed physical import remains a rejected pin; the queue tail only permits exact durable retry. */});return run;
 }
 private async pinRetainedCore(transition:GraphOwnedTransitionProof,activation:GraphMembershipActivationCertificate,reader:GraphTransferCustodyReader):Promise<GraphCustodyActivationPin>{
  const {authority,transfer}=this.options,{stage,holds,retirement}=transition,metadata=reader.metadata,machineId=this.self(stage.newMembership);
  if(canonicalHash(metadata.newMembership)!==canonicalHash(stage.newMembership)||canonicalHash(metadata.previousMembership)!==canonicalHash(stage.previousMembership)||canonicalHash(metadata.authorization)!==canonicalHash(stage.authorization)||canonicalHash(metadata.manifest)!==stage.authorization.sourceManifestHash)throw new Error('graph-custody-pin-transfer-mismatch');
  authority.stageActivation(stage,activation,holds,retirement);transfer.assertLocalCustodyContext({stateRoot:this.root,agentId:authority.agentId,machineId,authority});const imported=await transfer.postActivationTransferReceiptReader(reader,activation,authority);return this.finalizePin(transition,activation,imported);
 }
 private async pinCore(transition:GraphOwnedTransitionProof,activation:GraphMembershipActivationCertificate,sourceStage:GraphSourceTransferStage):Promise<GraphCustodyActivationPin>{const {authority,identity,identities,transfer}=this.options,{stage,holds,retirement}=transition,membership=stage.newMembership,machineId=this.self(membership);
  if(canonicalHash(sourceStage.newMembership)!==canonicalHash(membership)||canonicalHash(sourceStage.previousMembership)!==canonicalHash(stage.previousMembership)||canonicalHash(sourceStage.authorization)!==canonicalHash(stage.authorization))throw new Error('graph-custody-pin-transfer-mismatch');
  // A genuine certificate is retained first, with no positive activation.
  authority.stageActivation(stage,activation,holds,retirement);
  const imported=await transfer.postActivationTransferReceipt(sourceStage,activation);return this.finalizePin(transition,activation,imported);
 }
 private finalizePin(transition:GraphOwnedTransitionProof,activation:GraphMembershipActivationCertificate,imported:Awaited<ReturnType<ConversationGraphReplicationTransfer['postActivationTransferReceipt']>>):GraphCustodyActivationPin{
  const {authority,identity,identities}=this.options,{stage,holds,retirement}=transition,membership=stage.newMembership,machineId=this.self(membership);if(imported.receipt.machineId!==machineId)throw new Error('graph-custody-pin-import-recipient-mismatch');syncOwnedGraphIdentityDurably(identity,identities);if(this.self(membership)!==machineId)throw new Error('graph-custody-pin-recipient-not-current');
  const digest=canonicalHash({stageHash:canonicalHash(stage),activationHash:canonicalHash(activation),machineId}),file=this.file(digest),prior=this.read(file);let pin=prior;
  if(!pin){const binding={v:1 as const,agentId:membership.agentId,machineId,stageHash:canonicalHash(stage),activationHash:canonicalHash(activation),membershipHash:canonicalHash(membership)},postImportReceipt=signGraphCustodyImportedState({...binding,sourceTransferReceiptHash:canonicalHash(imported.receipt),importInventoryHash:imported.inventoryHash,persistedAt:new Date().toISOString()},identity.loadSigningKey());pin=signGraphCustodyActivationPin({...binding,postImportTransferReceiptHash:canonicalHash(imported.receipt),postImportTransferReceipt:imported.receipt,postImportReceipt,postImportReceiptHash:canonicalHash(postImportReceipt),pinnedAt:new Date().toISOString()},identity.loadSigningKey());}
  if(pin.machineId!==machineId||!verifyGraphCustodyActivationPin(pin,stage,activation,authority.ownerPublicKey))throw new Error('graph-custody-pin-invalid');this.persist(file,pin);authority.stageActivation(stage,activation,holds,retirement);if(this.self(membership)!==machineId)throw new Error('graph-custody-pin-recipient-not-current');return pin;
 }
}
