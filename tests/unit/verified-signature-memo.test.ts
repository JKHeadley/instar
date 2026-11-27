import crypto from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {verifyEd25519Memoized} from '../../src/core/VerifiedSignatureMemo.js';
const a=crypto.generateKeyPairSync('ed25519'),b=crypto.generateKeyPairSync('ed25519');
const sign=(data:Buffer,key=a.privateKey)=>crypto.sign(null,data,key);
describe('verified signature memo',()=>{
 it('checks a valid signature once and reuses the proven result',()=>{const data=Buffer.from('reuse-'+crypto.randomUUID()),sig=sign(data),spy=vi.spyOn(crypto,'verify');expect(verifyEd25519Memoized(data,sig,a.publicKey)).toBe(true);expect(verifyEd25519Memoized(data,sig,a.publicKey)).toBe(true);expect(spy).toHaveBeenCalledTimes(1);spy.mockRestore();});
 it('never reuses a result for different bytes',()=>{const data=Buffer.from('bytes-'+crypto.randomUUID()),sig=sign(data);expect(verifyEd25519Memoized(data,sig,a.publicKey)).toBe(true);expect(verifyEd25519Memoized(Buffer.concat([data,Buffer.from('x')]),sig,a.publicKey)).toBe(false);});
 it('never reuses a result for a different key',()=>{const data=Buffer.from('key-'+crypto.randomUUID()),sig=sign(data);expect(verifyEd25519Memoized(data,sig,a.publicKey)).toBe(true);expect(verifyEd25519Memoized(data,sig,b.publicKey)).toBe(false);});
 it('never reuses a result for a different signature',()=>{const data=Buffer.from('sig-'+crypto.randomUUID()),sig=sign(data),forged=Buffer.from(sig);forged[0]^=1;expect(verifyEd25519Memoized(data,sig,a.publicKey)).toBe(true);expect(verifyEd25519Memoized(data,forged,a.publicKey)).toBe(false);});
 it('keeps refusing a bad signature every time',()=>{const data=Buffer.from('bad-'+crypto.randomUUID()),bad=sign(Buffer.from('other')),spy=vi.spyOn(crypto,'verify');expect(verifyEd25519Memoized(data,bad,a.publicKey)).toBe(false);expect(verifyEd25519Memoized(data,bad,a.publicKey)).toBe(false);expect(spy).toHaveBeenCalledTimes(2);spy.mockRestore();});
 it('treats a PEM and the same key object as one key',()=>{const data=Buffer.from('pem-'+crypto.randomUUID()),sig=sign(data),pem=a.publicKey.export({type:'spki',format:'pem'}).toString(),spy=vi.spyOn(crypto,'verify');expect(verifyEd25519Memoized(data,sig,pem)).toBe(true);expect(verifyEd25519Memoized(data,sig,a.publicKey)).toBe(true);expect(spy).toHaveBeenCalledTimes(1);spy.mockRestore();});
 it('refuses a non-ed25519 key',()=>{const rsa=crypto.generateKeyPairSync('rsa',{modulusLength:2048});expect(verifyEd25519Memoized(Buffer.from('x'),Buffer.alloc(64),rsa.publicKey)).toBe(false);});
});
