// Authorized local overlay, deliberately separate from the agreed graph.
import {el,note,operatorSession} from './ui.js';
import {pendingModel,nodeModel,encodeNodeRef,sameNodeRef,writeStatusWords,independentlySaved} from './conversations-model.js';
import {ledger,forget} from './conversation-write-continuity.js';

/** Live pending list, not a canonical snapshot. Only opaque operation identity
 * reconciles pages; a malformed/unbounded page never proves absence. */
export async function pendingPages(send,current){
 const items=new Map(),byRequest=new Map();let offset=0;
 for(let page=0;page<320;page++){
  const response=await send(`/conversation-graph/pending${offset?`?offset=${offset}`:''}`);
  if(!current())return {ok:false};if(response.needsUnlock)return response;
  const parsed=response.ok?pendingModel(response.data):{ok:false};if(!parsed.ok)return {ok:false};
  for(const item of parsed.items){const previous=item.requestId?byRequest.get(item.requestId):null;if(previous&&previous!==item.operationKey)items.delete(previous);items.set(item.operationKey,item);if(item.requestId)byRequest.set(item.requestId,item.operationKey);}
  if(parsed.nextOffset===null)return {ok:true,items:[...items.values()]};
  if(parsed.nextOffset<=offset)return {ok:false};offset=parsed.nextOffset;
 }return {ok:false};
}
export async function mountPending({body,syncLine,baseSync='',send,current,unlock,refresh,catalog=[]}){
 const active=()=>current()&&Boolean(operatorSession());
 const region=el('section',{class:'list-section conversation-pending','aria-label':'Changes waiting to sync',style:'min-width:0;overflow-wrap:anywhere'});
 const title=el('h2',{class:'eyebrow section-label',text:'Changes waiting to sync'}),rows=el('div',{class:'rows'}),status=el('p',{class:'need-sub',role:'status'});
 const more=el('button',{type:'button',class:'btn-quiet btn-inline',text:'Show more pending changes',hidden:true});
 let offset=0,busy=false;const seen=new Set(),seenRequests=new Set(),rowRecords=new Map(),byRequest=new Map(),known=new Map(catalog.map(node=>[encodeNodeRef(node.ref),[...(node.primaryPath||[]).map(part=>part.title),node.title].filter(Boolean).join(' / ')]));
 const names=async ref=>{
  if(!ref)return 'Unassigned';const key=encodeNodeRef(ref);if(known.has(key))return known.get(key);
  const response=await send(`/conversation-graph/nodes/${encodeURIComponent(key)}`);
  if(!active())return null;if(response.needsUnlock){unlock();return null;}
  const node=response.ok?nodeModel(response.data):null;
  if(node?.ok&&sameNodeRef(node.node.ref,ref)){const label=[...node.path.map(part=>part.title),node.node.title].join(' / ');known.set(key,label);return label;}
  return ref.kind==='effort'?'Effort (details unavailable)':'Conversation (details unavailable)';
 };
 const row=item=>{
  const words=el('p',{class:'need-sub',text:item.words});
  const detail=el('p',{class:'need-sub',text:item.details==='quarantined'?'Private change details are unavailable.':'Pending change · the agreed view stays unchanged.'});
  const actions=el('div',{class:'conversation-corrections'});
  const card=el('article',{class:'conversation-pending-row',style:'min-width:0;max-width:100%'},
   el('strong',{text:item.state==='recorded-local'?'Recorded here':independentlySaved(item.raw)?'Saved independently':item.state==='refused-local'?'Change refused':'Change waiting'}),words,detail,actions);
  const update=async(response)=>{
   if(!active())return;if(response.needsUnlock){unlock();return;}
   if(!response.ok){words.textContent='This request could not be checked. Its identity is retained.';return;}
   words.textContent=writeStatusWords(response.data);
   if(['committed','canceled','canceled-local','erased','refused-local'].includes(response.data?.state))refresh();
  };
  if(item.requestId)actions.append(el('button',{type:'button',class:'btn-quiet btn-inline',text:'Check change',onclick:async()=>update(await send(`/conversation-graph/changes/${encodeURIComponent(item.requestId)}`))}));
  if(item.cancelEligible)actions.append(el('button',{type:'button',class:'btn-quiet btn-inline',text:'Cancel change',onclick:async event=>{
   if(!active())return;event.currentTarget.disabled=true;await update(await send(`/conversation-graph/changes/${encodeURIComponent(item.operationKey)}/cancel`,{}));
  }}));
  const intent=item.localIntent?.change;
  if(intent){
   if(intent.kind==='set-effort-title')detail.textContent=`Pending name: ${intent.title}`;
   if(intent.kind==='create-effort')detail.textContent='New effort · recorded locally, not yet in the agreed tree.';
   if(intent.kind==='set-primary-placement'||intent.kind==='set-front-door'){
    const from=intent.subject||intent.effort,to=intent.kind==='set-primary-placement'?intent.parent:intent.conversation;
    const reveal=el('button',{type:'button',class:'btn-quiet btn-inline',text:'Show intended placement',onclick:async()=>{
     reveal.disabled=true;const [source,target]=await Promise.all([names(from),names(to)]);if(!active())return;
     detail.textContent=source&&target?`${intent.kind==='set-front-door'?'Pending front door':'Pending move'}: ${source} → ${target}. The agreed placement stays unchanged.`:'Placement details could not be checked.';
    }});actions.prepend(reveal);
   }
  }
  return card;
 };
 const load=async()=>{
  if(busy||!active())return;busy=true;more.disabled=true;
  const response=await send(`/conversation-graph/pending${offset?`?offset=${offset}`:''}`);if(!active())return;
  if(response.needsUnlock){unlock();return;}const page=response.ok?pendingModel(response.data):{ok:false};
  if(!page.ok){status.textContent='Pending changes could not be checked.';busy=false;more.disabled=false;return;}
  for(const item of page.items){
   const previous=item.requestId?byRequest.get(item.requestId):null;const prior=rowRecords.get(previous||item.operationKey);const next=row(item);
   if(prior)prior.replaceWith(next);else rows.append(next);
   if(previous&&previous!==item.operationKey){seen.delete(previous);rowRecords.delete(previous);}
   seen.add(item.operationKey);rowRecords.set(item.operationKey,next);if(item.requestId){seenRequests.add(item.requestId);byRequest.set(item.requestId,item.operationKey);}
  }
  const recorded=[...rows.children].some(node=>node.textContent.startsWith('Recorded here'));
  syncLine.textContent=[baseSync,seen.size?(recorded?'Changes recorded here are waiting for sync.':'Changes are waiting for sync.'):''].filter(Boolean).join(' ');
  more.hidden=page.nextOffset===null;more.disabled=false;
  if(page.nextOffset!==null&&page.nextOffset<=offset){more.hidden=true;status.textContent='The pending list changed. Refresh to reconcile it.';}
  else offset=page.nextOffset??offset;
  if(seen.size&&!region.isConnected)body.append(region);
  busy=false;
 };
 const reconcile=el('button',{type:'button',class:'btn-quiet btn-inline',text:'Refresh pending changes',onclick:()=>{if(busy||!active())return;offset=0;seen.clear();seenRequests.clear();rowRecords.clear();byRequest.clear();rows.replaceChildren();status.textContent='';void load();}});
 region.append(title,reconcile,rows,status,more);more.addEventListener('click',load);await load();
 if(!active())return;
 // Dismissed/unknown IDs remain reachable even when the server cannot name an
 // accepted intent. Never reconstruct or resend an old write body.
 let unresolved=[];try{unresolved=ledger().filter(entry=>!seenRequests.has(entry.requestId));}catch{/* unavailable storage does not invent an empty server queue */}
 if(unresolved.length){const section=el('details',{},el('summary',{text:'Earlier unresolved requests'}));
  for(const entry of unresolved)section.append(el('button',{type:'button',class:'btn-quiet btn-inline',text:`Check earlier request · ${entry.requestId.slice(-6)}`,onclick:async()=>{
   const response=await send(`/conversation-graph/changes/${encodeURIComponent(entry.requestId)}`);if(!active())return;if(response.needsUnlock){unlock();return;}
   const matched=response.data?.requestId===entry.requestId;
   const terminal=matched&&response.ok&&['committed','canceled','canceled-local','refused-local','erased'].includes(response.data?.state);
   if(terminal){forget(entry.subject,entry.requestId);refresh();return;}
   status.textContent=response.ok?writeStatusWords(response.data,entry):'Earlier request is still unknown. No write was sent.';
  }}));region.append(section);if(!region.isConnected)body.append(region);
 }
}
