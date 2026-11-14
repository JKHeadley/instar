import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { BlockerLifecycleLedger } from '../../src/monitoring/BlockerLifecycleLedger.js';
import { BlockerLifecycleService } from '../../src/monitoring/BlockerLifecycleService.js';
import { measurementContractHash, validArchivedContract, validMeasurementContractVersions } from '../../src/monitoring/MeasurementContractVersion.js';
import { projectMaturationOutcome } from '../../src/monitoring/MaturationOutcome.js';
import type { MaturationEvaluationContract, Initiative } from '../../src/core/InitiativeTracker.js';
import type { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
const day=86400000, start=Date.parse('2026-11-06T00:00:00Z');
const resources:Array<{dir:string;ledger:BlockerLifecycleLedger;db:Database.Database}>=[];
afterEach(()=>{for(const r of resources.splice(0)){r.db.close();r.ledger.close();SafeFsExecutor.safeRmSync(r.dir,{recursive:true,force:true,operation:'MeasurementContractVersion.test'});}});
function fixture(){let now=start;const dir=fs.mkdtempSync(path.join(os.tmpdir(),'contract-version-'));const dbPath=path.join(dir,'x.db');const ledger=new BlockerLifecycleLedger({dbPath,now:()=>now});const db=new Database(dbPath);resources.push({dir,ledger,db});return {ledger,db,advance:(days:number)=>{now=start+days*day;},now:()=>now,dbPath};}
const observation={origin:'m1',featureId:'one',metricId:'quality',source:'feature-summary' as const,sourceRef:'quality',descriptorVersion:1,observedAtMs:start,value:2,samples:10};
const contract: MaturationEvaluationContract={cadenceHours:6,evidenceMaxAgeHours:12,metrics:[{id:'quality',source:'feature-summary',sourceRef:'quality',direction:'at-least',threshold:1,minSamples:10}],outcome:{statement:'Quality outcome',owner:'Echo',method:'Settled grades',version:'v1',outcomeMetricIds:['quality'],qualityMetricIds:['quality'],baseline:{origin:'m1',points:[{id:'quality',observedAtMs:start,descriptorVersion:1,value:2,samples:10}]}}};
const clone=()=>structuredClone(contract);
describe('existing-ledger contract archive',()=>{
 it('retains exact immutable definitions durably and distinguishes missing/corrupt rows',()=>{
  const f=fixture(),hash=measurementContractHash(contract);expect(f.ledger.archiveMaturationContract('m1','one',contract)).toBe(true);
  expect(f.ledger.maturationContractVersions('m1','one',[hash,'b'.repeat(64)])).toMatchObject({available:true,missing:['b'.repeat(64)],rows:[{hash,contract,firstArchivedAtMs:start,lastSeenAtMs:start}]});
  const reopened=new BlockerLifecycleLedger({dbPath:f.dbPath,now:f.now});expect(reopened.maturationContractVersions('m1','one',[hash]).rows[0].contract).toEqual(contract);reopened.close();
  f.db.prepare('UPDATE maturation_contract_versions SET contract_json=?').run('{}');expect(f.ledger.archiveMaturationContract('m1','one',contract)).toBe(false);expect(f.ledger.maturationContractVersions('m1','one',[hash])).toMatchObject({unreadable:[hash],rows:[]});
 });
 it('rejects extra context and oversized definitions without retaining them',()=>{
  expect(validArchivedContract({...contract,context:'private'})).toBe(false);const c=clone();(c.metrics[0] as unknown as Record<string,unknown>).context='private';expect(validArchivedContract(c)).toBe(false);
  const f=fixture();expect(f.ledger.archiveMaturationContract('m1','one',c)).toBe(false);expect(f.db.prepare('SELECT COUNT(*) AS n FROM maturation_contract_versions').get()).toEqual({n:0});
 });
 it('pins only corroborated baselines, keeps active old proof and later ambiguity, then expires inactive archives',()=>{
  const f=fixture();f.ledger.recordMaturationObservation(observation);expect(f.ledger.archiveMaturationContract('m1','one',contract)).toBe(true);
  // A conflicting source arrives after pinning. The entire collision set must survive pruning.
  f.ledger.recordMaturationObservation({...observation,sourceRef:'conflicting',value:100});f.advance(91);f.ledger.archiveMaturationContract('m1','one',contract);f.ledger.prune();
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM maturation_metric_observations').get()).toEqual({n:2});expect(f.ledger.maturationObservation('m1','one','quality',start)).toBeNull();
  f.advance(181);f.ledger.prune();expect(f.db.prepare('SELECT COUNT(*) AS n FROM maturation_metric_observations').get()).toEqual({n:2});
  // Last current sighting was day91, so definition remains until day272.
  expect(f.ledger.maturationContractVersions('m1','one',[measurementContractHash(contract)]).rows).toHaveLength(1);f.advance(272);f.ledger.prune();expect(f.db.prepare('SELECT COUNT(*) AS n FROM maturation_metric_observations').get()).toEqual({n:0});expect(f.ledger.maturationContractVersions('m1','one',[measurementContractHash(contract)]).missing).toHaveLength(1);
 });
 it('refreshes valid original proof beyond ordinary retention without recreating missing observations',()=>{
  const f=fixture();f.ledger.recordMaturationObservation(observation);f.ledger.archiveMaturationContract('m1','one',contract);f.advance(89);f.ledger.archiveMaturationContract('m1','one',contract);f.advance(181);f.ledger.prune();
  expect(f.ledger.maturationObservation('m1','one','quality',start)).toMatchObject({value:2});expect(projectMaturationOutcome(contract,'m1','one',f.now(),(id,at)=>f.ledger.maturationObservation('m1','one',id,at)).metrics[0].baseline.state).toBe('verified');
 });
 it.each(['missing','foreign','future','value','samples','descriptor','undersampled','tied'])('does not pin %s declarations',kind=>{
  const f=fixture(),c=clone();if(kind!=='missing')f.ledger.recordMaturationObservation(observation);
  if(kind==='foreign')c.outcome!.baseline.origin='m2';if(kind==='future')c.outcome!.baseline.points[0].observedAtMs=start+day;if(kind==='value')c.outcome!.baseline.points[0].value=999;
  if(kind==='samples')c.outcome!.baseline.points[0].samples=11;if(kind==='descriptor')c.outcome!.baseline.points[0].descriptorVersion=2;if(kind==='undersampled')c.metrics[0].minSamples=20;
  if(kind==='tied')f.ledger.recordMaturationObservation({...observation,sourceRef:'other'});
  expect(f.ledger.archiveMaturationContract('m1','one',c)).toBe(true);expect(f.db.prepare('SELECT COUNT(*) AS n FROM maturation_baseline_pins').get()).toEqual({n:0});
 });
 it('enforces capacity transactionally while allowing exact versions to refresh',()=>{
  const f=fixture();f.ledger.recordMaturationObservation(observation);expect(f.ledger.archiveMaturationContract('m1','one',contract)).toBe(true);
  f.db.prepare('UPDATE maturation_archive_usage SET rows=8192').run();const c=clone();c.outcome!.version='v2';expect(f.ledger.archiveMaturationContract('m1','one',c)).toBe(false);expect(f.ledger.archiveMaturationContract('m1','one',contract)).toBe(true);
  f.db.prepare('UPDATE maturation_archive_usage SET rows=1,bytes=67108864').run();expect(f.ledger.archiveMaturationContract('m1','one',c)).toBe(false);
 });
 it('bounds version reads and validates exact requested identities at the peer boundary',()=>{
  const f=fixture(),hashes:string[]=[];
  for(let n=0;n<100;n++){const c=clone();c.outcome!.version=`v${n}`;c.outcome!.statement='x'.repeat(500);c.outcome!.method='y'.repeat(500);expect(f.ledger.archiveMaturationContract('m1','one',c)).toBe(true);hashes.push(measurementContractHash(c));}
  const read=f.ledger.maturationContractVersions('m1','one',hashes);expect(read.rows.length).toBeLessThan(100);expect(read.rows.length+read.omitted.length).toBe(100);expect(validMeasurementContractVersions(read,hashes,f.now())).toBe(true);
  expect(validMeasurementContractVersions({...read,missing:[hashes[0]]},hashes,f.now())).toBe(false);
  const corrupt=structuredClone(read);corrupt.rows[0].contract.metrics[0].threshold=999;expect(validMeasurementContractVersions(corrupt,hashes,f.now())).toBe(false);
  expect(validMeasurementContractVersions({...read,context:'private'},hashes,f.now())).toBe(false);
 });
 it('enforces per-subject capacity without stopping refresh or unrelated subjects',()=>{
  const f=fixture();for(let n=0;n<256;n++){const c=clone();c.outcome!.version=`v${n}`;expect(f.ledger.archiveMaturationContract('m1','one',c)).toBe(true);}
  const c=clone();c.outcome!.version='new';expect(f.ledger.archiveMaturationContract('m1','one',c)).toBe(false);expect(f.ledger.archiveMaturationContract('m1','two',c)).toBe(true);
 });
 it('does not free capacity while bounded pin cleanup leaves references behind',()=>{
  const f=fixture();const c=clone();c.metrics=Array.from({length:16},(_,i)=>({...contract.metrics[0],id:`q${i}`}));c.outcome!.outcomeMetricIds=['q0'];c.outcome!.qualityMetricIds=['q1'];c.outcome!.baseline.points=c.metrics.map(m=>({id:m.id,observedAtMs:start,descriptorVersion:1,value:2,samples:10}));
  for(const m of c.metrics)f.ledger.recordMaturationObservation({...observation,metricId:m.id});
  for(let n=0;n<100;n++){c.outcome!.version=`v${n}`;expect(f.ledger.archiveMaturationContract('m1','one',c)).toBe(true);}
  f.advance(181);f.ledger.prune();expect((f.db.prepare('SELECT COUNT(*) AS n FROM maturation_baseline_pins').get() as {n:number}).n).toBe(600);
  expect(f.db.prepare(`SELECT COUNT(*) AS n FROM maturation_baseline_pins p LEFT JOIN maturation_contract_versions v USING(origin,feature_id,contract_hash) WHERE v.contract_hash IS NULL`).get()).toEqual({n:0});
  f.ledger.prune();expect(f.db.prepare('SELECT COUNT(*) AS n FROM maturation_contract_versions').get()).toEqual({n:0});expect(f.db.prepare('SELECT rows,bytes FROM maturation_archive_usage').get()).toEqual({rows:0,bytes:0});
 });
 it('holds an already-ready same slot after archive failure without interrupting ordinary ledger writes',()=>{
  const f=fixture();const events=Object.assign(new EventEmitter(),{getAll:()=>[],update:async()=>true,getBlockerEpisodeDropBuckets:()=>({})});const svc=new BlockerLifecycleService(events as unknown as CommitmentTracker,f.ledger,'m1',f.now);
  f.ledger.recordMaturationObservation(observation);const i={id:'one',rollout:{stage:'live',maturationEvaluation:contract}} as unknown as Initiative;
  svc.evaluateMaturation([i]);expect(svc.maturationEvaluationRows(0)[0].status).toBe('ready');
  f.db.exec("CREATE TRIGGER reject_archive BEFORE INSERT ON maturation_contract_versions BEGIN SELECT RAISE(ABORT,'test rejection'); END; CREATE TRIGGER reject_retraction BEFORE UPDATE ON maturation_evaluations BEGIN SELECT RAISE(ABORT,'test retraction rejection'); END;");
  svc.evaluateMaturation([i]);expect(f.ledger.maturationEvaluations('m1',0)[0].status).toBe('ready');expect(svc.maturationEvaluationRows(0)[0].status).toBe('insufficient-evidence');expect(svc.maturationTrendForContract('one',contract,90)!.evaluations.rows[0].status).toBe('insufficient-evidence');
  expect(svc.localSummary(168)).toMatchObject({maturation:{features:[{featureId:'one',status:'insufficient-evidence'}]}});
  f.db.exec('DROP TRIGGER reject_retraction');svc.evaluateMaturation([i]);expect(svc.maturationEvaluationRows(0)[0].status).toBe('insufficient-evidence');expect(f.ledger.maturationEvaluations('m1',0)[0].status).toBe('insufficient-evidence');
  expect(f.ledger.recordMaturationObservation({...observation,featureId:'ordinary'})).toBe(true);svc.close();
 });
});
