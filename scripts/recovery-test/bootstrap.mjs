// Run only on a shared-compute test host; all writes stay below the supplied throwaway root.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';
import {isIP} from 'node:net';
import {recoveryKeyPair} from '../../dist/recovery/RecoveryProtocol.js';
import {recoveryServiceId} from '../../dist/recovery/RecoveryInstallation.js';
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const root=path.resolve(input.root),repo=path.resolve('.');
const listenAddress=input.listenAddress??'127.0.0.1';if(!isIP(listenAddress))throw new Error('test-listen-address-invalid');
if(!root.includes('/echo-compute/recovery-10000001794/'))throw new Error('test-root-refused');
if(['config.json','host','client','ssh.json','relay.json'].some(name=>fs.existsSync(path.join(root,name))))throw new Error('new-test-identity-required');
fs.mkdirSync(root,{recursive:true,mode:0o700});
for(const d of ['home','state','agent'])fs.mkdirSync(path.join(root,d),{recursive:true,mode:0o700});
const keys={ssh:recoveryKeyPair(),relay:recoveryKeyPair()};
for(const [name,key]of Object.entries(keys))fs.writeFileSync(path.join(root,name+'.json'),JSON.stringify(key),{mode:0o600});
for(const name of ['host','client'])execFileSync('/usr/bin/ssh-keygen',['-q','-t','ed25519','-N','','-f',path.join(root,name)]);
const id=recoveryServiceId(input.agentId,input.machineId),serviceLabel=`com.instar.recovery-target.${id}`;
const config={version:1,agentId:input.agentId,machineId:input.machineId,stateDir:path.join(root,'state'),certificationRoot:input.certificationRoot,
 sshPrivateKey:keys.ssh.privateKey,relayPrivateKey:keys.relay.privateKey,relayUrl:input.relayUrl,serviceLabel,healthPort:input.healthPort};
const configFile=path.join(root,'config.json');fs.writeFileSync(configFile,JSON.stringify(config),{mode:0o600});
fs.writeFileSync(path.join(root,'relay-ca.pem'),input.relayCa,{mode:0o600});
const node=process.execPath,entry=path.join(repo,'scripts/recovery-entrypoint.mjs');
const shellQuote=s=>"'"+s.replaceAll("'","'\\''")+"'";
fs.writeFileSync(path.join(root,'ssh-wrapper.sh'),`#!/bin/sh\nexport NODE_EXTRA_CA_CERTS=${shellQuote(path.join(root,'relay-ca.pem'))}\nexec ${shellQuote(node)} ${shellQuote(entry)} ssh ${shellQuote(configFile)}\n`,{mode:0o700});
const sshConfig=[`Port ${input.sshPort}`,`ListenAddress ${listenAddress}`,`HostKey ${root}/host`,`PidFile ${root}/sshd.pid`,`AuthorizedKeysFile ${root}/authorized_keys`,'PasswordAuthentication no','KbdInteractiveAuthentication no','UsePAM no','StrictModes yes','PermitUserEnvironment no','AllowTcpForwarding no','PermitTunnel no','X11Forwarding no','PermitTTY no','MaxAuthTries 2'].join('\n')+'\n';
fs.writeFileSync(path.join(root,'sshd_config'),sshConfig,{mode:0o600});
const raw=Buffer.from(fs.readFileSync(path.join(root,'host.pub'),'utf8').split(' ')[1],'base64');
console.log(JSON.stringify({machineId:input.machineId,root,configFile,serviceLabel,username:process.env.USER,hostFingerprint:crypto.createHash('sha256').update(raw).digest('hex'),clientPublicKey:fs.readFileSync(path.join(root,'client.pub'),'utf8').trim(),sshPublicKey:keys.ssh.publicKey,relayPublicKey:keys.relay.publicKey}));
