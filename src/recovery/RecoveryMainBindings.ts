/** Exact installer-owned main bootstrap bindings; restore missing files, never bless changed files. */
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {SafeFsExecutor}from '../core/SafeFsExecutor.js';
export interface RecoveryMainBindingSnapshot{nodeAlias:string;nodeTarget:string;nodeTargetDigest:string;fallbackNodeDigest:string;wrapper:string;wrapperDigest:string;wrapperBackup:string;fallbackNode:string;}
interface Context{mainStateDir?:string;stateDir:string;mainBindings?:RecoveryMainBindingSnapshot;runtimeSlot?:{directory:string;node:string};}
const binaryHash=(file:string)=>{const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const st=fs.fstatSync(fd);if(!st.isFile()||![0,process.getuid?.()].includes(st.uid)||(st.mode&0o022)||st.size>268435456)throw new Error('recovery-main-binding-untrusted');return crypto.createHash('sha256').update(fs.readFileSync(fd)).digest('hex');}finally{fs.closeSync(fd);}};
const hash=(value:string)=>crypto.createHash('sha256').update(value).digest('hex');
function owned(file:string,max=131072):string{const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o022)||s.size>max)throw new Error('recovery-main-binding-untrusted');return fs.readFileSync(fd,'utf8');}finally{fs.closeSync(fd);}}
function root(c:Context):string{if(!c.mainStateDir||!path.isAbsolute(c.mainStateDir)||path.dirname(c.stateDir)!==path.join(c.mainStateDir,'recovery'))throw new Error('recovery-main-binding-untrusted');return c.mainStateDir;}
function validateShape(c:Context,b:RecoveryMainBindingSnapshot):void{
 const state=root(c),directory=path.join(state,'recovery','main-bindings',b.wrapperDigest);
 if(b.nodeAlias!==path.join(state,'bin','node')||b.wrapper!==path.join(state,'instar-boot.cjs')||b.wrapperBackup!==path.join(directory,'instar-boot.cjs')||!path.isAbsolute(b.nodeTarget)||!path.isAbsolute(b.fallbackNode)
  ||!b.fallbackNode.startsWith(path.join(state,'recovery','runtime-slots')+path.sep)||!/^[a-f0-9]{64}$/.test(b.wrapperDigest)||hash(owned(b.wrapperBackup))!==b.wrapperDigest)throw new Error('recovery-main-binding-untrusted');
 if(!/^[a-f0-9]{64}$/.test(b.nodeTargetDigest)||!/^[a-f0-9]{64}$/.test(b.fallbackNodeDigest)||binaryHash(b.fallbackNode)!==b.fallbackNodeDigest)throw new Error('recovery-main-binding-untrusted');
 const node=fs.lstatSync(b.fallbackNode);if(!node.isFile()||node.isSymbolicLink()||node.uid!==process.getuid?.()||(node.mode&0o022)||(node.mode&0o111)===0)throw new Error('recovery-main-binding-untrusted');
}
/** Called only by the trusted installer after it generated the candidate bytes. */
export function saveRecoveryMainBindingCandidate(c:Context,wrapperContent:string,nodeTarget:string,fallbackNode:string):RecoveryMainBindingSnapshot{
 const state=root(c),digest=hash(wrapperContent),directory=path.join(state,'recovery','main-bindings',digest),backup=path.join(directory,'instar-boot.cjs');
 if(!path.isAbsolute(nodeTarget)||!path.isAbsolute(fallbackNode)||!fallbackNode.startsWith(path.join(state,'recovery','runtime-slots')+path.sep)||wrapperContent.length>131072)throw new Error('recovery-main-binding-untrusted');
 fs.mkdirSync(directory,{recursive:true,mode:0o700});const s=fs.lstatSync(directory);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077))throw new Error('recovery-main-binding-untrusted');
 if(fs.existsSync(backup)){if(hash(owned(backup))!==digest)throw new Error('recovery-main-binding-untrusted');}
 else fs.writeFileSync(backup,wrapperContent,{mode:0o600,flag:'wx'});
 const snapshot={nodeAlias:path.join(state,'bin','node'),nodeTarget,nodeTargetDigest:binaryHash(fs.realpathSync(nodeTarget)),fallbackNodeDigest:binaryHash(fallbackNode),wrapper:path.join(state,'instar-boot.cjs'),wrapperDigest:digest,wrapperBackup:backup,fallbackNode};validateShape(c,snapshot);return snapshot;
}
/** Initial owner enrollment pins the already installed, protected own bootstrap. */
export function captureRecoveryMainBindings(c:Context):RecoveryMainBindingSnapshot{
 if(!c.runtimeSlot)throw new Error('recovery-runtime-slot-required');
 if(c.mainBindings)validateRecoveryMainBindings(c);
 const state=root(c),alias=path.join(state,'bin','node'),link=fs.lstatSync(alias);
 if(!link.isSymbolicLink()||link.uid!==process.getuid?.())throw new Error('recovery-main-binding-untrusted');
 return saveRecoveryMainBindingCandidate(c,owned(path.join(state,'instar-boot.cjs')),path.resolve(path.dirname(alias),fs.readlinkSync(alias)),c.runtimeSlot.node);
}
/** Missing bootstrap pieces are recoverable; a present mismatching file is not. */
export function validateRecoveryMainBindings(c:Context):void{
 const b=c.mainBindings;if(!b)throw new Error('recovery-main-binding-snapshot-required');validateShape(c,b);
 try{if(hash(owned(b.wrapper))!==b.wrapperDigest)throw new Error('recovery-main-binding-changed');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 try{const s=fs.lstatSync(b.nodeAlias);if(!s.isSymbolicLink()||s.uid!==process.getuid?.())throw new Error('recovery-main-binding-changed');const target=path.resolve(path.dirname(b.nodeAlias),fs.readlinkSync(b.nodeAlias));if(target!==b.nodeTarget&&target!==b.fallbackNode)throw new Error('recovery-main-binding-changed');if(fs.existsSync(target)&&binaryHash(fs.realpathSync(target))!==(target===b.fallbackNode?b.fallbackNodeDigest:b.nodeTargetDigest))throw new Error('recovery-main-binding-changed');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
}
export function restoreRecoveryMainBindings(c:Context):void{
 validateRecoveryMainBindings(c);const b=c.mainBindings!;
 if(!fs.existsSync(b.wrapper))fs.writeFileSync(b.wrapper,owned(b.wrapperBackup),{mode:0o600,flag:'wx'});
 let replace=false;try{fs.accessSync(b.nodeAlias,fs.constants.X_OK);}catch{replace=true;}
 if(replace){const dir=path.dirname(b.nodeAlias);fs.mkdirSync(dir,{recursive:true,mode:0o700});const s=fs.lstatSync(dir);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o022))throw new Error('recovery-main-binding-untrusted');
  try{SafeFsExecutor.safeUnlinkSync(b.nodeAlias,{operation:'recovery-main-start:restore-owned-interpreter-alias'});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  fs.symlinkSync(b.fallbackNode,b.nodeAlias);
 }
}
