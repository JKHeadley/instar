import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterAll,describe,expect,it} from 'vitest';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
import {durableStamp,flushDescriptorOnce,isDurablyUnchanged,rememberDurable} from '../../src/core/GraphDurableFileMemo.js';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'graph-memo-'));
afterAll(()=>SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'tests/unit/graph-durable-file-memo'}));
describe('durable file memo',()=>{
 it('only trusts a file this process flushed',()=>{const f=path.join(dir,'a');fs.writeFileSync(f,'x');expect(isDurablyUnchanged(f)).toBe(false);rememberDurable(f,durableStamp(f));expect(isDurablyUnchanged(f)).toBe(true);});
 it('flushes again after new bytes',()=>{const f=path.join(dir,'b');fs.writeFileSync(f,'x');rememberDurable(f,durableStamp(f));fs.writeFileSync(f,'yy');expect(isDurablyUnchanged(f)).toBe(false);});
 it('flushes again when replaced by rename, even with the same bytes',()=>{const f=path.join(dir,'c'),g=path.join(dir,'c2');fs.writeFileSync(f,'x');rememberDurable(f,durableStamp(f));fs.writeFileSync(g,'x');fs.renameSync(g,f);expect(isDurablyUnchanged(f)).toBe(false);});
 it('never remembers a write that raced the flush',()=>{const f=path.join(dir,'e');fs.writeFileSync(f,'x');const stamp=durableStamp(f);fs.writeFileSync(f,'raced');rememberDurable(f,stamp);expect(isDurablyUnchanged(f)).toBe(false);});
 it('flushes a directory again after a new entry',()=>{const d=path.join(dir,'sub');fs.mkdirSync(d);rememberDurable(d,durableStamp(d));expect(isDurablyUnchanged(d)).toBe(true);fs.writeFileSync(path.join(d,'n'),'x');expect(isDurablyUnchanged(d)).toBe(false);});
 it('does not credit a replacement made after the descriptor opened',()=>{const f=path.join(dir,'f'),g=path.join(dir,'f2');fs.writeFileSync(f,'old');const fd=fs.openSync(f,'r');fs.writeFileSync(g,'new');fs.renameSync(g,f);flushDescriptorOnce(f,fd);fs.closeSync(fd);expect(isDurablyUnchanged(f)).toBe(false);});
 it('credits the file a descriptor really flushed',()=>{const f=path.join(dir,'h');fs.writeFileSync(f,'x');const fd=fs.openSync(f,'r');flushDescriptorOnce(f,fd);fs.closeSync(fd);expect(isDurablyUnchanged(f)).toBe(true);});
 it('treats a deleted file as not durable',()=>{const f=path.join(dir,'d');fs.writeFileSync(f,'x');rememberDurable(f,durableStamp(f));SafeFsExecutor.safeUnlinkSync(f,{operation:'tests/unit/graph-durable-file-memo'});expect(isDurablyUnchanged(f)).toBe(false);});
});
