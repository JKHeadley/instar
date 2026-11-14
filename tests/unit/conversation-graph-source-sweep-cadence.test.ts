/** Checkpoint cadence only. Capture and coordinator are mocked; real signing is
 * in the source inventory integration suite. */
import {afterEach,describe,expect,it,vi} from 'vitest';
const capturePage=vi.hoisted(()=>vi.fn());
const captureSweep=vi.hoisted(()=>vi.fn());
vi.mock('../../src/core/ConversationGraphSourceInventory.js',()=>({ConversationGraphSourceInventoryCapture:class{capturePage=capturePage;}}));
vi.mock('../../src/core/ConversationGraphSourceSweepCapture.js',()=>({ConversationGraphSourceSweepCapture:class{capture=captureSweep;}}));
import {ConversationGraphSourceInventoryRuntime} from '../../src/server/ConversationGraphSourceInventoryRuntime.js';
import {GRAPH_SOURCE_SWEEP_HEARTBEAT_MS,GRAPH_SOURCE_SWEEP_STALE_MS} from '../../src/core/ConversationGraphSourceSweep.js';
const workers:ConversationGraphSourceInventoryRuntime[]=[];
afterEach(async()=>{vi.useRealTimers();for(const w of workers.splice(0))await w.close();capturePage.mockReset();captureSweep.mockReset();});
function fixture(state='committed'){
 const observe=vi.fn().mockResolvedValue({state});
 const worker=new ConversationGraphSourceInventoryRuntime({flatDeps:{} as never,conversations:{} as never,runtime:{observe,source:{},reader:{},droppedOriginRegistry:{}} as never,identity:{} as never,membership:()=>({agentId:'echo'}) as never,ownerPublicKey:'fixture',telegramChatId:'-1001'});workers.push(worker);
 capturePage.mockReturnValue({observations:[],nextCursor:null,partial:false});return{worker,observe};
}
const scan=(hash:string)=>({observations:[],inventoryHash:hash,checkpoint:{capture:{sourceId:'sweep-'+hash+Math.random()},encryptedPayload:{}}});
describe('source sweep checkpoint cadence',()=>{
 it('writes nothing new while the inventory is unchanged',async()=>{
  const {worker,observe}=fixture();captureSweep.mockImplementation(()=>scan('same'));
  await worker.tick();await worker.tick();await worker.tick();expect(observe).toHaveBeenCalledTimes(1);
 });
 it('publishes at once when the inventory changes',async()=>{
  const {worker,observe}=fixture();captureSweep.mockImplementationOnce(()=>scan('a')).mockImplementationOnce(()=>scan('b'));
  await worker.tick();await worker.tick();expect(observe).toHaveBeenCalledTimes(2);
 });
 it('republishes an unchanged inventory after the heartbeat, before a reader calls it stale',async()=>{
  expect(GRAPH_SOURCE_SWEEP_STALE_MS).toBeGreaterThan(GRAPH_SOURCE_SWEEP_HEARTBEAT_MS*2);
  vi.useFakeTimers({toFake:['Date']});const {worker,observe}=fixture();captureSweep.mockImplementation(()=>scan('same'));
  await worker.tick();vi.advanceTimersByTime(GRAPH_SOURCE_SWEEP_HEARTBEAT_MS-1);await worker.tick();expect(observe).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);await worker.tick();expect(observe).toHaveBeenCalledTimes(2);
 });
 it('keeps retrying a checkpoint that did not commit',async()=>{
  const {worker,observe}=fixture('saved-pending');captureSweep.mockImplementation(()=>scan('same'));
  await worker.tick();await worker.tick();expect(observe).toHaveBeenCalledTimes(2);
 });
});
