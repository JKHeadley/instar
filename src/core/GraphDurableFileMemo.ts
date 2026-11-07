import fs from 'node:fs';
/** Files and directories this process already flushed. A repeat flush of unchanged
 * content adds no durability and blocks the main thread. Any change to identity,
 * size or modified time makes it flush again; a restart starts empty. */
const MEMO_LIMIT=65536;
const durable=new Map<string,string>();
/** Take this BEFORE the flush, so a write racing the flush can never be remembered as flushed. */
export function durableStamp(file:string):string|null{
 try{const s=fs.lstatSync(file,{bigint:true});return s.isFile()||s.isDirectory()?[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':'):null;}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
}
export function isDurablyUnchanged(file:string):boolean{const known=durable.get(file);return known!==undefined&&known===durableStamp(file);}
export function rememberDurable(file:string,stamp:string|null):void{
 durable.delete(file);if(stamp===null)return;durable.set(file,stamp);
 if(durable.size>MEMO_LIMIT)durable.delete(durable.keys().next().value!);
}
/** Flush an open descriptor of `file` unless this process already flushed these exact contents.
 * `force` is for a path that just wrote or linked something: two changes inside one timestamp
 * tick can leave the stamp identical, so a publish must never trust it. */
export function flushDescriptorOnce(file:string,descriptor:number,force=false):void{
 if(!force&&isDurablyUnchanged(file))return;
 // Stamp the descriptor being flushed, not the path: if the path was replaced after open, the next check sees a different file and flushes it.
 const opened=fs.fstatSync(descriptor,{bigint:true}),stamp=[opened.dev,opened.ino,opened.size,opened.mtimeNs,opened.ctimeNs].join(':');rememberDurable(file,null);fs.fsyncSync(descriptor);rememberDurable(file,stamp); // Forgotten first: a failed flush must leave nothing a same-tick retry could trust.
}
