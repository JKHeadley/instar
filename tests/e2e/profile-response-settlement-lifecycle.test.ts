import {afterEach,describe,expect,it} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type {Server} from 'node:http';
import {settlementFixture} from '../fixtures/profile-settlement/composition.js';
const closes:Array<()=>Promise<void>|void>=[];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
describe('production-composed registered response settlement lifecycle',()=>{
 it('serves a live question with real receipt settlement, stays silent for it and still notices later unanswered work',async()=>{
  const f=await settlementFixture();closes.push(f.close);
  const server=await new Promise<Server>(resolve=>{const s=f.app.listen(0,'127.0.0.1',()=>resolve(s));});
  closes.push(()=>new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();}));
  const address=server.address();expect(address&&typeof address!=='string').toBe(true);
  if(!address||typeof address==='string')throw new Error('fixture failed to listen');
  const url=`http://127.0.0.1:${address.port}`;
  f.accept('403');
  const response=await fetch(`${url}/topic-profile/23/propose`,{method:'POST',headers:{'Content-Type':'application/json','X-Instar-Request':'1'},
   body:JSON.stringify({framework:'codex-cli',confirmIn:1001,...f.claim('403')})});
  expect(response.status).toBe(200);
  const body=await response.json();expect(body).toMatchObject({replyAlreadyDelivered:true,replySettlement:{status:'recorded'},
   questionDelivery:{kind:'registered',topicId:1001,messageId:f.sends[0].messageId},settingsApplied:false});
  expect(f.bundle.confirmSlots.proposals.get('1001',body.requestId)?.receipts).toEqual(expect.arrayContaining([expect.objectContaining({messageId:f.sends[0].messageId})]));
  f.advance();await f.monitor.watcher.tick();expect(f.notices).toEqual([]);
  f.accept('404','Please answer this separate question.');f.advance();await f.monitor.watcher.tick();
  expect(f.notices.length).toBeGreaterThan(0);
  expect(f.monitor.store.openFor('telegram','1001').map(o=>o.inboundMessageId)).toEqual(['404']);
  const disk=JSON.parse(fs.readFileSync(path.join(f.stateDir,'state/never-silent.json'),'utf8'));
  expect(disk.obligations.find((o:{inboundMessageId:string})=>o.inboundMessageId==='403')).toMatchObject({state:'answered',text:null});
  expect(f.sends).toHaveLength(1);
 });
 it('keeps production boot connected to the same private proof verifier and monitor delegate exercised above',()=>{
  const boot=fs.readFileSync('src/commands/server.ts','utf8');
  expect(boot).toMatch(/verifyRegisteredReplyProof\s*:\s*[^\n]*ownsRegisteredReplyProof/);
  expect(boot).toMatch(/setRegisteredReplyHandler\([^;]*observeRegisteredReply/s);
  const requests=fs.readFileSync('src/core/ProfileProposalRequests.ts','utf8');
  expect(requests).toContain('settleRegisteredReply');
 });
});
