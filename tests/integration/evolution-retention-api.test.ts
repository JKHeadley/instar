// safe-fs-allow: temporary test fixture cleanup only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EvolutionManager } from '../../src/core/EvolutionManager.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
const dirs:string[]=[];
afterEach(()=>{vi.unstubAllGlobals();for(const d of dirs.splice(0))SafeFsExecutor.safeRmSync(d,{recursive:true,force:true,operation:'evo022-http-cleanup'});});
function harness(extra:Partial<RouteContext>={}) {
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'evo022-api-'));dirs.push(d);
 const evolution=new EvolutionManager({stateDir:d,retentionTargets:{actions:1,learnings:0}});
 const ctx={config:{authToken:'test-token',stateDir:d,projectDir:d,port:0,multiMachine:{peerUrlAllowlist:['https://peer.example.test']}}, evolution,classReviewStore:null,startTime:new Date(), ...extra} as unknown as RouteContext;
 const app=express();app.use(express.json());app.use(createRoutes(ctx));return {app,evolution,d};
}
describe('EVO-022 real route pipeline',()=>{
 it('archives the terminal action at active saturation; stats, content and restore remain usable over HTTP',async()=>{
  const {app,evolution}=harness();
  const done=evolution.addAction({title:'done',description:'complete content'});evolution.updateAction(done.id,{status:'completed'});
  const active=await request(app).post('/evolution/actions').send({title:'open',description:'still owed',dueBy:'2099-01-01T00:00:00Z'});expect(active.status).toBe(201);
  const report=await request(app).get('/evolution/retention?scope=local');expect(report.body.stores.actions).toMatchObject({total:1,active:1,terminalRetained:0,target:1,overflow:0});
  const archive=await request(app).get(`/evolution/archive?kind=actions&id=${done.id}`);expect(archive.status).toBe(200);expect(archive.body.entries[0].record).toEqual({...done,status:'completed',completedAt:expect.any(String)});
  expect((await request(app).post(`/evolution/actions/${done.id}/restore`)).status).toBe(200);
  expect(evolution.listActions().map(a=>a.id)).toEqual(expect.arrayContaining([done.id,active.body.id]));
 });
 it('bounds archive pages and rejects malformed page queries without writes',async()=>{
  const {app,evolution,d}=harness();for(let i=0;i<3;i++){const l=evolution.addLearning({title:`lesson ${i}`,description:'full',category:'infra',source:{discoveredAt:'2026-01-01T00:00:00Z'}});evolution.markLearningApplied(l.id,'verified');}
  const file=path.join(d,'state/evolution/action-archive.json'),before=fs.readFileSync(file,'utf8');
  const first=await request(app).get('/evolution/archive?limit=1');expect(first.body.entries).toHaveLength(1);expect(first.body.nextOffset).toBe(1);
  const second=await request(app).get('/evolution/archive?limit=1&offset=1');expect(second.body.entries[0].digest).not.toBe(first.body.entries[0].digest);
  for(const query of ['limit=0','offset=-1','limit=51','kind=unknown'])expect((await request(app).get('/evolution/archive?'+query)).status).toBe(400);
  expect(fs.readFileSync(file,'utf8')).toBe(before);
 });
 it('reports corrupted state as unknown; archive corruption returns unavailable',async()=>{
  const {app,d}=harness();fs.mkdirSync(path.join(d,'state/evolution'),{recursive:true});fs.writeFileSync(path.join(d,'state/evolution/action-queue.json'),'{broken');
  expect((await request(app).get('/evolution/retention?scope=local')).body.stores.actions.status).toBe('unknown');
  fs.writeFileSync(path.join(d,'state/evolution/action-archive.json'),'{broken');expect((await request(app).get('/evolution/archive')).status).toBe(503);
 });
 it('pool coverage does not pretend unreachable peers are healthy or empty',async()=>{
  const {app}=harness({meshSelfId:'self',listPoolMachines:()=>[{machineId:'offline',lastKnownUrl:null}]});
  const r=await request(app).get('/evolution/retention');expect(r.status).toBe(200);expect(r.body.complete).toBe(false);expect(r.body.failed).toContainEqual({machineId:'offline',error:'no-known-url'});expect(r.body.local.machineId).toBe('self');
 });
});
