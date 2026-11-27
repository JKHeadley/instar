/** Recovery checkpoint authority and bounded opaque machine mailbox; no execution authority. */
import crypto from 'node:crypto';
import { recoveryPhonePage } from './RecoveryPhonePage.js';
import type http from 'node:http';
import { ReplayGuard, verifyDeviceRequest, parseDevicePublicKey } from '../core/MobileDeviceKeys.js';
import {
  OFFLINE_LEASE_MS, recoveryCanonical, recoveryDigest, signRecovery, validRecoveryId, validRecoveryTime, verifyRecovery, validateRecoveryPrincipals, recoveryKeyFingerprint,
  type RecoveryCertificate, type RecoveryCheckpoint, type RecoveryPrincipal, type RecoveryRoute, type RecoveryControlRequest, type RecoveryEnvelope, type RecoveryReceipt, validateRecoveryEnvelope, type Signed,
} from './RecoveryProtocol.js';

export interface RecoveryTarget {
  agentId: string; machineId: string; publicKey: string;
  principals: RecoveryPrincipal[]; revoked: string[]; disabledRoutes?:RecoveryRoute[]; repairEpoch?:number; version: number;
  acknowledgement: number; ownerSequence: number;
}
export interface RecoveryAuthorityConfig {
  certificate: Signed<RecoveryCertificate>; privateKey: string;
  /** Provisioned from the verified owner-device registry; never learned from a request. */
  owner?: { deviceId: string; publicKey: string; host: string; active: boolean };
  /** Host-issued, single-use phone commissioning capability; never an agent-held credential. */
  enrollment?: { tokenHash: string; issuedAt: number; expiresAt: number; host: string };
  /** Independently pinned release certification root, mandatory in production loader. */
  certificationRoot?: string;
}
export interface RecoveryControlStore {
  recoveryRead(key: string): unknown;
  recoveryWrite(key: string, value: unknown): void;
  recoveryTransaction<T>(fn: () => T): T;
}
interface Mail { id: string; from: string; to: string; expiresAt: number; payload: string; acknowledged: boolean }
interface MailAck { id:string;from:string;to:string;payloadDigest:string;expiresAt:number }

export class RecoveryControlPlane {
  private readonly deviceReplay = new ReplayGuard();
  constructor(private readonly store: RecoveryControlStore, private readonly authorities: ReadonlyMap<string, RecoveryAuthorityConfig>, private readonly now: () => number = Date.now) {
    const keys = new Set<string>();
    for (const [id, authority] of authorities) {
      const cert = authority.certificate.payload;
      if (cert.agentId !== id || keys.has(recoveryKeyFingerprint(cert.publicKey)) || !verifyRecovery(signRecovery({test:true},authority.privateKey),cert.publicKey)) throw new Error('recovery-signer-provisioning-invalid');
      if (authority.certificationRoot && (cert.domain !== 'instar-recovery-certificate-v1' || !verifyRecovery(authority.certificate,authority.certificationRoot))) throw new Error('recovery-certificate-invalid');
      if (!authority.owner && !authority.enrollment) throw new Error('recovery-owner-setup-required');
      const enrollment=authority.enrollment;
      if(enrollment && (!/^[a-f0-9]{64}$/.test(enrollment.tokenHash) || !Number.isSafeInteger(enrollment.issuedAt) || !Number.isSafeInteger(enrollment.expiresAt) || enrollment.expiresAt-enrollment.issuedAt>15*60_000 || enrollment.expiresAt<=enrollment.issuedAt || !/^[a-z0-9.-]+(?::[0-9]+)?$/.test(enrollment.host))) throw new Error('recovery-owner-enrollment-invalid');
      this.store.recoveryTransaction(()=>{
        const key=`authority-generation:${id}`,fingerprint=recoveryKeyFingerprint(cert.publicKey);
        const prior=this.store.recoveryRead(key) as {generation:number;fingerprint:string}|null;
        if(prior&&(prior.generation>cert.generation||(prior.generation===cert.generation&&prior.fingerprint!==fingerprint)))throw new Error('recovery-authority-generation-rollback');
        this.store.recoveryWrite(key,{generation:cert.generation,fingerprint});
      });
      keys.add(recoveryKeyFingerprint(cert.publicKey));
    }
  }
  private owner(agentId:string): RecoveryAuthorityConfig['owner'] {
    // A durable revoked row shadows static boot config, including after restart.
    return this.store.recoveryRead(`owner:${agentId}`) as RecoveryAuthorityConfig['owner'] ?? this.authorities.get(agentId)?.owner;
  }
  private target(agent: string, machine: string): RecoveryTarget | null {
    return this.store.recoveryRead(`target:${agent}:${machine}`) as RecoveryTarget | null;
  }
  private save(target: RecoveryTarget): void { this.store.recoveryWrite(`target:${target.agentId}:${target.machineId}`,target); }
  /** Returns false for unrelated requests. All recovery responses have a bounded body. */
  async handle(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<boolean> {
    if (!pathname.startsWith('/v1/recovery/')) return false;
    if(pathname==='/v1/recovery/phone' && req.method==='GET') {
      const page=recoveryPhonePage();
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':`default-src 'none'; script-src 'nonce-${page.nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`});res.end(page.html);return true;
    }
    const reply = (status: number, body: unknown) => {
      res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'}); res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST') { reply(405,{error:'method-not-allowed'}); return true; }
    try {
      const raw = await recoveryReadBody(req);
      const body = JSON.parse(raw.toString('utf8'));
      if (pathname === '/v1/recovery/owner-enroll') {
        const authority=this.authorities.get(body.agentId), enrollment=authority?.enrollment, now=this.now();
        if(!enrollment || !validRecoveryId(body.agentId) || typeof body.token!=='string' || body.token.length>256 || now<enrollment.issuedAt || now>=enrollment.expiresAt || !parseDevicePublicKey(body.publicKey)) throw new Error('recovery-owner-enrollment-refused');
        const tokenHash=crypto.createHash('sha256').update(body.token).digest('hex');
        if(!crypto.timingSafeEqual(Buffer.from(tokenHash,'hex'),Buffer.from(enrollment.tokenHash,'hex'))) throw new Error('recovery-owner-enrollment-refused');
        const verified=verifyDeviceRequest({deviceId:req.headers['x-device-id'],time:req.headers['x-device-time'],sig:req.headers['x-device-signature'],method:'POST',pathWithQuery:pathname,rawBody:raw},
          id=>id===body.deviceId?{publicKey:body.publicKey,host:enrollment.host,status:'active'}:null,new Set(['active']),this.deviceReplay,now);
        if(!verified.ok)throw new Error('recovery-owner-signature-required');
        this.store.recoveryTransaction(()=>{
          const existing=this.owner(body.agentId),consumed=this.store.recoveryRead(`owner-enrollment:${body.agentId}`) as {generation?:number;tokenHash?:string}|null;
          const generation=authority!.certificate.payload.generation;
          // Replacing a lost/revoked phone requires a newly release-certified
          // authority generation and a fresh host-issued capability. A restart
          // or regenerated token under the old certificate cannot replace it.
          if((existing||consumed)&&(!consumed||generation<=(consumed.generation??1)||consumed.tokenHash===tokenHash))throw new Error('recovery-owner-already-enrolled');
          this.store.recoveryWrite(`owner:${body.agentId}`,{deviceId:body.deviceId,publicKey:body.publicKey,host:enrollment.host,active:true});
          this.store.recoveryWrite(`owner-enrollment:${body.agentId}`,{consumedAt:now,tokenHash,generation});
        });
        reply(200,{state:'owner-enrolled',scope:'fixed-recovery-verbs-only'});return true;
      }
      if (pathname === '/v1/recovery/owner') {
        const authority = this.authorities.get(body.agentId);
        const owner = this.owner(body.agentId);
        if (!authority || !owner?.active) throw new Error('recovery-owner-unavailable');
        const verified = verifyDeviceRequest({deviceId:req.headers['x-device-id'],time:req.headers['x-device-time'],sig:req.headers['x-device-signature'],method:'POST',pathWithQuery:pathname,rawBody:raw},
          id => id === owner.deviceId ? {publicKey:owner.publicKey,host:owner.host,status:'active'} : null,new Set(['active']),this.deviceReplay,this.now());
        if (!verified.ok) throw new Error('recovery-owner-signature-required');
        const result = this.store.recoveryTransaction(() => this.ownerUpdate(body));
        reply(200,result); return true;
      }
      const signed = body as Signed<RecoveryControlRequest>; const p = signed.payload; const now = this.now();
      const authority = this.authorities.get(p?.agentId);
      const target = p && this.target(p.agentId,p.machineId);
      if (!authority || !target || p.domain !== 'instar-recovery-control-request-v1' || !validRecoveryId(p.machineId)
        || !/^[a-f0-9]{64}$/.test(p.nonce) || !validRecoveryTime(p.issuedAt,p.expiresAt,now,30_000)
        || !verifyRecovery(signed,target.publicKey)) throw new Error('recovery-control-authentication-refused');
      const result = this.store.recoveryTransaction(() => {
        const replayKey = `nonce:${p.agentId}:${p.machineId}`;
        const nonces = (this.store.recoveryRead(replayKey) ?? {}) as Record<string,number>;
        for (const [id,expires] of Object.entries(nonces)) if (expires < now) delete nonces[id];
        if (nonces[p.nonce] || Object.keys(nonces).length >= 200) throw new Error('recovery-control-replay');
        nonces[p.nonce] = p.expiresAt; this.store.recoveryWrite(replayKey,nonces);
        if (p.action === 'checkpoint' && pathname === '/v1/recovery/checkpoint') {
          if (typeof p.body.challenge !== 'string' || !/^[a-f0-9]{64}$/.test(p.body.challenge)) throw new Error('recovery-challenge-invalid');
          const cert = authority.certificate.payload;
          if (now < cert.issuedAt || now >= cert.expiresAt) throw new Error('recovery-certificate-expired');
          target.version++;
          const payload: RecoveryCheckpoint = { domain:'instar-recovery-checkpoint-v1',agentId:p.agentId,targetMachineId:p.machineId,
            challenge:p.body.challenge,version:target.version,issuedAt:now,expiresAt:Math.min(now + OFFLINE_LEASE_MS,cert.expiresAt),principals:target.principals,revoked:target.revoked,disabledRoutes:target.disabledRoutes??[],repairEpoch:target.repairEpoch??0 };
          this.save(target);
          return {certificate:authority.certificate,checkpoint:signRecovery(payload,authority.privateKey)};
        }
        if (p.action === 'checkpoint-ack' && pathname === '/v1/recovery/checkpoint-ack') {
          const version = p.body.checkpointVersion;
          if (!Number.isSafeInteger(version) || Number(version) < 1 || Number(version) > target.version) throw new Error('recovery-checkpoint-ack-invalid');
          target.acknowledgement = Math.max(target.acknowledgement, Number(version));
          this.save(target);
          return {status:'acknowledged',checkpointVersion:target.acknowledgement};
        }
        if ((p.action==='episode-claim'&&pathname==='/v1/recovery/episode-claim') || (p.action==='episode-notice'&&pathname==='/v1/recovery/episode-notice') || (p.action==='episode-notice-ack'&&pathname==='/v1/recovery/episode-notice-ack') || (p.action==='episode-notice-pending'&&pathname==='/v1/recovery/episode-notice-pending') || (p.action==='episode-resolve'&&pathname==='/v1/recovery/episode-resolve')) {
          const targetMachineId=p.body.targetMachineId;
          if(!validRecoveryId(targetMachineId)||targetMachineId===p.machineId||(p.action!=='episode-notice-pending'&&(!Number.isSafeInteger(p.body.sourceLeaseEpoch)||Number(p.body.sourceLeaseEpoch)<1)))throw new Error('recovery-episode-request-invalid');
          const recipient=this.target(p.agentId,targetMachineId);
          const principal=recipient?.principals.find(x=>x.machineId===p.machineId);
          if(!recipient||!principal||recipient.revoked.includes(p.machineId)||principal.relayPublicKey!==target.publicKey)throw new Error('recovery-episode-principal-refused');
          const stateKey=`episodes:${p.agentId}`,noticesKey=`notice-intents:${p.agentId}`;
          type NoticeIntent={targetMachineId:string;episodeId:string;idempotencyKey:string;leaseId:string;sourceLeaseEpoch:number;noticeSenderMachineId:string;accepted:boolean;outboxOperationId?:string;createdAt:number;acceptedAt?:number};
          const notices=(this.store.recoveryRead(noticesKey)??[]) as NoticeIntent[];
          if(p.action==='episode-notice-pending')return {pending:notices.filter(n=>n.targetMachineId===targetMachineId&&n.noticeSenderMachineId===p.machineId&&!n.accepted).slice(0,8).map(n=>({idempotencyKey:n.idempotencyKey,episodeId:n.episodeId,leaseId:n.leaseId,sourceLeaseEpoch:n.sourceLeaseEpoch,noticeSenderMachineId:n.noticeSenderMachineId}))};
          if(p.action==='episode-notice-ack'){
            const intent=notices.find(n=>n.targetMachineId===targetMachineId&&n.idempotencyKey===p.body.idempotencyKey);
            if(!intent||intent.noticeSenderMachineId!==p.machineId||!validRecoveryId(p.body.outboxOperationId))throw new Error('recovery-episode-notice-ack-invalid');
            if(intent.outboxOperationId&&intent.outboxOperationId!==p.body.outboxOperationId)throw new Error('recovery-episode-notice-operation-rebound');
            intent.accepted=true;intent.acceptedAt=now;intent.outboxOperationId=p.body.outboxOperationId;this.store.recoveryWrite(noticesKey,notices);
            // A late ACK for an old outage cannot consume a newer incarnation's
            // notification budget. Only its exact archived logical operation ends.
            const active=(this.store.recoveryRead(stateKey)??[]) as Array<{id:string;noticeId:string;notified:boolean;noticeOperationId?:string}>;
            const episode=active.find(e=>`recovery-notice-${recoveryDigest({episode:e.id,notice:e.noticeId})}`===intent.idempotencyKey);
            if(episode){episode.notified=true;episode.noticeOperationId=intent.outboxOperationId;this.store.recoveryWrite(stateKey,active);}
            return {accepted:true,episodeId:intent.episodeId,idempotencyKey:intent.idempotencyKey,outboxOperationId:intent.outboxOperationId};
          }
          type Episode={id:string;targetMachineId:string;route:string;pairingEpoch:number;pairingScope:string;failureClass:string;holder:string;sourceLeaseEpoch:number;leaseId:string;expiresAt:number;notified:boolean;noticeId:string;noticePending?:boolean;noticeOperationId?:string;noticeSenderMachineId?:string;resolvedAt?:number;updatedAt:number};
          const pairingScope=recoveryDigest({principals:recipient.principals,revoked:recipient.revoked,disabledRoutes:recipient.disabledRoutes??[],repairEpoch:recipient.repairEpoch??0});
          const episodes=((this.store.recoveryRead(stateKey)??[]) as Episode[]).filter(episode=>{
            const enrolled=this.target(p.agentId,episode.targetMachineId);
            return enrolled&&episode.pairingScope===recoveryDigest({principals:enrolled.principals,revoked:enrolled.revoked,disabledRoutes:enrolled.disabledRoutes??[],repairEpoch:enrolled.repairEpoch??0});
          });
          if(p.action==='episode-notice'||p.action==='episode-resolve'){
            const episode=episodes.find(x=>x.leaseId===p.body.leaseId&&x.targetMachineId===targetMachineId);
            if(!episode||episode.pairingScope!==pairingScope||episode.holder!==p.machineId||episode.sourceLeaseEpoch!==p.body.sourceLeaseEpoch||episode.expiresAt<=now)throw new Error('recovery-episode-lease-stale');
            if(p.action==='episode-resolve'){
              const evidence=p.body.evidence as {request:Signed<RecoveryEnvelope>;response:Signed<RecoveryReceipt>},request=evidence?.request,response=evidence?.response,e=request?.payload,r=response?.payload;
              const targetPrincipal=target.principals.find(x=>x.machineId===targetMachineId),targetKey=episode.route==='relay'?recipient.publicKey:targetPrincipal?.sshPublicKey;
              const sourceKey=episode.route==='relay'?principal.relayPublicKey:principal.sshPublicKey;
              if(!e||!r||!targetKey||!validateRecoveryEnvelope(e,now)||e.verb!=='status'||e.agentId!==p.agentId||e.sourceMachineId!==p.machineId||e.targetMachineId!==targetMachineId||e.route!==episode.route||e.pairingEpoch!==principal.pairingEpoch||e.generation!==principal.generation||!verifyRecovery(request,sourceKey)
                ||!verifyRecovery(response,targetKey)||r.domain!=='instar-recovery-receipt-v1'||r.agentId!==p.agentId||r.sourceMachineId!==p.machineId||r.targetMachineId!==targetMachineId||r.targetBootId!==e.targetBootId||r.operationId!==e.operationId||r.requestDigest!==recoveryDigest(e)||r.route!==episode.route||r.result!=='ok'||r.detail?.serverHealthy!==true||!Number.isSafeInteger(r.observedAt)||Math.abs(now-r.observedAt)>30_000)throw new Error('recovery-episode-resolution-invalid');
              // End this outage. The next claim receives a new lease and notice
              // budget; a stale prior receipt cannot resolve a later lease.
              episode.expiresAt=0;episode.leaseId=crypto.randomUUID();episode.resolvedAt=now;episode.updatedAt=now;
              // End the repair incarnation independently. Its immutable notice
              // reservation stays in notice-intents until the original sender
              // confirms durable acceptance, even if another outage starts now.
              episode.notified=false;episode.noticeId=crypto.randomUUID();episode.noticePending=false;delete episode.noticeOperationId;delete episode.noticeSenderMachineId;delete episode.resolvedAt;
              this.store.recoveryWrite(stateKey,episodes);return {resolved:true,episodeId:episode.id};
            }
            const episodeId=recoveryDigest({episode:episode.id,notice:episode.noticeId}),idempotencyKey=`recovery-notice-${episodeId}`;
            let intent=notices.find(n=>n.idempotencyKey===idempotencyKey);
            if(!intent){
              // Accepted history can age out; an uncertain reservation is never
              // discarded or reassigned merely to free a delivery budget.
              const retained=notices.filter(n=>!n.accepted||!n.acceptedAt||now-n.acceptedAt<7*OFFLINE_LEASE_MS);
              if(retained.length>=1024)throw new Error('recovery-notice-intent-store-full');
              intent={targetMachineId,episodeId,idempotencyKey,leaseId:episode.leaseId,sourceLeaseEpoch:Number(p.body.sourceLeaseEpoch),noticeSenderMachineId:p.machineId,accepted:false,createdAt:now};retained.push(intent);
              this.store.recoveryWrite(noticesKey,retained);
            }
            if(intent.accepted)return {claimed:false,status:'accepted',episodeId,idempotencyKey,outboxOperationId:intent.outboxOperationId,noticeSenderMachineId:intent.noticeSenderMachineId};
            if(intent.noticeSenderMachineId!==p.machineId)return {claimed:false,status:'delivery-pending',episodeId,idempotencyKey,noticeSenderMachineId:intent.noticeSenderMachineId};
            episode.noticeSenderMachineId=intent.noticeSenderMachineId;episode.noticePending=true;episode.updatedAt=now;this.store.recoveryWrite(stateKey,episodes);
            return {claimed:true,status:'pending',episodeId,idempotencyKey,outboxOperationId:intent.outboxOperationId??null,noticeSenderMachineId:intent.noticeSenderMachineId};
          }
          const {route,pairingEpoch,failureClass}=p.body;
          if(!['ssh','relay'].includes(String(route))||pairingEpoch!==principal.pairingEpoch||!['main-server-unavailable','recovery-route-unavailable'].includes(String(failureClass)))throw new Error('recovery-episode-request-invalid');
          // Use the target's common signed admission generation for pool
          // ownership. Different source/target pairs can have distinct epochs;
          // those authenticate the request but must not fork one outage notice.
          const id=recoveryDigest({agent:p.agentId,target:targetMachineId,route,pairingScope,failureClass});
          let episode=episodes.find(x=>x.id===id);
          if(episode&&episode.expiresAt>now&&(episode.holder!==p.machineId||episode.sourceLeaseEpoch!==p.body.sourceLeaseEpoch))throw new Error('recovery-episode-owned');
          if(!episode){
            // Bound untrusted per-agent storage without discarding notification
            // tombstones for a still-enrolled episode.
            if(episodes.length>=512)throw new Error('recovery-episode-store-full');
            episode={id,targetMachineId,route:String(route),pairingEpoch:principal.pairingEpoch,pairingScope,failureClass:String(failureClass),holder:p.machineId,sourceLeaseEpoch:Number(p.body.sourceLeaseEpoch),leaseId:crypto.randomUUID(),expiresAt:0,notified:false,noticeId:crypto.randomUUID(),updatedAt:now};episodes.push(episode);
          }else if(episode.expiresAt<=now){episode.holder=p.machineId;episode.sourceLeaseEpoch=Number(p.body.sourceLeaseEpoch);episode.leaseId=crypto.randomUUID();}
          episode.noticeId??=crypto.randomUUID();episode.expiresAt=now+120_000;episode.updatedAt=now;this.store.recoveryWrite(stateKey,episodes);
          return {leaseId:episode.leaseId,expiresAt:episode.expiresAt,notified:episode.notified,noticePending:episode.noticePending??false,noticeSenderMachineId:episode.noticeSenderMachineId??null,pendingNoticeSenders:[...new Set(notices.filter(n=>n.targetMachineId===targetMachineId&&!n.accepted).map(n=>n.noticeSenderMachineId))].slice(0,8),episodeId:recoveryDigest({episode:episode.id,notice:episode.noticeId})};
        }
        const mailKey=`mail:${p.agentId}`,ackKey=`mail-acks:${p.agentId}`;
        const previousMail=(this.store.recoveryRead(mailKey)??[]) as Mail[];
        const acknowledgements=((this.store.recoveryRead(ackKey)??[]) as MailAck[]).filter(a=>a.expiresAt>now);
        // Migrate older ACKed payloads to digest-only receipts. Only pending
        // frames consume the mailbox capacity; compact dedup has a separate cap.
        let migrated=false;
        for(const m of previousMail.filter(m=>m.acknowledged&&m.expiresAt>now)){
          const prior=acknowledgements.find(a=>a.id===m.id),payloadDigest=recoveryDigest(m.payload);
          if(prior&&(prior.from!==m.from||prior.to!==m.to||prior.payloadDigest!==payloadDigest))throw new Error('recovery-frame-rebound');
          if(!prior){if(acknowledgements.length>=4096)throw new Error('recovery-mailbox-dedup-full');acknowledgements.push({id:m.id,from:m.from,to:m.to,payloadDigest,expiresAt:Math.max(m.expiresAt,now+60000)});}migrated=true;
        }
        const mail=previousMail.filter(m=>!m.acknowledged&&m.expiresAt>now);
        if(migrated||mail.length!==previousMail.length){this.store.recoveryWrite(mailKey,mail);this.store.recoveryWrite(ackKey,acknowledgements);}
        if(p.action==='send'&&pathname==='/v1/recovery/send'){
          const {to,id,payload}=p.body;
          if(!validRecoveryId(to)||!validRecoveryId(id)||typeof payload!=='string'||payload.length>24000)throw new Error('recovery-frame-invalid');
          const recipient=this.target(p.agentId,to);
          if(!recipient||recipient.revoked.includes(p.machineId)||!recipient.principals.some(x=>x.machineId===p.machineId&&x.relayPublicKey===target.publicKey))throw new Error('recovery-frame-principal-refused');
          const prior=mail.find(m=>m.id===id),delivered=acknowledgements.find(a=>a.id===id);
          if(prior&&(prior.from!==p.machineId||prior.to!==to||prior.payload!==payload)||delivered&&(delivered.from!==p.machineId||delivered.to!==to||delivered.payloadDigest!==recoveryDigest(payload)))throw new Error('recovery-frame-rebound');
          if(delivered)return {id,status:'delivered'};
          if(!prior){
            // Reserve one compact ACK slot per accepted pending frame. ACKing
            // cannot fail merely because other deliveries filled dedup storage.
            if(acknowledgements.length+mail.length>=4096)throw new Error('recovery-mailbox-dedup-full');
            if(mail.length>=128||mail.filter(m=>m.from===p.machineId).length>=16)throw new Error('recovery-mailbox-full');
            mail.push({id,from:p.machineId,to,expiresAt:p.expiresAt,payload,acknowledged:false});
          }
          this.store.recoveryWrite(mailKey,mail);return {id,status:'queued'};
        }
        if(p.action==='poll'&&pathname==='/v1/recovery/poll')return {frames:mail.filter(m=>m.to===p.machineId).slice(0,8)};
        if(p.action==='ack'&&pathname==='/v1/recovery/ack'){
          const message=mail.find(m=>m.id===p.body.id&&m.to===p.machineId);
          if(!message){if(acknowledgements.some(a=>a.id===p.body.id&&a.to===p.machineId))return {status:'acknowledged'};throw new Error('recovery-frame-not-found');}
          if(acknowledgements.length>=4096)throw new Error('recovery-mailbox-dedup-full');
          acknowledgements.push({id:message.id,from:message.from,to:message.to,payloadDigest:recoveryDigest(message.payload),expiresAt:Math.max(message.expiresAt,now+60000)});
          this.store.recoveryWrite(mailKey,mail.filter(m=>m.id!==message.id));this.store.recoveryWrite(ackKey,acknowledgements);
          // Checkpoint acknowledgement is deliberately a separate signed action
          // issued only after exact current admission/grant reconciliation.
          return {status:'acknowledged'};
        }
        throw new Error('recovery-action-invalid');
      });
      reply(200,result);
    } catch (error) {
      const reason = error instanceof Error && /^recovery-[a-z-]+$/.test(error.message) ? error.message : 'recovery-request-invalid';
      reply(403,{error:reason});
    }
    return true;
  }
  private ownerUpdate(body: Record<string, unknown>): unknown {
    if (body.action === 'revoke-owner' && validRecoveryId(body.agentId)) {
      const owner=this.owner(body.agentId);
      if(!owner?.active)throw new Error('recovery-owner-unavailable');
      this.store.recoveryWrite(`owner:${body.agentId}`,{...owner,active:false});
      return {state:'owner-revoked',detail:'This phone can no longer grant recovery access. Existing machine access remains approved until separately removed.'};
    }
    if (!validRecoveryId(body.agentId) || !validRecoveryId(body.machineId)) throw new Error('recovery-owner-request-invalid');
    const prior = this.target(body.agentId,body.machineId);
    if (body.action === 'inspect') return {target:prior ? {machineId:prior.machineId,version:prior.version,acknowledgement:prior.acknowledgement,principals:prior.principals.map(p=>p.machineId),revoked:prior.revoked,disabledRoutes:prior.disabledRoutes??[],repairEpoch:prior.repairEpoch??0,pendingNoticeCount:((this.store.recoveryRead(`notice-intents:${body.agentId}`)??[]) as Array<{targetMachineId:string;accepted:boolean}>).filter(n=>n.targetMachineId===body.machineId&&!n.accepted).length,ownerSequence:prior.ownerSequence,state:prior.acknowledgement>=prior.version?'acknowledged':'pending-on-target',maximumExposureMs:OFFLINE_LEASE_MS} : null};
    if (!Number.isSafeInteger(body.sequence) || Number(body.sequence) <= (prior?.ownerSequence ?? 0)) throw new Error('recovery-owner-sequence-stale');
    if(body.action==='rearm-repair'){
      if(!prior||!Number.isSafeInteger(prior.repairEpoch??0)||(prior.repairEpoch??0)>=Number.MAX_SAFE_INTEGER||(body.repairEpoch!==undefined&&body.repairEpoch!==(prior.repairEpoch??0)+1))throw new Error('recovery-repair-rearm-invalid');
      // The phone authorizes a new finite cycle, never a peer or an automatic
      // checkpoint renewal. The next signed checkpoint carries the new epoch.
      prior.repairEpoch=(prior.repairEpoch??0)+1;prior.version++;prior.ownerSequence=Number(body.sequence);this.save(prior);
      return {state:'pending-on-target',repairEpoch:prior.repairEpoch,scope:'one-new-bounded-recovery-cycle',maximumExposureMs:OFFLINE_LEASE_MS};
    }
    if(body.action==='revoke-route'||body.action==='regrant-route'){
      if(!prior||!['ssh','relay'].includes(String(body.route)))throw new Error('recovery-route-request-invalid');
      const route=body.route as RecoveryRoute;
      prior.disabledRoutes=body.action==='revoke-route'?[...new Set([...(prior.disabledRoutes??[]),route])]:(prior.disabledRoutes??[]).filter(r=>r!==route);
      prior.version++;prior.ownerSequence=Number(body.sequence);this.save(prior);
      return {state:'pending-on-target',route,disabled:body.action==='revoke-route',maximumExposureMs:OFFLINE_LEASE_MS};
    }
    if (body.action === 'revoke') {
      if (!prior || !validRecoveryId(body.sourceMachineId)) throw new Error('recovery-revoke-invalid');
      prior.revoked = [...new Set([...prior.revoked,body.sourceMachineId])];
      prior.principals = prior.principals.filter(p=>p.machineId !== body.sourceMachineId);
      validateRecoveryPrincipals(prior.principals,prior.revoked);
      prior.version++; prior.ownerSequence = Number(body.sequence);
      this.save(prior); return {state:'pending-on-target',maximumExposureMs:OFFLINE_LEASE_MS};
    }
    if (body.action !== 'grant' || typeof body.publicKey !== 'string' || !Array.isArray(body.principals) || body.principals.length > 128) throw new Error('recovery-grant-invalid');
    if (crypto.createPublicKey(body.publicKey).asymmetricKeyType !== 'ed25519') throw new Error('recovery-grant-invalid');
    const principals = body.principals as RecoveryPrincipal[];
    validateRecoveryPrincipals(principals,prior?.revoked ?? []);
    for (const p of principals) {
      const before = prior?.principals.find(x=>x.machineId === p.machineId);
      if (before && (p.pairingEpoch < before.pairingEpoch || p.generation < before.generation || (p.generation === before.generation && recoveryDigest(p) !== recoveryDigest(before)))) throw new Error('recovery-principal-rollback');
    }
    if (prior && prior.publicKey !== body.publicKey) throw new Error('recovery-target-key-change');
    this.save({agentId:body.agentId,machineId:body.machineId,publicKey:body.publicKey,principals,revoked:prior?.revoked ?? [],disabledRoutes:prior?.disabledRoutes??[],repairEpoch:prior?.repairEpoch??0,version:(prior?.version ?? 0)+1,acknowledgement:prior?.acknowledgement ?? 0,ownerSequence:Number(body.sequence)});
    return {state:'pending-on-target',scope:'fixed-recovery-verbs-only',grantDigest:recoveryDigest(principals)};
  }
}
export async function recoveryReadBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  const timer = setTimeout(()=>req.destroy(new Error('recovery-request-timeout')),5_000);
  try {
    for await (const chunk of req) {
      const b = Buffer.from(chunk); size += b.length;
      if (size > 32_768) throw new Error('recovery-request-too-large');
      chunks.push(b);
    }
    return Buffer.concat(chunks);
  } finally { clearTimeout(timer); }
}
