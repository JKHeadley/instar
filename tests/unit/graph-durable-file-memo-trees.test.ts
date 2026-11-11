import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {flushDescriptorOnce,flushTreesDurably,isDurablyUnchanged} from '../../src/core/GraphDurableFileMemo.js';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
const dirs:string[]=[];const home=()=>{const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'graph-flush-')));dirs.push(dir);return dir;};
afterEach(()=>{vi.restoreAllMocks();for(const dir of dirs.splice(0))SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'tests/unit/graph-durable-file-memo-trees.test.ts'});});
describe('flushTreesDurably',()=>{
 it('flushes nested files and later checks do not flush them again',async()=>{
  const root=home(),file=path.join(root,'a','b.json');fs.mkdirSync(path.dirname(file));fs.writeFileSync(file,'{}');
  expect(await flushTreesDurably([root])).toBe(1);expect(isDurablyUnchanged(file)).toBe(true);
  const fsync=vi.spyOn(fs,'fsyncSync'),fd=fs.openSync(file,'r');try{flushDescriptorOnce(file,fd);}finally{fs.closeSync(fd);}
  expect(fsync).not.toHaveBeenCalled();
  expect(await flushTreesDurably([root])).toBe(0);
 });
 it('never trusts a file changed after the flush',async()=>{
  const root=home(),file=path.join(root,'c.json');fs.writeFileSync(file,'{}');await flushTreesDurably([root]);
  fs.writeFileSync(file,'{"changed":true}');expect(isDurablyUnchanged(file)).toBe(false);
  const fsync=vi.spyOn(fs,'fsyncSync'),fd=fs.openSync(file,'r');try{flushDescriptorOnce(file,fd);}finally{fs.closeSync(fd);}
  expect(fsync).toHaveBeenCalledTimes(1);
 });
 it('skips a missing directory and does not follow a link',async()=>{
  const root=home(),outside=path.join(home(),'o.json');fs.writeFileSync(outside,'{}');fs.symlinkSync(outside,path.join(root,'link.json'));
  expect(await flushTreesDurably([path.join(root,'absent'),root])).toBe(0);expect(isDurablyUnchanged(path.join(root,'link.json'))).toBe(false);
 });
});
