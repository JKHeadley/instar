import {describe,expect,it} from 'vitest';
import {graphJoinAddition} from '../../src/core/GraphCustodyJoinIntent.js';
import {canonicalHash,type GraphMembershipEpoch} from '../../src/core/GraphWitnessTypes.js';

const member=(machineId:string,suffix='')=>({machineId,signingPublicKey:'sign-'+machineId+suffix,sealingPublicKey:'seal-'+machineId+suffix});
const profile={mode:'owned-machine',hostMachineId:'a',witnessPublicKey:'w'};
const previous={v:1,agentId:'echo',epoch:1,witnessId:'witness',writerId:'a',members:[member('a')],custodyProfile:profile,signature:'s'} as unknown as GraphMembershipEpoch;
const next=(change:Record<string,unknown>={})=>({...previous,epoch:2,previousMembershipHash:canonicalHash(previous),members:[member('a'),member('b')],...change}) as unknown as GraphMembershipEpoch;

describe('adding a machine',()=>{
 it('accepts one new member with everything else unchanged, in any order',()=>{
  expect(graphJoinAddition(previous,next())?.machineId).toBe('b');
  expect(graphJoinAddition(previous,next({members:[member('b'),member('a')]}))?.machineId).toBe('b');
 });
 it.each([
  ['the same set',{members:[member('a')]}],
  ['removing a member',{members:[]}],
  ['swapping a member',{members:[member('b')]}],
  ['changing an existing key',{members:[member('a','-new'),member('b')]}],
  ['adding two',{members:[member('a'),member('b'),member('c')]}],
  ['a duplicate row',{members:[member('a'),member('a')]}],
  ['moving the host',{custodyProfile:{...profile,hostMachineId:'b'}}],
  ['changing the witness key',{custodyProfile:{...profile,witnessPublicKey:'other'}}],
  ['changing the witness',{witnessId:'other'}],
  ['leaving owned-machine custody',{custodyProfile:undefined}],
  ['skipping an epoch',{epoch:3}],
  ['naming another predecessor',{previousMembershipHash:'x'.repeat(64)}],
  ['another agent',{agentId:'other'}],
  ['changing the host key',{custodyProfile:{...profile,hostSigningPublicKey:'other'}}],
  ['changing the failure domain',{failureDomain:'other'}],
  ['changing the writer',{writerId:'b'}],
 ])('refuses %s',(_name,change)=>{expect(graphJoinAddition(previous,next(change as Record<string,unknown>))).toBeNull();});
});
