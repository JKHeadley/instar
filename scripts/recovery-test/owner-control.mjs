// Exercise the real phone-signed control endpoint with an isolated test owner.
import fs from 'node:fs';import crypto from 'node:crypto';
import {canonicalString} from '../../dist/core/MobileDeviceKeys.js';
const [file,origin,machineId,action='inspect',route]=process.argv.slice(2);
const st=fs.lstatSync(file);
if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)||st.uid!==process.getuid?.())throw new Error('test-owner-ownership-invalid');
const c=JSON.parse(fs.readFileSync(file,'utf8')),url=new URL(origin);
if(!/^throwaway-recovery-[a-z0-9-]+$/.test(c.agentId)||url.protocol!=='https:'||!['m5','mini'].includes(machineId)
 ||!['inspect','rearm-repair','revoke-route','regrant-route'].includes(action)||(['revoke-route','regrant-route'].includes(action)&&!['ssh','relay'].includes(route)))throw new Error('disposable-owner-control-required');
const order=BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
function signature(raw){
 const r=raw.subarray(0,32),value=BigInt('0x'+raw.subarray(32).toString('hex')),s=Buffer.from((value>order/2n?order-value:value).toString(16).padStart(64,'0'),'hex');
 const integer=input=>{while(input.length>1&&input[0]===0)input=input.subarray(1);if(input[0]&128)input=Buffer.concat([Buffer.from([0]),input]);return Buffer.concat([Buffer.from([2,input.length]),input]);};
 const body=Buffer.concat([integer(r),integer(s)]);return Buffer.concat([Buffer.from([48,body.length]),body]).toString('base64url');
}
async function send(body){
 const bytes=Buffer.from(JSON.stringify({agentId:c.agentId,machineId,...body})),time=String(Date.now());
 const signed=signature(crypto.sign('sha256',Buffer.from(canonicalString(c.ownerDeviceId,url.host,'POST','/v1/recovery/owner',time,bytes)),{key:c.ownerPrivateKey,dsaEncoding:'ieee-p1363'}));
 const response=await fetch(new URL('/v1/recovery/owner',url),{method:'POST',body:bytes,redirect:'error',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json','x-device-id':c.ownerDeviceId,'x-device-time':time,'x-device-signature':signed}});
 const text=await response.text();if(text.length>32768)throw new Error('test-owner-response-too-large');if(!response.ok)throw new Error('test-owner-control-refused:'+text);return JSON.parse(text);
}
const inspected=await send({action:'inspect'});
if(action==='inspect')console.log(JSON.stringify(inspected));
else{if(!inspected.target)throw new Error('test-target-not-enrolled');console.log(JSON.stringify(await send({action,sequence:inspected.target.ownerSequence+1,...(route?{route}:{} )})));}
