/** Relay-host commissioning. A release-certified signer is mandatory; this never creates a root. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { recoveryKeyPair, recoveryKeyFingerprint, signRecovery, validRecoveryId, verifyRecovery, type RecoveryCertificate, type Signed } from './RecoveryProtocol.js';
import type { RecoveryAuthorityConfig } from './RecoveryControlPlane.js';

export interface RecoveryAuthorityRequest {
  domain:'instar-recovery-certificate-request-v1'; agentId:string; publicKey:string; generation:number; issuedAt:number;
}
function privateDirectory(dir:string):void {
  const st=fs.lstatSync(dir);
  if(st.isSymbolicLink()||!st.isDirectory()||(typeof process.getuid==='function'&&st.uid!==process.getuid())||(st.mode&0o077))throw new Error('recovery-setup-directory-unsafe');
}
function privateRead(file:string):string {
  const st=fs.lstatSync(file);
  if(st.isSymbolicLink()||!st.isFile()||(typeof process.getuid==='function'&&st.uid!==process.getuid())||(st.mode&0o077)||st.size>262144)throw new Error('recovery-setup-file-unsafe');
  return fs.readFileSync(file,'utf8');
}
export function prepareRecoveryAuthority(input:{directory:string;agentId:string;generation:number;now?:number}): Signed<RecoveryAuthorityRequest> {
  if(!validRecoveryId(input.agentId)||!Number.isSafeInteger(input.generation)||input.generation<1)throw new Error('recovery-setup-request-invalid');
  fs.mkdirSync(input.directory,{mode:0o700,recursive:true});privateDirectory(input.directory);
  const keys=recoveryKeyPair();
  // Exclusive creation prevents accidentally rotating a production authority or losing its key.
  fs.writeFileSync(path.join(input.directory,'checkpoint-private.pem'),keys.privateKey,{mode:0o600,flag:'wx'});
  const request=signRecovery<RecoveryAuthorityRequest>({domain:'instar-recovery-certificate-request-v1',agentId:input.agentId,publicKey:keys.publicKey,generation:input.generation,issuedAt:input.now??Date.now()},keys.privateKey);
  fs.writeFileSync(path.join(input.directory,'certificate-request.json'),JSON.stringify(request,null,2)+'\n',{mode:0o600,flag:'wx'});
  return request;
}
/** Root is supplied by the signed release trust store, separately from the certificate. */
export function activateRecoveryAuthority(input:{directory:string;certificate:Signed<RecoveryCertificate>;certificationRoot:string;relayOrigin:string;now?:number}):{authority:RecoveryAuthorityConfig;enrollmentUrl:string} {
  privateDirectory(input.directory);const now=input.now??Date.now();
  const request=JSON.parse(privateRead(path.join(input.directory,'certificate-request.json'))) as Signed<RecoveryAuthorityRequest>;
  const privateKey=privateRead(path.join(input.directory,'checkpoint-private.pem'));
  const cert=input.certificate.payload;
  if(cert?.domain!=='instar-recovery-certificate-v1'||!verifyRecovery(input.certificate,input.certificationRoot)||cert.agentId!==request.payload.agentId||cert.generation!==request.payload.generation||cert.publicKey!==request.payload.publicKey||cert.issuedAt>now||cert.expiresAt<=now||!verifyRecovery(request,cert.publicKey)||!verifyRecovery(signRecovery({test:true},privateKey),cert.publicKey))throw new Error('recovery-setup-certificate-invalid');
  const origin=new URL(input.relayOrigin);
  if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('recovery-setup-relay-origin-invalid');
  const token=crypto.randomBytes(32).toString('base64url');
  const authority:RecoveryAuthorityConfig={certificate:input.certificate,privateKey,certificationRoot:input.certificationRoot,enrollment:{tokenHash:crypto.createHash('sha256').update(token).digest('hex'),issuedAt:now,expiresAt:now+15*60_000,host:origin.host.toLowerCase()}};
  const enrollmentUrl=origin.origin+'/v1/recovery/phone#'+new URLSearchParams({agent:cert.agentId,token}).toString();
  // Caller installs authority in the relay host's secret manager. Neither output is logged.
  return {authority,enrollmentUrl};
}
/** Validate every provisioned agent against an independently installed root before listening. */
export function validateProductionRecoveryAuthorities(authorities:Record<string,RecoveryAuthorityConfig>,certificationRoots:readonly string[],now=Date.now()):void {
  if(!certificationRoots.length||Object.keys(authorities).length>10000)throw new Error('recovery-setup-release-root-required');
  for(const [agentId,a]of Object.entries(authorities)){
    if(a.owner)throw new Error('recovery-owner-commissioning-required');
    const cert=a.certificate?.payload;
    if(!validRecoveryId(agentId)||cert?.agentId!==agentId||cert.domain!=='instar-recovery-certificate-v1'||!certificationRoots.some(root=>verifyRecovery(a.certificate,root))||cert.issuedAt>now||cert.expiresAt<=now||!Number.isSafeInteger(cert.generation)||cert.generation<1||!verifyRecovery(signRecovery({test:true},a.privateKey),cert.publicKey))throw new Error('recovery-setup-certificate-invalid');
    // Keep the exact verified root available for constructor verification, not a request-supplied root.
    a.certificationRoot=certificationRoots.find(root=>verifyRecovery(a.certificate,root));
    recoveryKeyFingerprint(cert.publicKey);
  }
}

/** Initial dedicated root provisioning runs ONLY on the configured release host.
 * Its public pin must be reviewed and shipped through the normal trusted release
 * channel before any agent accepts certificates. Existing roots never rotate here. */
export function bootstrapRecoveryCertificationRoot(input:{secretDirectory:string;publicPinFile:string}):{publicKey:string} {
  if(!path.isAbsolute(input.secretDirectory)||!path.isAbsolute(input.publicPinFile)||path.basename(input.publicPinFile)!=='instar-recovery-certification-root.pem')throw new Error('recovery-root-bootstrap-path-invalid');
  const privateFile=path.join(input.secretDirectory,'recovery-certification-private.pem');
  if(fs.existsSync(privateFile)||fs.existsSync(input.publicPinFile))throw new Error('recovery-root-already-provisioned');
  fs.mkdirSync(input.secretDirectory,{recursive:true,mode:0o700});privateDirectory(input.secretDirectory);
  const publicDirectory=path.dirname(input.publicPinFile);fs.mkdirSync(publicDirectory,{recursive:true,mode:0o755});
  const parent=fs.lstatSync(publicDirectory);
  if(!parent.isDirectory()||parent.isSymbolicLink()||(typeof process.getuid==='function'&&parent.uid!==process.getuid())||(parent.mode&0o022))throw new Error('recovery-root-publication-directory-unsafe');
  const keys=recoveryKeyPair();
  fs.writeFileSync(privateFile,keys.privateKey,{mode:0o600,flag:'wx'});
  fs.writeFileSync(input.publicPinFile,keys.publicKey,{mode:0o644,flag:'wx'});
  return {publicKey:keys.publicKey};
}
