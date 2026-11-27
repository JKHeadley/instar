/** Independent revocation HEAD: whole-config replays cannot restore authority.
 * This stores no credential/hash and deliberately retains only one generation.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {SafeFsExecutor} from './SafeFsExecutor.js';
import {assertGraphLocalPath} from './GraphLocalFiles.js';
export const DASHBOARD_PIN_GENERATION_HEAD='conversation-graph-owner-policy-head.json';
export const dashboardPinGenerationPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function location(stateDir:string):{root:string;file:string}{const root=fs.realpathSync(stateDir),file=path.join(root,DASHBOARD_PIN_GENERATION_HEAD);assertGraphLocalPath(root,file);return{root,file};}
export function readDashboardPinGenerationHead(stateDir:string):string|null{
 const {file}=location(stateDir);let stat:fs.Stats;
 try{stat=fs.lstatSync(file);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
 if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw new Error('dashboard-pin-head-file-invalid');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
 try{const opened=fs.fstatSync(fd);if(opened.dev!==stat.dev||opened.ino!==stat.ino||opened.nlink!==1)throw new Error('dashboard-pin-head-file-raced');
 const head=JSON.parse(fs.readFileSync(fd,'utf8'));
 if(!head||typeof head!=='object'||Array.isArray(head)||Object.keys(head).sort().join(',')!=='generation,version'||head.version!==1||typeof head.generation!=='string'||!dashboardPinGenerationPattern.test(head.generation))throw new Error('dashboard-pin-head-invalid');return head.generation;
 }finally{fs.closeSync(fd);}
}
/** Only the managed PIN writer calls this, before publishing its config pair.
 * Failure after rename intentionally leaves policy quarantined, never rolled back.
 */
export function publishDashboardPinGenerationHead(stateDir:string,generation:string):void{
 if(!dashboardPinGenerationPattern.test(generation))throw new Error('dashboard-pin-generation-invalid');
 const {root,file}=location(stateDir);readDashboardPinGenerationHead(stateDir);
 const bytes=JSON.stringify({version:1,generation})+'\n',temporary=`${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
 try{
  const fd=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  assertGraphLocalPath(root,file);fs.renameSync(temporary,file);
  const published=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));try{fs.fsyncSync(published);}finally{fs.closeSync(published);}
  const directory=fs.openSync(root,'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
  if(readDashboardPinGenerationHead(stateDir)!==generation)throw new Error('dashboard-pin-head-outcome-uncertain');
 }finally{if(fs.existsSync(temporary))SafeFsExecutor.safeUnlinkSync(temporary,{operation:'dashboard-pin-head:publication-scratch'});}
}
/** A legacy credential is usable for first-use authentication only when BOTH
 * managed facts are absent. Existing managed state cannot auto-repair itself.
 */
export function assertDashboardPinGenerationBinding(stateDir:string,generation:unknown):void{
 if(generation!==undefined&&(typeof generation!=='string'||!dashboardPinGenerationPattern.test(generation)))throw new Error('graph-owner-policy-generation-invalid');
 const head=readDashboardPinGenerationHead(stateDir);
 if(generation===undefined&&head===null)return;
 if(generation!==head)throw new Error('graph-owner-policy-generation-quarantined');
}
