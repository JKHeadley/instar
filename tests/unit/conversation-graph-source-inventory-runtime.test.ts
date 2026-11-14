/** Scheduler mechanics only. Capture and coordinator responses are mocked here;
 * this suite provides NO source-authority, certification or readiness evidence.
 * Real signing/registry/all-member coverage is in the source inventory integration.
 */
import {afterEach,describe,expect,it,vi} from 'vitest';
const capturePage=vi.hoisted(()=>vi.fn());
vi.mock('../../src/core/ConversationGraphSourceInventory.js',()=>({ConversationGraphSourceInventoryCapture:class{capturePage=capturePage;}}));
import {ConversationGraphSourceInventoryRuntime} from '../../src/server/ConversationGraphSourceInventoryRuntime.js';
const workers:ConversationGraphSourceInventoryRuntime[]=[];
afterEach(async()=>{for(const w of workers.splice(0))await w.close();capturePage.mockReset();});
function fixture(observe=vi.fn().mockResolvedValue({state:'committed'}),pagesPerTick=1){
 const worker=new ConversationGraphSourceInventoryRuntime({flatDeps:{} as never,conversations:{} as never,runtime:{observe} as never,identity:{} as never,
  membership:()=>({agentId:'echo'}) as never,ownerPublicKey:'fixture',telegramChatId:'-1001',pageSize:1,pagesPerTick});workers.push(worker);return {worker,observe};
}
const observation=(sourceId:string)=>({capture:{sourceId},encryptedPayload:{fixture:true}});
describe('source inventory bounded lifecycle',()=>{
 it('respects page bounds, retries uncommitted observations and never grants read readiness',async()=>{
  const {worker,observe}=fixture(vi.fn().mockResolvedValue({state:'saved-pending'}));
  capturePage.mockReturnValue({observations:[observation('source-a')],nextCursor:'next',partial:false});
  const first=await worker.tick();expect(capturePage).toHaveBeenCalledTimes(1);expect(first).toMatchObject({cursorPending:true,lastPassPartial:true,pending:1,running:false});
  capturePage.mockReturnValue({observations:[observation('source-a')],nextCursor:null,partial:false});
  await worker.tick();expect(observe).toHaveBeenCalledTimes(2);expect(worker.status()).not.toHaveProperty('ready');
 });
 it('memoizes only committed captures in bounded worker memory',async()=>{
  const {worker,observe}=fixture();capturePage.mockReturnValue({observations:[observation('source-a')],nextCursor:null,partial:false});
  await worker.tick();await worker.tick();expect(observe).toHaveBeenCalledTimes(1);expect(worker.status().committed).toBe(1);
 });
 it('singleflights overlapping ticks and drains the current observation on close',async()=>{
  let release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});
  const {worker,observe}=fixture(vi.fn(async()=>{await barrier;return {state:'committed'};}),2);
  capturePage.mockReturnValue({observations:[observation('source-a'),observation('source-b')],nextCursor:'next',partial:false});
  const first=worker.tick();expect(worker.tick()).toBe(first);const closing=worker.close();release();await closing;
  expect(observe).toHaveBeenCalledTimes(1);expect(worker.status()).toMatchObject({stopped:true,running:false});
  await worker.tick();worker.start();expect(capturePage).toHaveBeenCalledTimes(1);
 });
});
