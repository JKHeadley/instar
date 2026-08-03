import { isIP } from 'node:net';
import type { DirectionalSshProof, MutualSshVerifier, SshProbeTarget } from './MutualSshVerifier.js';
import { scrubForStore } from './durableSecretScrub.js';

export type MutualSshFailureClass = 'connect-refused' | 'timeout' | 'host-key-changed' | 'admission-refused' | 'identity-mismatch' | 'firewall-denied' | 'vpn-route-unavailable' | 'system-sleep' | 'port-collision' | 'unknown';

export interface MutualSshPairHealth {
  sourceMachineId: string;
  targetMachineId: string;
  mutual: boolean;
  state: 'verified' | 'repairing' | 'blocked';
  proof?: DirectionalSshProof;
  lastFailureClass?: MutualSshFailureClass;
  lastFailureDetail?: string;
  attempts: number;
  breakerOpenUntil?: string;
}

export interface CapturedMutualSshFailure {
  failureClass: MutualSshFailureClass;
  /** Bounded, credential- and endpoint-scrubbed evidence from the thrown value. */
  detail: string;
}

export interface MutualSshRepairHooks {
  refreshAdvert(target: SshProbeTarget): Promise<void>;
  reconcileAdmission(target: SshProbeTarget): Promise<void>;
  rotateSourceKey(target: SshProbeTarget): Promise<void>;
  notifySecurity(target: SshProbeTarget, failure: MutualSshFailureClass, detail: string): Promise<void>;
  notifyExhausted(target: SshProbeTarget, failure: MutualSshFailureClass, detail: string): Promise<void>;
}

interface PairState { proof?: DirectionalSshProof; failures: number[]; attempts: number; failure?: CapturedMutualSshFailure; breakerUntil?: number }

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
          current.failure = captureMutualSshFailure(error);
          if (current.failure.failureClass === 'host-key-changed') {
            await this.hooks.notifySecurity(target, current.failure.failureClass, current.failure.detail);
            break;
          }
          if (attempt < 4) await delay(Math.min(8_000, 250 * (2 ** (attempt - 1))));
        }
      }
      current.failures.push(now);
      if (current.failures.length >= 3) current.breakerUntil = now + 15 * 60_000;
      const failure = current.failure ?? captureMutualSshFailure(new Error('mutual-ssh-probe-failed-without-error'));
      await this.hooks.notifyExhausted(target, failure.failureClass, failure.detail);
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
        lastFailureClass: state.failure?.failureClass,
        lastFailureDetail: state.failure?.detail,
        attempts: state.attempts,
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

const MUTUAL_SSH_FAILURE_DETAIL_MAX_CHARS = 512;
const MUTUAL_SSH_FAILURE_DETAIL_SCRUB_LIMIT = 16_384;
const SSH_PUBLIC_KEY_RE = /\b(?:ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-nistp(?:256|384|521))\s+[A-Za-z0-9+/=]{16,}(?:\s+\S+)?/gi;
const HOME_PATH_RE = /\/(?:Users|home)\/[^/\s]+/g;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6_CANDIDATE_RE = /(?<![A-Za-z0-9])(\[?[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*(?:%[A-Za-z0-9_.-]+)?\]?)(?![A-Za-z0-9])/g;
const HOST_LABEL_PATTERN = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST_TOKEN_PATTERN = `${HOST_LABEL_PATTERN}(?:\\.${HOST_LABEL_PATTERN})*`;
const DNS_FAILURE_HOST_RE = new RegExp(`(\\b(?:getaddrinfo\\s+)?(?:ENOTFOUND|EAI_AGAIN)\\s+)(${HOST_TOKEN_PATTERN})\\b`, 'gi');
const LABELED_HOST_RE = new RegExp(`(\\b(?:host(?:name)?|endpoint|destination|server)\\s*[=:]\\s*)(${HOST_TOKEN_PATTERN})\\b`, 'gi');
const CONNECT_TO_HOST_RE = new RegExp(`(\\b(?:connect(?:ing|ed)?\\s+to(?:\\s+host)?|could not resolve hostname)\\s+)(${HOST_TOKEN_PATTERN})\\b`, 'gi');
const PRIVATE_HOSTNAME_RE = new RegExp(`\\b${HOST_TOKEN_PATTERN}\\.(?:internal|local|lan|home\\.arpa|ts\\.net)\\b`, 'gi');
const SSH_USER_HOST_RE = new RegExp(`(\\b[a-z_][a-z0-9_-]*@)(${HOST_TOKEN_PATTERN})\\b`, 'gi');

/**
 * Retain the thrown evidence without exposing endpoint identity or key material.
 * Classification deliberately runs over the original value; scrubbing affects
 * only the operator-facing detail and can never broaden the match table.
 */
export function captureMutualSshFailure(error: unknown): CapturedMutualSshFailure {
  const raw = error instanceof Error ? error.message : String(error);
  const source = raw.length > 0 ? raw : '<empty error message>';
  let detail = scrubForStore(source, { maxBytes: MUTUAL_SSH_FAILURE_DETAIL_SCRUB_LIMIT }).text;
  detail = detail
    .replace(SSH_PUBLIC_KEY_RE, '[REDACTED:ssh-key]')
    .replace(HOME_PATH_RE, '<HOME>')
    .replace(IPV4_RE, '[REDACTED:address]')
    .replace(IPV6_CANDIDATE_RE, (whole) => isIpv6Literal(whole) ? '[REDACTED:address]' : whole)
    .replace(DNS_FAILURE_HOST_RE, '$1[REDACTED:hostname]')
    .replace(LABELED_HOST_RE, '$1[REDACTED:hostname]')
    .replace(CONNECT_TO_HOST_RE, '$1[REDACTED:hostname]')
    .replace(PRIVATE_HOSTNAME_RE, '[REDACTED:hostname]')
    .replace(SSH_USER_HOST_RE, '$1[REDACTED:hostname]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (detail.length === 0) detail = '<empty error detail after scrubbing>';
  if (detail.length > MUTUAL_SSH_FAILURE_DETAIL_MAX_CHARS) {
    detail = `${detail.slice(0, MUTUAL_SSH_FAILURE_DETAIL_MAX_CHARS - 1)}…`;
  }
  return { failureClass: classifyMutualSshFailure(error), detail };
}
function isIpv6Literal(value: string): boolean {
  let candidate = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  const zone = candidate.indexOf('%');
  if (zone >= 0) candidate = candidate.slice(0, zone);
  return isIP(candidate) === 6;
}
function hasAny(value: string, needles: readonly string[]): boolean { return needles.some(needle => value.includes(needle)); }
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
