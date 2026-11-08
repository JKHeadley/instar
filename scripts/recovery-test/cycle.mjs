// Closed-verb destructive cycle against explicitly disposable identities only.
import fs from 'node:fs';
import net from 'node:net';
import {RecoveryClient} from '../../dist/recovery/RecoveryClient.js';
const [file,route,expectSshBlocked]=process.argv.slice(2),c=JSON.parse(fs.readFileSync(file,'utf8'));
if(!/^throwaway-recovery-[a-z0-9-]+$/.test(c.agentId)||!c.sourceRoot?.includes('/echo-compute/recovery-10000001794/test-a4-')||!['ssh','relay'].includes(route))throw new Error('disposable-cycle-required');
const client=new RecoveryClient({...c,sshSigningPrivateKey:JSON.parse(fs.readFileSync(c.sourceRoot+'/ssh.json','utf8')).privateKey,
 relaySigningPrivateKey:JSON.parse(fs.readFileSync(c.sourceRoot+'/relay.json','utf8')).privateKey,
 ssh:{...c.ssh,privateKey:fs.readFileSync(c.sourceRoot+'/client','utf8')}});
const log=(stage,result)=>console.log(JSON.stringify({at:Date.now(),source:c.sourceMachineId,target:c.targetMachineId,route,stage,result}));
if(expectSshBlocked==='ssh-blocked'){
 for(const port of [443,18797,c.ssh.port]){
  const denied=await new Promise(resolve=>{const s=net.connect({host:c.ssh.host,port});s.setTimeout(1500,()=>{s.destroy();resolve(false);});s.once('connect',()=>{s.destroy();resolve(false);});s.once('error',e=>resolve(e.code==='EPERM'||e.code==='EACCES'));});
  if(!denied)throw new Error('direct-target-egress-not-denied');
 }
 let refused=false;try{await client.execute('status','ssh',Date.now());}catch{refused=true;}
 if(!refused)throw new Error('direct-network-not-blocked');log('direct-network-blocked',true);
}
async function status(){
 if(expectSshBlocked==='ssh-blocked'){const r=await client.execute('status',route,Date.now());log('authenticated-status',r);if(r.result!=='ok')throw new Error('status-refused');return r.detail.serverHealthy;}
 const e=await client.probe(route,Date.now());log('signed-status',e);return e.response.payload.detail.serverHealthy;
}
if(await status()!==true)throw new Error('baseline-main-not-healthy');
const stop=await client.execute('stop-instar-server',route,Date.now());log('stop',stop);if(stop.result!=='ok')throw new Error('stop-refused');
const downBy=Date.now()+20000;let down=false;
while(Date.now()<downBy){if(await status()===false){down=true;break;}await new Promise(r=>setTimeout(r,1000));}
if(!down)throw new Error('main-did-not-stop');
const diag=await client.execute('collect-diagnostics',route,Date.now());log('diagnostics-main-down',diag);if(diag.result!=='ok'||diag.detail.serverHealthy!==false)throw new Error('down-not-proven');
const start=await client.execute('start-instar-server',route,Date.now());log('start',start);if(start.result!=='ok')throw new Error('start-refused');
const healthyBy=Date.now()+90000;let healthy=false;
while(Date.now()<healthyBy){if(await status()===true){healthy=true;break;}await new Promise(r=>setTimeout(r,3000));}
if(!healthy)throw new Error('main-did-not-recover');log('cycle-passed',true);
