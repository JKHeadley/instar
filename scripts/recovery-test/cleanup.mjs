import fs from 'node:fs';import {execFileSync} from 'node:child_process';
import {recoveryServiceId} from '../../dist/recovery/RecoveryInstallation.js';
import {openRecoveryEngine} from '../../dist/recovery/RecoveryEntrypoint.js';
const [root]=process.argv.slice(2);
if(!['adriana','amrch','justin_instar_1'].includes(process.env.USER)||!root.includes('/echo-compute/recovery-10000001794/test-a4-'))throw new Error('shared-test-host-required');
const e=await openRecoveryEngine(root+'/config.json');
try{if(e.admission.hold()){await e.restoreExpiredHold();if(e.admission.hold())throw new Error('test-hold-not-yet-expired');}}finally{e.admission.close();}
const c=JSON.parse(fs.readFileSync(root+'/config.json','utf8')),id=recoveryServiceId(c.agentId,c.machineId);
for(const kind of ['watchdog','target','sidecar','sshd','restore']){
const label=`com.instar.recovery-${kind}.${id}`;
try{execFileSync('/bin/launchctl',['print',`gui/${process.getuid()}/${label}`],{stdio:'ignore'});}catch{continue;}
execFileSync('/bin/launchctl',['bootout',`gui/${process.getuid()}/${label}`],{stdio:'ignore',timeout:10_000});
}
// The deadline job removes itself; manual cleanup removes it as well.
if(process.env.INSTAR_TEST_DEADLINE_TEARDOWN!=='1'){try{execFileSync('/bin/launchctl',['bootout',`gui/${process.getuid()}/com.instar.recovery-deadline.${id}`],{stdio:'ignore',timeout:10000});}catch{}}
console.log(JSON.stringify({machineId:c.machineId,testServicesRemoved:true}));
