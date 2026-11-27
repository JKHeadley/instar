/** The irreversible native step. Historical root signatures alone are never
 * admission: every mutation revalidates the actual fresh owner action. */
import fs from 'node:fs';
import path from 'node:path';
import {GraphOwnerMemberLossAction,GraphOwnerMemberLossIntent} from './GraphOwnerMemberLossAction.js';
import {GraphNativeMemberLossStore} from '../core/GraphNativeMemberLossStore.js';
import {GraphMemberLossHeldPreflight} from '../core/GraphMemberLossHeldPreflight.js';
import {MachineIdentityManager} from '../core/MachineIdentity.js';
import {IdentityStore} from '../core/IdentityStore.js';
import {syncOwnedGraphIdentityDurably} from '../core/GraphCustodyDurability.js';
import {canonicalHash} from '../core/GraphWitnessTypes.js';
import type {GraphOwnerMemberLossContext} from '../core/GraphOwnerMemberLoss.js';
import type {LeaseCoordinator} from '../core/LeaseCoordinator.js';
import type {GraphNativeMemberLossReceipt,GraphNativeMemberLossFloor} from '../core/GraphMemberLossNativeProof.js';

export async function applyOwnerMemberLossNativeAdministration(options:{
 action:GraphOwnerMemberLossAction;intent:GraphOwnerMemberLossIntent;
 preflight:GraphMemberLossHeldPreflight;store:GraphNativeMemberLossStore;
 identity:MachineIdentityManager;identities:IdentityStore;coordinator:LeaseCoordinator;
}):Promise<{receipt:GraphNativeMemberLossReceipt;floor:GraphNativeMemberLossFloor}>{
 const {action,intent,preflight,store,identity,identities}=options;
 if(!(action instanceof GraphOwnerMemberLossAction)||!(intent instanceof GraphOwnerMemberLossIntent)||!(preflight instanceof GraphMemberLossHeldPreflight)||!(store instanceof GraphNativeMemberLossStore)||!(identity instanceof MachineIdentityManager)||!(identities instanceof IdentityStore))throw new Error('member-loss-actual-native-components-required');
 const root=fs.realpathSync(identity.baseDir),scope=action.scope;
 if(root!==scope.stateRoot||store.stateRoot!==root||preflight.stateRoot!==root||path.join(fs.realpathSync(path.dirname(identities.epochPath)),path.basename(identities.epochPath))!==path.join(root,'state','identity-epochs.json')||store.machineId!==identity.loadIdentity().machineId||preflight.intentHash!==canonicalHash(intent.intentProof)||preflight.requestId!==scope.requestId||canonicalHash(intent.scope)!==canonicalHash(scope)||canonicalHash(preflight.operations)!==canonicalHash(action.consent.payload.operations)||preflight.knownManifestHash!==action.consent.payload.knownManifestHash||preflight.knownPendingManifestHash!==action.consent.payload.knownPendingManifestHash)throw new Error('member-loss-native-component-scope-mismatch');
 const context:GraphOwnerMemberLossContext={ownerPublicKey:store.custodyAuthority.ownerPublicKey,previousPublicationHash:scope.previousPublicationHash,previousMembership:scope.previousMembership,newMembership:scope.newMembership,nativeIdentities:scope.nativeIdentities};
 const check={intentHash:canonicalHash(intent.intentProof),consentHash:canonicalHash(action.consent),previousPublicationHash:scope.previousPublicationHash,previousMembershipHash:canonicalHash(scope.previousMembership),newMembershipHash:canonicalHash(scope.newMembership),nativeRosterHash:canonicalHash(scope.nativeIdentities)};
 preflight.assertCurrent();await action.assertCurrentForNative(check);preflight.assertCurrent();
 // An existing complete receipt is revalidated; arbitrary already-revoked rows
 // do not silently qualify as a resumed transaction.
 const existingProgress=store.progress(action.consent,context,intent.intentProof);
 const floor=existingProgress?.originalFloor??await store.captureNativeFloor(options.coordinator,intent.intentProof,context);
 await action.assertCurrentForNative(check);preflight.assertCurrent();
 const progress=store.beginNativeOperation(action.consent,context,intent.intentProof,preflight,floor);
 await action.recordNativeStart(progress);
 const retained=store.read(action.consent,context);
 if(retained){store.assertDurableReceipt(action.consent,context,intent.intentProof,retained);await action.assertCurrentForNative(check);return {receipt:retained,floor};}
 for(const removed of scope.removed){
  await action.assertCurrentForNative(check);preflight.assertCurrent();
  progress.assertCurrent();
  if(identities.getEpoch(removed.machineId).revokedAt){if(!progress.revokedMachineIds.includes(removed.machineId))throw new Error('member-loss-partial-native-resume-evidence-required');continue;}
  identities.revokeDurably(removed.machineId,identity.loadIdentity().machineId,'Conversations permanent loss '+scope.requestId);
  syncOwnedGraphIdentityDurably(identity,identities);
  await action.assertCurrentForNative(check);preflight.assertCurrent();
 }
 const receipt=store.record(action.consent,context,intent.intentProof);
 await action.assertCurrentForNative(check);store.assertDurableReceipt(action.consent,context,intent.intentProof,receipt);
 return {receipt,floor};
}
