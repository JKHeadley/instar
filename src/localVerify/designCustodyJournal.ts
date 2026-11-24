/** Optional facts inside the EXISTING service-owned inflight record. No file, socket or lease restoration. */
import fs from 'node:fs';
import path from 'node:path';
export interface DesignAttempt { attemptToken:string;pid:number;pgid:number;baseSha:string;headSha:string }
interface ChildIdentity { pid:number;pgid:number;startId:string }
interface RootRow { path:string;state:'admitted'|'released' }
interface ChildRow { launchId:string;root:string;state:'reserved'|'started'|'exited';identity?:ChildIdentity }
export interface DesignCustody { version:1;attempt:DesignAttempt;revision:number;phase:'active'|'closing';roots:RootRow[];children:ChildRow[] }
export interface DesignCustodyBackend {
  read():unknown;
  /** Existing single-writer owns atomic durable replacement; MUST compare entire expected record before write. */
  compareAndWrite(expected:unknown,next:unknown):void;
}
export interface DesignCustodyFact { readonly kind:'design-root-readback';readonly root:string }
const facts=new WeakMap<object,{check:()=>void;root:string}>();
const clone=<T>(v:T):T=>structuredClone(v);
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0;
const exact=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).every(k=>keys.includes(k))&&keys.every(k=>Object.hasOwn(v,k));
function attempt(v:unknown):asserts v is DesignAttempt {
 if(!object(v)||!exact(v,['attemptToken','pid','pgid','baseSha','headSha'])||typeof v.attemptToken!=='string'||! /^[a-f0-9]{16,64}$/.test(v.attemptToken)||!positive(v.pid)||!positive(v.pgid)||typeof v.baseSha!=='string'||! /^[a-f0-9]{40}$/.test(v.baseSha)||typeof v.headSha!=='string'||! /^[a-f0-9]{40}$/.test(v.headSha))throw Error('Invalid design attempt');
}
function childIdentity(v:unknown):asserts v is ChildIdentity {
 if(!object(v)||!exact(v,['pid','pgid','startId'])||!positive(v.pid)||!positive(v.pgid)||typeof v.startId!=='string'||!v.startId)throw Error('Invalid observed child identity');
}
export function inspectDesignCustody(record:unknown):DesignCustody|null {
 if(!object(record))throw Error('Unreadable inflight record');
 if(!Object.hasOwn(record,'designCustody'))return null;
 const v=record.designCustody;
 if(!object(v)||!exact(v,['version','attempt','revision','phase','roots','children'])||v.version!==1||!Number.isSafeInteger(v.revision)||Number(v.revision)<1||(typeof v.phase!=='string'||!['active','closing'].includes(v.phase))||!Array.isArray(v.roots)||!Array.isArray(v.children))throw Error('Malformed design custody');
 attempt(v.attempt);
 const roots=new Map<string,string>(),launches=new Set<string>();
 for(const r of v.roots){if(!object(r)||!exact(r,['path','state'])||typeof r.path!=='string'||!path.isAbsolute(r.path)||path.resolve(r.path)!==r.path||(typeof r.state!=='string'||!['admitted','released'].includes(r.state))||roots.has(r.path))throw Error('Malformed custody root');roots.set(r.path,String(r.state));}
 for(const c of v.children){if(!object(c)||typeof c.launchId!=='string'||!c.launchId||launches.has(c.launchId)||typeof c.root!=='string'||!roots.has(c.root)||(typeof c.state!=='string'||!['reserved','started','exited'].includes(c.state))||!exact(c,c.state==='reserved'?['launchId','root','state']:['launchId','root','state','identity']))throw Error('Malformed custody child');if(c.state!=='reserved')childIdentity(c.identity);if(roots.get(c.root)==='released'&&c.state!=='exited')throw Error('Released root has unresolved child');launches.add(c.launchId);}
 return clone(v) as unknown as DesignCustody;
}
export function assertDesignCustodyFact(fact:unknown):Readonly<{root:string}> {
 const f=object(fact)?facts.get(fact):undefined;if(!f)throw Error('Unregistered live custody fact');f.check();return Object.freeze({root:f.root});
}
/** Fresh instances over an existing section recover FACTS only; they cannot resume prospective authority. */
export function createDesignCustodyJournal(input:{verifyRoot:string;attempt:DesignAttempt;backend:DesignCustodyBackend;cleanupOnly?:boolean}) {
 attempt(input.attempt);const expected=Object.freeze({...input.attempt}),backend=input.backend;
 const verifyRoot=fs.realpathSync(input.verifyRoot);if(verifyRoot!==path.resolve(input.verifyRoot))throw Error('Noncanonical verify root');
 let live=false,revoked=false;
 const privateParent=()=>{const p=path.join(verifyRoot,'design-targets'),st=fs.lstatSync(p);if(fs.realpathSync(input.verifyRoot)!==verifyRoot||fs.realpathSync(p)!==p||!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077)!==0||(process.getuid&&st.uid!==process.getuid()))throw Error('Unsafe snapshot custody parent');return p;};
 const rootPath=(root:string)=>{const parent=privateParent();if(path.dirname(root)!==parent||!/^runtime-[a-f0-9]{32}$/.test(path.basename(root))||path.resolve(root)!==root)throw Error('Invalid exact snapshot leaf');};
 const read=()=>{const value=backend.read();if(!object(value))throw Error('Unreadable inflight record');const tuple={attemptToken:value.attemptToken,pid:value.pid,pgid:value.pgid,baseSha:value.baseSha,headSha:value.headSha};attempt(tuple);if(!equal(tuple,expected))throw Error('Inflight attempt changed');const custody=inspectDesignCustody(value);if(custody){if(!equal(custody.attempt,expected))throw Error('Custody attempt changed');for(const r of custody.roots)rootPath(r.path);}return{record:clone(value),custody};};
 const requireLive=()=>{if(!live||revoked||input.cleanupOnly)throw Error('No live prospective custody');const c=read().custody;if(!c||c.phase!=='active')throw Error('Custody is cleanup-only');};
 const mutate=(change:(c:DesignCustody)=>void)=>{const before=read();if(!before.custody)throw Error('Design custody not established');const next=clone(before.custody);change(next);if(equal(next,before.custody))return next;next.revision++;if(!Number.isSafeInteger(next.revision))throw Error('Custody revision exhausted');const row={...before.record,designCustody:next};let writeError:unknown;try{backend.compareAndWrite(before.record,row);}catch(e){writeError=e;}
  let after:ReturnType<typeof read>;try{after=read();}catch(e){revoked=true;live=false;throw writeError??e;}if(equal(after.record,row))return after.custody!;if(equal(after.record,before.record))throw writeError??Error('Custody write did not commit');revoked=true;live=false;throw writeError??Error('Custody write lacks exact readback');
 };
 const fact=(root:string):DesignCustodyFact=>{const value=Object.freeze({kind:'design-root-readback' as const,root});facts.set(value,{root,check:()=>{requireLive();try{const st=fs.lstatSync(root);if(!st.isDirectory()||st.isSymbolicLink()||fs.realpathSync(root)!==root||(st.mode&0o077)!==0||(process.getuid&&st.uid!==process.getuid()))throw Error('Admitted root identity changed');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}if(read().custody?.roots.find(r=>r.path===root)?.state!=='admitted')throw Error('Root custody ended');}});return value;};
 return Object.freeze({
  establish():void {if(revoked)throw Error('Custody instance revoked');const before=read();if(before.custody)return;if(input.cleanupOnly)throw Error('Cleanup cannot establish custody');const custody:DesignCustody={version:1,attempt:{...expected},revision:1,phase:'active',roots:[],children:[]};const row={...before.record,designCustody:custody};let error:unknown;try{backend.compareAndWrite(before.record,row);}catch(e){error=e;}try{if(!equal(read().record,row))throw Error('Establish lacks readback');}catch(e){revoked=true;throw error??e;}live=true;},
  admitRoot(root:string):DesignCustodyFact {requireLive();rootPath(root);const prior=read().custody!.roots.find(r=>r.path===root);if(prior&&prior.state!=='admitted')throw Error('Released root cannot reactivate');try{fs.lstatSync(root);throw Error('Snapshot leaf already exists');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}if(!prior)mutate(c=>{if(c.phase!=='active')throw Error('Custody closing');c.roots.push({path:root,state:'admitted'});});return fact(root);},
  reserveChild(root:string,launchId:string):void {requireLive();if(typeof launchId!=='string'||!launchId)throw Error('Missing launch identity');mutate(c=>{if(c.roots.find(r=>r.path===root)?.state!=='admitted')throw Error('Root not admitted');const old=c.children.find(x=>x.launchId===launchId);if(old){if(old.root!==root||old.state!=='reserved')throw Error('Launch already advanced');return;}c.children.push({launchId,root,state:'reserved'});});},
  startChild(launchId:string,identity:ChildIdentity):void {childIdentity(identity);mutate(c=>{const old=c.children.find(x=>x.launchId===launchId);if(!old)throw Error('Unreserved launch');if(old.identity){if(!equal(old.identity,identity))throw Error('Conflicting actual child');return;}old.identity=clone(identity);old.state='started';});},
  exitChild(launchId:string,receipt:{pid:number;startId:string;observed:true}):void {if(!receipt||receipt.observed!==true||!positive(receipt.pid)||!receipt.startId)throw Error('Missing actual exit');mutate(c=>{const old=c.children.find(x=>x.launchId===launchId);if(!old?.identity||old.identity.pid!==receipt.pid||old.identity.startId!==receipt.startId)throw Error('Exit identity mismatch');old.state='exited';});},
  beginCleanup():void {live=false;mutate(c=>{c.phase='closing';});},
  releaseRoot(root:string):void {rootPath(root);mutate(c=>{const r=c.roots.find(x=>x.path===root);if(!r||c.children.some(x=>x.root===root&&x.state!=='exited'))throw Error('Unresolved root custody');try{fs.lstatSync(root);throw Error('Snapshot root still exists');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}r.state='released';});},
  canClear():boolean {const c=read().custody;return !!c&&c.phase==='closing'&&c.roots.every(r=>r.state==='released')&&c.children.every(x=>x.state==='exited');},
  snapshot():DesignCustody|null {return read().custody;},
 });
}
