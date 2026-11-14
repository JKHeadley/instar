import {expect,it} from 'vitest';import http from 'node:http';import crypto from 'node:crypto';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {RecoveryControlPlane} from '../../src/recovery/RecoveryControlPlane.js';
import {RegistryStore} from '../../src/threadline/relay/RegistryStore.js';
import {recoveryKeyPair,signRecovery,recoveryDigest,type RecoveryCertificate} from '../../src/recovery/RecoveryProtocol.js';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
it('durably leases one source and one notification across holder loss and relay restart',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'recovery-episode-')),root=recoveryKeyPair(),signer=recoveryKeyPair(),a=recoveryKeyPair(),b=recoveryKeyPair(),target=recoveryKeyPair(),sa=recoveryKeyPair(),sb=recoveryKeyPair();let now=Date.now();
 const certificate=signRecovery<RecoveryCertificate>({domain:'instar-recovery-certificate-v1',agentId:'echo',publicKey:signer.publicKey,generation:1,issuedAt:now-1000,expiresAt:now+3600000},root.privateKey);
 const authorities=new Map([['echo',{certificate,privateKey:signer.privateKey,owner:{deviceId:'test-owner',publicKey:'not-used',host:'example.invalid',active:true}}]]);
 let store=new RegistryStore({dataDir:dir,relayId:'episode-test'}),plane=new RecoveryControlPlane(store,authorities,()=>now);
 for(const [machineId,key]of [['a',a],['b',b],['target',target]] as const)store.recoveryWrite('target:echo:'+machineId,{agentId:'echo',machineId,publicKey:key.publicKey,version:1,acknowledgement:0,ownerSequence:1,principals:machineId==='target'?[{machineId:'a',pairingEpoch:1,generation:1,sshPublicKey:sa.publicKey,relayPublicKey:a.publicKey},{machineId:'b',pairingEpoch:2,generation:1,sshPublicKey:sb.publicKey,relayPublicKey:b.publicKey}]:[],revoked:[]});
 const server=http.createServer((req,res)=>void plane.handle(req,res,new URL(req.url!,'http://test').pathname));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;
 const request=(source:'a'|'b',action:string,body:unknown)=>fetch(base+'/v1/recovery/'+action,{method:'POST',body:JSON.stringify(signRecovery({domain:'instar-recovery-control-request-v1',agentId:'echo',machineId:source,action,nonce:crypto.randomBytes(32).toString('hex'),issuedAt:now,expiresAt:now+30000,body},source==='a'?a.privateKey:b.privateKey))});
 const claim={targetMachineId:'target',pairingEpoch:1,route:'ssh',failureClass:'main-server-unavailable',sourceLeaseEpoch:10};
 try{
  const first=await request('a','episode-claim',claim);expect(first.status).toBe(200);const lease=await first.json();
  expect((await request('b','episode-claim',{...claim,pairingEpoch:2})).status).toBe(403);
  expect((await request('a','episode-claim',{...claim,pairingEpoch:2})).status).toBe(403);
  expect((await request('b','episode-notice',{targetMachineId:'target',sourceLeaseEpoch:10,leaseId:lease.leaseId})).status).toBe(403);
  const notice={targetMachineId:'target',sourceLeaseEpoch:10,leaseId:lease.leaseId};const pending=await(await request('a','episode-notice',notice)).json();expect(pending.claimed).toBe(true);expect(pending.status).toBe('pending');
  store.destroy();store=new RegistryStore({dataDir:dir,relayId:'episode-test'});plane=new RecoveryControlPlane(store,authorities,()=>now);
  const resumed=await(await request('a','episode-notice',notice)).json();expect(resumed.claimed).toBe(true);expect(resumed.idempotencyKey).toBe(pending.idempotencyKey);
  const accepted={...notice,idempotencyKey:pending.idempotencyKey,outboxOperationId:'durable-fixture-outbox'};expect((await(await request('a','episode-notice-ack',accepted)).json()).accepted).toBe(true);expect((await(await request('a','episode-notice-ack',accepted)).json()).accepted).toBe(true);expect((await request('a','episode-notice-ack',{...accepted,outboxOperationId:'different-budget'})).status).toBe(403);
  expect((await(await request('a','episode-notice',notice)).json()).claimed).toBe(false);
  now+=120001;const next=await request('b','episode-claim',{...claim,pairingEpoch:2,sourceLeaseEpoch:11});expect(next.status).toBe(200);const nextLease=await next.json();expect(nextLease.leaseId).not.toBe(lease.leaseId);expect(nextLease.notified).toBe(true);
  expect((await request('a','episode-notice',notice)).status).toBe(403);
  const relayLease=await(await request('b','episode-claim',{...claim,pairingEpoch:2,route:'relay',sourceLeaseEpoch:11})).json();
  const relayNotice={targetMachineId:'target',sourceLeaseEpoch:11,leaseId:relayLease.leaseId};const relayPending=await(await request('b','episode-notice',relayNotice)).json();expect(relayPending.claimed).toBe(true);
  const operation={domain:'instar-recovery-operation-v1',agentId:'echo',sourceMachineId:'b',targetMachineId:'target',targetBootId:'boot',pairingEpoch:2,generation:1,route:'relay',operationId:crypto.randomUUID(),nonce:crypto.randomBytes(32).toString('hex'),issuedAt:now,expiresAt:now+30000,fencingEpoch:1,verb:'status'};
  const receipt={domain:'instar-recovery-receipt-v1',agentId:'echo',sourceMachineId:'b',targetMachineId:'target',targetBootId:'boot',operationId:operation.operationId,requestDigest:recoveryDigest(operation),route:'relay',observedAt:now,checkpointVersion:1,result:'ok',detail:{serverHealthy:true}};
  const resolution={...relayNotice,evidence:{request:signRecovery(operation,b.privateKey),response:signRecovery(receipt,a.privateKey)}};
  expect((await request('b','episode-resolve',resolution)).status).toBe(403);
  resolution.evidence.response=signRecovery(receipt,target.privateKey);expect((await(await request('b','episode-resolve',resolution)).json()).resolved).toBe(true);
  const oldSenderPending=await(await request('b','episode-notice-pending',{targetMachineId:'target'})).json();expect(oldSenderPending.pending.map((n:any)=>n.idempotencyKey)).toContain(relayPending.idempotencyKey);
  expect((await(await request('a','episode-notice-pending',{targetMachineId:'target'})).json()).pending).toHaveLength(0);
  // The machine recovered, then a distinct outage began before the old sender
  // could enqueue. A new repair owner may act without inheriting that ambiguity.
  const later=await(await request('a','episode-claim',{...claim,route:'relay',sourceLeaseEpoch:12})).json();expect(later.leaseId).not.toBe(relayLease.leaseId);expect(later.notified).toBe(false);
  const laterNotice={targetMachineId:'target',sourceLeaseEpoch:12,leaseId:later.leaseId},laterPending=await(await request('a','episode-notice',laterNotice)).json();expect(laterPending.claimed).toBe(true);expect(laterPending.idempotencyKey).not.toBe(relayPending.idempotencyKey);
  const stillOld=await(await request('b','episode-notice-pending',{targetMachineId:'target'})).json();expect(stillOld.pending[0].idempotencyKey).toBe(relayPending.idempotencyKey);expect(stillOld.pending[0].noticeSenderMachineId).toBe('b');
  expect((await(await request('b','episode-notice-ack',{...relayNotice,idempotencyKey:relayPending.idempotencyKey,outboxOperationId:'durable-old-outage'})).json()).accepted).toBe(true);
  const afterOldAck=await(await request('a','episode-claim',{...claim,route:'relay',sourceLeaseEpoch:12})).json();expect(afterOldAck.notified).toBe(false);expect(afterOldAck.leaseId).toBe(later.leaseId);
  expect((await(await request('a','episode-notice-ack',{...laterNotice,idempotencyKey:laterPending.idempotencyKey,outboxOperationId:'durable-new-outage'})).json()).accepted).toBe(true);
  expect((await(await request('b','episode-notice-pending',{targetMachineId:'target'})).json()).pending).toHaveLength(0);
  expect(store.recoveryRead('target:echo:target')).toMatchObject({version:1,ownerSequence:1});
  expect((await request('b','episode-resolve',resolution)).status).toBe(403);
  const lostClaim={...claim,failureClass:'recovery-route-unavailable'},lostLease=await(await request('a','episode-claim',lostClaim)).json();
  const lostNotice={targetMachineId:'target',leaseId:lostLease.leaseId,sourceLeaseEpoch:10},lostPending=await(await request('a','episode-notice',lostNotice)).json();expect(lostPending.status).toBe('pending');
  now+=120001;const rescue=await(await request('b','episode-claim',{...lostClaim,pairingEpoch:2,sourceLeaseEpoch:12})).json();expect(rescue.notified).toBe(false);
  const rescueNotice={targetMachineId:'target',leaseId:rescue.leaseId,sourceLeaseEpoch:12},rescuePending=await(await request('b','episode-notice',rescueNotice)).json();expect(rescuePending.claimed).toBe(false);expect(rescuePending.status).toBe('delivery-pending');expect(rescuePending.noticeSenderMachineId).toBe('a');expect(rescuePending.idempotencyKey).toBe(lostPending.idempotencyKey);expect(rescuePending.episodeId).toBe(lostPending.episodeId);
  expect((await request('b','episode-notice-ack',{...rescueNotice,idempotencyKey:rescuePending.idempotencyKey,outboxOperationId:'replacement-budget'})).status).toBe(403);
  expect((await(await request('a','episode-notice-ack',{...lostNotice,idempotencyKey:lostPending.idempotencyKey,outboxOperationId:'durable-original-operation'})).json()).accepted).toBe(true);
  expect((await request('a','episode-notice-pending',{targetMachineId:'foreign-target'})).status).toBe(403);
  const row=store.recoveryRead('target:echo:target') as any;row.revoked=['b'];row.principals=row.principals.filter((x:any)=>x.machineId!=='b');store.recoveryWrite('target:echo:target',row);
  expect((await request('b','episode-notice',{targetMachineId:'target',sourceLeaseEpoch:12,leaseId:rescue.leaseId})).status).toBe(403);expect((await request('b','episode-notice-pending',{targetMachineId:'target'})).status).toBe(403);
 }finally{await new Promise<void>(r=>server.close(()=>r()));store.destroy();SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'recovery-episode-lease.test:cleanup'});}
});
