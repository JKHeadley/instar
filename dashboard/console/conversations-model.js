// Conversations read contract. The server owns authorization and placement;
// this module never infers either from a title, role, or decoded source ref.

function itemModel(item) {
  const key = encodeNodeRef(item?.ref);
  if (!item || !key || typeof item.title !== 'string'
      || (item.kind !== undefined && item.kind !== item.ref.kind)) return null;
  const expanded = item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata) ? item.metadata : {};
  const metadata = { ...item, ...expanded };
  return {
    ref: item.ref, key, title: item.title.trim() || (item.ref.kind === 'effort' ? 'Untitled' : 'Conversation'), kind: item.ref.kind,
    role: metadata.role, platform: item.ref.platform,
    visibleChildCount: Number.isSafeInteger(metadata.visibleChildCount) && metadata.visibleChildCount >= 0 ? metadata.visibleChildCount : null,
    primaryPath: Array.isArray(metadata.primaryPath) ? metadata.primaryPath.filter(validPath) : [],
    openUrl: sourceLink(item.openUrl),
    sourceFreshness: metadata.sourceFreshness ?? null,
    source: sourceModel(item.source),
    placedBy: ['owner', 'delegation', 'import', 'inference'].includes(item.placedBy) ? item.placedBy : null,
    frontDoor: item.ref.kind === 'effort' && expanded.frontDoor?.kind === 'conversation'
      && encodeNodeRef(expanded.frontDoor) ? expanded.frontDoor : null,
  };
}

function validPath(p) { return p && encodeNodeRef(p.ref) && typeof p.title === 'string'; }

/** Typed response refs become opaque URL tokens ONLY at the route boundary. */
export function encodeNodeRef(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null;
  const text = (s) => typeof s === 'string' && s.length > 0 && s.length <= 200;
  let keys;
  if (ref.kind === 'effort' && text(ref.id)) keys = ['kind', 'id'];
  if (ref.kind === 'conversation' && ref.platform === 'telegram'
      && ((typeof ref.chatId === 'string' && /^-?\d+$/.test(ref.chatId)) || Number.isSafeInteger(ref.chatId))
      && Number.isSafeInteger(ref.topicId) && ref.topicId > 0) keys = ['kind', 'platform', 'chatId', 'topicId'];
  if (ref.kind === 'conversation' && ref.platform === 'slack' && text(ref.channelId)
      && (ref.threadTs === undefined || text(ref.threadTs))) keys = ['kind', 'platform', 'channelId', ...(ref.threadTs === undefined ? [] : ['threadTs'])];
  if (ref.kind === 'conversation' && ref.platform === 'app' && text(ref.conversationKey)) keys = ['kind', 'platform', 'conversationKey'];
  if (!keys || Object.keys(ref).some((k) => !keys.includes(k))) return null;
  const canonical = JSON.stringify(Object.fromEntries(keys.sort().map((key) => [key, ref[key]])));
  return btoa(String.fromCharCode(...new TextEncoder().encode(canonical))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function listModel(data, view = 'overview') {
  if (!data || !Array.isArray(data.items) || typeof data.partial !== 'boolean') return { ok: false };
  const normalized = data.items.map(itemModel);
  // A malformed row must not silently disappear and make the view look complete.
  if (normalized.some((i) => i === null)) return { ok: false };
  return {
    ok: true, items: view === 'overview' ? normalized.slice(0, 5) : normalized,
    hasMore: Boolean(data.nextCursor) || (view === 'overview' && normalized.length > 5),
    nextCursor: typeof data.nextCursor === 'string' && data.nextCursor ? data.nextCursor : null,
    revision: data.revision, asOf: data.asOf, sync: syncWords(data), canCorrect: data.capabilities?.ownerCorrections === true,
  };
}

export function nodeModel(data) {
  const node = itemModel(data?.node);
  if (!node || typeof data.partial !== 'boolean' || !Array.isArray(data.children?.items)) return { ok: false };
  const children = data.children.items.map(itemModel);
  if (children.some((i) => i === null)) return { ok: false };
  return {
    ok: true, node, path: Array.isArray(data.path) ? data.path.filter(validPath) : [],
    children, nextCursor: data.children.nextCursor || null,
    links: Array.isArray(data.links) ? data.links.filter(validPath) : [],
    provenance: Array.isArray(data.provenance) ? data.provenance : [],
    correction: correctionModel(data.correction),
    canErase: data.capabilities?.ownerErasure === true && node.kind === 'effort',
    headerForgotten: data.erasure?.headerForgotten === true,
    asOf: data.asOf, sync: syncWords(data),
  };
}

function correctionModel(value) {
  if (!value || typeof value !== 'object' || typeof value.moveEligible !== 'boolean'
    || !Array.isArray(value.replacesPlacementEventIds) || value.replacesPlacementEventIds.length > 32
    || !value.replacesPlacementEventIds.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(id))) return null;
  return { moveEligible: value.moveEligible, replacesPlacementEventIds: [...value.replacesPlacementEventIds],
    headerVersion: Number.isSafeInteger(value.headerVersion) && value.headerVersion >= 0 ? value.headerVersion : null,
    replacesFrontDoorEventIds: Array.isArray(value.replacesFrontDoorEventIds) && value.replacesFrontDoorEventIds.length <= 32
      && value.replacesFrontDoorEventIds.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(id)) ? [...value.replacesFrontDoorEventIds] : null,
    headerForgotten: value.headerForgotten === true, reason: typeof value.reason === 'string' ? value.reason : null };
}

export function syncWords(data) {
  const lagging = data?.replicationState === 'pending' || data?.replicationState === 'recovering';
  if (!data?.partial && !lagging) return '';
  const reasons = Array.isArray(data.partialReasons) ? data.partialReasons.map((r) => typeof r === 'string' ? r : r?.reason) : [];
  const parts = [];
  if (lagging || reasons.includes('replica-lag') || reasons.includes('peer-not-replicated')) parts.push('Syncing with another machine.');
  if (reasons.includes('evidence-missing') || reasons.includes('history-unavailable')) parts.push('Some original history is unavailable.');
  if (reasons.includes('event-gap')) parts.push('This view is catching up.');
  return parts.join(' ') || 'Some information is still being checked.';
}

function sourceModel(source) {
  if (!source || !['telegram', 'slack', 'app'].includes(source.platform)) return null;
  const id = source.conversationId;
  if (source.platform === 'app' ? typeof id !== 'string' || !id : !Number.isSafeInteger(id)) return null;
  return { platform: source.platform, conversationId: id, title: typeof source.title === 'string' ? source.title : '',
    machine: typeof source.machine === 'string' ? source.machine : null };
}

export function historyPath(source, before = '') {
  if (!source) return null;
  const q = new URLSearchParams({ limit: '50' });
  if (before) q.set('before', before);
  if (source.platform === 'telegram' && Number.isSafeInteger(source.conversationId) && source.conversationId > 0) {
    const split = before.lastIndexOf('|');
    if (split >= 0 && /^\d+$/.test(before.slice(split + 1))) {
      q.set('before', before.slice(0, split)); q.set('beforeMessageId', before.slice(split + 1));
    }
    q.set('scope', 'pool');
    return `/telegram/topics/${source.conversationId}/messages?${q}`;
  }
  if (source.platform === 'slack' && Number.isSafeInteger(source.conversationId) && source.conversationId < 0 && source.machine) {
    q.set('machine', source.machine);
    return `/mobile/chat/slack/${source.conversationId}/messages?${q}`;
  }
  if (source.platform === 'app' && typeof source.conversationId === 'string' && source.conversationId) {
    q.set('scope', 'pool');
    return `/mobile/chat/app/${encodeURIComponent(source.conversationId)}/messages?${q}`;
  }
  return null;
}

export function graphHistoryRoute(node, before = '') {
  const original = historyPath(node?.source, before);
  if (!original || !node.key) return null;
  const query = new URLSearchParams(original.split('?')[1]);
  query.delete('machine'); query.delete('scope');
  return `/conversation-graph/nodes/${encodeURIComponent(node.key)}/messages?${query}`;
}

export function historyModel(data, source) {
  if (!Array.isArray(data?.messages)) return { ok: false };
  const messages = data.messages.map((m) => ({
    key: typeof m.eventId === 'string' ? m.eventId : `${m.messageId ?? m.id ?? ''}:${m.timestamp ?? m.at ?? ''}:${m.fromUser ?? m.role ?? ''}`,
    text: typeof m.text === 'string' ? m.text : '',
    at: typeof m.at === 'string' ? m.at : typeof m.timestamp === 'string' ? m.timestamp : '',
    fromUser: m.fromUser === true || m.role === 'operator',
    senderName: typeof m.senderName === 'string' ? m.senderName : '',
    attachmentCount: Array.isArray(m.attachments) ? m.attachments.length : 0,
    messageId: Number.isSafeInteger(m.messageId) ? m.messageId : null,
  }));
  messages.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0) || (a.messageId || 0) - (b.messageId || 0) || a.key.localeCompare(b.key));
  let before = typeof data.nextBefore === 'string' ? data.nextBefore : null;
  if (source.platform === 'telegram' && messages.length >= 50 && Number.isFinite(Date.parse(messages[0]?.at))) {
    before = messages[0].messageId ? `${messages[0].at}|${messages[0].messageId}` : messages[0].at;
  }
  return { ok: true, messages, before, partial: Boolean(data.pool?.failed?.length), observedOnly: source.platform === 'telegram' };
}

export function pageQuery(view, query = '', cursor = '') {
  const params = new URLSearchParams({ view: view === 'all' ? 'all' : 'overview' });
  if (query) params.set('q', query);
  if (cursor) params.set('cursor', cursor);
  return params.toString();
}

export function sourceLink(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (url.hostname !== 't.me' && url.hostname !== 'app.slack.com' && !url.hostname.endsWith('.slack.com')) return null;
    return url.href;
  } catch { return null; }
}

// Provisional v2 owned-custody adapter. No local intent becomes a canonical row.
export function sameNodeRef(a, b) { const key = encodeNodeRef(a); return Boolean(key && key === encodeNodeRef(b)); }
const opaqueRequest = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{8,160}$/.test(value);
export function cancellationKey(value) {
  const key = typeof value?.operationKey === 'string' ? value.operationKey : value?.eventId;
  return typeof key === 'string' && (/^queued:owner-change:[a-f0-9]{64}$/.test(key)
    || /^(graph-event|header-op):[A-Za-z0-9_.:-]{8,200}$/.test(key)) ? key : null;
}
export function independentlySaved(data){return ['saved-pending','committed'].includes(data?.state)&&['copied-on-owned-machine','external-custody'].includes(data?.custody?.kind);}
export function writeStatusWords(data, known = {}) {
  if(data?.state==='committed')return 'Change committed.';
  if(['canceled','canceled-local'].includes(data?.state))return 'Canceled. The agreed view stays unchanged.';
  if(data?.state==='refused-local')return 'Change refused. Review current details before making another edit.';
  const waiting = Array.isArray(data?.waitingMachines) ? data.waitingMachines.map(m => typeof m?.name === 'string' ? m.name.slice(0,120) : '').filter(Boolean).join(', ') : '';
  const machine = typeof data?.custody?.machine?.name === 'string' ? data.custody.machine.name.slice(0,120) : 'this machine';
  const independent = independentlySaved(data);
  if (data?.state === 'saved-pending' && independent) return `Saved independently${data.custody?.machine?.name ? ` on ${machine}` : ''}, waiting for sync${waiting ? ` with ${waiting}` : ''}. The agreed view stays unchanged.`;
  if (data?.state === 'cancel-pending' || data?.state === 'checking-cancel') return `Cancellation is waiting for sync${waiting ? ` with ${waiting}` : ''}.`;
  if (known.witnessed) return 'Saved independently. The current sync status could not be checked.';
  if(known.recorded&&data?.state!=='recorded-local')return 'Recorded here earlier. The current recording machine and sync status could not be checked. This does not confirm an independent copy.';
  const writer = data?.blockedBy?.reason === 'writer-not-joined' && typeof data.blockedBy.machine?.name === 'string' ? data.blockedBy.machine.name.slice(0,120) : '';
  if (data?.state === 'recorded-local' && writer) return `Recorded here on ${machine}. Not yet saved independently: ${writer} is in charge of your machines right now and has not joined Conversations, so this change waits until a joined machine${waiting ? ` (${waiting})` : ''} is in charge again. This copy may be lost if this machine is lost. The agreed view stays unchanged.`;
  if (data?.state === 'recorded-local') return `Recorded here on ${machine}. Not yet saved independently${waiting ? `; waiting for ${waiting}` : ''}. This copy may be lost if this machine is lost. The agreed view stays unchanged.`;
  if (data?.state === 'commit-won') return 'The change was already being committed. Check its status.';
  return 'The save has not been confirmed. Check this same request before trying again.';
}
function localChange(value) {
  if (!value || value.v !== 1 || Object.keys(value).some(k => !['v','change','createdEffort'].includes(k))) return null;
  const c = value.change; if (!c || typeof c !== 'object') return null;
  const ids = list => Array.isArray(list) && list.length <= 32 && list.every(v => typeof v === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(v));
  const exact = allowed => Object.keys(c).every(k => allowed.includes(k));
  let change;
  if (c.kind === 'create-effort' && exact(['kind','projectScope']) && Array.isArray(c.projectScope) && c.projectScope.length <= 64 && c.projectScope.every(v=>typeof v==='string'&&v.length<=200)) change={kind:c.kind,projectScope:[...c.projectScope]};
  if (c.kind === 'set-effort-title' && exact(['kind','effort','baseVersion','title']) && c.effort?.kind==='effort' && encodeNodeRef(c.effort) && Number.isSafeInteger(c.baseVersion) && c.baseVersion>=0 && typeof c.title==='string'&&c.title.length<=200) change={kind:c.kind,effort:c.effort,title:c.title,baseVersion:c.baseVersion};
  if(c.kind==='set-primary-placement'&&exact(['kind','subject','parent','replacesPlacementEventIds'])&&encodeNodeRef(c.subject)&&(c.parent===null||encodeNodeRef(c.parent))&&ids(c.replacesPlacementEventIds))change={kind:c.kind,subject:c.subject,parent:c.parent,replacesPlacementEventIds:[...c.replacesPlacementEventIds]};
  if(c.kind==='set-front-door'&&exact(['kind','effort','conversation','replacesFrontDoorEventIds','observedPlacementEventIds'])&&c.effort?.kind==='effort'&&encodeNodeRef(c.effort)&&(c.conversation===null||c.conversation?.kind==='conversation'&&encodeNodeRef(c.conversation))&&ids(c.replacesFrontDoorEventIds)&&ids(c.observedPlacementEventIds))change={kind:c.kind,effort:c.effort,conversation:c.conversation,replacesFrontDoorEventIds:[...c.replacesFrontDoorEventIds],observedPlacementEventIds:[...c.observedPlacementEventIds]};
  if(!change)return null;
  if(value.createdEffort!==undefined&&(!value.createdEffort||Object.keys(value.createdEffort).sort().join(',')!=='headerId,ref'||value.createdEffort.ref?.kind!=='effort'||!encodeNodeRef(value.createdEffort.ref)||typeof value.createdEffort.headerId!=='string'||!/^[A-Za-z0-9_.:-]{1,200}$/.test(value.createdEffort.headerId)))return null;
  return {v:1,change,...(value.createdEffort?{createdEffort:value.createdEffort}:{})};
}
export function pendingModel(data) {
  if(!data||!Array.isArray(data.items)||data.items.length>64)return {ok:false};
  const paged=data.total!==undefined||data.nextOffset!==undefined;
  if(paged&&(!Number.isSafeInteger(data.total)||data.total<0||data.nextOffset!==null&&(!Number.isSafeInteger(data.nextOffset)||data.nextOffset<0)))return {ok:false};
  const items=[];
  for(const item of data.items){
    if(!item||!['recorded-local','saved-pending','checking-save','cancel-pending','checking-cancel','commit-won','refused-local','canceled-local','committed','canceled','erased','erase-pending'].includes(item.state))return {ok:false};
    if(item.requestId!==null&&!opaqueRequest(item.requestId))return {ok:false};
    const operationKey=cancellationKey(item);if(!operationKey)return {ok:false};
    const localIntent=item.details==='available'?localChange(item.localIntent):null;
    if(item.details==='available'&&item.localIntent&&!localIntent)return {ok:false};
    const subject=encodeNodeRef(item.subject)?item.subject:localIntent?.change.subject||localIntent?.change.effort||localIntent?.createdEffort?.ref||null;
    items.push({operationKey,requestId:item.requestId,state:item.state,subject,localIntent,cancelEligible:item.cancelEligible===true,
      details:item.details==='quarantined'?'quarantined':'available',words:writeStatusWords(item),raw:item});
  }
  return {ok:true,items,nextOffset:paged?data.nextOffset:null,total:paged?data.total:null,provisional:!paged};
}

export function localOnlyEnvelope(response){return response?.status===503&&response.data?.code==='conversation-graph-pending'&&response.data?.reason==='owned-custody-pending'&&response.data?.capabilities?.recordLocal===true&&response.data?.capabilities?.canonical===false;}
export function localOnlyWords(response){return response?.data?.awaitingJoin===true?'This machine has not joined your other machines for Conversations yet. Changes you make here stay on this machine.':'Working locally. The agreed view is unavailable.';}
