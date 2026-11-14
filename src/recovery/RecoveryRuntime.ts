/** Main-server observer. The independently supervised listeners never depend on this loop. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { RecoveryClient, RecoveryProofStore, serverDownRecoveryHealth, type RecoveryPeerTarget, type RecoveryProbeEvidence, type RecoveryRouteProof } from './RecoveryClient.js';
import { loadRecoveryConfig } from './RecoveryEngine.js';
import { installRecoveryServices } from './RecoveryInstallation.js';
import { validRecoveryId, recoveryKeyFingerprint, type RecoveryRoute } from './RecoveryProtocol.js';

export interface RecoveryRuntimeManifest {
  version: 1; agentId: string; machineId: string; hostConfigFile: string; peers: RecoveryPeerTarget[];
}
export interface RecoveryRuntimeOptions {
  stateDir: string; agentId: string; machineId: string; enabled: boolean;
  /** Current MachineAuth ledger, re-read before every probe and every readiness read. */
  paired: () => Array<{ machineId: string; pairingEpoch: number }>;
  entrypoint: string;
  probe?: (target: RecoveryPeerTarget, route: RecoveryRoute) => Promise<RecoveryProbeEvidence>;
  install?: typeof installRecoveryServices;
  onSetupRequired?:(reason:string)=>Promise<void>;
  onPending?:(target:RecoveryPeerTarget)=>Promise<void>;
  onRouteSuccess?:(target:RecoveryPeerTarget,route:RecoveryRoute,evidence:RecoveryProbeEvidence)=>Promise<void>;
  onRouteFailure?:(target:RecoveryPeerTarget,route:RecoveryRoute,security:boolean)=>Promise<void>;
  repairStatus?:(target:RecoveryPeerTarget)=>unknown;
  onStatus?: (target:RecoveryPeerTarget,route:RecoveryRoute,healthy:boolean,evidence:RecoveryProbeEvidence)=>Promise<void>;
  now?: () => number;
  random?: () => number;
}
export interface RecoveryRuntimeStatus {
  scope: 'source-machine'; sourceMachineId: string; enabled: boolean; ready: boolean; reason: string;
  commonDependencies: string[];
  credentialGeneration?:number|null;listenerKeys?:{ssh:string;relay:string}|null;
  targets: Array<{ machineId: string; ready: boolean; reason: string; repair?:unknown; routes: Record<RecoveryRoute, { state: string; observedAt: number | null; expiresAt: number | null; sourceMachineId: string;pairingEpoch?:number|null;credentialGeneration?:number|null;bootId?:string|null;targetKeyFingerprint?:string|null }> }>;
}
function protectedRead(file: string): unknown {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077) || st.size > 1_048_576) throw new Error('recovery-runtime-config-invalid');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export class RecoveryRuntime {
  private readonly proofs: RecoveryProofStore;
  private readonly failures = new Map<string, {at:number;reason:string}>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private fastReprobe=false;
  private readonly observedThisProcess=new Set<string>();
  private stopped = true;
  private reason = 'recovery-setup-required';
  constructor(private readonly options: RecoveryRuntimeOptions) {
    this.proofs = new RecoveryProofStore(path.join(options.stateDir, 'recovery', 'proofs'));
  }
  private manifest(): RecoveryRuntimeManifest | null {
    try {
      const m = protectedRead(path.join(this.options.stateDir, 'recovery', 'runtime.json')) as RecoveryRuntimeManifest;
      if (m.version !== 1 || m.agentId !== this.options.agentId || m.machineId !== this.options.machineId
        || !path.isAbsolute(m.hostConfigFile) || !Array.isArray(m.peers) || m.peers.length > 128) throw new Error('recovery-runtime-config-invalid');
      const ids = new Set<string>();
      for (const p of m.peers) {
        if (p.agentId !== m.agentId || p.sourceMachineId !== m.machineId || p.targetMachineId === m.machineId || !validRecoveryId(p.targetMachineId)
          || ids.has(p.targetMachineId) || !Number.isSafeInteger(p.pairingEpoch) || p.pairingEpoch < 1 || !Number.isSafeInteger(p.generation) || p.generation < 1) throw new Error('recovery-runtime-config-invalid');
        ids.add(p.targetMachineId);
      }
      return m;
    } catch (error) {
      this.reason = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'recovery-setup-required' : 'recovery-runtime-config-invalid';
      return null;
    }
  }
  private peers(m: RecoveryRuntimeManifest): RecoveryPeerTarget[] {
    const paired = this.options.paired();
    return m.peers.filter(p => paired.some(x => x.machineId === p.targetMachineId && x.pairingEpoch === p.pairingEpoch));
  }
  async start(): Promise<void> {
    this.stopped = false;
    if (!this.options.enabled) { this.reason = 'recovery-disabled';void this.tick();return; }
    const m = this.manifest();
    if (m) {
      try {
        const host = loadRecoveryConfig(m.hostConfigFile);
        if (host.agentId !== m.agentId || host.machineId !== m.machineId) throw new Error('recovery-runtime-config-invalid');
        await (this.options.install ?? installRecoveryServices)(host, m.hostConfigFile, this.options.entrypoint);
        this.reason = 'awaiting-peer-proofs';
      } catch { this.reason = 'recovery-installation-blocked'; }
    }
    void this.tick();
  }
  async enable():Promise<void> { this.options.enabled=true;this.stop();await this.start(); }
  /** Stop only this observer. Main-server shutdown must never unload recovery services. */
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = null; }
  async probeNow(): Promise<void> {
    if (!this.options.enabled || this.running) return;
    this.running = true;
    try {
      const m = this.manifest(); if (!m) {await this.options.onSetupRequired?.(this.reason);return;}
      const peers = this.peers(m);
      // Two bounded workers leave the rest of the pool free. Each client call has
      // a transport deadline; no overlap with the next cadence or manual refresh.
      let cursor = 0;
      const worker = async () => {
        while (cursor < peers.length && !this.stopped) {
          const p = peers[cursor++];
          try{await this.options.onPending?.(p);}catch{this.reason='recovery-notice-delivery-pending';}
          for (const route of ['ssh', 'relay'] as const) {
            if (this.stopped || !this.peers(m).some(x => x.targetMachineId === p.targetMachineId)) break;
            try {
              const evidence = await (this.options.probe ? this.options.probe(p, route) : new RecoveryClient(p).probe(route, (this.options.now ?? Date.now)()));
              // Recheck revocation after the network await before durable storage.
              if (!this.peers(m).some(x => x.targetMachineId === p.targetMachineId)) break;
              this.proofs.save(p, evidence);
              this.observedThisProcess.add(`${p.targetMachineId}:${route}`);
              this.failures.delete(`${p.targetMachineId}:${route}`);
              try {await this.options.onRouteSuccess?.(p,route,evidence);} catch {this.reason='recovery-pool-resolution-pending';}
              try { await this.options.onStatus?.(p,route,evidence.response.payload.detail.serverHealthy===true,evidence); }
              catch { this.reason='recovery-repair-incomplete'; }
            } catch(error) {
              this.observedThisProcess.delete(`${p.targetMachineId}:${route}`);
              try{this.proofs.invalidate(p,route);}catch{this.reason='recovery-proof-invalidation-unavailable';}
              try { await this.options.onRouteFailure?.(p,route,error instanceof Error&&['recovery-receipt-invalid','recovery-discovery-invalid','recovery-proof-invalid','recovery-main-binding-unverified'].includes(error.message)); } catch { this.reason='recovery-route-attention-pending'; }
              if(!this.failures.has(`${p.targetMachineId}:${route}`))this.fastReprobe=true;
              this.failures.set(`${p.targetMachineId}:${route}`, {at:(this.options.now ?? Date.now)(),reason:error instanceof Error&&/^recovery-[a-z-]+$/.test(error.message)?error.message:'recovery-route-unavailable'});
              // A signer checkpoint can be carried through direct SSH when the
              // target's relay link is partitioned; carrying cannot mint a grant.
              if(route==='ssh'&&!this.options.probe) {
                try { await new RecoveryClient(p).renewCheckpointViaSsh(); } catch { /* unavailable checkpoint stays degraded */ }
              }
            }
          }
        }
      };
      await Promise.all([worker(), worker()]);
    } finally { this.running = false; }
  }
  private async tick(): Promise<void> {
    try {
      if(!this.options.enabled)await this.options.onSetupRequired?.('recovery-not-enrolled');
      await this.probeNow();
    } catch { this.reason='recovery-observer-unavailable';console.warn('[recovery] observer check incomplete; recovery readiness remains degraded'); }
    if (!this.stopped) {
      // Reprove before five-minute proof expiry, with per-source jitter.
      const delay=this.fastReprobe?30_000:240_000 + Math.floor((this.options.random ?? Math.random)() * 30_000);
      this.fastReprobe=false;
      this.timer = setTimeout(() => { void this.tick(); },delay);
      this.timer.unref?.();
    }
  }
  status(): RecoveryRuntimeStatus {
    const now = (this.options.now ?? Date.now)(), m = this.manifest();
    const targets: RecoveryRuntimeStatus['targets'] = this.options.paired().map(pair => {
      const p = m && this.peers(m).find(x => x.targetMachineId === pair.machineId);
      const proofs: RecoveryRouteProof[] = p ? (['ssh', 'relay'] as const).flatMap(route => this.observedThisProcess.has(`${p.targetMachineId}:${route}`)?this.proofs.read(p,route,now)??[]:[]) : [];
      // A reboot discovered through either route invalidates the other route's
      // old-boot proof. Never use a configured/cached target boot for readiness.
      const newest = [...proofs].sort((a, b) => b.observedAt - a.observedAt)[0];
      const health = newest ? serverDownRecoveryHealth(proofs, pair.machineId, { bootId: newest.bootId, pairingEpoch: pair.pairingEpoch, credentialGeneration: p!.generation }, now) : null;
      const routes = Object.fromEntries((['ssh', 'relay'] as const).map(route => {
        const proof = proofs.find(x => x.route === route && x.bootId === newest?.bootId);
        const failure = this.failures.get(`${pair.machineId}:${route}`);
        const failed = failure !== undefined && (!proof || failure.at >= proof.observedAt);
        return [route, { state: failed ? failure?.reason==='recovery-route-disabled'?'revoked':'broken' : proof ? 'proven' : 'unknown', observedAt: proof?.observedAt ?? null, expiresAt: proof?.expiresAt ?? null, sourceMachineId: this.options.machineId,pairingEpoch:proof?.pairingEpoch??null,credentialGeneration:proof?.credentialGeneration??null,bootId:proof?.bootId??null,targetKeyFingerprint:proof?.keyFingerprint??null }];
      })) as RecoveryRuntimeStatus['targets'][number]['routes'];
      const repair=p?this.options.repairStatus?.(p):undefined,repairState=(repair as {state?:string}|undefined)?.state;
      const exhausted=repairState==='exhausted',cooling=repairState==='cooling-down';
      const ready = !!this.options.enabled && !exhausted && !cooling && !!health?.ready && routes.ssh.state === 'proven' && routes.relay.state === 'proven';
      return { machineId: pair.machineId, ready, ...(p?{repair}:{}), reason: exhausted?'owner-retry-required':cooling?'recovery-cooling-down':ready?health!.reason:health?.reason&&health.reason!=='missing-fresh-peer-proof'?health.reason:!p?'recovery-peer-enrollment-required':'missing-fresh-peer-proof', routes };
    });
    const ready = this.options.enabled && targets.length > 0 && targets.every(x => x.ready);
    let listenerKeys:RecoveryRuntimeStatus['listenerKeys']=null;
    try{if(m){const host=loadRecoveryConfig(m.hostConfigFile,{restorationOnly:true});listenerKeys={ssh:recoveryKeyFingerprint(crypto.createPublicKey(host.sshPrivateKey).export({type:'spki',format:'pem'}).toString()),relay:recoveryKeyFingerprint(crypto.createPublicKey(host.relayPrivateKey).export({type:'spki',format:'pem'}).toString())};}}catch{/* Invalid own config supplies no current listener key evidence. */}
    return { scope: 'source-machine', sourceMachineId: this.options.machineId, enabled: this.options.enabled, ready,
      reason: ready ? 'two-fresh-independent-peer-proofs' : targets.length === 0 ? 'no-repair-capable-peer' : !this.options.enabled ? 'recovery-disabled' : !m ? this.reason : 'recovery-degraded',
      credentialGeneration:m?.peers[0]?.generation??null,listenerKeys,commonDependencies: ['target operating system', 'target host network', '24-hour authority lease'], targets };
  }
}

export function currentRecoveryStatus(): RecoveryRuntimeStatus | { scope: 'source-machine'; ready: false; reason: string; targets: [] } {
  return (globalThis as { __instarRecoveryRuntime?: RecoveryRuntime }).__instarRecoveryRuntime?.status()
    ?? { scope: 'source-machine', ready: false, reason: 'recovery-not-initialized', targets: [] };
}
