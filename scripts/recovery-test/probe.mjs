import fs from 'node:fs';import {RecoveryClient} from '../../dist/recovery/RecoveryClient.js';
const [file,route]=process.argv.slice(2),c=JSON.parse(fs.readFileSync(file,'utf8'));
if(!/^throwaway-recovery-[a-z0-9-]+$/.test(c.agentId)||!['ssh','relay'].includes(route)||!c.sourceRoot?.includes('/echo-compute/recovery-10000001794/test-a4-'))throw new Error('disposable-probe-required');
const client=new RecoveryClient({...c,sshSigningPrivateKey:JSON.parse(fs.readFileSync(c.sourceRoot+'/ssh.json','utf8')).privateKey,
 relaySigningPrivateKey:JSON.parse(fs.readFileSync(c.sourceRoot+'/relay.json','utf8')).privateKey,ssh:{...c.ssh,privateKey:fs.readFileSync(c.sourceRoot+'/client','utf8')}});
const evidence=await client.probe(route,Date.now());console.log(JSON.stringify({evidence,proof:client.proof(evidence)}));
