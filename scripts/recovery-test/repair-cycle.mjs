// Wait for the separately installed, bounded OWN test watchdog to cause a real
// outage, then run the fixed hold/start/verify/restore sequence from its peer.
import fs from 'node:fs';
import net from 'node:net';
import {RecoveryClient} from '../../dist/recovery/RecoveryClient.js';
const [file,route,expectSshBlocked]=process.argv.slice(2),c=JSON.parse(fs.readFileSync(file,'utf8'));
if(!/^throwaway-recovery-[a-z0-9-]+$/.test(c.agentId)||!c.sourceRoot?.includes('/echo-compute/recovery-10000001794/test-a4-')||!['ssh','relay'].includes(route))throw new Error('disposable-repair-required');
const client=new RecoveryClient({...c,sshSigningPrivateKey:JSON.parse(fs.readFileSync(c.sourceRoot+'/ssh.json','utf8')).privateKey,
 relaySigningPrivateKey:JSON.parse(fs.readFileSync(c.sourceRoot+'/relay.json','utf8')).privateKey,ssh:{...c.ssh,privateKey:fs.readFileSync(c.sourceRoot+'/client','utf8')}});
const log=(stage,result)=>console.log(JSON.stringify({at:Date.now(),source:c.sourceMachineId,target:c.targetMachineId,route,stage,result}));
if(expectSshBlocked==='ssh-blocked'){
 for(const port of [443,c.ssh.port-4000,c.ssh.port]){
  const denied=await new Promise(resolve=>{const s=net.connect({host:c.ssh.host,port});s.setTimeout(1500,()=>{s.destroy();resolve(false);});s.once('connect',()=>{s.destroy();resolve(false);});s.once('error',e=>resolve(e.code==='EPERM'||e.code==='EACCES'));});
  if(!denied)throw new Error('direct-target-egress-not-denied');
 }
 log('all-direct-egress-denied',true);
}
const call=async verb=>{const r=await client.execute(verb,route,Date.now());if(r.result!=='ok')throw new Error('repair-action-refused:'+verb+':'+r.detail.reason);return r;};
let down=false;const triggerBy=Date.now()+10*60000;
while(Date.now()<triggerBy){const r=await call('collect-diagnostics');if(r.detail.serverHealthy===false){log('owned-test-loop-down',r);down=true;break;}await new Promise(resolve=>setTimeout(resolve,1000));}
if(!down)throw new Error('test-watchdog-did-not-trigger');
const held=await call('hold-owned-instar-watchdog');log('watchdog-held',held);
const deadline=Number(held.detail.holdUntil);if(!Number.isSafeInteger(deadline)||deadline<=Date.now())throw new Error('invalid-hold');
log('start',await call('start-instar-server'));
let recovered=false;
while(Date.now()<deadline-2000){
 // The explicit isolation harness uses a loopback CONNECT proxy. This proves
 // bounded authenticated operations through that carrier, not direct socket
 // independence; ordinary unproxied probes qualify readiness separately.
 const e=expectSshBlocked==='ssh-blocked'?await call('status'):await client.probe(route,Date.now());
 log(expectSshBlocked==='ssh-blocked'?'authenticated-status':'signed-status',e);
 const receipt=expectSshBlocked==='ssh-blocked'?e:e.response.payload;
 if(receipt.detail.serverHealthy===true){await new Promise(resolve=>setTimeout(resolve,2000));if((await call('status')).detail.serverHealthy===true){recovered=true;break;}}
 await new Promise(resolve=>setTimeout(resolve,2000));
}
if(!recovered)throw new Error('repair-did-not-settle-within-hold');
log('restored',await call('restore'));log('kill-loop-repair-passed',true);
