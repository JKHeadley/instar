/** TEST-ONLY bounded synchronous inclusive timings. No arguments, names,
 * stacks, native signals, fs interception, promise replacement or permission
 * caching. Totals overlap when selected methods call each other; not CPU time. */
import {performance} from 'node:perf_hooks';
export interface GraphTimedPrototype {label:string;prototype:object;methods:readonly string[]}
export interface GraphSyncTiming {label:string;method:string;calls:number;throws:number;asyncReturns:number;syncInclusiveMs:number;maxSyncMs:number}
export function startGraphSyncMethodTiming(targets:readonly GraphTimedPrototype[]){
 if(targets.length>16)throw new Error('graph-timing-target-limit');
 const rows:GraphSyncTiming[]=[],restore:Array<()=>void>=[];
 try{
  for(const target of targets){
   if(!/^[A-Za-z0-9_.-]{1,100}$/.test(target.label)||target.methods.length>24)throw new Error('graph-timing-label-limit');
   for(const method of target.methods){
    if(!/^[A-Za-z0-9_]{1,100}$/.test(method))throw new Error('graph-timing-method-invalid');
    const descriptor=Object.getOwnPropertyDescriptor(target.prototype,method);
    if(!descriptor||!('value'in descriptor)||typeof descriptor.value!=='function'||!descriptor.configurable)throw new Error('graph-timing-own-method-required');
    const original=descriptor.value as (...args:unknown[])=>unknown;
    const row:GraphSyncTiming={label:target.label,method,calls:0,throws:0,asyncReturns:0,syncInclusiveMs:0,maxSyncMs:0};rows.push(row);
    const wrapper=function(this:unknown,...args:unknown[]){
     const start=performance.now();row.calls++;
     try{const result=Reflect.apply(original,this,args);if(result instanceof Promise)row.asyncReturns++;return result;}
     catch(error){row.throws++;throw error;}
     finally{const elapsed=performance.now()-start;row.syncInclusiveMs+=elapsed;row.maxSyncMs=Math.max(row.maxSyncMs,elapsed);}
    };
    Object.defineProperty(target.prototype,method,{...descriptor,value:wrapper});
    restore.push(()=>{if(Object.getOwnPropertyDescriptor(target.prototype,method)?.value===wrapper)Object.defineProperty(target.prototype,method,descriptor);});
   }
  }
 }catch(error){for(const undo of restore.reverse())undo();throw error;}
 return{snapshot:()=>({schemaVersion:1,mode:'synchronous-inclusive-overlapping-not-cpu',rows:rows.map(row=>({...row}))}),restore:()=>{for(const undo of restore.splice(0).reverse())undo();}};
}
