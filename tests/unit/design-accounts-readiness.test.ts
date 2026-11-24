import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertAccountsWitness, deriveAccountsExpectation, assertAccountsModelWitness, validateParentCase, terminalAccountsPaint } from '../design/harness/accountsReadiness.mjs';
afterEach(()=>vi.unstubAllGlobals());
const visibleBox=(width=700,height=50)=>({connected:true,nativeVisible:true,display:'block',visibility:'visible',opacity:1,contentVisibility:'visible',rectCount:1,rect:{x:0,y:0,width,height}});
const seed=JSON.parse(fs.readFileSync('tests/design/seeds/accounts.json','utf8'));
function bodies(state='busy') {return {
 '/subscription-pool?scope=pool':{enabled:true,accounts:state==='busy'?seed.states.busy.subscriptionPool.accounts:[],pool:{failed:state==='error'?[{machineId:'seed-studio',error:'peer-pool-invalid'}]:[]}},
 '/subscription-relogin?scope=pool':{episodes:[],blockers:[]},'/subscription-pool/in-use':{activeAccountId:null},'/pool':{machines:[]},
};}
function witness(state='busy') {
 const expected=deriveAccountsExpectation(state,bodies(state),Date.parse(seed.now));
 return {expected,view:{painted:true,listPresent:true,skeleton:false,wholePageUnknown:false,rowCount:expected.accountCount,names:expected.names,headline:expected.headline,notes:expected.partial?[expected.partial]:[],
 visibility:{main:visibleBox(768,500),heading:visibleBox(),list:visibleBox(700,state==='busy'?400:0),firstRow:state==='busy'?visibleBox():null,notes:expected.partial?[{text:expected.partial,box:visibleBox()}]:[]},
 display:{innerWidth:768,innerHeight:1024,devicePixelRatio:1,visualScale:1,themeAttribute:'dark',prefersDark:true,prefersLight:false,mediaMax768:true,backgroundToken:'#0a0e17',rootZoom:'1',bodyZoom:'1'}}};
}
describe('parent-trusted Accounts terminal readiness',()=>{
 it.each(['busy','empty','error'])('derives %s from the real model and accepts its terminal witness',state=>{
  const {expected,view}=witness(state);assertAccountsWitness(view,{seedState:state,viewport:{width:768,height:1024},theme:'dark'});assertAccountsModelWitness(view,expected);
  expect(expected.accountCount).toBe(state==='busy'?14:0);expect(expected.failedCount>0).toBe(state==='error');
 });
 it.each(['busy','empty','error'])('refuses another state presented as %s',state=>{
  const other=state==='error'?'empty':'error';expect(()=>deriveAccountsExpectation(state,bodies(other),Date.parse(seed.now))).toThrow();
 });
 it('refuses incomplete API evidence and incorrect names/headline/count/partial note',()=>{
  const {view,expected}=witness('error');expect(()=>deriveAccountsExpectation('error',{},Date.parse(seed.now))).toThrow();
  for(const patch of [{rowCount:1},{headline:'Fake ready'},{names:['Made up']},{notes:[]}])expect(()=>assertAccountsModelWitness({...view,...patch},expected)).toThrow();
 });
 it('refuses skeleton or whole-page unknown as a completed terminal list',()=>{
  const {view}=witness('empty');for(const patch of [{painted:false},{listPresent:false},{skeleton:true},{wholePageUnknown:true}])expect(()=>assertAccountsWitness({...view,...patch},{seedState:'empty',viewport:{width:768,height:1024},theme:'dark'})).toThrow();
 });
 it.each([{innerWidth:390},{innerHeight:844},{themeAttribute:'light'},{prefersDark:false},{prefersLight:true},{devicePixelRatio:2},{visualScale:2},{mediaMax768:false},{backgroundToken:''},{rootZoom:'2'}])('refuses an observed display mismatch %j',patch=>{
  const {view}=witness('empty');expect(()=>assertAccountsWitness({...view,display:{...view.display,...patch}},{seedState:'empty',viewport:{width:768,height:1024},theme:'dark'})).toThrow();
 });
 it('accepts actual light attribute and media only when the trusted case requests light',()=>{
  const {view}=witness('empty');view.display.themeAttribute='light';view.display.prefersDark=false;view.display.prefersLight=true;
  expect(()=>assertAccountsWitness(view,{seedState:'empty',viewport:{width:768,height:1024},theme:'light'})).not.toThrow();
 });
 it('rejects loading/native-failure/zoom case claims instead of silently admitting later slices',()=>{
  for(const value of [{fixtureRunId:'a'.repeat(32),seedState:'loading'},{fixtureRunId:'a'.repeat(32),seedState:'busy',allow503:true},{fixtureRunId:'unknown',seedState:'empty'}])expect(()=>validateParentCase(value)).toThrow();
 });
});

describe('terminal rendered visibility boundary',()=>{
 it.each(['hidden-main','hidden-list','zero-main','zero-list','zero-busy-list','zero-heading','hidden-first-row'] as const)('rejects correct busy model/text with %s',mode=>{
  const {view}=witness('busy');
  if(mode==='hidden-main')view.visibility.main.display='none';
  if(mode==='hidden-list')view.visibility.list.visibility='hidden';
  if(mode==='zero-main')view.visibility.main.rect.width=0;
  if(mode==='zero-list')view.visibility.list.rect.width=0;
  if(mode==='zero-busy-list')view.visibility.list.rect.height=0;
  if(mode==='zero-heading')view.visibility.heading.rect.height=0;
  if(mode==='hidden-first-row')view.visibility.firstRow!.nativeVisible=false;
  expect(()=>assertAccountsWitness(view,{seedState:'busy',viewport:{width:768,height:1024},theme:'dark'})).toThrow();
 });
 it('accepts an actually displayed empty list with legitimate zero height',()=>{
  const {view}=witness('empty');expect(view.visibility.list.rect.height).toBe(0);
  expect(()=>assertAccountsWitness(view,{seedState:'empty',viewport:{width:768,height:1024},theme:'dark'})).not.toThrow();
 });
 it('rejects a hidden partial-error note despite correct model text',()=>{
  const {view,expected}=witness('error');view.visibility.notes[0].box.visibility='hidden';
  expect(()=>assertAccountsModelWitness(view,expected)).toThrow();
 });
 it('does not treat hidden but present DOM as a terminal paint',()=>{
  const node=(display='block',height=50)=>({isConnected:true,styleFacts:{display,visibility:'visible',opacity:'1',contentVisibility:'visible'},checkVisibility:()=>true,
    getBoundingClientRect:()=>({x:0,y:0,width:700,height}),getClientRects:()=>[{}],textContent:'Accounts'});
  const list=node('block',0),heading=node(),main=Object.assign(node('none',500),{dataset:{painted:'1'},querySelector:(selector:string)=>selector==='.acct-list'?list:selector==='.page-title'?heading:null,querySelectorAll:()=>[]});
  vi.stubGlobal('document',{querySelector:()=>main});
  vi.stubGlobal('getComputedStyle',(target:any)=>target.styleFacts);
  expect(terminalAccountsPaint()).toBe(false);
  main.styleFacts.display='block';expect(terminalAccountsPaint()).toBe(true);
  list.styleFacts.visibility='hidden';expect(terminalAccountsPaint()).toBe(false);
 });
});

it('requires real visible loading shape rather than terminal text, and preserves display checks',()=>{
 const {view}=witness('empty');const loading={...view,painted:false,listPresent:false,skeleton:true,headline:'Loading accounts'};
 const options={seedState:'busy',loading:true,viewport:{width:768,height:1024},theme:'dark'};
 expect(()=>assertAccountsWitness(loading,options)).not.toThrow();
 for(const patch of [{painted:true},{listPresent:true},{wholePageUnknown:true},{names:['stale']},{skeleton:false},{rowCount:1},{headline:'Accounts'},{visibility:{...loading.visibility,heading:{...loading.visibility.heading,nativeVisible:false}}}])expect(()=>assertAccountsWitness({...loading,...patch},options)).toThrow();
});
