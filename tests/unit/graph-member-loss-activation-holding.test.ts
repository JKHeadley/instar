import crypto from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {FencedLease} from '../../src/core/FencedLease.js';
import {mintGraphMemberLossLeaseProof,verifyGraphMemberLossActivationHolding,type GraphMemberLossActivationAuthority} from '../../src/core/GraphMemberLossActivation.js';
import {canonicalHash,signGraphRecord,type GraphMembershipEpoch} from '../../src/core/GraphWitnessTypes.js';
import type {LeaseRecord} from '../../src/core/types.js';

const keys=crypto.generateKeyPairSync('ed25519'),other=crypto.generateKeyPairSync('ed25519'),writer='m_writer',agentId='agent-holding';
const pem=(key:crypto.KeyObject)=>key.export({type:'spki',format:'pem'}).toString();
const membership={agentId,epoch:2,members:[{machineId:writer,signingPublicKey:pem(keys.publicKey)},{machineId:'m_other',signingPublicKey:pem(other.publicKey)}]} as unknown as GraphMembershipEpoch;
const acquiredAt=Date.parse('2026-11-07T10:00:00.000Z'),iso=(ms:number)=>new Date(ms).toISOString();
const planExpiry=acquiredAt+60000;
function proof(change:Partial<LeaseRecord>={},signer:crypto.KeyObject=keys.privateKey,scope=membership){
 const fields={holder:writer,epoch:7,acquiredAt:iso(acquiredAt),expiresAt:iso(planExpiry),nonce:100,...change};
 const originalLease={...fields,signature:crypto.sign(null,Buffer.from(FencedLease.canonicalize(fields as LeaseRecord)),signer).toString('base64')} as LeaseRecord;
 const body={v:1 as const,agentId,membershipEpoch:scope.epoch,leaseEpoch:originalLease.epoch,writerId:originalLease.holder,issuedAt:originalLease.acquiredAt,expiresAt:originalLease.expiresAt,fencedLeaseHash:canonicalHash(originalLease)};
 return{lease:{...body,signature:signGraphRecord('graph-lease-v1',body,signer)},originalLease};
}
const snapshot=proof(),plan={currentLease:snapshot.lease,originalLease:snapshot.originalLease} as GraphMemberLossActivationAuthority;
const renewed={expiresAt:iso(planExpiry+600000),nonce:500},at=planExpiry+300000;

describe('proof of holding at member-loss commit',()=>{
 it('accepts a renewal of the same lease past the snapshot expiry',()=>{expect(verifyGraphMemberLossActivationHolding(proof(renewed),plan,membership,at)).toBe(true);});
 it('accepts the snapshot itself while it is live',()=>{expect(verifyGraphMemberLossActivationHolding(snapshot,plan,membership,planExpiry-1)).toBe(true);});
 it('refuses a proof that has expired at the moment checked, exactly at and past expiry',()=>{const held=proof(renewed);expect(verifyGraphMemberLossActivationHolding(held,plan,membership,planExpiry+600000)).toBe(false);expect(verifyGraphMemberLossActivationHolding(held,plan,membership,planExpiry+600001)).toBe(false);expect(verifyGraphMemberLossActivationHolding(snapshot,plan,membership,planExpiry)).toBe(false);});
 it('refuses a lower nonce and accepts an equal one',()=>{expect(verifyGraphMemberLossActivationHolding(proof({...renewed,nonce:99}),plan,membership,at)).toBe(false);expect(verifyGraphMemberLossActivationHolding(proof({...renewed,nonce:100}),plan,membership,at)).toBe(true);});
 it('refuses a different acquiredAt, as a separate acquisition',()=>{expect(verifyGraphMemberLossActivationHolding(proof({...renewed,acquiredAt:iso(acquiredAt+1)}),plan,membership,at)).toBe(false);});
 it('refuses a different epoch, higher or lower',()=>{for(const epoch of [6,8])expect(verifyGraphMemberLossActivationHolding(proof({...renewed,epoch}),plan,membership,at)).toBe(false);});
 it('refuses a different writer, even with that writer\'s valid signatures',()=>{expect(verifyGraphMemberLossActivationHolding(proof({...renewed,holder:'m_other'},other.privateKey),plan,membership,at)).toBe(false);});
 it('refuses a released lease',()=>{expect(verifyGraphMemberLossActivationHolding(proof({...renewed,released:true}),plan,membership,at)).toBe(false);});
 it('refuses a signature by anyone but the writer',()=>{expect(verifyGraphMemberLossActivationHolding(proof(renewed,other.privateKey),plan,membership,at)).toBe(false);});
 it('refuses a proof for another membership epoch',()=>{expect(verifyGraphMemberLossActivationHolding(proof(renewed,keys.privateKey,{...membership,epoch:3}),plan,membership,at)).toBe(false);});
 it('refuses a bridge that does not match its lease record',()=>{const held=proof(renewed),body={...held.lease,expiresAt:iso(planExpiry+900000)};const {signature:_drop,...fields}=body;expect(verifyGraphMemberLossActivationHolding({lease:{...fields,signature:signGraphRecord('graph-lease-v1',fields,keys.privateKey)},originalLease:held.originalLease},plan,membership,at)).toBe(false);});
 it('refuses extra fields and malformed values rather than throwing',()=>{expect(verifyGraphMemberLossActivationHolding({...proof(renewed),extra:1} as never,plan,membership,at)).toBe(false);expect(verifyGraphMemberLossActivationHolding(null as never,plan,membership,at)).toBe(false);expect(verifyGraphMemberLossActivationHolding(proof(renewed),plan,membership,Number.NaN)).toBe(false);});
});

describe('minting the proof from the live lease',()=>{
 const live=(change:Partial<LeaseRecord>={})=>proof({expiresAt:iso(Date.now()+60000),acquiredAt:iso(Date.now()-1000),...change}).originalLease;
 const mint=(o:{lease?:LeaseRecord|null;holds?:boolean;lock?:boolean;machineId?:string;leaseEpoch?:number})=>mintGraphMemberLossLeaseProof({coordinator:{currentLease:()=>o.lease===undefined?live():o.lease,holdsLease:()=>o.holds??true},instanceLockCurrent:()=>o.lock??true,machineId:o.machineId??writer,signingKey:keys.privateKey,membership,leaseEpoch:o.leaseEpoch??7});
 it('signs the current lease',()=>{const minted=mint({});expect(minted.originalLease.epoch).toBe(7);expect(minted.lease.expiresAt).toBe(minted.originalLease.expiresAt);expect(minted.lease.fencedLeaseHash).toBe(canonicalHash(minted.originalLease));});
 it('refuses when the coordinator no longer holds the lease',()=>{expect(()=>mint({holds:false})).toThrow('member-loss-native-epoch-continuation-required');});
 it('refuses with no lease, a lost instance lock, another holder or another epoch',()=>{expect(()=>mint({lease:null})).toThrow('member-loss-native-epoch-continuation-required');expect(()=>mint({lock:false})).toThrow('member-loss-native-epoch-continuation-required');expect(()=>mint({machineId:'m_other'})).toThrow('member-loss-native-epoch-continuation-required');expect(()=>mint({leaseEpoch:8})).toThrow('member-loss-native-epoch-continuation-required');});
 it('refuses a lease whose expiry has passed even if the coordinator says it holds it',()=>{expect(()=>mint({lease:live({acquiredAt:iso(Date.now()-120000),expiresAt:iso(Date.now()-1)})})).toThrow('member-loss-current-negative-lease-invalid');});
});
