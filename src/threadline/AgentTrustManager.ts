/**
 * AgentTrustManager — Per-agent trust profiles for inter-agent communication.
 *
 * Part of Threadline Protocol Phase 5. Tracks trust between THIS agent and
 * remote agents it communicates with. Unlike AdaptiveTrust (user→agent trust),
 * this manages agent→agent trust in the Threadline mesh.
 *
 * Trust rules (Section 7.3/7.4):
 * - ALL trust level UPGRADES require source: 'user-granted' — NO auto-escalation
 * - Auto-DOWNGRADE only: circuit breaker (3 activations in 24h → untrusted),
 *   crypto verification failure → untrusted, 90 days no interaction → downgrade one level
 * - All trust changes logged to append-only audit trail
 *
 * Storage:
 * - Profiles: {stateDir}/threadline/trust-profiles.json
 * - Audit trail: {stateDir}/threadline/trust-audit.jsonl
 */

import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { PairingPendingStore, type PendingPairingRecord } from './PairingPendingStore.js';

// ── Types ────────────────────────────────────────────────────────────

export type AgentTrustLevel = 'untrusted' | 'verified' | 'trusted' | 'autonomous';
export type AgentTrustSource =
  | 'user-granted'
  | 'paired-machine-granted'
  | 'setup-default'
  /**
   * Out-of-band SAS-verified pairing (Secure A2A Verified Pairing, §3.3).
   * Structurally un-self-grantable: ONLY `markMutualVerified` may set this source.
   * The generic setter (`applyTrustLevel`/`setTrustLevelByFingerprint`) REJECTS it
   * as input (returns false), so credential-share can never be self-granted.
   */
  | 'mutual-verified';

/**
 * Pairing lifecycle state stored ON the trust profile (single source of truth, §3.7).
 * `pending-verification` after a handshake; `mutual-verified` once the operator
 * SAS-confirms; `verification-failed` on an operator-asserted mismatch.
 *
 * `identity-verified` (§3.8, FD11) is the INHERITED state on a machine OTHER than the
 * one whose operator SAS-compared: a replicated `mutual-verified` RESULT from a peer
 * machine, HONORED by pinning the peer's identity key. It asserts "this identity key was
 * SAS-verified by a human SOMEWHERE" — it is NOT by itself channel-ready: credential-share
 * on THIS machine additionally requires THIS machine's own live encrypted channel (the
 * outbound CredentialShareGate enforces the encrypted-path half). It cannot be reached
 * locally (only an inbound replicated record sets it), so it can never be self-granted.
 */
export type PairingState = 'pending-verification' | 'mutual-verified' | 'verification-failed' | 'identity-verified';

export interface AgentTrustHistory {
  messagesReceived: number;
  messagesResponded: number;
  successfulInteractions: number;
  failedInteractions: number;
  lastInteraction: string;
  streakSinceIncident: number;
}

export interface AgentTrustProfile {
  agent: string;
  /** Cryptographic fingerprint (Ed25519-derived). Primary identity key. */
  fingerprint?: string;
  level: AgentTrustLevel;
  source: AgentTrustSource;
  history: AgentTrustHistory;
  allowedOperations: string[];
  blockedOperations: string[];
  createdAt: string;
  updatedAt: string;

  // ── Verified-Pairing state (Secure A2A Verified Pairing, §3.7) ──
  // Stored ON the trust profile so there is no cross-file torn state. The
  // sensitive SAS words live in a separate machine-local 0600 store
  // (PairingPendingStore), never here and never replicated.
  /** Pairing lifecycle state. Absent = no pairing handshake has occurred. */
  pairingState?: PairingState;
  /** Identifies THIS handshake instance (epoch binding, FD4). */
  pairingId?: string;
  /** The peer's Ed25519 identity public key (hex) bound by the human's verification. */
  peerIdentityPub?: string;
  /** SAS fingerprint (FD3) — logged/audited value; the SAS WORDS are never stored here. */
  sasFingerprint?: string;
  /** When this side's operator SAS-confirmed the peer (ISO-8601). */
  verifiedAt?: string;
  /** Optional liveness flag (FD8): a signature-verified inbound peer receipt arrived. */
  peerAcked?: boolean;
  /** When the pairingState is `identity-verified` (§3.8), the machine id whose operator
   *  SAS-compared (carried by the replicated record). Audit/observability only. */
  inheritedFromMachine?: string;
}

export interface TrustAuditEntry {
  timestamp: string;
  agent: string;
  previousLevel: AgentTrustLevel;
  newLevel: AgentTrustLevel;
  source: AgentTrustSource | 'system';
  reason: string;
  userInitiated: boolean;
}

export interface TrustChangeNotification {
  agent: string;
  previousLevel: AgentTrustLevel;
  newLevel: AgentTrustLevel;
  reason: string;
  userInitiated: boolean;
}

/** Callback for trust change notifications */
export type TrustChangeCallback = (notification: TrustChangeNotification) => void;

/**
 * Verified-pairing replication emitter (Secure A2A Verified Pairing §3.8 / FD11),
 * injected by server.ts ONLY when the journal-backed emitter exists AND
 * `multiMachine.stateSync.threadlinePairing.enabled` is true (default false ⇒ NOT
 * injected ⇒ a strict no-op). Replicates ONLY the verified-IDENTITY RESULT across the
 * agent's OWN machines — NEVER the SAS, shared secret, or relay token (the emitter is
 * handed ONLY the 5-field result; it has no access to the SAS store). The emitter
 * NEVER throws out of a mutation (a replication failure must never break a local trust
 * write), so the manager calls it best-effort.
 */
export interface PairingReplicationEmitter {
  /** Emit a `put` for a freshly mutual-verified pairing (the 5-field result). */
  emitVerified(result: {
    peerFp: string;
    peerIdentityPub: string;
    verifiedAt: string;
    verifiedOnMachine: string;
  }): void;
  /** Emit a `delete` tombstone for a revoked / verification-failed pairing (un-verify
   *  sticks pool-wide), keyed on the peer fingerprint. */
  emitRevoke(peerFp: string, deletedAt: string): void;
}

export interface InteractionStats {
  messagesReceived: number;
  messagesResponded: number;
  successfulInteractions: number;
  failedInteractions: number;
  successRate: number;
  streakSinceIncident: number;
  lastInteraction: string | null;
}

// ── Constants ────────────────────────────────────────────────────────

/** Trust levels ordered from most restrictive to least */
const TRUST_ORDER: AgentTrustLevel[] = ['untrusted', 'verified', 'trusted', 'autonomous'];

/** 90 days in milliseconds — staleness threshold for auto-downgrade */
const STALENESS_THRESHOLD_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * The credential-bearing operation (Secure A2A Verified Pairing, §3.3).
 * Deliberately NOT a member of any `DEFAULT_ALLOWED_OPS` level: it is allowed
 * ONLY for a peer whose trustSource === 'mutual-verified' AND level >= 'trusted'
 * (never by 'autonomous' alone, never by 'setup-default'/auto-handshake).
 * That gate lives in `isCredentialShareAllowed*`, not the level table.
 */
export const CREDENTIAL_SHARE_OP = 'credential-share';

/** Default operations allowed per trust level */
const DEFAULT_ALLOWED_OPS: Record<AgentTrustLevel, string[]> = {
  untrusted: ['ping', 'health'],
  verified: ['ping', 'health', 'message', 'query'],
  trusted: ['ping', 'health', 'message', 'query', 'task-request', 'data-share'],
  autonomous: ['ping', 'health', 'message', 'query', 'task-request', 'data-share', 'spawn', 'delegate'],
};

// ── Helpers ──────────────────────────────────────────────────────────

function atomicWrite(filePath: string, data: string): void {
  const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, data);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { SafeFsExecutor.safeUnlinkSync(tmpPath, { operation: 'src/threadline/AgentTrustManager.ts:105' }); } catch { /* ignore */ }
    throw err;
  }
}

function safeJsonParse<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

// ── Implementation ───────────────────────────────────────────────────

interface ProfilesFile {
  profiles: Record<string, AgentTrustProfile>;
  updatedAt: string;
}

export class AgentTrustManager {
  private readonly threadlineDir: string;
  private readonly profilesPath: string;
  private readonly auditPath: string;
  private profiles: Record<string, AgentTrustProfile>;
  private onTrustChange: TrustChangeCallback | null;
  private saveDirty = false;
  private saveTimer: ReturnType<typeof setInterval> | null = null;
  /** Machine-local 0600 store for pending-verification SAS words (FD4). */
  private readonly pendingStore: PairingPendingStore;
  /** Verified-pairing replication emitter (§3.8, injected/dark by default). Absent ⇒
   *  strict no-op (single-machine behavior). */
  private pairingReplication?: PairingReplicationEmitter;
  /** This machine's id (stamped into a replicated `verifiedOnMachine`). Absent ⇒ '?'. */
  private machineId: string;

  constructor(options: {
    stateDir: string;
    onTrustChange?: TrustChangeCallback;
    /** This machine's id, stamped into a replicated verified-identity result (§3.8). */
    machineId?: string;
  }) {
    this.threadlineDir = path.join(options.stateDir, 'threadline');
    fs.mkdirSync(this.threadlineDir, { recursive: true });
    this.profilesPath = path.join(this.threadlineDir, 'trust-profiles.json');
    this.auditPath = path.join(this.threadlineDir, 'trust-audit.jsonl');
    this.onTrustChange = options.onTrustChange ?? null;
    this.machineId = options.machineId ?? '?';
    this.profiles = this.loadProfiles();
    this.pendingStore = new PairingPendingStore({ stateDir: options.stateDir });
  }

  /**
   * Late-bind the verified-pairing replication emitter (§3.8). server.ts constructs the
   * journal-backed emitter AFTER the trust manager; passing undefined detaches (back to
   * single-machine no-op). Idempotent. Optionally re-sets the machine id used for a
   * replicated `verifiedOnMachine`.
   */
  setPairingReplicationEmitter(emitter: PairingReplicationEmitter | undefined, machineId?: string): void {
    this.pairingReplication = emitter;
    if (machineId) this.machineId = machineId;
  }

  // ── Profile Access ──────────────────────────────────────────────

  /**
   * Get trust profile for an agent by name or fingerprint.
   * Checks direct key match first (name or fingerprint), then scans
   * profile display names for backwards compatibility.
   */
  getProfile(agentNameOrFingerprint: string): AgentTrustProfile | null {
    // Direct key lookup (works for both name-keyed and fingerprint-keyed profiles)
    if (this.profiles[agentNameOrFingerprint]) {
      return this.profiles[agentNameOrFingerprint];
    }
    // Scan display names (for fingerprint-keyed profiles looked up by name)
    for (const profile of Object.values(this.profiles)) {
      if (profile.agent === agentNameOrFingerprint) return profile;
    }
    return null;
  }

  /**
   * Get or create a trust profile for an agent.
   * New agents start as 'untrusted' with 'setup-default' source.
   */
  getOrCreateProfile(agentName: string): AgentTrustProfile {
    if (!this.profiles[agentName]) {
      const now = new Date().toISOString();
      this.profiles[agentName] = {
        agent: agentName,
        level: 'untrusted',
        source: 'setup-default',
        history: {
          messagesReceived: 0,
          messagesResponded: 0,
          successfulInteractions: 0,
          failedInteractions: 0,
          lastInteraction: '',
          streakSinceIncident: 0,
        },
        allowedOperations: [...DEFAULT_ALLOWED_OPS.untrusted],
        blockedOperations: [],
        createdAt: now,
        updatedAt: now,
      };
      this.save();
    }
    return this.profiles[agentName];
  }

  // ── Fingerprint-Based Access (for relay messages) ──────────────

  /**
   * Get trust profile by cryptographic fingerprint.
   * Used for relay inbound messages where identity is fingerprint-based.
   */
  getProfileByFingerprint(fingerprint: string): AgentTrustProfile | null {
    for (const profile of Object.values(this.profiles)) {
      if (profile.fingerprint === fingerprint) {
        return profile;
      }
    }
    return null;
  }

  /**
   * Get or create a trust profile keyed by fingerprint.
   * For relay agents, the fingerprint IS the identity.
   * Relay agents default to 'verified' (can send messages) rather than
   * 'untrusted' (probes only), since they've already authenticated with the relay.
   *
   * IMPORTANT: Always keys by fingerprint to avoid collisions between
   * same-named agents on different machines. Display name is stored in
   * the profile's `agent` field for human readability.
   */
  getOrCreateProfileByFingerprint(fingerprint: string, displayName?: string): AgentTrustProfile {
    // Check if profile already exists by fingerprint
    const existing = this.getProfileByFingerprint(fingerprint);
    if (existing) {
      // Update display name if provided and different
      if (displayName && existing.agent !== displayName && existing.agent === fingerprint) {
        existing.agent = displayName;
        this.scheduleSave();
      }
      return existing;
    }

    // Create new profile keyed by fingerprint to prevent same-name collisions
    const now = new Date().toISOString();
    this.profiles[fingerprint] = {
      agent: displayName ?? fingerprint,
      fingerprint,
      level: 'verified',
      source: 'setup-default',
      history: {
        messagesReceived: 0,
        messagesResponded: 0,
        successfulInteractions: 0,
        failedInteractions: 0,
        lastInteraction: '',
        streakSinceIncident: 0,
      },
      allowedOperations: [...DEFAULT_ALLOWED_OPS.verified],
      blockedOperations: [],
      createdAt: now,
      updatedAt: now,
    };
    this.save();
    return this.profiles[fingerprint];
  }

  /**
   * Get trust level by fingerprint. Returns 'untrusted' for unknown agents.
   */
  getTrustLevelByFingerprint(fingerprint: string): AgentTrustLevel {
    const profile = this.getProfileByFingerprint(fingerprint);
    return profile?.level ?? 'untrusted';
  }

  /**
   * Get allowed operations by fingerprint.
   */
  getAllowedOperationsByFingerprint(fingerprint: string): string[] {
    const profile = this.getProfileByFingerprint(fingerprint);
    if (!profile) return [...DEFAULT_ALLOWED_OPS.untrusted];
    const base = profile.allowedOperations.length > 0
      ? [...profile.allowedOperations]
      : [...DEFAULT_ALLOWED_OPS[profile.level]];
    // credential-share is never in the level table — surface it only when the
    // dedicated gate allows it (mutual-verified + trusted, §3.3).
    if (this.isCredentialShareAllowedForProfile(profile) && !base.includes(CREDENTIAL_SHARE_OP)) {
      base.push(CREDENTIAL_SHARE_OP);
    }
    return base;
  }

  /**
   * Set trust level by fingerprint.
   * Operates directly on the fingerprint-keyed profile to avoid
   * name collision issues with setTrustLevel's name-based lookup.
   */
  setTrustLevelByFingerprint(
    fingerprint: string,
    level: AgentTrustLevel,
    source: AgentTrustSource,
    reason?: string,
    displayName?: string,
  ): boolean {
    const profile = this.getOrCreateProfileByFingerprint(fingerprint, displayName);
    return this.applyTrustLevel(profile, level, source, reason);
  }

  /**
   * Record a received message by fingerprint (debounced save).
   */
  recordMessageReceivedByFingerprint(fingerprint: string): void {
    const profile = this.getOrCreateProfileByFingerprint(fingerprint);
    profile.history.messagesReceived++;
    profile.history.lastInteraction = new Date().toISOString();
    profile.updatedAt = new Date().toISOString();
    this.scheduleSave();
  }

  // ── Trust Level Management ──────────────────────────────────────

  /**
   * Set trust level for an agent (by name).
   * UPGRADES require source: 'user-granted' or 'paired-machine-granted'.
   * Returns true if the change was applied, false if rejected.
   */
  setTrustLevel(
    agentName: string,
    level: AgentTrustLevel,
    source: AgentTrustSource,
    reason?: string
  ): boolean {
    const profile = this.getOrCreateProfile(agentName);
    return this.applyTrustLevel(profile, level, source, reason);
  }

  /**
   * Core trust level application logic. Shared by name-based and fingerprint-based paths.
   */
  private applyTrustLevel(
    profile: AgentTrustProfile,
    level: AgentTrustLevel,
    source: AgentTrustSource,
    reason?: string,
  ): boolean {
    const previousLevel = profile.level;
    const agentName = profile.agent;

    // The 'mutual-verified' source is structurally un-self-grantable (§3.3):
    // it may ONLY be set by the dedicated single-writer `markMutualVerified`.
    // The generic path rejects it as input so credential-share can never be
    // self-granted via setTrustLevel/setTrustLevelByFingerprint.
    if (source === 'mutual-verified') {
      return false;
    }

    // Unknown/forward-incompat source values degrade to un-verified — they must
    // NEVER elevate trust (a downgrade-rollback can't silently grant anything).
    const KNOWN_SOURCES: AgentTrustSource[] = ['user-granted', 'paired-machine-granted', 'setup-default'];
    if (!KNOWN_SOURCES.includes(source)) {
      return false;
    }

    // Upgrades require user-granted or paired-machine-granted source
    if (this.compareTrust(level, previousLevel) > 0) {
      if (source !== 'user-granted' && source !== 'paired-machine-granted') {
        return false;
      }
    }

    profile.level = level;
    profile.source = source;
    profile.updatedAt = new Date().toISOString();
    profile.allowedOperations = [...DEFAULT_ALLOWED_OPS[level]];

    this.save();
    this.writeAudit({
      timestamp: new Date().toISOString(),
      agent: agentName,
      previousLevel,
      newLevel: level,
      source,
      reason: reason ?? `Trust level changed to ${level}`,
      userInitiated: source === 'user-granted' || source === 'paired-machine-granted',
    });

    if (this.onTrustChange) {
      this.onTrustChange({
        agent: agentName,
        previousLevel,
        newLevel: level,
        reason: reason ?? `Trust level changed to ${level}`,
        userInitiated: source === 'user-granted' || source === 'paired-machine-granted',
      });
    }

    return true;
  }

  // ── Verified Pairing (Secure A2A Verified Pairing, §3.2/§3.3/§3.7) ──

  /**
   * Record a pending-verification pairing after a handshake.
   *
   * Writes the (replicated) pairing state ON the trust profile AND the
   * sensitive SAS words into the machine-local 0600 pending store. A NEW
   * handshake (new pairingId) resets pairingState to 'pending-verification'
   * and clears any prior verifiedAt/peerAcked (FD4) — a fresh epoch discards
   * the prior confirmation.
   *
   * Returns false for a self-pair (peerFp === ownFp, FD12). Does NOT touch the
   * trust source or level — that only happens at `markMutualVerified`.
   */
  recordPendingVerification(
    peerFp: string,
    args: {
      pairingId: string;
      peerIdentityPub: string;
      sasWords: string[];
      sasFingerprint: string;
      ownFp: string;
      displayName?: string;
    },
  ): boolean {
    // FD12 — self-pair guard.
    if (!peerFp || peerFp === args.ownFp) return false;

    const profile = this.getOrCreateProfileByFingerprint(peerFp, args.displayName);
    const now = new Date().toISOString();

    // A new pairingId is a new handshake epoch → reset to pending + clear prior confirm.
    profile.pairingState = 'pending-verification';
    profile.pairingId = args.pairingId;
    profile.peerIdentityPub = args.peerIdentityPub;
    profile.sasFingerprint = args.sasFingerprint;
    profile.verifiedAt = undefined;
    profile.peerAcked = undefined;
    profile.updatedAt = now;

    const record: PendingPairingRecord = {
      pairingId: args.pairingId,
      peerFp,
      peerIdentityPub: args.peerIdentityPub,
      sasWords: [...args.sasWords],
      sasFingerprint: args.sasFingerprint,
      createdAt: now,
    };
    this.pendingStore.put(record);
    this.save();
    return true;
  }

  /**
   * THE ONLY code path that may set trustSource='mutual-verified' (§3.3).
   *
   * Preconditions:
   * - `operatorConfirm` must be truthy (the operator-PIN check happens at the
   *   route layer; here we require the flag is present).
   * - `peerFp !== ownFp` (FD12 self-pair guard).
   * - The pairing must be in 'pending-verification' (or already 'mutual-verified')
   *   for the SAME pairingId (epoch binding — a stale pairingId is rejected).
   *
   * Write order (§3.7): pairing record fields written → trust source/level set
   * LAST, so a partial failure fails closed (never source-without-record).
   * Raises level to 'trusted' if currently below it (never to 'autonomous', FD6).
   * Discards the machine-local pending SAS store on success.
   *
   * Returns false if any precondition fails (no mutation).
   */
  markMutualVerified(
    peerFp: string,
    args: { pairingId: string; operatorConfirm: boolean; peerAcked?: boolean; ownFp?: string },
  ): boolean {
    if (!peerFp) return false;
    if (!args.operatorConfirm) return false; // operator-confirm precondition (FD7)
    if (args.ownFp && peerFp === args.ownFp) return false; // FD12 self-pair guard
    if (!args.pairingId) return false;

    const profile = this.getProfileByFingerprint(peerFp);
    if (!profile) return false;

    // Epoch binding (FD4): only confirm the CURRENT handshake instance.
    if (profile.pairingId !== args.pairingId) return false;

    // Must be pending-verification or already mutual-verified (a late receipt
    // can re-affirm). A verification-failed pairing requires a fresh handshake.
    if (profile.pairingState !== 'pending-verification' && profile.pairingState !== 'mutual-verified') {
      return false;
    }

    const previousLevel = profile.level;
    const now = new Date().toISOString();

    // Record fields first (single source of truth, write source LAST).
    profile.pairingState = 'mutual-verified';
    profile.verifiedAt = now;
    if (typeof args.peerAcked === 'boolean') profile.peerAcked = args.peerAcked;

    // Raise to 'trusted' if below; never to 'autonomous' (FD6).
    if (this.compareTrust(profile.level, 'trusted') < 0) {
      profile.level = 'trusted';
    }
    profile.allowedOperations = [...DEFAULT_ALLOWED_OPS[profile.level]];

    // Trust source LAST — this is the credential-share authorization bit.
    profile.source = 'mutual-verified';
    profile.updatedAt = now;

    this.save();

    // §3.8 — replicate ONLY the verified-IDENTITY RESULT to the agent's OWN machines.
    // The emitter is handed ONLY the 5-field result (it has NO access to the SAS store),
    // so the SAS/shared-secret/relay-token can never cross. Best-effort; never throws out.
    // peerIdentityPub is required for the pin — skip emission if it is somehow absent.
    if (this.pairingReplication && profile.peerIdentityPub) {
      try {
        this.pairingReplication.emitVerified({
          peerFp,
          peerIdentityPub: profile.peerIdentityPub,
          verifiedAt: now,
          verifiedOnMachine: this.machineId,
        });
      } catch { /* replication failure never breaks the local trust write */ }
    }

    // The sensitive SAS words are no longer needed once verified — discard.
    this.pendingStore.discard(peerFp);

    this.writeAudit({
      timestamp: now,
      agent: profile.agent,
      previousLevel,
      newLevel: profile.level,
      source: 'mutual-verified',
      reason: `Mutual-verified pairing confirmed (pairingId ${args.pairingId.slice(0, 12)}…)`,
      userInitiated: true,
    });

    if (this.onTrustChange) {
      this.onTrustChange({
        agent: profile.agent,
        previousLevel,
        newLevel: profile.level,
        reason: 'Mutual-verified pairing confirmed',
        userInitiated: true,
      });
    }

    return true;
  }

  /**
   * Mark a pairing 'verification-failed' (operator-asserted SAS mismatch, §3.2).
   * Forces the peer to 'untrusted', clears the mutual-verified source, and
   * discards the pending SAS store. NOT used for a missing-receipt timeout
   * (that simply stays 'pending-verification').
   */
  markVerificationFailed(peerFp: string, reason: string): boolean {
    const profile = this.getProfileByFingerprint(peerFp);
    if (!profile) return false;

    const previousLevel = profile.level;
    const now = new Date().toISOString();

    profile.pairingState = 'verification-failed';
    profile.verifiedAt = undefined;
    profile.peerAcked = undefined;
    profile.level = 'untrusted';
    profile.source = 'setup-default';
    profile.allowedOperations = [...DEFAULT_ALLOWED_OPS.untrusted];
    profile.updatedAt = now;

    this.save();
    this.pendingStore.discard(peerFp);

    // §3.8 — propagate the un-verify as a TOMBSTONE so it sticks pool-wide (even on a
    // peer machine that was offline at revoke time). Best-effort; never throws out.
    if (this.pairingReplication) {
      try { this.pairingReplication.emitRevoke(peerFp, now); }
      catch { /* replication failure never breaks the local trust write */ }
    }

    this.writeAudit({
      timestamp: now,
      agent: profile.agent,
      previousLevel,
      newLevel: 'untrusted',
      source: 'system',
      reason,
      userInitiated: true,
    });

    if (this.onTrustChange) {
      this.onTrustChange({
        agent: profile.agent,
        previousLevel,
        newLevel: 'untrusted',
        reason,
        userInitiated: true,
      });
    }

    return true;
  }

  /**
   * Set the optional `peerAcked` liveness flag (FD8) — driven ONLY by a real
   * signature-verified inbound receipt at the receipt-handling layer. Never
   * elevates trust on its own; a missing receipt never strands verification.
   */
  recordPeerAck(peerFp: string, pairingId: string): boolean {
    const profile = this.getProfileByFingerprint(peerFp);
    if (!profile) return false;
    if (profile.pairingId !== pairingId) return false;
    if (profile.pairingState !== 'pending-verification' && profile.pairingState !== 'mutual-verified') {
      return false;
    }
    profile.peerAcked = true;
    profile.updatedAt = new Date().toISOString();
    this.scheduleSave();
    return true;
  }

  /** Read the pending SAS record (incl. words) for a peer — operator surface only. */
  getPendingPairing(peerFp: string): PendingPairingRecord | null {
    return this.pendingStore.get(peerFp);
  }

  /**
   * Honor a replicated `mutual-verified` RESULT from a PEER MACHINE by PINNING the
   * record's identity key (Secure A2A Verified Pairing §3.8 / FD11, codex finding 1).
   *
   * This is the ONLY path that sets `pairingState='identity-verified'` — the INHERITED
   * state on a machine OTHER than the one whose operator SAS-compared. It is driven ONLY
   * by an inbound replicated record (the union read), NEVER by a local actor — so it can
   * never be self-granted, and it can never set the LOCAL `mutual-verified` state (that
   * stays reserved for THIS machine's own operator confirm).
   *
   * KEY-PINNING (the load-bearing rule): the caller passes the identity key THIS
   * machine's own live handshake presented for the peer (`presentedIdentityPub`), or
   * undefined if there is no live handshake yet. If a live handshake's key DIFFERS from
   * the pinned `peerIdentityPub`, the inheritance is REFUSED and the local pairing is
   * DOWNGRADED to `pending-verification` (re-verify on this machine) — a
   * fingerprint-substitution attempt, never auto-honored.
   *
   * INHERITED ≠ CHANNEL-READY: `identity-verified` asserts only "this identity key was
   * SAS-verified by a human somewhere". credential-share on THIS machine additionally
   * requires THIS machine's own live encrypted channel — the outbound CredentialShareGate
   * enforces that encrypted-path half (it is a SEPARATE precondition).
   *
   * Returns true iff the inheritance was honored (state set to identity-verified). A
   * mismatch returns false AND downgrades. The trust source is set `mutual-verified`
   * (so the identity HALF of the credential gate passes) at level `trusted` — but NEVER
   * raises beyond trusted, and a local `mutual-verified`/`verification-failed` state is
   * not clobbered (a machine that already did its own thing wins).
   */
  inheritReplicatedVerification(
    peerFp: string,
    args: { peerIdentityPub: string; verifiedAt?: string; verifiedOnMachine?: string; presentedIdentityPub?: string; displayName?: string },
  ): boolean {
    if (!peerFp || !args.peerIdentityPub) return false;

    const profile = this.getOrCreateProfileByFingerprint(peerFp, args.displayName);

    // A LOCAL decision always wins over an inherited one. If THIS machine already
    // verification-failed the peer, the inherited grant must NOT resurrect it. If THIS
    // machine already locally mutual-verified, there is nothing to inherit.
    if (profile.pairingState === 'verification-failed') return false;
    if (profile.pairingState === 'mutual-verified' && profile.source === 'mutual-verified') {
      // Already locally verified — refresh the pinned key only if it agrees; a disagreement
      // is a substitution signal we DOWNGRADE on.
      if (profile.peerIdentityPub && profile.peerIdentityPub.toLowerCase() !== args.peerIdentityPub.toLowerCase()) {
        this.downgradeToPending(profile, 'inherited identity key conflicts with local mutual-verified key');
        return false;
      }
      return false; // local mutual-verified is authoritative; nothing to inherit.
    }

    // KEY-PIN: a live handshake whose key differs from the inherited pin is refused.
    if (args.presentedIdentityPub && args.presentedIdentityPub.toLowerCase() !== args.peerIdentityPub.toLowerCase()) {
      this.downgradeToPending(profile, 'inherited identity key does not match this machine handshake key (substitution refused)');
      return false;
    }

    const previousLevel = profile.level;
    const now = new Date().toISOString();

    profile.pairingState = 'identity-verified';
    profile.peerIdentityPub = args.peerIdentityPub;
    if (args.verifiedAt) profile.verifiedAt = args.verifiedAt;
    if (args.verifiedOnMachine) profile.inheritedFromMachine = args.verifiedOnMachine;

    // Raise to 'trusted' if below; never to 'autonomous'. Trust source set LAST (the
    // identity half of the credential gate) — the channel half is enforced separately.
    if (this.compareTrust(profile.level, 'trusted') < 0) {
      profile.level = 'trusted';
    }
    profile.allowedOperations = [...DEFAULT_ALLOWED_OPS[profile.level]];
    profile.source = 'mutual-verified';
    profile.updatedAt = now;

    this.save();
    this.writeAudit({
      timestamp: now,
      agent: profile.agent,
      previousLevel,
      newLevel: profile.level,
      source: 'mutual-verified',
      reason: `Inherited replicated verification (identity-verified${args.verifiedOnMachine ? `, from ${args.verifiedOnMachine}` : ''})`,
      userInitiated: false,
    });
    return true;
  }

  /** Downgrade a profile to pending-verification + drop any credential-share authorization
   *  (a key-pin mismatch on an inherited record, §3.8). Internal helper. */
  private downgradeToPending(profile: AgentTrustProfile, reason: string): void {
    const previousLevel = profile.level;
    profile.pairingState = 'pending-verification';
    profile.verifiedAt = undefined;
    profile.peerAcked = undefined;
    profile.inheritedFromMachine = undefined;
    profile.source = 'setup-default';
    // Drop credential-share authorization by clamping below trusted.
    if (this.compareTrust(profile.level, 'verified') > 0) {
      profile.level = 'verified';
      profile.allowedOperations = [...DEFAULT_ALLOWED_OPS.verified];
    }
    profile.updatedAt = new Date().toISOString();
    this.save();
    this.writeAudit({
      timestamp: new Date().toISOString(),
      agent: profile.agent,
      previousLevel,
      newLevel: profile.level,
      source: 'system',
      reason,
      userInitiated: false,
    });
  }

  /**
   * Whether `credential-share` is allowed for a peer (by fingerprint).
   * TRUE iff trustSource === 'mutual-verified' AND level >= 'trusted' (§3.3).
   * Never granted by 'autonomous' alone, never by 'setup-default'/auto-handshake.
   */
  isCredentialShareAllowedByFingerprint(fingerprint: string): boolean {
    const profile = this.getProfileByFingerprint(fingerprint);
    return this.isCredentialShareAllowedForProfile(profile);
  }

  /**
   * Profile-level credential-share check — the IDENTITY half (shared by fingerprint +
   * name paths). TRUE iff trustSource === 'mutual-verified' AND level >= 'trusted' AND
   * the pairingState is either:
   *   - `mutual-verified` (THIS machine's operator SAS-confirmed), OR
   *   - `identity-verified` (an INHERITED, key-pinned verification from a peer machine,
   *     §3.8) — the identity key was SAS-verified by a human somewhere and pinned here.
   *
   * NOTE: the inherited `identity-verified` floor satisfies the IDENTITY half ONLY. The
   * CHANNEL half (this machine's own live encrypted+signed path — never plaintext, §3.5)
   * is enforced SEPARATELY by `evaluateOutboundCredentialShare` via `hasEncryptedSendPath`.
   * So credential-share on a machine that inherited the verification = inherited
   * identity-verified (here) AND that machine's own encrypted channel (the outbound gate).
   */
  isCredentialShareAllowedForProfile(profile: AgentTrustProfile | null): boolean {
    if (!profile) return false;
    if (profile.source !== 'mutual-verified') return false;
    if (profile.pairingState !== 'mutual-verified' && profile.pairingState !== 'identity-verified') return false;
    // level >= 'trusted'
    return this.compareTrust(profile.level, 'trusted') >= 0;
  }

  // ── Interaction Recording ───────────────────────────────────────

  /**
   * Record a successful or failed interaction with an agent.
   */
  recordInteraction(agentName: string, success: boolean, details?: string): void {
    const profile = this.getOrCreateProfile(agentName);
    const now = new Date().toISOString();

    profile.history.lastInteraction = now;

    if (success) {
      profile.history.successfulInteractions++;
      profile.history.streakSinceIncident++;
    } else {
      profile.history.failedInteractions++;
      profile.history.streakSinceIncident = 0;
    }

    profile.updatedAt = now;
    this.save();
  }

  /**
   * Record a received message from an agent.
   */
  recordMessageReceived(agentName: string): void {
    const profile = this.getOrCreateProfile(agentName);
    profile.history.messagesReceived++;
    profile.history.lastInteraction = new Date().toISOString();
    profile.updatedAt = new Date().toISOString();
    this.save();
  }

  /**
   * Record a response sent to an agent.
   */
  recordMessageResponded(agentName: string): void {
    const profile = this.getOrCreateProfile(agentName);
    profile.history.messagesResponded++;
    profile.updatedAt = new Date().toISOString();
    this.save();
  }

  // ── Permission Checking ─────────────────────────────────────────

  /**
   * Check if an agent is allowed to perform an operation.
   * Checks both trust-level defaults and explicit allowed/blocked lists.
   */
  checkPermission(agentName: string, operation: string): boolean {
    const profile = this.profiles[agentName];

    // credential-share is gated SOLELY by the mutual-verified + trusted check
    // (§3.3) — never by the level table, an explicit allowed-list entry, or an
    // unknown peer. Route it through the dedicated gate regardless of profile.
    if (operation === CREDENTIAL_SHARE_OP) {
      return this.isCredentialShareAllowedForProfile(profile ?? null);
    }

    if (!profile) {
      // Unknown agent — only allow untrusted-level operations
      return DEFAULT_ALLOWED_OPS.untrusted.includes(operation);
    }

    // Explicitly blocked operations always take precedence
    if (profile.blockedOperations.includes(operation)) {
      return false;
    }

    // Check explicit allowed list
    if (profile.allowedOperations.includes(operation)) {
      return true;
    }

    // Fall back to trust level defaults
    return DEFAULT_ALLOWED_OPS[profile.level].includes(operation);
  }

  // ── Interaction Stats ───────────────────────────────────────────

  /**
   * Get interaction statistics for an agent.
   */
  getInteractionStats(agentName: string): InteractionStats | null {
    const profile = this.profiles[agentName];
    if (!profile) return null;

    const h = profile.history;
    const total = h.successfulInteractions + h.failedInteractions;

    return {
      messagesReceived: h.messagesReceived,
      messagesResponded: h.messagesResponded,
      successfulInteractions: h.successfulInteractions,
      failedInteractions: h.failedInteractions,
      successRate: total > 0 ? h.successfulInteractions / total : 0,
      streakSinceIncident: h.streakSinceIncident,
      lastInteraction: h.lastInteraction || null,
    };
  }

  // ── Auto-Downgrade ──────────────────────────────────────────────

  /**
   * Safety-only auto-downgrade. Never auto-upgrades.
   * Called by CircuitBreaker (3 activations in 24h) or on crypto failure.
   */
  autoDowngrade(agentName: string, reason: string): boolean {
    const profile = this.profiles[agentName];
    if (!profile) return false;

    const previousLevel = profile.level;
    if (previousLevel === 'untrusted') return false; // Already at lowest

    profile.level = 'untrusted';
    profile.updatedAt = new Date().toISOString();
    profile.allowedOperations = [...DEFAULT_ALLOWED_OPS.untrusted];

    this.save();
    this.writeAudit({
      timestamp: new Date().toISOString(),
      agent: agentName,
      previousLevel,
      newLevel: 'untrusted',
      source: 'system',
      reason,
      userInitiated: false,
    });

    if (this.onTrustChange) {
      this.onTrustChange({
        agent: agentName,
        previousLevel,
        newLevel: 'untrusted',
        reason,
        userInitiated: false,
      });
    }

    return true;
  }

  /**
   * Check for staleness-based auto-downgrade.
   * If an agent hasn't interacted in 90 days, downgrade one level.
   * Returns true if a downgrade occurred.
   */
  checkStalenessDowngrade(agentName: string, nowMs?: number): boolean {
    const profile = this.profiles[agentName];
    if (!profile) return false;
    if (profile.level === 'untrusted') return false;

    const now = nowMs ?? Date.now();
    const lastInteraction = profile.history.lastInteraction;
    if (!lastInteraction) return false;

    const elapsed = now - new Date(lastInteraction).getTime();
    if (elapsed < STALENESS_THRESHOLD_MS) return false;

    const previousLevel = profile.level;
    const currentIdx = TRUST_ORDER.indexOf(previousLevel);
    if (currentIdx <= 0) return false;

    const newLevel = TRUST_ORDER[currentIdx - 1];
    profile.level = newLevel;
    profile.updatedAt = new Date().toISOString();
    profile.allowedOperations = [...DEFAULT_ALLOWED_OPS[newLevel]];

    this.save();
    this.writeAudit({
      timestamp: new Date().toISOString(),
      agent: agentName,
      previousLevel,
      newLevel,
      source: 'system',
      reason: `No interaction for ${Math.floor(elapsed / (24 * 60 * 60 * 1000))} days — auto-downgrade`,
      userInitiated: false,
    });

    if (this.onTrustChange) {
      this.onTrustChange({
        agent: agentName,
        previousLevel,
        newLevel,
        reason: `Staleness auto-downgrade after ${Math.floor(elapsed / (24 * 60 * 60 * 1000))} days`,
        userInitiated: false,
      });
    }

    return true;
  }

  // ── Profile Listing ─────────────────────────────────────────────

  /**
   * List all trust profiles, optionally filtered by trust level.
   */
  listProfiles(filter?: { level?: AgentTrustLevel; source?: AgentTrustSource }): AgentTrustProfile[] {
    let profiles = Object.values(this.profiles);

    if (filter?.level) {
      profiles = profiles.filter(p => p.level === filter.level);
    }
    if (filter?.source) {
      profiles = profiles.filter(p => p.source === filter.source);
    }

    return profiles;
  }

  // ── Blocked Operations ──────────────────────────────────────────

  /**
   * Block a specific operation for an agent.
   */
  blockOperation(agentName: string, operation: string): void {
    const profile = this.getOrCreateProfile(agentName);
    if (!profile.blockedOperations.includes(operation)) {
      profile.blockedOperations.push(operation);
      profile.updatedAt = new Date().toISOString();
      this.save();
    }
  }

  /**
   * Unblock a specific operation for an agent.
   */
  unblockOperation(agentName: string, operation: string): void {
    const profile = this.getOrCreateProfile(agentName);
    profile.blockedOperations = profile.blockedOperations.filter(op => op !== operation);
    profile.updatedAt = new Date().toISOString();
    this.save();
  }

  // ── Audit Trail ─────────────────────────────────────────────────

  /**
   * Read audit trail entries. Returns all entries or last N entries.
   */
  readAuditTrail(limit?: number): TrustAuditEntry[] {
    try {
      if (!fs.existsSync(this.auditPath)) return [];
      const content = fs.readFileSync(this.auditPath, 'utf-8').trim();
      if (!content) return [];

      const entries = content.split('\n').map(line => {
        try { return JSON.parse(line) as TrustAuditEntry; }
        catch { return null; }
      }).filter((e): e is TrustAuditEntry => e !== null);

      if (limit && limit > 0) {
        return entries.slice(-limit);
      }
      return entries;
    } catch {
      return [];
    }
  }

  // ── Persistence ─────────────────────────────────────────────────

  /**
   * Force reload profiles from disk.
   */
  reload(): void {
    this.profiles = this.loadProfiles();
  }

  /**
   * Flush any pending saves and stop the debounce timer.
   * Call on shutdown for clean exit.
   */
  flush(): void {
    if (this.saveDirty) {
      this.save();
      this.saveDirty = false;
    }
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }
  }

  // ── Private ─────────────────────────────────────────────────────

  /**
   * Schedule a debounced save (dirty-flag + interval flush).
   * Avoids synchronous disk writes on every message received.
   */
  private scheduleSave(): void {
    this.saveDirty = true;
    if (!this.saveTimer) {
      this.saveTimer = setInterval(() => {
        if (this.saveDirty) {
          this.save();
          this.saveDirty = false;
        }
      }, 5000); // Flush every 5 seconds
      // Don't keep process alive just for this timer
      if (this.saveTimer.unref) this.saveTimer.unref();
    }
  }

  private loadProfiles(): Record<string, AgentTrustProfile> {
    const data = safeJsonParse<ProfilesFile>(this.profilesPath, {
      profiles: {},
      updatedAt: '',
    });
    return data.profiles;
  }

  private save(): void {
    try {
      const data: ProfilesFile = {
        profiles: this.profiles,
        updatedAt: new Date().toISOString(),
      };
      atomicWrite(this.profilesPath, JSON.stringify(data, null, 2));
    } catch {
      // Save failure should never break trust evaluation
    }
  }

  private writeAudit(entry: TrustAuditEntry): void {
    try {
      fs.appendFileSync(this.auditPath, JSON.stringify(entry) + '\n');
    } catch {
      // Audit failure should not break operations
    }
  }

  private compareTrust(a: AgentTrustLevel, b: AgentTrustLevel): number {
    return TRUST_ORDER.indexOf(a) - TRUST_ORDER.indexOf(b);
  }
}
