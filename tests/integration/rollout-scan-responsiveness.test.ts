import { describe,it,expect } from 'vitest';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rolloutFixture } from '../helpers/rolloutScanFixture.js';

async function scenario(repo:string,mode:'sync'|'async'|'fallback') {
  const child=fork(fileURLToPath(new URL('../fixtures/rollout-scan-responsive-server.mjs',import.meta.url)),[repo,mode],{
    execArgv:[],stdio:['ignore','pipe','pipe','ipc']});
  let diagnostic='';child.stderr!.on('data',d=>{diagnostic=(diagnostic+String(d)).slice(-4000);});
  const wait=(kind:string)=>new Promise<any>((resolve,reject)=>{
    const message=(m:any)=>{if(m.type==='failure'){clean();reject(new Error(m.message));}else if(m.type===kind){clean();resolve(m);}};
    const exit=()=>{clean();reject(new Error(`fixture exited before ${kind}: ${diagnostic}`));};
    const clean=()=>{child.off('message',message);child.off('exit',exit);};child.on('message',message);child.once('exit',exit);
  });
  const probes:{sent:number;done:number;ok:boolean}[]=[];const pending:Promise<void>[]=[];let timer:ReturnType<typeof setInterval>|undefined;
  try{
    const ready=await wait('ready');
    const probe=()=>{const sent=performance.now();const operation=fetch(`http://127.0.0.1:${ready.port}/health`,{signal:AbortSignal.timeout(ready.healthDeadlineMs)})
      .then(async r=>{await r.json();probes.push({sent,done:performance.now(),ok:r.ok});},()=>{probes.push({sent,done:performance.now(),ok:false});});pending.push(operation);};
    const completed=wait('complete');timer=setInterval(probe,ready.renewEveryMs);probe();child.send('run');
    const result=await completed;clearInterval(timer);timer=undefined;probe();await Promise.all(pending);
    return{...result,...ready,probes};
  }finally{
    if(timer)clearInterval(timer);
    if(child.exitCode===null && child.signalCode===null){
      const stopped=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
      if(child.connected)child.send('stop');else child.kill('SIGKILL');
      const deadline=setTimeout(()=>child.kill('SIGKILL'),5000);await stopped;clearTimeout(deadline);
    }
  }
}
function renewalGaps(result:any){
  const times=result.confirmations as number[];
  const before=times.filter(t=>t<=result.started).at(-1);const after=times.find(t=>t>result.ended);
  expect(before).toBeDefined();expect(after).toBeDefined();
  const bracketed=[before!,...times.filter(t=>t>result.started&&t<=result.ended),after!];
  return bracketed.slice(1).map((t,i)=>t-bracketed[i]);
}
function responsive(result:any){
  expect(result.holdsLease).toBe(true);expect(result.ownership.every(Boolean)).toBe(true);
  expect(result.probes.length).toBeGreaterThan(2);
  expect(result.probes.every((p:any)=>p.ok&&p.done-p.sent<result.healthDeadlineMs)).toBe(true);
  expect(Math.max(...renewalGaps(result))).toBeLessThan(result.ttlMs);
  expect(result.confirmations.filter((t:number)=>t>=result.started&&t<=result.ended).length).toBeGreaterThan(1);
  expect(result.writes.length).toBeGreaterThan(1);
}

describe('large rollout scans preserve externally observed health and real leases',()=>{
  it('reproduces the synchronous gap and keeps the same canonical inventory responsive asynchronously',async()=>{
    const f=rolloutFixture(1000);
    try{
      const old=await scenario(f.repo,'sync');
      expect(old.holdsLease===false || old.probes.some((p:any)=>!p.ok||p.done-p.sent>=old.healthDeadlineMs)).toBe(true);
      const repaired=await scenario(f.repo,'async');responsive(repaired);
      expect(repaired.degradations).toEqual([]);expect(repaired.ids).toContain('canonical-new');expect(repaired.ids).not.toContain('local-only');
      expect(new Set(repaired.ids)).toEqual(new Set(old.ids));
    }finally{f.close();}
  },180000);
  it('keeps the complete large local fallback responsive through the last tracker write',async()=>{
    const f=rolloutFixture();
    try{
      // Match the measured 2538-file inventory and include its largest 343475-byte file.
      for(let i=0;i<2536;i++)f.write(f.repo,`docs/specs/local-volume-${i}.md`,f.content(`Local ${i}`)+'x'.repeat(11700));
      f.write(f.repo,'docs/specs/local-volume-0.md',f.content('Largest local')+'x'.repeat(343475-Buffer.byteLength(f.content('Largest local'))));
      const result=await scenario(f.repo,'fallback');responsive(result);
      expect(result.degradations).toHaveLength(1);expect(result.ids).toContain('local-only');expect(result.ids).not.toContain('canonical-new');
      expect(result.ids).toHaveLength(2538);
    }finally{f.close();}
  },120000);
});
