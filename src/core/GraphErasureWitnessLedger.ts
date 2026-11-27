/** Same-transaction durable deletion debt in the managed witness database. */
import type crypto from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {canonicalHash,canonicalJson,signGraphRecord,verifyWitnessErasure,type GraphMembershipEpoch,type GraphWitnessErasure} from './GraphWitnessTypes.js';
import {GRAPH_ERASURE_DOMAINS,graphErasureRecipients,verifyGraphErasureIngress,verifyGraphErasureMemberReceipt,type GraphErasureIngress,type GraphErasureFleetStatus,type GraphErasureMemberReceipt,type GraphErasurePlan} from './GraphErasureProtocol.js';
export class GraphErasureWitnessLedger {
 constructor(private readonly db:Database,private readonly options:{witnessId:string;signingKey:crypto.KeyLike;publicKey:crypto.KeyLike;witnessKey(witnessId:string):crypto.KeyLike;ownerKey(agentId:string):crypto.KeyLike;history(agentId:string):GraphMembershipEpoch[];now():string}){
  db.exec('CREATE TABLE IF NOT EXISTS fleetErasureRequests(agentId TEXT NOT NULL,requestId TEXT NOT NULL,ingress TEXT NOT NULL,proof TEXT NOT NULL,PRIMARY KEY(agentId,requestId));CREATE TABLE IF NOT EXISTS fleetErasureReceipts(agentId TEXT NOT NULL,requestId TEXT NOT NULL,recipientId TEXT NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(agentId,requestId,recipientId));');
 }
 register(ingress:GraphErasureIngress,proof:GraphWitnessErasure):GraphErasureFleetStatus{
  const history=this.options.history(ingress.agentId),membership=history.find(m=>m.epoch===ingress.membershipEpoch);
  if(!membership||!verifyGraphErasureIngress(ingress,membership,this.options.ownerKey(ingress.agentId))||proof.requestId!==ingress.requestId||proof.agentId!==ingress.agentId||proof.authorizationReceiptHash!==canonicalHash(ingress)||canonicalHash(proof.target)!==canonicalHash(ingress.target)||!verifyWitnessErasure(proof,this.options.witnessKey(proof.witnessId)))throw new Error('fleet-erasure-ingress-invalid');
  const prior=this.db.prepare('SELECT ingress,proof FROM fleetErasureRequests WHERE agentId=? AND requestId=?').get(ingress.agentId,ingress.requestId) as {ingress:string;proof:string}|undefined;
  if(prior&&((JSON.parse(prior.ingress)!==null&&canonicalHash(JSON.parse(prior.ingress))!==canonicalHash(ingress))||canonicalHash(JSON.parse(prior.proof))!==canonicalHash(proof)))throw new Error('fleet-erasure-idempotency-conflict');
  this.db.prepare('INSERT INTO fleetErasureRequests(agentId,requestId,ingress,proof) VALUES(?,?,?,?) ON CONFLICT(agentId,requestId) DO UPDATE SET ingress=excluded.ingress').run(ingress.agentId,ingress.requestId,canonicalJson(ingress),canonicalJson(proof));return this.status(ingress.agentId,ingress.requestId);
 }
 private synchronize(agentId:string):void {
  // Imported signed tombstones themselves retain deletion authority and debt.
  // Missing original ingress is never invented and never removes old copies.
  this.db.prepare("INSERT INTO fleetErasureRequests(agentId,requestId,ingress,proof) SELECT agentId,requestId,'null',proof FROM erasureRequests WHERE agentId=? ON CONFLICT DO NOTHING").run(agentId);
 }
 status(agentId:string,requestId:string):GraphErasureFleetStatus{
  this.synchronize(agentId);
  const row=this.db.prepare('SELECT ingress,proof FROM fleetErasureRequests WHERE agentId=? AND requestId=?').get(agentId,requestId) as {ingress:string;proof:string}|undefined;if(!row)throw new Error('fleet-erasure-unknown');
  const ingress=JSON.parse(row.ingress) as GraphErasureIngress|null,proof=JSON.parse(row.proof) as GraphWitnessErasure,history=this.options.history(agentId);
  const unsigned={v:1 as const,agentId,requestId,ingressHash:proof.authorizationReceiptHash,erasureHash:canonicalHash(proof),target:proof.target,activatedEpochs:history.map(m=>({epoch:m.epoch,membershipHash:canonicalHash(m)})),requiredRecipients:graphErasureRecipients(history),witnessId:this.options.witnessId,plannedAt:this.options.now()};
  const plan:GraphErasurePlan={...unsigned,signature:signGraphRecord(GRAPH_ERASURE_DOMAINS.plan,unsigned,this.options.signingKey)};
  const receipts=(this.db.prepare('SELECT receipt FROM fleetErasureReceipts WHERE agentId=? AND requestId=? ORDER BY recipientId').all(agentId,requestId) as {receipt:string}[]).map(r=>JSON.parse(r.receipt) as GraphErasureMemberReceipt);
  return {ingress,proof,plan,receipts};
 }
 acknowledge(agentId:string,requestId:string,receipt:GraphErasureMemberReceipt):GraphErasureFleetStatus{
  const status=this.status(agentId,requestId);if(!verifyGraphErasureMemberReceipt(receipt,status))throw new Error('fleet-erasure-receipt-invalid');
  // Retain the first signed complete purge acknowledgment; retries do not
  // replace history or release any other historical installed-copy debt.
  this.db.prepare('INSERT INTO fleetErasureReceipts(agentId,requestId,recipientId,receipt) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(agentId,requestId,receipt.recipientId,canonicalJson(receipt));return this.status(agentId,requestId);
 }
 page(agentId:string,requestId:string,kind:'recipients'|'receipts',offset:number):unknown[]{
  if(!Number.isSafeInteger(offset)||offset<0||offset>8192)throw new Error('fleet-erasure-page-invalid');
  if(!this.db.prepare('SELECT 1 FROM fleetErasureRequests WHERE agentId=? AND requestId=?').get(agentId,requestId))throw new Error('fleet-erasure-unknown');
  if(kind==='recipients')return graphErasureRecipients(this.options.history(agentId)).slice(offset,offset+64);
  return(this.db.prepare('SELECT receipt FROM fleetErasureReceipts WHERE agentId=? AND requestId=? ORDER BY recipientId LIMIT 64 OFFSET ?').all(agentId,requestId,offset) as {receipt:string}[]).map(row=>JSON.parse(row.receipt));
 }
 pending(agentId:string,offset=0):string[]{this.synchronize(agentId);if(!Number.isSafeInteger(offset)||offset<0||offset>20000)throw new Error('fleet-erasure-page-invalid');return(this.db.prepare('SELECT requestId FROM fleetErasureRequests WHERE agentId=? ORDER BY rowid LIMIT 128 OFFSET ?').all(agentId,offset) as {requestId:string}[]).map(r=>r.requestId);}
}
