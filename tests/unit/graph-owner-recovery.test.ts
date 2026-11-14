import crypto from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {witnessFixture,pem} from './graph-witness-fixtures.js';
import {createGraphCustodyProfile} from '../../src/core/GraphCustodyProfile.js';
import {createGraphOwnerRecoveryEnvelope,recoverGraphOwnerControl,verifyGraphOwnerRecoveryEnvelope} from '../../src/core/GraphOwnerRecovery.js';
import {canonicalHash,GRAPH_SIGNATURE_DOMAINS as D,signGraphRecord,unsigned} from '../../src/core/GraphWitnessTypes.js';
function fixture(){const f=witnessFixture('/unused-owner-recovery'),raw={...f.membership,failureDomain:'owned-test-host'},profile=createGraphCustodyProfile(raw,{mode:'owned-machine',witnessPublicKey:pem(f.witness.publicKey),hostMachineId:f.machines[0].machineId},f.owner.privateKey),membership={...raw,custodyProfile:profile,signature:''};membership.signature=signGraphRecord(D.membership,unsigned(membership),f.owner.privateKey);return{...f,membership};}
describe('installed-member owner control recovery envelopes',()=>{
 it('recovers the original root with each actual installed sealing key without exporting a custody role key',()=>{
  const f=fixture(),envelope=createGraphOwnerRecoveryEnvelope(f.owner.privateKey,f.membership);expect(verifyGraphOwnerRecoveryEnvelope(envelope,f.membership,pem(f.owner.publicKey))).toBe(true);
  const serialized=JSON.stringify(envelope);expect(serialized).not.toContain('PRIVATE KEY');expect(serialized).not.toContain(pem(f.witness.privateKey));
  for(const member of f.machines){const recovered=recoverGraphOwnerControl(envelope,f.membership,pem(f.owner.publicKey),member.machineId,member.sealing.privateKey);expect(pem(crypto.createPublicKey(recovered))).toBe(pem(f.owner.publicKey));}
 });
 it('rejects foreign recipients, keys, owner roots, profile substitutions and extra plaintext fields',()=>{
  const f=fixture(),envelope=createGraphOwnerRecoveryEnvelope(f.owner.privateKey,f.membership),foreign=crypto.generateKeyPairSync('x25519');
  expect(()=>recoverGraphOwnerControl(envelope,f.membership,pem(f.owner.publicKey),'not-installed',foreign.privateKey)).toThrow();expect(()=>recoverGraphOwnerControl(envelope,f.membership,pem(f.owner.publicKey),f.machines[0].machineId,foreign.privateKey)).toThrow();
  expect(verifyGraphOwnerRecoveryEnvelope({...envelope,title:'private'},f.membership,pem(f.owner.publicKey))).toBe(false);expect(verifyGraphOwnerRecoveryEnvelope({...envelope,profileHash:canonicalHash(null)},f.membership,pem(f.owner.publicKey))).toBe(false);expect(verifyGraphOwnerRecoveryEnvelope(envelope,f.membership,pem(crypto.generateKeyPairSync('ed25519').publicKey))).toBe(false);
  expect(()=>createGraphOwnerRecoveryEnvelope(crypto.generateKeyPairSync('ed25519').privateKey,f.membership)).toThrow();
 });
});
