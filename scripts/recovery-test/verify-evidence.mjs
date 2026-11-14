// Offline verification of retained public, disposable two-host proof evidence.
import fs from 'node:fs';import path from 'node:path';
import {verifyRecovery,recoveryDigest} from '../../dist/recovery/RecoveryProtocol.js';
const directory=process.argv[2]??'docs/verification/server-down-recovery-1106';
const inventory=JSON.parse(fs.readFileSync(path.join(directory,'public-keys.json'),'utf8'));let count=0;
for(const file of ['cold-signed-proofs.jsonl','final-socket-bound-proofs.jsonl','recovery-mini-1106-final-source-proofs.jsonl'])for(const line of fs.readFileSync(path.join(directory,file),'utf8').trim().split('\n')){
 const {evidence:e}=JSON.parse(line),r=e.request.payload,s=inventory.machines[r.sourceMachineId],t=inventory.machines[r.targetMachineId],key=r.route+'PublicKey';
 if(r.agentId!==inventory.agentId||!s||!t||!['ssh','relay'].includes(r.route)||!verifyRecovery(e.request,s[key])||!verifyRecovery(e.response,t[key])||!verifyRecovery(e.transport,s[key])
  ||e.response.payload.requestDigest!==recoveryDigest(r)||e.transport.payload.requestDigest!==recoveryDigest(r)||e.response.payload.detail.independentRuntime!==true)throw Error('test-evidence-invalid');
 count++;
}
console.log(JSON.stringify({verifiedHistoricalSignedProofs:count,freshReadiness:false,purpose:inventory.purpose}));
