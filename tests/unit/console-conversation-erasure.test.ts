import {afterEach,describe,it,expect,vi} from 'vitest';
import {JSDOM} from 'jsdom';
let dom:JSDOM;
const settle=async()=>{for(let i=0;i<6;i++)await new Promise(r=>setTimeout(r,0));};
afterEach(()=>{dom?.window.dispatchEvent(new dom.window.Event('instar-owner-locked'));dom?.window.close();vi.unstubAllGlobals();vi.restoreAllMocks();});
async function boot(handler:(path:string,body?:any)=>Promise<any>|any){
 vi.resetModules();dom=new JSDOM('<html><body><main></main></body></html>',{url:'http://localhost/dashboard/console/'});
 for(const key of ['window','document','location','sessionStorage'])vi.stubGlobal(key,(dom.window as any)[key]);
 vi.stubGlobal('requestAnimationFrame',(cb:any)=>setTimeout(cb,0));
 const ui=await import('../../dashboard/console/ui.js');ui.rememberOperatorSession({operatorSessionToken:'owner-proof-canary',operatorSessionExpiresAt:new Date(Date.now()+600000).toISOString()});
 const {erasureControls}=await import('../../dashboard/console/conversation-erasure.js');
 const calls:any[]=[];const unlock=vi.fn();
 const mount=(kind='effort',correction:any={headerForgotten:false})=>{const control=erasureControls({canErase:correction!==null,headerForgotten:correction?.headerForgotten===true,node:{kind,key:'opaque-node-key',ref:{kind:'effort',id:'012fdaec-70de-4324-9ef3-22b616fc83ce'},title:'private-title-canary'},correction,
  send:async(path:string,body?:any)=>{calls.push({path,body});return (await handler(path,body))??{ok:false,status:404,data:{code:'erasure-not-found'}};},current:()=>true,unlock,refresh:vi.fn()});if(control)document.querySelector('main')!.append(control);return control;};
 const button=(text:string)=>[...document.querySelectorAll('[role=dialog] button'),...document.querySelectorAll('button')].find(b=>b.textContent===text) as HTMLButtonElement;
 return{ui,mount,calls,button,unlock};
}
const stable='erasev1_'+ 'a'.repeat(64),scope='opaque-node-key:erase-header';
const ledgerKey='instar-conversation-write-ids:http://localhost/dashboard/console/';
const target={sourceKind:'header',sourceId:'hdr-1111111111111111'};
const pending=(id=stable)=>({ok:true,data:{requestId:id,target,localHidden:true,liveGraphStoresPurged:true,fleetComplete:false}});
const seed=(entries:any[])=>sessionStorage.setItem(ledgerKey,JSON.stringify(entries));
const ordinary=()=>Array.from({length:32},(_,n)=>({subject:'ordinary-'+n,requestId:'ordinary-request-'+n}));
describe('priority effort-name removal UI',()=>{
 it('does not expose deletion on conversations or without privacy authority',async()=>{const f=await boot(()=>undefined);expect(f.mount('conversation')).toBeNull();expect(f.mount('effort',null)).toBeNull();expect(f.calls).toEqual([]);});
 it('requires confirmation, uses server identity and distinguishes live purge from unknown backups',async()=>{
  const f=await boot(path=>path.endsWith('/ensure')?pending():undefined);f.mount()!.click();await settle();
  expect(f.calls.filter(c=>c.path.endsWith('/ensure'))).toHaveLength(0);expect(document.querySelector('[role=dialog]')?.textContent).toContain('Original messages stay');
  f.button('Forget name').click();await settle();const writes=f.calls.filter(c=>c.path.endsWith('/ensure'));expect(writes).toHaveLength(1);
  expect(writes[0].body).toEqual({effort:{kind:'effort',id:'012fdaec-70de-4324-9ef3-22b616fc83ce'}});
  expect(document.querySelector('[role=dialog]')?.textContent).toContain('Backup removal is not verified');expect(sessionStorage.length).toBe(0);expect(f.button('Retry same removal')).toBeUndefined();
 });
 it.each(['full','unavailable'])('does not block priority removal on ordinary tracking capacity (%s)',async mode=>{
  const f=await boot(path=>path.endsWith('/ensure')?pending():undefined);if(mode==='full')seed(ordinary());else{
   vi.spyOn(dom.window.Storage.prototype,'getItem').mockImplementation(()=>{throw new Error('storage-unavailable');});
   vi.spyOn(dom.window.Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('storage-unavailable');});
  }
  f.mount()!.click();await settle();f.button('Forget name').click();await settle();expect(f.calls.some(c=>c.path.endsWith('/ensure'))).toBe(true);
  expect(document.querySelector('[role=dialog]')?.textContent).toContain('Backup removal is not verified');if(mode==='full')expect(JSON.parse(sessionStorage.getItem(ledgerKey)!)).toEqual(ordinary());
 });
 it('restores server-accepted removal after reload without retaining a browser slot',async()=>{
  const f=await boot(path=>path.endsWith('/discover')?{ok:true,data:{requestId:stable,target,continuity:{publication:'published'}}}:path.includes('/erasures/')?pending():undefined);
  f.mount('effort',{headerForgotten:true})!.click();await settle();expect(f.calls.at(-1).path).toBe('/conversation-graph/erasures/'+stable);expect(f.calls.some(c=>c.path.endsWith('/ensure'))).toBe(false);expect(sessionStorage.length).toBe(0);
 });
 it('preserves an unknown legacy UUID and retries only that identity',async()=>{
  const f=await boot(path=>path.endsWith('/discover')?undefined:{ok:false,status:503,data:{}});seed([{subject:scope,requestId:'legacy-request-0001'}]);
  f.mount()!.click();await settle();expect(f.calls.at(-1).path).toBe('/conversation-graph/erasures/legacy-request-0001');f.button('Retry same removal').click();await settle();
  expect(f.calls.at(-1)).toMatchObject({path:'/conversation-graph/forget-header',body:{requestId:'legacy-request-0001'}});expect(f.calls.some(c=>c.path.endsWith('/ensure'))).toBe(false);expect(JSON.parse(sessionStorage.getItem(ledgerKey)!)[0].requestId).toBe('legacy-request-0001');
 });
 it('drops a legacy browser slot only when matching published server continuity is discovered',async()=>{
  const f=await boot(path=>path.endsWith('/discover')?{ok:true,data:{requestId:'legacy-request-0001',target,continuity:{publication:'published'}}}:path.includes('/erasures/')?pending('legacy-request-0001'):undefined);
  seed([{subject:scope,requestId:'legacy-request-0001'}]);f.mount()!.click();await settle();expect(JSON.parse(sessionStorage.getItem(ledgerKey)!)).toEqual([]);expect(f.calls.some(c=>c.path.endsWith('/ensure'))).toBe(false);
 });
 it('restores a known UUID even when ordinary edits and new privacy capability are unavailable',async()=>{
  const f=await boot(()=>undefined);seed([{subject:scope,requestId:'legacy-request-0001'}]);f.mount('effort',null)!.click();await settle();expect(f.calls.at(-1).path).toBe('/conversation-graph/erasures/legacy-request-0001');expect(f.button('Retry same removal')).toBeUndefined();
 });
 it.each(['contradictory','different-request'])('does not clear a known request for malformed completion (%s)',async mode=>{
  const f=await boot(path=>path.endsWith('/discover')?undefined:{ok:true,data:{requestId:mode==='different-request'?'wrong-request-0001':'legacy-request-0001',localHidden:true,liveGraphStoresPurged:mode!=='contradictory',capturedGraphCopiesComplete:true,fleetComplete:true,waitingCopyCount:0,memberBackupDebtCount:0,witnessPurge:{walPurged:true,externalBackupsVerified:true}}});
  seed([{subject:scope,requestId:'legacy-request-0001'}]);f.mount()!.click();await settle();expect(document.querySelector('[role=dialog]')?.textContent).not.toContain('Name removal verified');expect(JSON.parse(sessionStorage.getItem(ledgerKey)!)).toHaveLength(1);
 });
 it('keeps keyboard focus in the confirmation sheet',async()=>{
  const f=await boot(()=>undefined);f.mount()!.click();await settle();const last=f.button('Forget name');last.focus();last.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));expect(document.activeElement).toBe(document.querySelector('.sheet-close'));
 });
 it('scrubs immediately on owner lock and ignores a late private response',async()=>{
  let release!:(v:any)=>void;const waiting=new Promise(r=>{release=r;});const f=await boot(path=>path.endsWith('/ensure')?waiting:undefined);
  f.mount()!.click();await settle();f.button('Forget name').click();await settle();f.ui.forgetOperatorSession();expect(document.querySelector('[role=dialog]')).toBeNull();release(pending());await settle();expect(document.body.textContent).not.toContain('Backup removal');expect(f.unlock).toHaveBeenCalled();
 });
});
