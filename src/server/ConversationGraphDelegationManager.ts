/** Publication stores the initialization promise synchronously. Request paths
 * await the same attempt; no first-owner launch is silently uncaptured. */
import type {ConversationGraphReplicationRuntime} from './ConversationGraphReplicationRuntime.js';
import type {ConversationGraphDelegationRuntime} from './ConversationGraphDelegationRuntime.js';
import type {ConversationGraphDelegationRemoteRuntime} from './ConversationGraphDelegationRemoteRuntime.js';
export type SoloTopicCustodyReader = (topicId: string) => { machineId: string; ownerEpoch: number } | undefined;
export type ConversationGraphDelegationAvailability={status:'ready';local:ConversationGraphDelegationRuntime;remote:ConversationGraphDelegationRemoteRuntime|null;readSoloTopicCustody?:SoloTopicCustodyReader}|{status:'held';reason:string};
export type ConversationGraphDelegationGetter=()=>Promise<ConversationGraphDelegationAvailability>;
export type ConversationGraphDelegationFactory=(runtime:ConversationGraphReplicationRuntime)=>Promise<ConversationGraphDelegationAvailability>;
export class ConversationGraphDelegationManager {
 private readonly attempts=new Map<ConversationGraphReplicationRuntime,Promise<ConversationGraphDelegationAvailability>>();
 private current:Promise<ConversationGraphDelegationAvailability>|null=null;private closed=false;
 private factory:ConversationGraphDelegationFactory|null=null;private resolveFactory!:(factory:ConversationGraphDelegationFactory|null)=>void;
 private readonly factoryReady=new Promise<ConversationGraphDelegationFactory|null>(resolve=>{this.resolveFactory=resolve;});
 private readonly live=new Set<Extract<ConversationGraphDelegationAvailability,{status:'ready'}>>();
 constructor(private readonly onReady?:(value:Extract<ConversationGraphDelegationAvailability,{status:'ready'}>)=>void,private readonly onInvalidated?:()=>void){}
 setFactory(factory:ConversationGraphDelegationFactory):void{if(this.factory||this.closed)throw new Error('graph-delegation-factory-already-set');this.factory=factory;this.resolveFactory(factory);}
 publish(runtime:ConversationGraphReplicationRuntime):void{
  if(this.closed)return;const prior=this.attempts.get(runtime);if(prior){return;}
  const superseded = [...this.live];
  this.live.clear();
  this.onInvalidated?.();
  for (const value of superseded) { value.local.close(); value.remote?.close(); }
  let attempt:Promise<ConversationGraphDelegationAvailability>;
  attempt=Promise.resolve().then(async()=>{
   const factory=await this.factoryReady;if(!factory||this.closed)return{status:'held',reason:'graph-delegation-closed'} as const;
   let value:ConversationGraphDelegationAvailability;try{value=await factory(runtime);}catch{return{status:'held',reason:'graph-delegation-prerequisite-unavailable'} as const;}
   if(value.status==='ready'){
    if(this.closed||this.current!==attempt){value.local.close();value.remote?.close();return{status:'held',reason:'graph-delegation-runtime-superseded'} as const;}
    this.live.add(value);value.local.start();value.remote?.start();this.onReady?.(value);
   }return value;
  });
  this.attempts.set(runtime,attempt);this.current=attempt;
 }
 readonly get:ConversationGraphDelegationGetter=()=>this.closed?Promise.resolve({status:'held',reason:'graph-delegation-closed'}):this.current??Promise.resolve({status:'held',reason:'graph-runtime-not-published'});
 /** Published authority only. Superseded or closed runtimes cannot supply custody. */
 readSoloTopicCustody(topicId: string): ReturnType<SoloTopicCustodyReader> {
  if (this.closed) return;
  for (const value of this.live) {
   return value.readSoloTopicCustody?.(topicId);
  }
 }
 async close():Promise<void>{if(this.closed)return;this.closed=true;this.onInvalidated?.();this.resolveFactory(null);for(const value of this.live){value.local.close();value.remote?.close();}this.live.clear();await Promise.allSettled(this.attempts.values());}
}
