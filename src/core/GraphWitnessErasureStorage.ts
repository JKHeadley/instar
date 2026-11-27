/** Shared data-only indexed erasure engine. Callers establish actual negative
 * authority before invocation; these functions never sign or unlock a role. */
import type {Database as SqliteDatabase} from 'better-sqlite3';
import {canonicalHash,canonicalJson,sameGraphErasureIdentity,type GraphErasureIdentity,type GraphWitnessErasure,type GraphOperationPacket} from './GraphWitnessTypes.js';
import type {GraphErasureIngress} from './GraphErasureProtocol.js';
import type {GraphBootstrapTransferPlan,GraphRecoveryUploadPlan} from './GraphWitnessService.js';

export function assertGraphWitnessErasureHashBindings(db:SqliteDatabase,agentId:string,target:GraphErasureIdentity,bundleHashes:readonly string[]):void{
 for(const bundleHash of bundleHashes){
  const rows=db.prepare("SELECT packet FROM operations WHERE agentId=? AND json_extract(packet,'$.sourceBundleHash')=?").all(agentId,bundleHash) as {packet:string}[];
  const staged=db.prepare('SELECT sourceKind,sourceId FROM witnessTransferTargets WHERE agentId=? AND bundleHash=?').all(agentId,bundleHash) as GraphErasureIdentity[];
  if(rows.some(row=>!sameGraphErasureIdentity((JSON.parse(row.packet) as GraphOperationPacket).erasureIdentity,target))||staged.some(identity=>!sameGraphErasureIdentity(identity,target)))throw new Error('graph-role-erasure-target-bundle-conflict');
 }
}
export function purgeGraphWitnessStagedTarget(db:SqliteDatabase,agentId:string,target:GraphErasureIdentity,proof:GraphWitnessErasure|GraphErasureIngress):void {
    const hashes=db.prepare('SELECT DISTINCT bundleHash FROM witnessTransferTargets WHERE agentId=? AND sourceKind=? AND sourceId=?').all(agentId,target.sourceKind,target.sourceId) as {bundleHash:string}[];
    for(const row of hashes)purgeGraphWitnessStagedBundle(db,agentId,row.bundleHash,proof);
  }
export function enforceGraphWitnessTargetErasure(db:SqliteDatabase,agentId:string,proof:GraphWitnessErasure):void {
 assertGraphWitnessErasureHashBindings(db,agentId,proof.target,proof.bundleHashes);
 db.prepare('INSERT INTO targetErasures(agentId,sourceKind,sourceId,proof) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(agentId,proof.target.sourceKind,proof.target.sourceId,canonicalJson(proof));
 purgeGraphWitnessTargetBytes(db,agentId,proof);
}
export const GRAPH_WITNESS_LOCAL_ERASURE_SCHEMA='CREATE TABLE IF NOT EXISTS localTargetErasures(agentId TEXT NOT NULL,sourceKind TEXT NOT NULL,sourceId TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(agentId,sourceKind,sourceId))';
export function enforceGraphWitnessLocalTargetErasure(db:SqliteDatabase,agentId:string,ingress:GraphErasureIngress):void {
 db.exec(GRAPH_WITNESS_LOCAL_ERASURE_SCHEMA);
 db.prepare('INSERT INTO localTargetErasures(agentId,sourceKind,sourceId,body) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(agentId,ingress.target.sourceKind,ingress.target.sourceId,canonicalJson(ingress));
 purgeGraphWitnessTargetBytes(db,agentId,ingress);
}
function purgeGraphWitnessTargetBytes(db:SqliteDatabase,agentId:string,evidence:GraphWitnessErasure|GraphErasureIngress):void {
 const witnessed='bundleHashes' in evidence;
 const rows=db.prepare("SELECT packet,idempotencyKey,eventId FROM operations WHERE agentId=? AND json_extract(packet,'$.erasureIdentity.sourceKind')=? AND json_extract(packet,'$.erasureIdentity.sourceId')=?").all(agentId,evidence.target.sourceKind,evidence.target.sourceId) as {packet:string;idempotencyKey:string;eventId:string}[];
 for(const row of rows){const packet=JSON.parse(row.packet) as GraphOperationPacket;
  if(witnessed)db.prepare('INSERT INTO erasures(agentId,bundleHash,proof) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(agentId,packet.sourceBundleHash,canonicalJson(evidence));
  db.prepare('UPDATE bundles SET ciphertext=NULL WHERE agentId=? AND hash=?').run(agentId,packet.sourceBundleHash);
  db.prepare('UPDATE rewraps SET body=NULL WHERE agentId=? AND eventId=?').run(agentId,row.eventId);
  if(witnessed)db.prepare("UPDATE operations SET state='erased' WHERE agentId=? AND idempotencyKey=? AND state='prepared'").run(agentId,row.idempotencyKey);
  purgeGraphWitnessStagedBundle(db,agentId,packet.sourceBundleHash,evidence);
 }
 purgeGraphWitnessStagedTarget(db,agentId,evidence.target,evidence);
 for(const bundleHash of witnessed?evidence.bundleHashes:[]){db.prepare('UPDATE bundles SET ciphertext=NULL WHERE agentId=? AND hash=?').run(agentId,bundleHash);db.prepare("UPDATE rewraps SET body=NULL WHERE agentId=? AND json_extract(body,'$.originalBundleHash')=?").run(agentId,bundleHash);purgeGraphWitnessStagedBundle(db,agentId,bundleHash,evidence);}
}
export function inspectGraphWitnessTargetBytes(db:SqliteDatabase,agentId:string,target:GraphErasureIdentity):{bundles:number;rewraps:number;transferRows:number}{
 const args=[agentId,target.sourceKind,target.sourceId];
 const bundles=(db.prepare("SELECT COUNT(*) AS n FROM operations o JOIN bundles b ON b.agentId=o.agentId AND b.hash=json_extract(o.packet,'$.sourceBundleHash') WHERE o.agentId=? AND json_extract(o.packet,'$.erasureIdentity.sourceKind')=? AND json_extract(o.packet,'$.erasureIdentity.sourceId')=? AND b.ciphertext IS NOT NULL").get(...args) as {n:number}).n;
 const rewraps=(db.prepare("SELECT COUNT(*) AS n FROM operations o JOIN rewraps r ON r.agentId=o.agentId AND r.eventId=o.eventId WHERE o.agentId=? AND json_extract(o.packet,'$.erasureIdentity.sourceKind')=? AND json_extract(o.packet,'$.erasureIdentity.sourceId')=? AND r.body IS NOT NULL").get(...args) as {n:number}).n;
 const transferRows=(db.prepare("SELECT COUNT(*) AS n FROM witnessTransferTargets t JOIN witnessTransferRows r ON r.agentId=t.agentId AND r.transferId=t.transferId AND r.section=t.section AND r.rowIndex=t.rowIndex WHERE t.agentId=? AND t.sourceKind=? AND t.sourceId=? AND r.body!='null'").get(...args) as {n:number}).n;
 return{bundles,rewraps,transferRows};
}
export function purgeGraphWitnessStagedBundle(db:SqliteDatabase,agentId:string,bundleHash:string,proof:GraphWitnessErasure|GraphErasureIngress):void {
    const affected=db.prepare("SELECT DISTINCT b.transferId FROM witnessTransferBindings b JOIN witnessTransferRows r ON r.agentId=b.agentId AND r.transferId=b.transferId AND r.section=b.section AND r.rowIndex=b.rowIndex WHERE b.agentId=? AND b.bundleHash=? AND r.body!='null'").all(agentId,bundleHash) as {transferId:string}[];
    const applied=db.prepare('SELECT requestHash FROM bootstrapRequests WHERE agentId=?').get(agentId) as {requestHash:string}|undefined;
    for(const {transferId}of affected){
      const planRow=db.prepare('SELECT plan FROM witnessTransfers WHERE agentId=? AND transferId=?').get(agentId,transferId) as {plan:string};const plan=JSON.parse(planRow.plan) as GraphBootstrapTransferPlan|GraphRecoveryUploadPlan;
      const completed=('kind'in plan&&plan.kind==='recovery')?((db.prepare('SELECT requestHash FROM recoveryLog WHERE agentId=? AND recoveryId=?').get(agentId,plan.header.authorization.recoveryId) as {requestHash:string}|undefined)?.requestHash===plan.requestHash):applied?.requestHash===canonicalHash({payload:(plan as GraphBootstrapTransferPlan).payload,signature:(plan as GraphBootstrapTransferPlan).bootstrapSignature});
      if(!completed)db.prepare('INSERT INTO witnessTransferStale(agentId,transferId,erasureHash) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(agentId,transferId,canonicalHash(proof));
      const removed=db.prepare("SELECT COALESCE(SUM(length(CAST(r.body AS BLOB))-4),0) AS bytes FROM witnessTransferRows r JOIN witnessTransferBindings b ON r.agentId=b.agentId AND r.transferId=b.transferId AND r.section=b.section AND r.rowIndex=b.rowIndex WHERE b.agentId=? AND b.transferId=? AND b.bundleHash=? AND r.body!='null'").get(agentId,transferId,bundleHash) as {bytes:number};
      db.prepare("UPDATE witnessTransferRows SET body='null' WHERE agentId=? AND transferId=? AND (section,rowIndex) IN (SELECT section,rowIndex FROM witnessTransferBindings WHERE agentId=? AND transferId=? AND bundleHash=?)").run(agentId,transferId,agentId,transferId,bundleHash);
      db.prepare('UPDATE witnessTransferUsage SET bytes=MAX(0,bytes-?) WHERE agentId=? AND transferId=?').run(removed.bytes,agentId,transferId);
    }
  }
