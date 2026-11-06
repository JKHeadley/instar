#!/usr/bin/env node
/** Copy only the reviewed public recovery root; builds never generate roots. */
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {fileURLToPath}from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),source=path.join(root,'src/scaffold/keys/instar-recovery-certification-root.pem');
if(fs.existsSync(source)){
 const st=fs.lstatSync(source);if(!st.isFile()||st.isSymbolicLink()||st.size>4096)throw new Error('recovery-release-pin-invalid');
 const pem=fs.readFileSync(source,'utf8');if(!pem.startsWith('-----BEGIN PUBLIC KEY-----'))throw new Error('recovery-release-pin-invalid');const key=crypto.createPublicKey(pem);if(key.asymmetricKeyType!=='ed25519')throw new Error('recovery-release-pin-invalid');
 const target=path.join(root,'dist/keys/instar-recovery-certification-root.pem');fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,pem,{mode:0o644});fs.writeFileSync(path.join(path.dirname(target),'instar-recovery-certification-roots.json'),JSON.stringify([pem])+'\n',{mode:0o644});
}else console.log('Recovery certification root not provisioned; recovery setup remains incomplete.');
