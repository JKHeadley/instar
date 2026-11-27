/** Bounded source observation lifecycle for the server's actual flat inventory.
 * This worker never grants graph-read readiness. Only the separate certified
 * source union supplies rows; scheduling counters are not authority proofs.
 */
import {ConversationGraphSourceInventoryCapture,type CapturedGraphSourceOperation} from '../core/ConversationGraphSourceInventory.js';
import {ConversationGraphSourceSweepCapture} from '../core/ConversationGraphSourceSweepCapture.js';
import {sourceSweepCheckpointDue} from '../core/ConversationGraphSourceSweep.js';
import type {MobileConversationRouteDeps} from './mobileConversationRoutes.js';
import type {ConversationRegistry} from '../core/ConversationRegistry.js';
import type {MachineIdentityManager} from '../core/MachineIdentity.js';
import type {GraphMembershipEpoch} from '../core/GraphWitnessTypes.js';
import type {ConversationGraphReplicationRuntime} from './ConversationGraphReplicationRuntime.js';
import type crypto from 'node:crypto';
export interface ConversationGraphSourceInventoryRuntimeOptions {
 flatDeps:MobileConversationRouteDeps;conversations:ConversationRegistry;runtime:ConversationGraphReplicationRuntime;
 identity:MachineIdentityManager;membership():GraphMembershipEpoch;ownerPublicKey:crypto.KeyLike;telegramChatId:string|null;
 pageSize?:number;pagesPerTick?:number;intervalMs?:number;
}
export interface GraphSourceInventoryWorkerStatus {
 running:boolean;stopped:boolean;cursorPending:boolean;lastPassPartial:boolean;
 lastTickAt:string|null;observed:number;pending:number;committed:number;failed:number;
}
export class ConversationGraphSourceInventoryRuntime {
 private readonly capture:ConversationGraphSourceInventoryCapture;
 private readonly sweep:ConversationGraphSourceSweepCapture|null;
 private timer:ReturnType<typeof setInterval>|null=null;
 private inFlight:Promise<GraphSourceInventoryWorkerStatus>|null=null;
 private stopped=false;private cursor:string|null=null;
 private lastCheckpoint:{hash:string;at:number}|null=null;
 private readonly committed=new Map<string,number>();
 private readonly counts={lastTickAt:null as string|null,lastPassPartial:true,observed:0,pending:0,committed:0,failed:0};
 constructor(private readonly options:ConversationGraphSourceInventoryRuntimeOptions){
  this.capture=new ConversationGraphSourceInventoryCapture({agentId:options.membership().agentId,identity:options.identity,ownerPublicKey:options.ownerPublicKey,
   membership:options.membership,flat:options.flatDeps,registry:options.conversations,telegramChatId:options.telegramChatId,localErasure:options.runtime.localErasure,noteLocalActivity:(ref,lastActivity)=>options.runtime.noteLocalActivity?.(ref,lastActivity),acceptedInventory:()=>({source:options.runtime.source,reader:options.runtime.reader,dropped:options.runtime.droppedOriginRegistry})});
  this.sweep=options.runtime.source&&options.runtime.reader&&options.runtime.droppedOriginRegistry?new ConversationGraphSourceSweepCapture({agentId:options.membership().agentId,identity:options.identity,ownerPublicKey:options.ownerPublicKey,membership:options.membership,flat:options.flatDeps,registry:options.conversations,telegramChatId:options.telegramChatId,localErasure:options.runtime.localErasure,source:options.runtime.source,reader:options.runtime.reader,dropped:options.runtime.droppedOriginRegistry}):null;
 }
 start():void {
  if(this.stopped||this.timer)return;
  const interval=Math.max(1000,Math.min(3600000,this.options.intervalMs??60000));
  this.timer=setInterval(()=>{void this.tick();},interval);this.timer.unref();void this.tick();
 }
 status():GraphSourceInventoryWorkerStatus{return {...this.counts,running:!!this.inFlight,stopped:this.stopped,cursorPending:this.cursor!==null};}
 tick():Promise<GraphSourceInventoryWorkerStatus>{
  if(this.inFlight)return this.inFlight;
  if(this.stopped)return Promise.resolve(this.status());
  const work=this.run().then(()=>{if(this.inFlight===work)this.inFlight=null;return this.status();});this.inFlight=work;return work;
 }
 private async run():Promise<GraphSourceInventoryWorkerStatus>{
  this.counts.lastTickAt=new Date().toISOString();this.counts.observed=0;this.counts.pending=0;this.counts.failed=0;this.counts.lastPassPartial=false;
  const pageSize=Math.max(1,Math.min(100,this.options.pageSize??25)),pages=Math.max(1,Math.min(4,this.options.pagesPerTick??2));
  try{
   for(let n=0;n<pages&&!this.stopped;n++){
    const page=this.capture.capturePage(pageSize,this.cursor);this.counts.lastPassPartial ||=page.partial;
    for(const observation of page.observations){if(this.stopped)break;this.counts.observed++;
     if(this.committed.has(observation.capture.sourceId))continue;
     await this.observe(observation);
    }
    if(this.stopped)break;
    const previous=this.cursor;this.cursor=page.nextCursor;
    if(!this.cursor)break;
    if(previous===this.cursor){this.counts.lastPassPartial=true;this.counts.failed++;break;}
   }
   if(!this.cursor&&!this.stopped&&this.sweep){const scan=this.sweep.capture();let acknowledged=true;
    for(const observation of scan.observations){if(this.stopped){acknowledged=false;break;}if(!this.committed.has(observation.capture.sourceId)&&!await this.observe(observation))acknowledged=false;}
    const now=Date.now();
    if(acknowledged&&!this.stopped&&sourceSweepCheckpointDue(this.lastCheckpoint,scan.inventoryHash,now)&&await this.observe(scan.checkpoint))this.lastCheckpoint={hash:scan.inventoryHash,at:now};
   }
  }catch{/* @silent-fallback-ok: worker status exposes failed count and lastPassPartial; this failed scan never publishes completeness. */this.counts.lastPassPartial=true;this.counts.failed++;}
  // A remaining cursor or pending acknowledgments never means complete.
  if(this.cursor||this.counts.pending)this.counts.lastPassPartial=true;
  this.counts.committed=this.committed.size;return this.status();
 }
 private async observe(observation:CapturedGraphSourceOperation):Promise<boolean>{
  try{
   const outcome=await this.options.runtime.observe(observation);
   if(outcome.state==='committed'){
    this.committed.set(observation.capture.sourceId,Date.now());
    while(this.committed.size>4096)this.committed.delete(this.committed.keys().next().value!);return true;
   }else{this.counts.pending++;this.counts.lastPassPartial=true;}
  }catch{/* @silent-fallback-ok: worker status exposes failed observation and partial pass; no committed observation is recorded. */this.counts.failed++;this.counts.lastPassPartial=true;}return false;
 }
 async close():Promise<void>{this.stopped=true;if(this.timer){clearInterval(this.timer);this.timer=null;}await this.inFlight;}
}
