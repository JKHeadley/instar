/** Host-local commissioning. No key, service selector or shell command comes from a phone request. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MachineSshIdentity } from '../core/MachineSshIdentity.js';
import { PeerAuthorizedKeys } from '../core/PeerAuthorizedKeys.js';
import { qualifyRecoverySshEnvironment } from './RecoverySshEnvironment.js';
import { RecoveryAdmission } from './RecoveryAdmission.js';
import { recoveryHostBootId, loadRecoveryConfig, type RecoveryHostConfig } from './RecoveryEngine.js';
import { prepareRecoveryRuntimeSlot,verifyRecoveryRuntimeSlot } from './RecoveryRuntimeSlot.js';
import { captureRecoveryMainBindings } from './RecoveryMainBindings.js';
import { installRecoveryServices } from './RecoveryInstallation.js';
import { recoveryKeyPair, recoveryKeyFingerprint, recoveryDigest, signRecovery, verifyRecovery, validRecoveryId, type Signed, type RecoveryCertificate, type RecoveryCheckpoint } from './RecoveryProtocol.js';
import type { RecoveryPeerTarget } from './RecoveryClient.js';
import type { RecoveryRuntimeManifest } from './RecoveryRuntime.js';

export interface RecoveryEnrollmentAdvert {
  domain: 'instar-recovery-enrollment-v1'; agentId: string; machineId: string; generation: number;
  sshPublicKey: string; relayPublicKey: string; sshClientPublicKey: string;
  ssh: { host: string; port: number; username: string; hostFingerprint: string };
  relayUrl: string; issuedAt: number; expiresAt: number;
}
export interface RecoveryEnrollmentOptions {
  stateDir: string; agentId: string; machineId: string;
  /** Release-provisioned root only; never a caller-supplied or locally generated root. */
  certificationRoot: string;
  /** Existing MachineAuth identity; never a recovery principal's own attestation. */
  machineSigningKey: string;
  paired: () => Array<{ machineId: string; pairingEpoch: number; publicKey: string }>;
  relayUrl: string; directHost: string; sshPort: number; sshHostPublicKey: string;
  username: string; agentHome: string; mainServicePlist: string; mainHealthPort: number; mainAuthToken: string;
  entrypoint: string;
  /** Host OS policy reader, injected only by production-platform adapter tests. */
  inspectSshEnvironment?:(hostKeyFile:string)=>void;
}
function secureDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077)) throw new Error('recovery-enrollment-storage-invalid');
}
function read(file: string): any {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077) || st.size > 1_048_576) throw new Error('recovery-enrollment-storage-invalid');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function write(file: string, value: unknown): void {
  if (fs.existsSync(file)) read(file);
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file);
}
const shellQuote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

export class RecoveryEnrollment {
  readonly directory: string;
  constructor(private readonly o: RecoveryEnrollmentOptions) {
    if (!validRecoveryId(o.agentId) || !validRecoveryId(o.machineId)) throw new Error('recovery-enrollment-identity-invalid');
    recoveryKeyFingerprint(o.certificationRoot);
    this.directory = path.join(o.stateDir, 'recovery');
    secureDirectory(this.directory);
  }
  /** Idempotent local preparation creates no host grant or running listener. */
  async prepare(): Promise<{ advert: Signed<RecoveryEnrollmentAdvert>; challenge: string }> {
    if(!this.o.directHost||this.o.directHost.length>253||/[\s/\\]/.test(this.o.directHost))throw new Error('recovery-direct-route-required');
    const file = path.join(this.directory, 'host.json');
    let config: RecoveryHostConfig;
    if (fs.existsSync(file)) config = loadRecoveryConfig(file);
    else {
      const ssh = recoveryKeyPair(), relay = recoveryKeyPair();
      const st = fs.lstatSync(this.o.mainServicePlist);
      if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o022)) throw new Error('recovery-main-service-ownership-invalid');
      config = { version: 1, agentId: this.o.agentId, machineId: this.o.machineId, stateDir: path.join(this.directory, 'admission'),
        certificationRoot: this.o.certificationRoot, sshPrivateKey: ssh.privateKey, relayPrivateKey: relay.privateKey,
        relayUrl: this.o.relayUrl, serviceLabel: `ai.instar.${this.o.agentId}`, healthPort: this.o.mainHealthPort,
        mainAuthToken: this.o.mainAuthToken, mainStateDir:this.o.stateDir, authorizedKeysHome:this.o.agentHome,
        mainService: { plist: this.o.mainServicePlist, ownershipDigest: crypto.createHash('sha256').update(fs.readFileSync(this.o.mainServicePlist)).digest('hex') } };
      const home=this.o.agentHome;
      const watchdogFile=path.join(home,'Library','LaunchAgents','ai.instar.watchdog.plist');
      const watchdogScript=path.join(home,'.instar','instar-watchdog.sh');
      try {
        for(const candidate of [watchdogFile,watchdogScript]) {
          const owned=fs.lstatSync(candidate);
          if(!owned.isFile()||owned.isSymbolicLink()||owned.uid!==process.getuid?.()||(owned.mode&0o022)||owned.size>262_144)throw new Error('recovery-watchdog-ownership-invalid');
        }
        if(fs.readFileSync(watchdogScript,'utf8').includes('recovery_rule_held')) {
          config.watchdog={entrypoint:this.o.entrypoint,kind:'agent-rule',label:'ai.instar.watchdog',plist:watchdogFile,ownershipDigest:crypto.createHash('sha256').update(fs.readFileSync(watchdogFile)).digest('hex'),
            script:watchdogScript,scriptDigest:crypto.createHash('sha256').update(fs.readFileSync(watchdogScript)).digest('hex'),targetLabel:config.serviceLabel,
            holdFile:path.join(this.directory,'watchdog-hold.json'),eventsFile:path.join(this.directory,'watchdog-events.jsonl')};
        }
      } catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error; }
      write(file, config); loadRecoveryConfig(file);
    }
    if (config.agentId !== this.o.agentId || config.machineId !== this.o.machineId || config.certificationRoot !== this.o.certificationRoot) throw new Error('recovery-enrollment-identity-invalid');
    const previousConfig=fs.readFileSync(file,'utf8');
    let bindingChanged=false;
    if(!config.mainStateDir){config.mainStateDir=this.o.stateDir;bindingChanged=true;}
    // Binding comes from this main server's resolved owned config, never a peer
    // advert. An unreadable token cannot erase an existing protected credential.
    if(this.o.mainAuthToken&&config.mainAuthToken!==this.o.mainAuthToken){config.mainAuthToken=this.o.mainAuthToken;bindingChanged=true;}
    if(config.healthPort!==this.o.mainHealthPort){config.healthPort=this.o.mainHealthPort;bindingChanged=true;}
    const slot=prepareRecoveryRuntimeSlot(this.o.entrypoint,config.stateDir);
    if(config.runtimeSlot?.digest!==slot.digest){config.previousRuntimeSlot=config.runtimeSlot;config.runtimeSlot=slot;bindingChanged=true;}
    if(config.watchdog&&config.watchdog.entrypoint!==slot.entrypoint){config.watchdog.entrypoint=slot.entrypoint;bindingChanged=true;}
    if(!config.mainBindings){config.mainBindings=captureRecoveryMainBindings(config);bindingChanged=true;}
    // Refresh only our own fixed transport wrapper after a trusted slot rotation.
    const wrapper=path.join(this.directory,'ssh-wrapper.sh');
    const bindingWriter=new RecoveryAdmission({stateDir:config.stateDir,agentId:config.agentId,machineId:config.machineId,certificationRoot:config.certificationRoot,bootId:await recoveryHostBootId()});
    try{bindingWriter.withOwnedBindingWrite(()=>{
      if(fs.readFileSync(file,'utf8')!==previousConfig)throw new Error('recovery-install-config-changed');
      verifyRecoveryRuntimeSlot(slot,config.stateDir,true);
      bindingWriter.initializeEnrollment();
      if(fs.existsSync(wrapper))this.writeWrapper(config,file);
      if(bindingChanged)write(file,config);
    });}finally{bindingWriter.close();}
    const identity = new MachineSshIdentity(this.directory, this.o.agentId, this.o.machineId).ensure();
    const hostParts = this.o.sshHostPublicKey.trim().split(/\s+/);
    if (hostParts[0] !== 'ssh-ed25519' || !hostParts[1]) throw new Error('recovery-ssh-host-key-required');
    const now = Date.now();
    const advert: RecoveryEnrollmentAdvert = { domain: 'instar-recovery-enrollment-v1', agentId: this.o.agentId, machineId: this.o.machineId,
      generation: identity.clientGeneration, sshPublicKey: crypto.createPublicKey(config.sshPrivateKey).export({type:'spki',format:'pem'}).toString(),
      relayPublicKey: crypto.createPublicKey(config.relayPrivateKey).export({type:'spki',format:'pem'}).toString(), sshClientPublicKey: identity.clientPublicKey,
      ssh: { host: this.o.directHost, port: this.o.sshPort, username: this.o.username, hostFingerprint: crypto.createHash('sha256').update(Buffer.from(hostParts[1], 'base64')).digest('hex') },
      relayUrl: this.o.relayUrl, issuedAt: now, expiresAt: now + 300_000 };
    const admission = new RecoveryAdmission({stateDir: config.stateDir, agentId: config.agentId, machineId: config.machineId, certificationRoot: config.certificationRoot, bootId: await recoveryHostBootId()});
    try { return { advert: signRecovery(advert, this.o.machineSigningKey), challenge: admission.challenge() }; }
    finally { admission.close(); }
  }
  private writeWrapper(config:RecoveryHostConfig,configFile:string):void {
    const slot=config.runtimeSlot;if(!slot)throw new Error('recovery-runtime-slot-required');
    const wrapper=path.join(this.directory,'ssh-wrapper.sh');
    const script=`#!/bin/sh\nexec /usr/bin/env -i HOME=${shellQuote(this.o.agentHome)} USER=${shellQuote(this.o.username)} LOGNAME=${shellQuote(this.o.username)} SSH_ORIGINAL_COMMAND="$SSH_ORIGINAL_COMMAND" PATH=${shellQuote(path.dirname(slot.node)+':/usr/bin:/bin:/usr/sbin:/sbin')} ${shellQuote(slot.node)} ${shellQuote(slot.entrypoint)} ssh ${shellQuote(configFile)}\n`;
    if(fs.existsSync(wrapper)){const st=fs.lstatSync(wrapper);if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o022))throw new Error('recovery-enrollment-storage-invalid');}
    const tmp=wrapper+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,script,{mode:0o700,flag:'wx'});fs.renameSync(tmp,wrapper);
  }
  verifyAdvert(signed: Signed<RecoveryEnrollmentAdvert>): RecoveryEnrollmentAdvert {
    const a = signed?.payload, pair = this.o.paired().find(p => p.machineId === a?.machineId);
    if (!pair || !verifyRecovery(signed, pair.publicKey) || a.domain !== 'instar-recovery-enrollment-v1' || a.agentId !== this.o.agentId || a.machineId === this.o.machineId
      || a.issuedAt > Date.now() + 30_000 || a.expiresAt <= Date.now() || a.expiresAt - a.issuedAt > 300_000
      || !Number.isSafeInteger(a.generation) || a.generation < 1 || !Number.isInteger(a.ssh?.port) || a.ssh.port < 1 || a.ssh.port > 65535
      || !/^[a-f0-9]{64}$/.test(a.ssh.hostFingerprint) || typeof a.ssh.host !== 'string' || a.ssh.host.length<1 || a.ssh.host.length>253 || /[\s/\\]/.test(a.ssh.host)
      || typeof a.ssh.username !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(a.ssh.username)
      || !a.sshClientPublicKey.startsWith('ssh-ed25519 ') || a.sshClientPublicKey.length > 256 || /[\r\n]/.test(a.sshClientPublicKey)) throw new Error('recovery-peer-advert-invalid');
    const url = new URL(a.relayUrl); if (url.protocol !== 'https:') throw new Error('recovery-relay-tls-required');
    if (recoveryKeyFingerprint(a.sshPublicKey) === recoveryKeyFingerprint(a.relayPublicKey)) throw new Error('recovery-key-reused');
    return a;
  }
  /** The root-certified authority admits keys; existing paired-machine signatures bind their SSH inventory. */
  async install(certificate: Signed<RecoveryCertificate>, checkpoint: Signed<RecoveryCheckpoint>, adverts: Signed<RecoveryEnrollmentAdvert>[]): Promise<{ state: 'awaiting-peer-proofs' }> {
    const configFile = path.join(this.directory, 'host.json'), config = loadRecoveryConfig(configFile),previousHost=fs.readFileSync(configFile,'utf8');
    const verified = adverts.map(a => this.verifyAdvert(a));
    if (new Set(verified.map(a => a.machineId)).size !== verified.length) throw new Error('recovery-peer-advert-invalid');
    // Verify the independent checkpoint BEFORE any authorized_keys or supervisor mutation.
    const admission = new RecoveryAdmission({stateDir:config.stateDir,agentId:config.agentId,machineId:config.machineId,certificationRoot:config.certificationRoot,bootId:await recoveryHostBootId()});
    let installationEpoch=0;
    try{admission.withOwnedBindingWrite(()=>{
      admission.initializeEnrollment();installationEpoch=admission.installationEpoch();
      admission.acceptCheckpoint(certificate,checkpoint);
    });}finally{admission.close();}
    const identity = new MachineSshIdentity(this.directory, this.o.agentId, this.o.machineId).ensure();
    if(!checkpoint.payload.disabledRoutes?.includes('ssh')){
      try{(this.o.inspectSshEnvironment??(hostKeyFile=>{qualifyRecoverySshEnvironment({hostKeyFile});}))(identity.hostPrivateKeyPath);}
      catch(error){new PeerAuthorizedKeys(this.o.agentHome,false,'instar-recovery-access').revokeUnknown(this.o.agentId,new Set());throw error;}
    }
    config.sshEnvironmentHostKeyFile=identity.hostPrivateKeyPath;
    const privateKey = fs.readFileSync(identity.clientPrivateKeyPath, 'utf8');
    const peers: RecoveryPeerTarget[] = verified.map(a => {
      const p = checkpoint.payload.principals.find(p => p.machineId === a.machineId), paired = this.o.paired().find(p => p.machineId === a.machineId);
      if (!p || !paired || p.pairingEpoch !== paired.pairingEpoch || p.generation !== a.generation || p.sshPublicKey !== a.sshPublicKey || p.relayPublicKey !== a.relayPublicKey) throw new Error('recovery-peer-grant-mismatch');
      return { agentId: this.o.agentId, sourceMachineId: this.o.machineId, targetMachineId: a.machineId, bootId: '', pairingEpoch: p.pairingEpoch, generation: identity.clientGeneration,
        sshSigningPrivateKey: config.sshPrivateKey, relaySigningPrivateKey: config.relayPrivateKey, targetSshPublicKey: a.sshPublicKey, targetRelayPublicKey: a.relayPublicKey,
        relayUrl: a.relayUrl, ssh: {...a.ssh, privateKey} };
    });
    const finalAdmission=new RecoveryAdmission({stateDir:config.stateDir,agentId:config.agentId,machineId:config.machineId,certificationRoot:config.certificationRoot,bootId:await recoveryHostBootId()});
    try{return await finalAdmission.withServiceInstallation(async()=>{
    if(fs.readFileSync(configFile,'utf8')!==previousHost)throw new Error('recovery-install-config-changed');
    if(finalAdmission.installationEpoch()!==installationEpoch)throw new Error('recovery-installation-stale');
    if(!finalAdmission.lease({allowDeactivated:true}).ready)throw new Error('recovery-checkpoint-required');
    finalAdmission.withCurrentCheckpoint(current=>{if(recoveryDigest(current.payload)!==recoveryDigest(checkpoint.payload))throw new Error('recovery-install-checkpoint-changed');});
    for(const advert of adverts)this.verifyAdvert(advert);
    if(!config.runtimeSlot)throw new Error('recovery-runtime-slot-required');
    verifyRecoveryRuntimeSlot(config.runtimeSlot,config.stateDir,true);
    const wrapper = path.join(this.directory, 'ssh-wrapper.sh');
    this.writeWrapper(config,configFile);
    config.validatedGrantInventory=path.join(this.directory,'validated-grants.json');
    write(config.validatedGrantInventory,verified.map(a=>{
      const p=checkpoint.payload.principals.find(p=>p.machineId===a.machineId)!;
      return {machineId:a.machineId,pairingEpoch:p.pairingEpoch,generation:p.generation,sshSigningPublicKey:a.sshPublicKey,
        relaySigningPublicKey:a.relayPublicKey,sshClientPublicKey:a.sshClientPublicKey,forcedCommand:wrapper};
    }));
    write(configFile,config);
    const grants = new PeerAuthorizedKeys(this.o.agentHome, false, 'instar-recovery-access');
    const legacy = new PeerAuthorizedKeys(this.o.agentHome, false);
    for (const a of verified) {
      legacy.revoke(this.o.agentId,a.machineId);
      if(checkpoint.payload.disabledRoutes?.includes('ssh'))continue;
      const p = checkpoint.payload.principals.find(p => p.machineId === a.machineId)!;
      grants.reconcile({agentId:this.o.agentId,machineId:a.machineId,pairingEpoch:p.pairingEpoch,clientKeyGeneration:p.generation,publicKey:a.sshClientPublicKey,forcedCommand:wrapper});
      // Upgrade never preserves a managed unrestricted grant for the same peer.
    }
    grants.revokeUnknown(this.o.agentId,new Set(checkpoint.payload.disabledRoutes?.includes('ssh')?[]:verified.map(a=>a.machineId)));
    const manifest: RecoveryRuntimeManifest = {version:1,agentId:this.o.agentId,machineId:this.o.machineId,hostConfigFile:configFile,peers};
    write(path.join(this.directory,'runtime.json'),manifest);
    await installRecoveryServices(config,configFile,this.o.entrypoint,{admission:finalAdmission});
    finalAdmission.activateFromCheckpoint(checkpoint.payload.version,installationEpoch);
    return {state:'awaiting-peer-proofs' as const};
    });}finally{finalAdmission.close();}
  }
}
