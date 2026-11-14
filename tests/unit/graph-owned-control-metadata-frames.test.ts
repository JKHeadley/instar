import {describe,expect,it} from 'vitest';
import {GraphOwnedControlMetadataFrames,GraphOwnedMetadataAssembly,decodeGraphOwnedMetadata,assertGraphOwnedOpaqueMetadata} from '../../src/core/GraphOwnedControlMetadataFrames.js';
import {GraphOwnedControlFrameBudget} from '../../src/core/GraphOwnedControlFrameCache.js';
describe('bounded opaque controller metadata',()=>{
 it('refuses late worker retention after terminal close but clear permits unrelated future transfers',()=>{
  const budget=new GraphOwnedControlFrameBudget(),cache=new GraphOwnedControlMetadataFrames(budget);
  cache.retain({head:'a'.repeat(64)},'peer');cache.clear();expect(budget.activeBytes).toBe(0);
  cache.retain({head:'b'.repeat(64)},'peer');cache.close();cache.close();
  expect(()=>cache.retain({head:'c'.repeat(64)},'late-worker')).toThrow('closed');
  expect(cache.activeBytes).toBe(0);expect(budget.activeBytes).toBe(0);
 });
 it('round-trips a large exact control value with signed-page-sized chunks and peer isolation',()=>{
  const cache=new GraphOwnedControlMetadataFrames(),value={kind:'opaque-control-fixture',entries:Array.from({length:900},(_,i)=>({id:String(i),hash:'a'.repeat(64),head:'b'.repeat(64),receipt:'c'.repeat(64),operationHash:'d'.repeat(64)}))};
  const d=cache.retain(value,'peer-one');expect(d.bytes).toBeGreaterThan(256*1024);expect(cache.retain(value,'peer-one')).toEqual(d);expect(()=>cache.chunk(d.id,0,'peer-two')).toThrow('unknown');
  const chunks=Array.from({length:d.chunks},(_,index)=>cache.chunk(d.id,index,'peer-one').chunk);expect(chunks.every(chunk=>Buffer.byteLength(JSON.stringify({chunk}))<256*1024)).toBe(true);expect(decodeGraphOwnedMetadata(d,chunks)).toEqual(value);
  expect(()=>decodeGraphOwnedMetadata(d,[chunks[0].slice(1),...chunks.slice(1)])).toThrow();cache.close();expect(()=>cache.chunk(d.id,0,'peer-one')).toThrow('unknown');
 });
 it('rejects private data recursively instead of hiding it in generic framing',()=>{
  for(const key of ['ciphertext','envelopes','rewrap','ownerRecoveryEnvelope','encryptedSourceBundle','title','salt'])expect(()=>assertGraphOwnedOpaqueMetadata({stage:{nested:[{[key]:'private'}]}})).toThrow('private-field');
 });
 it('shares a finite aggregate budget rather than applying a whole-command 32MiB limit',()=>{
  const budget=new GraphOwnedControlFrameBudget();budget.reserve(34_453_031);expect(budget.activeBytes).toBe(34_453_031);expect(()=>budget.reserve(34_453_031)).toThrow('capacity');budget.release(34_453_031);expect(budget.activeBytes).toBe(0);
 });
 it('zeros an in-flight receiving buffer and invalidates its generation while permitting a new unrelated transfer',()=>{
  const budget=new GraphOwnedControlFrameBudget(),cache=new GraphOwnedControlMetadataFrames(budget),descriptor=cache.retain({head:'a'.repeat(64)},'peer'),page=cache.chunk(descriptor.id,0,'peer'),assembly=new GraphOwnedMetadataAssembly(descriptor,budget);
  assembly.append(0,page.chunk);const actualBuffer=(assembly as unknown as {bytes:Buffer}).bytes;expect(actualBuffer.some(byte=>byte!==0)).toBe(true);budget.zero();cache.clear();expect(actualBuffer.every(byte=>byte===0)).toBe(true);expect(()=>assembly.finish()).toThrow('incomplete');assembly.close();
  const replacement=new GraphOwnedMetadataAssembly(descriptor,budget);replacement.append(0,page.chunk);expect(replacement.finish()).toEqual({head:'a'.repeat(64)});expect(budget.activeBytes).toBe(0);
 });
});
