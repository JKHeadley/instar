/** Process-local, weak, negative-only cleanup of independently parsed custody
 * views. This inventory grants no permission, receipt, or durable custody. */
import {realpathSync} from 'node:fs';
import path from 'node:path';
import {canonicalHash,type GraphErasureIdentity} from './GraphWitnessTypes.js';
const LIMIT=80000;
interface Row {target:string;objects:Set<WeakRef<object>>;wrappers:Array<{object:WeakRef<object>;field:string}>;overflow:boolean}
const roots=new Map<string,Set<Row>>();
function canonicalRoot(directory:string):string{try{return realpathSync(directory);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;return path.join(realpathSync(path.dirname(directory)),path.basename(directory));}}
function count(rows:Set<Row>):number{let result=0;for(const row of rows)result+=row.objects.size+row.wrappers.length;return result;}
function clear(root:string,row:Row):boolean{
 let ok=!row.overflow;
 const known=new WeakSet<object>();for(const reference of row.objects){const value=reference.deref();if(value)known.add(value);}
 const discover=(object:object,depth:number):void=>{if(depth>80){row.overflow=true;ok=false;return;}for(const descriptor of Reflect.ownKeys(object).map(key=>Object.getOwnPropertyDescriptor(object,key)!)){if(!('value'in descriptor)){row.overflow=true;ok=false;continue;}const child=descriptor.value;if(child&&typeof child==='object'&&!known.has(child)){if(count(roots.get(root)??new Set())>=LIMIT){row.overflow=true;ok=false;continue;}known.add(child);row.objects.add(new WeakRef(child));discover(child,depth+1);}}};
 for(const wrapper of row.wrappers){const object=wrapper.object.deref();if(!object)continue;try{const descriptor=Object.getOwnPropertyDescriptor(object,wrapper.field);if(descriptor&&!('value'in descriptor)){row.overflow=true;ok=false;}else if(descriptor?.value&&typeof descriptor.value==='object'&&!known.has(descriptor.value)){if(count(roots.get(root)??new Set())>=LIMIT){row.overflow=true;ok=false;}else{known.add(descriptor.value);row.objects.add(new WeakRef(descriptor.value));discover(descriptor.value,0);}}else if(descriptor?.value!==null&&descriptor?.value!==undefined&&typeof descriptor.value!=='object'){row.overflow=true;ok=false;}}catch{row.overflow=true;ok=false;}}
 for(const reference of row.objects){const object=reference.deref();if(object)try{discover(object,0);}catch{row.overflow=true;ok=false;}}
 // Each descendant was registered before exposure; detached aliases remain
 // weakly attributable even when a mutable parent drops its last link.
 for(const reference of [...row.objects]){const object=reference.deref();if(!object){row.objects.delete(reference);continue;}try{for(const [key,descriptor] of Reflect.ownKeys(object).map(key=>[key,Object.getOwnPropertyDescriptor(object,key)!] as const)){if(key==='length'&&Array.isArray(object))continue;if(!('value'in descriptor)||!Reflect.deleteProperty(object,key))ok=false;}if(Array.isArray(object)&&Object.getOwnPropertyDescriptor(object,'length')?.writable)Reflect.set(object,'length',0);if(Reflect.ownKeys(object).some(key=>!(key==='length'&&Array.isArray(object)&&object.length===0)))ok=false;}catch{ok=false;}}
 for(const wrapper of row.wrappers){const object=wrapper.object.deref();if(!object)continue;try{const descriptor=Object.getOwnPropertyDescriptor(object,wrapper.field);if(descriptor&&'value'in descriptor&&descriptor.writable)Reflect.set(object,wrapper.field,null);}catch{ok=false;}}
 // Do not discard failed weak descendants: a frozen child can outlive its
 // cleared parent. Debt persists until it is actually cleared or collected.
 return ok;
}
export function retainGraphTransferPrivateViews(directory:string,target:GraphErasureIdentity,values:object[],wrappers:Array<{object:object;field:string}>):{close():void}{
 const root=canonicalRoot(directory),rows=roots.get(root)??new Set<Row>(),row:Row={target:canonicalHash(target),objects:new Set(),wrappers:wrappers.map(value=>({object:new WeakRef(value.object),field:value.field})),overflow:false},seen=new WeakSet<object>();
 const visit=(value:object):void=>{if(seen.has(value))return;seen.add(value);if(row.objects.size+row.wrappers.length+count(rows)>=LIMIT){row.overflow=true;return;}row.objects.add(new WeakRef(value));for(const descriptor of Reflect.ownKeys(value).map(key=>Object.getOwnPropertyDescriptor(value,key)!)){if(!('value'in descriptor)){row.overflow=true;continue;}if(descriptor.value&&typeof descriptor.value==='object')visit(descriptor.value);}};
 for(const value of values)visit(value);rows.add(row);roots.set(root,rows);
 const close=()=>{if(clear(root,row)){rows.delete(row);if(!rows.size)roots.delete(root);}else throw new Error('graph-transfer-private-view-debt');};
 if(row.overflow){try{close();}catch{/* The failed weak inventory remains attributable; never silently drop it. */}throw new Error('graph-transfer-private-view-capacity');}return{close};
}
export function purgeGraphTransferPrivateViews(directory:string,target:GraphErasureIdentity):void{
 const root=canonicalRoot(directory),rows=roots.get(root),key=canonicalHash(target);let debt=false;
 for(const row of rows??[])if(row.target===key){if(clear(root,row))rows!.delete(row);else debt=true;}
 if(rows&&!rows.size)roots.delete(root);if(debt)throw new Error('graph-transfer-private-view-debt');
}
