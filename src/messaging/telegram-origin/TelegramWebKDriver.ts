import { createHash } from 'node:crypto';
import { browserPeerMatches, canonicalBrowserJson, type BrowserDestination, type BrowserJson, type BrowserCanary, type PreparedBrowserChild, type TelegramBrowserDriver } from './BrowserTypes.js';
import { BrowserProtocolError, PrivateCdpPipe } from './PrivateCdpPipe.js';
import { TelegramRpcRefusal } from './TelegramBrowserBroker.js';

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
/** The only script surface is static code written here plus JSON data, never caller JS. */
const assetsExpression = `Array.from(new Set([...Array.from(document.scripts).map(s=>s.src), ...performance.getEntriesByType('resource').map(e=>e.name)]))
 .filter(u=>u.startsWith('https://web.telegram.org/k/')).map(u=>u.split('/').pop().split('?')[0])
 .filter(n=>/^(index-|app-|apiManagerProxy-|index\\.worker-).*\\.js$/.test(n)).sort()`;
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
  private probeExpression(): string {
    return `(async()=>{if(location.origin!=='https://web.telegram.org'||!location.pathname.startsWith('/k/')||typeof window.createProxiedManagersForAccount!=='function')return null;
      const m=window.createProxiedManagersForAccount(${this.options.accountNumber});
      const accountNumber=await m.apiManager.getAccountNumber();const self=await m.apiManager.invokeApi('users.getUsers',{id:[{_:'inputUserSelf'}]},{rawError:true,noErrorBox:true,stopTime:Date.now()+20000});const accountId=Array.isArray(self)&&self[0]&&self[0]._==='user'?String(self[0].id):'';
      const assets=${assetsExpression};if(assets.length<3||assets.length>32)throw new Error('browser-asset-census-bound');
      const assetDigests={};let total=0;
      for(const asset of assets){
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
  async inspectEnrollment(): Promise<{ accountNumber: number; accountId: string; criticalAssets: string[]; assetDigests: Record<string, string> }> {
    await this.ready;
    const probe = await this.evaluatePageScript(this.probeExpression()) as {
      accountNumber: number; accountId: string; assets: string[]; assetDigests: Record<string, string> } | null;
    if (!probe) throw new Error('browser-enrollment-unavailable');
    return { accountNumber: probe.accountNumber, accountId: probe.accountId, criticalAssets: probe.assets, assetDigests: probe.assetDigests };
  }
  async canary(): Promise<BrowserCanary> {
    const probe = await this.inspectEnrollment();
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
      catch(e){return {rpcError:{code:Number(e&&e.code)}}}
    })()`) as { held?: boolean; rpcError?: { code: number }; result?: unknown };
    if (result?.held) throw new TelegramRpcRefusal(403);
    if (result?.rpcError) throw new TelegramRpcRefusal(result.rpcError.code);
    return result?.result;
  }
  close(): Promise<void> { return this.pipe.close(); }
}
