import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { rolloutGitAsync } from '../../src/core/featureRolloutGitAsync.js';

const owned: ChildProcess[]=[];
const groups=new Set<number>();
function node(code:string, grouped=false) {
  const child=spawn(process.execPath,['-e',code],{stdio:['ignore','pipe','pipe'],detached:grouped});owned.push(child);if(grouped&&child.pid)groups.add(child.pid);return child;
}
afterEach(()=>{vi.restoreAllMocks();for(const child of owned.splice(0)){
  try {if(process.platform!=='win32' && child.pid && groups.has(child.pid))process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{/* @silent-fallback-ok: isolated fixture already exited */}
}});
function alive(pid:number){try{process.kill(pid,0);return true;}catch{return false;}}
async function gone(pid:number){for(let i=0;i<100 && alive(pid);i++)await delay(10);return !alive(pid);}

describe('finite asynchronous rollout Git commands',()=>{
  it('preserves UTF-8 when a code point spans stdout chunks',async()=>{
    vi.spyOn(SafeGitExecutor,'readStream').mockImplementation(()=>node("process.stdout.write(Buffer.from([0xe2]));setTimeout(()=>process.stdout.write(Buffer.from([0x82,0xac])),10)"));
    expect(await rolloutGitAsync(['show','fixture'],process.cwd(),'test')).toBe('€');
  });
  it('rejects spawn refusal without trying another surface',async()=>{
    vi.spyOn(SafeGitExecutor,'readStream').mockImplementation(()=>{throw new Error('guard refused');});
    await expect(rolloutGitAsync(['show','fixture'],process.cwd(),'test')).rejects.toThrow('guard refused');
  });
  it('never returns earlier output from a failed command',async()=>{
    vi.spyOn(SafeGitExecutor,'readStream').mockImplementation(()=>node("process.stdout.write('partial');process.exitCode=2"));
    await expect(rolloutGitAsync(['show','fixture'],process.cwd(),'test')).rejects.toThrow('failed');
  });
  it('uses the actual inherited ten-MiB buffer rather than the generic Node default',async()=>{
    vi.spyOn(SafeGitExecutor,'readStream').mockImplementation(()=>node("process.stdout.write('x'.repeat(2*1024*1024))"));
    expect((await rolloutGitAsync(['show','fixture'],process.cwd(),'test')).length).toBe(2*1024*1024);
  });
  it('rejects buffer overflow rather than returning truncated evidence',async()=>{
    vi.spyOn(SafeGitExecutor,'readStream').mockImplementation(()=>node("process.stdout.write('x'.repeat(11*1024*1024));setInterval(()=>{},1000)"));
    await expect(rolloutGitAsync(['show','fixture'],process.cwd(),'test')).rejects.toThrow('exceeded command buffer');
    expect(await gone(owned[0].pid!)).toBe(true);
  });
  it('has a finite timeout even when the owned fetch ignores graceful termination',async()=>{
    vi.spyOn(SafeGitExecutor,'spawn').mockImplementation(()=>node("process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",process.platform!=='win32'));
    await expect(rolloutGitAsync(['fetch','fixture'],process.cwd(),'test',undefined,1000)).rejects.toThrow('timed out');
    expect(await gone(owned[0].pid!)).toBe(true);
  });
  it.skipIf(process.platform==='win32')('aborts the owned fetch and its helper before settling',async()=>{
    let helper=0;let ready!:()=>void;const started=new Promise<void>(r=>ready=r);
    vi.spyOn(SafeGitExecutor,'spawn').mockImplementation(()=>{
      const child=node("const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});process.on('SIGTERM',()=>{});process.stdout.write(String(c.pid)+'\\n');setInterval(()=>{},1000)",true);
      child.stdout!.once('data',(data)=>{helper=Number(String(data).trim());ready();});return child;
    });
    const controller=new AbortController();const running=rolloutGitAsync(['fetch','fixture'],process.cwd(),'test',controller.signal);
    const rejected=expect(running).rejects.toMatchObject({name:'AbortError'});
    await started;controller.abort();await rejected;
    expect(await gone(owned[0].pid!)).toBe(true);expect(await gone(helper)).toBe(true);
  });
});
