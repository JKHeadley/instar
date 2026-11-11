/** Only a verified packet-bound copy on a different enrolled identity counts
 * beyond the recording disk. Callers first verify the source/membership chain.
 * This names custody; it does not certify distinct physical disaster domains.
 */
import {verifyMemberReceipt,type GraphMembershipEpoch} from './GraphWitnessTypes.js';
import type {ConversationGraphReplicationRecord} from './ConversationGraphReplication.js';
export function hasSeparateGraphPendingCopy(record:ConversationGraphReplicationRecord,
 context:{membership:GraphMembershipEpoch;leaseEpoch:number}):boolean{
 const profile=context.membership.custodyProfile;
 if(!profile||profile.mode==='external'||profile.hostMachineId!==record.packet.writerId)return true;
 return graphPendingMemberCopy(record,context)!==null;
}
export function graphPendingMemberCopy(record:ConversationGraphReplicationRecord,
 context:{membership:GraphMembershipEpoch;leaseEpoch:number}):string|null{
 return record.certificate?.memberReceipts.filter(receipt=>receipt.machineId!==record.packet.writerId
  &&verifyMemberReceipt(receipt,record.packet,context.membership,'source',undefined,
   {membershipEpoch:context.membership.epoch,leaseEpoch:context.leaseEpoch}))
  .map(receipt=>receipt.machineId).sort()[0]??null;
}
