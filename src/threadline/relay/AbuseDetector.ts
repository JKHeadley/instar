/**
 * AbuseDetector — Pattern-based abuse detection for the relay.
 *
 * Monitors agent behavior for spam, enumeration, flooding, connection churn,
 * and oversized payload attempts. Issues temporary bans by agent fingerprint.
 *
 * Bans are by agent ID (public key fingerprint), not IP — preventing ban
 * evasion by IP rotation while avoiding collateral damage to shared IPs.
 *
 * Also implements Sybil resistance via progressive rate limiting for new agents.
 *
 * Part of Threadline Relay Phase 5.
 */

import type { AgentFingerprint } from './types.js';
import { mergeDefaults } from '../../core/mergeDefaults.js';

// ── Configuration ──────────────────────────────────────────────────

export interface AbuseDetectorConfig {
  // Spam: sending to too many unique recipients
  spamUniqueRecipientsPerMinute: number; // default 50
  spamBanDurationMs: number; // default 1 hour

  // Flooding: sustained high rate
  floodingRateMultiplier: number; // default 10 (10x normal rate)
  floodingSustainedMinutes: number; // default 5
  floodingBanDurationMs: number; // default 24 hours

  // Connection churn
  connectionChurnPerHour: number; // default 100
  connectionChurnBanDurationMs: number; // default 1 hour

  // Oversized payloads
  oversizedPayloadWarnings: number; // default 3 warnings before ban
  oversizedPayloadBanDurationMs: number; // default 1 hour

  // Sybil resistance: progressive limits for new agents
  sybilFirstHourLimit: number; // default 10 messages
  sybilSecondHourLimit: number; // default 30 messages
  sybilGraduationMs: number; // default 24 hours

  // Normal rate for flooding detection
  normalRatePerMinute: number; // default 60
}

export interface BanInfo {
  agentId: AgentFingerprint;
  reason: string;
  pattern: AbusePattern;
  bannedAt: string; // ISO 8601
  expiresAt: string; // ISO 8601
  durationMs: number;
}

export type AbusePattern =
  | 'spam'
  | 'enumeration'
  | 'flooding'
  | 'connection_churn'
  | 'oversized_payload';

export interface AbuseEvent {
  agentId: AgentFingerprint;
  pattern: AbusePattern;
  details: string;
  timestamp: string;
}

// ── Defaults ───────────────────────────────────────────────────────

const DEFAULTS: AbuseDetectorConfig = {
  spamUniqueRecipientsPerMinute: 50,
  spamBanDurationMs: 60 * 60 * 1000, // 1 hour

  floodingRateMultiplier: 10,
  floodingSustainedMinutes: 5,
  floodingBanDurationMs: 24 * 60 * 60 * 1000, // 24 hours

  connectionChurnPerHour: 100,
  connectionChurnBanDurationMs: 60 * 60 * 1000, // 1 hour

  oversizedPayloadWarnings: 3,
  oversizedPayloadBanDurationMs: 60 * 60 * 1000, // 1 hour

  sybilFirstHourLimit: 10,
  sybilSecondHourLimit: 30,
  sybilGraduationMs: 24 * 60 * 60 * 1000, // 24 hours

  normalRatePerMinute: 60,
};

// ── Implementation ─────────────────────────────────────────────────

export class AbuseDetector {
  private readonly config: AbuseDetectorConfig;
  private readonly nowFn: () => number;

  /** Active bans by agent ID */
  private readonly bans = new Map<AgentFingerprint, BanInfo>();

  /** Track unique recipients per agent (for spam detection) */
  private readonly recipientTracker = new Map<AgentFingerprint, { recipients: Set<string>; windowStart: number }>();

  /** Track message rate per agent per minute (for flooding detection) */
  private readonly rateTracker = new Map<AgentFingerprint, number[]>();

  /** Track connection events per agent (for churn detection) */
  private readonly connectionTracker = new Map<AgentFingerprint, number[]>();

  /** Track oversized payload warnings per agent */
  private readonly oversizedWarnings = new Map<AgentFingerprint, number>();

  /** Track when agents first connected (for Sybil resistance) */
  private readonly firstSeen = new Map<AgentFingerprint, number>();

  /** Track messages sent by new agents (for Sybil limits) */
  private readonly sybilMessageCounts = new Map<AgentFingerprint, { firstHour: number; secondHour: number }>();

  /** Event listeners for abuse events */
  private readonly listeners: ((event: AbuseEvent) => void)[] = [];

  /** Timer for periodic cleanup */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: Partial<AbuseDetectorConfig>, nowFn?: () => number) {
    this.config = mergeDefaults(DEFAULTS, config);
    this.nowFn = nowFn ?? (() => Date.now());

    // Periodic cleanup every 5 minutes
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  // ── Ban Management ───────────────────────────────────────────────

  /**
   * Check if an agent is currently banned.
   */
  isBanned(agentId: AgentFingerprint): BanInfo | null {
    const ban = this.bans.get(agentId);
    if (!ban) return null;

    // Check if ban has expired
    if (this.nowFn() >= new Date(ban.expiresAt).getTime()) {
      this.bans.delete(agentId);
      return null;
    }

    return ban;
  }

  /**
   * Manually ban an agent (admin action).
   */
  ban(agentId: AgentFingerprint, reason: string, durationMs: number, pattern: AbusePattern = 'flooding'): BanInfo {
    const now = this.nowFn();
    const info: BanInfo = {
      agentId,
      reason,
      pattern,
      bannedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + durationMs).toISOString(),
      durationMs,
    };
    this.bans.set(agentId, info);
    return info;
  }

  /**
   * Manually unban an agent (admin action).
   */
  unban(agentId: AgentFingerprint): boolean {
    return this.bans.delete(agentId);
  }

  /**
   * Get all active bans.
   */
  getActiveBans(): BanInfo[] {
    const now = this.nowFn();
    const active: BanInfo[] = [];
    for (const [id, ban] of this.bans) {
      if (now < new Date(ban.expiresAt).getTime()) {
        active.push(ban);
      } else {
        this.bans.delete(id);
      }
    }
    return active;
  }

  // ── Abuse Pattern Detection ──────────────────────────────────────

  /**
   * Record a message send and check for spam/flooding patterns.
   * Returns a ban if the agent should be banned, null otherwise.
   */
  recordMessage(agentId: AgentFingerprint, recipientId: AgentFingerprint): BanInfo | null {
    const now = this.nowFn();

    // Check for spam (too many unique recipients)
    const spamBan = this.checkSpam(agentId, recipientId, now);
    if (spamBan) return spamBan;

    // Check for flooding (sustained high rate)
    const floodBan = this.checkFlooding(agentId, now);
    if (floodBan) return floodBan;

    return null;
  }

  /**
   * Record a connection event and check for churn.
   * Returns a ban if the agent should be banned, null otherwise.
   */
  recordConnection(agentId: AgentFingerprint): BanInfo | null {
    const now = this.nowFn();

    // Track first seen for Sybil resistance
    if (!this.firstSeen.has(agentId)) {
      this.firstSeen.set(agentId, now);
      this.sybilMessageCounts.set(agentId, { firstHour: 0, secondHour: 0 });
    }

    // Track connection events
    if (!this.connectionTracker.has(agentId)) {
      this.connectionTracker.set(agentId, []);
    }
    const events = this.connectionTracker.get(agentId)!;
    events.push(now);

    // Clean old events (keep last hour)
    const hourAgo = now - 60 * 60 * 1000;
    const recent = events.filter(t => t > hourAgo);
    this.connectionTracker.set(agentId, recent);

    // Check for churn
    if (recent.length >= this.config.connectionChurnPerHour) {
      const ban = this.ban(
        agentId,
        `Connection churn: ${recent.length} connections in the last hour`,
        this.config.connectionChurnBanDurationMs,
        'connection_churn',
      );
      this.emitEvent(agentId, 'connection_churn', ban.reason);
      return ban;
    }

    return null;
  }

  /**
   * Record an oversized payload attempt and check for abuse.
   * Returns a ban if warnings exceeded, null otherwise.
   */
  recordOversizedPayload(agentId: AgentFingerprint): BanInfo | null {
    const count = (this.oversizedWarnings.get(agentId) ?? 0) + 1;
    this.oversizedWarnings.set(agentId, count);

    if (count >= this.config.oversizedPayloadWarnings) {
      const ban = this.ban(
        agentId,
        `Repeated oversized payloads (${count} attempts)`,
        this.config.oversizedPayloadBanDurationMs,
        'oversized_payload',
      );
      this.emitEvent(agentId, 'oversized_payload', ban.reason);
      this.oversizedWarnings.delete(agentId);
      return ban;
    }

    return null;
  }

  // ── Sybil Resistance ─────────────────────────────────────────────

  /**
   * Check if a new agent is within its progressive rate limits.
   * Returns { allowed, remaining, reason } indicating whether the message is allowed.
   */
  checkSybilLimit(agentId: AgentFingerprint): { allowed: boolean; remaining: number; reason?: string } {
    const now = this.nowFn();
    let seen = this.firstSeen.get(agentId);
    if (!seen) {
      // First time — register
      this.firstSeen.set(agentId, now);
      this.sybilMessageCounts.set(agentId, { firstHour: 0, secondHour: 0 });
      seen = now;
    }

    const elapsed = now - seen;

    // Graduated: no Sybil limits apply
    if (elapsed >= this.config.sybilGraduationMs) {
      return { allowed: true, remaining: Infinity };
    }

    const counts = this.sybilMessageCounts.get(agentId) ?? { firstHour: 0, secondHour: 0 };

    if (elapsed < 60 * 60 * 1000) {
      // First hour
      if (counts.firstHour >= this.config.sybilFirstHourLimit) {
        return {
          allowed: false,
          remaining: 0,
          reason: `New agent rate limit: ${this.config.sybilFirstHourLimit} messages in first hour`,
        };
      }
      counts.firstHour++;
      this.sybilMessageCounts.set(agentId, counts);
      return { allowed: true, remaining: this.config.sybilFirstHourLimit - counts.firstHour };
    }

    if (elapsed < 2 * 60 * 60 * 1000) {
      // Second hour
      if (counts.secondHour >= this.config.sybilSecondHourLimit) {
        return {
          allowed: false,
          remaining: 0,
          reason: `New agent rate limit: ${this.config.sybilSecondHourLimit} messages in second hour`,
        };
      }
      counts.secondHour++;
      this.sybilMessageCounts.set(agentId, counts);
      return { allowed: true, remaining: this.config.sybilSecondHourLimit - counts.secondHour };
    }

    // Between 2 hours and graduation — no Sybil limits (standard rate limits still apply)
    return { allowed: true, remaining: Infinity };
  }

  // ── Event System ─────────────────────────────────────────────────

  /**
   * Register a listener for abuse events.
   */
  onAbuse(listener: (event: AbuseEvent) => void): void {
    this.listeners.push(listener);
  }

  // ── Stats ────────────────────────────────────────────────────────

  /**
   * Get abuse detection statistics.
   */
  getStats(): {
    activeBans: number;
    trackedAgents: number;
    newAgents: number;
  } {
    const now = this.nowFn();
    const graduationCutoff = now - this.config.sybilGraduationMs;

    let newAgents = 0;
    for (const [, seen] of this.firstSeen) {
      if (seen > graduationCutoff) newAgents++;
    }

    return {
      activeBans: this.getActiveBans().length,
      trackedAgents: this.firstSeen.size,
      newAgents,
    };
  }

  // ── Cleanup ──────────────────────────────────────────────────────

  /**
   * Clean up expired bans and stale tracking data.
   */
  cleanup(): void {
    const now = this.nowFn();

    // Remove expired bans
    for (const [id, ban] of this.bans) {
      if (now >= new Date(ban.expiresAt).getTime()) {
        this.bans.delete(id);
      }
    }

    // Clean up stale recipient trackers (older than 2 minutes)
    for (const [id, tracker] of this.recipientTracker) {
      if (now - tracker.windowStart > 2 * 60 * 1000) {
        this.recipientTracker.delete(id);
      }
    }

    // Clean up stale rate trackers (no events in last 10 minutes)
    for (const [id, events] of this.rateTracker) {
      const recent = events.filter(t => t > now - 10 * 60 * 1000);
      if (recent.length === 0) {
        this.rateTracker.delete(id);
      } else {
        this.rateTracker.set(id, recent);
      }
    }

    // Clean up graduated agents from Sybil tracking
    const graduationCutoff = now - this.config.sybilGraduationMs;
    for (const [id, seen] of this.firstSeen) {
      if (seen < graduationCutoff) {
        this.firstSeen.delete(id);
        this.sybilMessageCounts.delete(id);
      }
    }
  }

  /**
   * Destroy the detector (clear timers).
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.bans.clear();
    this.recipientTracker.clear();
    this.rateTracker.clear();
    this.connectionTracker.clear();
    this.oversizedWarnings.clear();
    this.firstSeen.clear();
    this.sybilMessageCounts.clear();
  }

  // ── Private ──────────────────────────────────────────────────────

  private checkSpam(agentId: AgentFingerprint, recipientId: AgentFingerprint, now: number): BanInfo | null {
    if (!this.recipientTracker.has(agentId)) {
      this.recipientTracker.set(agentId, { recipients: new Set(), windowStart: now });
    }

    const tracker = this.recipientTracker.get(agentId)!;

    // Reset window if it's been more than 1 minute
    if (now - tracker.windowStart > 60_000) {
      tracker.recipients.clear();
      tracker.windowStart = now;
    }

    tracker.recipients.add(recipientId);

    if (tracker.recipients.size >= this.config.spamUniqueRecipientsPerMinute) {
      const ban = this.ban(
        agentId,
        `Spam: sent to ${tracker.recipients.size} unique recipients in 1 minute`,
        this.config.spamBanDurationMs,
        'spam',
      );
      this.emitEvent(agentId, 'spam', ban.reason);
      tracker.recipients.clear();
      return ban;
    }

    return null;
  }

  private checkFlooding(agentId: AgentFingerprint, now: number): BanInfo | null {
    if (!this.rateTracker.has(agentId)) {
      this.rateTracker.set(agentId, []);
    }

    const events = this.rateTracker.get(agentId)!;
    events.push(now);

    // Keep only events within the sustained window
    const windowMs = this.config.floodingSustainedMinutes * 60 * 1000;
    const cutoff = now - windowMs;
    const recent = events.filter(t => t > cutoff);
    this.rateTracker.set(agentId, recent);

    // Check if rate exceeds threshold sustained over the window
    const threshold = this.config.normalRatePerMinute * this.config.floodingRateMultiplier;
    const ratePerMinute = recent.length / this.config.floodingSustainedMinutes;

    if (ratePerMinute >= threshold && recent.length >= threshold * this.config.floodingSustainedMinutes) {
      const ban = this.ban(
        agentId,
        `Flooding: ${Math.round(ratePerMinute)} msgs/min sustained for ${this.config.floodingSustainedMinutes} minutes (threshold: ${threshold})`,
        this.config.floodingBanDurationMs,
        'flooding',
      );
      this.emitEvent(agentId, 'flooding', ban.reason);
      this.rateTracker.delete(agentId);
      return ban;
    }

    return null;
  }

  private emitEvent(agentId: AgentFingerprint, pattern: AbusePattern, details: string): void {
    const event: AbuseEvent = {
      agentId,
      pattern,
      details,
      timestamp: new Date(this.nowFn()).toISOString(),
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Don't let listener errors break abuse detection
      }
    }
  }
}
