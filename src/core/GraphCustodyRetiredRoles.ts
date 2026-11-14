/** Current verified negative authority purges EVERY discovered custody role.
 * No historical signing key is loaded and no old-role signature is invented. */
import fs from 'node:fs';import path from 'node:path';import Database from 'better-sqlite3';
import {MachineIdentityManager} from './MachineIdentity.js';
import {verifiedGraphMemberLossOwnedRoleClaim} from './GraphMemberLossOwnedRole.js';
import {GraphCustodyProfileAuthority} from './GraphCustodyProfileAuthority.js';
import {ConversationGraphLocalErasureFence} from './ConversationGraphLocalErasure.js';
import {verifyGraphErasureAuthority,verifyGraphErasureIngress,type GraphErasureAuthority,type GraphErasureIngress} from './GraphErasureProtocol.js';
import {canonicalHash,canonicalJson,exactFields,sameGraphErasureIdentity,validateGraphErasureIdentity,validatePacket,verifyEncryptedBundle,verifyBundleRewrap,verifyWitnessLease,verifyFencedLeaseBridge,unsigned,verifyGraphRecord,GRAPH_SIGNATURE_DOMAINS as D,type GraphOperationPacket,type GraphErasureIdentity,type GraphWitnessErasure,type GraphMembershipEpoch} from './GraphWitnessTypes.js';
import {decodeGraphNativeSourceUpload,validateGraphNativeSourceUpload,GRAPH_NATIVE_UPLOAD_DOMAIN,GRAPH_NATIVE_UPLOAD_CHUNK_BYTES} from './GraphNativeSourceUpload.js';
import {verifyGraphControlCapsule} from './GraphWitnessControl.js';
import {assertGraphLocalPath} from './GraphLocalFiles.js';
import {inspectGraphCustodyRoleFiles,type GraphCustodyRoleClaim,type GraphCustodyRoleDiskEntry,type GraphCustodyRoleDiskDebt} from './GraphCustodyRetiredRolesInventory.js';
import {enforceGraphWitnessTargetErasure,enforceGraphWitnessLocalTargetErasure,inspectGraphWitnessTargetBytes,assertGraphWitnessErasureHashBindings} from './GraphWitnessErasureStorage.js';
export type GraphCustodyRoleNegative={proof:GraphWitnessErasure;erasureAuthority:GraphErasureAuthority}|{ingress:GraphErasureIngress;fence:ConversationGraphLocalErasureFence};
export class GraphCustodyRolePurgeDebt extends Error {constructor(readonly debt:readonly {scope:string;reason:string}[]){super('graph-custody-role-purge-evidence-missing');}}
export class GraphCustodyRetiredRoles {
 constructor(private readonly options:{stateDir:string;identity:MachineIdentityManager;authority:GraphCustodyProfileAuthority}){
  if(!(options.identity instanceof MachineIdentityManager)||!(options.authority instanceof GraphCustodyProfileAuthority))throw new Error('graph-role-authority-required');
  if(fs.realpathSync(options.stateDir)!==options.authority.stateRoot||fs.realpathSync(options.identity.baseDir)!==options.authority.stateRoot)throw new Error('graph-role-local-authority-scope-mismatch');
 }
 private context(target:GraphErasureIdentity,evidence:GraphCustodyRoleNegative){
  if(!validateGraphErasureIdentity(target))throw new Error('graph-role-target-invalid');
  const authority=this.options.authority,lineage=authority.verifiedNegativeRoleLineage(),memberships=[lineage.genesis,...lineage.activations.map(row=>row.certificate.newMembership),...lineage.memberLossActivations.map(row=>row.certificate.newMembership)];
  const current=lineage.current,keys=new Map(memberships.map(m=>[m.witnessId,m.custodyProfile?.witnessPublicKey??'']));
  if('proof' in evidence){
   if(!sameGraphErasureIdentity(evidence.proof.target,target)||evidence.proof.agentId!==authority.agentId||canonicalHash(evidence.erasureAuthority.membership)!==canonicalHash(current)
    ||!verifyGraphErasureAuthority(evidence.erasureAuthority,evidence.proof,current,authority.ownerPublicKey,keys))throw new Error('graph-role-erasure-authority-invalid');
  }else{
   const ingress=evidence.ingress,accepted=memberships.find(m=>m.epoch===ingress.membershipEpoch&&canonicalHash(m)===ingress.membershipHash),oldMember=accepted?.members.find(m=>m.machineId===ingress.acceptedBy),member=current.members.find(m=>m.machineId===ingress.acceptedBy);
   if(!(evidence.fence instanceof ConversationGraphLocalErasureFence)||!evidence.fence.targets().some(t=>sameGraphErasureIdentity(t,target))||!accepted||!member||member.signingPublicKey!==oldMember?.signingPublicKey
    ||!sameGraphErasureIdentity(ingress.target,target)||!verifyGraphErasureIngress(ingress,accepted,authority.ownerPublicKey))throw new Error('graph-role-local-ingress-invalid');
   // Bind the deny to this actual state root, not another instance's object.
   const retained=new ConversationGraphLocalErasureFence(this.options.stateDir);if(!retained.durableTargets().some(t=>sameGraphErasureIdentity(t,target)))throw new Error('graph-role-local-deny-not-durable');
  }
  return{lineage,memberships,current};
 }
 private matches(role:GraphCustodyRoleDiskEntry,lineage:ReturnType<GraphCustodyProfileAuthority['verifiedNegativeRoleLineage']>):GraphMembershipEpoch|null{
  const ownerHash=canonicalHash(this.options.authority.ownerPublicKey);
  if(role.kind==='genesis')return lineage.genesis;
  const claim=role.claim;if(!claim||claim.agentId!==this.options.authority.agentId||claim.ownerPublicKeyHash!==ownerHash)return null;
  if('kind' in claim){
   const member=lineage.memberLossActivations.find(row=>canonicalHash(row.certificate.newMembership)===claim.membershipHash)?.certificate.newMembership;if(!member)return null;
   try{const verified=verifiedGraphMemberLossOwnedRoleClaim({stateDir:this.options.stateDir,authority:this.options.authority,membership:member});return verified.databasePath===role.databasePath&&canonicalHash(verified.claim)===canonicalHash(claim)?member:null;}catch{return null;}
  }
  for(const stage of lineage.stages){
   const activation=lineage.activations.find(row=>canonicalHash(row.stage)===canonicalHash(stage));
   const expected:GraphCustodyRoleClaim={v:1,agentId:stage.agentId,witnessId:stage.newMembership.witnessId,membershipHash:canonicalHash(stage.newMembership),ownerPublicKeyHash:ownerHash,stageHash:canonicalHash(stage),retirementHash:activation?canonicalHash(activation.retirement):claim.retirementHash,sourceManifestHash:stage.authorization.sourceManifestHash,rewrapInventoryHash:stage.authorization.rewrapInventoryHash};
   // For an unactivated staged copy, the actually held owner-signed stage
   // binds negative scope. Its retirementHash grants NO activation authority.
   if(canonicalHash(claim)===canonicalHash(expected))return stage.newMembership;
  }return null;
 }
 /** Attribution is an immutable signed packet + owner-verified control proof,
  * never a mutable JSON index field. Refuse before any local role mutation. */
 private verifyStoredBindings(db:Database.Database,memberships:readonly GraphMembershipEpoch[]):void{
  const owner=this.options.authority.ownerPublicKey,bindings=new Map<string,GraphOperationPacket>();
  for(const row of db.prepare('SELECT agentId,eventId,idempotencyKey,operationHash,packet,packetSignature FROM operations').iterate() as Iterable<{agentId:string;eventId:string;idempotencyKey:string;operationHash:string;packet:string;packetSignature:string}>){
   const packet=JSON.parse(row.packet) as GraphOperationPacket;
   const capsuleRow=db.prepare('SELECT body FROM controls WHERE agentId=? AND eventId=?').get(row.agentId,row.eventId) as {body:string}|undefined;
   const capsule=capsuleRow?JSON.parse(capsuleRow.body):null;
   if(!validatePacket(packet)||row.agentId!==this.options.authority.agentId||packet.agentId!==row.agentId||packet.eventId!==row.eventId||packet.idempotencyKey!==row.idempotencyKey||canonicalHash(packet)!==row.operationHash||!verifyGraphControlCapsule(capsule,packet,owner))throw new Error('role-immutable-binding-unverified');
   const historical=memberships.find(m=>canonicalHash(m)===canonicalHash(capsule.authorizationProof.membership));
   const writer=historical?.members.find(m=>m.machineId===packet.writerId);
   if(!writer||!verifyGraphRecord(D.packet,packet,row.packetSignature,writer.signingPublicKey))throw new Error('role-immutable-binding-unverified');
   const prior=bindings.get(packet.sourceBundleHash);if(prior&&!sameGraphErasureIdentity(prior.erasureIdentity,packet.erasureIdentity))throw new Error('role-immutable-binding-conflict');bindings.set(packet.sourceBundleHash,packet);
  }
  for(const row of db.prepare('SELECT agentId,hash,ciphertext FROM bundles WHERE ciphertext IS NOT NULL').iterate() as Iterable<{agentId:string;hash:string;ciphertext:string}>){const packet=bindings.get(row.hash),bundle=JSON.parse(row.ciphertext),membership=packet&&memberships.find(m=>m.epoch===packet.membershipEpoch);if(row.agentId!==this.options.authority.agentId||!packet||!membership||canonicalHash(bundle)!==packet.sourceBundleHash||!verifyEncryptedBundle(bundle,membership))throw new Error('role-private-bundle-unverified');}
  // An unfinished bootstrap may have durable signed operation rows before
  // promotion into operations. Verify their original proofs, not index claims.
  for(const row of db.prepare("SELECT agentId,body FROM witnessTransferRows WHERE section='operation' AND body!='null'").iterate() as Iterable<{agentId:string;body:string}>){
   const staged=JSON.parse(row.body),op=staged.operation,packet=op?.packet as GraphOperationPacket,capsule=op?.controlCapsule;
   const lossSource=staged.kind==='member-loss-source';if(!exactFields(staged,['operation','encryptedSourceBundle',...(lossSource?['kind']:[])])||!op||lossSource&&op.stateProof!==undefined||!exactFields(op,['packet','packetSignature','controlCapsule','prepareProof','erasedControlProof','state','certificate','cancellation','cancellationCertificate','erasure',...(lossSource?[]:['stateProof']),'adoption','rewrap','materialization','certificatePersistenceReceipts'])||row.agentId!==this.options.authority.agentId||!packet||packet.agentId!==row.agentId||!validatePacket(packet)||!verifyGraphControlCapsule(capsule,packet,owner))throw new Error('role-staged-binding-unverified');
   const membership=memberships.find(m=>canonicalHash(m)===canonicalHash(capsule.authorizationProof.membership)),writer=membership?.members.find(m=>m.machineId===packet.writerId);
   if(!writer||!verifyGraphRecord(D.packet,packet,op.packetSignature,writer.signingPublicKey))throw new Error('role-staged-binding-unverified');
   if(staged.encryptedSourceBundle&&(!membership||canonicalHash(staged.encryptedSourceBundle)!==packet.sourceBundleHash||!verifyEncryptedBundle(staged.encryptedSourceBundle,membership)))throw new Error('role-private-bundle-unverified');
   const prior=bindings.get(packet.sourceBundleHash);if(prior&&!sameGraphErasureIdentity(prior.erasureIdentity,packet.erasureIdentity))throw new Error('role-immutable-binding-conflict');bindings.set(packet.sourceBundleHash,packet);
  }
  const byEvent=(eventId:string)=>[...bindings.values()].find(p=>p.eventId===eventId);
  const bundleFor=(packet:GraphOperationPacket)=>{const row=db.prepare('SELECT ciphertext FROM bundles WHERE agentId=? AND hash=?').get(packet.agentId,packet.sourceBundleHash) as {ciphertext:string|null}|undefined;if(row?.ciphertext)return JSON.parse(row.ciphertext);
   for(const staged of db.prepare("SELECT body FROM witnessTransferRows WHERE section='operation' AND body!='null'").iterate() as Iterable<{body:string}>){const value=JSON.parse(staged.body);if(value.operation?.packet?.eventId===packet.eventId&&value.encryptedSourceBundle)return value.encryptedSourceBundle;}throw new Error('role-private-body-binding-unverified');};
  const verifyRewrap=(value:unknown,eventId:string)=>{const packet=byEvent(eventId),rewrap=value as import('./GraphWitnessTypes.js').GraphBundleRewrap;
   const membership=memberships.find(m=>canonicalHash(m)===rewrap?.newMembershipHash);
   if(!packet||!membership||rewrap.eventId!==eventId||rewrap.originalBundleHash!==packet.sourceBundleHash||!verifyBundleRewrap(rewrap,bundleFor(packet),membership))throw new Error('role-private-body-binding-unverified');return packet;};
  // Direct key envelopes are bound by their OWN original signed rewrap, not
  // solely by the mutable eventId column used by the purge SQL.
  for(const row of db.prepare('SELECT agentId,eventId,body FROM rewraps WHERE body IS NOT NULL').iterate() as Iterable<{agentId:string;eventId:string;body:string}>){if(row.agentId!==this.options.authority.agentId)throw new Error('role-private-body-binding-unverified');verifyRewrap(JSON.parse(row.body),row.eventId);}
  // Enumerate every private staged family, including missing indexes. Derive
  // source identity from the retained authenticated body BEFORE comparing both
  // mutable acceleration indexes. Unknown/incomplete attribution is debt.
  for(const row of db.prepare("SELECT agentId,transferId,section,rowIndex,hash,body FROM witnessTransferRows WHERE body!='null' AND (section IN ('operation','historical-rewrap','revalidation','native-source') OR EXISTS(SELECT 1 FROM witnessTransferBindings b WHERE b.agentId=witnessTransferRows.agentId AND b.transferId=witnessTransferRows.transferId AND b.section=witnessTransferRows.section AND b.rowIndex=witnessTransferRows.rowIndex))").iterate() as Iterable<{agentId:string;transferId:string;section:string;rowIndex:number;hash:string;body:string}>){
   const value=JSON.parse(row.body);if(canonicalHash(value)!==row.hash)throw new Error('role-private-body-binding-unverified');let packet:GraphOperationPacket|undefined;
   if(row.section==='operation'){if(!exactFields(value,['operation','encryptedSourceBundle',...(value.kind==='member-loss-source'?['kind']:[])]))throw new Error('role-private-body-binding-unverified');packet=byEvent(value.operation?.packet?.eventId);if(!value.encryptedSourceBundle&&!value.operation?.rewrap)continue;if(value.operation?.rewrap)verifyRewrap(value.operation.rewrap,packet?.eventId??'');}
   else if(row.section==='historical-rewrap'){if(!exactFields(value,['eventId','rewrap']))throw new Error('role-private-body-binding-unverified');packet=verifyRewrap(value.rewrap,value.eventId);}
   else if(row.section==='revalidation'){if(!exactFields(value,['proof','rewrap']))throw new Error('role-private-body-binding-unverified');if(!value.rewrap)continue;
    const original=[...bindings.values()].find(p=>p.idempotencyKey===value.proof?.idempotencyKey);if(!original||value.proof.operationHash!==canonicalHash(original)||value.proof.coreHash!==original.coreHash||value.proof.rewrapHash!==canonicalHash(value.rewrap))throw new Error('role-private-body-binding-unverified');packet=verifyRewrap(value.rewrap,original.eventId);}

   else if(row.section==='native-source'){
    const saved=db.prepare('SELECT plan FROM witnessTransfers WHERE agentId=? AND transferId=?').get(row.agentId,row.transferId) as {plan:string}|undefined;const plan=saved&&JSON.parse(saved.plan);if(!validateGraphNativeSourceUpload(plan))throw new Error('role-private-body-binding-unverified');
    const uploadMembership=memberships.find(m=>m.epoch===plan.lease.membershipEpoch),uploadWriter=uploadMembership?.members.find(m=>m.machineId===plan.lease.writerId);
    const originalMembership=memberships.find(m=>m.epoch===plan.packet.membershipEpoch),originalWriter=originalMembership?.members.find(m=>m.machineId===plan.packet.writerId);
    if(plan.transferId!==row.transferId||plan.packet.agentId!==row.agentId||!validatePacket(plan.packet)||!uploadMembership||!uploadWriter||!verifyWitnessLease(plan.lease,uploadMembership)||!verifyFencedLeaseBridge(plan.lease,plan.originalLease,uploadMembership)||!verifyGraphRecord(GRAPH_NATIVE_UPLOAD_DOMAIN,unsigned(plan),plan.signature,uploadWriter.signingPublicKey)||!originalWriter||!verifyGraphRecord(D.packet,plan.packet,plan.packetSignature,originalWriter.signingPublicKey)||!verifyGraphControlCapsule(plan.controlCapsule,plan.packet,owner)||canonicalHash(plan.controlCapsule.authorizationProof.membership)!==canonicalHash(originalMembership))throw new Error('role-private-body-binding-unverified');
    // A signed original native-writer plan commits EVERY chunk independently.
    // Negative erasure may verify present ACKed pieces without fabricating the
    // missing suffix or waiting for positive upload completion.
    if(!Number.isSafeInteger(row.rowIndex)||row.rowIndex<0||row.rowIndex>=plan.chunkHashes.length||row.hash!==plan.chunkHashes[row.rowIndex]||typeof value!=='string'||!/^[A-Za-z0-9_-]+$/.test(value))throw new Error('role-private-body-binding-unverified');
    const piece=Buffer.from(value,'base64url');try{if(piece.toString('base64url')!==value||piece.length!==Math.min(GRAPH_NATIVE_UPLOAD_CHUNK_BYTES,plan.bytes-row.rowIndex*GRAPH_NATIVE_UPLOAD_CHUNK_BYTES))throw new Error('role-private-body-binding-unverified');}finally{piece.fill(0);}
    packet=plan.packet;const known=byEvent(packet.eventId);if(known&&canonicalHash(known)!==canonicalHash(packet))throw new Error('role-private-body-binding-unverified');
    const chunks=db.prepare("SELECT rowIndex,body FROM witnessTransferRows WHERE agentId=? AND transferId=? AND section='native-source' AND body!='null' ORDER BY rowIndex").all(row.agentId,row.transferId) as {rowIndex:number;body:string}[];
    if(chunks.length===plan.chunkHashes.length){if(chunks.some((c,i)=>c.rowIndex!==i))throw new Error('role-private-body-binding-unverified');const decoded=decodeGraphNativeSourceUpload(plan,chunks.map(c=>JSON.parse(c.body)));if(!decoded.encryptedSourceBundle||canonicalHash(decoded.encryptedSourceBundle)!==packet.sourceBundleHash||!originalMembership||!verifyEncryptedBundle(decoded.encryptedSourceBundle,originalMembership))throw new Error('role-private-body-binding-unverified');}

   }else throw new Error('role-private-body-binding-unverified');
   const binding=db.prepare('SELECT bundleHash FROM witnessTransferBindings WHERE agentId=? AND transferId=? AND section=? AND rowIndex=?').get(row.agentId,row.transferId,row.section,row.rowIndex) as {bundleHash:string}|undefined;
   const target=db.prepare('SELECT sourceKind,sourceId,bundleHash FROM witnessTransferTargets WHERE agentId=? AND transferId=? AND section=? AND rowIndex=?').get(row.agentId,row.transferId,row.section,row.rowIndex) as (GraphErasureIdentity&{bundleHash:string})|undefined;
   if(!packet||row.agentId!==packet.agentId||binding?.bundleHash!==packet.sourceBundleHash||target?.bundleHash!==packet.sourceBundleHash||!sameGraphErasureIdentity(packet.erasureIdentity,{sourceKind:target.sourceKind,sourceId:target.sourceId}))throw new Error('role-private-body-binding-unverified');
  }

 }
 purge(target:GraphErasureIdentity,evidence:GraphCustodyRoleNegative):{purgeInventoryHash:string;roles:readonly string[]}{
  const context=this.context(target,evidence),publicOwner={agentId:this.options.authority.agentId,ownerPublicKey:this.options.authority.ownerPublicKey},before=inspectGraphCustodyRoleFiles(this.options.stateDir,publicOwner),debt:Array<{scope:string;reason:string}>=[...before.debt];
  const self=this.options.identity.loadIdentity().machineId,expected=new Set<string>(),scope=(value:string)=>'custody-role:'+canonicalHash(value);
  if(context.lineage.genesis.custodyProfile?.hostMachineId===self)expected.add(path.join(before.root,'conversation-graph','custody.sqlite'));
  // An epoch advances membership, not necessarily physical custody. Preserve
  // the actual creation path for an unchanged witness ID + key + host; every
  // present copy is still independently inspected below, never deduplicated.
  const roleIdentity=(m:GraphMembershipEpoch)=>canonicalHash({witnessId:m.witnessId,publicKey:m.custodyProfile?.witnessPublicKey??null,hostMachineId:m.custodyProfile?.hostMachineId??null,mode:m.custodyProfile?.mode??null});
  const created=new Set([roleIdentity(context.lineage.genesis)]),physicalPaths=new Map<string,string>();
  if(context.lineage.genesis.custodyProfile?.hostMachineId===self)physicalPaths.set(path.join(before.root,'conversation-graph','custody.sqlite'),roleIdentity(context.lineage.genesis));
  for(const role of [...context.lineage.stages.map(row=>row.newMembership),...context.lineage.memberLossActivations.map(row=>row.certificate.newMembership),...context.lineage.memberLossIntents.map(row=>row.newMembership)].sort((a,b)=>a.epoch-b.epoch)){const key=roleIdentity(role);if(created.has(key))continue;created.add(key);if(role.custodyProfile?.hostMachineId===self){const file=path.join(before.root,'conversation-graph','roles',canonicalHash(role.witnessId),'custody.sqlite');
    // A changed key/host under an already used versioned witness name cannot
    // silently satisfy two distinct creation obligations with one old DB.
    const prior=physicalPaths.get(file);if(prior&&prior!==key)debt.push({scope:scope(file),reason:'role-creation-path-conflict'});physicalPaths.set(file,key);expected.add(file);
   }}
  for(const file of expected)if(!before.roles.some(row=>row.databasePath===file))debt.push({scope:scope(file),reason:'known-role-database-missing'});
  // Cross-target known-hash conflicts abort BEFORE ANY role fence changes.
  // No old key is used; this is public immutable packet/target metadata.
  if('proof' in evidence)for(const role of before.roles){
   const membership=this.matches(role,context.lineage);if(!membership)continue;
   let db:Database.Database|undefined;try{assertGraphLocalPath(before.root,role.databasePath);db=new Database(role.databasePath,{readonly:true,fileMustExist:true});assertGraphWitnessErasureHashBindings(db,membership.agentId,target,evidence.proof.bundleHashes);}
   catch(error){if((error as Error).message==='graph-role-erasure-target-bundle-conflict')throw new GraphCustodyRolePurgeDebt([{scope:membership.witnessId,reason:'cross-target-bundle-conflict'}]);debt.push({scope:membership.witnessId,reason:'role-preflight-unavailable'});}
   finally{db?.close();}
  }
  // Verify every known role before purging any of them: index corruption
  // cannot hide private bytes under a different well-shaped logical target.
  for(const role of before.roles){const membership=this.matches(role,context.lineage);if(!membership)continue;
   let db:Database.Database|undefined;try{assertGraphLocalPath(before.root,role.databasePath);db=new Database(role.databasePath,{readonly:true,fileMustExist:true});this.verifyStoredBindings(db,context.memberships);}
   catch(error){const reason=(error as Error).message;throw new GraphCustodyRolePurgeDebt([{scope:membership.witnessId,reason:['role-staged-binding-unverified','role-private-bundle-unverified','role-immutable-binding-conflict','role-private-body-binding-unverified'].includes(reason)?reason:'role-immutable-binding-unverified'}]);}finally{db?.close();}
  }
  const inspected:Array<{role:string;membershipHash:string;counts:{bundles:number;rewraps:number;transferRows:number};walBytes:number}>=[];
  for(const role of before.roles){
   const membership=this.matches(role,context.lineage);if(!membership){debt.push({scope:scope(role.databasePath),reason:'role-claim-lineage-unverified'});continue;}
   if(role.files.some(file=>file.links!==1&&/custody\.sqlite(?:-wal|-shm)?$/.test(file.relativePath))){debt.push({scope:membership.witnessId,reason:'unbounded-hardlink-alias'});continue;}
   try{
    assertGraphLocalPath(before.root,role.databasePath);const original=fs.lstatSync(role.databasePath);const captured=role.files.find(file=>file.relativePath===path.relative(before.root,role.databasePath));if(!captured||captured.device!==original.dev||captured.inode!==original.ino||original.nlink!==1||!original.isFile()||original.isSymbolicLink())throw new Error('path');
    const db=new Database(role.databasePath,{fileMustExist:true});try{
     const actual=fs.lstatSync(role.databasePath);if(actual.dev!==original.dev||actual.ino!==original.ino||actual.nlink!==1)throw new Error('role-file-changed');
     // Existing rows must identify this exact owner-signed role. An empty
     // staged engine remains negative-only and cannot be bootstrapped here.
     const schema=db.prepare('SELECT MAX(version) AS version FROM witnessTransferBindingVersion').get() as {version:number|null};
     if(schema.version!==3)throw new Error('role-erasure-index-schema-unknown');
     const rows=db.prepare('SELECT body FROM memberships').all() as {body:string}[];
     if(rows.some(row=>{const m=JSON.parse(row.body) as GraphMembershipEpoch;return m.agentId!==membership.agentId||!context.memberships.some(known=>canonicalHash(known)===canonicalHash(m))&&canonicalHash(m)!==canonicalHash(membership);}))throw new Error('role-membership-conflict');
     if(rows.length&& !rows.some(row=>(JSON.parse(row.body) as GraphMembershipEpoch).witnessId===membership.witnessId))throw new Error('role-identity-conflict');
     if(role.kind==='genesis'&&!rows.length)throw new Error('role-identity-conflict');
     if(db.prepare('SELECT 1 FROM agents WHERE agentId<>? LIMIT 1').get(membership.agentId)||db.prepare('SELECT 1 FROM bundles WHERE agentId<>? AND ciphertext IS NOT NULL LIMIT 1').get(membership.agentId))throw new Error('role-identity-conflict');
     this.verifyStoredBindings(db,context.memberships);
     db.pragma('busy_timeout = 5000');db.pragma('secure_delete = ON');db.pragma('synchronous = FULL');
     this.context(target,evidence); // Actual authority is checked again at mutation.
     db.transaction(()=>{'proof' in evidence?enforceGraphWitnessTargetErasure(db,membership.agentId,evidence.proof):enforceGraphWitnessLocalTargetErasure(db,membership.agentId,evidence.ingress);}).immediate();
     const checkpoint=db.pragma('wal_checkpoint(TRUNCATE)') as Array<{busy:number}>;
     const counts=inspectGraphWitnessTargetBytes(db,membership.agentId,target),wal=role.databasePath+'-wal',walBytes=fs.existsSync(wal)?fs.lstatSync(wal).size:0;
     const orphanBundles=(db.prepare("SELECT COUNT(*) AS n FROM bundles b WHERE b.agentId=? AND b.ciphertext IS NOT NULL AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.agentId=b.agentId AND json_extract(o.packet,'$.sourceBundleHash')=b.hash)").get(membership.agentId) as {n:number}).n;
     const orphanRewraps=(db.prepare("SELECT COUNT(*) AS n FROM rewraps r WHERE r.agentId=? AND r.body IS NOT NULL AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.agentId=r.agentId AND o.eventId=r.eventId)").get(membership.agentId) as {n:number}).n;
     if(orphanBundles||orphanRewraps)throw new Error('role-unattributed-private-copy');
     for(const row of db.prepare("SELECT o.packet FROM operations o JOIN bundles b ON b.agentId=o.agentId AND b.hash=json_extract(o.packet,'$.sourceBundleHash') WHERE o.agentId=? AND b.ciphertext IS NOT NULL").iterate(membership.agentId) as Iterable<{packet:string}>){if(!validateGraphErasureIdentity((JSON.parse(row.packet) as {erasureIdentity:unknown}).erasureIdentity))throw new Error('role-unattributed-private-copy');}
     const unboundParts=(db.prepare("SELECT COUNT(*) AS n FROM witnessTransferBindings b JOIN witnessTransferRows r ON r.agentId=b.agentId AND r.transferId=b.transferId AND r.section=b.section AND r.rowIndex=b.rowIndex WHERE b.agentId=? AND r.body!='null' AND NOT EXISTS (SELECT 1 FROM witnessTransferTargets t WHERE t.agentId=b.agentId AND t.transferId=b.transferId AND t.section=b.section AND t.rowIndex=b.rowIndex AND t.bundleHash=b.bundleHash)").get(membership.agentId) as {n:number}).n;
     if(unboundParts)throw new Error('role-unattributed-private-copy');
     if(checkpoint[0]?.busy!==0||walBytes!==0||Object.values(counts).some(count=>count!==0))throw new Error('physical-purge-incomplete');
     inspected.push({role:membership.witnessId,membershipHash:canonicalHash(membership),counts,walBytes});
    }finally{db.close();}
    const fd=fs.openSync(role.databasePath,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));try{const actual=fs.fstatSync(fd);if(actual.dev!==original.dev||actual.ino!==original.ino||actual.nlink!==1)throw new Error('role-file-changed');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    const dir=fs.openSync(role.directory,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
   }catch(error){debt.push({scope:membership.witnessId,reason:(error as Error).message==='graph-role-erasure-target-bundle-conflict'?'cross-target-bundle-conflict':'role-physical-purge-unverified'});}
  }
  const after=inspectGraphCustodyRoleFiles(this.options.stateDir,publicOwner);debt.push(...after.debt);
  if(canonicalHash(before.publicFiles)!==canonicalHash(after.publicFiles))debt.push({scope:'custody-role-public-metadata',reason:'role-inventory-changed'});
  if(canonicalHash(before.roles.map(r=>({path:r.databasePath,claim:r.claim,identities:r.files.filter(f=>/custody\.sqlite$|claim\.json$/.test(f.relativePath)).map(f=>({path:f.relativePath,device:f.device,inode:f.inode,links:f.links}))})))!==canonicalHash(after.roles.map(r=>({path:r.databasePath,claim:r.claim,identities:r.files.filter(f=>/custody\.sqlite$|claim\.json$/.test(f.relativePath)).map(f=>({path:f.relativePath,device:f.device,inode:f.inode,links:f.links}))}))))debt.push({scope:'custody-role-inventory',reason:'role-inventory-changed'});
  if(canonicalHash(context.lineage)!==canonicalHash(this.options.authority.verifiedNegativeRoleLineage()))debt.push({scope:'custody-role-authority',reason:'role-lineage-changed'});
  if(debt.length)throw new GraphCustodyRolePurgeDebt(debt);
  return{purgeInventoryHash:canonicalHash({v:1,target,currentMembershipHash:canonicalHash(context.current),negativeEvidenceHash:canonicalHash('proof'in evidence?{proof:evidence.proof,authority:evidence.erasureAuthority}:evidence.ingress),roles:inspected,inventory:after.inventoryHash}),roles:inspected.map(row=>row.role)};
 }
}
