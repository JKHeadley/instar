// Refresh only an existing expiring shared-host fixture; never starts a main agent.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';
import {prepareRecoveryRuntimeSlot} from '../../dist/recovery/RecoveryRuntimeSlot.js';
import {recoveryLaunchdPlan,recoveryServiceId} from '../../dist/recovery/RecoveryInstallation.js';
const input=process.argv[2]?{root:process.argv[2]}:JSON.parse(fs.readFileSync(0,'utf8'));
const root=path.resolve(input.root??'');
if(!['adriana','amrch','justin_instar_1'].includes(process.env.USER)||!root.includes('/echo-compute/recovery-10000001794/test-a4-')||fs.realpathSync(root)!==root)throw new Error('shared-test-host-required');
function owned(file){const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o022)||st.size>262144)throw new Error('test-file-ownership-invalid');return fs.readFileSync(file,'utf8');}
const deadline=owned(root+'/test-deadline.json'),expiresAt=JSON.parse(deadline).expiresAt;
if(!Number.isSafeInteger(expiresAt)||expiresAt<=Date.now()+60000)throw new Error('fresh-expiring-test-deadline-required');
const configFile=root+'/config.json',previousConfig=owned(configFile),c=JSON.parse(previousConfig),id=recoveryServiceId(c.agentId,c.machineId);
if(!/^throwaway-recovery-[a-z0-9-]+$/.test(c.agentId)||c.stateDir!==root+'/state'||c.serviceLabel!==`com.instar.recovery-target.${id}`)throw new Error('disposable-target-required');
const runtime=prepareRecoveryRuntimeSlot(path.resolve('scripts/recovery-entrypoint.mjs'),c.stateDir);
const next={...c,previousRuntimeSlot:c.runtimeSlot,runtimeSlot:runtime};
if(next.watchdog?.kind==='agent-rule')next.watchdog={...next.watchdog,entrypoint:runtime.entrypoint};
const configBytes=JSON.stringify(next),quote=s=>"'"+s.replaceAll("'","'\\''")+"'",xml=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const wrapper=root+'/ssh-wrapper.sh',previousWrapper=owned(wrapper);
const script=`#!/bin/sh\nexport NODE_EXTRA_CA_CERTS=${quote(root+'/relay-ca.pem')}\nexec ${quote(runtime.node)} ${quote(runtime.entrypoint)} ssh ${quote(configFile)}\n`;
const plans=recoveryLaunchdPlan({agentId:c.agentId,machineId:c.machineId,node:runtime.node,entrypoint:runtime.entrypoint,configFile,stateDir:c.stateDir,launchAgentsDir:root,configRevision:crypto.createHash('sha256').update(configBytes).digest('hex'),runtimeRevision:runtime.digest});
const extra=`<key>HOME</key><string>${xml(root+'/home')}</string><key>PATH</key><string>${xml(path.dirname(runtime.node)+':/usr/bin:/bin:/usr/sbin:/sbin')}</string><key>NODE_EXTRA_CA_CERTS</key><string>${xml(root+'/relay-ca.pem')}</string>`;
for(const p of plans)p.content=p.content.replace(/(<key>EnvironmentVariables<\/key><dict>)([\s\S]*?)(<\/dict>)/,(_all,open,values,close)=>open+values+extra+close);
const sshLabel=`com.instar.recovery-sshd.${id}`,sshFile=root+'/'+sshLabel+'.plist',sshContent=owned(sshFile);
if(!sshContent.includes(`<string>${sshLabel}</string>`)||!sshContent.includes(`<string>${root}/sshd_config</string>`))throw new Error('isolated-sshd-required');
const services=[...plans.map(p=>({...p,previous:owned(p.file)})),{label:sshLabel,file:sshFile,content:sshContent,previous:sshContent}];
for(const p of services)if(!p.previous.includes(`<string>${p.label}</string>`))throw new Error('test-service-identity-mismatch');
const domain=`gui/${process.getuid()}`,loaded=[];
const launch=args=>execFileSync('/bin/launchctl',args,{stdio:['ignore','pipe','pipe'],timeout:3000});
const delay=()=>new Promise(resolve=>setTimeout(resolve,500));
const absent=error=>/Could not find service|No such process|No such file or directory/.test(String(error.stderr??''));
const removalDeadline=Math.min(Date.now()+45000,expiresAt-10000);
async function waitAbsent(label){
 while(Date.now()<removalDeadline){try{launch(['print',domain+'/'+label]);}catch(error){if(absent(error))return;throw error;}await delay();}
 throw new Error('isolated-service-removal-timeout');
}
async function bootstrap(p,rollback=false){
 const until=rollback?Math.min(Date.now()+15000,expiresAt-2000):removalDeadline;
 for(;;){
  if(Date.now()>=expiresAt-1000)throw new Error('test-deadline-expired');
  if(owned(p.file)!==p.content)throw new Error('isolated-service-plan-changed');
  try{launch(['bootstrap',domain,p.file]);return;}catch(error){
   // launchd can report absent while its bootout tombstone still rejects the
   // same exact label with EIO. Retry only this transitional bootstrap failure.
   if(error.status!==5||!/Input\/output error|Bootstrap failed: 5/i.test(String(error.stderr??''))||Date.now()>=until)throw error;
  }
  await delay();
 }
}
for(const p of services){try{launch(['print',domain+'/'+p.label]);loaded.push(p.label);}catch(error){if(!absent(error))throw error;}}
const atomic=(file,bytes,mode)=>{const temporary=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temporary,bytes,{flag:'wx',mode});fs.renameSync(temporary,file);};
const started=[],stopped=[];
try{
 for(const p of services)if(loaded.includes(p.label)){launch(['bootout',domain+'/'+p.label]);stopped.push(p.label);await waitAbsent(p.label);}
 atomic(configFile,configBytes,0o600);atomic(wrapper,script,0o700);
 for(const p of services){atomic(p.file,p.content,0o600);await bootstrap(p);started.push(p.label);}
 if(owned(root+'/test-deadline.json')!==deadline)throw new Error('test-deadline-changed');
 console.log(JSON.stringify({machineId:c.machineId,expiresAt,runtimeDigest:runtime.digest,runtimeDirectory:runtime.directory,labels:services.map(p=>p.label),mainUntouched:true,deadlineUntouched:true}));
}catch(error){
 const rollbackErrors=[];
 for(const label of started.reverse()){try{launch(['bootout',domain+'/'+label]);}catch(e){rollbackErrors.push(String(e));}}
 try{atomic(configFile,previousConfig,0o600);atomic(wrapper,previousWrapper,0o700);}catch(e){rollbackErrors.push(String(e));}
 for(const p of services){try{atomic(p.file,p.previous,0o600);if(stopped.includes(p.label))await bootstrap({...p,content:p.previous},true);}catch(e){rollbackErrors.push(String(e));}}
 if(rollbackErrors.length)console.error(JSON.stringify({rollbackIncomplete:true,errors:rollbackErrors.map(e=>e.slice(0,160))}));throw error;
}
