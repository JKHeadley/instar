/** TEST ONLY. A private, verified independent copy of the normal production
 * build. Worktree tsc/dashboard rewrites cannot mutate this running fixture. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function files(root,relative,rows=[],hashContent=true){const file=path.join(root,relative),stat=fs.lstatSync(file);if(stat.isSymbolicLink())throw new Error('fixture-code-symlink-refused');if(stat.isDirectory()){for(const name of fs.readdirSync(file).sort())files(root,path.join(relative,name),rows,hashContent);}else if(stat.isFile())rows.push({path:relative.split(path.sep).join('/'),bytes:stat.size,executable:!!(stat.mode&0o111),...(hashContent?{sha256:sha(fs.readFileSync(file))}:{})});else throw new Error('fixture-code-file-invalid');return rows;}
async function packageFiles(repository){
 const declared=JSON.parse(fs.readFileSync(path.join(repository,'package.json'),'utf8')).files;
 if(!Array.isArray(declared)||!declared.length)throw new Error('fixture-normal-package-list-invalid');
 const roots=[...declared,...['package.json','README.md','LICENSE','LICENSE.md'].filter(name=>fs.existsSync(path.join(repository,name)))],names=[];
 for(const name of roots){if(typeof name!=='string'||path.isAbsolute(name)||name.split('/').some(part=>part==='..'||part==='')||/[?*{}]/.test(name)||name==='.claude'||name.startsWith('.instar')||name.startsWith('node_modules'))throw new Error('fixture-package-path-refused');for(const file of files(repository,name,[],false))names.push(file.path);}
 return [...new Set(names)].sort();
}
function inventory(root,names){return names.flatMap(name=>files(root,name)).sort((a,b)=>a.path.localeCompare(b.path));}
// Change detection only: path, size, mode and modification time, no content hash. Hashing the whole
// declared package (about 10,000 files) several times made startup slow and load-sensitive.
function fileMeta(root,names){return names.map(name=>{const stat=fs.lstatSync(path.join(root,name));if(!stat.isFile()||stat.isSymbolicLink())throw new Error('fixture-code-file-invalid');return{path:name,bytes:stat.size,executable:!!(stat.mode&0o111),mtimeNs:String(fs.statSync(path.join(root,name),{bigint:true}).mtimeNs)};});}
function selected(repository,critical){return critical.map(module=>{const source=path.join(repository,'src',module+'.ts'),built=path.join(repository,'dist',module+'.js');if(fs.statSync(source).mtimeMs>fs.statSync(built).mtimeMs)throw new Error('fixture-current-normal-dist-required');return{module,sourceSha256:sha(fs.readFileSync(source)),loadedDistSha256:sha(fs.readFileSync(built))};});}
function directories(root,relative,mode,filesAlreadyReadonly=false){const file=path.join(root,relative),stat=fs.lstatSync(file);if(stat.isSymbolicLink())return;if(stat.isDirectory()){fs.chmodSync(file,mode);for(const name of fs.readdirSync(file))directories(root,path.join(relative,name),mode,filesAlreadyReadonly);}else if(stat.isFile()&&mode===0o500){if(filesAlreadyReadonly){if(stat.mode&0o222)throw new Error('fixture-code-writable-copy-refused');}else fs.chmodSync(file,(stat.mode&0o111)?0o500:0o400);}}
export async function freezeGraphDist(repository,critical,onPhase=()=>{}){
 onPhase('inventory-start');const sourceBefore=selected(repository,critical),names=await packageFiles(repository),before=fileMeta(repository,names);onPhase('inventory-ready');const root=fs.mkdtempSync(path.join(os.tmpdir(),'conversation-graph-code-'));fs.chmodSync(root,0o700);let SafeFsExecutor;
 const thaw=()=>{directories(root,'',0o700);};
 try{
  onPhase('copy-start');const sourceModes=new Map(before.map(row=>[row.path,row.executable?0o500:0o400])),createdParents=new Set([root]);for(const name of names){const destination=path.join(root,name),parent=path.dirname(destination);if(!createdParents.has(parent)){fs.mkdirSync(parent,{recursive:true,mode:0o700});createdParents.add(parent);}fs.copyFileSync(path.join(repository,name),destination,fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);fs.chmodSync(destination,sourceModes.get(name)??0o400);}
  onPhase('copy-ready');
  // Existing installed dependencies only; no install/new dependency or source
  // loader. Own production dist/dashboard/package bytes are independent files.
  fs.symlinkSync(fs.realpathSync(path.join(repository,'node_modules')),path.join(root,'node_modules'),'dir');
  onPhase('guard-import-start');({SafeFsExecutor}=await import(pathToFileURL(path.join(root,'dist/core/SafeFsExecutor.js')).href));
  onPhase('guard-import-ready');const sourceAfter=selected(repository,critical),afterNames=await packageFiles(repository),after=fileMeta(repository,afterNames),copied=inventory(root,names);
  // The source did not change while it was copied (same names, sizes and times), and the copy has the
  // same names and sizes; the critical modules are also checked by content just below.
  const shape=rows=>JSON.stringify(rows.map(row=>[row.path,row.bytes,row.executable]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0));
  if(JSON.stringify(names)!==JSON.stringify(afterNames)||JSON.stringify(sourceBefore)!==JSON.stringify(sourceAfter)||JSON.stringify(before)!==JSON.stringify(after)||shape(before)!==shape(copied))throw new Error('fixture-build-changed-during-snapshot');
  const modules=sourceBefore.map(value=>{const copiedFile=copied.find(file=>file.path===`dist/${value.module}.js`);if(!copiedFile||copiedFile.sha256!==value.loadedDistSha256)throw new Error('fixture-module-snapshot-mismatch');return value;});
  const manifestPath=path.join(root,'frozen-code-manifest.json'),assetManifest={format:'isolated-declared-package-v1',assetSelection:'package-json-files-exact-declared-roots',treeSha256:sha(JSON.stringify(copied)),fileCount:copied.length,files:copied,modules};const metadata=fs.openSync(manifestPath,'wx',0o400);try{fs.writeFileSync(metadata,JSON.stringify(assetManifest));fs.fsyncSync(metadata);}finally{fs.closeSync(metadata);}
  onPhase('verify-ready');directories(root,'',0o500,true);const frozenMetadata=JSON.stringify(fileMeta(root,names));onPhase('readonly-ready');
  let closed=false;return{root,modules,identity:{manifestPath,format:'isolated-declared-package-v1',treeSha256:sha(JSON.stringify(copied)),fileCount:copied.length,createdAt:new Date().toISOString(),assetSelection:'package-json-files-exact-declared-roots',dependencyMode:'existing-node_modules-symlink',dependencyLockSha256:sha(fs.readFileSync(path.join(repository,'package-lock.json')))},moduleURL:name=>pathToFileURL(path.join(root,'dist',name+'.js')).href,
   assertUnchanged(){if(JSON.stringify(fileMeta(root,names))!==frozenMetadata)throw new Error('fixture-frozen-code-changed');},
   close(){if(closed)return;thaw();SafeFsExecutor.safeRmSync(root,{recursive:true,force:true,operation:'graph-live-fixture:frozen-public-code-cleanup'});closed=true;}};
 }catch(error){
  if(!SafeFsExecutor&&fs.existsSync(path.join(root,'dist/core/SafeFsExecutor.js')))try{({SafeFsExecutor}=await import(pathToFileURL(path.join(root,'dist/core/SafeFsExecutor.js')).href));}catch{/* public-code-only incomplete copy has no service/keys/admission; startup remains refused */}
  if(SafeFsExecutor){thaw();SafeFsExecutor.safeRmSync(root,{recursive:true,force:true,operation:'graph-live-fixture:failed-code-snapshot-cleanup'});}throw error;
 }
}
