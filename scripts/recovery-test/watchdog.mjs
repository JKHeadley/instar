// Deliberately faulty, Instar-owned watchdog for this throwaway service only.
import fs from 'node:fs';import {execFileSync} from 'node:child_process';
const [root,label,port]=process.argv.slice(2);
if(!root.includes('/echo-compute/recovery-10000001794/test-a4-')||!/^com\.instar\.recovery-target\.[a-f0-9]{32}$/.test(label))throw new Error('test-watchdog-scope-refused');
const marker=root+'/watchdog-first-triggered-'+(process.argv[5]??'initial');let active=true,kills=0;
process.once('SIGTERM',()=>{active=false;});
while(active){
let healthy=false;try{const r=await fetch(`http://127.0.0.1:${Number(port)}/health`,{signal:AbortSignal.timeout(150)});healthy=r.ok;await r.body?.cancel();}catch{}
if((!healthy||!fs.existsSync(marker))&&kills<10){
kills++;
fs.writeFileSync(marker,'triggered',{mode:0o600});
try{execFileSync('/bin/launchctl',['kill','SIGKILL',`gui/${process.getuid()}/${label}`],{timeout:1000,stdio:'ignore'});}catch{}
try{execFileSync('/bin/launchctl',['kickstart',`gui/${process.getuid()}/${label}`],{timeout:1000,stdio:'ignore'});}catch{}
fs.appendFileSync(root+'/watchdog-events.jsonl',JSON.stringify({at:Date.now(),event:'killed-and-restarted-owned-test-target'})+'\n',{mode:0o600});
}
await new Promise(r=>setTimeout(r,400));
}
