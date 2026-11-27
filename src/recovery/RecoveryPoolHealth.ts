/** Signed MachineAuth session-status carries each source's independently verified proof projection. */
import { currentRecoveryStatus, type RecoveryRuntimeStatus } from './RecoveryRuntime.js';
const observations=new Map<string,{status:RecoveryRuntimeStatus;receivedAt:number}>();
export function observeRecoveryPeer(machineId:string,input:unknown,now=Date.now()):void {
  if(!input||typeof input!=='object')return;
  const status=input as RecoveryRuntimeStatus;
  if(status.scope!=='source-machine'||status.sourceMachineId!==machineId||!Array.isArray(status.targets)||status.targets.length>128)return;
  // Keep only the bounded source projection. No credential, address or diagnostic
  // output crosses into the pool surface, even if a paired source is malformed.
  const targets:RecoveryRuntimeStatus['targets']=[];
  for(const target of status.targets) {
    if(typeof target?.machineId!=='string'||target.machineId.length>128||target.machineId===machineId)continue;
    const routes={} as RecoveryRuntimeStatus['targets'][number]['routes'];
    for(const route of ['ssh','relay'] as const) {
      const p=target.routes?.[route];
      const current=Number.isSafeInteger(p?.pairingEpoch)&&Number.isSafeInteger(p?.credentialGeneration)&&typeof p?.bootId==='string'&&typeof p?.targetKeyFingerprint==='string'&&p.credentialGeneration===status.credentialGeneration&&p?.state==='proven'&&p.sourceMachineId===machineId&&Number.isSafeInteger(p.observedAt)&&Number.isSafeInteger(p.expiresAt)
        &&p.observedAt!>now-300_000&&p.observedAt!<=now+30_000&&p.expiresAt!>now&&p.expiresAt!-p.observedAt!<=300_000;
      routes[route]={state:current?'proven':'unknown',observedAt:current?p.observedAt:null,expiresAt:current?p.expiresAt:null,sourceMachineId:machineId,pairingEpoch:current?p.pairingEpoch:null,credentialGeneration:current?p.credentialGeneration:null,bootId:current?p.bootId:null,targetKeyFingerprint:current?p.targetKeyFingerprint:null};
    }
    const ready=status.enabled===true&&target.ready===true&&routes.ssh.state==='proven'&&routes.relay.state==='proven';
    targets.push({machineId:target.machineId,ready,reason:ready?'two-fresh-independent-peer-proofs':'missing-fresh-peer-proof',routes});
  }
  if(!observations.has(machineId)&&observations.size>=128)observations.delete(observations.keys().next().value!);
  observations.set(machineId,{status:{scope:'source-machine',sourceMachineId:machineId,credentialGeneration:status.credentialGeneration,listenerKeys:status.listenerKeys,enabled:status.enabled===true,ready:false,reason:'source-observed',commonDependencies:[],targets},receivedAt:now});
}
export function recoveryPoolHealth(selfMachineId:string|null,roster:string[],now=Date.now(),membership?:Record<string,number>) {
  const local=currentRecoveryStatus(),ids=[...new Set([...(selfMachineId?[selfMachineId]:[]),...roster])].sort();
  const sources=ids.map(id=>{
    const observation=id===selfMachineId&&'sourceMachineId'in local?{status:local,receivedAt:now}:observations.get(id);
    return {machineId:id,status:observation&&now-observation.receivedAt<300_000?observation.status:null};
  });
  const targets=ids.map(target=>{
    const targetKeys=sources.find(s=>s.machineId===target)?.status?.listenerKeys;
    const targetProofs=sources.flatMap(s=>s.status?.targets.filter(p=>p.machineId===target).flatMap(p=>(['ssh','relay'] as const).flatMap(r=>p.routes[r].observedAt===null?[]:[p.routes[r]]))??[]);
    const conflictingBoots=new Set(targetProofs.filter(p=>p.state==='proven').map(p=>p.bootId)).size>1;
    const boot=[...targetProofs].sort((a,b)=>(b.observedAt??0)-(a.observedAt??0))[0]?.bootId;
    // Both routes must have been proved by the same source. Never stitch two
    // half-proofs from observers with different reachability into redundancy.
    const from=sources.filter(s=>!conflictingBoots&&s.machineId!==target&&s.status?.targets.some(p=>p.machineId===target&&p.ready&&(['ssh','relay'] as const).every(route=>{
      const proof=p.routes[route],expectedEpoch=membership?Math.max(membership[s.machineId]??NaN,membership[target]??NaN):proof.pairingEpoch;return proof.pairingEpoch===expectedEpoch&&proof.credentialGeneration===s.status?.credentialGeneration&&proof.bootId===boot&&(!targetKeys||proof.targetKeyFingerprint===targetKeys[route])&&proof.state==='proven'&&proof.expiresAt!==null&&proof.expiresAt>now&&proof.observedAt!==null&&now-proof.observedAt<300_000;
    }))).map(s=>s.machineId);
    return {machineId:target,ready:from.length>0,testedSources:from,reason:from.length?'two-fresh-independent-peer-proofs':conflictingBoots?'target-boot-observations-disagree':'missing-fresh-peer-proof'};
  });
  return {scope:'pool' as const,ready:ids.length>1&&targets.every(t=>t.ready),targets,
    sources:sources.map(s=>({machineId:s.machineId,state:s.status?'observed':'unknown'})),
    commonDependencies:['target operating system','target host network','24-hour authority lease']};
}
