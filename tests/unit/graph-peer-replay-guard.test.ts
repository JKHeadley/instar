import {describe,expect,it} from 'vitest';
import {GraphPeerReplayGuard} from '../../src/server/GraphPeerReplayGuard.js';

function guard(over:Partial<ConstructorParameters<typeof GraphPeerReplayGuard>[0]>={}){
 let now=1_000_000;const g=new GraphPeerReplayGuard({windowMs:60_000,maxEntries:3,maxRetainedBytes:1024,replayCode:'replayed',capacityCode:'window-full',now:()=>now,...over});
 return {g,advance:(ms:number)=>{now+=ms;}};
}

describe('GraphPeerReplayGuard',()=>{
 it('runs the work once and gives an in-flight exact repeat the same answer',async()=>{
  const {g}=guard();let runs=0;let release!:(v:string)=>void;
  const work=()=>{runs++;return new Promise<string>(resolve=>{release=resolve;});};
  const first=g.run('a:1','h',work),second=g.run('a:1','h',work);
  await new Promise(resolve=>setImmediate(resolve));release('answer');
  await expect(first).resolves.toBe('answer');await expect(second).resolves.toBe('answer');expect(runs).toBe(1);
 });

 it('gives a settled exact repeat the same answer without running again',async()=>{
  const {g}=guard();let runs=0;
  await g.run('a:1','h',async()=>{runs++;return {ok:true};});
  await expect(g.run('a:1','h',async()=>{runs++;return {ok:false};})).resolves.toEqual({ok:true});expect(runs).toBe(1);
 });

 it('refuses a reused request id with different bytes',async()=>{
  const {g}=guard();await g.run('a:1','h1',async()=>1);
  await expect(g.run('a:1','h2',async()=>2)).rejects.toThrow('replayed');
 });

 it('shares a refusal with an exact repeat instead of running the work again',async()=>{
  const {g}=guard();let runs=0;const fail=async()=>{runs++;throw new Error('graph-runtime-mutation-not-admitted');};
  await expect(g.run('a:1','h',fail)).rejects.toThrow('not-admitted');
  await expect(g.run('a:1','h',fail)).rejects.toThrow('not-admitted');expect(runs).toBe(1);
 });

 it('refuses a repeat once the answer was too large to keep, and keeps distinct requests apart',async()=>{
  const {g}=guard({maxRetainedBytes:16});
  await g.run('a:1','h',async()=>'x'.repeat(100));
  await expect(g.run('a:1','h',async()=>'y')).rejects.toThrow('replayed');
  await expect(g.run('a:2','h',async()=>'small')).resolves.toBe('small');
 });

 it('reports a full window by its own code, and forgets ids after the window',async()=>{
  const {g,advance}=guard();
  for(const id of ['1','2','3'])await g.run('a:'+id,'h',async()=>id);
  await expect(g.run('a:4','h',async()=>'4')).rejects.toThrow('window-full');
  advance(60_001);
  await expect(g.run('a:4','h',async()=>'4')).resolves.toBe('4');expect(g.size).toBe(1);
  await expect(g.run('a:1','h',async()=>'again')).resolves.toBe('again');
 });
});

