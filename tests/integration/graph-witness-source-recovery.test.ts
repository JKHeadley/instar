import {createGraphControlCapsule} from '../../src/core/GraphWitnessControl.js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {Server} from 'node:http';
import {afterEach,describe,expect,it} from 'vitest';
import {createGraphWitnessServer} from '../../src/server/graphWitnessServer.js';
import {GraphWitnessClient} from '../../src/core/GraphWitnessClient.js';
import {ConversationGraphReplication} from '../../src/core/ConversationGraphReplication.js';
import {encodeGraphSourceEnvelope} from '../../src/core/ConversationGraphSourceEnvelope.js';
import {sealGraphBundle} from '../../src/core/GraphWitnessCrypto.js';
import {canonicalHash,signGraphRecord,GRAPH_SIGNATURE_DOMAINS as D} from '../../src/core/GraphWitnessTypes.js';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
import {replicationFixture} from '../unit/conversation-graph-replication.fixtures.js';
const dirs:string[]=[];const closers:Array<()=>Promise<void>>=[];
async function directory(){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'witness-only-source-'));dirs.push(dir);return dir;}
afterEach(async()=>{for(const close of closers.splice(0).reverse())await close();for(const dir of dirs.splice(0))SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'witness-only-recovery-test-cleanup'});});
const publicPem=(key:crypto.KeyObject)=>key.export({type:'spki',format:'pem'}).toString();
async function saveThenLoseWriter(){
 // Original core, application bytes, auth proof, packet and writer private key
 // exist only in this scope. The returned capability retains the survivor's
 // own key and public trust, never the original record or writer key.
 const f=replicationFixture(),writerDirectory=await directory(),survivorDirectory=await directory(),databasePath=path.join(await directory(),'witness.sqlite');
 const config={databasePath,witnessId:f.membership.witnessId,failureDomain:f.membership.failureDomain,signingPrivateKey:f.witness.privateKey,
  enrollments:{echo:{ownerPublicKey:publicPem(f.owner.publicKey),bearerToken:'witness-only-recovery-transport'}},installedFailureDomains:['installed-fleet'],now:()=>Date.parse('2026-11-05T08:07:00Z')};
 let runtime=createGraphWitnessServer(config);runtime.service.registerMembership(f.membership);let server:Server;
 async function listen(){server=runtime.app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));return `http://127.0.0.1:${(server.address() as {port:number}).port}`;}
 let baseUrl=await listen();const clientOptions={agentId:'echo',bearerToken:config.enrollments.echo.bearerToken,witnessId:config.witnessId,witnessPublicKey:publicPem(f.witness.publicKey),ownerPublicKey:publicPem(f.owner.publicKey),expectedFailureDomain:config.failureDomain,allowLoopbackHttpForTests:true};
 const application=crypto.randomBytes(4096),applicationHash=canonicalHash(application.toString('base64url'));const record=f.record();
 const envelope=encodeGraphSourceEnvelope(record.coreType,record.core,record.authorizationProof,application);application.fill(0);
 record.encryptedSourceBundle=sealGraphBundle(envelope,f.membership.members,record.packet);envelope.fill(0);record.packet.sourceBundleHash=canonicalHash(record.encryptedSourceBundle);record.packetSignature=signGraphRecord(D.packet,record.packet,f.members[0].signing.privateKey);
 const writer=await ConversationGraphReplication.open(f.options(writerDirectory));await writer.appendLocal(record);
 await new GraphWitnessClient({...clientOptions,baseUrl}).prepare({packet:record.packet,controlCapsule:createGraphControlCapsule(record.coreType,record.core,record.authorizationProof),packetSignature:record.packetSignature,encryptedSourceBundle:record.encryptedSourceBundle,lease:f.lease,originalLease:f.originalLease});
 const key=record.packet.idempotencyKey,packetSignatureHash=canonicalHash(record.packetSignature),coreHash=record.packet.coreHash;
 const survivorOptions=f.options(survivorDirectory,'sleeper');
 SafeFsExecutor.safeRmSync(writerDirectory,{recursive:true,force:true,operation:'witness-only-recovery-simulate-original-writer-loss'});
 // Force the managed witness to recover its original signature from durable
 // disk too, rather than returning anything retained in the accepting call.
 await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));runtime.service.close();runtime=createGraphWitnessServer(config);baseUrl=await listen();
 closers.push(async()=>{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));runtime.service.close();});
 return {writerDirectory,survivorOptions,key,packetSignatureHash,coreHash,applicationHash,client:new GraphWitnessClient({...clientOptions,baseUrl})};
}
describe('Saved source continuity from independent witness only',()=>{
 it('reconstructs original core/auth/signature using survivor key after original writer files and record variables are gone',async()=>{
  const saved=await saveThenLoseWriter();await expect(fs.stat(saved.writerDirectory)).rejects.toMatchObject({code:'ENOENT'});
  const recovered=await saved.client.recover(saved.key);expect(canonicalHash(recovered.operation.packetSignature)).toBe(saved.packetSignatureHash);
  const historicalMembership=await saved.client.membership(recovered.operation.packet.membershipEpoch);
  let survivor=await ConversationGraphReplication.open(saved.survivorOptions);
  const input={packet:recovered.operation.packet,controlCapsule:recovered.operation.controlCapsule,packetSignature:recovered.operation.packetSignature,encryptedSourceBundle:recovered.encryptedSourceBundle!,preparationProof:recovered.operation.prepareProof};
  const receipt=await survivor.reconstructFromWitness(input,historicalMembership);expect(receipt.phase).toBe('source');
  survivor=await ConversationGraphReplication.open(saved.survivorOptions);
  const restored=survivor.repairRecord(recovered.operation.packet.eventId)!;expect(canonicalHash(restored.core)).toBe(saved.coreHash);expect(canonicalHash(restored.packetSignature)).toBe(saved.packetSignatureHash);expect(survivor.verifyHistoricalRecord(restored)).toBe(true);
  const application=survivor.openVerifiedPayload(restored);expect(canonicalHash(application.toString('base64url'))).toBe(saved.applicationHash);application.fill(0);
  expect(survivor.status(restored.packet.eventId).state).toBe('prepared');
  await expect(survivor.reconstructFromWitness({...input,packetSignature:'A'.repeat(86)},historicalMembership)).rejects.toThrow();
 });
});
