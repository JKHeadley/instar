import crypto from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {canonicalPublicKey} from '../../src/core/GraphWitnessTypes.js';

describe('canonicalPublicKey verdict memo',()=>{
 const ed=crypto.generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}).toString();
 const x=crypto.generateKeyPairSync('x25519').publicKey.export({type:'spki',format:'pem'}).toString();
 it('keeps the same verdicts as the uncached check',()=>{
  for(let round=0;round<2;round++){
   expect(canonicalPublicKey(ed,'ed25519')).toBe(true);
   expect(canonicalPublicKey(ed,'x25519')).toBe(false);
   expect(canonicalPublicKey(x,'x25519')).toBe(true);
   expect(canonicalPublicKey(ed.replace(/\n$/,''),'ed25519')).toBe(false);
   expect(canonicalPublicKey('not a key','ed25519')).toBe(false);
   expect(canonicalPublicKey({} as unknown as string,'ed25519')).toBe(false);
  }
 });
 it('parses a given PEM once, then answers from the memo',()=>{
  const fresh=crypto.generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}).toString();
  const spy=vi.spyOn(crypto,'createPublicKey');
  try{expect(canonicalPublicKey(fresh,'ed25519')).toBe(true);expect(canonicalPublicKey(fresh,'ed25519')).toBe(true);expect(spy).toHaveBeenCalledTimes(1);}
  finally{spy.mockRestore();}
 });
 it('never keeps oversized input',()=>{
  const big='x'.repeat(4096),spy=vi.spyOn(crypto,'createPublicKey');
  try{expect(canonicalPublicKey(big,'ed25519')).toBe(false);expect(canonicalPublicKey(big,'ed25519')).toBe(false);expect(spy).toHaveBeenCalledTimes(2);}
  finally{spy.mockRestore();}
 });
 it('stays bounded and still correct after eviction',()=>{
  for(let i=0;i<1100;i++)expect(canonicalPublicKey('junk-'+i,'ed25519')).toBe(false);
  expect(canonicalPublicKey(ed,'ed25519')).toBe(true);
 });
});
