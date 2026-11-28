// safe-fs-allow: test file — SafeFsExecutor owns temporary cleanup.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import request from 'supertest';import {afterEach,expect,it} from 'vitest';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
import {LOCAL_VERIFY_LIMITS} from '../../src/localVerify/policy.js';
import {timingFixture} from '../helpers/local-verify-metrics-fixture.js';
const cleanup:Array<()=>void>=[];afterEach(()=>{for(const f of cleanup.splice(0))f();});
it('records exact published-head observation for a real HTTP capacity refusal, without inventing admission',async()=>{
 const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'lvmetrics-http-')));const f=timingFixture(home,false);cleanup.push(()=>{f.svc.shutdown();SafeFsExecutor.safeRmSync(home,{recursive:true,force:true,operation:'timing-http'});});
 for(let pr=1;pr<=LOCAL_VERIFY_LIMITS.queueCap;pr++)expect((await request(f.app).post('/local-verify').send({pr})).status).toBe(202);
 f.advance();const refused=await request(f.app).post('/local-verify').send({pr:100});expect(refused.status).toBe(429);expect(refused.body.code).toBe('queue-full');
 const first=f.rows().find((r:{pr:number})=>r.pr===100);expect(first.firstObservedPublishedHeadAt).toBe(first.requestedAt);expect(first.admittedAt).toBeUndefined();expect(first.dispatchedAt).toBeUndefined();
 f.advance();await request(f.app).post('/local-verify').send({pr:100});expect(f.rows().find((r:{pr:number})=>r.pr===100).requestedAt).toBe(first.requestedAt);expect(f.children).toHaveLength(0);
 // A queued candidate refreshed onto a new base retains a distinct truthful observation.
 f.advance();f.setBase('c'.repeat(40));expect((await request(f.app).post('/local-verify').send({pr:1})).status).toBe(202);
 const refreshed=f.rows().filter((r:{pr:number})=>r.pr===1);expect(refreshed).toHaveLength(2);
 expect(refreshed.find((r:{baseSha:string})=>r.baseSha==='c'.repeat(40))).toHaveProperty('requestedAt');
});
