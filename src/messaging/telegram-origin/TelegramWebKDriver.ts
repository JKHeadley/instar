import { createHash } from 'node:crypto';
import { browserPeerMatches, canonicalBrowserJson, type BrowserDestination, type BrowserJson, type BrowserCanary, type PreparedBrowserChild, type TelegramBrowserDriver } from './BrowserTypes.js';
import { BrowserProtocolError, PrivateCdpPipe } from './PrivateCdpPipe.js';
import { TelegramRpcRefusal } from './TelegramBrowserBroker.js';
import { randomUUID } from 'node:crypto';

export interface WebKBuildEnrollment {
  buildId: string;
  /** Exact loaded critical bundle names from the read-only deployment canary, sorted before hashing. */
  criticalAssets: string[];
  /** SHA-256 of each exact public bundle, not just its content-shaped filename. */
  assetDigests: Record<string, string>;
}
export interface TelegramWebKOptions {
  executablePath: string;
  userDataDir: string;
  accountNumber: number;
  expectedAccountId: string;
  supportedBuilds: WebKBuildEnrollment[];
  startupTimeoutMs?: number;
}
/** Web K's client-side error for an rpc_result it could not deserialize (networker.ts, build 686+). */
export const WEB_K_UNREADABLE_RESULT = 'NETWORK_RESULT_UNREADABLE';
/** The only script surface is static code written here plus JSON data, never caller JS. */
const assetsExpression = `Array.from(new Set([...Array.from(document.scripts).map(s=>s.src), ...performance.getEntriesByType('resource').map(e=>e.name)]))
 .filter(u=>u.startsWith('https://web.telegram.org/k/')).map(u=>u.split('/').pop().split('?')[0])
 .filter(n=>/^(index-|app-|apiManagerProxy-|index\\.worker-).*\\.js$/.test(n)).sort()`;
/** Shared identity predicate pieces for every test-group page script. */
const TEST_GROUP_TITLE_PATTERN = String(/^Instar test - .{1,112} \[itg-[a-z2-7]{10}\]$/);
export const TEST_GROUP_REQUIRED_RIGHTS = Object.freeze(['manage_topics', 'pin_messages', 'delete_messages']);
/** `other` is the manage-chat right Telegram implies for every admin. Anything else fails. */
export const TEST_GROUP_ALLOWED_RIGHTS = Object.freeze([...TEST_GROUP_REQUIRED_RIGHTS, 'other']);
/** The static rights literal. tweb's serializer reads constructor flags from pFlags. */
export const TEST_GROUP_ADMIN_RIGHTS = canonicalBrowserJson({ _: 'chatAdminRights', pFlags: { manage_topics: true, pin_messages: true, delete_messages: true } });
const TEST_GROUP_LIST_BOUND = 100;
export function webKBuildFingerprint(assets: string[]): string {
  return createHash('sha256').update(canonicalBrowserJson([...new Set(assets)].sort())).digest('hex');
}
export function validWebKBuildEnrollment(build: WebKBuildEnrollment): boolean {
  return !!build && typeof build === 'object' && typeof build.buildId === 'string' && build.buildId.length > 0 && build.buildId.length <= 128 &&
    Array.isArray(build.criticalAssets) && build.criticalAssets.length >= 3 && build.criticalAssets.length <= 32 &&
    new Set(build.criticalAssets).size === build.criticalAssets.length && !!build.assetDigests &&
    Object.keys(build.assetDigests).length === build.criticalAssets.length && build.criticalAssets.every(asset =>
      /^[A-Za-z0-9._-]+\.js$/.test(asset) && /^[0-9a-f]{64}$/.test(build.assetDigests[asset] ?? ''));
}

export class TelegramWebKDriver implements TelegramBrowserDriver {
  private sessionId = '';
  private readonly pipe: PrivateCdpPipe;
  private readonly ready: Promise<void>;
  constructor(private readonly options: TelegramWebKOptions) {
    if (!Number.isSafeInteger(options.accountNumber) || options.accountNumber < 1 || options.accountNumber > 4
      || !/^[1-9][0-9]*$/.test(options.expectedAccountId)) throw new Error('invalid-web-account-enrollment');
    this.pipe = new PrivateCdpPipe(options);
    this.ready = this.initialize();
    // Construction may precede the first operation. Observe errors without hiding them from readiness.
    void this.ready.catch(() => this.close());
  }
  private async initialize(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([(async () => {
        const target = await this.pipe.request('Target.createTarget', { url: 'https://web.telegram.org/k/' }) as { targetId: string };
        const attached = await this.pipe.request('Target.attachToTarget', { targetId: target.targetId, flatten: true }) as { sessionId: string };
        this.sessionId = attached.sessionId;
        // The target initially owns an about:blank execution context. Navigation
        // may replace it between attach and evaluate; only this read-only
        // startup check retries that typed protocol error, never an invocation.
        for (let attempt = 0; attempt < 200; attempt++) {
          try {
            if (await this.evaluatePageScript(`location.origin==='https://web.telegram.org'&&location.pathname.startsWith('/k/')&&typeof window.createProxiedManagersForAccount==='function'`)) return;
          } catch (error) {
            if (!(error instanceof BrowserProtocolError) || !error.contextUnavailable) throw error;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error('web-manager-unavailable');
      })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('browser-startup-deadline')), this.options.startupTimeoutMs ?? 25_000); })]);
    } catch (error) { await this.close(); throw error; }
    finally { if (timer) clearTimeout(timer); }
  }
  private async evaluatePageScript(expression: string): Promise<unknown> {
    const response = await this.pipe.request('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, this.sessionId) as {
      exceptionDetails?: unknown; result?: { value?: unknown; subtype?: string };
    };
    if (response.exceptionDetails || response.result?.subtype === 'error') throw new Error('browser-evaluation-failed');
    return response.result?.value;
  }
  /** `deadlineMs` (test-group operations only) bounds the account RPC and the asset loop;
   * without it the probe is byte-for-byte what sends have always run. */
  private probeExpression(deadlineMs?: number): string {
    const stop = deadlineMs === undefined ? 'Date.now()+20000' : `Math.min(Date.now()+20000,${Math.floor(deadlineMs) - 3000})`;
    const budget = deadlineMs === undefined ? '' : `if(Date.now()>${Math.floor(deadlineMs) - 3000})throw new Error('browser-probe-budget');`;
    return `(async()=>{if(location.origin!=='https://web.telegram.org'||!location.pathname.startsWith('/k/')||typeof window.createProxiedManagersForAccount!=='function')return null;
      const m=window.createProxiedManagersForAccount(${this.options.accountNumber});
      const accountNumber=await m.apiManager.getAccountNumber();const self=await m.apiManager.invokeApi('users.getUsers',{id:[{_:'inputUserSelf'}]},{rawError:true,noErrorBox:true,stopTime:${stop}});const accountId=Array.isArray(self)&&self[0]&&self[0]._==='user'?String(self[0].id):'';
      const assets=${assetsExpression};if(assets.length<3||assets.length>32)throw new Error('browser-asset-census-bound');
      const assetDigests={};let total=0;
      for(const asset of assets){${budget}
        const response=await fetch('https://web.telegram.org/k/'+asset,{cache:'force-cache',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(5000)});
        if(!response.ok||!response.body)throw new Error('browser-asset-unavailable');
        const reader=response.body.getReader();const chunks=[];let length=0;
        try{for(;;){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;total+=part.value.byteLength;
          if(length>8388608||total>33554432)throw new Error('browser-asset-byte-bound');chunks.push(part.value);}}
        finally{await reader.cancel();}
        const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
        assetDigests[asset]=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(n=>n.toString(16).padStart(2,'0')).join('');
      }
      return {accountNumber,accountId,assets,assetDigests}})()`;
  }
  /** Trusted enrollment inspection only; no send method, cookies or chat text. */
  async inspectEnrollment(deadlineMs?: number): Promise<{ accountNumber: number; accountId: string; criticalAssets: string[]; assetDigests: Record<string, string> }> {
    await this.ready;
    const probe = await this.evaluatePageScript(this.probeExpression(deadlineMs)) as {
      accountNumber: number; accountId: string; assets: string[]; assetDigests: Record<string, string> } | null;
    if (!probe) throw new Error('browser-enrollment-unavailable');
    return { accountNumber: probe.accountNumber, accountId: probe.accountId, criticalAssets: probe.assets, assetDigests: probe.assetDigests };
  }
  async canary(deadlineMs?: number): Promise<BrowserCanary> {
    const probe = await this.inspectEnrollment(deadlineMs);
    const assets = probe.criticalAssets;
    const fingerprint = webKBuildFingerprint(assets);
    const build = this.options.supportedBuilds.find(b => validWebKBuildEnrollment(b) && webKBuildFingerprint(b.criticalAssets) === fingerprint &&
      b.criticalAssets.every(asset => b.assetDigests[asset] === probe.assetDigests[asset]));
    return { transport: 'web-k', buildId: build?.buildId ?? `unrecognized:${fingerprint}`, accountId: probe?.accountId ?? '',
      supported: !!build && probe?.accountId === this.options.expectedAccountId && probe.accountNumber === this.options.accountNumber };
  }
  async readSnapshot(): Promise<{ text: string; accountId: string }> {
    const canary = await this.canary();
    if (canary.accountId !== this.options.expectedAccountId) throw new Error('browser-account-mismatch');
    const text = await this.evaluatePageScript(`document.body.innerText.slice(0,32768)`);
    return { text: typeof text === 'string' ? text : '', accountId: canary.accountId };
  }
  async resolvePeer(destination: BrowserDestination): Promise<{ [key: string]: BrowserJson }> {
    const canary = await this.canary();
    if (!canary.supported) throw new Error('browser-peer-canary-unavailable');
    if (!['user', 'chat', 'channel'].includes(destination.kind) || !/^[1-9][0-9]*$/.test(destination.id)) throw new Error('browser-peer-invalid');
    const output = { _: `peer${destination.kind[0].toUpperCase()}${destination.kind.slice(1)}`,
      [`${destination.kind}_id`]: destination.id };
    // The account manager performs both conversions, including Web K's peer-id
    // convention. The API caller never supplies an account access hash.
    const peer = await this.evaluatePageScript(`(async()=>{const m=window.createProxiedManagersForAccount(${this.options.accountNumber});
      const id=await m.appPeersManager.getPeerId(${canonicalBrowserJson(output)});
      return m.appPeersManager.getInputPeerById(id)})()`);
    if (!browserPeerMatches(peer, destination)) throw new Error('browser-peer-mismatch');
    return peer as { [key: string]: BrowserJson };
  }
  async invoke(child: Readonly<PreparedBrowserChild>): Promise<unknown> {
    await this.ready;
    // The second canary runs in the SAME evaluation as the write, after account RPC resolves.
    const approvedAssets = this.options.supportedBuilds.filter(validWebKBuildEnrollment).map(b => ({ assets: [...b.criticalAssets].sort(), assetDigests: b.assetDigests }));
    const payload = canonicalBrowserJson({ method: child.method, args: child.args });
    const result = await this.evaluatePageScript(`(async()=>{
      const probe=await (${this.probeExpression()});
      const approved=${JSON.stringify(approvedAssets)};
      if(!probe||probe.accountId!==${JSON.stringify(child.accountId)}||probe.accountNumber!==${this.options.accountNumber}
        ||!approved.some(a=>JSON.stringify(a.assets)===JSON.stringify(probe.assets)&&a.assets.every(name=>a.assetDigests[name]===probe.assetDigests[name]))||Date.now()>=${child.deadlineMs})return {held:true};
      const p=${payload};const m=window.createProxiedManagersForAccount(${this.options.accountNumber});
      try{return {result:await m.apiManager.invokeApi(p.method,p.args,{rawError:true,noErrorBox:true,stopTime:${child.deadlineMs}})}}
      catch(e){return {rpcError:{code:Number(e&&e.code),type:String(e&&e.type||'')}}}
    })()`) as { held?: boolean; rpcError?: { code: number; type?: string }; result?: unknown };
    if (result?.held) throw new TelegramRpcRefusal(403);
    // Web K 2.3 (686) turns a server result the client cannot parse into a
    // synthetic 400. The server may have executed the write, so this is an
    // unknown outcome, never a refusal that would make a resend look safe.
    if (result?.rpcError?.type === WEB_K_UNREADABLE_RESULT) throw new Error('telegram-result-unreadable');
    if (result?.rpcError) throw new TelegramRpcRefusal(result.rpcError.code);
    return result?.result;
  }
  /** One evaluation: the same-evaluation build/account probe (the `invoke` pattern), then
   * `body` with `api(method, params)` bound to this account and the evaluation's stop time.
   * Only static code and canonical JSON data are interpolated. */
  private testGroupScript(deadline: number, body: string): string {
    const approvedAssets = this.options.supportedBuilds.filter(validWebKBuildEnrollment).map(b => ({ assets: [...b.criticalAssets].sort(), assetDigests: b.assetDigests }));
    const stop = Math.floor(deadline) - 3000;
    return `(async()=>{
      let probe;try{probe=await (${this.probeExpression(deadline)});}catch(e){return {ok:false,step:'budget'};}
      const approved=${canonicalBrowserJson(approvedAssets)};
      if(!probe||probe.accountId!==${canonicalBrowserJson(this.options.expectedAccountId)}||probe.accountNumber!==${this.options.accountNumber}
        ||!approved.some(a=>JSON.stringify(a.assets)===JSON.stringify(probe.assets)&&a.assets.every(name=>a.assetDigests[name]===probe.assetDigests[name])))return {ok:false,step:'canary'};
      const m=window.createProxiedManagersForAccount(${this.options.accountNumber});
      const api=(method,params)=>{if(Date.now()>${stop})throw {code:0,type:'STEP_BUDGET'};return m.apiManager.invokeApi(method,params,{rawError:true,noErrorBox:true,stopTime:${stop}});};
      const fail=(step,e,extra)=>{const out={ok:false,step};const code=Number(e&&e.code);if(Number.isSafeInteger(code))out.code=code;
        const type=e&&typeof e.type==='string'&&/^[A-Z_0-9]{1,48}$/.test(e.type)?e.type:typeof e==='string'&&/^[A-Z_0-9]{1,48}$/.test(e)?e:undefined;if(type)out.type=type;
        if(!type&&!Number.isSafeInteger(code)){const n=e&&e.constructor&&e.constructor.name;if(typeof n==='string'&&/^[A-Za-z]{1,40}$/.test(n))out.kind=n;
          const msg=e&&typeof e.message==='string'?e.message:'';if(/^[A-Za-z0-9 _.:()'-]{1,120}$/.test(msg))out.message=msg;}
        return Object.assign(out,extra||{});};
      const isCandidate=c=>!!c&&c._==='channel'&&!!c.pFlags&&!!c.pFlags.creator&&!!c.pFlags.megagroup&&!!c.pFlags.forum
        &&typeof c.title==='string'&&${TEST_GROUP_TITLE_PATTERN}.test(c.title);
      ${body}
    })()`;
  }
  private testGroupOperation = '';
  async listTestGroups(input: { deadline: number; channelId?: string }): Promise<unknown> {
    await this.ready;
    const operation = this.testGroupOperation = randomUUID();
    const requested = input.channelId === undefined ? 'null' : canonicalBrowserJson(input.channelId);
    return this.evaluatePageScript(this.testGroupScript(input.deadline, `
      let r;try{r=await api('messages.getAllChats',{except_ids:[]});}catch(e){return fail('list',e);}
      const chats=r&&Array.isArray(r.chats)?r.chats:[];
      const candidates=chats.filter(isCandidate);
      window.__instarTestGroups={operation:${canonicalBrowserJson(operation)},chats:Object.fromEntries(candidates.map(c=>[String(c.id),c]))};
      const req=${requested};
      const out={ok:true,complete:!!r&&r._==='messages.chats'&&candidates.length<=${TEST_GROUP_LIST_BOUND},
        groups:candidates.slice(0,${TEST_GROUP_LIST_BOUND}).map(c=>({channelId:String(c.id),title:c.title,date:Number(c.date)}))};
      if(req!==null)out.requested={present:chats.some(c=>String(c&&c.id)===req)};
      return out;`));
  }
  async createTestGroup(input: { title: string; bot: { username: string; userId: string }; deadline: number }): Promise<unknown> {
    await this.ready;
    const data = canonicalBrowserJson({ title: input.title, username: input.bot.username, userId: input.bot.userId });
    return this.evaluatePageScript(this.testGroupScript(input.deadline, `
      const d=${data};
      let resolved;try{resolved=await api('contacts.resolveUsername',{username:d.username});}catch(e){return fail('bot-identity',e);}
      const user=(resolved&&Array.isArray(resolved.users)?resolved.users:[]).find(u=>u&&u._==='user'&&String(u.id)===d.userId);
      if(!user||!user.pFlags||!user.pFlags.bot||user.pFlags.deleted)return {ok:false,step:'bot-identity'};
      const inputUser={_:'inputUser',user_id:user.id,access_hash:user.access_hash};
      if(Date.now()>${Math.floor(input.deadline) - 15000})return {ok:false,step:'budget'};
      let created;
      try{created=await api('channels.createChannel',{megagroup:true,forum:true,title:d.title,about:''});}
      catch(e){const code=Number(e&&e.code);return fail('create',e,{uncertain:!(e&&e.type==='STEP_BUDGET')&&!([400,403,406,420].includes(code)&&!(typeof (e&&e.type)==='string'&&e.type.startsWith('NETWORK_')))});}
      const made=(created&&Array.isArray(created.chats)?created.chats:[]).filter(c=>isCandidate(c)&&c.title===d.title);
      if(made.length!==1)return {ok:false,step:'create-shape',uncertain:true};
      const ch=made[0];const channel={_:'inputChannel',channel_id:ch.id,access_hash:ch.access_hash};
      const rollback=async step=>{let rolledBack=false;try{await m.apiManager.invokeApi('channels.deleteChannel',{channel},{rawError:true,noErrorBox:true,stopTime:${Math.floor(input.deadline) - 1000}});rolledBack=true;}catch(e){rolledBack=false;}
        return {ok:false,step,channelId:String(ch.id),rolledBack};};
      try{const inv=await api('channels.inviteToChannel',{channel,users:[inputUser]});
        if(inv&&Array.isArray(inv.missing_invitees)&&inv.missing_invitees.length)return rollback('invite');}catch(e){return rollback('invite');}
      try{await api('channels.editAdmin',{channel,user_id:inputUser,admin_rights:${TEST_GROUP_ADMIN_RIGHTS},rank:''});}catch(e){return rollback('promote');}
      try{const p=await api('channels.getParticipants',{channel,filter:{_:'channelParticipantsRecent'},offset:0,limit:10,hash:'0'});
        const list=p&&p._==='channels.channelParticipants'&&Array.isArray(p.participants)?p.participants:null;
        if(!list||p.count!==2||list.length!==2)return rollback('verify');
        const owner=list.find(x=>x._==='channelParticipantCreator'&&String(x.user_id)===probe.accountId);
        const admin=list.find(x=>x._==='channelParticipantAdmin'&&String(x.user_id)===d.userId);
        const rights=admin&&admin.admin_rights&&admin.admin_rights.pFlags?Object.keys(admin.admin_rights.pFlags).filter(k=>admin.admin_rights.pFlags[k]):[];
        const allowed=${JSON.stringify(TEST_GROUP_ALLOWED_RIGHTS)};const required=${JSON.stringify(TEST_GROUP_REQUIRED_RIGHTS)};
        if(!owner||!admin||!required.every(k=>rights.includes(k))||!rights.every(k=>allowed.includes(k)))return rollback('verify');
      }catch(e){return rollback('verify');}
      return {ok:true,channelId:String(ch.id)};`));
  }
  async deleteTestGroup(input: { channelId: string; title: string; deadline: number }): Promise<unknown> {
    await this.ready;
    const operation = this.testGroupOperation;
    this.testGroupOperation = '';
    const data = canonicalBrowserJson({ channelId: input.channelId, title: input.title, operation });
    return this.evaluatePageScript(this.testGroupScript(input.deadline, `
      const d=${data};const kept=window.__instarTestGroups;window.__instarTestGroups=undefined;
      const ch=d.operation&&kept&&kept.operation===d.operation&&kept.chats?kept.chats[d.channelId]:undefined;
      if(!ch||!ch.access_hash)return {ok:false,step:'stale-read'};
      const channel={_:'inputChannel',channel_id:ch.id,access_hash:ch.access_hash};
      let fresh;
      try{const r=await api('channels.getChannels',{id:[channel]});fresh=r&&Array.isArray(r.chats)?r.chats.find(c=>c&&String(c.id)===d.channelId):undefined;}
      catch(e){if(e&&e.type==='CHANNEL_INVALID')return {ok:true,outcome:'gone'};return fail('read',e);}
      if(fresh&&fresh._==='channelForbidden')return {ok:true,outcome:'gone'};
      if(!isCandidate(fresh)||fresh.title!==d.title)return {ok:false,step:'identity-mismatch'};
      try{await api('channels.deleteChannel',{channel});}
      catch(e){const code=Number(e&&e.code);return fail('delete',e,{uncertain:!(e&&e.type==='STEP_BUDGET')&&!([400,403,406,420].includes(code)&&!(typeof (e&&e.type)==='string'&&e.type.startsWith('NETWORK_')))});}
      return {ok:true,outcome:'deleted'};`));
  }
  close(): Promise<void> { return this.pipe.close(); }
}
