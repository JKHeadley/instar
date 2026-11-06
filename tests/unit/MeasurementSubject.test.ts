import { describe,expect,it } from 'vitest';
import { measurementSourceRef,validMeasurementBinding, type GenericMeasurementContract } from '../../src/monitoring/MeasurementSubject.js';
import { FeatureMetricsLedger } from '../../src/monitoring/FeatureMetricsLedger.js';
const now=Date.parse('2026-11-06T00:00:00Z');
function contract():GenericMeasurementContract {
 const c:GenericMeasurementContract={subject:{kind:'decision',key:'test-point'},adapter:{kind:'decision-quality',decisionPoint:'test-point',ruleId:'grade-v1',rung:'deterministic-ground-truth',evidenceStrength:'deterministic-proof',windowHours:24,rightRateMetricId:'right-rate',unmatchedShareMetricId:'unmatched'},cadenceHours:6,evidenceMaxAgeHours:12,metrics:[{id:'right-rate',source:'feature-summary',sourceRef:'',direction:'at-least',threshold:.9,minSamples:10},{id:'unmatched',source:'feature-summary',sourceRef:'',direction:'at-most',threshold:.1,minSamples:10}],outcome:{statement:'More correct decisions',method:'Settled canonical winning grades',owner:'Echo',version:'v1',outcomeMetricIds:['right-rate'],qualityMetricIds:['unmatched'],baseline:{origin:'m1',points:[{id:'right-rate',observedAtMs:now,descriptorVersion:1,value:.7,samples:100},{id:'unmatched',observedAtMs:now,descriptorVersion:1,value:.1,samples:111}]}}};
 for(const m of c.metrics)m.sourceRef=measurementSourceRef(c,m.id);return c;
}
describe('generic measurement binding',()=>{
 it('requires distinct outcome and safeguard metrics and exact scoped refs',()=>{
  expect(validMeasurementBinding(contract(),'one')).toBe(true);
  for(const change of [(c:GenericMeasurementContract)=>{c.adapter!.unmatchedShareMetricId='right-rate';},(c:GenericMeasurementContract)=>{c.metrics.pop();},(c:GenericMeasurementContract)=>{c.outcome!.qualityMetricIds=['right-rate'];},(c:GenericMeasurementContract)=>{c.metrics[0].sourceRef='ladder.other-feature';},(c:GenericMeasurementContract)=>{c.metrics[1].direction='at-least';}]){const c=contract();change(c);expect(validMeasurementBinding(c,'one')).toBe(false);}
 });
 it('does not let decision bindings or effort ids drift and does not lend decision grades to jobs',()=>{
  const c=contract();c.subject.key='another-point';expect(validMeasurementBinding(c)).toBe(false);
  c.subject={kind:'job',key:'review'};expect(validMeasurementBinding(c)).toBe(false);
  c.subject={kind:'effort',key:'whole-effort'};for(const m of c.metrics)m.sourceRef=measurementSourceRef(c,m.id);
  expect(validMeasurementBinding(c,'whole-effort')).toBe(true);expect(validMeasurementBinding(c,'other-effort')).toBe(false);
 });
 it('changes refs with method/cohort identity but never with a flattering declared baseline',()=>{
  const c=contract(),old=measurementSourceRef(c,'right-rate');c.outcome!.baseline.points[0].value=999;expect(measurementSourceRef(c,'right-rate')).toBe(old);
  c.adapter!.ruleId='grade-v2';expect(measurementSourceRef(c,'right-rate')).not.toBe(old);c.adapter!.ruleId='grade-v1';c.outcome!.version='v2';expect(measurementSourceRef(c,'right-rate')).not.toBe(old);
 });
});
describe('canonical winning-grade measurement cohort',()=>{
 it('counts incompatible, unknown and ungraded decisions as unmatched rather than silently discarding them',()=>{
  const l=new FeatureMetricsLedger({dbPath:':memory:',now:()=>now});
  try {
   const decision=(id:string,point='test-point',machine:string|null='m1')=>l.recordDecision({correlationId:id,decisionPoint:point,ts:now,feature:'test',verdictClass:'allow',mintedBy:'router',volumeClass:'full',contentClass:'metadata',machineId:machine??undefined,model:'test',framework:'test',promptId:'test'});
   const grade=(id:string,result:'right'|'wrong'|'unknown',ruleId='grade-v1',rung:'self-report'|'deterministic-ground-truth'='deterministic-ground-truth')=>l.upsertOutcome({correlationId:id,gradedBy:rung,ruleId,rung,evidenceStrength:rung==='self-report'?'self-report':'deterministic-proof',grade:result,ts:now});
   for(const id of ['right','wrong','unknown','ungraded','different','stronger'])decision(id);decision('foreign','another-point');
   grade('right','right');grade('wrong','wrong');grade('unknown','unknown');grade('different','right','other-rule');grade('stronger','right','grade-v1','self-report');grade('stronger','wrong');
   const args={decisionPoint:'test-point',ruleId:'grade-v1',rung:'deterministic-ground-truth' as const,evidenceStrength:'deterministic-proof' as const,sinceMs:now-3600000,untilMs:now,machineSegment:'m1'};
   expect(l.decisionMeasurementCohort(args)).toEqual({total:6,right:1,wrong:2,unknownOrUnmatched:3});
   decision('foreign-machine','test-point','m2');grade('foreign-machine','right');decision('unattributed','test-point',null);grade('unattributed','right');
   expect(l.decisionMeasurementCohort({...args,machineSegment:null})).toEqual({total:1,right:1,wrong:0,unknownOrUnmatched:0});
   expect(l.decisionMeasurementCohorts([args,{...args,ruleId:'other-rule'}])).toEqual([{total:7,right:1,wrong:2,unknownOrUnmatched:4},{total:7,right:1,wrong:0,unknownOrUnmatched:6}]);
   expect(l.decisionMeasurementCohort({...args,decisionPoint:'empty'})).toEqual({total:0,right:0,wrong:0,unknownOrUnmatched:0});
   l.close();expect(l.decisionMeasurementCohort(args)).toBeNull();
  } finally {l.close();}
 });
});
