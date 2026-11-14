/** Disjoint compact owner-signed stage. No existing authority, W or runtime
 * accepts it automatically. A hash-only commitment never verifies this stage. */
import {GraphVerifiedNativeTailBarrier,type GraphNativeTailBarrierCommitment} from './GraphVerifiedNativeTailBarrier.js';
import {verifyGraphCustodyHoldIntent,verifyGraphCustodyIntentHold,type GraphCustodyHoldIntent,type GraphCustodyIntentHold} from './GraphCustodyProfileAuthority.js';
import {canonicalHash,exactFields,hash,iso,unsigned,verifyGraphRecord,verifyRecoveryAuthorization,type GraphMembershipEpoch,type GraphRecoveryAuthorization,type GraphWitnessLease} from './GraphWitnessTypes.js';
export const GRAPH_CUSTODY_STAGE_V2_DOMAIN='graph-owned-custody-stage-v2';
export interface GraphCustodyProfileStageV2 {
 v:2;kind:'owned-custody-stage-v2';agentId:string;revision:number;supersedesHash:string|null;
 holdIntent:GraphCustodyHoldIntent;intentHolds:GraphCustodyIntentHold[];tailBarrier:GraphNativeTailBarrierCommitment;
 authorization:GraphRecoveryAuthorization;previousMembership:GraphMembershipEpoch;newMembership:GraphMembershipEpoch;
 ownerRecoveryHash:string;issuedAt:string;signature:string;
}
function commitment(raw:GraphNativeTailBarrierCommitment):boolean{return exactFields(raw,['v','kind','membershipHash','leaseHash','closedTailsHash','memberCount','receiptSetHash','pagesRootHash'])&&raw.v===1&&raw.kind==='graph-native-tail-barrier-commitment'&&Number.isSafeInteger(raw.memberCount)&&raw.memberCount>=1&&raw.memberCount<=64&&[raw.membershipHash,raw.leaseHash,raw.closedTailsHash,raw.receiptSetHash,raw.pagesRootHash].every(hash);}
function holds(stage:GraphCustodyProfileStageV2,owner:string):boolean{
 const intent=stage.holdIntent;if(!verifyGraphCustodyHoldIntent(intent,owner)||canonicalHash(intent.previousMembership)!==canonicalHash(stage.previousMembership)||canonicalHash(intent.newMembership)!==canonicalHash(stage.newMembership)||intent.ownerRecoveryHash!==stage.ownerRecoveryHash||!Array.isArray(stage.intentHolds)||stage.intentHolds.length>128)return false;
 const expected=new Set([...intent.previousMembership.members,...intent.newMembership.members].map(member=>member.machineId)),seen=new Set<string>();for(const hold of stage.intentHolds){if(seen.has(hold.machineId)||!verifyGraphCustodyIntentHold(hold,intent,owner))return false;seen.add(hold.machineId);}return seen.size===expected.size&&[...expected].every(id=>seen.has(id));
}
/** Same v1 stage invariants, plus actual paged proof resolution under the
 * supplied previous membership and current lease. Chain persistence, current
 * native/Core admission and exact Source manifest coverage remain callers'
 * required barriers; this pure verifier cannot activate or retire anything. */
export async function verifyGraphCustodyProfileStageV2(raw:GraphCustodyProfileStageV2,ownerPublicKey:string,barrier:GraphVerifiedNativeTailBarrier,currentLease:GraphWitnessLease):Promise<boolean>{
 try{
  if(!(barrier instanceof GraphVerifiedNativeTailBarrier))return false;const stage=structuredClone(raw),lease=structuredClone(currentLease);
  if(!exactFields(stage,['v','kind','agentId','revision','supersedesHash','holdIntent','intentHolds','tailBarrier','authorization','previousMembership','newMembership','ownerRecoveryHash','issuedAt','signature'])||stage.v!==2||stage.kind!=='owned-custody-stage-v2'||!Number.isSafeInteger(stage.revision)||stage.revision<1||stage.revision>128||(stage.revision===1?stage.supersedesHash!==null:!hash(stage.supersedesHash))||stage.agentId!==stage.previousMembership.agentId||stage.agentId!==stage.newMembership.agentId||stage.newMembership.custodyProfile?.mode!=='owned-machine'||!hash(stage.ownerRecoveryHash)||!iso(stage.issuedAt)||!commitment(stage.tailBarrier)||!holds(stage,ownerPublicKey)||!verifyRecoveryAuthorization(stage.authorization,stage.previousMembership,stage.newMembership,ownerPublicKey)||stage.authorization.fenceEpoch!==lease.leaseEpoch||!verifyGraphRecord(GRAPH_CUSTODY_STAGE_V2_DOMAIN,unsigned(stage),stage.signature,ownerPublicKey))return false;
  barrier.assertCurrent(stage.previousMembership,lease);const actual=await barrier.commitment();if(canonicalHash(stage.tailBarrier)!==canonicalHash(actual)||actual.membershipHash!==canonicalHash(stage.previousMembership)||actual.leaseHash!==canonicalHash(lease)||actual.memberCount!==stage.previousMembership.members.length)return false;barrier.assertCurrent(stage.previousMembership,lease);return true;
 }catch{/* @silent-fallback-ok: absent/corrupt paged proof or invalid compact stage grants no authority and leaves existing holds intact. */return false;}
}
