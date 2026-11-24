// safe-fs-allow: test file — SafeFsExecutor owns temporary cleanup.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import request from 'supertest';import {afterEach,expect,it} from 'vitest';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
import {timingFixture} from '../helpers/local-verify-metrics-fixture.js';
const cleanup:Array<()=>void>=[];afterEach(()=>{for(const f of cleanup.splice(0))f();});
it('production service construction and boot wire one real metrics writer through HTTP, dispatch and journaled completion',async()=>{
 const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'lvmetrics-life-')));const f=timingFixture(home,true);cleanup.push(()=>{f.svc.shutdown();SafeFsExecutor.safeRmSync(home,{recursive:true,force:true,operation:'timing-life'});});
 await f.svc.boot();expect((await request(f.app).post('/local-verify').send({pr:7})).status).toBe(202);expect(f.rows()[0]).toHaveProperty('admittedAt');expect(f.rows()[0]).not.toHaveProperty('dispatchedAt');
 f.advance();f.setBusy(false);await f.svc.tick();for(let n=0;n<100&&!f.children.length;n++)await new Promise(r=>setTimeout(r,10));expect(f.children).toHaveLength(1);expect(f.rows()[0]).toHaveProperty('dispatchedAt');
 await f.finish();const row=f.rows()[0];expect(row.verdicts).toHaveLength(1);expect(row.verdicts[0]).toMatchObject({outcome:'failure',inventory:'complete',source:'run'});expect(row.pr).toBe(7);expect(row.headSha).toBe('0007'.repeat(10));expect(row.baseSha).toBe('b'.repeat(40));
 const journal=fs.readFileSync(path.join(f.stateDir,'state/local-verify/journal.jsonl'),'utf8');expect(JSON.parse(journal.trim()).record.outcome).toBe('failure');
});
