import {afterEach,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {installRecoveryServices} from '../../src/recovery/RecoveryInstallation.js';
import {RecoveryAdmission} from '../../src/recovery/RecoveryAdmission.js';
import {RecoveryEnrollment,type RecoveryEnrollmentAdvert} from '../../src/recovery/RecoveryEnrollment.js';
import {recoveryKeyPair,signRecovery,OFFLINE_LEASE_MS,type RecoveryCertificate,type RecoveryCheckpoint} from '../../src/recovery/RecoveryProtocol.js';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
vi.mock('../../src/recovery/RecoveryEngine.js',async original=>({...await original<object>(),recoveryHostBootId:async()=>'test-host-boot'}));
vi.mock('../../src/recovery/RecoveryRuntimeSlot.js',()=>({verifyRecoveryRuntimeSlot:(slot:unknown)=>slot,prepareRecoveryRuntimeSlot:(_entry:string,stateDir:string)=>{
  const directory=path.join(path.dirname(stateDir),'runtime-slots','a'.repeat(64)),node=path.join(directory,'bin','node');fs.mkdirSync(path.dirname(node),{recursive:true,mode:0o700});if(!fs.existsSync(node))fs.writeFileSync(node,'test',{mode:0o500});
  return {version:1,directory,node,entrypoint:path.join(directory,'scripts','recovery-entrypoint.mjs'),updateEntrypoint:path.join(directory,'scripts','recovery-update-entrypoint.mjs'),digest:'a'.repeat(64)};
}}));
vi.mock('../../src/recovery/RecoveryInstallation.js',async original=>({...await original<object>(),installRecoveryServices:vi.fn(async()=>({state:'awaiting-peer-proofs',labels:[]}))}));
const dirs:string[]=[];
afterEach(()=>{for(const dir of dirs.splice(0))SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'recovery-enrollment.test:cleanup'});});
function fixture(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'recovery-enrollment-'));dirs.push(dir);
  const root=recoveryKeyPair(),source=recoveryKeyPair(),peer=recoveryKeyPair(),peerSsh=recoveryKeyPair(),peerRelay=recoveryKeyPair(),authority=recoveryKeyPair();
  const main=path.join(dir,'ai.instar.agent.plist');fs.writeFileSync(main,'<plist><string>ai.instar.agent</string><string>server</string><string>start</string></plist>',{mode:0o600});
  let paired=[{machineId:'peer',pairingEpoch:1,publicKey:peer.publicKey}];
  const options={stateDir:dir,agentId:'agent',machineId:'source',certificationRoot:root.publicKey,machineSigningKey:source.privateKey,paired:()=>paired,
    relayUrl:'https://relay.example',directHost:'100.1.2.3',sshPort:22,sshHostPublicKey:'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA==',username:'test',agentHome:dir,mainServicePlist:main,mainHealthPort:4040,mainAuthToken:'fixture',entrypoint:'/installed/recovery-entrypoint.mjs',inspectSshEnvironment:()=>{}};
  fs.mkdirSync(path.join(dir,'bin'),{mode:0o700});fs.symlinkSync(process.execPath,path.join(dir,'bin','node'));fs.writeFileSync(path.join(dir,'instar-boot.cjs'),'// trusted installer wrapper',{mode:0o600});
  const enrollment=new RecoveryEnrollment(options),now=Date.now();
  const advert:RecoveryEnrollmentAdvert={domain:'instar-recovery-enrollment-v1',agentId:'agent',machineId:'peer',generation:1,sshPublicKey:peerSsh.publicKey,relayPublicKey:peerRelay.publicKey,
    sshClientPublicKey:'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK3J18o7t58nPfEYuvSgU0BWC3P7l3ukW7lwtuv3OgHz',ssh:{host:'100.2.3.4',port:22,username:'peer',hostFingerprint:'a'.repeat(64)},relayUrl:'https://relay.example',issuedAt:now,expiresAt:now+300_000};
  return {dir,enrollment,options,root,authority,peer,advert,revoke:()=>{paired=[];}};
}
function approved(f:ReturnType<typeof fixture>,challenge:string){const now=Date.now();
 const certificate=signRecovery<RecoveryCertificate>({domain:'instar-recovery-certificate-v1',agentId:'agent',publicKey:f.authority.publicKey,generation:1,issuedAt:now,expiresAt:now+30*OFFLINE_LEASE_MS},f.root.privateKey);
 const checkpoint=signRecovery<RecoveryCheckpoint>({domain:'instar-recovery-checkpoint-v1',agentId:'agent',targetMachineId:'source',challenge,version:1,issuedAt:now,expiresAt:now+OFFLINE_LEASE_MS,principals:[{machineId:'peer',pairingEpoch:1,generation:1,sshPublicKey:f.advert.sshPublicKey,relayPublicKey:f.advert.relayPublicKey}],revoked:[]},f.authority.privateKey);return{certificate,checkpoint};
}
describe('host-local recovery commissioning',()=>{
  it('prepares private keys and a fresh challenge without installing grants',async()=>{
    const f=fixture(),one=await f.enrollment.prepare(),two=await f.enrollment.prepare();
    expect(one.advert.payload.relayPublicKey).toBe(two.advert.payload.relayPublicKey);
    expect(one.challenge).not.toBe(two.challenge);
    expect(fs.existsSync(path.join(f.dir,'.ssh','authorized_keys'))).toBe(false);
    expect(fs.statSync(path.join(f.dir,'recovery','host.json')).mode&0o777).toBe(0o600);
  });
  it('does not refresh host bindings while a trusted main update owns admission',async()=>{
    const f=fixture();await f.enrollment.prepare();const configFile=path.join(f.dir,'recovery','host.json'),before=fs.readFileSync(configFile,'utf8'),c=JSON.parse(before);
    const admission=new RecoveryAdmission({stateDir:c.stateDir,agentId:c.agentId,machineId:c.machineId,certificationRoot:c.certificationRoot,bootId:'test-host-boot'});
    try{admission.beginOwnedUpdate('b'.repeat(64),{pid:process.pid,birth:1,bootId:'test-host-boot'});await expect(f.enrollment.prepare()).rejects.toThrow('recovery-install-operation-busy');expect(fs.readFileSync(configFile,'utf8')).toBe(before);}
    finally{admission.finishOwnedUpdate('b'.repeat(64));admission.close();}
  });
  it('binds peer inventories to the current MachineAuth key and rejects revoked or substituted peers',()=>{
    const f=fixture(),signed=signRecovery(f.advert,f.peer.privateKey);
    expect(f.enrollment.verifyAdvert(signed).machineId).toBe('peer');
    expect(()=>f.enrollment.verifyAdvert({...signed,payload:{...f.advert,ssh:{...f.advert.ssh,host:'attacker'}}})).toThrow('advert-invalid');
    f.revoke();expect(()=>f.enrollment.verifyAdvert(signed)).toThrow('advert-invalid');
  });
  it('keeps first enrollment durably inactive when independent service installation fails after grant files exist',async()=>{
    const f=fixture(),prepared=await f.enrollment.prepare(),{certificate,checkpoint}=approved(f,prepared.challenge);
    vi.mocked(installRecoveryServices).mockRejectedValueOnce(new Error('recovery-restorer-bootstrap-failed'));
    await expect(f.enrollment.install(certificate,checkpoint,[signRecovery(f.advert,f.peer.privateKey)])).rejects.toThrow('restorer-bootstrap-failed');
    const c=JSON.parse(fs.readFileSync(path.join(f.dir,'recovery','host.json'),'utf8')),a=new RecoveryAdmission({stateDir:c.stateDir,agentId:c.agentId,machineId:c.machineId,certificationRoot:c.certificationRoot,bootId:'test-host-boot'});
    try{expect(a.locallyActive()).toBe(false);expect(a.lease().ready).toBe(false);expect(()=>a.verifyDiscovery({} as never,'ssh')).toThrow('locally-deactivated');expect(()=>a.verifyDiscovery({} as never,'relay')).toThrow('locally-deactivated');}finally{a.close();}
  });
  it('reinstalls a deactivated target only with a fresh owner checkpoint while retaining its epoch fence',async()=>{
    const f=fixture(),first=await f.enrollment.prepare(),one=approved(f,first.challenge),adverts=[signRecovery(f.advert,f.peer.privateKey)];await f.enrollment.install(one.certificate,one.checkpoint,adverts);
    const c=JSON.parse(fs.readFileSync(path.join(f.dir,'recovery','host.json'),'utf8')),a=new RecoveryAdmission({stateDir:c.stateDir,agentId:c.agentId,machineId:c.machineId,certificationRoot:c.certificationRoot,bootId:'test-host-boot'});
    try{a.deactivate();expect(a.lease().ready).toBe(false);const prepared=await f.enrollment.prepare(),two=signRecovery({...one.checkpoint.payload,version:2,challenge:prepared.challenge},f.authority.privateKey);
      await expect(f.enrollment.install(one.certificate,two,adverts)).resolves.toMatchObject({state:'awaiting-peer-proofs'});expect(a.locallyActive()).toBe(true);expect(a.lease().ready).toBe(true);
    }finally{a.close();}
  });
  it.each(['uninstall','checkpoint','update'] as const)('refuses stale final enrollment writes after a concurrent %s',async(kind)=>{
    const f=fixture(),prepared=await f.enrollment.prepare(),{certificate,checkpoint}=approved(f,prepared.challenge),file=path.join(f.dir,'recovery','host.json'),before=fs.readFileSync(file,'utf8'),c=JSON.parse(before);
    const a=new RecoveryAdmission({stateDir:c.stateDir,agentId:c.agentId,machineId:c.machineId,certificationRoot:c.certificationRoot,bootId:'test-host-boot'});
    f.options.inspectSshEnvironment=()=>{
      if(kind==='uninstall')a.deactivate();
      else if(kind==='update')a.beginOwnedUpdate('d'.repeat(64),{pid:process.pid,birth:1,bootId:'test-host-boot'});
      else a.acceptCheckpoint(certificate,signRecovery({...checkpoint.payload,challenge:a.challenge(),version:2,disabledRoutes:['ssh']},f.authority.privateKey));
    };
    try{await expect(f.enrollment.install(certificate,checkpoint,[signRecovery(f.advert,f.peer.privateKey)])).rejects.toThrow(kind==='uninstall'?'installation-stale':kind==='checkpoint'?'install-checkpoint-changed':'owned-update-in-progress');
      expect(fs.readFileSync(file,'utf8')).toBe(before);expect(fs.existsSync(path.join(f.dir,'recovery','ssh-wrapper.sh'))).toBe(false);expect(fs.existsSync(path.join(f.dir,'recovery','runtime.json'))).toBe(false);expect(fs.existsSync(path.join(f.dir,'.ssh','authorized_keys'))).toBe(false);
    }finally{if(kind==='update')a.finishOwnedUpdate('d'.repeat(64));a.close();}
  });
  it('requires a genuine root-certified checkpoint before any account grant',async()=>{
    const f=fixture(),prepared=await f.enrollment.prepare(),now=Date.now();
    const cert:RecoveryCertificate={domain:'instar-recovery-certificate-v1',agentId:'agent',publicKey:f.authority.publicKey,generation:1,issuedAt:now,expiresAt:now+30*OFFLINE_LEASE_MS};
    const checkpoint:RecoveryCheckpoint={domain:'instar-recovery-checkpoint-v1',agentId:'agent',targetMachineId:'source',challenge:prepared.challenge,version:1,issuedAt:now,expiresAt:now+OFFLINE_LEASE_MS,
      principals:[{machineId:'peer',pairingEpoch:1,generation:1,sshPublicKey:f.advert.sshPublicKey,relayPublicKey:f.advert.relayPublicKey}],revoked:[]};
    await expect(f.enrollment.install(signRecovery(cert,f.peer.privateKey),signRecovery(checkpoint,f.authority.privateKey),[signRecovery(f.advert,f.peer.privateKey)])).rejects.toThrow('certificate-invalid');
    expect(fs.existsSync(path.join(f.dir,'.ssh','authorized_keys'))).toBe(false);
    await expect(f.enrollment.install(signRecovery(cert,f.root.privateKey),signRecovery(checkpoint,f.authority.privateKey),[signRecovery(f.advert,f.peer.privateKey)])).resolves.toMatchObject({state:'awaiting-peer-proofs'});
    const grants=fs.readFileSync(path.join(f.dir,'.ssh','authorized_keys'),'utf8');
    const wrapper=fs.readFileSync(path.join(f.dir,'recovery','ssh-wrapper.sh'),'utf8');expect(wrapper).toContain('runtime-slots');expect(wrapper).not.toContain('/installed/recovery-entrypoint.mjs');
    expect(grants).toContain('command=');expect(grants).toContain('restrict,command=');expect(grants).toContain('instar-recovery-access:agent:peer');
    expect(fs.existsSync(path.join(f.dir,'recovery','runtime.json'))).toBe(true);
  });
});
