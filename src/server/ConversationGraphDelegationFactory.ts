/** Late composition from the default factory's actual native dependencies.
 * Missing fleet/solo authority holds; no replacement lease or owner bool. */
import fs from 'node:fs';
import {MachineIdentityManager} from '../core/MachineIdentity.js';
import {IdentityStore} from '../core/IdentityStore.js';
import {LeaseCoordinator} from '../core/LeaseCoordinator.js';
import {WriteAdmission} from '../core/WriteAdmission.js';
import {SingleInstanceLock} from '../core/SingleInstanceLock.js';
import type {ConversationGraphReplicationRuntimeOptions} from './ConversationGraphReplicationRuntime.js';
import type {ConversationGraphDelegationFactory} from './ConversationGraphDelegationManager.js';
import {createConversationGraphDelegationComposition,createConversationGraphDelegationContext,type ConversationGraphDelegationCompositionOptions} from './ConversationGraphDelegationComposition.js';
import {ConversationGraphDelegationRemoteRuntime} from './ConversationGraphDelegationRemoteRuntime.js';
import {createConversationGraphSoloOwnership} from './ConversationGraphSoloOwnership.js';
export type GraphDelegationNativeDependencies=Readonly<Pick<ConversationGraphReplicationRuntimeOptions,'identity'|'identities'|'writeAdmission'|'leaseCoordinator'|'instanceLock'|'droppedOrigins'>>;
export function createConversationGraphDelegationFactory(options:Omit<ConversationGraphDelegationCompositionOptions,'runtime'|'agentId'|'identity'|'admission'|'coordinator'|'ownership'|'dropped'|'membership'|'ownerPublicKey'>&{
 native:()=>GraphDelegationNativeDependencies|null;ownership:()=>ConversationGraphDelegationCompositionOptions['ownership']|null;
 placement?:()=>Parameters<ConversationGraphDelegationRemoteRuntime['setPlacement']>[0]|undefined;
}):ConversationGraphDelegationFactory{return async runtime=>{
 const native=options.native();if(!native||!options.telegram||!options.telegramChatId||!options.tmuxPath)return{status:'held',reason:'graph-delegation-bindings-unavailable'};
 if(!(native.identity instanceof MachineIdentityManager)||!(native.identities instanceof IdentityStore)||!(native.leaseCoordinator instanceof LeaseCoordinator)||!(native.writeAdmission instanceof WriteAdmission)||!(native.instanceLock instanceof SingleInstanceLock)
  ||fs.realpathSync(native.identity.baseDir)!==fs.realpathSync(options.state.baseDir)||!native.instanceLock.revalidate())return{status:'held',reason:'graph-delegation-native-authority-unavailable'};
 const common={...options,runtime,agentId:runtime.agentId,identity:native.identity,admission:native.writeAdmission,coordinator:native.leaseCoordinator,dropped:native.droppedOrigins,membership:runtime.installedMembership,ownerPublicKey:runtime.ownerPublicKey};
 let ownership=options.ownership(),establishOwnership:ConversationGraphDelegationCompositionOptions['establishOwnership'];
 const solo=runtime.installedMembership.members.length===1;
 if(!ownership){if(!solo)return{status:'held',reason:'graph-delegation-fleet-ownership-unavailable'};
  const actual=createConversationGraphSoloOwnership({...common,instanceLock:native.instanceLock,identities:native.identities});ownership=actual.registry;
  establishOwnership=refs=>{const project=createConversationGraphDelegationContext({...common,ownership:actual.registry}).project;for(const ref of refs)project(ref);actual.establish(refs);};
 }
 const composed={...common,ownership,establishOwnership};const local=createConversationGraphDelegationComposition(composed);let remote:ConversationGraphDelegationRemoteRuntime|null=null;
 try{if(!solo){remote=new ConversationGraphDelegationRemoteRuntime(composed);const placement=options.placement?.();if(placement)remote.setPlacement(placement);}return{status:'ready',local,remote};}
 catch(error){local.close();remote?.close();throw error;}
};}
