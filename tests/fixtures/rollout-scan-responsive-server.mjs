// Isolated regression server: no bot, production state, or real lease transport.
import http from 'node:http';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { FeatureRolloutReconciler } from '../../dist/core/FeatureRolloutReconciler.js';
import { scanSpecArtifactsWithCanonical, scanSpecArtifactsWithCanonicalAsync } from '../../dist/core/featureRolloutScan.js';
import { LeaseCoordinator } from '../../dist/core/LeaseCoordinator.js';
import { FencedLease } from '../../dist/core/FencedLease.js';

const [repo,mode,profile]=process.argv.slice(2);
const measureTiming=profile==='timing';
const ttlMs=measureTiming?1000:30_000,renewEveryMs=25,healthDeadlineMs=measureTiming?1000:15_000;
const keys=crypto.generateKeyPairSync('ed25519');
const crypt={selfMachineId:'isolated-rollout-test',sign:s=>crypto.sign(null,Buffer.from(s),keys.privateKey).toString('base64'),
  verify:(s,sig)=>crypto.verify(null,Buffer.from(s),keys.publicKey,Buffer.from(sig,'base64'))};
let lease=null,epoch=0;
const store={read:()=>({lease,epoch}),hasNoSharedMedium:()=>false,
  casWrite:c=>{const ok=c.epoch===epoch+1;if(ok){lease=c;epoch=c.epoch;}return{ok,observed:{lease,epoch}};},
  refresh:c=>{if(c.epoch!==epoch)return false;lease=c;return true;}};
const coordinator=new LeaseCoordinator({lease:new FencedLease(crypt,{leaseTtlMs:ttlMs,failoverThresholdMs:60_000}),
  store,presumedDeadHolders:()=>new Set(),monotonicNow:()=>performance.now()});
if(!await coordinator.acquireIfEligible())throw new Error('isolated lease acquisition failed');
const confirmations=[performance.now()];const ownership=[];let renewing=false;
async function renew(){if(renewing)return;renewing=true;try{
  ownership.push(coordinator.holdsLease());
  if(await coordinator.renew() && coordinator.msSinceConfirmedRenewal()<renewEveryMs)confirmations.push(performance.now());
  ownership.push(coordinator.holdsLease());
}finally{renewing=false;}}
const timer=setInterval(()=>void renew(),renewEveryMs);
const records=new Map();const writes=[];const degradations=[];
const tracker={list:()=>[...records.values()],get:id=>records.get(id),
  create:async row=>{writes.push(performance.now());records.set(row.id,{...row,version:1});return records.get(row.id);},
  update:async(id,patch)=>{writes.push(performance.now());records.set(id,{...records.get(id),...patch});return records.get(id);},
  setPhaseStatus:async()=>{}};
const options={canonicalRefScanEnabled:true,canonicalRemote:mode==='fallback'?'missing-fixture-remote':'origin',onDegradation:reason=>degradations.push(reason)};
const reconciler=new FeatureRolloutReconciler({tracker,observeFlag:()=>({}),
  listSpecArtifacts:signal=>mode==='sync'?scanSpecArtifactsWithCanonical(repo,options):scanSpecArtifactsWithCanonicalAsync(repo,options,Date.now,signal)});
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({holdsLease:coordinator.holdsLease()}));});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
process.send?.({type:'ready',port:server.address().port,ttlMs,renewEveryMs,healthDeadlineMs});
let ran=false;
process.on('message',async message=>{
  if(message==='run'&&!ran){ran=true;const started=performance.now();
    try{
      const summary=await reconciler.reconcile();const ended=performance.now();
      await delay(renewEveryMs*2);await renew();
      process.send?.({type:'complete',started,ended,confirmations,ownership,holdsLease:coordinator.holdsLease(),writes,
        ids:[...records.keys()],summary,degradations});
    }catch(error){process.send?.({type:'failure',message:String(error)});}
  }
  if(message==='stop'){
    clearInterval(timer);await reconciler.stop();await new Promise(resolve=>server.close(resolve));
    process.send?.({type:'stopped'},()=>process.exit(0));
  }
});
