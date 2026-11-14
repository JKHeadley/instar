import {afterEach,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';import vm from 'node:vm';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
const dirs:string[]=[];
afterEach(()=>{vi.useRealTimers();for(const d of dirs.splice(0))SafeFsExecutor.safeRmSync(d,{recursive:true,force:true,operation:'recovery-refresh-runtime.test:cleanup'});});
describe('existing expiring fixture runtime refresh',()=>{
 it('retries only transient own launchd removal tombstones and preserves main/deadline',async()=>{
  vi.useFakeTimers();const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'refresh-runtime-')));dirs.push(temp);
  const root=path.join(temp,'echo-compute/recovery-10000001794/test-a4-fixture');fs.mkdirSync(root,{recursive:true,mode:0o700});
  const deadline=JSON.stringify({expiresAt:Date.now()+120000}),id='fixture',agentId='throwaway-recovery-fixture',config={agentId,machineId:'machine',stateDir:root+'/state',serviceLabel:'com.instar.recovery-target.'+id};
  const write=(file:string,text:string,mode=0o600)=>fs.writeFileSync(root+'/'+file,text,{mode});write('test-deadline.json',deadline);write('config.json',JSON.stringify(config));write('ssh-wrapper.sh','old wrapper',0o700);
  const labels=['com.instar.recovery-sidecar.'+id,'com.instar.recovery-restore.'+id,'com.instar.recovery-sshd.'+id];
  for(const label of labels)write(label+'.plist',`<string>${label}</string><string>${root}/sshd_config</string>`);
  const loaded=new Set(labels),calls:string[][]=[],attempts=new Map<string,number>();
  const execFileSync=(command:string,args:string[])=>{
   expect(command).toBe('/bin/launchctl');calls.push(args);const label=args[0]==='bootstrap'?path.basename(args[2],'.plist'):args[1].split('/').at(-1)!;expect(labels).toContain(label);
   if(args[0]==='print'){if(!loaded.has(label))throw {stderr:'Could not find service',status:113};return Buffer.from('loaded');}
   if(args[0]==='bootout'){loaded.delete(label);return Buffer.alloc(0);}
   if(args[0]==='bootstrap'){const count=(attempts.get(label)??0)+1;attempts.set(label,count);if(count<3)throw {stderr:'Bootstrap failed: 5: Input/output error',status:5};loaded.add(label);return Buffer.alloc(0);}
   throw new Error('unexpected verb');
  };
  const source=fs.readFileSync(path.resolve('scripts/recovery-test/refresh-runtime.mjs'),'utf8').split('\n').filter(line=>!line.startsWith('import ')).join('\n');
  const work=vm.runInNewContext('(async()=>{'+source+'})()',{
   fs,path,crypto,execFileSync,Date,setTimeout,console:{log:vi.fn(),error:vi.fn()},process:{argv:['node','script',root],env:{USER:'adriana'},getuid:()=>process.getuid?.()},
   prepareRecoveryRuntimeSlot:()=>({version:1,directory:root+'/runtime-slots/new',node:root+'/runtime-slots/new/bin/node',entrypoint:root+'/runtime-slots/new/scripts/recovery-entrypoint.mjs',digest:'a'.repeat(64)}),
   recoveryServiceId:()=>id,recoveryLaunchdPlan:()=>labels.slice(0,2).map(label=>({label,file:root+'/'+label+'.plist',content:`<string>${label}</string><key>EnvironmentVariables</key><dict></dict>`})),
  });
  await vi.runAllTimersAsync();await work;
  expect(loaded.size).toBe(3);expect([...attempts.values()]).toEqual([3,3,3]);expect(fs.readFileSync(root+'/test-deadline.json','utf8')).toBe(deadline);
  expect(fs.readFileSync(root+'/ssh-wrapper.sh','utf8')).toContain('runtime-slots/new');expect(calls.some(args=>args.join(' ').includes(config.serviceLabel))).toBe(false);
 });
});
