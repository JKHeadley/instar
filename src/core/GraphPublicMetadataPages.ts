/** DATA custody only. Hash-checked bytes are not a public-schema verdict, an
 * erasure-census exemption, or owner/native/Source receipt authority. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {SafeFsExecutor} from './SafeFsExecutor.js';
import {assertGraphLocalPath,ensureGraphLocalDirectory} from './GraphLocalFiles.js';

export const GRAPH_PUBLIC_METADATA_PAGE_BYTES=128*1024;
const FANOUT=128,TOKEN=Symbol('graph-public-metadata-data-handle');
const digest=(bytes:Uint8Array|string)=>crypto.createHash('sha256').update(bytes).digest('hex');
const validHash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
interface Ref {kind:'page'|'index';hash:string;bytes:number;pages:number}
interface Index {v:1;kind:'graph-public-metadata-index';children:Ref[]}
export interface GraphPublicMetadataDescriptor {v:1;kind:'graph-public-metadata-bytes';hash:string;bytes:number;pages:number;indexHash:string|null}
interface Stamp {dev:bigint;ino:bigint;size:bigint;mtimeNs:bigint;ctimeNs:bigint}
const stamp=(s:fs.BigIntStats):Stamp=>({dev:s.dev,ino:s.ino,size:s.size,mtimeNs:s.mtimeNs,ctimeNs:s.ctimeNs});
const same=(a:Stamp,b:Stamp)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
function descriptor(raw:unknown):raw is GraphPublicMetadataDescriptor{const d=raw as GraphPublicMetadataDescriptor;return !!d&&Object.keys(d).sort().join(',')==='bytes,hash,indexHash,kind,pages,v'&&d.v===1&&d.kind==='graph-public-metadata-bytes'&&validHash(d.hash)&&Number.isSafeInteger(d.bytes)&&d.bytes>=0&&d.pages===Math.ceil(d.bytes/GRAPH_PUBLIC_METADATA_PAGE_BYTES)&&(d.pages===0?d.indexHash===null:validHash(d.indexHash));}
function ref(raw:unknown):raw is Ref {const r=raw as Ref;return !!r&&Object.keys(r).sort().join(',')==='bytes,hash,kind,pages'&&['page','index'].includes(r.kind)&&validHash(r.hash)&&Number.isSafeInteger(r.bytes)&&r.bytes>0&&Number.isSafeInteger(r.pages)&&r.pages>0&&(r.kind!=='page'||r.pages===1&&r.bytes<=GRAPH_PUBLIC_METADATA_PAGE_BYTES);}
/** Constructor is token-gated; no caller can turn a hash or callback into a
 * verified data handle. Consumers still must validate their exact public schema. */
export class GraphPublicMetadataData {
 readonly descriptor:Readonly<GraphPublicMetadataDescriptor>;readonly stateRoot:string;
 #read:()=>AsyncGenerator<Buffer>;#check:()=>void;#range:(offset:number,length:number)=>Buffer;
 constructor(token:symbol,value:GraphPublicMetadataDescriptor,read:()=>AsyncGenerator<Buffer>,check:()=>void,range:(offset:number,length:number)=>Buffer,stateRoot:string){if(token!==TOKEN)throw new Error('graph-public-metadata-actual-data-required');this.descriptor=Object.freeze({...value});this.stateRoot=stateRoot;this.#read=read;this.#check=check;this.#range=range;Object.freeze(this);}
 bytes():AsyncGenerator<Buffer>{return this.#read();}
 /** Selected paths/pages only, never a fresh whole-set or domain verdict.
  * A real consumer must still assertCurrent at its final whole-proof barrier. */
 readRangeSync(offset:number,length:number):Buffer{if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<0||length>GRAPH_PUBLIC_METADATA_PAGE_BYTES||offset>this.descriptor.bytes||length>this.descriptor.bytes-offset)throw new Error('graph-public-metadata-range-invalid');return this.#range(offset,length);}
 async readRange(offset:number,length:number):Promise<Buffer>{return this.readRangeSync(offset,length);}
 /** Fresh complete bytes/inode/stamp validation, never an authority decision. */
 assertCurrent():void{this.#check();}
}
export class GraphPublicMetadataPages {
 readonly stateRoot:string;readonly directory:string;
 private readonly rootStamp:Stamp;private readonly maxTotalBytes:number;private readonly directories=new Map<string,Stamp>();
 constructor(options:{stateRoot:string;maxTotalBytes:number}){
  if(!Number.isSafeInteger(options.maxTotalBytes)||options.maxTotalBytes<1)throw new Error('graph-public-metadata-explicit-byte-policy-required');
  this.maxTotalBytes=options.maxTotalBytes;this.stateRoot=fs.realpathSync(options.stateRoot);this.rootStamp=stamp(fs.lstatSync(this.stateRoot,{bigint:true}));this.directory=path.join(this.stateRoot,'state','conversation-graph-public-metadata');this.scope();ensureGraphLocalDirectory(this.stateRoot,this.directory);for(const part of ['pages','indexes','roots'])ensureGraphLocalDirectory(this.stateRoot,path.join(this.directory,part));for(const dir of [path.join(this.stateRoot,'state'),this.directory,...['pages','indexes','roots'].map(part=>path.join(this.directory,part))])this.directories.set(dir,stamp(fs.lstatSync(dir,{bigint:true})));this.scope();
 }
 private scope():void{const s=fs.lstatSync(this.stateRoot,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink()||s.dev!==this.rootStamp.dev||s.ino!==this.rootStamp.ino||fs.realpathSync(this.stateRoot)!==this.stateRoot)throw new Error('graph-public-metadata-root-changed');assertGraphLocalPath(this.stateRoot,this.directory);for(const [dir,known]of this.directories){assertGraphLocalPath(this.stateRoot,dir);const current=fs.lstatSync(dir,{bigint:true});if(!current.isDirectory()||current.isSymbolicLink()||current.dev!==known.dev||current.ino!==known.ino)throw new Error('graph-public-metadata-directory-changed');}}
 private file(kind:'page'|'index'|'root',hash:string):string{if(!validHash(hash))throw new Error('graph-public-metadata-invalid-hash');this.scope();const f=path.join(this.directory,kind==='page'?'pages':kind==='index'?'indexes':'roots',hash+(kind==='page'?'.bin':'.json'));assertGraphLocalPath(this.stateRoot,f);return f;}
 private syncParents(file:string):void{this.scope();for(let directory=path.dirname(file);;directory=path.dirname(directory)){assertGraphLocalPath(this.stateRoot,directory);const before=fs.lstatSync(directory,{bigint:true});if(!before.isDirectory()||before.isSymbolicLink())throw new Error('graph-public-metadata-parent-invalid');const fd=fs.openSync(directory,'r');try{const opened=fs.fstatSync(fd,{bigint:true});if(opened.dev!==before.dev||opened.ino!==before.ino)throw new Error('graph-public-metadata-parent-changed');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}if(directory===this.stateRoot)break;if(path.dirname(directory)===directory)throw new Error('graph-public-metadata-parent-invalid');}this.scope();}
 private read(file:string,limit:number,expected?:Stamp):{bytes:Buffer;stamp:Stamp}{
  this.scope();assertGraphLocalPath(this.stateRoot,file);const before=fs.lstatSync(file,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>BigInt(limit))throw new Error('graph-public-metadata-file-invalid');if(expected&&!same(stamp(before),expected))throw new Error('graph-public-metadata-file-changed');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));try{const opened=fs.fstatSync(fd,{bigint:true});if(!same(stamp(before),stamp(opened))||opened.nlink!==1n)throw new Error('graph-public-metadata-file-changed');const bytes=Buffer.alloc(Number(opened.size)+1);let offset=0;while(offset<bytes.length){const count=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);if(count===0)break;offset+=count;}const after=fs.lstatSync(file,{bigint:true});if(offset!==Number(opened.size)||!same(stamp(opened),stamp(after))||after.nlink!==1n)throw new Error('graph-public-metadata-file-changed');fs.fsyncSync(fd);this.syncParents(file);this.scope();return{bytes:bytes.subarray(0,offset),stamp:stamp(after)};}finally{fs.closeSync(fd);}
 }
 private publish(kind:'page'|'index'|'root',hash:string,bytes:Buffer):void{
  const file=this.file(kind,hash),limit=GRAPH_PUBLIC_METADATA_PAGE_BYTES;if(bytes.length>limit||digest(bytes)!==hash)throw new Error('graph-public-metadata-publication-invalid');
  try{const old=this.read(file,limit);if(!old.bytes.equals(bytes))throw new Error('graph-public-metadata-conflict');this.syncParents(file);return;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const temporary=file+'.'+crypto.randomUUID()+'.pending';let owned:Stamp|undefined;
  try{const fd=fs.openSync(temporary,'wx',0o600);try{owned=stamp(fs.fstatSync(fd,{bigint:true}));fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}try{fs.linkSync(temporary,file);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}}
  finally{if(owned){const current=fs.lstatSync(temporary,{bigint:true});if(current.dev!==owned.dev||current.ino!==owned.ino||!current.isFile()||current.isSymbolicLink())throw new Error('graph-public-metadata-own-scratch-changed');SafeFsExecutor.safeUnlinkSync(temporary,{operation:'graph-public-metadata:own-publication-scratch'});}}
  const retained=this.read(file,limit);if(!retained.bytes.equals(bytes)||digest(retained.bytes)!==hash)throw new Error('graph-public-metadata-publication-readback');this.syncParents(file);
 }
 private index(children:Ref[]):Ref{const value:Index={v:1,kind:'graph-public-metadata-index',children},bytes=Buffer.from(JSON.stringify(value)),hash=digest(bytes);this.publish('index',hash,bytes);return{kind:'index',hash,bytes:children.reduce((n,c)=>n+c.bytes,0),pages:children.reduce((n,c)=>n+c.pages,0)};}
 /** Input is caller-designated PUBLIC bytes. This primitive does not inspect
  * their domain schema or make private data safe to store as public metadata. */
 async put(input:AsyncIterable<Uint8Array>|Iterable<Uint8Array>):Promise<GraphPublicMetadataData>{
  this.scope();const body=crypto.createHash('sha256'),refs:Ref[]=[];let total=0,filled=0;const page=Buffer.alloc(GRAPH_PUBLIC_METADATA_PAGE_BYTES);
  const flush=()=>{if(!filled)return;const bytes=page.subarray(0,filled),hash=digest(bytes);this.publish('page',hash,bytes);refs.push({kind:'page',hash,bytes:filled,pages:1});filled=0;};
  for await(const chunk of input){if(!(chunk instanceof Uint8Array))throw new Error('graph-public-metadata-byte-input-required');if(chunk.byteLength>this.maxTotalBytes-total)throw new Error('graph-public-metadata-byte-policy');total+=chunk.byteLength;body.update(chunk);let offset=0;while(offset<chunk.byteLength){const n=Math.min(page.length-filled,chunk.byteLength-offset);page.set(chunk.subarray(offset,offset+n),filled);filled+=n;offset+=n;if(filled===page.length)flush();}}flush();
  let level=refs;while(level.length>1||level[0]?.kind==='page'){const next:Ref[]=[];for(let offset=0;offset<level.length;offset+=FANOUT)next.push(this.index(level.slice(offset,offset+FANOUT)));level=next;}
  const value:GraphPublicMetadataDescriptor={v:1,kind:'graph-public-metadata-bytes',hash:body.digest('hex'),bytes:total,pages:refs.length,indexHash:level[0]?.hash??null},bytes=Buffer.from(JSON.stringify(value));this.publish('root',digest(bytes),bytes);return this.open(value);
 }
 open(raw:GraphPublicMetadataDescriptor):GraphPublicMetadataData{
  if(!descriptor(raw)||raw.bytes>this.maxTotalBytes)throw new Error('graph-public-metadata-descriptor-invalid');const d=Object.freeze({v:raw.v,kind:raw.kind,hash:raw.hash,bytes:raw.bytes,pages:raw.pages,indexHash:raw.indexHash}),rootBytes=Buffer.from(JSON.stringify(d)),rootFile=this.file('root',digest(rootBytes)),stamps=new Map<string,{stamp:Stamp;hash:string}>();
  const checkRead=(kind:'page'|'index'|'root',hash:string,capture:boolean)=>{const file=this.file(kind,hash),known=stamps.get(file);if(!capture&&!known)throw new Error('graph-public-metadata-unverified-file');const result=this.read(file,GRAPH_PUBLIC_METADATA_PAGE_BYTES,known?.stamp);if(digest(result.bytes)!==hash)throw new Error('graph-public-metadata-content-invalid');if(capture&&!known)stamps.set(file,{stamp:result.stamp,hash});return result.bytes;};
  const root=checkRead('root',digest(rootBytes),true);if(!root.equals(rootBytes))throw new Error('graph-public-metadata-root-invalid');
  const children=(r:Ref,capture:boolean):Ref[]=>{const value=JSON.parse(checkRead('index',r.hash,capture).toString('utf8')) as Index;if(!value||Object.keys(value).sort().join(',')!=='children,kind,v'||value.v!==1||value.kind!=='graph-public-metadata-index'||!Array.isArray(value.children)||value.children.length<1||value.children.length>FANOUT||!value.children.every(ref)||value.children.reduce((n,c)=>n+c.bytes,0)!==r.bytes||value.children.reduce((n,c)=>n+c.pages,0)!==r.pages)throw new Error('graph-public-metadata-index-invalid');return value.children;};
  const visit=function*(store:GraphPublicMetadataPages,r:Ref,depth:number,capture:boolean):Generator<Buffer>{if(depth>16)throw new Error('graph-public-metadata-index-depth');if(r.kind==='page'){const bytes=checkRead('page',r.hash,capture);if(bytes.length!==r.bytes)throw new Error('graph-public-metadata-page-length');yield bytes;return;}for(const child of children(r,capture))yield*visit(store,child,depth+1,capture);};
  const scan=(capture:boolean)=>{this.scope();const h=crypto.createHash('sha256');let bytes=0,pages=0;checkRead('root',digest(rootBytes),capture);if(d.indexHash)for(const page of visit(this,{kind:'index',hash:d.indexHash,bytes:d.bytes,pages:d.pages},0,capture)){pages++;bytes+=page.length;if(bytes>d.bytes||pages>d.pages)throw new Error('graph-public-metadata-count-invalid');if(pages<d.pages&&page.length!==GRAPH_PUBLIC_METADATA_PAGE_BYTES)throw new Error('graph-public-metadata-short-page');h.update(page);}if(bytes!==d.bytes||pages!==d.pages||h.digest('hex')!==d.hash)throw new Error('graph-public-metadata-final-hash-invalid');};
  scan(true);this.syncParents(rootFile);const store=this;
  const range=(offset:number,length:number):Buffer=>{store.scope();checkRead('root',digest(rootBytes),false);const result=Buffer.alloc(length),selected=new Map<string,{kind:'page'|'index';hash:string}>();let written=0;
   const copy=(r:Ref,start:number,depth:number):void=>{if(depth>16)throw new Error('graph-public-metadata-index-depth');if(start>=offset+length||start+r.bytes<=offset)return;selected.set(r.kind+':'+r.hash,{kind:r.kind,hash:r.hash});if(r.kind==='page'){const bytes=checkRead('page',r.hash,false);if(bytes.length!==r.bytes)throw new Error('graph-public-metadata-page-length');const from=Math.max(0,offset-start),to=Math.min(bytes.length,offset+length-start),destination=start+from-offset;bytes.copy(result,destination,from,to);written+=to-from;return;}let childStart=start;for(const child of children(r,false)){copy(child,childStart,depth+1);childStart+=child.bytes;}};
   if(length&&d.indexHash)copy({kind:'index',hash:d.indexHash,bytes:d.bytes,pages:d.pages},0,0);if(written!==length)throw new Error('graph-public-metadata-range-incomplete');for(const row of selected.values())checkRead(row.kind,row.hash,false);checkRead('root',digest(rootBytes),false);store.scope();return result;};
  return new GraphPublicMetadataData(TOKEN,d,async function*(){store.scope();checkRead('root',digest(rootBytes),false);const h=crypto.createHash('sha256');let total=0,pages=0;if(d.indexHash)for(const bytes of visit(store,{kind:'index',hash:d.indexHash,bytes:d.bytes,pages:d.pages},0,false)){total+=bytes.length;pages++;h.update(bytes);yield Buffer.from(bytes);}if(total!==d.bytes||pages!==d.pages||h.digest('hex')!==d.hash)throw new Error('graph-public-metadata-final-hash-invalid');store.scope();},()=>scan(false),range,this.stateRoot);
 }
 /** Unknown names/scratch are retained and reported as debt. No GC implied. */
 inspectDebt():readonly string[]{this.scope();const debt:string[]=[];for(const name of fs.readdirSync(this.directory))if(!['pages','indexes','roots'].includes(name))debt.push(name);for(const group of ['pages','indexes','roots']){const directory=path.join(this.directory,group);assertGraphLocalPath(this.stateRoot,directory);for(const name of fs.readdirSync(directory)){const file=path.join(directory,name),s=fs.lstatSync(file);if(!new RegExp('^[a-f0-9]{64}'+(group==='pages'?'\\.bin':'\\.json')+'$').test(name)||!s.isFile()||s.isSymbolicLink()||s.nlink!==1)debt.push(group+'/'+name);}}return Object.freeze(debt);}
}
