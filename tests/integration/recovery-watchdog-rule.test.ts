import { afterEach,describe,expect,it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const watchdog=path.resolve('src/templates/scripts/instar-watchdog.sh');
const digest=(file:string)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
describe('installed fleet watchdog recovery rule boundary',()=>{
  let dir:string;
  afterEach(()=>{if(dir)SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'recovery-watchdog-rule.test:cleanup'});});
  function fixture(){
    dir=fs.mkdtempSync(path.join(os.tmpdir(),'recovery-rule-shell-'));
    const project=path.join(dir,'agent'),recovery=path.join(project,'.instar','recovery');fs.mkdirSync(recovery,{recursive:true,mode:0o700});
    const launchAgents=path.join(dir,'LaunchAgents');fs.mkdirSync(launchAgents,{mode:0o700});
    const plist=path.join(dir,'fleet.plist');fs.writeFileSync(plist,'owned fleet singleton',{mode:0o600});
    const preload=path.join(dir,'host-fixture.cjs');
    fs.writeFileSync(preload,"const cp=require('node:child_process');const original=cp.execFileSync;cp.execFileSync=(file,args,...rest)=>file==='/usr/sbin/sysctl'&&args[1]==='kern.bootsessionuuid'?'fixture-boot\\n':original(file,args,...rest);",{mode:0o600});
    const node=path.join(dir,'node');fs.writeFileSync(node,`#!/bin/sh\nexec '${process.execPath}' --require '${preload}' "$@"\n`,{mode:0o700});
    const w={kind:'agent-rule',label:'ai.instar.watchdog',targetLabel:'ai.instar.a',script:watchdog,scriptDigest:digest(watchdog),plist,ownershipDigest:digest(plist),
      holdFile:path.join(recovery,'watchdog-hold.json'),eventsFile:path.join(recovery,'watchdog-events.jsonl'),entrypoint:path.join(dir,'entry.mjs')};
    fs.writeFileSync(path.join(recovery,'host.json'),JSON.stringify({agentId:'a',serviceLabel:'ai.instar.a',watchdog:w}),{mode:0o600});
    const marker={version:1,label:'ai.instar.a',scriptDigest:w.scriptDigest,plistDigest:w.ownershipDigest,deadline:Date.now()+60000,
      monotonicDeadline:Number(process.hrtime.bigint()/1_000_000n)+60000,bootId:process.platform==='darwin'?'fixture-boot':fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()};
    fs.writeFileSync(w.holdFile,JSON.stringify(marker),{mode:0o600});
    const run=(label='ai.instar.a')=>spawnSync('bash',['-c','source "$1"; recovery_rule_held "$2" "$3"',watchdog,watchdog,project,label],{encoding:'utf8',timeout:10000,
      env:{...process.env,INSTAR_WATCHDOG_NODE_BIN:node,INSTAR_WATCHDOG_LAUNCH_AGENTS_DIR:launchAgents,INSTAR_WATCHDOG_STATE_DIR:path.join(dir,'state'),INSTAR_WATCHDOG_LOG_FILE:path.join(dir,'watchdog.log')}});
    return {w,marker,run};
  }
  it('pauses the exact agent rule and leaves another agent outside that hold',()=>{
    const {run}=fixture();expect(run().status).toBe(0);expect(run('ai.instar.other').status).toBe(1);
  });
  it('automatically resumes after the bounded deadline and rejects a tampered policy',()=>{
    const {w,marker,run}=fixture();
    fs.writeFileSync(w.holdFile,JSON.stringify({...marker,deadline:Date.now()-1}));expect(run().status).toBe(1);
    fs.writeFileSync(w.holdFile,JSON.stringify({...marker,scriptDigest:'0'.repeat(64)}));expect(run().status).toBe(1);
  });
});
