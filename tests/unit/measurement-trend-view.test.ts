import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { JSDOM } from 'jsdom';
import { measurementDetail,measurementChart } from '../../dashboard/console/measurement-trend.js';
import { measurementTrend } from '../../src/monitoring/MeasurementTrend.js';
import type { MaturationEvaluationContract } from '../../src/core/InitiativeTracker.js';
import type { MaturationEvaluationRecord,MaturationMetricObservation } from '../../src/monitoring/BlockerLifecycleLedger.js';
const now=Date.parse('2026-11-06T12:00:00Z'),step=6*3600000,hash='a'.repeat(64);
function detail(){
 const contract={cadenceHours:6,evidenceMaxAgeHours:12,metrics:[{id:'quality',source:'feature-summary',sourceRef:'source',direction:'at-least',threshold:5,minSamples:10}]} as MaturationEvaluationContract;
 const rows=[now,now-step].map(at=>({origin:'m1',featureId:'one',rung:'live',dueSlotMs:at,evaluatedAtMs:at,status:'ready',contractHash:hash,passingMetrics:1,totalMetrics:1,minNormalizedMargin:0,newestEvidenceAtMs:at})) as MaturationEvaluationRecord[];
 const observations=[now,now-step].map((at,i)=>({origin:'m1',featureId:'one',metricId:'quality',source:'feature-summary',sourceRef:'source',descriptorVersion:1,observedAtMs:at,value:7-i,samples:10})) as MaturationMetricObservation[];
 return measurementTrend({origin:'m1',subjectId:'one',subjectKnown:true,now,windowDays:7,contract,contractHash:hash,evidence:{state:'missing-contract',metrics:[]},evaluations:{total:2,rows},observations:new Map([['quality',{total:2,rows:observations}]])});
}
describe('numeric measurement display',()=>{
 let dom:JSDOM;beforeEach(()=>{dom=new JSDOM('<!doctype html><body></body>');Object.assign(globalThis,{document:dom.window.document});});afterEach(()=>dom.window.close());
 it('shows missing baseline as unknown instead of calling numeric activity improvement',()=>{
  const node=measurementDetail({schema:'measurement-read/1',state:'available',detail:detail()});
  expect(node.textContent).toContain('raw measurements');expect(node.textContent).toContain('does not by itself prove improvement');expect(node.textContent).toContain('baseline comparison cannot be established');
  expect(node.querySelectorAll('svg circle')).toHaveLength(2);expect(node.querySelector('svg')?.getAttribute('aria-label')).toContain('2 recorded points');
 });
 it('labels exact archived methods and gaps without reconstructing an old policy',()=>{
  const d=detail();d.historicalContractDetails='archived';d.contractVersions={available:true,requested:2,missing:['old'],omitted:[],unreadable:[],rows:[{hash:d.currentContractHash,firstArchivedAtMs:now,lastSeenAtMs:now,contract:{cadenceHours:6,evidenceMaxAgeHours:12,metrics:[{id:'quality',source:'feature-summary',sourceRef:'quality',direction:'at-least',threshold:3,minSamples:10}]}}]};
  const node=measurementDetail({schema:'measurement-read/1',state:'available',detail:d});expect(node.textContent).toContain('Current definition');expect(node.textContent).toContain('Not archived: 1');expect(node.textContent).toContain('Method description not recorded');expect(node.textContent).toContain('at least 3');
 });
 it('renders only declared continuity edges and remains finite at extreme numeric values',()=>{
  const d=detail(),metric=d.metrics[0],series=metric.series[0];series.points[1].joinPrevious=true;
  const node=measurementChart(metric,series,d,null);expect(node.querySelectorAll('line[stroke-width="2"]')).toHaveLength(1);
  series.points[1].joinPrevious=false;expect(measurementChart(metric,series,d,null).querySelectorAll('line[stroke-width="2"]')).toHaveLength(0);
  series.points[0].value=-1e308;series.points[1].value=1e308;
  const extreme=measurementChart(metric,series,d,null);expect(extreme.outerHTML).not.toMatch(/NaN|Infinity/);
 });
 it('keeps descriptor/source mismatches hollow even with an exact evaluation hash',()=>{
  const d=detail(),metric=d.metrics[0],series=metric.series[0];
  series.descriptorVersion=2;
  const proof={descriptorVersion:1};
  const changed=measurementChart(metric,series,d,proof);
  expect([...changed.querySelectorAll('circle')].every(n=>n.getAttribute('fill')==='var(--bg)')).toBe(true);
  series.descriptorVersion=1;series.sourceRef='changed';
  expect([...measurementChart(metric,series,d,proof).querySelectorAll('circle')].every(n=>n.getAttribute('fill')==='var(--bg)')).toBe(true);
 });
 it('keeps markup literal and supplies a question action when a source cannot be read',()=>{
  const d=detail();Object.assign(d.evidence,{statement:'<img src=x onerror=alert(1)>'});
  const node=measurementDetail({schema:'measurement-read/1',state:'available',detail:d});
  expect(node.querySelector('img,script')).toBeNull();expect(node.textContent).toContain('<img');
  expect(measurementDetail({schema:'measurement-read/1',state:'unavailable',detail:null}).querySelector('a')).not.toBeNull();
 });
});
