/** Data projection only. Actual Core signature/chain proof is tested separately. */
import {describe,it,expect} from 'vitest';
import {canonicalHash} from '../../src/core/GraphWitnessTypes.js';
import {projectGraphLossFrontierHashes as project} from '../../src/core/GraphCustodyPeerFrontier.js';
describe('recognized loss-revision gossip projection',()=>{
 it('covers all verified ancestors but advertises only latest pending intent and revision',()=>{
  const intent={cut:'original'},first={generation:1},second={generation:2},latest={generation:3};
  const hashes=[first,second,latest].map(canonicalHash),result=project({positiveCurrent:{epoch:1},memberLossIntents:[{intent,newMembership:{epoch:2},planRevision:latest,planRevisionHashes:hashes}],memberLossActivations:[]});
  expect([...result.known].sort()).toEqual([canonicalHash(intent),...hashes].sort());
  expect(result.pending).toEqual([canonicalHash(intent),canonicalHash(latest)].sort());
  expect(result.pending).not.toContain(canonicalHash(first));
 });
 it('keeps completed ACT revision provenance known without calling it pending',()=>{
  const intent={cut:'original'},revision={generation:2},result=project({positiveCurrent:{epoch:2},memberLossIntents:[],memberLossActivations:[{certificate:{memberLoss:{intent,planRevision:revision}}}]});
  expect([...result.known].sort()).toEqual([canonicalHash(intent),canonicalHash(revision)].sort());expect(result.pending).toEqual([]);
 });
 it('preserves legacy intent-only lineage without fabricating a revision',()=>{
  const intent={cut:'legacy'},result=project({positiveCurrent:{epoch:1},memberLossIntents:[{intent,newMembership:{epoch:2}}],memberLossActivations:[]});
  expect([...result.known]).toEqual([canonicalHash(intent)]);expect(result.pending).toEqual([canonicalHash(intent)]);
 });
});
