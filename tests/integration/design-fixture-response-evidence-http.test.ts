import http from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { createFixtureResponseEvidence, RESPONSE_EVIDENCE_HEADER, digest, joinFixtureProbeEvidence } from '../design/harness/fixtureResponseEvidence.mjs';
import { startAccountsHarness } from '../design/harness/accountsServer.js';
const closes:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of closes.splice(0))await close();});
it('records the actual production browser-status response bytes and native header ID privately',async()=>{
 const h=await startAccountsHarness();closes.push(h.close);
 const response=await fetch(`${h.url}/mobile/browser-devices/status`,{headers:{Authorization:`Bearer ${h.bootNonce}`}}),bytes=Buffer.from(await response.arrayBuffer());
 const id=response.headers.get(RESPONSE_EVIDENCE_HEADER)!;
 const record=h.responseEvidenceProvider(id)!;expect(record.finished).toBe(true);expect(record.bytes).toEqual(bytes);expect(record.sha256).toBe(digest(bytes));
 const joined=joinFixtureProbeEvidence(h.responseEvidenceProvider,h.url,{method:'GET',url:response.url,status:response.status,contentType:response.headers.get('content-type'),contentLength:response.headers.get('content-length'),bodyEvidence:{kind:'awaiting-parent-evidence',responseId:id,browserConsumption:'not-observed'}});
 expect(joined.bytes).toEqual(bytes);expect(joined.evidence.browserConsumption).toBe('not-observed');
 expect((await fetch(`${h.url}/subscription-pool`)).headers.has(RESPONSE_EVIDENCE_HEADER)).toBe(false);
 expect((await fetch(`${h.url}/work-board?x=1`)).status).toBe(404);
 expect((await fetch(`${h.url}/work-board`,{method:'POST'})).status).toBe(405);
});
it('preserves real write/end encoding, callbacks and exact final bytes without counting end twice',async()=>{
 const ledger=createFixtureResponseEvidence();let callbacks=0;
 const server=http.createServer((req,res)=>ledger.middleware(req as never,res as never,()=>{
  res.setHeader('Content-Type','application/json');res.write('π','utf8',()=>callbacks++);res.write(Buffer.from([0,255]),()=>callbacks++);res.end('終','utf8',()=>callbacks++);
 }));
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));closes.push(()=>new Promise<void>((done,reject)=>{server.close(error=>error?reject(error):done());server.closeAllConnections();}));
 const address=server.address();if(!address||typeof address==='string')throw Error('No fixture address');const origin=`http://127.0.0.1:${address.port}`;ledger.bindOrigin(origin);
 const response=await fetch(origin+'/work-board'),bytes=Buffer.from(await response.arrayBuffer());
 expect(bytes).toEqual(Buffer.concat([Buffer.from('π'),Buffer.from([0,255]),Buffer.from('終')]));
 const record=ledger.provider(response.headers.get(RESPONSE_EVIDENCE_HEADER)!)!;expect(record.bytes).toEqual(bytes);expect(record.byteLength).toBe(7);expect(callbacks).toBe(3);
});
