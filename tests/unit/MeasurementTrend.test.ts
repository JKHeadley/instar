import { describe, expect, it } from 'vitest';
import { projectMaturationOutcome } from '../../src/monitoring/MaturationOutcome.js';
import { measurementTrend, comparableMeasurementEdge } from '../../src/monitoring/MeasurementTrend.js';
import type { MaturationEvaluationContract } from '../../src/core/InitiativeTracker.js';
import type { MaturationEvaluationRecord, MaturationMetricObservation } from '../../src/monitoring/BlockerLifecycleLedger.js';
const now=Date.parse('2026-11-06T12:00:00Z'), step=6*3600000, hash='a'.repeat(64);
const contract: MaturationEvaluationContract={cadenceHours:6,evidenceMaxAgeHours:12,metrics:[{id:'q',source:'feature-summary',sourceRef:'quality',direction:'at-least',threshold:5,minSamples:10}],outcome:{statement:'Checked quality',owner:'Echo',method:'Recorded outcomes',version:'v1',outcomeMetricIds:['q'],qualityMetricIds:['q'],baseline:{origin:'m1',points:[{id:'q',observedAtMs:now-step,descriptorVersion:1,value:5,samples:10}]}}};
const observation=(at:number, over={})=>({origin:'m1',featureId:'one',metricId:'q',source:'feature-summary',sourceRef:'quality',observedAtMs:at,value:5,samples:10,descriptorVersion:1,...over}) as MaturationMetricObservation;
const evaluation=(at:number,over={})=>({origin:'m1',featureId:'one',dueSlotMs:at,evaluatedAtMs:at,rung:'live',contractHash:hash,status:'ready',passingMetrics:1,totalMetrics:1,minNormalizedMargin:0,newestEvidenceAtMs:at,...over}) as MaturationEvaluationRecord;
function detail(obs=[observation(now),observation(now-step)], evals=[evaluation(now),evaluation(now-step)]) {
 return measurementTrend({origin:'m1',subjectId:'one',subjectKnown:true,now,windowDays:7,contract,contractHash:hash,evidence:projectMaturationOutcome(contract,'m1','one',now,(_id,at)=>obs.find(o=>at===undefined||o.observedAtMs===at)??null),evaluations:{total:evals.length,rows:evals},observations:new Map([['q',{total:obs.length,rows:obs}]])});
}
describe('recorded numeric trend identity',()=>{
 it('connects only exact capture/evaluation joins under current cadence',()=>{const d=detail();const m=d.metrics[0],s=m.series[0];expect(comparableMeasurementEdge(s.points[0],s.points[1],s,m,d,m.series.flatMap(s=>s.points))).toBe(true);});
 it('uses isolated dots for unknown/ambiguous evaluation identities and old contracts',()=>{
  for(const evals of [[],[evaluation(now),evaluation(now-step,{contractHash:'b'.repeat(64)})],[evaluation(now),evaluation(now-step),evaluation(now-step,{contractHash:'b'.repeat(64)})]]){
   const d=detail(undefined,evals),m=d.metrics[0],s=m.series[0];expect(comparableMeasurementEdge(s.points[0],s.points[1],s,m,d,m.series.flatMap(s=>s.points))).toBe(false);
  }
 });
 it('breaks at missing cadence, changed rung, inadequate samples and future evidence',()=>{
  for(const d of [detail([observation(now),observation(now-2*step)],[evaluation(now),evaluation(now-2*step)]),detail(undefined,[evaluation(now),evaluation(now-step,{rung:'fleet'})]),detail([observation(now,{samples:1}),observation(now-step)]),detail([observation(now+step),observation(now)],[evaluation(now+step),evaluation(now)])]){
   const m=d.metrics[0],s=m.series[0];expect(comparableMeasurementEdge(s.points[0],s.points[1],s,m,d,m.series.flatMap(s=>s.points))).toBe(false);
  }
 });
 it('keeps changed source/descriptor histories separate rather than joining their values',()=>{
  const d=detail([observation(now),observation(now-step,{descriptorVersion:2}),observation(now-2*step,{sourceRef:'previous'})]);expect(d.metrics[0].series).toHaveLength(3);
 });
 it('keeps totals and read failures distinct from zero and discloses exact omissions',()=>{
  const d=measurementTrend({origin:'m1',subjectId:'one',subjectKnown:false,now,windowDays:90,contract,contractHash:hash,evidence:{state:'missing-contract',metrics:[]},evaluations:null,observations:new Map([['q',{total:500,rows:[observation(now)]}]])});
  expect(d.metrics[0]).toMatchObject({total:500,omitted:499,historyAvailable:true});expect(d.evaluations).toMatchObject({available:false,total:null,omitted:null});
 });
});

describe('numeric history pool boundary',()=>{
 it('preserves exact identity and refuses invented connections, tags, origins or private extra fields',async()=>{
  const {validMeasurementTrend}=await import('../../src/monitoring/MeasurementTrend.js');
  const d=detail();expect(validMeasurementTrend(d,'m1','one',now)).toBe(true);
  expect(validMeasurementTrend(d,'other','one',now)).toBe(false);
  const old=detail(undefined,[]);old.metrics[0].series[0].points[1].joinPrevious=true;
  expect(validMeasurementTrend(old,'m1','one',now)).toBe(false);
  const extra={...d,contextFull:'private context'};
  expect(validMeasurementTrend(extra,'m1','one',now)).toBe(false);
  const hidden=structuredClone(d);hidden.metrics[0].series[0].points[1].evaluation!.contractHash='b'.repeat(64);
  expect(validMeasurementTrend(hidden,'m1','one',now)).toBe(false);
 });
});

describe('history bounds and ambiguous observations',()=>{
 it('does not attach an evaluation identity when several sources share a metric capture time',()=>{
  const d=detail([observation(now),observation(now,{sourceRef:'other'})],[evaluation(now)]);
  expect(d.metrics[0].series).toHaveLength(2);
  expect(d.metrics[0].series.flatMap(s=>s.points).every(p=>p.evaluation===null&&!p.joinPrevious)).toBe(true);
 });
 it('shares the byte budget fairly and counts all omitted history without changing stored totals',()=>{
  const metrics=Array.from({length:16},(_,i)=>({...contract.metrics[0],id:`metric-${i}`}));
  const c={...contract,metrics};
  const observations=new Map(metrics.map(m=>[m.id,{total:5000,rows:Array.from({length:96},(_,i)=>observation(now-i*step,{metricId:m.id,sourceRef:(`source-${i}-`).padEnd(128,'x'),descriptorVersion:i+1}))}]));
  const d=measurementTrend({origin:'m1',subjectId:'one',subjectKnown:true,now,windowDays:90,contract:c,contractHash:hash,evidence:{state:'missing-contract',metrics:[]},evaluations:{total:128,rows:Array.from({length:128},(_,i)=>evaluation(now-i*step))},observations});
  expect(Buffer.byteLength(JSON.stringify(d))).toBeLessThan(128*1024);
  expect(d.metrics.every(m=>m.series.length>0)).toBe(true);
  for(const m of d.metrics)expect(m.omitted+m.series.reduce((n,s)=>n+s.points.length,0)).toBe(5000);
 });
});

describe('continuity across full metric history',()=>{
 it('never connects a changed descriptor, or a reverted source across an intervening capture',async()=>{
  const {validMeasurementTrend}=await import('../../src/monitoring/MeasurementTrend.js');
  const changed=detail([observation(now,{descriptorVersion:2}),observation(now-step,{descriptorVersion:2})]);
  expect(changed.metrics[0].series[0].points.every(p=>!p.joinPrevious)).toBe(true);
  const reverted=detail([observation(now),observation(now-step/2,{descriptorVersion:2}),observation(now-step)]);
  const first=reverted.metrics[0].series.find(s=>s.descriptorVersion===1)!;
  expect(first.points[1].joinPrevious).toBe(false);
  first.points[1].joinPrevious=true;
  expect(validMeasurementTrend(reverted,'m1','one',now)).toBe(false);
 });
 it('returns a newest contiguous suffix after a large tagged point exhausts the shared byte budget',()=>{
  const metrics=Array.from({length:16},(_,i)=>({...contract.metrics[0],id:`metric-${i}`}));
  const c={...contract,outcome:undefined,metrics};
  const observations=new Map(metrics.map(m=>[m.id,{total:96,rows:Array.from({length:96},(_,i)=>observation(now-i*step+(i%2?1:0),{metricId:m.id,sourceRef:i%2?'small':(`long-${i}`).padEnd(128,'x'),descriptorVersion:i+1}))}]));
  const d=measurementTrend({origin:'m1',subjectId:'one',subjectKnown:true,now,windowDays:90,contract:c,contractHash:hash,evidence:{state:'missing-contract',metrics:[]},evaluations:{total:128,rows:Array.from({length:128},(_,i)=>evaluation(now-i*step))},observations});
  expect(d.metrics.some(m=>m.omitted!>0)).toBe(true);
  for(const metric of d.metrics){const actual=metric.series.flatMap(s=>s.points).map(p=>p.at).sort((a,b)=>b-a);expect(actual).toEqual(observations.get(metric.id)!.rows.slice(0,actual.length).map(p=>p.observedAtMs));}
 });
});
