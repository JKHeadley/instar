/**
 * Keeps one inventory worker on the graph runtime in use. A removal replaces the
 * runtime while the server keeps running and the old one accepts nothing, so a
 * worker left behind would leave the history warning on until the next restart.
 */
export interface GraphSourceInventoryWorker {start():void;close():Promise<void>;}
export class GraphSourceInventoryBinding<Runtime extends object,Worker extends GraphSourceInventoryWorker> {
 private runtime:Runtime|null=null;private worker:Worker|null=null;private opening:Promise<void>|null=null;private stopped=false;
 /** The old worker finishes before its replacement starts, so two never write together. */
 use(runtime:Runtime,create:(runtime:Runtime)=>Promise<Worker>,onFailure:(error:unknown)=>void):void{
  if(this.stopped||this.runtime===runtime)return;
  this.runtime=runtime;const superseded=this.worker,earlier=this.opening;this.worker=null;
  const started:Promise<void>=(async()=>{
   await earlier;await superseded?.close();
   if(this.stopped||this.runtime!==runtime)return;
   const worker=await create(runtime);
   if(this.stopped||this.runtime!==runtime){await worker.close();return;}
   this.worker=worker;worker.start();
  })().catch(error=>{/* @silent-fallback-ok: onFailure reports it; coverage stays partial and no certified rows are inferred */onFailure(error);}).finally(()=>{if(this.opening===started)this.opening=null;});
  this.opening=started;
 }
 async close():Promise<void>{this.stopped=true;await this.opening;await this.worker?.close();this.worker=null;}
}
