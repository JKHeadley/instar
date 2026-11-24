import { deriveAccountsExpectation } from '../design/harness/accountsReadiness.mjs';
/** Synthetic protocol/artifact fixture only. Does not claim a browser rendered these bytes. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createFixtureResponseEvidence, digest, RESPONSE_EVIDENCE_HEADER, providerBinding } from '../design/harness/fixtureResponseEvidence.mjs';
export function responseEvidenceFixture(options:Record<string,unknown>={}) {
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'lv-tmp-response-evidence-')));fs.chmodSync(root,0o700);
 const origin='http://127.0.0.1:41414',ledger=createFixtureResponseEvidence(options);ledger.bindOrigin(origin);
 const folder=path.join(root,'renderer-synthetic');fs.mkdirSync(folder,{mode:0o700});fs.mkdirSync(path.join(folder,'responses'));
 function probe(route:string,finish=true) {
  const headers=new Map<string,string>();
  const res=Object.assign(new EventEmitter(),{statusCode:200,setHeader:(key:string,value:string)=>{headers.set(key.toLowerCase(),String(value));},getHeader:(key:string)=>headers.get(key.toLowerCase()),write:()=>true,end:()=>res});
  ledger.middleware({method:'GET',originalUrl:route} as never,res as never,()=>{});
  res.setHeader('Content-Type','application/json');res.end('{"synthetic":true}');if(finish)res.emit('finish');
  return {method:'GET',url:origin+route,status:200,contentType:'application/json',contentLength:null,
   bodyEvidence:{kind:'awaiting-parent-evidence',responseId:headers.get(RESPONSE_EVIDENCE_HEADER),browserConsumption:'not-observed'}};
 }
 const png=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.write('IHDR',12);png.writeUInt32BE(1280,16);png.writeUInt32BE(728,20);fs.writeFileSync(path.join(folder,'capture.png'),png);
 const axe=Buffer.from('{}');fs.writeFileSync(path.join(folder,'axe.json'),axe);
 const asset=Buffer.from('synthetic asset bytes'),assetName=`responses/${digest(asset)}.bin`;fs.writeFileSync(path.join(folder,assetName),asset);
 const manifest:any={status:'capture-produced',fixtureOrigin:origin,lifetime:{canceled:false},process:{aliveAfterClose:false},cleanup:{status:'closed-gracefully',exitObserved:true},pageFailures:[],
  capture:{file:'capture.png',bytes:png.length,sha256:digest(png)},accessibility:{file:'axe.json',sha256:digest(axe),status:'measured',mergeAuthority:false},
  responses:[probe('/mobile/browser-devices/status'),probe('/work-board'),{method:'GET',url:origin+'/dashboard/console/console.js',status:200,contentType:'application/javascript',bytes:asset.length,sha256:digest(asset),file:assetName}] as any[]};
 const seed=JSON.parse(fs.readFileSync(new URL('../design/seeds/accounts.json',import.meta.url),'utf8'));
 const bodies:Record<string,unknown>={
  '/subscription-pool?scope=pool':{enabled:true,accounts:seed.states.busy.subscriptionPool.accounts,pool:{failed:[]}},
  '/subscription-relogin?scope=pool':{enabled:true,episodes:[],blockers:[]},
  '/subscription-pool/in-use':{enabled:true,activeAccountId:'seed-account-1'},
  '/pool':{machines:[{machineId:'seed-studio',nickname:'Meadow Studio'},{machineId:'seed-notebook',nickname:'River Notebook'}]},
 };
 for(const [key,value]of Object.entries(bodies)){
  const bytes=Buffer.from(JSON.stringify(value)),file=`responses/${digest(bytes)}.bin`;fs.writeFileSync(path.join(folder,file),bytes);
  manifest.responses.push({method:'GET',url:origin+key,status:200,contentType:'application/json',bytes:bytes.length,sha256:digest(bytes),file});
 }
 const expected=deriveAccountsExpectation('busy',bodies,Date.parse('2026-11-01T12:00:00Z'));
 Object.assign(manifest,{parentCase:{fixtureRunId:undefined,seedState:'busy'},readiness:{
  painted:true,listPresent:true,skeleton:false,wholePageUnknown:false,headline:expected.headline,names:expected.names,rowCount:expected.accountCount,notes:[],
  display:{innerWidth:1280,innerHeight:728,devicePixelRatio:1,visualScale:1,themeAttribute:'dark',prefersDark:true,prefersLight:false,mediaMax768:false,backgroundToken:'#0a0e17',rootZoom:'1',bodyZoom:'1'},
 }});
 const visibleBox=(width=700,height=50)=>({connected:true,nativeVisible:true,display:'block',visibility:'visible',opacity:1,contentVisibility:'visible',rectCount:1,rect:{x:0,y:0,width,height}});
 manifest.readiness.visibility={main:visibleBox(1280,700),heading:visibleBox(),list:visibleBox(1200,500),firstRow:visibleBox(),notes:[]};
 manifest.parentCase.fixtureRunId=providerBinding(ledger.provider,origin).runId;
 const manifestPath=path.join(folder,'manifest.json');const save=()=>fs.writeFileSync(manifestPath,JSON.stringify(manifest));save();
 const config={fixtureOrigin:origin,bootNonce:'a'.repeat(64),seedNow:'2026-11-01T12:00:00Z',viewport:'desktop',theme:'dark',runDir:root,rendererDir:root,stepRemainingMs:120_000};
 return {root,origin,folder,ledger,manifest,manifestPath,save,config,probe};
}
