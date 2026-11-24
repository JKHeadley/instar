import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createFixtureResponseEvidence, joinFixtureProbeEvidence, isDeclaredHeaderProbe, RESPONSE_EVIDENCE_HEADER } from '../design/harness/fixtureResponseEvidence.mjs';
const origin = 'http://127.0.0.1:41515';
function record(ledger: ReturnType<typeof createFixtureResponseEvidence>, path = '/work-board', status = 200, finish = true) {
 const headers = new Map<string,string>();
 const res = Object.assign(new EventEmitter(), { statusCode: status,
  setHeader: (key:string,value:string) => { headers.set(key.toLowerCase(),String(value)); },
  getHeader: (key:string) => headers.get(key.toLowerCase()),
  write: () => false,
  end: () => res,
 });
 ledger.middleware({ method: 'GET', originalUrl: path }, res, () => {});
 res.setHeader('Content-Type','application/json'); expect(res.write(Buffer.from('first'))).toBe(false); res.end('last');
 if(finish)res.emit('finish');
 const id=headers.get(RESPONSE_EVIDENCE_HEADER)!;
 return { method:'GET',url:origin+path,status,contentType:'application/json',bodyEvidence:{kind:'awaiting-parent-evidence',responseId:id,browserConsumption:'not-observed'} };
}
describe('actual fixture emitted response evidence',()=>{
 it('joins the exact completed response ID and raw write/end bytes without asserting browser consumption',()=>{
  const ledger=createFixtureResponseEvidence();ledger.bindOrigin(origin);const row=record(ledger);
  const joined=joinFixtureProbeEvidence(ledger.provider,origin,row);
  expect(joined.bytes.toString()).toBe('firstlast');expect(joined.evidence).toMatchObject({kind:'fixture-emitted',browserConsumption:'not-observed',bytes:9});
 });
 it.each(['unknown','wrong-id','wrong-origin','wrong-path','wrong-method','wrong-status','unfinished','wrong-provider','unbranded'])( 'refuses %s evidence',kind=>{
  const ledger=createFixtureResponseEvidence();ledger.bindOrigin(origin);let row=record(ledger,'/work-board',200,kind!=='unfinished');let provider=ledger.provider;
  if(kind==='unknown')row.bodyEvidence.responseId='unknown';
  if(kind==='wrong-id')row.bodyEvidence.responseId=record(ledger,'/mobile/browser-devices/status').bodyEvidence.responseId;
  if(kind==='wrong-origin')row.url='http://127.0.0.1:41516/work-board';
  if(kind==='wrong-path')row.url=origin+'/work-board?query=1';
  if(kind==='wrong-method')row.method='POST';
  if(kind==='wrong-status')row.status=503;
  if(kind==='wrong-provider'){const other=createFixtureResponseEvidence();other.bindOrigin(origin);provider=other.provider;}
  if(kind==='unbranded')provider=()=>({});
  expect(()=>joinFixtureProbeEvidence(provider,origin,row)).toThrow();
 });
 it('never permits emitted evidence for a queried probe, mutable request or other body',()=>{
  for(const [method,url]of[['GET',origin+'/work-board?x=1'],['POST',origin+'/work-board'],['GET',origin+'/subscription-pool'],['GET',origin+'/dashboard/console/console.js']])expect(isDeclaredHeaderProbe(method,url,origin)).toBe(false);
 });
});
