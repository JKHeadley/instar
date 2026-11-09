import {afterEach,describe,it,expect,vi} from 'vitest';
import {JSDOM} from 'jsdom';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {listModel,nodeModel} from '../../dashboard/console/conversations-model.js';
import {pendingModel,writeStatusWords,cancellationKey,sameNodeRef,independentlySaved} from '../../dashboard/console/conversations-model.js';
let dom:JSDOM;
afterEach(()=>{dom?.window.close();vi.unstubAllGlobals();});
const ref={kind:'effort',id:'012fdaec-70de-4324-9ef3-22b616fc83ce'};
const item={wireVersion:2,requestId:'local-request-0001',operationKey:'queued:owner-change:'+ 'a'.repeat(64),state:'recorded-local',custody:{kind:'recorded-here',machine:{machineId:'owned-machine',name:'Sleeping laptop'}},cancelEligible:true,details:'available',localIntent:{v:1,change:{kind:'set-effort-title',effort:ref,baseVersion:1,title:'PRIVATE-NAME'}}};
describe('explicit provisional owned-custody v2 model',()=>{
 it('separates same-machine recording from independent Saved even for a contradictory wire state',()=>{
  expect(writeStatusWords(item)).toContain('Recorded here on Sleeping laptop');expect(writeStatusWords(item)).toContain('Not yet saved independently');
  expect(writeStatusWords({...item,state:'saved-pending'})).not.toContain('Saved independently');
  expect(independentlySaved({...item,state:'committed'})).toBe(false);expect(independentlySaved({state:'committed'})).toBe(false);
  expect(writeStatusWords({...item,state:'saved-pending',custody:{kind:'copied-on-owned-machine',machine:{name:'Studio'}}})).toContain('Saved independently on Studio');
 });
 it('names the machine in charge when it has not joined, instead of waiting silently',()=>{
  const blocked={...item,waitingMachines:[{machineId:'m5',name:'M5'}],blockedBy:{reason:'writer-not-joined',machine:{machineId:'mini',name:'Mac Mini'}}};
  const words=writeStatusWords(blocked);expect(words).toContain('Recorded here on Sleeping laptop');expect(words).toContain('Mac Mini is in charge of your machines right now and has not joined Conversations');expect(words).toContain('(M5)');expect(words).toContain('Not yet saved independently');
  expect(writeStatusWords({...blocked,blockedBy:{reason:'other',machine:{name:'Mac Mini'}}})).not.toContain('Mac Mini');
  expect(writeStatusWords({...blocked,state:'committed'})).toBe('Change committed.');
 });
 it('accepts typed local previews only while details are available and validates cancellation keys',()=>{
  const parsed=pendingModel({items:[item],total:65,nextOffset:64});expect(parsed.ok).toBe(true);expect(parsed.items[0].localIntent.change.title).toBe('PRIVATE-NAME');expect(parsed.nextOffset).toBe(64);
  expect(pendingModel({items:[{...item,details:'quarantined'}],total:1,nextOffset:null}).items[0].localIntent).toBeNull();
  expect(cancellationKey({...item,operationKey:'https://bad.invalid'})).toBeNull();
  expect(pendingModel({items:[{...item,localIntent:{...item.localIntent,change:{...item.localIntent.change,principal:'forged'}}}],total:1,nextOffset:null}).ok).toBe(false);
 });
 it('matches exact typed refs without collapsing numeric/string chat ids or prefix aliases',()=>{
  expect(sameNodeRef(ref,{...ref})).toBe(true);expect(sameNodeRef(ref,{...ref,id:ref.id+'x'})).toBe(false);
  expect(sameNodeRef({kind:'conversation',platform:'telegram',chatId:'1',topicId:42},{kind:'conversation',platform:'telegram',chatId:1,topicId:42})).toBe(false);
 });
 it('preserves multiple opaque unknown identities per subject and never evicts to exceed32',async()=>{
  vi.resetModules();dom=new JSDOM('',{url:'http://localhost/dashboard/console/'});for(const k of ['location','sessionStorage'])vi.stubGlobal(k,(dom.window as any)[k]);
  const {track,ledger,dismiss,forget}=await import('../../dashboard/console/conversation-write-continuity.js');
  track('subject',{body:{requestId:'old-unknown-0001'}});dismiss('subject','old-unknown-0001');track('subject',{body:{requestId:'new-request-0001'},recorded:true});
  expect(ledger()).toHaveLength(2);forget('subject','new-request-0001');expect(ledger()).toMatchObject([{requestId:'old-unknown-0001',dismissed:true}]);
  for(let n=0;n<31;n++)track('other-'+n,{body:{requestId:'other-request-'+n}});
  expect(()=>track('subject',{body:{requestId:'would-overflow-01'}})).toThrow('write-tracking-full');expect(ledger()).toHaveLength(32);
 });
 it('decodes the unchanged actual signed-phone AgentServer capture without promoting its local draft',()=>{
  const bytes=fs.readFileSync(new URL('../fixtures/captured/native-owned-local-wire-capture.json',import.meta.url));
  expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe('b5094b3f9db137011a8038d97d5c132fbed756bf41f7c23ef4783c017b392909');
  const captured=JSON.parse(bytes.toString());expect(captured.runtime).toContain('injected');
  const roots=listModel(captured.roots),node=nodeModel(captured.node),pending=pendingModel(captured.pending);
  expect(roots.ok).toBe(true);expect(node.ok).toBe(true);expect(pending.ok).toBe(true);
  expect(pending.items[0].localIntent.createdEffort.ref).toEqual(captured.recordedLocal.localIntent.createdEffort.ref);
  expect(pending.items[0].subject).toEqual(captured.recordedLocal.localIntent.createdEffort.ref);
  expect(roots.items.some(item=>sameNodeRef(item.ref,pending.items[0].subject))).toBe(false);
  expect(writeStatusWords(captured.recordedLocal)).toContain('Recorded here on Mac Lan');
  expect(cancellationKey(captured.localStatus)).toBe(captured.recordedLocal.operationKey);
 });

});
