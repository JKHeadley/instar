import {describe,it,expect} from 'vitest';
import {canonicalHash} from '../../src/core/GraphWitnessTypes.js';
import {validGraphMemberLossRevisionNegativeFacts as valid,graphMemberLossRevisionPreservesNegativeFacts as preserves,type GraphMemberLossRevisionNegativeFacts} from '../../src/core/GraphMemberLossPlanRevision.js';
const target={sourceKind:'header' as const,sourceId:'header:original'};
const empty=():GraphMemberLossRevisionNegativeFacts=>({erasureHashes:[],localTargets:[]});
describe('loss plan revision negative inventory commitments',()=>{
 it('preserves never-seen local targets and verified proof commitments independently',()=>{
  const old={erasureHashes:[canonicalHash('proof')],localTargets:[target]};
  expect(valid(old)).toBe(true);expect(preserves(old,old)).toBe(true);
  expect(preserves(old,{...old,localTargets:[]})).toBe(false);
  expect(preserves(old,{...old,erasureHashes:[]})).toBe(false);
  expect(preserves(empty(),old)).toBe(true);
 });
 it('rejects duplicate, unordered, malformed and private-bearing negative facts',()=>{
  const hashes=[canonicalHash('one'),canonicalHash('two')].sort();
  expect(valid({erasureHashes:hashes,localTargets:[]})).toBe(true);
  expect(valid({erasureHashes:[...hashes].reverse(),localTargets:[]})).toBe(false);
  expect(valid({erasureHashes:[hashes[0],hashes[0]],localTargets:[]})).toBe(false);
  expect(valid({erasureHashes:[],localTargets:[target,target]})).toBe(false);
  expect(valid({erasureHashes:[],localTargets:[{...target,body:'private'} as typeof target]})).toBe(false);
  expect(valid({...empty(),privateBody:'private'} as GraphMemberLossRevisionNegativeFacts)).toBe(false);
 });
 it('keeps an intermediate negative even when the original inventory was empty',()=>{
  const original=empty(),intermediate={erasureHashes:[canonicalHash('later-deny')],localTargets:[target]},rolledBack=empty();
  expect(preserves(original,intermediate)).toBe(true);
  expect(preserves(original,rolledBack)).toBe(true);
  expect(preserves(intermediate,rolledBack)).toBe(false);
 });
});
