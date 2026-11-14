#!/usr/bin/env node
/** Run on the relay host, with the signed release trust store mounted read-only. */
import fs from 'node:fs';
import path from 'node:path';
import { prepareRecoveryAuthority, activateRecoveryAuthority, validateProductionRecoveryAuthorities } from '../dist/recovery/RecoveryAuthoritySetup.js';
import { verifyRecovery } from '../dist/recovery/RecoveryProtocol.js';
const [mode,directory,...args]=process.argv.slice(2);
try {
  if(!directory||!path.isAbsolute(directory))throw new Error('recovery-setup-absolute-directory-required');
  if(mode==='prepare'){
    const [agentId,generation='1']=args;
    prepareRecoveryAuthority({directory,agentId,generation:Number(generation)});
    console.log('Certificate request prepared. Submit certificate-request.json through the release certification process. The private checkpoint key stays on this relay host.');
  }else if(mode==='activate'){
    const [certificateFile,rootsFile,relayOrigin]=args;
    if(!certificateFile||!rootsFile||!relayOrigin)throw new Error('recovery-setup-activation-arguments-required');
    const stat=fs.lstatSync(rootsFile);
    if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o022)||stat.size>65536)throw new Error('recovery-setup-release-root-invalid');
    const roots=JSON.parse(fs.readFileSync(rootsFile,'utf8'));
    const certificate=JSON.parse(fs.readFileSync(certificateFile,'utf8'));
    const root=Array.isArray(roots)&&roots.find(r=>typeof r==='string'&&verifyRecovery(certificate,r));
    if(!root)throw new Error('recovery-setup-release-root-required');
    const result=activateRecoveryAuthority({directory,certificate,certificationRoot:root,relayOrigin});
    const file=path.join(directory,'authority.json');
    validateProductionRecoveryAuthorities({[certificate.payload.agentId]:result.authority},roots);
    fs.writeFileSync(file,JSON.stringify({[certificate.payload.agentId]:result.authority},null,2)+'\n',{mode:0o600,flag:'wx'});
    fs.writeFileSync(path.join(directory,'phone-enrollment-url.txt'),result.enrollmentUrl+'\n',{mode:0o600,flag:'wx'});
    console.log('Certified authority ready. Install authority.json in the relay host secret manager and set RELAY_RECOVERY_AUTHORITY_FILE. Set RELAY_RECOVERY_CERTIFICATION_ROOTS_FILE to the independently mounted release trust store. Deliver the private phone-enrollment-url.txt through the operator’s existing secure channel within 15 minutes; never paste it in logs.');
  }else throw new Error('recovery-setup-mode-invalid');
}catch(error){
  const reason=error instanceof Error&&/^recovery-[a-z-]+$/.test(error.message)?error.message:'recovery-setup-failed';
  console.error(reason);process.exitCode=1;
}
