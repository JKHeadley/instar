import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateSigningKeyPair, sign } from '../../../src/core/MachineIdentity.js';
import { signerKeyHashOf, type MachineKeyLookup, type MachineSigner } from '../../../src/core/AppRecordSignatures.js';
import { acknowledgeTrial, bindTrial, finalizeTrialReceipt, finalizeInterruptedTrials, writeWatchdogReceipt, finishDelivery, importTrialPacket, pendingTrialBindings, pendingTrialPackets, receivedTrial, validTrialReceipt } from '../../../src/localVerify/smallPeerReceipts.js';
import { trialDirectory, type TrialReceipt } from '../../../src/localVerify/smallPeerWatchdog.js';
import type { PeerRunRequest } from '../../../src/localVerify/peer.js';

const keyring = new Map<string,string>();
function signer(id: string): MachineSigner {
  const pair = generateSigningKeyPair();
  const hash = signerKeyHashOf(pair.publicKey);
  keyring.set(id + hash,pair.publicKey);
  return {machineId:()=>id, signerKeyHash:()=>hash, sign:payload=>({machineId:id, signerKeyHash:hash, sig:sign(payload,pair.privateKey)})};
}
const coordinator = signer('coordinator');
const peer = signer('peer');
const lookup: MachineKeyLookup = (id,hash) => {
  const key = keyring.get(id+hash);
  return key ? {status:'ok', publicKeyPem:key} : {status:'unknown'};
};
const id = 'ab'.repeat(16);
const request: PeerRunRequest = {attemptId:id, coordinatorMachineId:'coordinator',leaseEpoch:4,
  pr:42,headSha:'a'.repeat(40),baseSha:'b'.repeat(40),baseRefName:'main',verifierVersion:'v',policyHash:'c'.repeat(64)};
let temp: string, local: string, remote: string;
beforeEach(()=>{
  temp = fs.mkdtempSync(path.join(os.tmpdir(),'instar-trial-receipts-'));
  local = path.join(temp,'coordinator');
  remote = path.join(temp,'peer');
  bindTrial(local,request,'peer',true);
  bindTrial(remote,request,'peer');
});
afterEach(()=>SafeFsExecutor.safeRmSync(temp,{force:true,recursive:true,operation:'smallPeerReceipts.test.ts'}));

function terminal(outcome: TrialReceipt['outcome'] = 'completed') {
  const receipt: TrialReceipt = {attemptId:id,outcome,reason:outcome==='completed'?'exit':'memory',cleanupProven:true,
    samples:6,peakRssBytes:4096,minimumAvailableBytes:8192,elapsedMs:1100,reserveBreached:false};
  fs.writeFileSync(path.join(trialDirectory(remote,id),'receipt.json'),JSON.stringify(receipt));
  return pendingTrialPackets(remote,'coordinator',peer,[id])[0];
}

describe('signed Mini verification receipts',()=>{
  it.each(['completed','capacity'] as const)('retains a %s result over disconnect and dropped acknowledgement',outcome=>{
    const pkt = terminal(outcome);
    const first = importTrialPacket(local,pkt,'peer',50,lookup,coordinator);
    expect(first.fresh).toBe(true);
    expect(receivedTrial(local,id)?.receipt.outcome).toBe(outcome);
    expect(pendingTrialBindings(local)).toHaveLength(1);
    expect(pendingTrialPackets(remote,'coordinator',peer,[id])).toHaveLength(1);
    expect(acknowledgeTrial(remote,first.ack,51,lookup)).toBe(true);
    expect(pendingTrialPackets(remote,'coordinator',peer,[id])).toEqual([]);
    const replay = importTrialPacket(local,receivedTrial(local,id)!,'peer',52,lookup,coordinator);
    expect(replay.fresh).toBe(false);
    expect(acknowledgeTrial(remote,replay.ack,53,lookup)).toBe(true);
    finishDelivery(local,id);
    expect(pendingTrialBindings(local)).toEqual([]);
  });

  it('withholds provisional success and signs only the final supervisor decision',()=>{
    writeWatchdogReceipt(remote,{attemptId:id,outcome:'completed',reason:'runner-exited',cleanupProven:true,
      samples:2,peakRssBytes:512,minimumAvailableBytes:1024,elapsedMs:2000,reserveBreached:false});
    expect(pendingTrialPackets(remote,'coordinator',peer,[id])).toEqual([]);
    finalizeTrialReceipt(remote,id,'trial-disabled',2001);
    finalizeInterruptedTrials(remote,'peer');
    expect(pendingTrialPackets(remote,'coordinator',peer,[id])[0].receipt)
      .toMatchObject({outcome:'capacity',reason:'trial-disabled',samples:2,elapsedMs:2001});
  });

  it('recovers only local bindings and preserves observed measurements on watchdog loss',()=>{
    finalizeInterruptedTrials(local,'coordinator');
    expect(fs.existsSync(path.join(trialDirectory(local,id),'receipt.json'))).toBe(false);
    finalizeTrialReceipt(remote,id,'sample-expired',2555,{samples:3,peakRssBytes:1024,minimumAvailableBytes:2048,reserveBreached:true});
    expect(pendingTrialPackets(remote,'coordinator',peer,[id])[0].receipt)
      .toMatchObject({outcome:'capacity',samples:3,peakRssBytes:1024,minimumAvailableBytes:2048,reserveBreached:true});
  });

  it.each([null, 'trial-disabled'])('keeps a measurement failure quarantined across supervisor cancellation (%s) and restart', reason => {
    writeWatchdogReceipt(remote, { attemptId:id, outcome:'capacity', reason:'measurement-failed',
      cleanupProven:true, samples:1, peakRssBytes:4096, minimumAvailableBytes:8192, elapsedMs:1100, reserveBreached:false });
    finalizeTrialReceipt(remote,id,reason,1110);
    finalizeInterruptedTrials(remote,'peer');
    expect(fs.existsSync(path.join(remote,'state','local-verify','small-peer-quarantined'))).toBe(true);
    expect(pendingTrialPackets(remote,'coordinator',peer,[id])[0].receipt)
      .toMatchObject({reason:'measurement-failed',samples:1,minimumAvailableBytes:8192});
  });

  it('fences an interrupted local trial before exposing a capacity receipt, even with no settings loaded',()=>{
    finalizeInterruptedTrials(remote,'peer');
    const state = path.join(remote,'state','local-verify');
    expect(fs.existsSync(path.join(state,'small-peer-recovering'))).toBe(true);
    expect(fs.existsSync(path.join(state,'small-peer-quarantined'))).toBe(true);
    expect(pendingTrialPackets(remote,'coordinator',peer,[id])[0].receipt)
      .toMatchObject({outcome:'capacity',reason:'server-restarted',samples:0,elapsedMs:null});
  });

  it('rejects receipt tampering, a revoked key, and a replacement dispatch',()=>{
    const pkt = terminal();
    expect(()=>importTrialPacket(local,{...pkt,receipt:{...pkt.receipt,elapsedMs:99}},'peer',55,lookup,coordinator)).toThrow();
    expect(()=>importTrialPacket(local,pkt,'peer',55,()=>({status:'unknown'}),coordinator)).toThrow();
    expect(()=>bindTrial(local,{...request,baseSha:'babe'.repeat(10)},'peer')).toThrow(/conflicting/);
    expect(receivedTrial(local,id)).toBeNull();
  });

  it('refuses an acknowledgement signed for another digest or by an unpinned coordinator',()=>{
    const pkt=terminal('capacity');
    const {ack}=importTrialPacket(local,pkt,'peer',66,lookup,coordinator);
    expect(acknowledgeTrial(remote,{...ack,packetDigest:'4'.repeat(64)},68,lookup)).toBe(false);
    expect(acknowledgeTrial(remote,ack,68,()=>({status:'unknown'}))).toBe(false);
    expect(pendingTrialPackets(remote,'coordinator',peer,[id])).toHaveLength(1);
  });

  it('requires real telemetry and proven cleanup for completion and rejects contradictory outcomes',()=>{
    const {receipt}=terminal();
    expect(validTrialReceipt({...receipt,peakRssBytes:null},id)).toBe(false);
    expect(validTrialReceipt({...receipt,reserveBreached:true},id)).toBe(false);
    expect(validTrialReceipt({...receipt,cleanupProven:false},id)).toBe(false);
    expect(validTrialReceipt({...receipt,outcome:'capacity',samples:0,minimumAvailableBytes:null,peakRssBytes:null},id)).toBe(true);
  });
});
