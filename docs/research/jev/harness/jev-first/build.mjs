// Rebuild replay inputs from the judgment-provenance log + Telegram history + topic-intent store.
// Writes gitignored sample-*.json (raw text) and prints join coverage (content-free).
import * as fs from 'node:fs'; import * as path from 'node:path'; import crypto from 'node:crypto';
const A='/Users/dabombstudio/.instar/agents/echo'; const OUT=path.dirname(new URL(import.meta.url).pathname);
const { projectConfidence } = await import(`${A}/.instar/shadow-install/node_modules/instar/dist/core/TopicIntent.js`);
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const S=s=>'sha256:'+sha(s).match(/.{16}/g).join(':');
const SPLIT='2026-11-01T00:00:00.000Z';
const rows=[];
const dir=`${A}/.instar/state/judgment-provenance`;
for(const f of fs.readdirSync(dir).filter(f=>/^\d{4}.*jsonl$/.test(f)).sort()){
  for(const l of fs.readFileSync(path.join(dir,f),'utf8').split('\n')){ if(!l) continue; let d; try{d=JSON.parse(l)}catch{continue}
    if(d.kind==='decision'&&d.decisionPoint) rows.push(d);} }
console.log('rows',rows.length);
const tgS=new Map(),tgP=new Map(),tgId=new Map();
for(const l of fs.readFileSync(`${A}/.instar/telegram-messages.jsonl`,'utf8').split('\n')){ if(!l) continue; let m; try{m=JSON.parse(l)}catch{continue}
  const t=m.text||''; if(!t) continue; tgS.set(S(t),m); tgP.set(sha(t),m); tgId.set(`${m.topicId}:${m.messageId}`,m); }
const splitOf=d=>d.ts>=SPLIT?'test':'design';
const head=d=>d.contextFull?.rawResponseHead;
// ---- tone
{ const out=[]; const by={};
 for(const d of rows){ if(d.decisionPoint!=='messaging-tone-gate') continue; const cf=d.contextFull; const body=cf._contentFull?.candidateBody; const h=head(d); if(!h||!body||cf.candidate?.bodyTruncated) continue;
  const pass=/"pass"\s*:\s*true/.test(h); const failr=/"pass"\s*:\s*false/.test(h); if(!pass&&!failr) continue;
  const rule=pass?'':(h.match(/"rule"\s*:\s*"(\w+)"/)||[])[1]||'unknown';
  out.push({id:d.id,split:splitOf(d),ts:d.ts,state:body,label:pass?'pass':'block',rule,signals:cf.gateSignalKinds||[],kind:cf.messageKind,recent:cf.recentMessageCount,deferral:cf.deferralShapeDetected===true,tokensIn:d.tokensIn});
  by[rule||'pass']=(by[rule||'pass']||0)+1; }
 fs.writeFileSync(`${OUT}/sample-tone.json`,JSON.stringify(out)); console.log('tone',out.length,by); }
// tone body index for arc join
const toneBody=new Map(); for(const d of rows){ if(d.decisionPoint==='messaging-tone-gate'){ const b=d.contextFull._contentFull?.candidateBody; if(b) toneBody.set(S(b),b);} }
// refs at time
const topicCache=new Map();
function topicFile(t){ if(topicCache.has(t)) return topicCache.get(t); const p=`${A}/.instar/topic-intent/${t}.json`; let v=null; try{v=JSON.parse(fs.readFileSync(p,'utf8'))}catch{} topicCache.set(t,v); return v; }
function refsAt(topicId,ts,minTier){ const f=topicFile(topicId); if(!f) return null; const now=Date.parse(ts); const out=[]; const rank={observation:0,tentative:1,authoritative:2};
  for(const ref of Object.values(f.refs||{})){ const ev=(ref.evidence||[]).filter(e=>Date.parse(e.at)<=now); if(!ev.length) continue; const last=ev.map(e=>e.at).sort().pop();
    const proj=projectConfidence(ev,last,now,ref.kind); if(rank[proj.tier]>=rank[minTier]) out.push({refId:ref.refId,text:ref.text,kind:ref.kind,tier:proj.tier,confidence:proj.confidence}); }
  return out; }
// ---- arc
{ const out=[]; let dp=0,noDraft=0,noTopic=0,hashOK=0,countOK=0,noRefs=0;
 // nearest user-message window for topic of tone-only drafts is unavailable: those rows are dropped and counted
 for(const d of rows){ if(d.decisionPoint!=='topic-intent-arc-check') continue; const h=head(d); if(!h) continue; dp++; const cf=d.contextFull;
  const m=tgS.get(cf.draftIdentitySha256); const draft=m?.text; if(!draft){noDraft++;continue;}
  const refs=refsAt(m.topicId,d.ts,'tentative'); if(!refs||!refs.length){noRefs++;continue;}
  if(refs.length===cf.refCount) countOK++;
  const refSet=S(JSON.stringify(refs.map(r=>[r.refId,r.text,r.tier]))); const exact=refSet===cf.refSetIdentitySha256; if(exact) hashOK++;
  const empty=/"actsOn"\s*:\s*\[\s*\]/.test(h)&&/"contradicts"\s*:\s*\[\s*\]/.test(h);
  const contradicts=/"contradicts"\s*:\s*\[\s*[^\]\s]/.test(h);
  out.push({id:d.id,split:splitOf(d),ts:d.ts,topicId:m.topicId,draft,refs,exact,countMatch:refs.length===cf.refCount,label:empty?'none':'engaged',contradicts,tokensIn:d.tokensIn}); }
 fs.writeFileSync(`${OUT}/sample-arc.json`,JSON.stringify(out)); console.log('arc settled rows',dp,'noDraftJoin',noDraft,'noRefs',noRefs,'built',out.length,'refCountMatch',countOK,'refSetHashExact',hashOK); }
// ---- extractor
{ const fd=fs.openSync(`${OUT}/sample-extract.json`,'w'); let built=0; let dp=0,no=0,mismatch=0,count=0; const c={}; let maxRefs=0;
 for(const d of rows){ if(d.decisionPoint!=='topic-intent-extract') continue; const h=head(d); if(!h) continue; dp++; const cf=d.contextFull;
  const m=tgId.get(`${cf.topicId}:${cf.messageId}`); let text=m?.text; if(!text){no++;continue;} if(sha(text)!==cf.messageSha256){ const alt=tgP.get(cf.messageSha256); if(alt) text=alt.text; else {mismatch++;continue;} }
  const refsAll=(refsAt(cf.topicId,d.ts,'observation')||[]); if(refsAll.length===cf.existingRefCount) count++; maxRefs=Math.max(maxRefs,refsAll.length);
  const refs=refsAll.slice(-80).map(r=>({kind:r.kind,tier:r.tier,text:r.text.slice(0,240)}));
  const empty=/^\s*\{\s*"signals"\s*:\s*\[\s*\]/.test(h);
  const kinds=[...h.matchAll(/"kind"\s*:\s*"(new-ref|reref|affirm|contradict)"/g)].map(x=>x[1]);
  const k=(cf.fromUser?'user:':'agent:')+(empty?'none':'signal'); c[k]=(c[k]||0)+1;
  fs.writeSync(fd,JSON.stringify({id:d.id,split:splitOf(d),ts:d.ts,topicId:cf.topicId,fromUser:cf.fromUser===true,text,refs,refTotal:refsAll.length,label:empty?'none':'signal',kinds,goal:(h.match(/"topic"\s*:\s*\{\s*"goal"\s*:\s*"([^"]{0,200})/)||[])[1]||null,tokensIn:d.tokensIn})+'\n'); built++; }
 fs.closeSync(fd); console.log('extract rows',dp,'noMsg',no,'hashMismatch',mismatch,'built',built,'refCountMatch',count,'maxRefs',maxRefs,c); }
// ---- message sentinel
{ const out=[]; let dp=0,no=0; for(const d of rows){ if(d.decisionPoint!=='message-sentinel-classify'||!['noop','fired'].includes(d.decision)) continue; dp++; const m=tgS.get(d.contextFull.messageIdentitySha256); if(!m){no++;continue;}
  out.push({id:d.id,split:splitOf(d),ts:d.ts,state:m.text,label:d.decision==='fired'?'fired':'normal',tokensIn:d.tokensIn}); }
 fs.writeFileSync(`${OUT}/sample-sentinel.json`,JSON.stringify(out)); const f=out.filter(x=>x.label==='fired').length; console.log('sentinel rows',dp,'noJoin',no,'built',out.length,'fired',f); }
// ---- completion claim: join message body by plain sha over tone bodies and telegram
{ const out=[]; let dp=0,no=0; const bodies=new Map(); const add=b=>{const k=sha(b).slice(0,4)+':'+Buffer.byteLength(b); if(!bodies.has(k)) bodies.set(k,b);}; for(const b of toneBody.values()) add(b); for(const m of tgP.values()) add(m.text);
 for(const d of rows){ if(d.decisionPoint!=='completion-claim-verify') continue; const h=head(d); if(!h) continue; dp++; const cf=d.contextFull;
  // sliceHash is redacted by the credential scrubber to [TOKEN:xxxx****]; join on the 4 surviving hex digits + exact byte length
  const key=String(cf.sliceHash).replace(/^\[TOKEN:/,'').slice(0,4)+':'+cf.sliceBounds?.byteLength; const b=bodies.get(key); if(!b){no++;continue;}
  const labels=[...h.matchAll(/"label"\s*:\s*"([\w-]+)"/g)].map(x=>x[1]);
  out.push({id:d.id,split:splitOf(d),ts:d.ts,state:b,visibleLabels:labels,clauseCount:cf.clauseCount,tokensIn:d.tokensIn}); }
 fs.writeFileSync(`${OUT}/sample-claim.json`,JSON.stringify(out)); console.log('claim rows',dp,'noJoin',no,'built',out.length); }
