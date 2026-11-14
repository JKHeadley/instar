// Independent deadline for ALL disposable services, including SSH and recovery.
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {recoveryServiceId} from '../../dist/recovery/RecoveryInstallation.js';
const [root]=process.argv.slice(2);
if(!root?.includes('/echo-compute/recovery-10000001794/test-a4-'))throw new Error('test-root-refused');
const expiry=JSON.parse(fs.readFileSync(root+'/test-deadline.json','utf8')).expiresAt;
if(!Number.isSafeInteger(expiry))throw new Error('test-deadline-required');
if(Date.now()>=expiry){
 execFileSync(process.execPath,[new URL('./cleanup.mjs',import.meta.url).pathname,root],{timeout:20000,stdio:'inherit',env:{...process.env,INSTAR_TEST_DEADLINE_TEARDOWN:'1'}});
 const c=JSON.parse(fs.readFileSync(root+'/config.json','utf8'));
 fs.appendFileSync(root+'/teardown.log',JSON.stringify({at:Date.now(),deadlineTeardown:true})+'\n',{mode:0o600});
 execFileSync('/bin/launchctl',['bootout',`gui/${process.getuid()}/com.instar.recovery-deadline.${recoveryServiceId(c.agentId,c.machineId)}`],{timeout:5000});
}
