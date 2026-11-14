/** Read-only bounded disk inventory. Claims are NOT authority until the caller
 * binds them to real owner-pinned role lineage. No role key is loaded or role
 * opened. Candidate public metadata must pass its complete byte classifier. */
import fs from 'node:fs';
import path from 'node:path';
import {canonicalHash,canonicalJson,exactFields,hash,opaque} from './GraphWitnessTypes.js';
import type {GraphMemberLossOwnedRoleClaim} from './GraphMemberLossOwnedRole.js';
import {assertGraphLocalPath} from './GraphLocalFiles.js';
import {verifyGraphMemberLossPublicFile} from './GraphMemberLossPublicMetadata.js';
export interface GraphCustodyRoleClaim {v:1;agentId:string;witnessId:string;membershipHash:string;ownerPublicKeyHash:string;stageHash:string;retirementHash:string;sourceManifestHash:string;rewrapInventoryHash:string}
export interface GraphCustodyRoleDiskDebt {scope:string;reason:'symlink'|'hardlink'|'unknown-copy'|'missing-database'|'invalid-claim'|'unreadable'|'inventory-bound'}
export interface GraphCustodyRoleDiskFile {relativePath:string;device:number;inode:number;size:number;links:number}
export interface GraphCustodyRoleDiskEntry {kind:'genesis'|'versioned';directory:string;databasePath:string;claim:GraphCustodyRoleClaim|GraphMemberLossOwnedRoleClaim|null;files:GraphCustodyRoleDiskFile[]}
export interface GraphCustodyRoleDiskInventory {root:string;roles:GraphCustodyRoleDiskEntry[];publicFiles:Array<GraphCustodyRoleDiskFile&{contentHash:string}>;debt:GraphCustodyRoleDiskDebt[];inventoryHash:string}
export function validGraphCustodyRoleClaim(raw:unknown):raw is GraphCustodyRoleClaim|GraphMemberLossOwnedRoleClaim {
 const loss=raw as GraphMemberLossOwnedRoleClaim;if(loss?.kind==='owned-member-loss-role')return exactFields(loss,['v','kind','agentId','witnessId','membershipHash','ownerPublicKeyHash','consentHash','intentHash','creationHash','sourceManifestHash','rewrapInventoryHash'])&&loss.v===1&&opaque(loss.agentId)&&opaque(loss.witnessId)&&[loss.membershipHash,loss.ownerPublicKeyHash,loss.consentHash,loss.intentHash,loss.creationHash,loss.sourceManifestHash,loss.rewrapInventoryHash].every(hash);
 const c=raw as GraphCustodyRoleClaim;return !!c&&exactFields(c,['v','agentId','witnessId','membershipHash','ownerPublicKeyHash','stageHash','retirementHash','sourceManifestHash','rewrapInventoryHash'])&&c.v===1&&opaque(c.agentId)&&opaque(c.witnessId)&&[c.membershipHash,c.ownerPublicKeyHash,c.stageHash,c.retirementHash,c.sourceManifestHash,c.rewrapInventoryHash].every(hash);
}
function absent(error:unknown){return (error as NodeJS.ErrnoException).code==='ENOENT';}
export function inspectGraphCustodyRoleFiles(stateDir:string,publicOwner?:{agentId:string;ownerPublicKey:string}):GraphCustodyRoleDiskInventory {
 const state=fs.lstatSync(stateDir);if(!state.isDirectory()||state.isSymbolicLink())throw new Error('graph-role-state-root-invalid');
 const root=fs.realpathSync(stateDir),base=path.join(root,'conversation-graph'),roles:GraphCustodyRoleDiskEntry[]=[],publicFiles:GraphCustodyRoleDiskInventory['publicFiles']=[],debt:GraphCustodyRoleDiskDebt[]=[];
 const roleByDirectory=new Map<string,GraphCustodyRoleDiskEntry>();let count=0;
 const scope=(file:string)=>'custody-role:'+canonicalHash(path.relative(root,file));
 const deny=(file:string,reason:GraphCustodyRoleDiskDebt['reason'])=>{if(!debt.some(row=>row.scope===scope(file)&&row.reason===reason))debt.push({scope:scope(file),reason});};
 const capture=(file:string):GraphCustodyRoleDiskFile|null=>{
  try{assertGraphLocalPath(root,file);const before=fs.lstatSync(file);if(before.isSymbolicLink()){deny(file,'symlink');return null;}if(!before.isFile()){deny(file,'unknown-copy');return null;}
   const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));try{const opened=fs.fstatSync(fd);if(opened.ino!==before.ino||opened.dev!==before.dev||!opened.isFile())throw new Error('changed');if(opened.nlink!==1)deny(file,'hardlink');return{relativePath:path.relative(root,file),device:opened.dev,inode:opened.ino,size:opened.size,links:opened.nlink};}finally{fs.closeSync(fd);}
  }catch(error){deny(file,absent(error)?'missing-database':'unreadable');return null;}
 };
 const addRole=(directory:string,kind:'genesis'|'versioned')=>{
  const databasePath=path.join(directory,'custody.sqlite');let claim:GraphCustodyRoleClaim|GraphMemberLossOwnedRoleClaim|null=null;
  if(kind==='versioned'){
   const file=path.join(directory,'claim.json');try{assertGraphLocalPath(root,file);const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.size>16384)throw new Error('invalid');
    const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));let bytes:Buffer;try{const opened=fs.fstatSync(fd);if(opened.ino!==st.ino||opened.dev!==st.dev||opened.size>16384)throw new Error('changed');bytes=Buffer.alloc(opened.size);if(fs.readSync(fd,bytes)!==bytes.length)throw new Error('changed');}finally{fs.closeSync(fd);}
    const value=JSON.parse(bytes.toString());if(!validGraphCustodyRoleClaim(value)||path.basename(directory)!==canonicalHash(value.witnessId))throw new Error('claim');claim=value;
   }catch{deny(file,'invalid-claim');}
  }
  let present=false;try{present=fs.lstatSync(databasePath).isFile();}catch(error){if(!absent(error))deny(databasePath,'unreadable');}
  if(!present){deny(databasePath,'missing-database');return;}
  const role:GraphCustodyRoleDiskEntry={kind,directory,databasePath,claim,files:[]};roles.push(role);roleByDirectory.set(directory,role);
 };
 try{assertGraphLocalPath(root,base);const st=fs.lstatSync(base);if(!st.isDirectory()||st.isSymbolicLink())throw new Error('directory');}catch(error){if(!absent(error))deny(base,'symlink');return {root,roles,publicFiles,debt,inventoryHash:canonicalHash({roles:[],publicFiles,debt})};}
 if(fs.existsSync(path.join(base,'custody.sqlite')))addRole(base,'genesis');
 const versioned=path.join(base,'roles');try{assertGraphLocalPath(root,versioned);const names=fs.readdirSync(versioned);if(names.length>1024)deny(versioned,'inventory-bound');else for(const name of names){const file=path.join(versioned,name);const st=fs.lstatSync(file);if(st.isSymbolicLink()){deny(file,'symlink');continue;}if(!st.isDirectory()||!/^[a-f0-9]{64}$/.test(name)){deny(file,'unknown-copy');continue;}addRole(file,'versioned');}}catch(error){if(!absent(error))deny(versioned,'unreadable');}
 const walk=(directory:string,depth:number)=>{
  if(depth>8){deny(directory,'inventory-bound');return;}let names:string[];try{names=fs.readdirSync(directory);}catch{deny(directory,'unreadable');return;}
  if(count+names.length>20000){deny(directory,'inventory-bound');return;}count+=names.length;
  for(const name of names){const file=path.join(directory,name);let st:fs.Stats;try{st=fs.lstatSync(file);}catch{deny(file,'unreadable');continue;}
   if(st.isSymbolicLink()){deny(file,'symlink');continue;}if(st.isDirectory()){walk(file,depth+1);continue;}if(!st.isFile()){deny(file,'unknown-copy');continue;}
   const relative=path.relative(base,file).split(path.sep);
   if(relative[0]==='member-loss-owned'){
    const match=relative.length===3&&/^([a-f0-9]{64})\.(origin|creation|ready)\.json$/.exec(name);
    if(!publicOwner||!match||!/^[a-f0-9]{64}$/.test(relative[1])){deny(file,'unknown-copy');continue;}
    if(st.nlink!==1){deny(file,'hardlink');continue;}
    try{
     assertGraphLocalPath(root,file);if(st.nlink!==1||st.size>32*1024*1024)throw new Error('unclassified');
     const stamp=fs.lstatSync(file,{bigint:true}),sameStamp=(actual:fs.BigIntStats)=>actual.isFile()&&!actual.isSymbolicLink()&&actual.dev===stamp.dev&&actual.ino===stamp.ino&&actual.size===stamp.size&&actual.nlink===1n&&actual.mtimeNs===stamp.mtimeNs&&actual.ctimeNs===stamp.ctimeNs;
     if(!sameStamp(stamp)||stamp.dev!==BigInt(st.dev)||stamp.ino!==BigInt(st.ino)||stamp.size!==BigInt(st.size))throw new Error('changed');
     const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));let bytes:Buffer;
     try{const opened=fs.fstatSync(fd,{bigint:true});if(!sameStamp(opened))throw new Error('changed');bytes=Buffer.alloc(Number(opened.size));let offset=0;while(offset<bytes.length){const n=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);if(!n)throw new Error('changed');offset+=n;}if(fs.readSync(fd,Buffer.alloc(1),0,1,Number(opened.size))||!sameStamp(fs.fstatSync(fd,{bigint:true})))throw new Error('changed');}finally{fs.closeSync(fd);}
     let value:unknown;try{value=JSON.parse(bytes.toString('utf8'));if(!bytes.equals(Buffer.from(canonicalJson(value))))throw new Error('noncanonical-public-bytes');}finally{bytes.fill(0);}if(!verifyGraphMemberLossPublicFile(match[2] as 'origin'|'creation'|'ready',value,{...publicOwner,witnessHash:relative[1],consentHash:match[1]}))throw new Error('unclassified');
     assertGraphLocalPath(root,file);if(!sameStamp(fs.lstatSync(file,{bigint:true})))throw new Error('changed');
     publicFiles.push({relativePath:path.relative(root,file),device:st.dev,inode:st.ino,size:st.size,links:st.nlink,contentHash:canonicalHash(value)});
    }catch{deny(file,'unknown-copy');}
    continue;
   }
   const role=roleByDirectory.get(directory);if(role&&['custody.sqlite','custody.sqlite-wal','custody.sqlite-shm'].includes(name)){const entry=capture(file);if(entry)role.files.push(entry);continue;}
   if(role?.kind==='versioned'&&name==='claim.json'){const entry=capture(file);if(entry)role.files.push(entry);continue;}
   if(role?.kind==='versioned'){deny(file,'unknown-copy');continue;}
   // Detect renamed SQLite and recognizable transfer/cipher copies throughout
   // the managed custody namespace, without following foreign links.
   try{const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));const header=Buffer.alloc(16);try{const opened=fs.fstatSync(fd);if(opened.ino!==st.ino||opened.dev!==st.dev)throw new Error('changed');fs.readSync(fd,header,0,16,0);}finally{fs.closeSync(fd);}
    if(header.toString('utf8',0,16)==='SQLite format 3\0'||/\.(sqlite|db|wal|shm|part|bundle|rewrap)([.-]|$)/i.test(name))deny(file,'unknown-copy');
   }catch{deny(file,'unreadable');}
  }
 };
 walk(base,0);roles.sort((a,b)=>a.databasePath.localeCompare(b.databasePath));for(const role of roles)role.files.sort((a,b)=>a.relativePath.localeCompare(b.relativePath));debt.sort((a,b)=>a.scope.localeCompare(b.scope)||a.reason.localeCompare(b.reason));
 publicFiles.sort((a,b)=>a.relativePath.localeCompare(b.relativePath));
 return{root,roles,publicFiles,debt,inventoryHash:canonicalHash({roles:roles.map(role=>({kind:role.kind,directory:path.relative(root,role.directory),claim:role.claim,files:role.files})),publicFiles,debt})};
}
