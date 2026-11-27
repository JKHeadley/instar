// Real macOS crash test; signals only the child process created by this driver.
import fs from 'node:fs';import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
const [root]=process.argv.slice(2);
if(process.platform!=='darwin'||!root?.includes('/echo-compute/recovery-10000001794/test-a4-'))throw new Error('disposable-test-host-required');
const directory=path.join(root,'caffeinate-parent-trial');fs.mkdirSync(directory,{recursive:true,mode:0o700});
const pids=()=>{try{return execFileSync('/usr/bin/pgrep',['-x','caffeinate'],{encoding:'utf8',timeout:3000}).trim().split('\n').filter(Boolean).map(Number);}catch{return [];}};
const before=pids(),module=new URL('../../dist/core/CaffeinateManager.js',import.meta.url).href;
const code=`import {CaffeinateManager} from ${JSON.stringify(module)};const m=new CaffeinateManager({stateDir:${JSON.stringify(directory)}});m.start();console.log('READY:'+JSON.stringify(m.getStatus()));setInterval(()=>{},1000);`;
const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']});
let helper;
try{
 helper=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(new Error('trial-start-timeout')),10000);child.stdout.on('data',b=>{output+=b;const line=output.split('\n').find(s=>s.startsWith('READY:'));if(line){clearTimeout(timer);resolve(JSON.parse(line.slice(6)).pid);}});child.once('error',reject);child.once('exit',()=>{clearTimeout(timer);reject(new Error('trial-parent-exited'));});});
 const ended=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await ended;
 const deadline=Date.now()+10000;while(pids().includes(helper)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
 const after=pids(),unrelatedPreserved=before.every(pid=>after.includes(pid)),parentBoundExit=!after.includes(helper);
 console.log(JSON.stringify({parentBoundExit,unrelatedPreserved,existingHelpers:before.length}));
 if(!parentBoundExit||!unrelatedPreserved)process.exitCode=1;
}finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');}
