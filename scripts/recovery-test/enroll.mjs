// Disposable authority only. All principal inventories are public; signing keys remain private here.
import fs from 'node:fs';import crypto from 'node:crypto';import https from 'node:https';
import {canonicalString} from '../../dist/core/MobileDeviceKeys.js';
const [controllerFile,caFile,origin,...publicFiles]=process.argv.slice(2);
if(!controllerFile||!caFile||publicFiles.length!==2)throw new Error('test-enrollment-input-required');
const st=fs.lstatSync(controllerFile);
if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)||st.uid!==process.getuid?.())throw new Error('test-controller-ownership-invalid');
const ctl=JSON.parse(fs.readFileSync(controllerFile,'utf8'));
if(!/^throwaway-recovery-[a-z0-9-]+$/.test(ctl.agentId))throw new Error('disposable-authority-required');
const url=new URL(origin);if(url.protocol!=='https:')throw new Error('test-relay-tls-required');
const publicHosts=publicFiles.map(file=>JSON.parse(fs.readFileSync(file,'utf8')));
if(publicHosts[0].machineId===publicHosts[1].machineId)throw new Error('two-distinct-targets-required');
const n=BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
function der(raw){const r=raw.subarray(0,32),s0=BigInt('0x'+raw.subarray(32).toString('hex')),s=Buffer.from((s0>n/2n?n-s0:s0).toString(16).padStart(64,'0'),'hex');const int=b=>{while(b.length>1&&b[0]===0)b=b.subarray(1);if(b[0]&128)b=Buffer.concat([Buffer.from([0]),b]);return Buffer.concat([Buffer.from([2,b.length]),b]);};const b=Buffer.concat([int(r),int(s)]);return Buffer.concat([Buffer.from([48,b.length]),b]).toString('base64url');}
for(const target of publicHosts){
 const source=publicHosts.find(p=>p.machineId!==target.machineId);
 const body=JSON.stringify({action:'grant',agentId:ctl.agentId,machineId:target.machineId,publicKey:target.relayPublicKey,sequence:1,principals:[{machineId:source.machineId,pairingEpoch:1,generation:1,sshPublicKey:source.sshPublicKey,relayPublicKey:source.relayPublicKey}]});
 const time=String(Date.now()),deviceId=ctl.ownerDeviceId;
 if(typeof deviceId!=='string')throw new Error('test-owner-device-required');
 const sig=der(crypto.sign('sha256',Buffer.from(canonicalString(deviceId,url.host,'POST','/v1/recovery/owner',time,Buffer.from(body))),{key:ctl.ownerPrivateKey,dsaEncoding:'ieee-p1363'}));
 const response=await new Promise((resolve,reject)=>{const req=https.request(new URL('/v1/recovery/owner',url),{method:'POST',ca:fs.readFileSync(caFile),timeout:5000,headers:{'Content-Type':'application/json','x-device-id':deviceId,'x-device-time':time,'x-device-signature':sig}},res=>{let out='';res.on('data',d=>{out+=d;if(out.length>32768)req.destroy(new Error('test-response-too-large'));});res.on('end',()=>resolve({status:res.statusCode,body:out}));});req.on('timeout',()=>req.destroy(new Error('test-enroll-timeout')));req.on('error',reject);req.end(body);});
 if(response.status!==200)throw new Error('test-owner-enrollment-refused');console.log(JSON.stringify({target:target.machineId,...JSON.parse(response.body)}));
}
