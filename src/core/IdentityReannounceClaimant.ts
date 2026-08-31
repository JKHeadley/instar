/** Durable claimant-side recovery episode: typed refusals → bounded re-announce. */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { signingRotationMessage, type RotationBinding } from './MachineRecoveryKey.js';
import { sign } from './MachineIdentity.js';
import type { MachineIdentity } from './types.js';
import { IDENTITY_REANNOUNCE_PROTOCOL_VERSION } from './IdentityReannounce.js';

interface FailureRun { count: number; firstAt: number; lastAt: number }
interface PeerAttempt {
  status: 'pending' | 'accepted' | 'would-accept' | 'quarantined' | 'refused' | 'route-absent' | 'exhausted';
  attempts: number;
  nextAttemptAt: number;
  lastReason?: string;
  unreachableSince?: number;
}
interface Episode {
  keyEpoch: number;
  openedAt: number;
  peers: Record<string, PeerAttempt>;
  firstAcceptanceNoticed: boolean;
  horizonNoticed: boolean;
  continuityRequired?: boolean;
}
interface ClaimantFile {
  version: 1;
  failures: Record<string, FailureRun>;
  episodes: Record<string, Episode>;
}

export interface ReannouncePeer { machineId: string; url: string }
export interface PeerChallenge {
  challengeId: string;
  nonce: string;
  challengerMachineId: string;
  protocolVersion: number;
}
export interface PeerClaimOutcome { outcome: 'accepted' | 'would-accept' | 'quarantined' | 'would-quarantine' | 'refused'; reason?: string }

export interface IdentityReannounceClaimantDeps {
  stateDir: string;
  identity: () => MachineIdentity;
  signingPrivateKey: () => string;
  recoveryContinuitySignature: (binding: RotationBinding) => string | null;
  peers: () => ReannouncePeer[];
  requestChallenge: (peer: ReannouncePeer, identity: MachineIdentity) => Promise<PeerChallenge>;
  submitClaim: (peer: ReannouncePeer, claim: { challengeId: string; possessionSignature: string; continuitySignature?: string }) => Promise<PeerClaimOutcome>;
  admit: (peerMachineId: string) => Promise<boolean>;
  notify: (event: { kind: 'first-acceptance' | 'outcome-update' | 'horizon-exhausted'; keyEpoch: number; peers: Record<string, PeerAttempt> }) => void;
  now?: () => number;
}

/** The only pre-activation use of the persisted recovery bearer. Returning the
 * token is inseparable from proving that this is an automatic local recovery
 * and that escrow still matches the identity's pinned recovery root. */
export function resolveContinuityBootstrapBearer(input: {
  identityMutationCoherenceAllowed: boolean;
  recoveryEscrowDryRun: boolean | undefined;
  identity: MachineIdentity;
  escrowMatchesPinnedRoot: boolean;
  configuredBearerToken: string | undefined;
}): string | null {
  if (input.identityMutationCoherenceAllowed
    || input.recoveryEscrowDryRun !== false
    || typeof input.identity.keysRotatedReason !== 'string'
    || !input.identity.keysRotatedReason.startsWith('automatic recovery:')
    || !input.identity.recoveryPublicKey
    || !input.escrowMatchesPinnedRoot
    || !/^[a-f0-9]{64}$/i.test(input.configuredBearerToken ?? '')) return null;
  return input.configuredBearerToken!;
}

const FAILURE_K = 10;
const FAILURE_SPAN_MS = 15 * 60_000;
const HORIZON_MS = 72 * 60 * 60_000;
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 6 * 60 * 60_000];
const MAX_PARALLEL_ATTEMPTS_PER_TICK = 4;

function atomicWrite(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export class IdentityReannounceClaimant {
  private readonly d: IdentityReannounceClaimantDeps;
  private readonly file: string;
  private ticking = false;

  constructor(deps: IdentityReannounceClaimantDeps) {
    this.d = deps;
    this.file = path.join(deps.stateDir, 'state', 'identity-reannounce-claimant.json');
  }

  recordAuthRejected(peerMachineId: string): FailureRun {
    const data = this.read();
    const now = (this.d.now ?? Date.now)();
    const rotatedAt = Date.parse(this.d.identity().keysRotatedAt ?? '');
    const stored = data.failures[peerMachineId];
    // A refusal run that began before this signing generation cannot help open
    // the new generation's claimant episode. Reset it on the first post-rotate
    // refusal so stale evidence cannot either authorize or permanently wedge
    // recovery.
    const prior = stored && (!Number.isFinite(rotatedAt) || stored.firstAt >= rotatedAt)
      ? stored
      : undefined;
    const row = prior
      ? { count: prior.count + 1, firstAt: prior.firstAt, lastAt: now }
      : { count: 1, firstAt: now, lastAt: now };
    data.failures[peerMachineId] = row;
    this.write(data);
    return row;
  }

  recordSuccess(peerMachineId: string): void {
    const data = this.read();
    if (!data.failures[peerMachineId]) return;
    delete data.failures[peerMachineId];
    this.write(data);
  }

  /** Open the escrow-continuity recovery path immediately after local total-key
   * recovery. This bypasses the ordinary 10-refusal trigger because the peer's
   * already-pinned recovery root—not timing evidence—is the authority. The
   * resulting episode refuses to submit without a continuity signature. */
  openContinuityRecovery(): void {
    const data = this.read();
    const now = (this.d.now ?? Date.now)();
    const identity = this.d.identity();
    const rotatedAt = Date.parse(identity.keysRotatedAt ?? '');
    if (!identity.recoveryPublicKey || !Number.isFinite(rotatedAt)) {
      throw new Error('continuity recovery requires a rotated identity with a pinned recovery root');
    }
    const epoch = Number(identity.keyEpoch ?? 0);
    const episodeKey = `${identity.machineId}:${epoch}`;
    const episode = data.episodes[episodeKey] ?? {
      keyEpoch: epoch, openedAt: now, peers: {}, firstAcceptanceNoticed: false, horizonNoticed: false,
    };
    episode.continuityRequired = true;
    for (const peer of this.d.peers()) {
      episode.peers[peer.machineId] ??= { status: 'pending', attempts: 0, nextAttemptAt: now };
    }
    data.episodes[episodeKey] = episode;
    this.write(data);
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const data = this.read();
      const now = (this.d.now ?? Date.now)();
      const identity = this.d.identity();
      const rotatedAt = Date.parse(identity.keysRotatedAt ?? '');
      if (!Number.isFinite(rotatedAt)) return;
      const epoch = Number(identity.keyEpoch ?? 0);
      const episodeKey = `${identity.machineId}:${epoch}`;
      let episode = data.episodes[episodeKey];
      const peersById = new Map(this.d.peers().map((peer) => [peer.machineId, peer]));

      for (const [peerMachineId, failures] of Object.entries(data.failures)) {
        if (failures.count < FAILURE_K || failures.lastAt - failures.firstAt < FAILURE_SPAN_MS) continue;
        if (failures.firstAt < rotatedAt || !peersById.has(peerMachineId)) continue;
        episode ??= { keyEpoch: epoch, openedAt: now, peers: {}, firstAcceptanceNoticed: false, horizonNoticed: false };
        episode.peers[peerMachineId] ??= { status: 'pending', attempts: 0, nextAttemptAt: now };
      }
      if (!episode) return;
      data.episodes[episodeKey] = episode;

      // A peer can be active in the authenticated registry before it has a
      // usable URL. Continuity recovery must absorb it when a route later
      // appears; otherwise activation can remain held forever even though the
      // peer has become reachable.
      let addedContinuityPeer = false;
      if (episode.continuityRequired) {
        for (const peerMachineId of peersById.keys()) {
          if (episode.peers[peerMachineId]) continue;
          episode.peers[peerMachineId] = { status: 'pending', attempts: 0, nextAttemptAt: now };
          addedContinuityPeer = true;
        }
      }

      // An active peer may have no route for longer than the episode horizon,
      // so it cannot be represented in peers() until much later. Give the
      // newly routable cohort one fresh, still-bounded horizon rather than
      // terminalizing it before its first claim.
      if (addedContinuityPeer && now - episode.openedAt >= HORIZON_MS) {
        episode.openedAt = now;
        episode.horizonNoticed = false;
      }

      // Attempt ownership is persisted before network I/O. If the process dies
      // after owning the third slot, restart must consume that slot as terminal
      // rather than issuing a fourth request.
      let reconciledAttemptCap = false;
      for (const row of Object.values(episode.peers)) {
        if (['pending', 'route-absent', 'refused'].includes(row.status) && row.attempts >= 3) {
          row.status = 'exhausted';
          reconciledAttemptCap = true;
        }
      }
      if (reconciledAttemptCap && !episode.horizonNoticed) {
        episode.horizonNoticed = true;
        this.d.notify({ kind: 'horizon-exhausted', keyEpoch: epoch, peers: episode.peers });
      }

      const outagePaused = Object.values(episode.peers).some((row) => row.unreachableSince !== undefined);
      if (!outagePaused && now - episode.openedAt >= HORIZON_MS) {
        for (const row of Object.values(episode.peers)) {
          if (['pending', 'route-absent', 'refused'].includes(row.status)) row.status = 'exhausted';
        }
        if (!episode.horizonNoticed) {
          episode.horizonNoticed = true;
          this.d.notify({ kind: 'horizon-exhausted', keyEpoch: epoch, peers: episode.peers });
        }
        this.write(data);
        return;
      }

      const candidates = Object.entries(episode.peers)
        .filter(([peerMachineId, row]) => ['pending', 'route-absent', 'refused'].includes(row.status)
          && row.nextAttemptAt <= now && peersById.has(peerMachineId))
        .sort(([leftId, left], [rightId, right]) => left.nextAttemptAt - right.nextAttemptAt
          || left.attempts - right.attempts || leftId.localeCompare(rightId));
      const admitted: Array<[string, PeerAttempt, ReannouncePeer]> = [];
      for (const [peerMachineId, row] of candidates) {
        if (admitted.length >= MAX_PARALLEL_ATTEMPTS_PER_TICK) break;
        if (!(await this.d.admit(peerMachineId))) continue; // governor deny consumes no attempt
        admitted.push([peerMachineId, row, peersById.get(peerMachineId)!]);
      }

      // Own the whole bounded batch durably before starting network work. A
      // crash cannot replay any selected budget slot, and no tick ever has more
      // than four peer RPC sequences in flight.
      for (const [, row] of admitted) {
        row.attempts += 1;
        row.nextAttemptAt = now + BACKOFF_MS[Math.min(row.attempts - 1, BACKOFF_MS.length - 1)];
      }
      if (admitted.length > 0) this.write(data);

      await Promise.all(admitted.map(async ([peerMachineId, row, peer]) => {
        try {
          const challenge = await this.d.requestChallenge(peer, identity);
          if (row.unreachableSince !== undefined) {
            episode.openedAt += Math.max(0, now - row.unreachableSince);
            delete row.unreachableSince;
          }
          if (!Number.isSafeInteger(challenge.protocolVersion)
            || challenge.protocolVersion < IDENTITY_REANNOUNCE_PROTOCOL_VERSION) {
            throw Object.assign(new Error('peer-lacks-accept-route'), { status: 501 });
          }
          const binding: RotationBinding = {
            nonce: challenge.nonce,
            claimantMachineId: identity.machineId,
            newSigningPublicKey: identity.signingPublicKey,
            newEncryptionPublicKey: identity.encryptionPublicKey,
            challengerMachineId: challenge.challengerMachineId,
            keyEpoch: epoch,
            recoveryEpoch: Number(identity.recoveryEpoch ?? 0),
            newRecoveryPublicKey: identity.recoveryPublicKey,
          };
          const continuitySignature = this.d.recoveryContinuitySignature(binding) ?? undefined;
          if (episode.continuityRequired && !continuitySignature) {
            row.status = 'refused';
            row.lastReason = 'recovery-continuity-unavailable';
          } else {
            const result = await this.d.submitClaim(peer, {
              challengeId: challenge.challengeId,
              possessionSignature: sign(signingRotationMessage(binding), this.d.signingPrivateKey()),
              continuitySignature,
            });
            row.status = result.outcome === 'would-quarantine' ? 'quarantined' : result.outcome;
            row.lastReason = result.reason;
            if (row.status === 'refused') {
              row.nextAttemptAt = now + BACKOFF_MS[Math.min(row.attempts - 1, BACKOFF_MS.length - 1)];
            }
          }
        } catch (err) {
          const status = typeof err === 'object' && err && 'status' in err ? Number((err as { status: unknown }).status) : 0;
          row.status = status === 404 || status === 501 ? 'route-absent' : 'pending';
          row.lastReason = status === 404 || status === 501 ? 'peer-lacks-accept-route' : 'attempt-failed';
          if (!status) {
            row.unreachableSince ??= now;
            // An ordinary observed transport failure is not an identity
            // assertion and cannot consume the three-attempt generation cap.
            row.attempts = Math.max(0, row.attempts - 1);
          } else if (row.unreachableSince !== undefined) {
            episode.openedAt += Math.max(0, now - row.unreachableSince);
            delete row.unreachableSince;
          }
          row.nextAttemptAt = now + BACKOFF_MS[Math.min(Math.max(0, row.attempts - 1), BACKOFF_MS.length - 1)];
        }
        if (['route-absent', 'refused'].includes(row.status) && row.attempts >= 3) {
          row.status = 'exhausted';
          if (!episode.horizonNoticed) {
            episode.horizonNoticed = true;
            this.d.notify({ kind: 'horizon-exhausted', keyEpoch: epoch, peers: episode.peers });
          }
        }
        if (row.status === 'accepted' || row.status === 'would-accept') {
          if (!episode.firstAcceptanceNoticed) {
            episode.firstAcceptanceNoticed = true;
            this.d.notify({ kind: 'first-acceptance', keyEpoch: epoch, peers: episode.peers });
          } else {
            this.d.notify({ kind: 'outcome-update', keyEpoch: epoch, peers: episode.peers });
          }
        }
      }));
      this.write(data);
    } finally {
      this.ticking = false;
    }
  }

  status(): ClaimantFile { return this.read(); }

  private read(): ClaimantFile {
    if (!fs.existsSync(this.file)) return { version: 1, failures: {}, episodes: {} };
    const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as ClaimantFile;
    if (parsed?.version !== 1 || !parsed.failures || !parsed.episodes) throw new Error('identity-claimant-store-corrupt');
    return parsed;
  }
  private write(data: ClaimantFile): void { atomicWrite(this.file, data); }
}
