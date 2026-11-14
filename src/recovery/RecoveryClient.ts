import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
/** Source-side transport and evidence. Only target-signed responses create proofs. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ssh2 from 'ssh2';
import net from 'node:net';
import {channel} from 'node:diagnostics_channel';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { recoveryResponseJson } from './RecoveryHttp.js';
import {
  recoveryDigest, recoveryKeyFingerprint, signRecovery, verifyRecovery, REQUEST_TTL_MS, PROOF_TTL_MS,
  type RecoveryCertificate, type RecoveryCheckpoint, type RecoveryControlRequest, type RecoveryDiscovery, type RecoveryHello, type RecoveryEnvelope, type RecoveryReceipt,
  validateRecoveryEnvelope, type RecoveryRoute, type RecoveryVerb, type Signed,
} from './RecoveryProtocol.js';
const exec=promisify(execFile);

export interface RecoveryTransportObservation {
  domain:'instar-recovery-transport-observation-v1'; requestDigest:string; route:RecoveryRoute;
  interface:string; nextHopDigest:string; endpointDigest:string; configurationDigest:string; observedAt:number;
}
export function recoveryTransportConfigDigest(target:RecoveryPeerTarget,route:RecoveryRoute):string {
  return recoveryDigest(route==='ssh'?{route,host:target.ssh.host,port:target.ssh.port,username:target.ssh.username,hostFingerprint:target.ssh.hostFingerprint}
    :{route,relayUrl:target.relayUrl});
}

/** Bind a fetch to its actual connection, including an already pooled socket.
 * A fresh private correlation header prevents unrelated concurrent fetches from
 * supplying the evidence. Missing diagnostics can never become a route proof. */
export async function recoveryFetchWithDestination(url:URL,init:RequestInit):Promise<{response:Response;destination:string|null}> {
  const trace=crypto.randomBytes(24).toString('hex'),header='x-instar-recovery-observation';
  const destinations=new Set<string>(),events=channel('undici:client:sendHeaders');
  const listener=(value:unknown)=>{
    const event=value as {headers?:string;socket?:{remoteAddress?:string;encrypted?:boolean;authorized?:boolean}};
    if(typeof event.headers!=='string'||!event.headers.toLowerCase().includes(`${header}: ${trace}\r\n`))return;
    const socket=event.socket;if(url.protocol==='https:'&&(!socket?.encrypted||socket.authorized!==true))return;
    if(socket?.remoteAddress&&net.isIP(socket.remoteAddress))destinations.add(socket.remoteAddress);
  };
  events.subscribe(listener);
  try{const headers=new Headers(init.headers);headers.set(header,trace);const response=await fetch(url,{...init,headers});
    const proxyEnabled=process.env.NODE_USE_ENV_PROXY==='1'&&['HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','https_proxy','http_proxy','all_proxy'].some(name=>!!process.env[name]);
    return{response,destination:!proxyEnabled&&destinations.size===1?[...destinations][0]:null};
  }finally{events.unsubscribe(listener);}
}
/** Kernel route lookup of the authenticated connection's numeric destination;
 * never a second DNS resolution that might describe a different connection. */
export async function observeRecoveryTransport(target:RecoveryPeerTarget,route:RecoveryRoute,destination?:string|null):Promise<Omit<RecoveryTransportObservation,'domain'|'requestDigest'|'observedAt'>> {
  if(!destination||!net.isIP(destination))throw new Error('recovery-transport-observation-unavailable');
  const address=destination.startsWith('::ffff:')&&net.isIP(destination.slice(7))===4?destination.slice(7):destination;
  if(route==='relay'&&(address==='::1'||address.startsWith('127.')))throw new Error('recovery-transport-observation-unavailable');
  let networkInterface:string,nextHop:string;
  if(process.platform==='darwin') {
    const output=(await exec('/sbin/route',['-n','get',address],{timeout:3_000,maxBuffer:8_192})).stdout;
    networkInterface=/^\s*interface:\s*(\S+)\s*$/m.exec(output)?.[1]??'';
    nextHop=/^\s*gateway:\s*(\S+)\s*$/m.exec(output)?.[1]??address;
  } else if(process.platform==='linux') {
    const output=JSON.parse((await exec('ip',['-json','route','get',address],{timeout:3_000,maxBuffer:8_192})).stdout);
    networkInterface=output[0]?.dev??'';nextHop=output[0]?.gateway??address;
  } else throw new Error('recovery-transport-observation-unavailable');
  if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(networkInterface)||typeof nextHop!=='string'||nextHop.length>256)throw new Error('recovery-transport-observation-unavailable');
  // Different ports on the same destination do not prove independent routing.
  return {route,interface:networkInterface,nextHopDigest:recoveryDigest(nextHop),endpointDigest:recoveryDigest(address),configurationDigest:recoveryTransportConfigDigest(target,route)};
}

export interface RecoveryPeerTarget {
  agentId: string; sourceMachineId: string; targetMachineId: string; bootId: string;
  pairingEpoch: number; generation: number;
  sshSigningPrivateKey: string; relaySigningPrivateKey: string;
  targetSshPublicKey: string; targetRelayPublicKey: string;
  relayUrl: string;
  ssh: { host: string; port: number; username: string; privateKey: string; hostFingerprint: string };
}
export interface RecoveryRouteProof {
  sourceMachineId: string; targetMachineId: string; bootId: string; route: RecoveryRoute;
  observedAt: number; expiresAt: number; credentialGeneration: number; pairingEpoch: number;
  repairAvailable:boolean;repairEpoch:number;repairBlockedReason?:string;
  processDomain: string; transportDomain: string; supervisorDomain: string; keyFingerprint: string;
}
export interface RecoveryProbeEvidence {
  request: Signed<RecoveryEnvelope>;
  response: Signed<RecoveryReceipt>;
  transport:Signed<RecoveryTransportObservation>;
}
type Request = RecoveryEnvelope | RecoveryDiscovery;
type ResponsePayload = RecoveryReceipt | RecoveryHello;

export class RecoveryClient {
  constructor(private readonly target: RecoveryPeerTarget) {}
  private signingKey(route: RecoveryRoute): string {
    return route === 'ssh' ? this.target.sshSigningPrivateKey : this.target.relaySigningPrivateKey;
  }
  private targetKey(route: RecoveryRoute): string {
    return route === 'ssh' ? this.target.targetSshPublicKey : this.target.targetRelayPublicKey;
  }
  /** Each transport discovers the current host boot independently, with a fresh nonce. */
  async discover(route: RecoveryRoute): Promise<RecoveryHello> {
    const t=this.target, now=Date.now();
    const request=signRecovery<RecoveryDiscovery>({domain:'instar-recovery-discovery-v1',agentId:t.agentId,
      sourceMachineId:t.sourceMachineId,targetMachineId:t.targetMachineId,pairingEpoch:t.pairingEpoch,generation:t.generation,
      route,nonce:crypto.randomBytes(32).toString('hex'),issuedAt:now,expiresAt:now+REQUEST_TTL_MS},this.signingKey(route));
    const response=await this.exchange(request,route);
    const hello=response.payload as RecoveryHello;
    if (!verifyRecovery(response,this.targetKey(route)) || hello.domain!=='instar-recovery-hello-v1'
      || hello.agentId!==t.agentId || hello.machineId!==t.targetMachineId || hello.nonce!==request.payload.nonce
      || hello.route!==route || typeof hello.bootId!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(hello.bootId)
      || !Number.isSafeInteger(hello.fencingEpoch)||hello.fencingEpoch<0||hello.fencingEpoch>=Number.MAX_SAFE_INTEGER
      || Math.abs(Date.now()-hello.observedAt)>REQUEST_TTL_MS || !hello.checkpoint?.ready) throw new Error('recovery-discovery-invalid');
    return hello;
  }
  private async operation(verb:RecoveryVerb,route:RecoveryRoute,fencingEpoch:number):Promise<{request:Signed<RecoveryEnvelope>;response:Signed<RecoveryReceipt>;destination:string|null}> {
    const hello=await this.discover(route),t=this.target,now=Date.now();
    const request=signRecovery<RecoveryEnvelope>({domain:'instar-recovery-operation-v1',agentId:t.agentId,
      sourceMachineId:t.sourceMachineId,targetMachineId:t.targetMachineId,targetBootId:hello.bootId,
      pairingEpoch:t.pairingEpoch,generation:t.generation,route,operationId:crypto.randomUUID(),nonce:crypto.randomBytes(32).toString('hex'),
      issuedAt:now,expiresAt:now+REQUEST_TTL_MS,fencingEpoch:Math.max(fencingEpoch,hello.fencingEpoch+1),verb},this.signingKey(route));
    let destination:string|null=null;
    const response=await this.exchange(request,route,address=>{destination=address;}) as Signed<RecoveryReceipt>;
    this.validateReceipt(request,response,route);
    return {request,response,destination};
  }
  async execute(verb: RecoveryVerb,route: RecoveryRoute,fencingEpoch: number): Promise<RecoveryReceipt> {
    return (await this.operation(verb,route,fencingEpoch)).response.payload;
  }
  async probe(route:RecoveryRoute,fencingEpoch:number):Promise<RecoveryProbeEvidence> {
    const {request,response,destination}=await this.operation('status',route,fencingEpoch);
    const observation=await observeRecoveryTransport(this.target,route,destination);
    const evidence:RecoveryProbeEvidence={request,response,transport:signRecovery({domain:'instar-recovery-transport-observation-v1',requestDigest:recoveryDigest(request.payload),
      observedAt:Date.now(),...observation},this.signingKey(route))};
    this.proof(evidence);
    return evidence;
  }
  /** Relay outage on the target is repaired by carrying its own signed request
   * over SSH. The carrier never learns or uses the target's private relay key. */
  async renewCheckpointViaSsh():Promise<{checkpointVersion:number}> {
    const t=this.target,now=Date.now();
    const discovery=signRecovery<RecoveryDiscovery>({domain:'instar-recovery-discovery-v1',agentId:t.agentId,sourceMachineId:t.sourceMachineId,
      targetMachineId:t.targetMachineId,pairingEpoch:t.pairingEpoch,generation:t.generation,route:'ssh',nonce:crypto.randomBytes(32).toString('hex'),
      issuedAt:now,expiresAt:now+REQUEST_TTL_MS},t.sshSigningPrivateKey);
    const request=await this.sshWire<Signed<RecoveryControlRequest>>(discovery,'instar-recovery-checkpoint-challenge-v1');
    this.verifyCarriedControl(request,'checkpoint');
    const checkpoint=await this.forwardCarriedControl(request) as {certificate:Signed<RecoveryCertificate>;checkpoint:Signed<RecoveryCheckpoint>};
    const acknowledgement=await this.sshWire<Signed<RecoveryControlRequest>>(checkpoint,'instar-recovery-checkpoint-deliver-v1');
    this.verifyCarriedControl(acknowledgement,'checkpoint-ack');
    await this.forwardCarriedControl(acknowledgement);
    const checkpointVersion=Number(acknowledgement.payload.body.checkpointVersion);
    if(!Number.isSafeInteger(checkpointVersion)||checkpointVersion<1)throw new Error('recovery-checkpoint-ack-invalid');
    return {checkpointVersion};
  }
  private verifyCarriedControl(request:Signed<RecoveryControlRequest>,action:'checkpoint'|'checkpoint-ack'):void {
    const p=request?.payload;
    if(!verifyRecovery(request,this.target.targetRelayPublicKey)||p.domain!=='instar-recovery-control-request-v1'||p.agentId!==this.target.agentId
      ||p.machineId!==this.target.targetMachineId||p.action!==action||!Number.isSafeInteger(p.issuedAt)||!Number.isSafeInteger(p.expiresAt)
      ||p.issuedAt>Date.now()+30_000||p.expiresAt<=Date.now()||p.expiresAt-p.issuedAt>REQUEST_TTL_MS)throw new Error('recovery-carried-request-invalid');
  }
  private async forwardCarriedControl(request:Signed<RecoveryControlRequest>):Promise<unknown> {
    const response=await fetch(new URL(`/v1/recovery/${request.payload.action}`,this.target.relayUrl),{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(request),signal:AbortSignal.timeout(5_000),redirect:'error'});
    if(!response.ok){await response.body?.cancel();throw new Error('recovery-checkpoint-carry-failed');}
    return recoveryResponseJson(response);
  }
  /** Revalidate persisted and peer-carried evidence before deriving any readiness field. */
  proof(evidence:RecoveryProbeEvidence,now=Date.now()):RecoveryRouteProof {
    const {request,response,transport}=evidence, e=request.payload, r=response.payload;
    const route=e.route;
    const publicKey=crypto.createPublicKey(this.signingKey(route)).export({format:'pem',type:'spki'}).toString();
    if (!validateRecoveryEnvelope(e,e.issuedAt) || !verifyRecovery(request,publicKey) || e.verb!=='status' || e.agentId!==this.target.agentId
      || e.sourceMachineId!==this.target.sourceMachineId || e.targetMachineId!==this.target.targetMachineId
      || e.pairingEpoch!==this.target.pairingEpoch || e.generation!==this.target.generation) throw new Error('recovery-proof-invalid');
    this.validateReceipt(request,response,route,false);
    const observation=transport?.payload;
    if(!observation||!verifyRecovery(transport,publicKey)||observation.domain!=='instar-recovery-transport-observation-v1'
      ||observation.requestDigest!==recoveryDigest(e)||observation.route!==route||!Number.isSafeInteger(observation.observedAt)
      ||observation.configurationDigest!==recoveryTransportConfigDigest(this.target,route)
      ||observation.observedAt>now||Math.abs(observation.observedAt-r.observedAt)>REQUEST_TTL_MS
      ||!/^[A-Za-z0-9_.:-]{1,128}$/.test(observation.interface)||!/^([a-f0-9]{64})$/.test(observation.nextHopDigest)
      ||!/^[a-f0-9]{64}$/.test(observation.endpointDigest))throw new Error('recovery-transport-observation-invalid');
    if(r.detail.repairSuppressed===true&&typeof r.detail.repairSuppressionReason==='string'&&r.detail.repairSuppressionReason.startsWith('main-'))throw new Error('recovery-main-binding-unverified');
    if (r.result!=='ok' || r.detail.independentRuntime!==true || typeof r.detail.serverHealthy!=='boolean' || r.detail.hostBootId!==e.targetBootId
      || !Number.isSafeInteger(r.detail.listenerPid)||Number(r.detail.listenerPid)<1||!Number.isSafeInteger(r.detail.listenerParentPid)||Number(r.detail.listenerParentPid)<1
      || typeof r.detail.listenerSupervisor!=='string'||(route==='ssh'?r.detail.listenerSupervisor!=='host-sshd':!/^com\.instar\.recovery-sidecar\.[a-f0-9]{32}$/.test(r.detail.listenerSupervisor))
      || typeof r.detail.leaseExpiresAt!=='number' || r.detail.leaseExpiresAt-r.observedAt<=REQUEST_TTL_MS
      || r.observedAt<e.issuedAt-REQUEST_TTL_MS || r.observedAt>e.expiresAt+REQUEST_TTL_MS
      || now-observation.observedAt>=PROOF_TTL_MS) throw new Error('recovery-proof-invalid');
    // Source and target wall clocks need not be ordered. Freshness belongs to
    // the source's signed observation; translate the target's remaining lease
    // into that clock and reserve one request horizon for transport uncertainty.
    const leaseDeadline=observation.observedAt+r.detail.leaseExpiresAt-r.observedAt-REQUEST_TTL_MS;
    if(leaseDeadline<=now)throw new Error('recovery-proof-invalid');
    return {sourceMachineId:e.sourceMachineId,targetMachineId:e.targetMachineId,bootId:e.targetBootId,route,
      observedAt:observation.observedAt,expiresAt:Math.min(observation.observedAt+PROOF_TTL_MS,leaseDeadline),credentialGeneration:e.generation,pairingEpoch:e.pairingEpoch,
      repairAvailable:r.detail.repairBudgetAvailable===true,repairEpoch:Number(r.detail.repairEpoch??0),repairBlockedReason:r.detail.repairBudgetAvailable===true?undefined:r.detail.repairBudgetExhausted===true?'owner-retry-required':r.detail.repairBudgetAvailable===false?'recovery-cooling-down':'missing-signed-repair-budget',
      processDomain:`${e.targetBootId}:${r.detail.listenerPid}`,transportDomain:`${observation.interface}:${observation.nextHopDigest}:${observation.endpointDigest}`,
      supervisorDomain:route==='ssh'?`host-parent:${r.detail.listenerParentPid}`:r.detail.listenerSupervisor,keyFingerprint:recoveryKeyFingerprint(this.targetKey(route))};
  }
  private validateReceipt(request: Signed<RecoveryEnvelope>,signed: Signed<RecoveryReceipt>,route: RecoveryRoute,fresh=true): RecoveryReceipt {
    const r = signed?.payload, e = request.payload;
    if (!r || !verifyRecovery(signed,this.targetKey(route)) || r.domain !== 'instar-recovery-receipt-v1'
      || r.agentId !== e.agentId || r.sourceMachineId !== e.sourceMachineId || r.targetMachineId !== e.targetMachineId
      || r.targetBootId !== e.targetBootId || r.operationId !== e.operationId || r.route !== route || r.requestDigest !== recoveryDigest(e)
      || !Number.isSafeInteger(r.observedAt) || (fresh && Math.abs(Date.now()-r.observedAt)>REQUEST_TTL_MS)) throw new Error('recovery-receipt-invalid');
    return r;
  }
  private exchange(request:Signed<Request>,route:RecoveryRoute,capture?:(destination:string|null)=>void):Promise<Signed<ResponsePayload>> {
    return route==='ssh'?this.ssh(request,capture):this.relay(request,capture);
  }
  private ssh(request: Signed<Request>,capture?:(destination:string|null)=>void): Promise<Signed<ResponsePayload>> {
    const command=request.payload.domain==='instar-recovery-discovery-v1'?'instar-recovery-hello-v1':'instar-recovery-v1';
    return this.sshWire(request,command,capture);
  }
  private sshWire<T>(request:unknown,command:string,capture?:(destination:string|null)=>void):Promise<T> {
    const t = this.target.ssh;
    return new Promise((resolve,reject)=> {
      const client = new ssh2.Client(),socket=net.connect({host:t.host,port:t.port});
      let settled = false;
      const finish = (error: Error | null, result?: T) => {
        if (settled) return; settled = true; clearTimeout(timer); client.end();socket.destroy();
        if (error) reject(error); else resolve(result!);
      };
      const timer = setTimeout(()=>finish(new Error('recovery-ssh-timeout')),20_000);
      client.once('error',error=>finish(error));
      client.once('ready',()=>client.exec(command,(error,stream)=> {
        if (error) { finish(error); return; }
        let output='', refusal='';
        stream.stderr.on('data',(chunk:Buffer)=>{if(refusal.length<1_024)refusal+=chunk.toString().slice(0,1_024-refusal.length);});
        stream.on('data',(chunk: Buffer)=> { output += chunk.toString(); if (output.length>32_768) { stream.close(); finish(new Error('recovery-response-too-large')); } });
        stream.once('close',(code: number)=> {
          if (code !== 0) { finish(new Error(/^recovery-[a-z-]+$/.test(refusal.trim())?refusal.trim():'recovery-ssh-refused')); return; }
          try {const result=JSON.parse(output);capture?.(socket.remoteAddress??null);finish(null,result); } catch { finish(new Error('recovery-response-invalid')); }
        });
        stream.end(JSON.stringify(request));
      }));
      client.connect({sock:socket,host:t.host,port:t.port,username:t.username,privateKey:t.privateKey,readyTimeout:8_000,hostHash:'sha256',hostVerifier:(hash: string)=>hash === t.hostFingerprint});
    });
  }
  async claimRepairEpisode(route:RecoveryRoute,sourceLeaseEpoch:number,failureClass:'main-server-unavailable'|'recovery-route-unavailable'='main-server-unavailable'):Promise<{leaseId:string;expiresAt:number;notified:boolean;episodeId:string}> {
    return this.control('episode-claim',{targetMachineId:this.target.targetMachineId,pairingEpoch:this.target.pairingEpoch,failureClass,sourceLeaseEpoch,route});
  }
  async resolveRepairEpisode(leaseId:string,sourceLeaseEpoch:number,evidence:RecoveryProbeEvidence):Promise<unknown> {
    return this.control('episode-resolve',{targetMachineId:this.target.targetMachineId,leaseId,sourceLeaseEpoch,evidence});
  }
  async claimRepairNotice(leaseId:string,sourceLeaseEpoch:number):Promise<{claimed:boolean;idempotencyKey?:string;episodeId?:string;noticeSenderMachineId?:string}> {
    return this.control('episode-notice',{targetMachineId:this.target.targetMachineId,leaseId,sourceLeaseEpoch});
  }
  async pendingRepairNotices():Promise<{pending:Array<{idempotencyKey:string;leaseId:string;sourceLeaseEpoch:number;noticeSenderMachineId:string}>}> {
    return this.control('episode-notice-pending',{targetMachineId:this.target.targetMachineId});
  }
  async acknowledgeRepairNotice(leaseId:string,sourceLeaseEpoch:number,idempotencyKey:string,outboxOperationId:string):Promise<unknown> {
    return this.control('episode-notice-ack',{targetMachineId:this.target.targetMachineId,leaseId,sourceLeaseEpoch,idempotencyKey,outboxOperationId});
  }
  private async control(action: string,body: Record<string,unknown>,capture?:(destination:string|null)=>void): Promise<any> {
    const t = this.target,now = Date.now();
    const request = signRecovery({domain:'instar-recovery-control-request-v1',agentId:t.agentId,machineId:t.sourceMachineId,action,nonce:crypto.randomBytes(32).toString('hex'),issuedAt:now,expiresAt:now+REQUEST_TTL_MS,body},t.relaySigningPrivateKey);
    const url=new URL(`/v1/recovery/${action}`,t.relayUrl),init:RequestInit={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(5_000),redirect:'error'};
    const result=capture?await recoveryFetchWithDestination(url,init):{response:await fetch(url,init),destination:null};
    const response=result.response;capture?.(result.destination);
    if (!response.ok) {
      const refusal=await recoveryResponseJson(response);
      throw new Error(typeof refusal?.error==='string'&&/^recovery-[a-z-]+$/.test(refusal.error)?refusal.error:'recovery-relay-request-failed');
    } return recoveryResponseJson(response);
  }
  private async relay(request: Signed<Request>,capture?:(destination:string|null)=>void): Promise<Signed<ResponsePayload>> {
    const id='operationId' in request.payload?request.payload.operationId:crypto.randomUUID();
    await this.control('send',{id,to:this.target.targetMachineId,payload:JSON.stringify(request)});
    const deadline = Date.now()+20_000;
    while(Date.now()<deadline) {
      let destination:string|null=null;
      const result = await this.control('poll',{},capture?address=>{destination=address;}:undefined);
      for(const frame of result.frames) {
        let signed: Signed<ResponsePayload>;
        try { signed=JSON.parse(frame.payload); } catch { continue; }
        if (frame.from !== this.target.targetMachineId || !verifyRecovery(signed,this.targetKey('relay'))) continue;
        const payload=signed.payload;
        const matches='operationId' in request.payload
          ? 'operationId' in payload && payload.operationId===request.payload.operationId
          : 'nonce' in payload && payload.nonce===request.payload.nonce;
        if (!matches) continue;
        await this.control('ack',{id:frame.id});capture?.(destination);return signed;
      }
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    throw new Error('recovery-relay-timeout');
  }
}

/** Source-local durable evidence; projections are always reconstructed and verified on read. */
export class RecoveryProofStore {
  constructor(private readonly directory:string) {
    fs.mkdirSync(directory,{recursive:true,mode:0o700});
    const st=fs.lstatSync(directory);
    if (!st.isDirectory() || st.isSymbolicLink() || (st.mode&0o077) || st.uid!==process.getuid?.()) throw new Error('recovery-proof-store-invalid');
  }
  private file(target:RecoveryPeerTarget,route:RecoveryRoute):string {
    return path.join(this.directory,recoveryDigest({agent:target.agentId,source:target.sourceMachineId,target:target.targetMachineId,route})+'.json');
  }
  save(target:RecoveryPeerTarget,evidence:RecoveryProbeEvidence):void {
    new RecoveryClient(target).proof(evidence);
    const file=this.file(target,evidence.request.payload.route),tmp=file+'.'+crypto.randomUUID()+'.tmp';
    fs.writeFileSync(tmp,JSON.stringify(evidence),{mode:0o600});fs.renameSync(tmp,file);
  }
  invalidate(target:RecoveryPeerTarget,route:RecoveryRoute):void {
    try {SafeFsExecutor.safeUnlinkSync(this.file(target,route),{operation:'recovery-proof:invalidate-failed-route'});}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  read(target:RecoveryPeerTarget,route:RecoveryRoute,now=Date.now()):RecoveryRouteProof|null {
    try {
      const file=this.file(target,route),st=fs.lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink() || st.size>32_768 || (st.mode&0o077) || st.uid!==process.getuid?.()) return null;
      return new RecoveryClient(target).proof(JSON.parse(fs.readFileSync(file,'utf8')),now);
    } catch { return null; } // @silent-fallback-ok — missing or invalid evidence means unknown, never ready
  }
}

export function serverDownRecoveryHealth(proofs: RecoveryRouteProof[],targetMachineId: string,currentTarget:{bootId:string;pairingEpoch:number;credentialGeneration:number},now=Date.now()): {ready:boolean; routes:{ssh:string;relay:string}; reason:string} {
  const current = proofs.filter(p=>p.targetMachineId === targetMachineId && p.sourceMachineId !== targetMachineId && p.bootId === currentTarget.bootId && p.pairingEpoch === currentTarget.pairingEpoch && p.credentialGeneration === currentTarget.credentialGeneration && p.observedAt<=now && p.expiresAt>now && p.expiresAt-p.observedAt<=PROOF_TTL_MS);
  const a = current.find(p=>p.route === 'ssh'),b = current.find(p=>p.route === 'relay');
  const network=(proof:RecoveryRouteProof|undefined):{name:string;tunnel:boolean}|null=>{
    const name=proof&&/^([^:]+):[a-f0-9]{64}:[a-f0-9]{64}$/.exec(proof.transportDomain)?.[1];
    if(!name)return null;
    const tunnel=/^(?:utun|tun|tap|wg|tailscale|ipsec|ppp)[0-9]+$/.test(name);
    // Unknown adapter kinds cannot establish independence. Common physical OS
    // adapter names share the explicitly declared host-network dependency;
    // two destinations reached through one tunnel additionally share its daemon.
    if(!tunnel&&!/^(?:en[0-9]+|eth[0-9]+|en[a-z0-9]+|wl[a-z0-9]+|wwan[0-9]+|pdp_ip[0-9]+)$/.test(name))return null;
    return{name,tunnel};
  };
  const an=network(a),bn=network(b),separateNetwork=an&&bn&&!(an.name===bn.name&&(an.tunnel||bn.tunnel));
  const independent = a && b && separateNetwork && a.sourceMachineId === b.sourceMachineId && a.bootId === b.bootId && a.processDomain !== b.processDomain && a.supervisorDomain !== b.supervisorDomain && a.transportDomain !== b.transportDomain && a.keyFingerprint !== b.keyFingerprint;
  return {ready:!!independent&&a?.repairAvailable!==false&&b?.repairAvailable!==false,routes:{ssh:a?'proven':'unknown',relay:b?'proven':'unknown'},reason:independent&&(a?.repairAvailable===false||b?.repairAvailable===false)?([a,b].find(p=>p?.repairAvailable===false)?.repairBlockedReason??'missing-signed-repair-budget'):independent?'two-fresh-independent-peer-proofs':!a||!b?'missing-fresh-peer-proof':'shared-recovery-dependency'};
}
