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
import { deriveSASv2, deriveSasBitsV2, deriveSasFingerprintV2, derivePairingIdV2 } from './ThreadlineCrypto.js';
import { isAcceptableIdentityKey, type InviteTrust } from '@sagemindai/threadline-core';
import { earliestMark } from './encryptedSeenMark.js';

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
export type PairingState =
  | 'pending-verification'
  | 'mutual-verified'
  | 'verification-failed'
  | 'identity-verified'
  /**
   * Invite flow (docs/specs/a2a-pairing-invite-link.md §4.3–4.4): this side approved an
   * invite and pinned the peer's key, but the pairing is not finished (or was paused by a
   * second accept). NOT credential-eligible.
   */
  | 'invite-accepted';

/** How a pinned identity key was verified (spec threadline-standalone-pairing D9). */
export type PairingMethod = 'invite' | 'sas' | 'inherited';

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
  /**
   * Set when the relay unknown-sender path wrote this profile on a first contact
   * while its trust check was observing (docs/specs/a2a-relay-unknown-sender-trust.md).
   * While `source` is still `setup-default`, that check treats the profile as
   * absent: a first contact is not a grant. Absent on every other profile.
   */
  relayFirstContact?: boolean;

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
  /**
   * HOW the pinned key was verified (docs/specs/threadline-standalone-pairing.md D9):
   * `invite` (invite-link pairing), `sas` (operator SAS comparison) or `inherited` (a
   * replicated result from another of this agent's machines whose record carried no
   * method). An inherited pairing whose record DID carry a method stores that method
   * (`invite` | `sas`, rollout step 5b), so D9 applies on every machine that holds the
   * same pinned key. D9's encrypt-to-pinned rule applies only to `invite`. Profiles from before this field are backfilled on load:
   * a `mutual-verified` profile gets `sas` when it holds a sasFingerprint, else `invite`.
   */
  pairingMethod?: PairingMethod;
  /** When this side's operator SAS-confirmed the peer (ISO-8601). */
  verifiedAt?: string;
  /** Optional liveness flag (FD8): a signature-verified inbound peer receipt arrived. */
  peerAcked?: boolean;
  /** When the current pairing was recorded on THIS machine (ISO-8601). Receipts older
   *  than this (minus clock skew) are stale (FD4 v2: the SAS no longer changes per handshake). */
  pairingRecordedAt?: string;
  /** When the pairingState is `identity-verified` (§3.8), the machine id whose operator
   *  SAS-compared (carried by the replicated record). Audit/observability only. */
  inheritedFromMachine?: string;
  /**
   * Set when an invite pairing was paused because its invite was used twice (spec
   * a2a-pairing-invite-link §4.4.2): the reason given at the pause. Exposed to the invite engine
   * as `via: "paused: <reason>"`, so a late Finish cannot re-promote the pin
   * (threadline-standalone-pairing step 3 follow-up). Cleared only by markInviteVerified.
   */
  invitePausedReason?: string;
  /** When the pause was recorded (ISO-8601). An inherited verification ends the pause only if it is later. */
  invitePausedAt?: string;
  /** Read-only view for threadline-core's InviteTrust: `paused: <reason>` while paused. */
  readonly via?: string;
  /**
   * When this peer first sent us ENCRYPTED ordinary chat (docs/specs/threadline-standalone-pairing.md
   * D6/D11, rollout step 6). Bound to `peerIdentityPub`: it is dropped whenever the pinned key
   * changes. Set once, merged with the agent's other machines as a union keeping the earliest
   * time, and removed only when the person unpairs (markVerificationFailed) or the inherited pin
   * it belongs to is forgotten. While `threadline.refuseDowngrade` enforces, plaintext under this
   * peer's fingerprint is refused.
   */
  encryptedSeenAt?: string;
}

/**
 * SEC-16 (spec threadline-standalone-pairing D8): a key that is small-order or not canonical is
 * refused when pinning. Hex in, so every pinning path can share it.
 */
function isPinnableIdentityKeyHex(hex: string | undefined): boolean {
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) return false;
  return isAcceptableIdentityKey(Buffer.from(hex, 'hex'));
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
    /** How the peer was paired (D9/D11, the optional sixth field): 'invite' | 'sas'. */
    pairingMethod?: 'invite' | 'sas';
  }): void;
  /** Emit a `delete` tombstone for a revoked / verification-failed pairing (un-verify
   *  sticks pool-wide), keyed on the peer fingerprint. */
  emitRevoke(peerFp: string, deletedAt: string, peerIdentityPub?: string): void;
  /** Rollout step 6 (D11): this machine recorded the encryptedSeen mark for this pinned key. */
  emitEncryptedSeen?(peerFp: string, peerIdentityPub: string, at: string): void;
  /** Rollout step 6 (D11): the person unpaired here, so every earlier mark for this key is void. */
  emitEncryptedSeenUnpaired?(peerFp: string, peerIdentityPub: string | undefined, at: string): void;
}

export interface InteractionStats {
  messagesReceived: number;
  messagesResponded: number;
  successfulInteractions: number;
  failedInteractions: number;
  successRate: number | null;
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

export class AgentTrustManager implements InviteTrust {
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
  /**
   * Live reader: the level a NEW fingerprint profile is created at
   * (docs/specs/a2a-relay-unknown-sender-trust.md). Absent ⇒ `verified`, today's
   * behaviour byte-for-byte.
   */
  private readonly newFingerprintProfileLevel: (() => AgentTrustLevel) | null;
  /** Told the level of every fingerprint profile this manager creates (counters only). */
  private readonly onFingerprintProfileCreated: ((level: AgentTrustLevel) => void) | null;

  constructor(options: {
    stateDir: string;
    onTrustChange?: TrustChangeCallback;
    /** This machine's id, stamped into a replicated verified-identity result (§3.8). */
    machineId?: string;
    /**
     * The level a new fingerprint profile is created at, read per creation.
     * Absent ⇒ `verified`. Only `verified` or `untrusted` are honoured; any other
     * answer (or a throw) falls back to `verified`, so this can only ever LOWER
     * the default, never raise it.
     */
    newFingerprintProfileLevel?: () => AgentTrustLevel;
    onFingerprintProfileCreated?: (level: AgentTrustLevel) => void;
  }) {
    this.newFingerprintProfileLevel = options.newFingerprintProfileLevel ?? null;
    this.onFingerprintProfileCreated = options.onFingerprintProfileCreated ?? null;
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
        return withPausedVia(profile);
      }
    }
    return null;
  }

  /**
   * Get or create a trust profile keyed by fingerprint.
   * For relay agents, the fingerprint IS the identity.
   * New profiles default to 'verified' (can send messages); while the relay
   * unknown-sender check is enforcing they start 'untrusted' (probes only) —
   * the relay proves key possession, not identity
   * (docs/specs/a2a-relay-unknown-sender-trust.md).
   *
   * IMPORTANT: Always keys by fingerprint to avoid collisions between
   * same-named agents on different machines. Display name is stored in
   * the profile's `agent` field for human readability.
   */
  getOrCreateProfileByFingerprint(
    fingerprint: string,
    displayName?: string,
    /** Stamp a NEW profile as a relay first contact in its first (atomic) write. */
    createOpts?: { relayFirstContact?: boolean },
  ): AgentTrustProfile {
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

    // Create new profile keyed by fingerprint to prevent same-name collisions.
    // The level is `verified` unless the relay unknown-sender check is enforcing
    // (a first contact proves key possession, not a grant) — then `untrusted`.
    let level: AgentTrustLevel = 'verified';
    if (this.newFingerprintProfileLevel) {
      try {
        if (this.newFingerprintProfileLevel() === 'untrusted') level = 'untrusted';
      } catch { /* @silent-fallback-ok — an unreadable mode keeps today's default */ }
    }
    const now = new Date().toISOString();
    this.profiles[fingerprint] = {
      agent: displayName ?? fingerprint,
      fingerprint,
      level,
      source: 'setup-default',
      history: {
        messagesReceived: 0,
        messagesResponded: 0,
        successfulInteractions: 0,
        failedInteractions: 0,
        lastInteraction: '',
        streakSinceIncident: 0,
      },
      allowedOperations: [...DEFAULT_ALLOWED_OPS[level]],
      blockedOperations: [],
      createdAt: now,
      updatedAt: now,
      ...(createOpts?.relayFirstContact ? { relayFirstContact: true } : {}),
    };
    this.save();
    try { this.onFingerprintProfileCreated?.(level); } catch { /* @silent-fallback-ok — counters never break trust */ }
    return this.profiles[fingerprint];
  }

  /**
   * Get trust level by fingerprint. Returns 'untrusted' for unknown agents.
   */
  getTrustLevelByFingerprint(fingerprint: string): AgentTrustLevel {
    const profile = this.getProfileByFingerprint(fingerprint);
    if (profile && this.isUngrantedFirstContact(profile)) return 'untrusted';
    return profile?.level ?? 'untrusted';
  }

  /**
   * A profile the relay unknown-sender path wrote at first contact while its
   * check was observing, never since decided by anyone (source still
   * `setup-default`). While that check ENFORCES, it counts as no grant on every
   * path — the relay gate included — so a soak period hands out nothing that
   * outlives it (docs/specs/a2a-relay-unknown-sender-trust.md).
   */
  private isUngrantedFirstContact(profile: AgentTrustProfile): boolean {
    if (!profile.relayFirstContact || profile.source !== 'setup-default' || !this.newFingerprintProfileLevel) return false;
    try {
      return this.newFingerprintProfileLevel() === 'untrusted';
    } catch {
      return false; // @silent-fallback-ok — an unreadable mode keeps today's answer
    }
  }

  /**
   * Get allowed operations by fingerprint.
   */
  getAllowedOperationsByFingerprint(fingerprint: string): string[] {
    const profile = this.getProfileByFingerprint(fingerprint);
    if (!profile || this.isUngrantedFirstContact(profile)) return [...DEFAULT_ALLOWED_OPS.untrusted];
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
    if (!isPinnableIdentityKeyHex(args.peerIdentityPub)) return false; // SEC-16

    const profile = this.getOrCreateProfileByFingerprint(peerFp, args.displayName);
    const now = new Date().toISOString();

    // A new pairingId is a new handshake epoch → reset to pending + clear prior confirm.
    profile.pairingState = 'pending-verification';
    profile.pairingId = args.pairingId;
    if (profile.peerIdentityPub !== args.peerIdentityPub) profile.encryptedSeenAt = undefined; // the mark belongs to its pin
    profile.peerIdentityPub = args.peerIdentityPub;
    profile.sasFingerprint = args.sasFingerprint;
    profile.pairingMethod = 'sas';
    profile.verifiedAt = undefined;
    profile.peerAcked = undefined;
    profile.pairingRecordedAt = now;
    profile.updatedAt = now;
    // A pairing back at pending is no longer verified, so it must not keep the
    // credential-authorizing source (Echo's second review, item 2). The trust LEVEL is left
    // alone: an operator may have set it independently, and credentials are gated on the
    // source and the pairing state, not on the level.
    if (profile.source === 'mutual-verified') profile.source = 'setup-default';

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
    profile.pairingMethod = 'sas';
    profile.verifiedAt = now;
    profile.invitePausedReason = undefined; // an operator's 12-word confirm also ends a pause
    profile.invitePausedAt = undefined;
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
          pairingMethod: 'sas',
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
   * Start (or re-check) a v2 static-key pairing with a peer (spec §3.2, FD4 v2).
   *
   * Both sides call this independently with the two Ed25519 identity keys; the 12 SAS
   * words are a function of those keys alone, so no round trip is needed. The pairingId
   * identifies the KEY PAIR, so it changes exactly when either key rotates. Rules:
   *  - a changed pairingId (either key rotated, or first time) → pending-verification;
   *  - same pairingId and already mutual/identity-verified → unchanged ('already-verified');
   *  - same pairingId and verification-failed → refused unless `clearFailed` (an
   *    operator-PIN-gated clear at the route): a denied match must NOT silently return to
   *    pending, because the same static words would be shown again (spec §3.2);
   *  - same pairingId and pending → unchanged ('already-pending'), re-recording the
   *    machine-local words if they were lost (e.g. the 0600 store was cleared).
   * The peer fingerprint must be the first 16 bytes of the supplied peer key.
   */
  startStaticPairing(
    peerFp: string,
    args: { ownIdentityPub: Buffer; peerIdentityPub: Buffer; ownFp: string; displayName?: string; clearFailed?: boolean },
  ):
    | { outcome: 'started' | 'already-pending' | 'already-verified'; pairingId: string; sasFingerprint: string }
    | { outcome: 'self-pair' | 'fingerprint-mismatch' | 'refused-failed' | 'unacceptable-key' } {
    const fp = (peerFp || '').toLowerCase();
    if (!fp || fp === (args.ownFp || '').toLowerCase()) return { outcome: 'self-pair' };
    if (args.peerIdentityPub.length !== 32 || args.peerIdentityPub.subarray(0, 16).toString('hex') !== fp) {
      return { outcome: 'fingerprint-mismatch' };
    }
    if (!isAcceptableIdentityKey(args.peerIdentityPub)) return { outcome: 'unacceptable-key' };
    const pairingId = derivePairingIdV2(args.ownIdentityPub, args.peerIdentityPub);
    const sasBits = deriveSasBitsV2(args.ownIdentityPub, args.peerIdentityPub);
    const sasFingerprint = deriveSasFingerprintV2(sasBits);
    const peerPubHex = args.peerIdentityPub.toString('hex');

    const existing = this.getProfileByFingerprint(fp);
    // A denied match stays denied WHATEVER the pairingId (spec §3.2): only an operator
    // PIN clear (`clearFailed`, checked at the route) reopens it. A changed pairingId
    // (our key rotated) must not be a back door to pending.
    if (existing?.pairingState === 'verification-failed' && !args.clearFailed) {
      return { outcome: 'refused-failed' };
    }
    // An inherited pairing (§3.8) has no local pairingId; it binds on the pinned key.
    // A start for the same key leaves it identity-verified rather than demoting it.
    if (existing?.pairingState === 'identity-verified' && existing.peerIdentityPub === peerPubHex) {
      return { outcome: 'already-verified', pairingId, sasFingerprint };
    }
    const samePair = !!existing && existing.pairingId === pairingId && existing.peerIdentityPub === peerPubHex;
    if (existing && samePair) {
      if (existing.pairingState === 'mutual-verified') {
        return { outcome: 'already-verified', pairingId, sasFingerprint };
      }
      if (existing.pairingState === 'pending-verification' && this.pendingStore.get(fp)) {
        return { outcome: 'already-pending', pairingId, sasFingerprint };
      }
    }
    const recorded = this.recordPendingVerification(fp, {
      pairingId,
      peerIdentityPub: peerPubHex,
      sasWords: deriveSASv2(args.ownIdentityPub, args.peerIdentityPub),
      sasFingerprint,
      ownFp: args.ownFp,
      displayName: args.displayName,
    });
    if (!recorded) return { outcome: 'self-pair' };
    return { outcome: 'started', pairingId, sasFingerprint };
  }

  /**
   * Mark a pairing 'verification-failed' (operator-asserted SAS mismatch, §3.2).
   * Forces the peer to 'untrusted', clears the mutual-verified source, and
   * discards the pending SAS store. NOT used for a missing-receipt timeout
   * (that simply stays 'pending-verification').
   */
  // ── Invite flow (docs/specs/a2a-pairing-invite-link.md) ─────────────────────

  /**
   * B side, after its operator approved an invite: pin the inviter's identity key in state
   * `invite-accepted`. Not credential-eligible until the inviter finishes (markInviteVerified).
   * Never downgrades an existing verified pairing for the SAME key.
   */
  recordInviteAccepted(peerFp: string, args: { peerIdentityPub: string; displayName?: string; ownFp?: string }): boolean {
    const fp = String(peerFp || '').toLowerCase();
    const key = String(args.peerIdentityPub || '').toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(fp) || !/^[0-9a-f]{64}$/.test(key) || key.slice(0, 32) !== fp) return false;
    if (args.ownFp && fp === args.ownFp.toLowerCase()) return false; // self-pair
    if (!isPinnableIdentityKeyHex(key)) return false; // SEC-16
    const profile = this.getOrCreateProfileByFingerprint(fp, args.displayName);
    if ((profile.pairingState === 'mutual-verified' || profile.pairingState === 'identity-verified') && profile.peerIdentityPub === key) {
      return true; // already verified for this exact key
    }
    const now = new Date().toISOString();
    profile.pairingState = 'invite-accepted';
    if (profile.peerIdentityPub !== key) profile.encryptedSeenAt = undefined; // the mark belongs to its pin
    profile.peerIdentityPub = key;
    // The operator approved a NEW invite from this peer: that is the re-confirmation a pause
    // waits for (a2a-pairing-invite-link §4.4.2), so the new invite's Finish may complete.
    profile.invitePausedReason = undefined;
    profile.invitePausedAt = undefined;
    profile.pairingId = undefined;
    profile.sasFingerprint = undefined;
    profile.pairingMethod = 'invite';
    profile.verifiedAt = undefined;
    profile.peerAcked = undefined;
    profile.pairingRecordedAt = now;
    if (profile.source === 'mutual-verified') profile.source = 'setup-default';
    profile.updatedAt = now;
    this.save();
    return true;
  }

  /**
   * Either side, when the invite flow completes (A on its operator's Finish; B on a valid
   * signed finish): pin the key and mark `mutual-verified`. Same write order and effects as
   * markMutualVerified (record first, level raised to trusted, source LAST, replication).
   */
  markInviteVerified(
    peerFp: string,
    args: { peerIdentityPub: string; displayName?: string; ownFp?: string; via: string; ownIdentityPub?: string },
  ): boolean {
    const fp = String(peerFp || '').toLowerCase();
    const key = String(args.peerIdentityPub || '').toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(fp) || !/^[0-9a-f]{64}$/.test(key) || key.slice(0, 32) !== fp) return false;
    if (args.ownFp && fp === args.ownFp.toLowerCase()) return false;
    if (!isPinnableIdentityKeyHex(key)) return false; // SEC-16
    const profile = this.getOrCreateProfileByFingerprint(fp, args.displayName);
    // A pinned key may only be replaced by re-pairing: never silently swap keys here.
    if (profile.peerIdentityPub && profile.peerIdentityPub !== key && profile.pairingState !== 'verification-failed' && profile.pairingState !== undefined) {
      return false;
    }
    const previousLevel = profile.level;
    const now = new Date().toISOString();
    profile.pairingState = 'mutual-verified';
    if (profile.peerIdentityPub !== key) profile.encryptedSeenAt = undefined; // the mark belongs to its pin
    profile.peerIdentityPub = key;
    profile.invitePausedReason = undefined; // a completed pairing ends a pause
    profile.invitePausedAt = undefined;
    // The same pairingId v2 uses (HKDF over the two identity keys), so the credential gate can
    // check our own key has not rotated since verification (CredentialShareGate check 3).
    profile.pairingId = args.ownIdentityPub
      ? derivePairingIdV2(Buffer.from(args.ownIdentityPub, 'hex'), Buffer.from(key, 'hex'))
      : undefined;
    profile.sasFingerprint = undefined;
    profile.pairingMethod = 'invite';
    profile.verifiedAt = now;
    if (this.compareTrust(profile.level, 'trusted') < 0) profile.level = 'trusted';
    profile.allowedOperations = [...DEFAULT_ALLOWED_OPS[profile.level]];
    profile.source = 'mutual-verified'; // LAST: the credential-share authorization bit
    profile.updatedAt = now;
    this.save();
    if (this.pairingReplication) {
      try {
        this.pairingReplication.emitVerified({ peerFp: fp, peerIdentityPub: key, verifiedAt: now, verifiedOnMachine: this.machineId, pairingMethod: 'invite' });
      } catch { /* replication failure never breaks the local trust write */ }
    }
    this.writeAudit({
      timestamp: now, agent: profile.agent, previousLevel, newLevel: profile.level, source: 'mutual-verified',
      reason: `Invite pairing completed (${args.via})`, userInitiated: true,
    });
    if (this.onTrustChange) {
      this.onTrustChange({ agent: profile.agent, previousLevel, newLevel: profile.level, reason: 'Invite pairing completed', userInitiated: true });
    }
    return true;
  }

  /**
   * A second valid accept arrived for an invite this agent already used (spec §4.4.2): pause
   * the first acceptor. Back to `invite-accepted`, credential-ineligible, until the operator
   * re-confirms. Applies whatever the timing, including after Finish. Revokes any replicated
   * copy so other machines stop honouring it too.
   */
  demoteInvitePairing(peerFp: string, reason: string): boolean {
    const fp = String(peerFp || '').toLowerCase();
    const profile = this.getProfileByFingerprint(fp);
    if (!profile || !profile.pairingState) return false;
    const previousLevel = profile.level;
    const now = new Date().toISOString();
    profile.pairingState = 'invite-accepted';
    profile.verifiedAt = undefined;
    profile.invitePausedReason = String(reason || 'invite used twice');
    profile.invitePausedAt = now;
    if (profile.source === 'mutual-verified') profile.source = 'setup-default';
    profile.updatedAt = now;
    this.save();
    if (this.pairingReplication) {
      try { this.pairingReplication.emitRevoke(fp, now, profile.peerIdentityPub); } catch { /* best effort */ }
    }
    this.writeAudit({
      timestamp: now, agent: profile.agent, previousLevel, newLevel: profile.level, source: 'setup-default',
      reason: `Invite pairing paused: ${reason}`, userInitiated: false,
    });
    return true;
  }

  markVerificationFailed(peerFp: string, reason: string): boolean {
    const profile = this.getProfileByFingerprint(peerFp);
    if (!profile) return false;

    const previousLevel = profile.level;
    const now = new Date().toISOString();

    profile.pairingState = 'verification-failed';
    profile.verifiedAt = undefined;
    profile.peerAcked = undefined;
    // The person unpaired (D8/D11): the encryptedSeen mark goes with the pairing, here and, through
    // the replicated unpair record, on every other machine of this agent.
    profile.encryptedSeenAt = undefined;
    profile.level = 'untrusted';
    profile.source = 'setup-default';
    profile.allowedOperations = [...DEFAULT_ALLOWED_OPS.untrusted];
    profile.updatedAt = now;

    this.save();
    this.pendingStore.discard(peerFp);

    // §3.8 — propagate the un-verify as a TOMBSTONE so it sticks pool-wide (even on a
    // peer machine that was offline at revoke time). Best-effort; never throws out.
    if (this.pairingReplication) {
      try { this.pairingReplication.emitRevoke(peerFp, now, profile.peerIdentityPub); }
      catch { /* replication failure never breaks the local trust write */ }
      // Always sent (not only when THIS machine held a mark): another machine may hold one.
      try { this.pairingReplication.emitEncryptedSeenUnpaired?.(peerFp, profile.peerIdentityPub, now); }
      catch { /* best effort */ }
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
    args: {
      peerIdentityPub: string;
      verifiedAt?: string;
      verifiedOnMachine?: string;
      presentedIdentityPub?: string;
      displayName?: string;
      /** The replicated method (D9/D11). 'invite' | 'sas' is stored as-is so the
       *  encrypt-to-pinned resolver applies D9 here with the same pinned key; absent or
       *  unknown is stored as 'inherited' (treated as not-invite). */
      pairingMethod?: 'invite' | 'sas';
    },
  ): boolean {
    if (!peerFp || !args.peerIdentityPub) return false;
    if (!isPinnableIdentityKeyHex(args.peerIdentityPub)) return false; // SEC-16

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

    // Never downgrade a known 'invite' for the SAME pinned key (D11 mixed versions): the
    // method is the peer's capability, and a record from an older machine without the field
    // says nothing new about it. A different key starts over.
    const sameKey = !!profile.peerIdentityPub && profile.peerIdentityPub.toLowerCase() === args.peerIdentityPub.toLowerCase();
    const keepInvite = sameKey && profile.pairingState === 'identity-verified' && profile.pairingMethod === 'invite';
    const method: PairingMethod = args.pairingMethod === 'invite' || args.pairingMethod === 'sas' ? args.pairingMethod : 'inherited';

    profile.pairingState = 'identity-verified';
    profile.pairingMethod = keepInvite ? 'invite' : method;
    if (!sameKey) profile.encryptedSeenAt = undefined; // the mark belongs to its pin
    profile.peerIdentityPub = args.peerIdentityPub.toLowerCase(); // stored lowercase, as every other pin path compares it (Echo, step 6 review)
    // An inherited verification ends a pause only if it is an operator's confirm made AFTER the
    // pause: its verifiedAt must be present and strictly later than this machine's recorded
    // invitePausedAt. The revoke tombstone a demote sends is best-effort, and the replicated store
    // can hold a concurrent put and tombstone as two versions, so an older put can still arrive
    // here; this local timestamp check, not the tombstone, is what keeps it from clearing the pause
    // (Echo's review of #2230). Otherwise the key is pinned as before and the pause stays.
    // Times are compared with Date.parse; a missing or unparsable time counts as not later. verifiedAt
    // comes from the other machine's clock: if that clock runs behind, a genuinely newer confirm can
    // look older and the pause stays. That is the safe direction and is deliberately not "fixed".
    if (profile.invitePausedReason !== undefined && isLaterThan(args.verifiedAt, profile.invitePausedAt)) {
      profile.invitePausedReason = undefined;
      profile.invitePausedAt = undefined;
    }
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

  /**
   * Upgrade migration (D11, rollout step 5b): re-send the replicated record of every LOCAL
   * invite-paired, mutual-verified profile so its `pairingMethod` reaches the agent's other
   * machines (records sent before the sixth field existed carry none). The emitter stamps a
   * fresh HLC, so the re-sent record supersedes the old one; `verifiedAt` stays the original
   * verification time. Only runs with the replication emitter attached (the
   * `multiMachine.stateSync.threadlinePairing.enabled` gate). Idempotent through
   * `alreadyPublished`, which the caller answers from THIS machine's own replicated stream
   * (a record for that key already carrying 'invite' ⇒ skip). Inherited profiles never
   * re-send. Returns the number of records emitted.
   */
  republishInvitePairingMethods(alreadyPublished: (peerFp: string, peerIdentityPub: string) => boolean): number {
    if (!this.pairingReplication) return 0;
    let sent = 0;
    for (const profile of Object.values(this.profiles)) {
      const fp = profile.fingerprint;
      const key = profile.peerIdentityPub;
      if (!fp || !key) continue;
      if (profile.pairingState !== 'mutual-verified' || profile.source !== 'mutual-verified' || profile.pairingMethod !== 'invite') continue;
      let published = false;
      try { published = alreadyPublished(fp, key); } catch { published = false; }
      if (published) continue;
      try {
        this.pairingReplication.emitVerified({
          peerFp: fp,
          peerIdentityPub: key,
          verifiedAt: profile.verifiedAt ?? new Date().toISOString(),
          verifiedOnMachine: this.machineId,
          pairingMethod: 'invite',
        });
        sent++;
      } catch { /* replication failure never breaks anything local */ }
    }
    return sent;
  }

  /**
   * A replicated REVOKE for an inherited pairing (step 5b): the person unpaired on another
   * of this agent's machines. Acts ONLY on an `identity-verified` profile — the state only
   * inheritance sets — so a pairing established on THIS machine is never touched. When
   * `revokedKeys` names keys, the profile must be pinned to one of them (a revoke for key K
   * never touches a pin to another key); `unkeyed` (a tombstone from a machine that does
   * not send the key) applies to the fingerprint.
   *
   * The inherited pin is FORGOTTEN, not marked verification-failed: the pairing state,
   * method, pinned key and verification fields are cleared, the trust source goes back to
   * setup-default and the level is clamped to `verified` (the same clamp as
   * downgradeToPending), so credential-share and encrypt-to-pinned stop for the peer. A
   * later, newer replicated record can be inherited again. Emits nothing (the revoke is
   * already replicated). Returns true iff the profile was changed.
   */
  revokeInheritedVerification(
    peerFp: string,
    revoke: { keys: ReadonlySet<string>; unkeyed: boolean },
    reason = 'replicated revoke',
  ): boolean {
    const profile = this.getProfileByFingerprint(String(peerFp || '').toLowerCase()) ?? this.getProfileByFingerprint(peerFp);
    if (!profile || profile.pairingState !== 'identity-verified') return false;
    const pinned = profile.peerIdentityPub?.toLowerCase();
    if (!revoke.unkeyed && (!pinned || !revoke.keys.has(pinned))) return false;
    const previousLevel = profile.level;
    const now = new Date().toISOString();
    profile.pairingState = undefined;
    profile.pairingMethod = undefined;
    profile.peerIdentityPub = undefined;
    profile.verifiedAt = undefined;
    profile.peerAcked = undefined;
    profile.inheritedFromMachine = undefined;
    // The mark lives with the pin. If a newer record re-pins the same key, the merge pass
    // restores the mark from the replicated mark records (unless the person unpaired since).
    profile.encryptedSeenAt = undefined;
    profile.source = 'setup-default';
    if (this.compareTrust(profile.level, 'verified') > 0) profile.level = 'verified';
    profile.allowedOperations = [...DEFAULT_ALLOWED_OPS[profile.level]];
    profile.updatedAt = now;
    this.save();
    this.writeAudit({
      timestamp: now, agent: profile.agent, previousLevel, newLevel: profile.level, source: 'system',
      reason: `Inherited pairing revoked (${reason})`, userInitiated: false,
    });
    return true;
  }

  /**
   * Rollout step 6 (D6/D11): this peer sent us ENCRYPTED ordinary chat, verified against
   * `peerIdentityPub`. Set once: an existing mark is never moved. Only for a pinned peer whose
   * pinned key is exactly that key. Replicated to this agent's other machines as a mark record
   * (best effort). Returns true when the mark is now set (newly or already).
   */
  markEncryptedSeen(peerFp: string, peerIdentityPub: string): boolean {
    const profile = this.getProfileByFingerprint(String(peerFp || '').toLowerCase());
    const key = String(peerIdentityPub || '').toLowerCase();
    if (!profile?.peerIdentityPub || profile.peerIdentityPub.toLowerCase() !== key || !profile.fingerprint) return false;
    if (profile.encryptedSeenAt) return true;
    const now = new Date().toISOString();
    profile.encryptedSeenAt = now;
    profile.updatedAt = now;
    this.save();
    if (this.pairingReplication) {
      try { this.pairingReplication.emitEncryptedSeen?.(profile.fingerprint, key, now); }
      catch { /* replication failure never breaks the local write */ }
    }
    return true;
  }

  /**
   * Rollout step 6 (D11): fold in the unified mark another machine recorded for this peer — a
   * union keeping the earliest time. Applies only when `peerIdentityPub` is the key pinned here.
   * Never clears and never moves a mark later. Emits nothing (it is already replicated). Returns
   * true when the stored mark changed.
   */
  mergeEncryptedSeen(peerFp: string, peerIdentityPub: string, at: string): boolean {
    const profile = this.getProfileByFingerprint(String(peerFp || '').toLowerCase());
    if (!profile?.peerIdentityPub || profile.peerIdentityPub.toLowerCase() !== String(peerIdentityPub || '').toLowerCase()) return false;
    const merged = earliestMark(profile.encryptedSeenAt, at);
    if (merged === undefined || merged === profile.encryptedSeenAt) return false;
    profile.encryptedSeenAt = merged;
    profile.updatedAt = new Date().toISOString();
    this.save();
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
      successRate: total > 0 ? h.successfulInteractions / total : null,
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
    this.pendingStore.reload();
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
    backfillPairingMethod(data.profiles);
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

/**
 * The profile as threadline-core's invite engine reads it: `via` is `paused: <reason>` while an
 * invite pairing is paused (core's handleFinish refuses a Finish then). A getter, so it is never
 * written to the trust file and always reflects the stored pause.
 */
// Core must read the profile ONLY through getProfileByFingerprint: a clone or spread drops this
// getter, so a paused pin would read as not paused and fail open.
function withPausedVia(profile: AgentTrustProfile): AgentTrustProfile {
  if (!Object.prototype.hasOwnProperty.call(profile, 'via')) {
    Object.defineProperty(profile, 'via', {
      enumerable: false,
      configurable: true,
      get(this: AgentTrustProfile) {
        return this.invitePausedReason !== undefined ? `paused: ${this.invitePausedReason}` : undefined;
      },
    });
  }
  return profile;
}

/** True only when `a` is a valid time strictly later than `b` (a valid time). Missing or unparsable → false. */
function isLaterThan(a: string | undefined, b: string | undefined): boolean {
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  return Number.isFinite(ta) && Number.isFinite(tb) && ta > tb;
}

/**
 * Backfill `pairingMethod` on profiles written before it existed (spec
 * threadline-standalone-pairing D9). Idempotent and in memory: a `mutual-verified` profile
 * with no method gets `sas` when it holds a sasFingerprint (only the SAS path sets one),
 * else `invite` (the invite path clears it). An existing value is never overwritten. The
 * field reaches disk with the next save, like every other profile field.
 * Returns the number of profiles changed.
 */
export function backfillPairingMethod(profiles: Record<string, AgentTrustProfile> | undefined | null): number {
  if (!profiles || typeof profiles !== 'object') return 0;
  let changed = 0;
  for (const p of Object.values(profiles)) {
    if (!p || typeof p !== 'object') continue;
    if (p.pairingState !== 'mutual-verified' || p.pairingMethod) continue;
    p.pairingMethod = p.sasFingerprint ? 'sas' : 'invite';
    changed++;
  }
  return changed;
}
