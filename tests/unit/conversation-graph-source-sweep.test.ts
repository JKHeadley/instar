import {describe,it,expect} from 'vitest';
import {canonicalHash} from '../../src/core/GraphWitnessTypes.js';
import {validateGraphSourceSweepPayload,sourceSweepPageHash,type GraphSourceSweepPayload} from '../../src/core/ConversationGraphSourceSweep.js';
function empty():GraphSourceSweepPayload{const frontier={registrationsHash:canonicalHash([]),appEventWatermark:0,slackSequence:0};return {v:1,sourceId:'empty-source',scanId:'empty-scan',producerMachineId:'producer',startedAt:'2026-11-05T10:00:00.000Z',completedAt:'2026-11-05T10:00:01.000Z',status:'complete',partialReasons:[],expected:[],entries:[],pages:[{index:0,afterHash:canonicalHash(null),nextHash:canonicalHash(null),observationsHash:sourceSweepPageHash([],0),observedCount:0}],before:frontier,after:frontier};}
describe('bounded content-free inventory checkpoint schema',()=>{
 it('represents a legitimate complete empty inventory explicitly',()=>expect(validateGraphSourceSweepPayload(empty())).not.toBeNull());
 it('rejects title, alias and salt fields at every structural level',()=>{
  for(const mutate of [(p:any)=>p.title='secret',(p:any)=>p.pages[0].alias=-7,(p:any)=>p.after.salt='secret']){const p=empty();mutate(p);expect(validateGraphSourceSweepPayload(p)).toBeNull();}
 });
 it('refuses a completeness claim with a missing page, changed frontier or partial reason',()=>{
  const a=empty();a.pages[0].nextHash=canonicalHash('next');expect(validateGraphSourceSweepPayload(a)).toBeNull();
  const b=empty();b.after={...b.after,appEventWatermark:1};expect(validateGraphSourceSweepPayload(b)).toBeNull();
  const c=empty();c.partialReasons=['capacity'];expect(validateGraphSourceSweepPayload(c)).toBeNull();
 });
 it('accepts an explicit bounded partial scan without granting complete coverage',()=>{const p=empty();p.status='partial';p.partialReasons=['registration-unavailable'];expect(validateGraphSourceSweepPayload(p)?.status).toBe('partial');});
});
