import fs from 'node:fs';import {RecoveryClient} from '../../dist/recovery/RecoveryClient.js';
const [file,verb,route]=process.argv.slice(2);const config=JSON.parse(fs.readFileSync(file,'utf8'));
const client=new RecoveryClient({...config,sshSigningPrivateKey:JSON.parse(fs.readFileSync(config.sourceRoot+'/ssh.json','utf8')).privateKey,
 relaySigningPrivateKey:JSON.parse(fs.readFileSync(config.sourceRoot+'/relay.json','utf8')).privateKey,
 ssh:{...config.ssh,privateKey:fs.readFileSync(config.sourceRoot+'/client','utf8')}});
const receipt=await client.execute(verb,route,Date.now());console.log(JSON.stringify(receipt));
