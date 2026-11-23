import {afterEach,describe,expect,it,vi} from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import {settlementFixture} from '../fixtures/profile-settlement/composition.js';
const closes:Array<()=>void>=[];
afterEach(()=>{vi.restoreAllMocks();for(const close of closes.splice(0))close();});
async function fixture(){const f=await settlementFixture();closes.push(f.close);return f;}
function post(f:Awaited<ReturnType<typeof fixture>>,binding:Record<string,unknown>={}){
 return request(f.app).post('/topic-profile/propose-batch').set('X-Instar-Request','1').send({confirmIn:1001,
 targets:[{topicId:23,patch:{framework:'codex-cli'}},{topicId:24,patch:{framework:'claude-code'}}],...binding});
}
describe('registered response exact-inbound settlement HTTP',()=>{
 it('records the claimed actual inbound and receipt without clearing older or later inputs',async()=>{
  const f=await fixture();f.accept('402');f.accept('403');f.accept('404');
  const response=await post(f,f.claim('403'));expect(response.status,JSON.stringify(response.body)).toBe(200);
  expect(response.body).toMatchObject({settingsApplied:false,replyAlreadyDelivered:true,replySettlement:{status:'recorded'},
   questionDelivery:{kind:'registered',topicId:1001,messageId:f.sends[0].messageId}});
  const disk=JSON.parse(fs.readFileSync(path.join(f.stateDir,'state/never-silent.json'),'utf8'));
  expect(disk.obligations.find((o:{inboundMessageId:string})=>o.inboundMessageId==='403')).toMatchObject({state:'answered',text:null,registeredReply:{messageId:f.sends[0].messageId}});
  expect(f.monitor.store.openFor('telegram','1001').map(o=>o.inboundMessageId)).toEqual(['402','404']);
  expect(f.sends).toHaveLength(1);expect(f.bundle.store.resolve('23')).toBeNull();expect(f.bundle.store.resolve('24')).toBeNull();
 });
 it.each(['single','batch'] as const)('settles an actual registered %s reminder using the current inbound handle',async(kind)=>{
  const f=await fixture();
  const initial=kind==='batch'?await post(f):await request(f.app).post('/topic-profile/23/propose').set('X-Instar-Request','1').send({framework:'codex-cli',confirmIn:1001});
  expect(initial.status,JSON.stringify(initial.body)).toBe(200);expect(initial.body.replyAlreadyDelivered).toBe(false);
  f.accept('403');f.accept('404');const binding=f.claim('403');
  const route=kind==='batch'?'/topic-profile/propose-batch':'/topic-profile/23/propose';
  const response=await request(f.app).post(route).set('X-Instar-Request','1').send({confirmIn:1001,...binding,
   ...(kind==='batch'?{remindRequestIds:[initial.body.requestId]}:{remindRequestId:initial.body.requestId})});
  expect(response.status,JSON.stringify(response.body)).toBe(200);
  expect(response.body).toMatchObject({requestId:initial.body.requestId,expiresAt:initial.body.expiresAt,reminder:true,
   replyAlreadyDelivered:true,replySettlement:{status:'recorded'},questionDelivery:{kind:'registered',topicId:1001,messageId:f.sends[1].messageId}});
  expect(f.monitor.store.openFor('telegram','1001').map(o=>o.inboundMessageId)).toEqual(['404']);
  expect(f.bundle.confirmSlots.proposals.get('1001',initial.body.requestId)?.receipts).toHaveLength(2);
  expect(f.sends).toHaveLength(2);
 });
 it('does not claim relay fulfillment for an ordinary unbound question',async()=>{
  const f=await fixture();f.accept('403');const response=await post(f);expect(response.status,JSON.stringify(response.body)).toBe(200);
  expect(response.body).toMatchObject({replyAlreadyDelivered:false,replySettlement:{status:'unbound'},questionDelivery:{kind:'registered'}});
  expect(f.monitor.store.openFor('telegram','1001')).toHaveLength(1);
 });
});

describe('registered response settlement boundaries',()=>{
 it.each(['disabled','unwired'] as const)('reports %s bookkeeping without inventing recorded settlement',async(mode)=>{
  const f=await fixture();f.accept('403');
  if(mode==='disabled')f.setMonitoringEnabled(false);else f.bundle.confirmSlots.proposals.setRegisteredReplyHandler(null);
  const response=await post(f,f.claim('403'));expect(response.status,JSON.stringify(response.body)).toBe(200);
  expect(response.body).toMatchObject({replyAlreadyDelivered:true,replySettlement:{status:mode==='disabled'?'not-required':'unavailable'}});
  expect(f.monitor.store.openFor('telegram','1001').map(o=>o.inboundMessageId)).toEqual(['403']);
 });
 it('keeps duplicate genuine delivery callbacks idempotent and rejects a copied proof',async()=>{
  const f=await fixture();f.accept('403');let proof:unknown;
  f.bundle.confirmSlots.proposals.setRegisteredReplyHandler(p=>{proof=p;return f.monitor.observeRegisteredReply(p);});
  const response=await post(f,f.claim('403'));expect(response.status,JSON.stringify(response.body)).toBe(200);
  const filename=path.join(f.stateDir,'state/never-silent.json'),before=fs.readFileSync(filename,'utf8');
  expect(f.monitor.observeRegisteredReply(proof as never)).toBe('recorded');
  expect(f.monitor.observeRegisteredReply({...proof as object} as never)).toBe('unavailable');
  expect(fs.readFileSync(filename,'utf8')).toBe(before);expect(f.sends).toHaveLength(1);
  expect(f.monitor.store.openFor('telegram','1001')).toEqual([]);
 });
 it.each(['source','principal','inbound','forged','replay'] as const)('rejects %s authority without settling any input',async(kind)=>{
  const f=await fixture();f.accept('403');f.accept('404');
  let binding:Record<string,unknown>;
  if(kind==='source')binding=f.claim('403','2002');
  else if(kind==='principal')binding=f.claim('403','1001','telegram:999');
  else if(kind==='inbound')binding={...f.claim('403'),ownerTurnInboundId:'404'};
  else if(kind==='forged')binding={...f.claim('403'),replyAlreadyDelivered:true,replySettlement:{status:'recorded'}};
  else {binding=f.claim('403');expect((await post(f,binding)).status).toBe(200);}
  const response=await post(f,binding);expect(response.status,JSON.stringify(response.body)).toBe(kind==='forged'?400:409);
  expect(response.body.replyAlreadyDelivered).not.toBe(true);
  expect(f.monitor.store.openFor('telegram','1001').map(o=>o.inboundMessageId)).toEqual(kind==='replay'?['404']:['403','404']);
  expect(f.sends).toHaveLength(kind==='replay'?1:0);
 });
 it.each(['unknown','quiet','refused','inactive'] as const)('never settles a %s platform outcome',async(outcome)=>{
  const f=await fixture();f.accept('403');f.setDelivery(outcome);
  const response=await post(f,f.claim('403'));expect(response.status,JSON.stringify(response.body)).toBe(outcome==='inactive'?409:502);
  expect(response.body.replyAlreadyDelivered).not.toBe(true);expect(response.body.questionDelivery).toBeUndefined();
  expect(f.sends).toHaveLength(outcome==='inactive'?1:0);
  expect(f.monitor.store.openFor('telegram','1001').map(o=>o.inboundMessageId)).toEqual(['403']);
 });
 it('keeps repeated failed persistence excluded and retries only after distinct ordinary storage progress',async()=>{
  const f=await fixture();f.accept('403');
  const rename=fs.renameSync.bind(fs);let fail=true,attempts=0;
  vi.spyOn(fs,'renameSync').mockImplementation((from,to)=>{
   if(String(to)===path.join(f.stateDir,'state/never-silent.json')){attempts++;if(fail)throw new Error('fixture disk failure');}
   return rename(from,to);
  });
  const response=await post(f,f.claim('403'));expect(response.status,JSON.stringify(response.body)).toBe(200);
  expect(response.body).toMatchObject({replyAlreadyDelivered:true,replySettlement:{status:'pending'}});
  const afterInitial=attempts;await f.monitor.watcher.tick();await f.monitor.watcher.tick();
  expect(attempts).toBe(afterInitial);expect(f.notices).toEqual([]);
  fail=false;f.accept('404');const afterProgress=attempts;
  fail=true;await f.monitor.watcher.tick();expect(attempts).toBe(afterProgress+1);
  await f.monitor.watcher.tick();expect(attempts).toBe(afterProgress+1);
  fail=false;f.accept('405');await f.monitor.watcher.tick();
  expect(f.monitor.store.openFor('telegram','1001').map(o=>o.inboundMessageId)).toEqual(['404','405']);
  expect(f.sends).toHaveLength(1);
  const disk=JSON.parse(fs.readFileSync(path.join(f.stateDir,'state/never-silent.json'),'utf8'));
  expect(disk.obligations.find((o:{inboundMessageId:string})=>o.inboundMessageId==='403')).toMatchObject({state:'answered',text:null,registeredReply:{messageId:f.sends[0].messageId}});
 });
 it('retains real missing-inbound delivery evidence until same-ID admission without answering a neighbor',async()=>{
  const f=await fixture();const rename=fs.renameSync.bind(fs);let fail=true;
  vi.spyOn(fs,'renameSync').mockImplementation((from,to)=>{
   if(fail&&String(to)===path.join(f.stateDir,'state/never-silent.json'))throw new Error('failed inbound acceptance');return rename(from,to);
  });
  f.accept('403');fail=false;
  const response=await post(f,f.claim('403'));expect(response.status,JSON.stringify(response.body)).toBe(200);
  expect(response.body).toMatchObject({replyAlreadyDelivered:true,replySettlement:{status:'pending'}});
  f.accept('404');f.accept('403');await f.monitor.watcher.tick();
  expect(f.monitor.store.openFor('telegram','1001').map(o=>o.inboundMessageId)).toEqual(['404']);
  const disk=JSON.parse(fs.readFileSync(path.join(f.stateDir,'state/never-silent.json'),'utf8'));
  expect(disk.obligations.find((o:{inboundMessageId:string})=>o.inboundMessageId==='403')).toMatchObject({state:'answered',text:null,registeredReply:{messageId:f.sends[0].messageId}});
  expect(f.sends).toHaveLength(1);expect(f.notices).toEqual([]);
 });
 it('does not carry a failed ordinary release into an unrelated successful acceptance',async()=>{
  const f=await fixture();f.accept('403');
  const rename=fs.renameSync.bind(fs);let fail=true;
  vi.spyOn(fs,'renameSync').mockImplementation((from,to)=>{if(fail&&String(to)===path.join(f.stateDir,'state/never-silent.json'))throw new Error('failed release');return rename(from,to);});
  expect(()=>f.monitor.store.release('telegram','1001','fixture release')).toThrow();fail=false;
  f.accept('404');const response=await post(f,f.claim('403'));expect(response.status,JSON.stringify(response.body)).toBe(200);
  expect(response.body.replySettlement).toEqual({status:'recorded'});
  expect(f.monitor.store.openFor('telegram','1001').map(o=>o.inboundMessageId)).toEqual(['404']);
  const disk=JSON.parse(fs.readFileSync(path.join(f.stateDir,'state/never-silent.json'),'utf8'));
  expect(disk.obligations.find((o:{inboundMessageId:string})=>o.inboundMessageId==='403')).toMatchObject({state:'answered',text:null,registeredReply:{messageId:f.sends[0].messageId}});
 });
});
