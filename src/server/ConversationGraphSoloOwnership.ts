/** Genuine one-member topic ownership uses the existing durable FSM/CAS. It is
 * never synthesized from a native epoch or used for a paired installation. */
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {LocalSessionOwnershipStore} from '../core/LocalSessionOwnershipStore.js';
import {SessionOwnershipRegistry} from '../core/SessionOwnershipRegistry.js';
import {assertGraphLocalPath,ensureGraphLocalDirectory} from '../core/GraphLocalFiles.js';
import {ownedGraphInstalledRoster} from '../core/OwnedGraphCustody.js';
import {canonicalHash} from '../core/GraphWitnessTypes.js';
import type {ConversationGraphDelegationCompositionOptions} from './ConversationGraphDelegationComposition.js';
import type {GraphDelegationConversationRef} from '../core/ConversationGraphDelegation.js';
export function createConversationGraphSoloOwnership(o:Omit<ConversationGraphDelegationCompositionOptions,'ownership'>&{instanceLock:import('../core/SingleInstanceLock.js').SingleInstanceLock;identities:import('../core/IdentityStore.js').IdentityStore}){
 const root=fs.realpathSync(o.state.baseDir),directory=path.join(root,'ownership','local');ensureGraphLocalDirectory(root,directory);
 const store=new LocalSessionOwnershipStore({dir:directory}),seen=new Set<string>();
 const registry=new SessionOwnershipRegistry({store,seenNonce:key=>seen.has(key),recordNonce:key=>{seen.add(key);}});
 const native=()=>{const membership=o.runtime.installedMembership,id=o.identity.loadIdentity().machineId;
  const admitted=ownedGraphInstalledRoster(o.identity,o.identities);
  if(membership.members.length!==1||membership.members[0].machineId!==id||admitted.length!==1||admitted[0].machineId!==id||canonicalHash(admitted)!==canonicalHash(membership.members)||!o.instanceLock.revalidate()||!o.coordinator.holdsLease()
   ||o.coordinator.currentLease()?.holder!==id||!o.admission.evaluate('cluster-shared').admit)throw new Error('graph-solo-ownership-authority-unavailable');return id;};
 const confirm=(key:string)=>{const file=path.join(directory,key+'.json');assertGraphLocalPath(root,file);const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));let raw:unknown;
  try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>65536)throw new Error('graph-solo-ownership-file-invalid');fs.fsyncSync(fd);raw=JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}
  const dir=fs.openSync(directory,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}if(canonicalHash(raw)!==canonicalHash(registry.read(key)))throw new Error('graph-solo-ownership-readback-failed');};
 const establish=(refs:readonly GraphDelegationConversationRef[])=>{
  const id=native();for(const ref of refs){if(ref.platform!=='telegram'||ref.chatId!==o.telegramChatId)throw new Error('graph-solo-binding-unsupported');
   const key=String(ref.topicId);let current=registry.read(key);
   // A corrupt existing file must never become an inferred absent record.
   if(!current&&fs.existsSync(path.join(directory,key+'.json')))throw new Error('graph-solo-ownership-existing-unverified');
   if(current&&current.ownerMachineId!==id)throw new Error('graph-solo-ownership-foreign');
   if(!current||current.status==='released'){native();const placed=registry.cas({type:'place',machineId:id},{sessionKey:key,sender:id,nonce:crypto.randomUUID()});if(!placed.ok)throw new Error('graph-solo-ownership-place-refused');confirm(key);current=registry.read(key);}
   if(current?.status==='placing'){confirm(key);native();const claimed=registry.cas({type:'claim',machineId:id},{sessionKey:key,sender:id,nonce:crypto.randomUUID()});if(!claimed.ok)throw new Error('graph-solo-ownership-claim-refused');}
   current=registry.read(key);if(current?.status!=='active'||current.ownerMachineId!==id)throw new Error('graph-solo-ownership-not-active');confirm(key);
  }
 };
 return{registry,establish};
}
