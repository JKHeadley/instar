import {expect,it} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {FeatureEvidenceLog} from '../../src/monitoring/FeatureEvidenceLog.js';
import {readJsonlQueries} from '../../src/monitoring/LadderEvidenceReader.js';
import {computeLadderState,parseLadderRegistry,type JsonlLogRef} from '../../src/monitoring/MaturationLadder.js';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';

it('consumes real reviewed recovery evidence without treating disposable receipts as a completed development soak',async()=>{
 const parsed=parseLadderRegistry(fs.readFileSync('src/data/feature-ladders.json','utf8'));if(!parsed.ok)throw Error(parsed.reason);
 const entry=parsed.registry.entries.find(e=>e.id==='multiMachine.serverDownRecovery')!,rung=entry.rungs.fleet!,now=Date.now();
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'recovery-ladder-'));
 try{
  const evidence=new FeatureEvidenceLog({projectDir:directory,machine:'disposable',instarVersion:'test',now:()=>now});
  const queries=rung.metrics.map(metric=>({key:metric.id,ref:metric.ref as JsonlLogRef,sinceMs:now-30*86400000,direction:metric.direction}));
  const matrix=evidence.record(entry.id,{kind:'fired',reason:'two-host-destructive-matrix-passed',context:{report:'disposable-test-report',revision:'test-revision'}})!;
  evidence.record(entry.id,{kind:'outcome',reason:'two-host-destructive-matrix-reviewed',outcome:'right',gradesEventId:matrix});
  const initial=await readJsonlQueries(directory,queries,now);
  expect(initial.get('two-host-matrix')!.value).toBe(1);
  expect(initial.get('development-proof-soak')!.value).toBe(0);
  const soak=evidence.record(entry.id,{kind:'fired',reason:'dev-agent-two-route-48h-soak-passed',context:{report:'separately-reviewed-development-soak'}})!;
  evidence.record(entry.id,{kind:'outcome',reason:'dev-agent-two-route-48h-soak-reviewed',outcome:'right',gradesEventId:soak});
  const readings=await readJsonlQueries(directory,queries,now);
  expect(readings.get('development-proof-soak')!.value).toBe(1);expect(readings.get('development-soak-reviewed')!.value).toBe(1);
  const state=computeLadderState({entry,rung:'dev-agent-live',target:'fleet',readings:rung.metrics.map(metric=>({metric,...readings.get(metric.id)!})),afterMove:[],evaluations:[{dueSlotMs:now,status:'ready',contractHash:'qualified-contract'}],contractHash:'qualified-contract',now,lastMoveAt:null,heldReason:null});
  expect(state.state).toBe('soaking');expect(state.soak.needed).toBe(2);expect(state.soak.days).toBe(0);
 }finally{SafeFsExecutor.safeRmSync(directory,{recursive:true,force:true,operation:'recovery-maturation-ladder.test:cleanup'});}
});
