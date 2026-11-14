import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

let dom: JSDOM;
const flush = () => new Promise((r) => setTimeout(r, 0));
const row = (n: number) => ({ ref: { kind: 'effort', id: `effort-${n}` }, title: `Effort ${n}`, kind: 'effort', role: 'front-door', visibleChildCount: 1, primaryPath: [] });
const page = (items: unknown[], nextCursor: string | null = null) => ({ revision: 'r1', asOf: '2026-11-05T09:00:00Z', partial: false, items, nextCursor });

afterEach(async () => {
  if (dom) { const { closeSheet } = await import('../../dashboard/console/ui.js'); closeSheet(); }
  dom?.window.close(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function boot(hash: string, handler: (url: string, options?: any) => { status?: number; body: unknown } | Promise<{status?:number;body:unknown}>) {
  vi.resetModules();
  dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', { url: `http://localhost:4040/dashboard/console/${hash}` });
  for (const key of ['window', 'document', 'location', 'history', 'localStorage', 'sessionStorage']) vi.stubGlobal(key, (dom.window as any)[key]);
  vi.stubGlobal('requestAnimationFrame', (f: () => void) => setTimeout(f, 0));
  dom.window.scrollTo = vi.fn();
  dom.window.localStorage.setItem('instar_token', 'bearer');
  const requests: Array<{ url: string; headers: Record<string, string>; method?:string; body?:string }> = [];
  vi.stubGlobal('fetch', async (url: string, options: any = {}) => {
    requests.push({ url, headers: options.headers || {}, method:options.method,body:options.body });
    const response = await (url === '/dashboard/unlock-check' ? { body: { accepted: true } }
      : url === '/dashboard/unlock' ? { body: { token: 'bearer', operatorSessionToken: 'human-proof', operatorSessionExpiresAt: new Date(Date.now() + 900000).toISOString() } }
        : handler(url,options));
    const status = response.status || 200;
    return { status, ok: status < 400, json: async () => response.body };
  });
  const { renderConversations } = await import('../../dashboard/console/conversations.js');
  const main = dom.window.document.querySelector('main')!;
  const render = () => renderConversations(main);
  await render();
  expect(requests).toHaveLength(0); // No owner read before PIN proof.
  (main.querySelector('button') as HTMLButtonElement).click();
  await flush();
  const input = dom.window.document.querySelector('.pin-input') as HTMLInputElement;
  input.value = '123456';
  dom.window.document.querySelector('.pin-form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  for (let i = 0; i < 8; i++) await flush();
  return { main, requests, render };
}

describe('native console Conversations', () => {
  it('clears private DOM on PIN-proof expiry without waiting for page refresh or sheet dismissal', async()=>{
    const f=await boot('#/work/conversations',url=>({body:url.includes('/pending')?{items:[]}:{...page([{...row(0),title:'PRIVATE-EXPIRY-CANARY'}]),capabilities:{ownerCorrections:true}}}));
    expect(f.main.textContent).toContain('PRIVATE-EXPIRY-CANARY');
    const create=[...f.main.querySelectorAll('button')].find(button=>button.textContent==='Create effort')!;
    create.click();for(let i=0;i<4;i++)await flush();
    expect(document.querySelector('[role=dialog]')).not.toBeNull();
    const before=f.requests.length,actualNow=Date.now();vi.spyOn(Date,'now').mockReturnValue(actualNow+901000);
    for(let i=0;i<80&&!f.main.textContent?.includes('Unlock to see');i++)await new Promise(resolve=>setTimeout(resolve,10));
    expect(f.main.textContent).not.toContain('PRIVATE-EXPIRY-CANARY');expect(f.main.textContent).toContain('Unlock to see');
    expect(document.querySelector('[role=dialog]')).toBeNull();expect(f.requests.length).toBe(before);
  });

  it.each([false,true,'true'])('keeps privacy erasure separate from unavailable ordinary correction capability (%s)',async ownerErasure=>{
    const {main,requests}=await boot('#/work/conversations?node=retained-effort',()=>({body:{partial:true,replicationState:'pending',node:row(1),children:{items:[],nextCursor:null},capabilities:{ownerCorrections:false,ownerErasure},erasure:{headerForgotten:false}}}));
    expect([...main.querySelectorAll('button')].some(b=>b.textContent==='Forget name')).toBe(ownerErasure===true);expect([...main.querySelectorAll('button')].some(b=>['Move','Rename effort','Choose front door'].includes(b.textContent||''))).toBe(false);
    if(ownerErasure===true){([...main.querySelectorAll('button')].find(b=>b.textContent==='Forget name') as HTMLButtonElement).click();expect(document.querySelector('[role=dialog]')?.textContent).toContain('Original messages stay');expect(requests.some(r=>r.method==='POST'&&r.url==='/conversation-graph/forget-header')).toBe(false);}
  });

  it.each([false,true])('mounts root effort creation only with actual server capability (%s)',async enabled=>{
    const {main}=await boot('#/work/conversations',()=>({body:{...page([]),capabilities:{ownerCorrections:enabled}}}));
    expect([...main.querySelectorAll('button')].some(b=>b.textContent==='Create effort')).toBe(enabled);
  });
  it.each(['effort','conversation'])('mounts effort controls only on an effort node (%s)',async kind=>{
    const node=kind==='effort'?row(1):{ref:{kind:'conversation',platform:'telegram',chatId:'-100123',topicId:42},title:'Worker'};
    const {main}=await boot('#/work/conversations?node=opaque-node',url=>url.endsWith('/pending')?{body:{items:[]}}:{body:{partial:false,node,children:{items:[],nextCursor:null},correction:{moveEligible:true,replacesPlacementEventIds:[],replacesFrontDoorEventIds:[],headerVersion:0}}});
    expect([...main.querySelectorAll('button')].some(b=>b.textContent==='Rename effort')).toBe(kind==='effort');
    expect([...main.querySelectorAll('button')].some(b=>b.textContent==='Choose front door')).toBe(kind==='effort');
  });
  it('synchronously clears an actual mounted naming sheet when owner proof is forgotten',async()=>{
    await boot('#/work/conversations?node=opaque-node',url=>url.endsWith('/pending')?{body:{items:[]}}:{body:{partial:false,node:row(1),children:{items:[],nextCursor:null},correction:{moveEligible:true,replacesPlacementEventIds:[],replacesFrontDoorEventIds:[],headerVersion:0}}});
    ([...document.querySelectorAll('button')].find(b=>b.textContent==='Rename effort') as HTMLButtonElement).click();for(let i=0;i<5;i++)await flush();
    const input=document.querySelector('[role=dialog] input') as HTMLInputElement;input.value='private mounted draft';
    const {forgetOperatorSession}=await import('../../dashboard/console/ui.js');forgetOperatorSession();
    expect(input.value).toBe('');expect(document.querySelector('[role=dialog]')).toBeNull();expect(document.querySelector('main')?.textContent).toContain('Unlock');
  });

  it.each([undefined,'not-recorded'])('retains uncertain request IDs and clears only an authoritative pre-admission rejection (%s)',async(requestState)=>{
    await boot('#/work/conversations?node=effort-1',url=>{
      if(url.endsWith('/pending'))return{body:{items:[]}};
      if(url.includes('/destinations?'))return{body:page([row(2)])};
      if(url.endsWith('/preview'))return{body:{eligible:true}};
      if(url.endsWith('/changes'))return{status:409,body:{code:'placement-conflict',...(requestState?{requestState}:{})}};
      return{body:{partial:false,node:row(1),children:{items:[],nextCursor:null},path:[],links:[],correction:{moveEligible:true,replacesPlacementEventIds:[]}}};
    });
    const button=(label:string)=>[...dom.window.document.querySelectorAll('button')].find(button=>button.textContent===label) as HTMLButtonElement;
    button('Move').click();for(let i=0;i<5;i++)await flush();button('Effort 2').click();for(let i=0;i<5;i++)await flush();
    button('Confirm move').click();for(let i=0;i<5;i++)await flush();
    const tracked=JSON.parse(dom.window.sessionStorage.getItem(dom.window.sessionStorage.key(0)!)!);
    expect(tracked).toHaveLength(requestState==='not-recorded'?0:1);
  });
  it.each([null,'prior-request-0001'])('blocks destination search until pending restoration finishes (%s)',async(requestId)=>{
    let release!:(value:{body:unknown})=>void;
    const pending=new Promise<{body:unknown}>(resolve=>{release=resolve;});
    const {requests}=await boot('#/work/conversations?node=effort-1',url=>{
      if(url.endsWith('/pending'))return pending;
      if(url.includes('/changes/'))return{status:202,body:{state:'saved-pending'}};
      if(url.includes('/destinations?'))return{body:page([row(2)])};
      return{body:{partial:false,node:row(1),children:{items:[],nextCursor:null},path:[],links:[],correction:{moveEligible:true,replacesPlacementEventIds:[]}}};
    });
    ([...dom.window.document.querySelectorAll('button')].find(button=>button.textContent==='Move') as HTMLButtonElement).click();
    const search=dom.window.document.querySelector('[role=dialog] input') as HTMLInputElement;
    expect(search.disabled).toBe(true);search.value='other';search.dispatchEvent(new dom.window.Event('change'));
    for(let i=0;i<3;i++)await flush();
    expect(requests.some(request=>request.url.includes('/destinations?'))).toBe(false);
    release({body:{items:[{subject:row(1).ref,requestId}]}});for(let i=0;i<5;i++)await flush();
    search.dispatchEvent(new dom.window.Event('change'));for(let i=0;i<3;i++)await flush();
    expect(search.disabled).toBe(true);
    expect(requests.some(request=>request.url.includes('/destinations?'))).toBe(false);
    expect(requests.some(request=>request.url==='/conversation-graph/changes')).toBe(false);
  });
  it('previews a move, leaves canonical content unchanged while Saved Pending, and confirms cancellation by status',async()=>{
    const {main,requests}=await boot('#/work/conversations?node=effort-1',(url)=>{
      if(url.endsWith('/pending'))return{body:{items:[]}};
      if(url.includes('/destinations?'))return{body:page([row(2)])};
      if(url.endsWith('/preview'))return{body:{eligible:true}};
      if(url.endsWith('/cancel'))return{status:202,body:{state:'cancel-pending'}};
      if(url.includes('/changes/'))return{body:{state:'canceled',requestId:decodeURIComponent(url.split('/').at(-1)!)}};
      if(url.endsWith('/changes'))return{status:202,body:{state:'saved-pending',custody:{kind:'external-custody'},eventId:'graph-event:change-abcdefgh',waitingMachines:[{machineId:'peer',name:'Sleeping laptop'}],cancelEligible:true}};
      return{body:{partial:false,node:row(1),children:{items:[],nextCursor:null},path:[],links:[],correction:{moveEligible:true,replacesPlacementEventIds:[]}}};
    });
    const button=(label:string)=>[...dom.window.document.querySelectorAll('button')].find(button=>button.textContent===label) as HTMLButtonElement;
    button('Move').click();for(let i=0;i<5;i++)await flush();button('Effort 2').click();for(let i=0;i<5;i++)await flush();
    expect(dom.window.document.querySelector('[role=dialog]')?.textContent).toContain('Move from Unassigned to Effort 2');
    button('Confirm move').click();for(let i=0;i<5;i++)await flush();
    expect(dom.window.document.querySelector('[role=dialog]')?.textContent).toContain('Saved independently, waiting for sync with Sleeping laptop');
    expect(main.querySelector('h1')?.textContent).toBe('Effort 1');
    const write=requests.find(request=>request.url==='/conversation-graph/changes')!;
    expect(JSON.parse(write.body!).change).toMatchObject({kind:'set-primary-placement',subject:row(1).ref,parent:row(2).ref,replacesPlacementEventIds:[]});
    button('Cancel change').click();for(let i=0;i<5;i++)await flush();
    expect(dom.window.document.querySelector('[role=dialog]')?.textContent).toContain('Cancellation is waiting');
    button('Check status').click();for(let i=0;i<5;i++)await flush();
    expect(dom.window.document.querySelector('[role=dialog]')?.textContent).toContain('Canceled. The agreed placement stays as it was.');
  });
  it('retries the exact request identity after an uncertain response',async()=>{
    let writes=0;
    const {requests}=await boot('#/work/conversations?node=effort-1',(url)=>{
      if(url.endsWith('/pending'))return{body:{items:[]}};
      if(url.includes('/destinations?'))return{body:page([row(2)])};
      if(url.endsWith('/preview'))return{body:{eligible:true}};
      if(url.endsWith('/changes')){if(++writes===1)throw new Error('connection interrupted');return{body:{state:'committed'}};}
      if(url.includes('/changes/'))return{status:404,body:{code:'not-found'}};
      return{body:{partial:false,node:row(1),children:{items:[],nextCursor:null},path:[],links:[],correction:{moveEligible:true,replacesPlacementEventIds:[]}}};
    });
    const button=(label:string)=>[...dom.window.document.querySelectorAll('button')].find(button=>button.textContent===label) as HTMLButtonElement;
    button('Move').click();for(let i=0;i<5;i++)await flush();button('Effort 2').click();for(let i=0;i<5;i++)await flush();
    button('Confirm move').click();for(let i=0;i<5;i++)await flush();
    expect(dom.window.document.querySelector('[role=dialog]')?.textContent).toContain('save has not been confirmed');
    const entry=JSON.parse(dom.window.sessionStorage.getItem(dom.window.sessionStorage.key(0)!)!)[0];
    expect(Object.keys(entry).sort()).toEqual(['requestId','subject']);
    (dom.window.document.querySelector('.sheet-close') as HTMLButtonElement).click();
    button('Move').click();for(let i=0;i<5;i++)await flush();
    expect(requests.filter(request=>request.url==='/conversation-graph/changes')).toHaveLength(1);
    expect(requests.some(request=>request.url===`/conversation-graph/changes/${entry.requestId}`)).toBe(true);
    button('Retry same request').click();for(let i=0;i<5;i++)await flush();
    const intents=requests.filter(request=>request.url==='/conversation-graph/changes');
    expect(intents).toHaveLength(2);expect(intents[0].body).toBe(intents[1].body);
    expect(dom.window.document.querySelector('[role=dialog]')?.textContent).toContain('Placement updated.');
  });
  it('requires human unlock and shows five safe text rows with All and search reachable', async () => {
    const { main, requests } = await boot('#/work/conversations', () => ({ body: page(Array.from({ length: 7 }, (_, n) => row(n))) }));
    expect(main.querySelectorAll('.conversation-row')).toHaveLength(5);
    expect(main.textContent).toContain('All conversations');
    expect(main.querySelector('input[type=search]')).not.toBeNull();
    const graph = requests.find((r) => r.url.startsWith('/conversation-graph/'))!;
    expect(graph.headers).toMatchObject({ Authorization: 'Bearer bearer', 'X-Instar-Operator-Session': 'human-proof' });
    expect(dom.window.localStorage.getItem('human-proof')).toBeNull();
  });
  it('search is server scoped, paging preserves query, and title text cannot inject markup', async () => {
    const { main, requests } = await boot('#/work/conversations?view=all&q=ship', (url) => ({ body: url.includes('cursor=')
      ? page([{ ...row(2), title: '<img src=x onerror=alert(1)>' }]) : page([row(1)], 'next+/=') }));
    expect(requests.some((r) => r.url === '/conversation-graph/roots?view=all&q=ship')).toBe(true);
    ([...main.querySelectorAll('button')].find((b) => b.textContent === 'Show more') as HTMLButtonElement).click();
    for (let i = 0; i < 5; i++) await flush();
    expect(requests.some((r) => r.url.includes('q=ship&cursor=next%2B%2F%3D'))).toBe(true);
    expect(main.querySelectorAll('.conversation-row')).toHaveLength(2);
    expect(main.querySelector('img')).toBeNull();
    expect(main.textContent).toContain('<img src=x');
  });
  it('drops private rows on expired operator proof instead of retaining a cached owner view', async () => {
    let expired = false;
    const { main, render } = await boot('#/work/conversations', () => expired ? { status: 403, body: { code: 'operator-session-expired' } } : { body: page([row(1)]) });
    expect(main.textContent).toContain('Effort 1');
    expired = true;
    await render();
    expect(main.textContent).not.toContain('Effort 1');
    expect(main.textContent).toContain('Unlock');
  });
  it('deep worker opens source before More and preserves search origin in Back', async () => {
    const { main } = await boot('#/work/conversations?view=all&q=worker&node=opaque-source', () => ({ body: {
      partial: false, node: { ...row(1), ref: { kind: 'conversation', platform: 'telegram', chatId: '-100123', topicId: 456 }, kind: 'conversation', title: 'Worker', platform: 'telegram', openUrl: 'https://t.me/c/123/456' },
      path: [row(0)], children: { items: [], nextCursor: null }, links: [], provenance: [],
    } }));
    const more = main.querySelector('details')!;
    const platform = more.querySelector('a.btn-quiet');
    expect(platform?.getAttribute('href')).toBe('https://t.me/c/123/456');
    expect(platform?.textContent).toBe('Open in Telegram');
    expect(main.querySelector('a.btn-primary')).toBeNull();
    expect(more.textContent).toContain('Front door');
    expect(main.querySelector('details')?.open).toBe(false);
    expect(main.querySelector('a')?.getAttribute('href')).toBe('#/work/conversations?view=all&q=worker');
  });
  it('a dark or missing route is an honest unavailable state', async () => {
    const { main } = await boot('#/work/conversations', () => ({ status: 503, body: { code: 'conversation-graph-off' } }));
    expect(main.textContent).toContain('not switched on');
    expect(main.textContent).not.toContain('No efforts');
  });
  it.each([200,404])('resolves a worker front door only from an authorized ancestor effort read (%s)',async(status)=>{
    const worker={kind:'conversation',platform:'telegram',chatId:'-100123',topicId:456};
    const frontDoor={kind:'conversation',platform:'telegram',chatId:'-100123',topicId:789};
    const effort=row(1).ref;
    const {encodeNodeRef}=await import('../../dashboard/console/conversations-model.js');
    const ancestorRoute=`/conversation-graph/nodes/${encodeNodeRef(effort)}`;
    const {main,requests}=await boot('#/work/conversations?view=all&q=worker&node=worker',url=>{
      if(url===ancestorRoute)return{status,body:{partial:false,node:{...row(1),metadata:{frontDoor}},path:[],children:{items:[],nextCursor:null},links:[]}};
      return{body:{partial:false,node:{ref:worker,title:'Worker',openUrl:'https://t.me/c/123/456'},path:[{ref:effort,title:'Effort'}],children:{items:[],nextCursor:null},links:[]}};
    });
    expect(requests.filter(r=>r.url===ancestorRoute)).toHaveLength(0);
    const details=main.querySelector('details')!;details.open=true;details.dispatchEvent(new dom.window.Event('toggle'));
    for(let i=0;i<5;i++)await flush();
    expect(requests.filter(r=>r.url===ancestorRoute)).toHaveLength(1);
    const shortcut=[...details.querySelectorAll('a')].find(a=>a.textContent==='Go to front door');
    expect(!!shortcut).toBe(status===200);
    if(shortcut)expect(shortcut.getAttribute('href')).toContain(encodeNodeRef(frontDoor));
    expect([...main.querySelectorAll('a')].find(a=>a.textContent==='Back to results')?.getAttribute('href')).toBe('#/work/conversations?view=all&q=worker');
  });
});
