/** Shared guard for the ordinary setup/startup bootstrap writers. */
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';
import {RecoveryAdmission} from './RecoveryAdmission.js';import {loadRecoveryConfig} from './RecoveryEngine.js';
import {restoreRecoveryMainBindings,validateRecoveryMainBindings} from './RecoveryMainBindings.js';
import {processStartMs} from '../core/processIdentity.js';import {withSyncOp} from '../core/InFlightSyncOpMarker.js';
function configFile(projectDir:string):string{return path.join(projectDir,'.instar','recovery','host.json');}
function readPrivate(file:string):string{const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o077)||st.size>1048576)throw new Error('recovery-bootstrap-transaction-invalid');return fs.readFileSync(file,'utf8');}
/** A callback is trusted only while its exact installer transaction owns admission. */
export function assertRecoveryBootstrapWrite(projectDir:string):void {
 const file=configFile(projectDir);if(!fs.existsSync(file))return;
 const c=loadRecoveryConfig(file),transaction=JSON.parse(readPrivate(path.join(projectDir,'.instar','recovery','main-update.json'))),birth=processStartMs(process.pid);
 const digest=transaction.latchKey??crypto.createHash('sha256').update(transaction.previousConfig+transaction.nextPlist).digest('hex');
 if(transaction.projectDir!==projectDir||transaction.configFile!==file||transaction.phase!=='prepared'||transaction.ownerReleased||transaction.ownerPid!==process.pid||transaction.ownerBirth!==birth||transaction.previousConfig!==readPrivate(file))throw new Error('recovery-bootstrap-transaction-invalid');
 // This connection only reads the latch; no clock/lease or mutation method uses
 // this placeholder boot identity. The exact live parent process owns the latch.
 const a=new RecoveryAdmission({stateDir:c.stateDir,agentId:c.agentId,machineId:c.machineId,certificationRoot:c.certificationRoot,bootId:'bootstrap-read-only'});
 try{const owner=a.ownedUpdate();if(!owner||owner.released||owner.digest!==digest||owner.pid!==process.pid||owner.birth!==birth)throw new Error('recovery-bootstrap-transaction-invalid');}finally{a.close();}
}
/** Startup preserves current approved bindings; only exact missing bytes heal. */
export function preserveRecoveryBootstrap(projectDir:string):boolean {
 const file=configFile(projectDir);if(!fs.existsSync(file))return false;
 const before=readPrivate(file),c=loadRecoveryConfig(file);validateRecoveryMainBindings(c);
 const b=c.mainBindings!;
 if(fs.existsSync(b.wrapper)&&fs.existsSync(b.nodeAlias))return true;
 const bootId=process.platform==='darwin'?withSyncOp(()=>execFileSync('/usr/sbin/sysctl',['-n','kern.bootsessionuuid'],{encoding:'utf8',timeout:3000,maxBuffer:1024})).trim():process.platform==='linux'?fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim():'';
 if(!bootId)throw new Error('recovery-host-unsupported');
 const a=new RecoveryAdmission({stateDir:c.stateDir,agentId:c.agentId,machineId:c.machineId,certificationRoot:c.certificationRoot,bootId});
 try{a.withOwnedBindingWrite(()=>{if(readPrivate(file)!==before)throw new Error('recovery-install-config-changed');restoreRecoveryMainBindings(c);});}finally{a.close();}
 return true;
}
/** This reads only the exact protected installed policy, never general user config. */
export function enrolledRecoveryBootstrapMode(projectDir:string):{agentId:string;hasTelegram:boolean}|null {
 const file=configFile(projectDir);if(!fs.existsSync(file))return null;const c=loadRecoveryConfig(file);
 return{agentId:c.agentId,hasTelegram:fs.readFileSync(c.mainService!.plist,'utf8').includes('<string>lifeline</string>')};
}
