/** Wire projection of actual retained Source proofs. This is NOT a proof mint
 * or admission factory: the loss-only witness importer verifies every original
 * signature, the exact owner cut, manifest and all new durable transfer pins. */
import type {ConversationGraphReplicationRecord} from './ConversationGraphReplication.js';
import type {GraphWitnessBootstrapOperation} from './GraphWitnessService.js';
import {createGraphControlCapsule} from './GraphWitnessControl.js';
import {graphHistoricalMaterializationRef} from './ConversationGraphHistoricalMaterialization.js';
export function graphMemberLossSourceImport(record:ConversationGraphReplicationRecord):GraphWitnessBootstrapOperation{
 const state=record.certificate?'certified':record.cancellationCertificate?.outcome??(record.cancellation?'canceled':record.erasure?'erased':'prepared');
 return{kind:'member-loss-source',operation:{packet:record.packet,packetSignature:record.packetSignature,controlCapsule:createGraphControlCapsule(record.coreType,record.core,record.authorizationProof),prepareProof:record.preparationProof??null,erasedControlProof:record.erasedControlProof??null,state,certificate:record.certificate??null,cancellation:record.cancellation??null,cancellationCertificate:record.cancellationCertificate??null,erasure:record.erasure??null,adoption:record.adoption??null,rewrap:record.rewrap??null,materialization:record.materialization?graphHistoricalMaterializationRef(record.materialization):null,certificatePersistenceReceipts:[...(record.certificatePersistenceReceipts??[])].sort((a,b)=>a.machineId<b.machineId?-1:a.machineId>b.machineId?1:0)},encryptedSourceBundle:record.encryptedSourceBundle};
}
