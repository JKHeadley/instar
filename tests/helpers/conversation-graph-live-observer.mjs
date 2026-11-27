/** Read-only fixture evidence. Capture the original URL before Express may
 * strip a mounted prefix. An unfinished/closed response is not a completed one. */
export function observeGraphFixtureRequest(req,res,{bind,observations,deviceAdmittedAt,deviceAdmissionIdentity,deviceAdmittedHost,erasureIds}){
 const route=new URL(req.url??'/',`http://${bind}`).pathname;if(!route.startsWith('/mobile/conversation-graph/')&&!route.startsWith('/conversation-graph/'))return;
 const startedAt=Date.now();let recorded=false;
 const record=completed=>{if(recorded)return;recorded=true;const raw=req.body?.requestId,requestId=typeof raw==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(raw)?raw:null;if(route.includes('forget-header')&&requestId)erasureIds.add(requestId);const admittedAt=deviceAdmittedAt(req);
  observations.push({method:req.method,path:route,requestId,startedAt,finishedAt:Date.now(),status:res.statusCode,responseCompleted:completed,responseClosedBeforeFinish:!completed,headersSent:res.headersSent,deviceId:admittedAt!==null&&req.instarPrincipal?.kind==='device'?req.instarPrincipal.deviceId??null:null,deviceAdmissionIdentity:deviceAdmissionIdentity(req),deviceAdmittedAt:admittedAt,deviceAdmittedHost:deviceAdmittedHost(req)});while(observations.length>1024)observations.shift();
 };
 res.once('finish',()=>record(true));res.once('close',()=>record(res.writableFinished===true));
}
/** Resolve actual signed durable ingress; a bare local deny is not completion.
 * Status reads may perform the coordinator's normal idempotent purge/checkpoint. */
export async function observeGraphFixtureErasures(runtime,agentId,requestedIds){
 const knownErasureIds=new Set(requestedIds),erasures=[],erasureDiscoveryDebt=[],localErasureTargets=runtime?.localErasure.targets()??[];
 for(const target of localErasureTargets.slice(-32)){try{const found=await runtime.erasure.lookupByTarget(target,`owner:${agentId}`);if(found)knownErasureIds.add(found.requestId);}catch{erasureDiscoveryDebt.push({target,evidence:'unavailable'});}}
 for(const id of [...knownErasureIds].slice(-32)){try{const view=await runtime.erasure.status(id);erasures.push({requestId:id,state:view,status:view.state});}catch{erasures.push({requestId:id,evidence:'unavailable'});}}
 return{localErasureTargets,erasures,erasureDiscoveryDebt,erasureInventoryPartial:localErasureTargets.length>32||knownErasureIds.size>32};
}
