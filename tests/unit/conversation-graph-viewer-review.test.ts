/** Independent review: actual signed phone admission followed by a durable
 * ledger-only revocation while the registry update has not happened. */
import {describe,it,expect} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import type {Request,Response} from 'express';
import {MobilePairingService,deviceAuthenticator} from '../../src/server/mobilePairingRoutes.js';
import {MobileDeviceKeyLedger} from '../../src/core/MobileDeviceKeyLedger.js';
import {canonicalString} from '../../src/core/MobileDeviceKeys.js';
import {signerKeyHashOf,type MachineSigner} from '../../src/core/AppRecordSignatures.js';
import {generateSigningKeyPair,sign} from '../../src/core/MachineIdentity.js';
import {createConversationGraphViewerResolver} from '../../src/server/conversationGraphViewer.js';
import {makeDevice} from '../helpers/mobileDevice.js';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
describe('independent graph viewer revocation review',()=>{
 it('stops post-admission owner authority on the ledger row alone',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'graph-viewer-review-')),keys=generateSigningKeyPair(),keyHash=signerKeyHashOf(keys.publicKey);
  const signer:MachineSigner={machineId:()=> 'review-machine',signerKeyHash:()=>keyHash,sign:p=>({machineId:'review-machine',signerKeyHash:keyHash,sig:sign(p,keys.privateKey)})};
  const pairing=new MobilePairingService({config:{projectName:'echo',developmentAgent:true,mobilePairing:{multiRoute:{enabled:false}}} as never,stateDir:dir,holdsLease:()=>true});
  try{const ledger=new MobileDeviceKeyLedger({stateDir:dir,signer,keyLookup:(machine,hash)=>machine==='review-machine'&&hash===keyHash?{status:'ok',publicKeyPem:keys.publicKey}:{status:'unknown'}});pairing.keyLedger=ledger;
   const phone=makeDevice(),created=pairing.devices.createPending({deviceName:'Review phone',label:null,publicKey:phone.publicKey,host:'review.example.dev'});if(!created.ok)throw new Error('pairing-refused');pairing.devices.applyConfirm(created.device.id,{ok:true});
   const route='/mobile/conversation-graph/erasures/review-erasure-id',time=String(Date.now()),signature=phone.sign(canonicalString(created.device.id,'review.example.dev','GET',route,time,undefined));
   const req={headers:{'x-instar-device':created.device.id,'x-instar-device-time':time,'x-instar-device-sig':signature},method:'GET',path:route,originalUrl:route} as unknown as Request;
   const res={status(){return this;},json(){return this;}} as unknown as Response;expect(deviceAuthenticator(pairing)(req,res)).toBe('ok');
   const resolve=createConversationGraphViewerResolver({agentId:'echo',pairing,verifyDashboardOwner:()=>false});
   expect(resolve(req,'mobile')).toBeNull(); // Signed identity alone cannot enable a disabled native surface.
   pairing.nativeOn=true;const before=resolve(req,'mobile');expect(before).not.toBeNull();
   ledger.recordRevocation(pairing.devices.get(created.device.id)!,new Date().toISOString());expect(pairing.devices.get(created.device.id)!.status).toBe('active');
   expect(resolve(req,'mobile')).toBeNull();expect(before?.mayView({kind:'effort',id:'012fdaec-70de-4324-9ef3-22b616fc83ce'})).toBe(false);
  }finally{pairing.stop();SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'graph-viewer-independent-review-cleanup'});}
 });
});
