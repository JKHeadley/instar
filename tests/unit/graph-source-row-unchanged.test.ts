import {describe,expect,it} from 'vitest';
import {GRAPH_SOURCE_ACTIVITY_REFRESH_MS,graphSourceRowUnchanged,type GraphSourceFlatRow} from '../../src/core/ConversationGraphSourceInventory.js';
const at=(ms:number)=>new Date(Date.parse('2026-11-01T00:00:00.000Z')+ms).toISOString();
const row=(over:Partial<GraphSourceFlatRow>={}):GraphSourceFlatRow=>({id:42,platform:'telegram',title:'Topic',lastActivity:at(0),...over} as GraphSourceFlatRow);
describe('graphSourceRowUnchanged',()=>{
 it('adds no record for ordinary new messages',()=>{
  expect(graphSourceRowUnchanged(row(),row())).toBe(true);
  expect(graphSourceRowUnchanged(row(),row({lastActivity:at(60_000)}))).toBe(true);
  expect(graphSourceRowUnchanged(row(),row({lastActivity:at(GRAPH_SOURCE_ACTIVITY_REFRESH_MS-1)}))).toBe(true);
 });
 it('adds one record once the signed activity is a week behind',()=>{
  expect(graphSourceRowUnchanged(row(),row({lastActivity:at(GRAPH_SOURCE_ACTIVITY_REFRESH_MS)}))).toBe(false);
 });
 it('adds a record for a real change of the row',()=>{
  expect(graphSourceRowUnchanged(row(),row({title:'Renamed'}))).toBe(false);
  expect(graphSourceRowUnchanged(row(),row({id:43}))).toBe(false);
  expect(graphSourceRowUnchanged(row(),row({machine:'m_other'} as Partial<GraphSourceFlatRow>))).toBe(false);
 });
 it('records first activity once, and a missing time is no change',()=>{
  expect(graphSourceRowUnchanged(row({lastActivity:null}),row())).toBe(false);
  expect(graphSourceRowUnchanged(row(),row({lastActivity:null}))).toBe(true);
  expect(graphSourceRowUnchanged(row({lastActivity:null}),row({lastActivity:null}))).toBe(true);
 });
});
