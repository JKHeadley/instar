import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { ConversationGraphReplication } from '../../src/core/ConversationGraphReplication.js';
import { ConversationGraphCommitCoordinator, localGraphCommitMember } from '../../src/core/ConversationGraphCommitCoordinator.js';
import { GraphWitnessClient } from '../../src/core/GraphWitnessClient.js';
import { createGraphWitnessServer } from '../../src/server/graphWitnessServer.js';
import { canonicalHash, signGraphRecord, witnessActionPayload, GRAPH_SIGNATURE_DOMAINS } from '../../src/core/GraphWitnessTypes.js';
import { replicationFixture } from '../unit/conversation-graph-replication.fixtures.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
async function boot() {
  const f = replicationFixture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-commit-'));
  cleanup.push(() => SafeFsExecutor.safeRmSync(directory, { recursive: true, force: true, operation: 'graph-commit-test:teardown' }));
  const pem = (key: typeof f.owner.publicKey) => key.export({type:'spki',format:'pem'}).toString();
  const {app,service} = createGraphWitnessServer({databasePath:path.join(directory,'witness.sqlite'),
    witnessId:f.membership.witnessId, failureDomain:f.membership.failureDomain, signingPrivateKey:f.witness.privateKey,
    enrollments:{echo:{ownerPublicKey:pem(f.owner.publicKey),bearerToken:'graph-commit-test-token'}},
    installedFailureDomains:['writer','sleeper'],now:()=>Date.parse('2026-11-05T08:06:00Z')});
  cleanup.push(() => service.close());
  const server: Server = app.listen(0,'127.0.0.1');
  await new Promise<void>(r=>server.once('listening',r));
  cleanup.push(()=>new Promise<void>(r=>{server.closeAllConnections();server.close(()=>r());}));
  const address=server.address(); if (!address || typeof address==='string') throw new Error('test-listener');
  const witness=new GraphWitnessClient({baseUrl:`http://127.0.0.1:${address.port}`,agentId:'echo',bearerToken:'graph-commit-test-token',
    witnessId:f.membership.witnessId,witnessPublicKey:pem(f.witness.publicKey),ownerPublicKey:pem(f.owner.publicKey),
    expectedFailureDomain:f.membership.failureDomain,allowLoopbackHttpForTests:true});
  await witness.registerMembership(f.membership);
  const writer=await ConversationGraphReplication.open(f.options(path.join(directory,'writer')));
  const sleeper=await ConversationGraphReplication.open(f.options(path.join(directory,'sleeper'),'sleeper'));
  let available=true; let proofAvailable=true;
  const peer=localGraphCommitMember('sleeper',sleeper);
  const coordinator=new ConversationGraphCommitCoordinator({source:writer,witness,machineId:'writer',
    actuation:()=>({lease:f.lease,originalLease:f.originalLease}),member:()=>available ? {...peer,
      persistCommitProof:async(record)=>{if(!proofAvailable) throw new Error('network-cut');return peer.persistCommitProof(record);}}:null});
  return {...f,writer,sleeper,witness,coordinator,directory,available:(v:boolean)=>{available=v;},proofAvailable:(v:boolean)=>{proofAvailable=v;}};
}
describe('real graph save coordinator',()=>{
  it('publishes the complete signed delivery facts so a follower and its cold restart prove the same committed outcome',async()=>{
    const f=await boot(),record=f.record();expect((await f.coordinator.submit(record)).state).toBe('committed');
    expect(f.writer.allCommitProofDelivered(record.packet.eventId)).toBe(true);expect(f.sleeper.allCommitProofDelivered(record.packet.eventId)).toBe(true);
    const copy=f.sleeper.repairRecord(record.packet.eventId)!;expect(copy.commitProofDeliveryReceipts).toHaveLength(2);expect(copy.commitProofDeliveryReceipts!.every(receipt=>f.sleeper.verifyCommitProofDeliveryReceipt(receipt,copy))).toBe(true);
    const reopened=await ConversationGraphReplication.open(f.options(path.join(f.directory,'sleeper'),'sleeper'));expect(reopened.allCommitProofDelivered(record.packet.eventId)).toBe(true);
    expect(f.writer.allDeliveryCompletionPersisted(record.packet.eventId)).toBe(true);
  });
  it('rejects a no-op completion callback replaying a real first-phase receipt, then finishes by actual full-set fsync',async()=>{
    const f=await boot(),record=f.record(),peer=localGraphCommitMember('sleeper',f.sleeper);let replay=true;
    const coordinator=new ConversationGraphCommitCoordinator({source:f.writer,witness:f.witness,machineId:'writer',actuation:()=>({lease:f.lease,originalLease:f.originalLease}),member:()=>({...peer,persistDeliveryCompletion:async input=>replay?await f.sleeper.durableCommitProofDeliveryReceipt(input.packet.eventId) as unknown as Awaited<ReturnType<ConversationGraphReplication['durableDeliveryCompletionReceipt']>>:peer.persistDeliveryCompletion!(input)})});
    expect(await coordinator.submit(record)).toMatchObject({state:'saved-pending',waitingMachineIds:['sleeper']});expect(f.writer.allDeliveryCompletionPersisted(record.packet.eventId)).toBe(false);expect(f.sleeper.allCommitProofDelivered(record.packet.eventId)).toBe(false);
    replay=false;expect((await coordinator.submit(record)).state).toBe('committed');expect(f.sleeper.allCommitProofDelivered(record.packet.eventId)).toBe(true);expect(f.writer.allDeliveryCompletionPersisted(record.packet.eventId)).toBe(true);
  });
  it('does not acknowledge before every installed member has source, certificate and full persistence proof',async()=>{
    const f=await boot(); const record=f.record(); f.available(false);
    expect(await f.coordinator.submit(record)).toMatchObject({state:'saved-pending',phase:'witnessed',waitingMachineIds:['sleeper']});
    expect(f.writer.status(record.packet.eventId).state).not.toBe('committed');
    f.available(true); f.proofAvailable(false);
    expect(await f.coordinator.submit(record)).toMatchObject({state:'saved-pending',phase:'certified',waitingMachineIds:['sleeper']});
    expect(f.sleeper.status(record.packet.eventId).state).not.toBe('committed');
    f.proofAvailable(true);
    expect(await f.coordinator.submit(record)).toMatchObject({state:'committed',phase:'committed'});
    expect(f.sleeper.status(record.packet.eventId).state).toBe('committed');
    const restarted=await ConversationGraphReplication.open(f.options(path.join(f.directory,'sleeper'),'sleeper'));
    expect(restarted.status(record.packet.eventId).state).toBe('committed');
    expect(restarted.repairRecord(record.packet.eventId)?.certificatePersistenceReceipts).toHaveLength(2);
    expect(canonicalHash(f.writer.repairRecord(record.packet.eventId)?.packet)).toBe(canonicalHash(record.packet));
    vi.spyOn(f.witness,'prepare').mockRejectedValue(new Error('witness-offline'));
    expect(await f.coordinator.submit(record)).toMatchObject({state:'committed',phase:'committed'});
    expect(f.witness.prepare).not.toHaveBeenCalled();
  });
  it('preserves uncertainty when the append return is lost after real fsync',async()=>{
    const f=await boot();const append=f.writer.appendLocal.bind(f.writer);
    vi.spyOn(f.writer,'appendLocal').mockImplementation(async(record)=>{await append(record);throw new Error('lost-return');});
    const record=f.record();
    expect(await f.coordinator.submit(record)).toMatchObject({state:'checking-save',reason:'save-outcome-unknown'});
    expect(f.writer.repairRecord(record.packet.eventId)).not.toBeNull();
  });
  it('continues the original action under an independently verified new native holder without new owner approval',async()=>{
    const f=await boot();const record=f.record();f.available(false);
    expect((await f.coordinator.submit(record)).state).toBe('saved-pending');
    const proposal=f.adopted(record),proposed=proposal.adoption!;
    const current=f.actuation('sleeper',2);
    const [adoption]=await f.witness.adoptPending({currentLease:current.lease,originalCurrentLease:current.originalLease,
      revalidations:[{proof:proposed.revalidation,rewrap:proposal.rewrap!}]});
    const adopted={...record,adoption,rewrap:proposal.rewrap};
    f.setLive({admitted:true,writerId:'sleeper',leaseEpoch:2,membershipEpoch:1,fencedLeaseHash:canonicalHash(current.originalLease)});
    await f.sleeper.receive(adopted,'writer');
    let writerAvailable=false;
    const coordinator=new ConversationGraphCommitCoordinator({source:f.sleeper,witness:f.witness,machineId:'sleeper',
      actuation:()=>current,member:id=>writerAvailable&&id==='writer'?localGraphCommitMember('writer',f.writer):null});
    expect(await coordinator.submit(adopted)).toMatchObject({state:'saved-pending',waitingMachineIds:['writer']});
    writerAvailable=true;
    expect(await coordinator.submit(adopted)).toMatchObject({state:'committed'});
    expect(f.sleeper.repairRecord(record.packet.eventId)?.authorizationProof).toEqual(record.authorizationProof);
    expect(f.writer.status(record.packet.eventId).state).toBe('committed');
  });
  it('keeps cancellation pending for an absent member and never relabels it as a commit',async()=>{
    const f=await boot();const record=f.record();f.available(false);
    expect((await f.coordinator.submit(record)).state).toBe('saved-pending');
    const sign=(lease:typeof f.lease)=>signGraphRecord(GRAPH_SIGNATURE_DOMAINS.action,
      witnessActionPayload('cancel',{idempotencyKey:record.packet.idempotencyKey},lease),f.members[0].signing.privateKey);
    expect(await f.coordinator.cancel(record,sign)).toMatchObject({state:'cancel-pending',waitingMachineIds:['sleeper']});
    f.available(true);
    expect(await f.coordinator.cancel(record,sign)).toMatchObject({state:'canceled',waitingMachineIds:[]});
    expect(f.sleeper.status(record.packet.eventId).state).toBe('canceled');
    expect((await f.coordinator.submit(record)).state).not.toBe('committed');
  });
});
