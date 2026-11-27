import fs from 'node:fs';import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';
import {openRecoveryEngine} from '../../dist/recovery/RecoveryEntrypoint.js';
import {recoveryServiceId} from '../../dist/recovery/RecoveryInstallation.js';
const [root,round="initial"]=process.argv.slice(2);if(!root.includes('/echo-compute/recovery-10000001794/test-a4-'))throw new Error('test-root-refused');
const file=root+'/config.json',c=JSON.parse(fs.readFileSync(file,'utf8'));
const engine=await openRecoveryEngine(file);try{if(engine.admission.hold())throw new Error('test-watchdog-hold-active');}finally{engine.admission.close();}
const id=recoveryServiceId(c.agentId,c.machineId),label='com.instar.recovery-watchdog.'+id,plist=root+'/'+label+'.plist';
const args=[process.execPath,process.cwd()+'/scripts/recovery-test/watchdog.mjs',root,c.serviceLabel,String(c.healthPort),round];
const content=`<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map(a=>'<string>'+a+'</string>').join('')}</array><key>RunAtLoad</key><true/><key>StandardOutPath</key><string>${root}/watchdog.log</string><key>StandardErrorPath</key><string>${root}/watchdog.log</string></dict></plist>`;
try{execFileSync('/bin/launchctl',['print',`gui/${process.getuid()}/${label}`],{stdio:'ignore',timeout:3000});execFileSync('/bin/launchctl',['bootout',`gui/${process.getuid()}/${label}`],{stdio:'ignore',timeout:5000});}catch(error){if(![3,113].includes(error.status))throw error;}
fs.writeFileSync(plist,content,{mode:0o600});c.watchdog={label,plist,ownershipDigest:crypto.createHash('sha256').update(content).digest('hex')};fs.writeFileSync(file,JSON.stringify(c),{mode:0o600});
execFileSync('/bin/launchctl',['kill','SIGTERM',`gui/${process.getuid()}/com.instar.recovery-sidecar.${id}`]);
const until=Math.min(Date.now()+15000,JSON.parse(fs.readFileSync(root+'/test-deadline.json','utf8')).expiresAt-1000);
for(;;){
 if(Date.now()>=until)throw new Error('test-watchdog-bootstrap-deadline');
 if(fs.readFileSync(plist,'utf8')!==content)throw new Error('test-watchdog-plan-changed');
 try{execFileSync('/bin/launchctl',['bootstrap',`gui/${process.getuid()}`,plist],{timeout:3000,stdio:['ignore','pipe','pipe']});break;}
 catch(error){if(error.status!==5||!/Bootstrap failed: 5: Input\/output error/.test(String(error.stderr??'')))throw error;await new Promise(resolve=>setTimeout(resolve,500));}
}
console.log(JSON.stringify({label,installed:true}));
