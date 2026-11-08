import fs from 'node:fs';import crypto from 'node:crypto';import {isIP} from 'node:net';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {recoveryLaunchdPlan,recoveryServiceId,recoveryRuntimeRevision} from '../../dist/recovery/RecoveryInstallation.js';
import {recoveryHostBootId} from '../../dist/recovery/RecoveryEngine.js';
const input=JSON.parse(fs.readFileSync(0,'utf8')),root=input.root,repo=process.cwd();
if(!['adriana','amrch','justin_instar_1'].includes(process.env.USER)||!root.includes('/echo-compute/recovery-10000001794/test-a4-'))throw new Error('shared-test-host-required');
if(!isIP(input.listenAddress??''))throw new Error('test-listen-address-required');
const sshdConfig=fs.readFileSync(root+'/sshd_config','utf8').replace(/^ListenAddress .*$/m,`ListenAddress ${input.listenAddress}`);fs.writeFileSync(root+'/sshd_config',sshdConfig,{mode:0o600});
const configFile=root+'/config.json',c=JSON.parse(fs.readFileSync(configFile,'utf8'));
const mainFile=root+'/agent/.instar/config.json',main=JSON.parse(fs.readFileSync(mainFile,'utf8'));
main.dispatches={...main.dispatches,enabled:false,dispatchFile:root+'/agent/.instar/state/dispatches.json',dispatchUrl:'https://example.invalid/disabled'};main.feedback={...main.feedback,enabled:false,feedbackFile:root+'/agent/.instar/feedback.json',webhookUrl:'https://example.invalid/disabled'};main.tunnel={enabled:false};
main.projectName=c.agentId;main.messaging=[];main.autoUpdate={enabled:false};main.multiMachine={enabled:false};main.threadline={enabled:false};
fs.writeFileSync(mainFile,JSON.stringify(main,null,2),{mode:0o600});
fs.writeFileSync(root+'/agent/.instar/jobs.json','[]');if(!c.mainAuthToken){if(typeof main.authToken!=='string'||main.authToken.startsWith('[secret:'))throw new Error('test-main-token-required');c.mainAuthToken=main.authToken;}fs.writeFileSync(configFile,JSON.stringify(c),{mode:0o600});
const expiresAt=Math.min(Date.now()+2*60*60*1000,Date.parse(main.throwawayAgent?.expiresAt??''));if(!Number.isSafeInteger(expiresAt)||expiresAt<=Date.now())throw new Error('fresh-expiring-test-agent-required');
fs.writeFileSync(root+'/test-deadline.json',JSON.stringify({expiresAt}),{mode:0o600});
const peer=input.peer;
fs.writeFileSync(root+'/authorized_keys',`restrict,command="${root}/ssh-wrapper.sh" ${peer.clientPublicKey}\n`,{mode:0o600});
const xml=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const env=`<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(root+'/home')}</string><key>PATH</key><string>${xml(path.dirname(process.execPath)+':/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin')}</string><key>NODE_EXTRA_CA_CERTS</key><string>${xml(root+'/relay-ca.pem')}</string></dict>`;
const plans=recoveryLaunchdPlan({agentId:c.agentId,machineId:c.machineId,node:process.execPath,entrypoint:repo+'/scripts/recovery-entrypoint.mjs',configFile,stateDir:c.stateDir,launchAgentsDir:root,configRevision:crypto.createHash('sha256').update(fs.readFileSync(configFile)).digest('hex'),runtimeRevision:recoveryRuntimeRevision(repo+'/scripts/recovery-entrypoint.mjs')});
for(const p of plans){
  const extra=env.slice('<key>EnvironmentVariables</key><dict>'.length,-'</dict>'.length);
  p.content=p.content.includes('<key>EnvironmentVariables</key>')
    ?p.content.replace(/(<key>EnvironmentVariables<\/key><dict>)([\s\S]*?)(<\/dict>)/,(_all,open,values,close)=>open+values+extra+close)
    :p.content.replace('</dict></plist>',env+'</dict></plist>');
}
const plist=(label,args,keepAlive=false)=>({label,file:root+'/'+label+'.plist',content:`<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map(a=>'<string>'+xml(a)+'</string>').join('')}</array><key>WorkingDirectory</key><string>${xml(root+'/agent')}</string><key>RunAtLoad</key><true/>${keepAlive?'<key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>':''}${env}<key>StandardOutPath</key><string>${root}/${label}.log</string><key>StandardErrorPath</key><string>${root}/${label}.log</string></dict></plist>`});
plans.push(plist(c.serviceLabel,[process.execPath,repo+'/dist/cli.js','server','start','--foreground','--no-telegram','--dir',root+'/agent']));
plans.push(plist('com.instar.recovery-sshd.'+recoveryServiceId(c.agentId,c.machineId),['/usr/sbin/sshd','-D','-e','-f',root+'/sshd_config'],true));
const deadline=plist('com.instar.recovery-deadline.'+recoveryServiceId(c.agentId,c.machineId),[process.execPath,repo+'/scripts/recovery-test/teardown.mjs',root]);deadline.content=deadline.content.replace('<key>RunAtLoad</key><true/>','<key>RunAtLoad</key><true/><key>StartInterval</key><integer>30</integer>');plans.unshift(deadline);
for(const p of plans){fs.writeFileSync(p.file,p.content,{mode:0o600});execFileSync('/bin/launchctl',['bootstrap',`gui/${process.getuid()}`,p.file],{stdio:['ignore','pipe','pipe'],timeout:5_000});}
console.log(JSON.stringify({machineId:c.machineId,bootId:await recoveryHostBootId(),labels:plans.map(p=>p.label)}));
