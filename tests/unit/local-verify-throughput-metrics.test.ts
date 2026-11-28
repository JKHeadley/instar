// safe-fs-allow: test file — SafeFsExecutor owns temporary cleanup.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { ThroughputMetrics } from '../../src/localVerify/throughputMetrics.js';
import { validateRecord, type LocalVerifyRecord } from '../../src/localVerify/record.js';
import { measureInventoryCoverage, type LaneRunInput } from '../../src/localVerify/laneReport.js';
import { computeInventory } from '../../src/localVerify/inventory.js';
import { throughputReport } from '../../scripts/local-verify-throughput-report.mjs';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'throughput-metrics-test' }); });
const k = { repo: 'JKHeadley/instar', pr: 1, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), baseRefName: 'main' };
function setup() {
 const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvmetrics-'))); dirs.push(dir);
 const file = path.join(dir, 'state/local-verify/throughput-metrics.json'); let time = 1000;
 const signals: unknown[] = []; const store = () => new ThroughputMetrics(file, () => time, (e) => signals.push(e));
 return { dir, file, signals, store, at: (n: number) => { time = n; }, rows: () => JSON.parse(fs.readFileSync(file, 'utf8')).rows };
}
function record(over: Partial<LocalVerifyRecord> = {}): LocalVerifyRecord {
 return { ...k, mergeTree: 'c'.repeat(40), lanes: [], nodeVersion: 'v24', machineId: 'm1', startedAt: new Date(2000).toISOString(), finishedAt: new Date(3000).toISOString(), outcome: 'failure', harnessChanging: false, protectedPath: false, skipsAdded: false, testsRemoved: false, verifierVersion: 'v1', policyHash: 'p1', ...over };
}
describe('Local Verify throughput observations', () => {
 it('does not call equal-file coverage complete when a lane was stopped early or cut short', () => {
  const inventory = computeInventory(['tests/unit/a.test.ts']);
  const run: LaneRunInput = { lane:'unit', report:{files:new Map([['tests/unit/a.test.ts',{passed:1,failed:0,skipped:0,todo:0}]])}, seconds:1 };
  expect(measureInventoryCoverage(inventory,[run]).complete).toBe(true);
  expect(measureInventoryCoverage(inventory,[{...run,stoppedEarly:true}]).complete).toBe(false);
  expect(measureInventoryCoverage(inventory,[{...run,cutShort:true}]).complete).toBe(false);
 });

 it('retains first observation over refusal, retry and restart; separates exact successor/base keys', () => {
  const x=setup(); let s=x.store(); s.observe(k,'requestedAt'); x.at(2000); s.observe(k,'requestedAt'); s.observe(k,'admittedAt');
  s=x.store(); x.at(3000); s.observe(k,'dispatchedAt'); s.observe({...k, headSha:'d'.repeat(40)},'requestedAt'); s.observe({...k, baseSha:'e'.repeat(40)},'requestedAt');
  const rows=x.rows(); expect(rows).toHaveLength(3); expect(rows.find((r: typeof k)=>r.headSha===k.headSha&&r.baseSha===k.baseSha)).toMatchObject({firstObservedPublishedHeadAt:1000,requestedAt:1000,admittedAt:2000,dispatchedAt:3000});
 });
 it('does not invent publication observation for a restored verdict, and deduplicates replay', () => {
  const x=setup(),s=x.store(); x.at(4000); s.verdict(record(),'run'); s.verdict(record(),'run');
  expect(x.rows()[0].firstObservedPublishedHeadAt).toBeUndefined(); expect(x.rows()[0].verdicts).toHaveLength(1); expect(x.rows()[0].verdicts[0].inventory).toBe('unknown');
 });
 it('retains only bounded metadata and fails open on corrupt or unwritable store, including broken audit callback', () => {
  const x=setup(); fs.mkdirSync(path.dirname(x.file),{recursive:true});fs.writeFileSync(x.file,'broken');
  expect(()=>x.store().observe(k,'requestedAt')).not.toThrow();expect(x.signals).toHaveLength(1);expect(fs.readFileSync(x.file,'utf8')).toBe('broken');
  expect(()=>new ThroughputMetrics(path.join(x.file,'impossible'),()=>1000,()=>{throw new Error('audit');}).observe(k,'requestedAt')).not.toThrow();
 });
 it('labels an observation without a retained verdict as unresolved, not proven live waiting', async () => {
  const x=setup();const s=x.store();s.observe(k,'requestedAt');
  const report=await throughputReport(x.dir,1,5000);
  expect(report).not.toHaveProperty('censoredWaiting');
  expect(report.unresolvedObservations).toEqual([expect.objectContaining({...k,elapsedSinceFirstObservationMs:4000,lastObservedAt:1000})]);
  expect(report.unresolvedObservations[0]).not.toHaveProperty('observedWaitAtLeastMs');
  expect(report.limitations).toContain('NOT a live queue');
 });
 it('counts a remote result by coordinator journal verdict time, not the child clock', async () => {
  const x = setup();fs.mkdirSync(path.dirname(x.file),{recursive:true});
  const r = record({finishedAt:new Date(1).toISOString(),startedAt:new Date(0).toISOString(),outcome:'success'});
  fs.writeFileSync(path.join(path.dirname(x.file),'journal.jsonl'),JSON.stringify({writtenAt:new Date(5_000_000).toISOString(),record:r})+'\n');
  const report = await throughputReport(x.dir,1,5_001_000);
  expect(report.completeGreenHeadVerdicts).toBe(1);expect(report.legacyFinishTimeFallbacks).toBe(0);
 });
 it('records complete and incomplete coverage independently of success and reports honest lower-bound latency', async()=>{
  const x=setup(),s=x.store();s.observe(k,'requestedAt');x.at(4000);
  const a=record({inventoryCoverage:{expectedFiles:3,reportedFiles:3,complete:true}});s.verdict(a,'run');
  const b=record({headSha:'d'.repeat(40),inventoryCoverage:{expectedFiles:3,reportedFiles:1,complete:false}});s.verdict(b,'run');
  fs.writeFileSync(path.join(path.dirname(x.file),'journal.jsonl'),[a,b].map(record=>JSON.stringify({record})).join('\n'));
  const report=await throughputReport(x.dir,1,5000);expect(report.completeInventoryVerdicts).toBe(1);expect(report.incompleteInventories).toBe(1);expect(report.completeGreenHeadVerdicts).toBe(0);
  expect(report.exactPublicationTimeAvailable).toBe(false);expect(report.observedHeadToVerdictLowerBound).toMatchObject({samples:1,medianMs:3000});expect(validateRecord(a).ok).toBe(true);
  // An optional observation must never invalidate an otherwise legitimate verdict.
  expect(validateRecord(record({inventoryCoverage:{expectedFiles:3,reportedFiles:1,complete:true}})).ok).toBe(true);
 });
});
