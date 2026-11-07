/** Real owned runtime and actual enrollment change. A recording capability
 * must never stand in for an available canonical hierarchy. */
import {describe,it,expect} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setupGraphRuntimeFixture,dirs} from '../helpers/conversation-graph-runtime.js';
import {MachineIdentityManager} from '../../src/core/MachineIdentity.js';
import {IdentityStore} from '../../src/core/IdentityStore.js';
import {ConversationGraphHeaderCustody} from '../../src/server/ConversationGraphHeaderCustody.js';
import {ConversationGraphRuntimeReadSource} from '../../src/server/ConversationGraphReadSource.js';
import {ConversationGraphReadModel} from '../../src/core/conversationGraphRead.js';

describe('actual owned recording while canonical authority is held',()=>{
 it('keeps local intake available after pairing without exposing an old or invented empty graph',async()=>{
  const actual=await setupGraphRuntimeFixture({ownedCustodyHostIndex:0});
  expect(await actual.runtime.refreshReadiness()).toBe(true);
  const source=new ConversationGraphRuntimeReadSource(actual.runtime,new ConversationGraphHeaderCustody(actual.managers[0].baseDir,actual.runtime),
   {correctionsEnabled:true,localIntentsEnabled:true});
  const model=new ConversationGraphReadModel(source),owner={principalKey:'owner:echo',grantVersion:'fixture-owner',mayView:()=>true};
  expect(model.roots(owner,{view:'overview'}).status).toBe(200);
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'graph-actual-new-pair-'));dirs.push(dir);
  const added=new MachineIdentityManager(dir);await added.generateIdentity();
  const identity=added.loadIdentity();
  new IdentityStore({stateDir:actual.managers[0].baseDir}).apply({identity,scope:'remote',actor:'pairing-trust',path:'pair'});
  actual.managers[0].registerMachine(identity,'standby');
  expect(actual.runtime.isReady()).toBe(false);
  expect(()=>actual.runtime.retainedProjection()).toThrow();
  expect(actual.runtime.canRecordLocalOwnerIntents()).toBe(true);
  expect(model.roots(owner,{view:'overview'})).toEqual({status:503,body:{code:'conversation-graph-pending',reason:'owned-custody-pending',
   capabilities:{recordLocal:true,canonical:false}}});
  expect(actual.runtime.source.recordsForRepair()).toEqual([]);
 });
});
