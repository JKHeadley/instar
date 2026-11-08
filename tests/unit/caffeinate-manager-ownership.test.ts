import {afterEach,describe,expect,it,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
const fake=vi.hoisted(()=>({spawn:vi.fn(),spawnSync:vi.fn()}));
vi.mock('child_process',()=>({spawn:fake.spawn,spawnSync:fake.spawnSync}));
import {CaffeinateManager} from '../../src/core/CaffeinateManager.js';
describe('sleep assertion ownership during recovery restarts',()=>{
 let dir:string;
 afterEach(()=>{vi.restoreAllMocks();fake.spawn.mockReset();fake.spawnSync.mockReset();if(dir)SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'caffeinate-ownership:cleanup'});});
 const child=(pid:number)=>Object.assign(new EventEmitter(),{pid,unref:vi.fn(),kill:vi.fn()});
 it('never enumerates or kills another agent helper when reclaiming its own stale record',()=>{
  dir=fs.mkdtempSync(path.join(os.tmpdir(),'caffeinate-ownership-'));
  fs.writeFileSync(path.join(dir,'caffeinate.pid'),'43210');
  fake.spawnSync.mockReturnValue({stdout:'43210\n54321\n'});
  const kill=vi.spyOn(process,'kill').mockReturnValue(true);
  (new CaffeinateManager({stateDir:dir}) as any).cleanupStale();
  expect(fake.spawnSync).not.toHaveBeenCalled();expect(kill).not.toHaveBeenCalled();
 });
 it('binds the assertion to its actual server lifetime and stops only its own child handle',()=>{
  dir=fs.mkdtempSync(path.join(os.tmpdir(),'caffeinate-parent-'));
  const proc=child(43210);fake.spawn.mockReturnValue(proc);
  const manager=new CaffeinateManager({stateDir:dir});
  (manager as any).spawnCaffeinate();
  expect(fake.spawn).toHaveBeenCalledWith('caffeinate',['-s','-w',String(process.pid)],expect.any(Object));
  manager.stop();expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
 });
 it('does not let a delayed old exit erase a replacement helper',()=>{
  dir=fs.mkdtempSync(path.join(os.tmpdir(),'caffeinate-late-exit-'));
  const old=child(43210),replacement=child(54321);fake.spawn.mockReturnValueOnce(old).mockReturnValueOnce(replacement);
  const manager=new CaffeinateManager({stateDir:dir});
  (manager as any).spawnCaffeinate();(manager as any).spawnCaffeinate();old.emit('exit',0,null);
  expect(manager.getStatus().pid).toBe(54321);manager.stop();
 });
});
