/** Recovery has its own Node, JavaScript and native modules outside the mutable
 * main installation. Installed slots are immutable and addressed by their bytes. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire,isBuiltin} from 'node:module';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {withSyncOp} from '../core/InFlightSyncOpMarker.js';
import {RecoveryAdmission} from './RecoveryAdmission.js';
import {processStartMs} from '../core/processIdentity.js';
import {SafeFsExecutor} from '../core/SafeFsExecutor.js';

export interface RecoveryRuntimeSlot {
  version:1;directory:string;node:string;entrypoint:string;updateEntrypoint:string;digest:string;
}
interface SlotManifest {version:1;digest:string;files:Array<{path:string;sha256:string;size:number;executable:boolean}>}
const HASH=/^[a-f0-9]{64}$/;
const MAX_FILES=20_000,MAX_BYTES=768*1024*1024;
export const RECOVERY_RUNTIME_SLOT_CAPACITY=8;
function allocationStore(stateDir:string):RecoveryAdmission{return new RecoveryAdmission({stateDir,agentId:'runtime-allocation',machineId:'runtime-allocation',certificationRoot:'',bootId:'allocation-only'});}
function owned(st:fs.Stats):boolean{return [0,process.getuid?.()].includes(st.uid)&&!(st.mode&0o022);}
function directory(dir:string):void {
  fs.mkdirSync(dir,{recursive:true,mode:0o700});const st=fs.lstatSync(dir);
  if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o077))throw new Error('recovery-runtime-slot-ownership-invalid');
}
function fileBytes(file:string,max=8*1024*1024):Buffer {
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{const st=fs.fstatSync(fd);if(!st.isFile()||!owned(st)||st.size>max)throw new Error('recovery-runtime-source-invalid');return fs.readFileSync(fd);}finally{fs.closeSync(fd);}
}
function specifiers(source:string):string[] {
  const names=new Set<string>();
  for(const match of source.matchAll(/^\s*(?:import\s+(?:(?:[^'";]+?)\s+from\s+)?|export\s+(?:\*|\{[^}]*\})\s+from\s+)['"]([^'"]+)['"]/gm))names.add(match[1]);
  for(const match of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g))names.add(match[1]);
  return [...names];
}
function packageRoot(moduleFile:string,name:string):string {
  let current=fs.realpathSync(path.dirname(moduleFile));
  while(current!==path.dirname(current)){
    const manifest=path.join(current,'package.json');
    if(fs.existsSync(manifest)){const value=JSON.parse(fileBytes(manifest).toString());if(typeof value.name==='string'&&value.name)return current;}
    current=path.dirname(current);
  }
  throw new Error('recovery-runtime-dependency-unavailable');
}
function packageName(specifier:string):string{return specifier.startsWith('@')?specifier.split('/').slice(0,2).join('/'):specifier.split('/')[0];}
function relativeSafe(root:string,file:string):string {
  const value=path.relative(root,file);if(!value||value.startsWith('..')||path.isAbsolute(value))throw new Error('recovery-runtime-source-invalid');return value;
}
function nodeDependencies(node:string):void {
  const fd=fs.openSync(node,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),magic=Buffer.alloc(4);try{fs.readSync(fd,magic,0,4,0);}finally{fs.closeSync(fd);}
  // A copied Homebrew Node can still depend on mutable Homebrew libraries.
  // Standalone official Node only names protected OS libraries on macOS.
  if(['cffaedfe','cefaedfe','cafebabe','bebafeca'].includes(magic.toString('hex'))){
    const output=withSyncOp(()=>execFileSync('/usr/bin/otool',['-L',node],{encoding:'utf8',timeout:3000,maxBuffer:16384}));
    for(const line of output.split('\n').slice(1)){if(line.startsWith(node+' (architecture '))continue;const library=line.trim().split(' ')[0];if(library&&!library.startsWith('/usr/lib/')&&!library.startsWith('/System/Library/'))throw new Error('recovery-node-standalone-runtime-required');}
  }
}
export function verifyRecoveryRuntimeSlot(slot:RecoveryRuntimeSlot,stateDir:string,verifyContents=false):RecoveryRuntimeSlot {
  const root=path.join(path.dirname(stateDir),'runtime-slots');
  if(slot?.version!==1||!HASH.test(slot.digest)||slot.directory!==path.join(root,slot.digest)||slot.node!==path.join(slot.directory,'bin','node')
    ||slot.entrypoint!==path.join(slot.directory,'scripts','recovery-entrypoint.mjs')||slot.updateEntrypoint!==path.join(slot.directory,'scripts','recovery-update-entrypoint.mjs'))throw new Error('recovery-runtime-slot-invalid');
  const st=fs.lstatSync(slot.directory);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o022))throw new Error('recovery-runtime-slot-ownership-invalid');
  const manifest=JSON.parse(fileBytes(path.join(slot.directory,'slot-manifest.json'),4*1024*1024).toString())as SlotManifest;
  if(manifest.version!==1||manifest.digest!==slot.digest||!Array.isArray(manifest.files)||manifest.files.length>MAX_FILES)throw new Error('recovery-runtime-slot-invalid');
  const digest=crypto.createHash('sha256');let bytes=0;
  for(const entry of manifest.files){
    if(typeof entry.path!=='string'||path.isAbsolute(entry.path)||entry.path.split(path.sep).includes('..')||!HASH.test(entry.sha256)||!Number.isSafeInteger(entry.size)||entry.size<0)throw new Error('recovery-runtime-slot-invalid');
    const file=path.join(slot.directory,entry.path),s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||!owned(s)||s.size!==entry.size)throw new Error('recovery-runtime-slot-ownership-invalid');
    bytes+=s.size;if(bytes>MAX_BYTES)throw new Error('recovery-runtime-slot-too-large');
    if(verifyContents&&crypto.createHash('sha256').update(fileBytes(file,256*1024*1024)).digest('hex')!==entry.sha256)throw new Error('recovery-runtime-slot-corrupt');
    digest.update(JSON.stringify(entry));digest.update('\n');
  }
  if(digest.digest('hex')!==slot.digest)throw new Error('recovery-runtime-slot-corrupt');
  for(const required of [slot.node,slot.entrypoint,slot.updateEntrypoint])if(!manifest.files.some(entry=>path.join(slot.directory,entry.path)===required))throw new Error('recovery-runtime-slot-invalid');
  return slot;
}
export function prepareRecoveryRuntimeSlot(sourceEntrypoint:string,stateDir:string):RecoveryRuntimeSlot {
  if(!path.isAbsolute(sourceEntrypoint)||!path.isAbsolute(stateDir))throw new Error('recovery-runtime-source-invalid');
  const root=path.join(path.dirname(stateDir),'runtime-slots');directory(root);
  const existing=path.basename(path.dirname(path.dirname(sourceEntrypoint)));
  if(HASH.test(existing)&&path.dirname(path.dirname(path.dirname(sourceEntrypoint)))===root){
    const dir=path.join(root,existing);return verifyRecoveryRuntimeSlot({version:1,directory:dir,node:path.join(dir,'bin','node'),entrypoint:path.join(dir,'scripts','recovery-entrypoint.mjs'),updateEntrypoint:path.join(dir,'scripts','recovery-update-entrypoint.mjs'),digest:existing},stateDir,true);
  }
  const sourceRoot=fs.realpathSync(path.resolve(path.dirname(sourceEntrypoint),'..')),stage=path.join(root,'.staging-'+crypto.randomUUID());
  const allocation=allocationStore(stateDir);try{allocation.withRuntimeSlotAllocation(()=>{
    const entries=new Set(fs.readdirSync(root).filter(name=>HASH.test(name)||name.startsWith('.staging-')).map(name=>name.replace(/\.owner\.json$/,'')));
    if(entries.size>=RECOVERY_RUNTIME_SLOT_CAPACITY)throw new Error('recovery-runtime-slot-capacity: clean up owned unreferenced runtime slots before installing another build');
    fs.writeFileSync(stage+'.owner.json',JSON.stringify({pid:process.pid,birth:processStartMs(process.pid),createdAt:Date.now()}),{mode:0o600,flag:'wx'});directory(stage);
  });}finally{allocation.close();}
  const files=new Set<string>(),externals=new Map<string,string>();let totalBytes=0;
  const copy=(source:string,relative:string,executable=false)=>{
    if(path.isAbsolute(relative)||relative.split(path.sep).includes('..'))throw new Error('recovery-runtime-source-invalid');
    if(files.has(relative))return;const st=fs.lstatSync(source);
    if(!st.isFile()||st.isSymbolicLink()||!owned(st)||st.size>256*1024*1024)throw new Error('recovery-runtime-source-invalid');
    totalBytes+=st.size;if(totalBytes>MAX_BYTES||files.size>=MAX_FILES)throw new Error('recovery-runtime-slot-too-large');
    const target=path.join(stage,relative);fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});fs.copyFileSync(source,target,fs.constants.COPYFILE_FICLONE);fs.chmodSync(target,executable?0o500:0o400);files.add(relative);
  };
  const visited=new Set<string>();
  const graph=(file:string)=>{
    file=fs.realpathSync(file);if(visited.has(file))return;visited.add(file);
    const relative=relativeSafe(sourceRoot,file);if(!relative.startsWith('dist'+path.sep)&&!relative.startsWith('scripts'+path.sep))throw new Error('recovery-runtime-source-invalid');
    copy(file,relative);const source=fileBytes(file).toString();
    for(const name of specifiers(source)){
      if(isBuiltin(name))continue;
      if(name.startsWith('.'))graph(path.resolve(path.dirname(file),name));
      else {const p=packageName(name),resolved=createRequire(file).resolve(name);externals.set(p,packageRoot(resolved,p));}
    }
  };
  const packageCopies=new Set<string>(),globalPackages=new Map<string,string>();
  const copyPackage=(source:string,destination:string,ancestors:Set<string>,depth=0)=>{
    source=fs.realpathSync(source);if(depth>32||ancestors.has(source))throw new Error('recovery-runtime-dependency-cycle');
    const marker=source+'\0'+destination;if(packageCopies.has(marker))return;packageCopies.add(marker);
    const walk=(dir:string,relative='')=>{
      for(const item of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
        if(['node_modules','.git','node_gyp_bins','obj.target'].includes(item.name))continue;
        const from=path.join(dir,item.name),to=path.join(destination,relative,item.name);
        if(item.isDirectory())walk(from,path.join(relative,item.name));
        else if(item.isSymbolicLink()){
          const real=fs.realpathSync(from);if(!real.startsWith(source+path.sep))throw new Error('recovery-runtime-dependency-symlink');
          if(!fs.statSync(real).isFile())throw new Error('recovery-runtime-dependency-symlink');copy(real,to,!!(fs.statSync(real).mode&0o111));
        }else copy(from,to,!!(fs.statSync(from).mode&0o111));
      }
    };
    walk(source);const manifest=JSON.parse(fileBytes(path.join(source,'package.json')).toString()),nextAncestors=new Set([...ancestors,source]);
    const dependencies={...manifest.dependencies,...manifest.optionalDependencies}as Record<string,string>;
    for(const name of Object.keys(dependencies??{}).sort()){
      if(isBuiltin(name))continue;
      let dependency:string;
      try{dependency=packageRoot(createRequire(path.join(source,'package.json')).resolve(name),name);}catch(error){if(manifest.optionalDependencies?.[name])continue;throw error;}
      const prior=globalPackages.get(name);
      // A nested package can shadow the root version; install its exact resolved
      // dependency locally rather than assuming the global name wins resolution.
      if(prior===dependency&&destination.split(path.sep).filter(x=>x==='node_modules').length===1)continue;
      const next=prior?path.join(destination,'node_modules',name):path.join('node_modules',name);if(!prior)globalPackages.set(name,dependency);
      copyPackage(dependency,next,nextAncestors,depth+1);
    }
  };
  try {
    const bundle=path.join(sourceRoot,'dist','recovery');
    for(const name of fs.readdirSync(bundle).filter(name=>/^[A-Za-z0-9_-]+\.js$/.test(name)).sort())graph(path.join(bundle,name));
    graph(sourceEntrypoint);graph(path.join(sourceRoot,'scripts','recovery-update-entrypoint.mjs'));
    copy(path.join(sourceRoot,'package.json'),'package.json');
    for(const[name,pkg]of [...externals].sort(([a],[b])=>a.localeCompare(b))){if(globalPackages.has(name))continue;globalPackages.set(name,pkg);copyPackage(pkg,path.join('node_modules',name),new Set());}
    const node=fs.realpathSync(process.execPath);nodeDependencies(node);copy(node,path.join('bin','node'),true);
    // Qualification executes the copied interpreter and the actual copied native
    // binding before either route is switched. No source-package NODE_PATH or
    // preload environment is available to make an incomplete slot appear valid.
    const smoke=`const{createRequire}=await import('node:module');await import(process.argv[1]);await import(process.argv[2]);const Database=createRequire(process.argv[1])('better-sqlite3');const db=new Database(':memory:');if(db.prepare('SELECT 1 AS n').get().n!==1)throw Error('native-storage');db.close();process.stdout.write('recovery-slot-ok');`;
    const result=withSyncOp(()=>execFileSync(path.join(stage,'bin','node'),['--input-type=module','-e',smoke,pathToFileURL(path.join(stage,'dist','recovery','RecoveryEngine.js')).href,pathToFileURL(path.join(stage,'dist','recovery','RecoveryEntrypoint.js')).href],{encoding:'utf8',timeout:15000,maxBuffer:8192,cwd:stage,env:{HOME:stage,PATH:'/usr/bin:/bin',NODE_PATH:''}}));
    if(result!=='recovery-slot-ok')throw new Error('recovery-runtime-slot-smoke-failed');

    const manifestFiles=[...files].sort().map(relative=>{const data=fileBytes(path.join(stage,relative),256*1024*1024);return{path:relative,sha256:crypto.createHash('sha256').update(data).digest('hex'),size:data.length,executable:!!(fs.statSync(path.join(stage,relative)).mode&0o111)};});
    const hash=crypto.createHash('sha256');for(const entry of manifestFiles){hash.update(JSON.stringify(entry));hash.update('\n');}const digest=hash.digest('hex'),destination=path.join(root,digest);
    fs.writeFileSync(path.join(stage,'slot-manifest.json'),JSON.stringify({version:1,digest,files:manifestFiles}),{mode:0o400,flag:'wx'});
    if(fs.existsSync(destination))SafeFsExecutor.safeRmSync(stage,{recursive:true,force:true,operation:'recovery-slot:discard-identical-staging-copy'});else fs.renameSync(stage,destination);
    SafeFsExecutor.safeUnlinkSync(stage+'.owner.json',{operation:'recovery-slot:finish-allocation'});
    return verifyRecoveryRuntimeSlot({version:1,directory:destination,node:path.join(destination,'bin','node'),entrypoint:path.join(destination,'scripts','recovery-entrypoint.mjs'),updateEntrypoint:path.join(destination,'scripts','recovery-update-entrypoint.mjs'),digest},stateDir,true);
  } catch(error){if(fs.existsSync(stage))SafeFsExecutor.safeRmSync(stage,{recursive:true,force:true,operation:'recovery-slot:discard-failed-staging-copy'});if(fs.existsSync(stage+'.owner.json'))SafeFsExecutor.safeUnlinkSync(stage+'.owner.json',{operation:'recovery-slot:discard-failed-allocation'});throw error;}
}

/** Explicit local operator cleanup. Never a remote recovery verb. Keep every
 * current/prior/transaction reference and candidates newer than one day. */
export function cleanupRecoveryRuntimeSlots(configFile:string,now=Date.now()):{removed:string[];retained:string[]} {
  const configStat=fs.lstatSync(configFile);if(configStat.uid!==process.getuid?.()||(configStat.mode&0o077))throw new Error('recovery-runtime-cleanup-config-invalid');
  const configBytes=fileBytes(configFile,131072).toString(),c=JSON.parse(configBytes);
  if(!path.isAbsolute(configFile)||configFile!==path.join(path.dirname(c.stateDir),'host.json'))throw new Error('recovery-runtime-cleanup-config-invalid');
  const bootId=process.platform==='darwin'?withSyncOp(()=>execFileSync('/usr/sbin/sysctl',['-n','kern.bootsessionuuid'],{encoding:'utf8',timeout:3000,maxBuffer:1024})).trim():process.platform==='linux'?fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim():'';
  if(!bootId)throw new Error('recovery-runtime-cleanup-host-unsupported');
  const admission=new RecoveryAdmission({stateDir:c.stateDir,agentId:c.agentId,machineId:c.machineId,certificationRoot:c.certificationRoot,bootId});
  try{return admission.withOwnedBindingWrite(()=>{
    if(fileBytes(configFile,131072).toString()!==configBytes)throw new Error('recovery-install-config-changed');
    const root=path.join(path.dirname(c.stateDir),'runtime-slots');directory(root);const keep=new Set<string>();
    const collect=(value:unknown):void=>{
      if(typeof value==='string'){
        for(const match of value.matchAll(new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/([a-f0-9]{64})(?:/|["\\\\]|$)','g')))keep.add(match[1]);
        if(value.trimStart().startsWith('{')){
          let embedded:unknown;
          try{embedded=JSON.parse(value);}catch{throw new Error('recovery-runtime-cleanup-reference-invalid');}
          collect(embedded);
        }
      }else if(value&&typeof value==='object')for(const item of Object.values(value))collect(item);
    };
    collect(c);
    const transactions=[path.join(path.dirname(c.stateDir),'main-update.json'),...(c.watchdog?.script?[path.join(path.dirname(c.watchdog.script),'recovery-fleet-update.json')]:[])];
    for(const file of transactions)if(fs.existsSync(file))collect(JSON.parse(fileBytes(file,1048576).toString()));
    const removed:string[]=[],retained:string[]=[];
    for(const name of new Set(fs.readdirSync(root).map(name=>name.replace(/\.owner\.json$/,'')))){
      if(!HASH.test(name)&&!name.startsWith('.staging-'))continue;
      const dir=path.join(root,name),exists=fs.existsSync(dir),st=fs.lstatSync(exists?dir:dir+'.owner.json');if((exists&&!st.isDirectory())||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o077))throw new Error('recovery-runtime-slot-ownership-invalid');
      if(keep.has(name)||now-st.mtimeMs<86400000){retained.push(name);continue;}
      if(name.startsWith('.staging-')){
        const owner=JSON.parse(fileBytes(dir+'.owner.json',4096).toString());
        if(!Number.isSafeInteger(owner.pid)||owner.pid<=0||!(owner.birth===null||(Number.isFinite(owner.birth)&&owner.birth>0))){retained.push(name);continue;}let dead=false;
        try{process.kill(owner.pid,0);}catch(error){dead=(error as NodeJS.ErrnoException).code==='ESRCH';}
        if(!dead){const birth=processStartMs(owner.pid);dead=birth!==null&&owner.birth!==null&&birth!==owner.birth;}
        if(!dead){retained.push(name);continue;}
      }else verifyRecoveryRuntimeSlot({version:1,directory:dir,node:path.join(dir,'bin','node'),entrypoint:path.join(dir,'scripts','recovery-entrypoint.mjs'),updateEntrypoint:path.join(dir,'scripts','recovery-update-entrypoint.mjs'),digest:name},c.stateDir,true);
      if(exists)SafeFsExecutor.safeRmSync(dir,{recursive:true,force:false,operation:'recovery-slot:operator-remove-unreferenced-owned-runtime'});
      if(name.startsWith('.staging-'))SafeFsExecutor.safeUnlinkSync(dir+'.owner.json',{operation:'recovery-slot:operator-remove-dead-allocation'});removed.push(name);
    }
    return{removed,retained};
  });}finally{admission.close();}
}
