/** Owner-local suppression is durable before network work. This is a deny
 * fence, never a claim that a witness or another member erased anything. */
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {SafeFsExecutor} from './SafeFsExecutor.js';
import {assertGraphLocalPath} from './GraphLocalFiles.js';
import {canonicalHash,validateGraphErasureIdentity,type GraphErasureIdentity} from './GraphWitnessTypes.js';

type NegativeRootState={denied:Map<string,GraphErasureIdentity>;corrupt:boolean;device:bigint;inode:bigint};
// Process-local NEGATIVE knowledge only. Never evict/clear a deny after refresh
// or same-process restore. This grants no positive freshness or cold-process
// restore authority, and is not evidence that an unsynced deny reached disk.
const negativeRoots=new Map<string,NegativeRootState>();
export class ConversationGraphLocalErasureFence {
 private readonly directory:string;
 private readonly stateDir:string;
 private readonly inputPath:string;
 private readonly negative:NegativeRootState;
 constructor(stateDir:string){
  this.inputPath=path.resolve(stateDir);this.stateDir=fs.realpathSync(this.inputPath);
  const fd=fs.openSync(this.stateDir,fs.constants.O_RDONLY|(fs.constants.O_DIRECTORY??0)|(fs.constants.O_NOFOLLOW??0));let stat:fs.BigIntStats;
  try{stat=fs.fstatSync(fd,{bigint:true});if(!stat.isDirectory())throw new Error('local-erasure-root-invalid');}finally{fs.closeSync(fd);}
  const prior=negativeRoots.get(this.stateDir);this.negative=prior??{denied:new Map(),corrupt:false,device:stat.dev,inode:stat.ino};
  if(prior&&(prior.device!==stat.dev||prior.inode!==stat.ino))prior.corrupt=true;
  negativeRoots.set(this.stateDir,this.negative);this.directory=path.join(this.stateDir,'conversation-graph','local-erasure-intents');this.load();
 }
 private rootValid():boolean{
  try{if(fs.realpathSync(this.inputPath)!==this.stateDir)throw new Error('path-changed');const fd=fs.openSync(this.stateDir,fs.constants.O_RDONLY|(fs.constants.O_DIRECTORY??0)|(fs.constants.O_NOFOLLOW??0));try{const stat=fs.fstatSync(fd,{bigint:true});if(!stat.isDirectory()||stat.dev!==this.negative.device||stat.ino!==this.negative.inode)throw new Error('root-changed');}finally{fs.closeSync(fd);}assertGraphLocalPath(this.stateDir,this.directory);}
  catch{this.negative.corrupt=true;}return !this.negative.corrupt;
 }
 /** Scope identity only, not a positive read/admission capability. */
 get stateRoot():string{if(!this.rootValid())throw new Error('local-erasure-fence-unavailable');return this.stateDir;}
 private readDisk(sync=false):GraphErasureIdentity[]{
  if(!this.rootValid())throw new Error('local-erasure-fence-unavailable');const targets:GraphErasureIdentity[]=[];
  let entries:string[];try{entries=fs.readdirSync(this.directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return targets;throw error;}
  for(const entry of entries){if(!entry.endsWith('.json'))continue;const file=path.join(this.directory,entry);assertGraphLocalPath(this.stateDir,file);
   const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));let target:unknown;
   try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>4096)throw new Error('local-erasure-fence-invalid');target=JSON.parse(fs.readFileSync(fd,'utf8'));if(!validateGraphErasureIdentity(target)||entry!==`${canonicalHash(target)}.json`)throw new Error('local-erasure-fence-invalid');if(sync)fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
   targets.push(Object.freeze({...target as GraphErasureIdentity}));
  }
  if(sync)for(const parent of [this.directory,path.dirname(this.directory),this.stateDir]){const fd=fs.openSync(parent,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
  return targets;
 }
 private load():void{try{for(const target of this.readDisk())this.negative.denied.set(canonicalHash(target),target);}catch{this.negative.corrupt=true;}}
 async refresh():Promise<void>{this.load();if(this.negative.corrupt)throw new Error('local-erasure-fence-unavailable');}
 isDenied(target:GraphErasureIdentity):boolean{return !this.rootValid()||!validateGraphErasureIdentity(target)||this.negative.denied.has(canonicalHash(target));}
 targets():GraphErasureIdentity[]{if(!this.rootValid())throw new Error('local-erasure-fence-unavailable');return [...this.negative.denied.values()].map(target=>({...target}));}
 /** Fresh disk validation/barrier only; shared in-memory deny is never proof
  * of durable publication. Missing accepted live denials remain explicit debt. */
 durableTargets():GraphErasureIdentity[]{
  let targets:GraphErasureIdentity[];try{targets=this.readDisk(true);}catch{this.negative.corrupt=true;throw new Error('local-erasure-fence-unavailable');}
  const disk=new Set(targets.map(canonicalHash));for(const target of targets)this.negative.denied.set(canonicalHash(target),target);
  if([...this.negative.denied.keys()].some(hash=>!disk.has(hash)))throw new Error('local-erasure-fence-not-durable');
  return targets.map(target=>({...target}));
 }
 async deny(target:GraphErasureIdentity):Promise<void>{
  if(!validateGraphErasureIdentity(target))throw new Error('local-erasure-target-invalid');
  if(!this.rootValid())throw new Error('local-erasure-fence-unavailable');
  const frozen=Object.freeze({...target}),hash=canonicalHash(frozen);
  // Visible to EVERY actual instance synchronously, even if persistence fails.
  this.negative.denied.set(hash,frozen);
  await fs.promises.mkdir(this.directory,{recursive:true,mode:0o700});
  for(const parent of [this.stateDir,path.dirname(this.directory)]){const directory=await fs.promises.open(parent,'r');try{await directory.sync();}finally{await directory.close();}}
  if(!this.rootValid())throw new Error('local-erasure-fence-unavailable');
  const destination=path.join(this.directory,`${hash}.json`),temporary=path.join(this.directory,`${hash}.${randomUUID()}.pending`),handle=await fs.promises.open(temporary,'wx',0o600);
  try{await handle.writeFile(JSON.stringify(frozen));await handle.sync();}finally{await handle.close();}
  try{if(!this.rootValid())throw new Error('local-erasure-fence-unavailable');await fs.promises.rename(temporary,destination);const directory=await fs.promises.open(this.directory,'r');try{await directory.sync();}finally{await directory.close();}}
  finally{try{await SafeFsExecutor.safeUnlink(temporary,{operation:'graph-local-erasure:temporary-cleanup'});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
 }
}
