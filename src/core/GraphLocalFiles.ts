/** Graph-local durable files stay beneath the caller's canonical state root.
 * Reject inherited symlinks as well as leaf links before touching private state.
 */
import fs from 'node:fs';
import path from 'node:path';
export function assertGraphLocalPath(stateRoot:string,target:string):void{
 const relative=path.relative(stateRoot,target);
 if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('graph-local-path-outside-state');
 let current=stateRoot;
 for(const component of relative.split(path.sep).filter(Boolean)){
  current=path.join(current,component);
  try{if(fs.lstatSync(current).isSymbolicLink())throw new Error('graph-local-symlink-refused');}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')break;throw error;}
 }
}
export function ensureGraphLocalDirectory(stateRoot:string,directory:string):void{
 assertGraphLocalPath(stateRoot,directory);
 let current=stateRoot;
 for(const component of path.relative(stateRoot,directory).split(path.sep).filter(Boolean)){
  const parent=current;current=path.join(current,component);
  try{fs.mkdirSync(current,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  const stat=fs.lstatSync(current);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('graph-local-directory-invalid');
  const fd=fs.openSync(parent,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 }
}
