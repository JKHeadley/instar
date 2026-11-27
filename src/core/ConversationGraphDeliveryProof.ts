/** Publication facts for an existing signed delivery proof. Signatures and
 * timestamps remain verified custody evidence, not competing HLC payloads. */
import {canonicalHash} from './GraphWitnessTypes.js';
import type {ConversationGraphReplicationRecord} from './ConversationGraphReplication.js';
export function graphCompleteDeliveryFacts(record:ConversationGraphReplicationRecord):unknown[]{
 const receipts=record.commitProofDeliveryReceipts??[],membership=record.materialization?.activation.newMembership??record.adoption?.newMembership??record.authorizationProof.membership;
 if(receipts.length!==membership.members.length||new Set(receipts.map(receipt=>receipt.machineId)).size!==receipts.length||!membership.members.every(member=>receipts.some(receipt=>receipt.machineId===member.machineId)))return [];
 return [...receipts].sort((a,b)=>a.machineId.localeCompare(b.machineId)).map(({persistedAt:_time,signature:_signature,...fact})=>fact);
}
export const graphDeliveryFactsHash=(record:ConversationGraphReplicationRecord):string=>canonicalHash(graphCompleteDeliveryFacts(record));
