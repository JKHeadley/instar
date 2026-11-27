import {it,expect} from 'vitest';
import {setupGraphDefaultPlannedTransition} from '../helpers/graph-default-planned-transition.js';
import {canonicalHash} from '../../src/core/GraphWitnessTypes.js';
it('exports an actual nonempty planned M2 with both original members retained for subsequent recovery',async()=>{
 const started=performance.now();
 const fixture=await setupGraphDefaultPlannedTransition({onPhase:phase=>console.error(JSON.stringify({plannedPhase:phase,elapsedMs:Math.round(performance.now()-started)}))});try{
  expect(fixture.newMembership.members).toEqual(fixture.oldMembership.members);
  expect(fixture.newMembership.epoch).toBe(2);expect(fixture.records.length).toBeGreaterThanOrEqual(2);
  for(const manager of fixture.defaults){const parts=manager.memberLossPlanningComponents();expect(parts).not.toBeNull();expect(parts!.authority.currentMembership()).toEqual(fixture.newMembership);expect(parts!.authority.verifiedNegativeRoleLineage().activations.some(row=>canonicalHash(row.certificate)===canonicalHash(fixture.activation))).toBe(true);expect(await manager.runtime!.refreshReadiness()).toBe(true);}
  expect((await fixture.request(1,'/conversation-graph/changes/act-kept-effort')).body.state).toBe('committed');
 }finally{await fixture.cleanup();}
},120000);
