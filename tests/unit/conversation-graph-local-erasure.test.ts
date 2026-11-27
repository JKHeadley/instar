import {afterEach,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
import {ConversationGraphLocalErasureFence} from '../../src/core/ConversationGraphLocalErasure.js';
import {canonicalHash,type GraphErasureIdentity} from '../../src/core/GraphWitnessTypes.js';

const directories:string[]=[];
const home=()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'graph-local-erasure-'));directories.push(dir);return dir;};
afterEach(()=>{vi.restoreAllMocks();for(const dir of directories.splice(0))SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'graph-local-erasure-test:cleanup'});});
describe('owner-local erasure fence',()=>{
 it('retains durable logical targets across live instances and isolates unrelated targets',async()=>{
  const dir=home();const target:GraphErasureIdentity={sourceKind:'header',sourceId:'hdr-abcdefghijklmnop'};
  const fence=new ConversationGraphLocalErasureFence(dir);
  expect(fence.isDenied(target)).toBe(false);
  await fence.deny(target);
  target.sourceId='hdr-otherabcdefghijkl';
  const restored=new ConversationGraphLocalErasureFence(dir);
  expect(restored.isDenied({sourceKind:'header',sourceId:'hdr-abcdefghijklmnop'})).toBe(true);expect(restored.durableTargets()).toContainEqual({sourceKind:'header',sourceId:'hdr-abcdefghijklmnop'});
  expect(restored.isDenied(target)).toBe(false);
  const exposed=restored.targets();exposed[0].sourceId='mutated';
  expect(restored.targets()[0].sourceId).toBe('hdr-abcdefghijklmnop');
 });
 it('fails closed on corrupt or misnamed durable fences',async()=>{
  const dir=home();const fence=new ConversationGraphLocalErasureFence(dir);
  const target:GraphErasureIdentity={sourceKind:'conversation-metadata',sourceId:'a'.repeat(64)};
  await fence.deny(target);
  fs.writeFileSync(path.join(dir,'conversation-graph','local-erasure-intents',`${canonicalHash(target)}.json`),'{}');
  const restored=new ConversationGraphLocalErasureFence(dir);
  expect(restored.isDenied({sourceKind:'header',sourceId:'hdr-unrelatedabcdefg'})).toBe(true);
  await expect(restored.refresh()).rejects.toThrow('local-erasure-fence-unavailable');
 });
 it('does not acknowledge persistence failure but suppresses content in the current process',async()=>{
  const dir=home();fs.writeFileSync(path.join(dir,'conversation-graph'),'not a directory');
  const fence=new ConversationGraphLocalErasureFence(dir);
  const target:GraphErasureIdentity={sourceKind:'header',sourceId:'hdr-abcdefghijklmnop'};
  await expect(fence.deny(target)).rejects.toThrow();
  expect(fence.isDenied(target)).toBe(true);
 });
 it('shares synchronous negative acceptance across realpath aliases without inventing durable publication',async()=>{
  const dir=home(),aliasParent=home(),alias=path.join(aliasParent,'alias');fs.symlinkSync(dir,alias,'dir');
  const first=new ConversationGraphLocalErasureFence(dir),second=new ConversationGraphLocalErasureFence(alias),target:GraphErasureIdentity={sourceKind:'header',sourceId:'hdr-live-two-instances'};
  const fault=vi.spyOn(fs.promises,'mkdir').mockRejectedValueOnce(new Error('injected-fence-directory-failure'));
  expect(first.stateRoot).toBe(fs.realpathSync(dir));expect(second.stateRoot).toBe(first.stateRoot);const failed=second.deny(target);expect(first.isDenied(target)).toBe(true);await expect(failed).rejects.toThrow('injected-fence-directory-failure');fault.mockRestore();
  expect(first.targets()).toContainEqual(target);expect(()=>new ConversationGraphLocalErasureFence(dir).durableTargets()).toThrow('not-durable');
  expect(first.isDenied({sourceKind:'header',sourceId:'hdr-unrelated-target'})).toBe(false);
  await second.deny(target);expect(first.durableTargets()).toContainEqual(target);
  SafeFsExecutor.safeRmSync(path.join(dir,'conversation-graph','local-erasure-intents',`${canonicalHash(target)}.json`),{force:true,operation:'local-erasure-test:remove-durable-intent'});await second.refresh();expect(first.isDenied(target)).toBe(true);expect(()=>first.durableTargets()).toThrow('not-durable');
 });
 it('shares corrupt-root failure and rejects changed root identity rather than resetting live negatives',async()=>{
  const dir=home(),first=new ConversationGraphLocalErasureFence(dir),second=new ConversationGraphLocalErasureFence(dir),target:GraphErasureIdentity={sourceKind:'header',sourceId:'hdr-live-corrupt'};
  await first.deny(target);fs.writeFileSync(path.join(dir,'conversation-graph','local-erasure-intents',`${canonicalHash(target)}.json`),'{}');await expect(second.refresh()).rejects.toThrow('unavailable');expect(first.isDenied({sourceKind:'header',sourceId:'hdr-other-before-corrupt'})).toBe(true);
  const clean=home(),old=new ConversationGraphLocalErasureFence(clean),parked=clean+'-parked';directories.push(parked);fs.renameSync(clean,parked);fs.mkdirSync(clean);
  expect(old.isDenied(target)).toBe(true);expect(new ConversationGraphLocalErasureFence(clean).isDenied(target)).toBe(true);expect(()=>old.durableTargets()).toThrow('unavailable');expect(()=>old.stateRoot).toThrow('unavailable');
 });

});
