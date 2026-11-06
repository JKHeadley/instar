import fs from 'node:fs';
import path from 'node:path';
import type {MachineIdentityManager} from './MachineIdentity.js';
import type {IdentityStore} from './IdentityStore.js';
/** Explicit graph durability barrier for the actual native decryption/signing
 * material. This does not mutate enrollment or change native lease policy. */
export function syncOwnedGraphIdentityDurably(identity:MachineIdentityManager,identities:IdentityStore):void{
 for(const file of [identity.signingKeyPath,identity.encryptionKeyPath,identity.identityPath,identity.registryPath,identities.epochPath]){
  const before=fs.lstatSync(file);if(!before.isFile()||before.isSymbolicLink())throw new Error('graph-native-identity-durability-invalid');
  const descriptor=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));try{const opened=fs.fstatSync(descriptor);if(!opened.isFile()||opened.ino!==before.ino||opened.dev!==before.dev)throw new Error('graph-native-identity-durability-changed');fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
  for(let parent=path.dirname(file);;parent=path.dirname(parent)){const descriptor=fs.openSync(parent,'r');try{fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}if(path.dirname(parent)===parent)break;}
 }
}
