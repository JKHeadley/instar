#!/usr/bin/env node
/** Explicit release-authority operation. Normal builds never certify a signer. */
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {fileURLToPath} from 'node:url';
import {recoveryDigest,signRecovery,verifyRecovery,validRecoveryId} from '../dist/recovery/RecoveryProtocol.js';
const root=fileURLToPath(new URL('../',import.meta.url));
function bounded(file,privateFile=false){const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const st=fs.fstatSync(fd);if(!st.isFile()||st.size>65536||(privateFile&&(st.mode&0o077)))throw Error('recovery-certificate-input-unsafe');return fs.readFileSync(fd,'utf8');}finally{fs.closeSync(fd);}}
try{
 const [requestFile,reviewFile,outputFile]=process.argv.slice(2);if(!requestFile||!reviewFile||!outputFile)throw Error('recovery-certificate-arguments-required');
 const request=JSON.parse(bounded(requestFile)),review=JSON.parse(bounded(reviewFile)),now=Date.now(),p=request.payload;
 if(p?.domain!=='instar-recovery-certificate-request-v1'||!validRecoveryId(p.agentId)||!Number.isSafeInteger(p.generation)||p.generation<1||!Number.isSafeInteger(p.issuedAt)||p.issuedAt>now+30000||now-p.issuedAt>30*86400000||!verifyRecovery(request,p.publicKey))throw Error('recovery-certificate-request-invalid');
 if(review.decision!=='approved'||review.agentId!==p.agentId||review.requestDigest!==recoveryDigest(request)||review.generation!==p.generation||!Number.isSafeInteger(review.expiresAt)||review.expiresAt<=now||review.expiresAt>now+30*86400000)throw Error('recovery-certificate-reviewed-request-required');
 const store=process.env.INSTAR_RECOVERY_RELEASE_HOST_SECRET_DIRECTORY;
 const pem=process.env.INSTAR_RECOVERY_CERTIFICATION_PRIVATE_KEY_PEM||bounded(process.env.INSTAR_RECOVERY_CERTIFICATION_PRIVATE_KEY_PEM_PATH||(store?path.join(store,'recovery-certification-private.pem'):''),true);
 const pinned=bounded(path.join(root,'dist/keys/instar-recovery-certification-root.pem'));
 const key=crypto.createPrivateKey(pem),publicKey=crypto.createPublicKey(key);
 if(key.asymmetricKeyType!=='ed25519'||!publicKey.export({type:'spki',format:'der'}).equals(crypto.createPublicKey(pinned).export({type:'spki',format:'der'})))throw Error('recovery-certificate-release-authority-unavailable');
 const certificate=signRecovery({domain:'instar-recovery-certificate-v1',agentId:p.agentId,publicKey:p.publicKey,generation:p.generation,issuedAt:now,expiresAt:review.expiresAt},pem);
 if(!verifyRecovery(certificate,pinned))throw Error('recovery-certificate-verification-failed');
 fs.writeFileSync(outputFile,JSON.stringify(certificate,null,2)+'\n',{mode:0o644,flag:'wx'});
 console.log('Recovery checkpoint signer certified for the reviewed agent, generation and lifetime. No admission checkpoint was issued.');
}catch(error){console.error(error instanceof Error&&/^recovery-[a-z-]+$/.test(error.message)?error.message:'recovery-certificate-issuance-unavailable');process.exitCode=1;}
