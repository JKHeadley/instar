/** Canonical owner-intent shape shared by local sealed intake and admitted changes.
 * Structural validation grants no owner or write authority. */
import {exactFields} from './GraphWitnessTypes.js';
import {validateNodeRef,type NodeRef} from './conversationGraph.js';
import {canonicalTitle} from './EffortHeaderStore.js';

export type GraphOwnerChange =
 | {kind:'set-primary-placement';subject:NodeRef;parent:NodeRef|null;replacesPlacementEventIds:string[]}
 | {kind:'set-front-door';effort:NodeRef;conversation:NodeRef|null;replacesFrontDoorEventIds:string[];observedPlacementEventIds:string[]}
 | {kind:'create-effort';projectScope:string[]}
 | {kind:'set-effort-title';effort:NodeRef;baseVersion:number;title:string};
const ids=(value:unknown):value is string[]=>Array.isArray(value)&&value.length<=32&&value.every(x=>typeof x==='string'&&/^[A-Za-z0-9_-]{8,80}$/.test(x));
export function parseGraphOwnerChange(raw:unknown):GraphOwnerChange|null{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
 const value=raw as Record<string,unknown>,subject=validateNodeRef(value.subject);
 if(value.kind==='set-primary-placement'&&exactFields(value,['kind','subject','parent','replacesPlacementEventIds'])&&subject&&ids(value.replacesPlacementEventIds)){
  const parent=value.parent===null?null:validateNodeRef(value.parent);if(value.parent!==null&&!parent)return null;
  return{kind:'set-primary-placement',subject,parent,replacesPlacementEventIds:[...new Set(value.replacesPlacementEventIds)].sort()};
 }
 if(value.kind==='set-front-door'&&exactFields(value,['kind','effort','conversation','replacesFrontDoorEventIds','observedPlacementEventIds'])){
  const effort=validateNodeRef(value.effort),conversation=value.conversation===null?null:validateNodeRef(value.conversation);
  if(effort?.kind!=='effort'||(value.conversation!==null&&conversation?.kind!=='conversation')||!ids(value.replacesFrontDoorEventIds)||!ids(value.observedPlacementEventIds))return null;
  return{kind:'set-front-door',effort,conversation,replacesFrontDoorEventIds:[...new Set(value.replacesFrontDoorEventIds)].sort(),observedPlacementEventIds:[...new Set(value.observedPlacementEventIds)].sort()};
 }
 if(value.kind==='create-effort'&&exactFields(value,['kind','projectScope'])&&Array.isArray(value.projectScope)&&value.projectScope.length<=32
  &&value.projectScope.every(x=>typeof x==='string'&&/^[A-Za-z0-9_.:@-]{1,120}$/.test(x)))return{kind:'create-effort',projectScope:[...new Set(value.projectScope as string[])].sort()};
 if(value.kind==='set-effort-title'&&exactFields(value,['kind','effort','baseVersion','title'])){
  const effort=validateNodeRef(value.effort);if(effort?.kind!=='effort'||!Number.isSafeInteger(value.baseVersion)||Number(value.baseVersion)<0||typeof value.title!=='string')return null;
  const title=canonicalTitle(value.title);if(!title||title.length>200)return null;
  return{kind:'set-effort-title',effort,baseVersion:Number(value.baseVersion),title};
 }
 return null;
}

