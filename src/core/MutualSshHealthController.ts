import type { DirectionalSshProof, MutualSshVerifier, SshProbeTarget } from './MutualSshVerifier.js';

export type MutualSshFailureClass = 'connect-refused' | 'timeout' | 'host-key-changed' | 'admission-refused' | 'identity-mismatch' | 'firewall-denied' | 'vpn-route-unavailable' | 'system-sleep' | 'port-collision' | 'unknown';

export interface MutualSshPairHealth {
  sourceMachineId: string;
  targetMachineId: string;
  mutual: boolean;
  state: 'verified' | 'repairing' | 'blocked';
  proof?: DirectionalSshProof;
  lastFailureClass?: MutualSshFailureClass;
  attempts: number;
  breakerOpenUntil?: string;
}

export interface MutualSshRepairHooks {
  refreshAdvert(target: SshProbeTarget): Promise<void>;
  reconcileAdmission(target: SshProbeTarget): Promise<void>;
  rotateSourceKey(target: SshProbeTarget): Promise<void>;
  notifySecurity(target: SshProbeTarget, failure: MutualSshFailureClass): Promise<void>;
  notifyExhausted(target: SshProbeTarget, failure: MutualSshFailureClass): Promise<void>;
}

interface PairState { proof?: DirectionalSshProof; failures: number[]; attempts: number; failure?: MutualSshFailureClass; breakerUntil?: number }

/** Bounded detector/remediator. It emits proof signals and never chooses routing. */
/* @self-action-controller: mutual-ssh-repair-sweep */
export class MutualSshHealthController {
  private readonly state = new Map<string, PairState>();
  private running = 0;
  constructor(private readonly verifier: MutualSshVerifier, private readonly hooks: MutualSshRepairHooks, private readonly concurrency = 4) {
    if (concurrency < 1 || concurrency > 32) throw new Error('mutual-ssh-concurrency-out-of-range');
  }

  static validateCapacity(machineCount: number, concurrency = 4, deadlineMs = 8_000, freshnessMs = 300_000): void {
    const sweepMs = machineCount * (machineCount - 1) * deadlineMs / concurrency;
    if (sweepMs >= freshnessMs) throw new Error(`mutual-ssh-capacity-invalid machines=${machineCount} sweepMs=${sweepMs} freshnessMs=${freshnessMs}`);
  }

  async check(target: SshProbeTarget, now = Date.now()): Promise<DirectionalSshProof | null> {
    const key = pairKey(target);
    const current = this.state.get(key) ?? { failures: [], attempts: 0 };
    current.failures = current.failures.filter(at => now - at < 15 * 60_000);
    if ((current.breakerUntil ?? 0) > now || this.running >= this.concurrency) return null;
    const started = Date.now();
    this.running += 1;
    try {
      for (let attempt = 1; attempt <= 4 && Date.now() - started < 120_000; attempt += 1) {
        current.attempts = attempt;
        try {
          if (attempt === 2) await this.hooks.refreshAdvert(target);
          if (attempt === 3) await this.hooks.reconcileAdmission(target);
          if (attempt === 4) await this.hooks.rotateSourceKey(target);
          const proof = await this.verifier.probe(target);
          current.proof = proof; current.failure = undefined; current.attempts = 0;
          this.state.set(key, current);
          return proof;
        } catch (error) {
          // @silent-fallback-ok — a failed bounded probe is the controller's
          // expected input: it is classified, retained in health state, and
          // ultimately surfaced through notifyExhausted/notifySecurity.
          current.failure = classifyMutualSshFailure(error);
          if (current.failure === 'host-key-changed') { await this.hooks.notifySecurity(target, current.failure); break; }
          if (attempt < 4) await delay(Math.min(8_000, 250 * (2 ** (attempt - 1))));
        }
      }
      current.failures.push(now);
      if (current.failures.length >= 3) current.breakerUntil = now + 15 * 60_000;
      await this.hooks.notifyExhausted(target, current.failure ?? 'unknown');
      this.state.set(key, current);
      return null;
    } finally { this.running -= 1; }
  }

  health(targets: SshProbeTarget[], now = Date.now()): MutualSshPairHealth[] {
    return targets.map(target => {
      const state = this.state.get(pairKey(target)) ?? { failures: [], attempts: 0 };
      const reverse = this.state.get(`${target.targetMachineId}->${target.sourceMachineId}@${target.pairingEpoch}`);
      const mutual = Boolean(state.proof && reverse?.proof && Date.parse(state.proof.expiresAt) > now && Date.parse(reverse.proof.expiresAt) > now);
      return {
        sourceMachineId: target.sourceMachineId, targetMachineId: target.targetMachineId, mutual,
        state: mutual ? 'verified' : state.attempts > 0 ? 'repairing' : 'blocked', proof: state.proof,
        lastFailureClass: state.failure, attempts: state.attempts,
        breakerOpenUntil: state.breakerUntil ? new Date(state.breakerUntil).toISOString() : undefined,
      };
    });
  }
}

function pairKey(target: Pick<SshProbeTarget, 'sourceMachineId' | 'targetMachineId' | 'pairingEpoch'>): string {
  return `${target.sourceMachineId}->${target.targetMachineId}@${target.pairingEpoch}`;
}
export function classifyMutualSshFailure(error: unknown): MutualSshFailureClass {
  // Structural transport/error-code classification only. This never infers
  // human intent, gates input, or reroutes a message.
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (hasAny(message, ['host', 'fingerprint', 'pinned'])) return 'host-key-changed';
  if (hasAny(message, ['eaddrinuse', 'address already in use'])) return 'port-collision';
  if (hasAny(message, ['eacces', 'eperm', 'firewall', 'administratively prohibited'])) return 'firewall-denied';
  if (hasAny(message, ['enetunreach', 'ehostunreach', 'no route', 'vpn-route-unavailable'])) return 'vpn-route-unavailable';
  if (hasAny(message, ['system-sleep', 'sleep-wake', 'suspended'])) return 'system-sleep';
  if (message.includes('timeout')) return 'timeout';
  if (hasAny(message, ['auth', 'admission'])) return 'admission-refused';
  if (message.includes('identity')) return 'identity-mismatch';
  if (hasAny(message, ['econnrefused', 'connect'])) return 'connect-refused';
  return 'unknown';
}
function hasAny(value: string, needles: readonly string[]): boolean { return needles.some(needle => value.includes(needle)); }
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
