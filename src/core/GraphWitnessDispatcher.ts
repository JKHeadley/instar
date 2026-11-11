/** Shared protocol dispatch table: HTTP and in-process transports execute the same handlers. */
import {canonicalJson,exactFields} from './GraphWitnessTypes.js';
import {GraphWitnessError,type GraphWitnessService} from './GraphWitnessService.js';
export interface GraphWitnessDispatchRequest {params:Record<string,string>;query:Record<string,string|undefined>;body:any}
export interface GraphWitnessEndpoint {method:'GET'|'POST';path:string;handle:(request:GraphWitnessDispatchRequest)=>unknown}
export function graphWitnessEndpoints(service:GraphWitnessService):GraphWitnessEndpoint[]{
 const endpoints:GraphWitnessEndpoint[]=[];
 const register=(method:'GET'|'POST',path:string,handle:(request:GraphWitnessDispatchRequest)=>unknown)=>endpoints.push({method,path,handle});
 const execute=(handle:(request:GraphWitnessDispatchRequest)=>unknown)=>handle;
  register('POST','/v1/agents/:agentId/membership', execute((req) => {
    if (req.body?.membership?.agentId !== req.params.agentId) throw new GraphWitnessError('agent-scope-mismatch', 403);
    return service.registerMembership(req.body.membership);
  }));
  register('GET','/v1/agents/:agentId/memberships/:epoch', execute((req) => service.membershipProof(req.params.agentId, Number(req.params.epoch))));
  register('GET','/v1/agents/:agentId/membership-activations/:epoch', execute(req=>service.membershipActivation(req.params.agentId,Number(req.params.epoch))));
  register('POST','/v1/agents/:agentId/lease', execute((req) => service.observeLease(req.params.agentId, req.body.lease, req.body.originalLease)));
  register('POST','/v1/agents/:agentId/erasures/:requestId/authority',execute(req=>service.erasureEndorsement(req.params.agentId,req.params.requestId,req.body.challenge)));
  register('POST','/v1/agents/:agentId/fleet-erasures',execute(req=>{service.beginFleetErasure(req.params.agentId,req.body.ingress,req.body.bundleHashes,req.body.lease,req.body.originalLease,req.body.actionSignature);return {accepted:true};}));
  register('GET','/v1/agents/:agentId/fleet-erasures',execute(req=>service.pendingFleetErasures(req.params.agentId,Number(req.query.offset??0))));
  register('GET','/v1/agents/:agentId/fleet-erasures/:requestId',execute(req=>service.fleetErasureHeader(req.params.agentId,req.params.requestId)));
  register('GET','/v1/agents/:agentId/fleet-erasures/:requestId/pages/:kind',execute(req=>{if(req.params.kind!=='recipients'&&req.params.kind!=='receipts')throw new GraphWitnessError('fleet-erasure-page-invalid',400);return service.fleetErasurePage(req.params.agentId,req.params.requestId,req.params.kind,Number(req.query.offset??0));}));
  register('POST','/v1/agents/:agentId/fleet-erasures/:requestId/receipt',execute(req=>{service.acknowledgeFleetErasure(req.params.agentId,req.params.requestId,req.body.receipt);return {accepted:true};}));
  register('POST','/v1/agents/:agentId/erased-control', execute((req) => {if(req.body?.packet?.agentId!==req.params.agentId)throw new GraphWitnessError('agent-mismatch',403);return service.admitErasedControl(req.body);}));
  register('POST','/v1/agents/:agentId/native-source-uploads',execute(req=>service.beginNativeSourceUpload(req.params.agentId,req.body)));
  register('POST','/v1/agents/:agentId/native-source-uploads/:transferId/chunks/:index',execute(req=>service.putNativeSourceUpload(req.params.agentId,req.params.transferId,Number(req.params.index),req.body.value)));
  register('POST','/v1/agents/:agentId/native-source-uploads/:transferId/finish',execute(req=>service.finishNativeSourceUpload(req.params.agentId,req.params.transferId)));
  register('POST','/v1/agents/:agentId/recovered-source', execute((req)=>{if(req.body?.packet?.agentId!==req.params.agentId)throw new GraphWitnessError('agent-mismatch',403);return service.recoverPositiveSource(req.body);}));
  register('POST','/v1/agents/:agentId/hold-owned-profile',execute(req=>{if(!exactFields(req.body,['intent']))throw new GraphWitnessError('custody-allocation-hold-request-invalid',400);return service.holdOwnedProfile(req.params.agentId,req.body.intent);}));
  register('POST','/v1/agents/:agentId/retire-owned-profile', execute(req=>service.retireOwnedProfile(req.params.agentId,req.body)));
  register('POST','/v1/agents/:agentId/adopt-pending', execute((req) => service.adoptPending(req.params.agentId, req.body)));
  register('POST','/v1/agents/:agentId/inventory-exports',execute(req=>service.exportInventory(req.params.agentId,req.body.challenge)));
  register('GET','/v1/agents/:agentId/inventory-exports/:exportId/pages/:index',execute(req=>service.inventoryPage(req.params.agentId,req.params.exportId,Number(req.params.index))));
  register('POST','/v1/agents/:agentId/inventory', execute((req) => {const result=service.inventory(req.params.agentId,req.body.challenge);if(Buffer.byteLength(canonicalJson(result))>2800000)throw new GraphWitnessError('inventory-export-required');return result;}));
  register('GET','/v1/agents/:agentId/recovery-manifest', execute((req) => {const result=service.recoveryManifest(req.params.agentId);if(Buffer.byteLength(canonicalJson(result))>2800000)throw new GraphWitnessError('inventory-export-required');return result;}));
  register('POST','/v1/agents/:agentId/recovery-uploads',execute(req=>service.beginRecoveryUpload(req.params.agentId,req.body)));
  register('POST','/v1/agents/:agentId/recovery-uploads/:transferId/chunks/:section/:index',execute(req=>service.putRecoveryUpload(req.params.agentId,req.params.transferId,req.params.section as import('./GraphWitnessService.js').GraphRecoveryUploadSection,Number(req.params.index),req.body.value)));
  register('POST','/v1/agents/:agentId/recovery-uploads/:transferId/finish',execute(req=>service.finishRecoveryUpload(req.params.agentId,req.params.transferId)));
  register('GET','/v1/agents/:agentId/recovery-uploads/:transferId/adoptions/:index',execute(req=>service.recoveryUploadAdoption(req.params.agentId,req.params.transferId,Number(req.params.index))));
  register('POST','/v1/agents/:agentId/recovery-uploads/:transferId/abort',execute(req=>{service.abortRecoveryUpload(req.params.agentId,req.params.transferId,req.body.signature);return {aborted:true};}));
  register('POST','/v1/agents/:agentId/bootstrap-transfers',execute(req=>service.beginBootstrapTransfer(req.params.agentId,req.body)));
  register('POST','/v1/agents/:agentId/bootstrap-transfers/:transferId/chunks/:section/:index',execute(req=>service.putBootstrapRow(req.params.agentId,req.params.transferId,req.params.section as import('./GraphWitnessService.js').GraphBootstrapSection,Number(req.params.index),req.body.value)));
  register('POST','/v1/agents/:agentId/bootstrap-transfers/:transferId/abort',execute(req=>{service.abortBootstrapTransfer(req.params.agentId,req.params.transferId,req.body.signature);return {aborted:true};}));
  register('POST','/v1/agents/:agentId/bootstrap-transfers/:transferId/finish',execute(req=>{const result=service.finishBootstrapTransfer(req.params.agentId,req.params.transferId);return {activation:result.activation,adoptionCount:result.adoptions.length};}));
  register('GET','/v1/agents/:agentId/bootstrap-transfers/:transferId/adoptions/:index',execute(req=>service.bootstrapTransferAdoption(req.params.agentId,req.params.transferId,Number(req.params.index))));
  register('POST','/v1/agents/:agentId/bootstrap', execute((req) => service.bootstrap(req.params.agentId, req.body)));
  register('GET','/v1/agents/:agentId/recovery-contexts/:epoch',execute(req=>service.recoveryContextHeader(req.params.agentId,Number(req.params.epoch))));
  register('GET','/v1/agents/:agentId/recovery-contexts/:epoch/pages/:index',execute(req=>service.recoveryContextPage(req.params.agentId,Number(req.params.epoch),Number(req.params.index))));
  register('POST','/v1/agents/:agentId/settle-member-loss',execute(req=>service.settleMemberLoss(req.params.agentId,req.body)));
  register('POST','/v1/agents/:agentId/recover-pending', execute((req) => service.recoverPending(req.params.agentId, req.body)));
  register('POST','/v1/agents/:agentId/operations/:key/prepare', execute((req) => {
    if (req.body?.packet?.agentId !== req.params.agentId || req.body?.packet?.idempotencyKey !== req.params.key) throw new GraphWitnessError('operation-scope-mismatch', 403);
    return service.prepare(req.body);
  }));
  register('POST','/v1/agents/:agentId/operations/:key/commit', execute((req) => service.commit(req.params.agentId,
    req.params.key, req.body.lease, req.body.originalLease, req.body.receipts)));
  register('POST','/v1/agents/:agentId/operations/:key/cancel', execute((req) => service.cancel(req.params.agentId,
    req.params.key, req.body.lease, req.body.originalLease, req.body.actionSignature)));
  register('POST','/v1/agents/:agentId/operations/:key/certify-cancellation', execute((req) => service.certifyCancellation(req.params.agentId,
    req.params.key, req.body.lease, req.body.originalLease, req.body.receipts)));
  register('POST','/v1/agents/:agentId/operations/:key/certificate-receipt', execute((req) => service.acknowledgeCertificate(req.params.agentId,
    req.params.key, req.body.receipt)));
  register('GET','/v1/agents/:agentId/operations/:key', execute((req) => {
    const operation = service.operation(req.params.agentId, req.params.key);
    if (!operation) throw new GraphWitnessError('operation-unknown', 404);
    return operation;
  }));
  register('GET','/v1/agents/:agentId/operations/:key/recover', execute((req) => service.recover(req.params.agentId, req.params.key)));
  register('GET','/v1/agents/:agentId/pending', execute((req) => ({ operations: service.pending(req.params.agentId) })));
  register('POST','/v1/agents/:agentId/backup-erasure-attestation', execute((req) => { service.attestBackupErasure(req.params.agentId, req.body); return {accepted:true}; }));
  register('POST','/v1/agents/:agentId/erasures', execute((req) => service.erase(req.params.agentId, req.body.requestId,req.body.target,
    req.body.bundleHashes, req.body.authorizationReceiptHash, req.body.lease, req.body.originalLease, req.body.actionSignature)));
  register('POST','/v1/agents/:agentId/erasures/:requestId/checkpoint', execute((req) => service.checkpointErasure(req.params.agentId, req.params.requestId,req.body.challenge)));
 return endpoints;
}
