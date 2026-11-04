/**
 * SessionMonitor — Proactive session health monitoring.
 *
 * Unlike StallTriageNurse (reactive — triggers on unanswered messages) or
 * SessionWatchdog (reactive — triggers on stuck bash commands), the
 * SessionMonitor is PROACTIVE: it periodically checks all active sessions
 * and ensures users experience the responsiveness they'd expect.
 *
 * Responsibilities:
 * 1. Detect idle sessions (no tmux output changes for extended periods)
 * 2. Track session responsiveness (time between user message and agent reply)
 * 3. Send proactive health updates to users (not overbearing)
 * 4. Coordinate with StallTriageNurse for recovery when issues are found
 *
 * Design principle: Responsive and informative but not overbearing.
 * One update per issue per session — not a stream of "still checking" messages.
 */

import { EventEmitter } from 'events';
import fs from 'node:fs';
import path from 'node:path';
import type { SessionRecovery, RecoveryResult } from './SessionRecovery.js';
import { detectContextExhaustion } from './QuotaExhaustionDetector.js';
import { mergeDefaults } from '../core/mergeDefaults.js';
import type { SessionOwnershipRecord } from '../core/SessionOwnership.js';

export function isForeignTopicOwner(
  record: Pick<SessionOwnershipRecord, 'ownerMachineId' | 'status'> | null | undefined,
  selfMachineId: string | null | undefined,
): boolean {
  return !!record && !!selfMachineId && record.status !== 'released' && record.ownerMachineId !== selfMachineId;
}

export interface SessionMonitorConfig {
  /** Enable the session monitor (default: true) */
  enabled?: boolean;
  /** How often to check sessions, in seconds (default: 60) */
  pollIntervalSec?: number;
  /** Minutes of inactivity before a session is flagged as idle (default: 15) */
  idleThresholdMinutes?: number;
  /** Minimum minutes between user notifications per topic (default: 30) */
  notificationCooldownMinutes?: number;
}

interface SessionSnapshot {
  sessionName: string;
  topicId: number;
  lastOutput: string;
  lastOutputAt: number;
  lastUserMessageAt: number;
  lastAgentMessageAt: number;
  notifiedAt: number | null;
  status: 'healthy' | 'idle' | 'unresponsive' | 'dead';
}

export interface SessionMonitorEvents {
  'monitor:idle-detected': { topicId: number; sessionName: string; idleMinutes: number };
  'monitor:unresponsive': { topicId: number; sessionName: string; waitMinutes: number };
  'monitor:recovery-triggered': { topicId: number; sessionName: string; reason: string };
  'monitor:mechanical-recovery': { topicId: number; sessionName: string; result: RecoveryResult };
  'monitor:user-notified': { topicId: number; message: string };
  'monitor:recovery-deferred': { topicId: number; sessionName: string };
}

export interface SessionMonitorDeps {
  /** Get all active topic-to-session mappings */
  getActiveTopicSessions: () => Map<number, string>;
  /** Capture tmux output for a session */
  captureSessionOutput: (sessionName: string, lines: number) => string | null;
  /** Check if a session is alive */
  isSessionAlive: (sessionName: string) => boolean;
  /** A replacement is being launched for this conversation. */
  isSessionStarting?: (topicId: number) => boolean;
  /** Get recent messages for a topic */
  getTopicHistory: (topicId: number, limit: number) => Array<{ text: string; fromUser: boolean; timestamp: string }>;
  /** Durable outbound log check; Slack's inbound ring may omit its bot replies. */
  hasAgentRepliedSince?: (topicId: number, sinceMs: number) => boolean;
  /** Send a message to a topic */
  sendToTopic: (topicId: number, text: string) => Promise<any>;
  /** Trigger triage recovery for a session */
  triggerTriage?: (topicId: number, sessionName: string, reason: string) => Promise<{ resolved: boolean }>;
  /** Optional mechanical recovery layer — runs before LLM triage */
  sessionRecovery?: SessionRecovery;
  /** Optional path to the persisted context-exhaustion notify ledger. When set,
   *  the once-per-death-EPISODE dedup map survives server restarts — without it
   *  every boot (update-train churn) forgot which dead sessions were already
   *  announced and re-posted "conversation too long" once per restart (the
   *  bounded residual confirmed twice on 2026-06-06: topics 16566 + 19437). */
  statePath?: string;
  /** Optional: true when another machine in the session pool owns this topic.
   *  A non-owner machine can keep a stale local topic→session mapping after a
   *  topic moves; its local session is "dead" only because the conversation now
   *  runs elsewhere. Such a topic is skipped entirely — no recovery, no triage,
   *  and no "session has stopped, send a new message" notice (2026-10-25: the
   *  Studio told the operator to resend a message the Mama PC was already
   *  answering). A throw is treated as not-owned-elsewhere (today's behavior). */
  isTopicOwnedByPeer?: (topicId: number) => boolean;
  /** Optional path to the persisted "session has stopped" notice ledger. When
   *  set, the dead-session notice is once per death across server restarts:
   *  a topic already told about a death is not told again until a newer user
   *  message arrives. Without it, every boot forgot
   *  the in-memory guards and re-posted the same death (2026-11-02: a Slack
   *  agent re-posted the notice in one channel a dozen times in a morning). */
  deadNoticeStatePath?: string;
}

interface DeadNoticeEntry {
  /** The session whose death was announced. */
  sessionName: string;
  /** Timestamp (ms) of the newest user message the notice answered. */
  userMessageAt: number;
  /** When the notice was sent (ms) — used only for age pruning. */
  at: number;
}

const DEFAULT_CONFIG: Required<SessionMonitorConfig> = {
  enabled: true,
  pollIntervalSec: 60,
  idleThresholdMinutes: 15,
  notificationCooldownMinutes: 30,
};

export class SessionMonitor extends EventEmitter {
  private config: Required<SessionMonitorConfig>;
  private deps: SessionMonitorDeps;
  private snapshots = new Map<number, SessionSnapshot>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** Topic-level cooldown for context exhaustion — survives snapshot cleanup */
  private contextExhaustionCooldowns = new Map<number, number>();
  /** Topic-level notification cooldown — survives snapshot cleanup.
   *  When snapshots are deleted (session dies between polls) and recreated,
   *  snap.notifiedAt resets to null. Without this, the dead-session notification
   *  fires every poll (60s) creating spam. */
  private notificationCooldowns = new Map<number, number>();
  /** topicId -> {sessionName, at} already notified for context exhaustion.
   *  Makes the user notification once-per-failure-EPISODE (per session
   *  instance), not once-per-cooldown-window — the prior behavior re-posted
   *  the same death every cycle while the condition persisted (the 2026-06-06
   *  flood). A successful recovery clears the flag so a future genuine death
   *  notifies. Persisted via deps.statePath so a server restart does not
   *  forget the episode and re-announce the same death once per boot. */
  private ctxNotifiedSessions = new Map<number, { sessionName: string; at: number }>();
  private ctxPersistWarned = false;
  /** Entries older than this are pruned at load — a week-old dead-session
   *  episode is over by any reasonable measure, and pruning bounds the file. */
  private static readonly CTX_NOTIFIED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  /** topicId -> the last "session has stopped" notice. Persisted via
   *  deps.deadNoticeStatePath so one death is announced once, not once per boot. */
  private deadNotified = new Map<number, DeadNoticeEntry>();
  private deadPersistWarned = false;
  private deadRecoveryAttempts = new Map<number, number>();

  constructor(deps: SessionMonitorDeps, config?: Partial<SessionMonitorConfig>) {
    super();
    this.deps = deps;
    this.config = mergeDefaults(DEFAULT_CONFIG, config);
    this.loadCtxNotified();
    this.loadDeadNotified();
  }

  /** Load the persisted dead-notice ledger (tolerant: missing/corrupt → empty). */
  private loadDeadNotified(): void {
    const file = this.deps.deadNoticeStatePath;
    if (!file) return;
    try {
      if (!fs.existsSync(file)) return;
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, Partial<DeadNoticeEntry>>;
      const cutoff = Date.now() - SessionMonitor.CTX_NOTIFIED_MAX_AGE_MS;
      for (const [topic, entry] of Object.entries(raw)) {
        const topicId = Number(topic);
        if (!Number.isFinite(topicId) || !entry || typeof entry.sessionName !== 'string') continue;
        if (typeof entry.at !== 'number' || entry.at < cutoff) continue; // pruned
        if (typeof entry.userMessageAt !== 'number') continue;
        this.deadNotified.set(topicId, { sessionName: entry.sessionName, userMessageAt: entry.userMessageAt, at: entry.at });
      }
    } catch (err) {
      // A corrupt ledger must never break monitoring — start empty (worst case:
      // one repeat notice per dead session, the pre-ledger behavior).
      console.warn('[SessionMonitor] Could not load dead-notice ledger — starting empty:', err);
    }
  }

  /** Persist the dead-notice ledger (atomic tmp+rename; failure-tolerant). */
  private persistDeadNotified(): void {
    const file = this.deps.deadNoticeStatePath;
    if (!file) return;
    try {
      const obj: Record<string, DeadNoticeEntry> = {};
      for (const [topicId, entry] of this.deadNotified) obj[String(topicId)] = entry;
      const tmp = `${file}.tmp`;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
      fs.renameSync(tmp, file);
    } catch (err) {
      // @silent-fallback-ok — not silent: warns once. A failed save degrades
      // to the pre-ledger in-memory guard (the old behaviour), never to extra
      // notices within this process.
      if (!this.deadPersistWarned) {
        this.deadPersistWarned = true;
        console.warn('[SessionMonitor] Could not persist dead-notice ledger (will not warn again):', err);
      }
    }
  }

  /** True when the topic was already told about a death and no user message
   *  has arrived since the one that notice answered — re-announcing would be
   *  a repeat, not news. Keyed on the user message, not the session name:
   *  Telegram reuses a topic's session name across respawns, so a later,
   *  genuinely new death in the same topic must still be announced. */
  private deadAlreadyAnnounced(topicId: number, lastUserMessageAt: number): boolean {
    const prior = this.deadNotified.get(topicId);
    if (!prior) return false;
    return lastUserMessageAt <= prior.userMessageAt;
  }

  /** Load the persisted notify ledger (tolerant: missing/corrupt → empty). */
  private loadCtxNotified(): void {
    if (!this.deps.statePath) return;
    try {
      if (!fs.existsSync(this.deps.statePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.deps.statePath, 'utf-8')) as
        Record<string, { sessionName: string; at: number }>;
      const cutoff = Date.now() - SessionMonitor.CTX_NOTIFIED_MAX_AGE_MS;
      for (const [topic, entry] of Object.entries(raw)) {
        const topicId = Number(topic);
        if (!Number.isFinite(topicId) || !entry || typeof entry.sessionName !== 'string') continue;
        if (typeof entry.at !== 'number' || entry.at < cutoff) continue; // pruned
        this.ctxNotifiedSessions.set(topicId, { sessionName: entry.sessionName, at: entry.at });
      }
    } catch (err) {
      // A corrupt ledger must never break monitoring — start empty (worst
      // case: one repeat notice per dead session, the pre-persistence status quo).
      console.warn('[SessionMonitor] Could not load ctx-notified ledger — starting empty:', err);
    }
  }

  /** Persist the notify ledger (atomic tmp+rename; failure-tolerant). */
  private persistCtxNotified(): void {
    if (!this.deps.statePath) return;
    try {
      const obj: Record<string, { sessionName: string; at: number }> = {};
      for (const [topicId, entry] of this.ctxNotifiedSessions) obj[String(topicId)] = entry;
      const tmp = `${this.deps.statePath}.tmp`;
      fs.mkdirSync(path.dirname(this.deps.statePath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
      fs.renameSync(tmp, this.deps.statePath);
    } catch (err) {
      // Persistence is best-effort: losing it degrades to the pre-persistence
      // behavior (one repeat notice per boot), never to broken monitoring.
      if (!this.ctxPersistWarned) {
        this.ctxPersistWarned = true;
        console.warn('[SessionMonitor] Could not persist ctx-notified ledger (will not warn again):', err);
      }
    }
  }

  // ── Typed Events ────────────────────────────────────────
  override emit<K extends keyof SessionMonitorEvents>(event: K, data: SessionMonitorEvents[K]): boolean {
    return super.emit(event, data);
  }
  override on<K extends keyof SessionMonitorEvents>(event: K, listener: (data: SessionMonitorEvents[K]) => void): this {
    return super.on(event, listener);
  }

  // ── Public API ──────────────────────────────────────────
  start(): void {
    if (!this.config.enabled || this.interval) return;
    console.log(`[SessionMonitor] Starting (poll: ${this.config.pollIntervalSec}s, idle: ${this.config.idleThresholdMinutes}m)`);
    this.interval = setInterval(() => this.poll(), this.config.pollIntervalSec * 1000);
    // Initial poll after 10 seconds (let other systems initialize)
    setTimeout(() => this.poll(), 10_000);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  getStatus(): {
    enabled: boolean;
    trackedSessions: number;
    sessionHealth: Array<{ topicId: number; sessionName: string; status: string; idleMinutes: number }>;
  } {
    const health = [];
    for (const [topicId, snap] of this.snapshots) {
      health.push({
        topicId,
        sessionName: snap.sessionName,
        status: snap.status,
        idleMinutes: Math.round((Date.now() - snap.lastOutputAt) / 60000),
      });
    }
    return {
      enabled: this.config.enabled,
      trackedSessions: this.snapshots.size,
      sessionHealth: health,
    };
  }

  // ── Core Polling ────────────────────────────────────────
  async poll(): Promise<void> {
    if (!this.config.enabled || this.running) return;
    this.running = true;

    try {
      const activeTopics = this.deps.getActiveTopicSessions();

      // Clean up snapshots for topics that no longer have sessions
      for (const topicId of this.snapshots.keys()) {
        if (!activeTopics.has(topicId)) {
          this.snapshots.delete(topicId);
        }
      }

      // Check each active session
      for (const [topicId, sessionName] of activeTopics) {
        if (this.ownedByPeer(topicId)) {
          this.snapshots.delete(topicId);
          continue;
        }
        try {
          await this.checkSession(topicId, sessionName);
        } catch (err) {
          console.error(`[SessionMonitor] Error checking topic ${topicId}:`, err);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private ownedByPeer(topicId: number): boolean {
    if (!this.deps.isTopicOwnedByPeer) return false;
    try {
      return this.deps.isTopicOwnedByPeer(topicId) === true;
    } catch {
      // @silent-fallback-ok — ownership unknown (unreadable registry, or a read
      // before the late-bound registry exists) → monitor as today.
      return false;
    }
  }

  private stopIfOwnedByPeer(topicId: number): boolean {
    if (!this.ownedByPeer(topicId)) return false;
    this.snapshots.delete(topicId);
    return true;
  }

  private async checkSession(topicId: number, sessionName: string): Promise<void> {
    const now = Date.now();
    const alive = this.deps.isSessionAlive(sessionName);
    // A registry entry can still name the failed resume while its replacement
    // is launching. Do not recover or announce the old name in that window.
    if (!alive && this.deps.isSessionStarting?.(topicId)) return;

    // Get or create snapshot
    let snap = this.snapshots.get(topicId);
    if (!snap) {
      snap = {
        sessionName,
        topicId,
        lastOutput: '',
        lastOutputAt: now,
        lastUserMessageAt: 0,
        lastAgentMessageAt: 0,
        notifiedAt: null,
        status: 'healthy',
      };
      this.snapshots.set(topicId, snap);
    }

    // Update session name if it changed (respawn)
    snap.sessionName = sessionName;

    // Capture current output
    const currentOutput = alive ? (this.deps.captureSessionOutput(sessionName, 30) || '') : '';

    // Check if output changed
    if (currentOutput !== snap.lastOutput && currentOutput.length > 0) {
      snap.lastOutput = currentOutput;
      snap.lastOutputAt = now;
    }

    // Get recent message timestamps
    const history = this.deps.getTopicHistory(topicId, 5);
    for (const msg of history) {
      const ts = new Date(msg.timestamp).getTime();
      if (msg.fromUser && ts > snap.lastUserMessageAt) {
        snap.lastUserMessageAt = ts;
      } else if (!msg.fromUser && ts > snap.lastAgentMessageAt) {
        snap.lastAgentMessageAt = ts;
      }
    }

    // ── Proactive context exhaustion check ────────────────────
    // Run BEFORE health classification because a context-exhausted session
    // appears "alive" with recent output (the error message itself), so it
    // would be classified as 'healthy' and skip all recovery logic.
    if (alive && this.deps.sessionRecovery) {
      // Topic-level cooldown survives snapshot cleanup (which happens when sessions die between polls)
      const lastCtxAction = this.contextExhaustionCooldowns.get(topicId);
      const ctxCooldownMs = this.config.notificationCooldownMinutes * 60 * 1000;
      const inCtxCooldown = lastCtxAction && (now - lastCtxAction) < ctxCooldownMs;
      const ctxCheck = detectContextExhaustion(currentOutput);

      // Persist the existing detector's positive result even when the monitor's
      // existing presentation cooldown is active. The latch stores no metadata
      // and owns no recovery decision.
      if (ctxCheck.matched) {
        this.deps.sessionRecovery.markContextWedgedSeen?.(topicId);
      }

      if (!inCtxCooldown) {
        if (ctxCheck.matched || this.deps.sessionRecovery.hasContextWedgedSeen?.(topicId)) {
          if (ctxCheck.matched) {
            console.log(`[SessionMonitor] Context exhaustion detected in topic ${topicId} (pattern: ${ctxCheck.pattern})`);
          } else {
            console.log(`[SessionMonitor] Previously seen context exhaustion remains latched for topic ${topicId}`);
          }
          this.contextExhaustionCooldowns.set(topicId, now);
          let recoveryResult: RecoveryResult | null = null;
          try {
            recoveryResult = await this.deps.sessionRecovery.checkAndRecover(topicId, sessionName);
            this.emit('monitor:mechanical-recovery', { topicId, sessionName, result: recoveryResult });
            if (recoveryResult.recovered) {
              console.log(`[SessionMonitor] Context exhaustion recovery succeeded for topic ${topicId}: ${recoveryResult.message}`);
              snap.status = 'healthy';
              snap.notifiedAt = now;
              if (this.ctxNotifiedSessions.delete(topicId)) this.persistCtxNotified(); // episode over — a future genuine death may notify again
              return;
            }
          } catch (err) {
            console.error(`[SessionMonitor] Context exhaustion recovery error for topic ${topicId}:`, err);
          }
          if (this.stopIfOwnedByPeer(topicId)) return;
          // DEFERRED ≠ dead. The work-check found the session alive and actively
          // producing work, so the kill was deferred — the session is FINE.
          // Telling the user it "hit conversation too long and can't continue"
          // here is a FALSE death report on a live session (2026-06-06 flood:
          // 68 detections / 29+ deferrals / 0 real recoveries in one day).
          // Housekeeping → log + event only, NEVER the user.
          if (recoveryResult?.deferred) {
            console.log(`[SessionMonitor] Context-exhaustion recovery deferred for topic ${topicId} (session alive + producing work) — suppressing user notification`);
            this.emit('monitor:recovery-deferred', { topicId, sessionName });
            return;
          }
          // Genuine failure: notify once per session INSTANCE (failure episode),
          // not once per cooldown window — the same dead session must not
          // re-announce its death every cycle.
          if (this.ctxNotifiedSessions.get(topicId)?.sessionName === sessionName) {
            console.log(`[SessionMonitor] Context-exhaustion already notified for topic ${topicId} session "${sessionName}" — suppressing duplicate`);
            return;
          }
          const recent = this.deps.getTopicHistory(topicId, 5);
          const latestUser = Math.max(0, ...recent.filter(m => m.fromUser).map(m => new Date(m.timestamp).getTime()));
          const latestAgent = Math.max(0, ...recent.filter(m => !m.fromUser).map(m => new Date(m.timestamp).getTime()));
          const current = this.deps.getActiveTopicSessions().get(topicId);
          if (latestUser === 0 || latestAgent > latestUser ||
              this.deps.hasAgentRepliedSince?.(topicId, latestUser) ||
              this.deps.isSessionStarting?.(topicId) ||
              (current && this.deps.isSessionAlive(current))) return;
          snap.status = 'dead';
          await this.deps.sendToTopic(topicId,
            `I couldn't restore this conversation after it reached its context limit. Your message is saved.`
          ).catch(() => {});
          this.emit('monitor:user-notified', { topicId, message: 'context_exhausted' });
          this.ctxNotifiedSessions.set(topicId, { sessionName, at: now });
          this.persistCtxNotified();
          snap.notifiedAt = now;
          this.notificationCooldowns.set(topicId, now);
          return;
        }
      }
    }

    // Determine session health
    const idleMinutes = Math.round((now - snap.lastOutputAt) / 60000);
    const prevStatus = snap.status;

    if (!alive) {
      snap.status = 'dead';
    } else if (snap.lastUserMessageAt > snap.lastAgentMessageAt &&
               now - snap.lastUserMessageAt > 10 * 60 * 1000) {
      // User sent a message > 10 min ago and agent hasn't replied
      snap.status = 'unresponsive';
    } else if (idleMinutes >= this.config.idleThresholdMinutes) {
      snap.status = 'idle';
    } else {
      snap.status = 'healthy';
    }

    // Take action based on health status
    if (snap.status === 'healthy') return;
    if (snap.status === prevStatus && snap.notifiedAt) return; // Already handled

    // Check notification cooldown — use BOTH snapshot-level and persistent topic-level cooldown.
    // Snapshots get deleted when sessions die between polls, resetting snap.notifiedAt to null.
    // The persistent cooldown survives snapshot cleanup and prevents notification spam.
    const cooldownMs = this.config.notificationCooldownMinutes * 60 * 1000;
    if (snap.notifiedAt && now - snap.notifiedAt < cooldownMs) {
      return;
    }
    const lastNotification = this.notificationCooldowns.get(topicId);
    if (lastNotification && now - lastNotification < cooldownMs) {
      return;
    }

    // Only act if the user has sent a message that's gone unanswered.
    // A session sitting idle after the agent responded is NORMAL — the user
    // just hasn't sent a new message yet. "Recently active" is not a reason
    // to escalate; only an unanswered user message is.
    const userExpectsResponse = snap.lastUserMessageAt > snap.lastAgentMessageAt &&
      !this.deps.hasAgentRepliedSince?.(topicId, snap.lastUserMessageAt);

    if (!userExpectsResponse) return; // Session idle but no unanswered message — normal state

    // Try mechanical recovery first (fast, no LLM) before escalating to triage.
    // Run for ALL unhealthy statuses — context exhaustion can occur in alive sessions
    // that appear "unresponsive" or even "idle" (the session is alive at a prompt
    // but can't process input because the conversation is too long).
    if (this.deps.sessionRecovery) {
      try {
        const recoveryResult = await this.deps.sessionRecovery.checkAndRecover(topicId, sessionName);
        this.emit('monitor:mechanical-recovery', { topicId, sessionName, result: recoveryResult });
        if (recoveryResult.recovered) {
          console.log(`[SessionMonitor] Mechanical recovery succeeded for topic ${topicId}: ${recoveryResult.message}`);
          snap.status = 'healthy';
          snap.notifiedAt = now;
          return;
        }
      } catch (err) {
        console.error(`[SessionMonitor] Mechanical recovery error for topic ${topicId}:`, err);
      }
      if (this.stopIfOwnedByPeer(topicId)) return;
    }

    switch (snap.status) {
      case 'dead': {
        this.emit('monitor:recovery-triggered', { topicId, sessionName, reason: 'session_dead' });
        if (this.deps.triggerTriage) {
          const result = await this.deps.triggerTriage(topicId, sessionName, 'Session died while user was waiting');
          if (this.stopIfOwnedByPeer(topicId)) return;
          if (result.resolved) {
            snap.status = 'healthy';
            snap.notifiedAt = now;
            return;
          }
        }
        // Triage may be inconclusive when a resume UUID fails before it has a
        // transcript. Restart from conversation history before telling anyone.
        if (this.stopIfOwnedByPeer(topicId)) return;
        const beforeRestart = this.deps.getActiveTopicSessions().get(topicId);
        if (this.deps.isSessionStarting?.(topicId) ||
            (beforeRestart && this.deps.isSessionAlive(beforeRestart)) ||
            this.deps.hasAgentRepliedSince?.(topicId, snap.lastUserMessageAt)) {
          snap.status = 'healthy';
          return;
        }
        if (this.deadRecoveryAttempts.get(topicId) !== snap.lastUserMessageAt) {
          this.deadRecoveryAttempts.set(topicId, snap.lastUserMessageAt);
          try {
            await this.deps.sessionRecovery?.restartStoppedConversation?.(topicId, sessionName);
          } catch (err) {
            console.error(`[SessionMonitor] Fresh restart failed for topic ${topicId}:`, err);
          }
        }
        if (this.stopIfOwnedByPeer(topicId)) return;
        const currentName = this.deps.getActiveTopicSessions().get(topicId);
        const historyNow = this.deps.getTopicHistory(topicId, 5);
        const latestUser = Math.max(0, ...historyNow.filter(m => m.fromUser).map(m => new Date(m.timestamp).getTime()));
        const latestAgent = Math.max(0, ...historyNow.filter(m => !m.fromUser).map(m => new Date(m.timestamp).getTime()));
        if (this.deps.isSessionStarting?.(topicId) ||
            (currentName && this.deps.isSessionAlive(currentName)) ||
            latestAgent > latestUser ||
            this.deps.hasAgentRepliedSince?.(topicId, latestUser) ||
            this.ownedByPeer(topicId)) {
          snap.status = 'healthy';
          return;
        }
        // Only a failed self-recovery with an unanswered user message merits one notice.
        if (userExpectsResponse && !this.deadAlreadyAnnounced(topicId, snap.lastUserMessageAt)) {
          let delivered = true;
          await this.deps.sendToTopic(topicId,
            `I couldn't restore this conversation. Your message is saved.`
          ).catch(() => { delivered = false; });
          this.emit('monitor:user-notified', { topicId, message: 'session_dead' });
          // Record only a notice that went out: a failed send must stay
          // retryable (after the cooldown or a restart), never marked as told.
          if (delivered) {
            this.deadNotified.set(topicId, { sessionName, userMessageAt: snap.lastUserMessageAt, at: now });
            this.persistDeadNotified();
          }
        }
        snap.notifiedAt = now;
        this.notificationCooldowns.set(topicId, now);
        break;
      }

      case 'unresponsive': {
        const waitMinutes = Math.round((now - snap.lastUserMessageAt) / 60000);
        this.emit('monitor:unresponsive', { topicId, sessionName, waitMinutes });

        if (this.deps.triggerTriage) {
          const result = await this.deps.triggerTriage(topicId, sessionName,
            `Session unresponsive for ${waitMinutes} minutes after user message`);
          if (result.resolved) {
            snap.status = 'healthy';
            snap.notifiedAt = now;
            return;
          }
        }
        snap.notifiedAt = now;
        this.notificationCooldowns.set(topicId, now);
        break;
      }

      case 'idle': {
        this.emit('monitor:idle-detected', { topicId, sessionName, idleMinutes });
        // For idle sessions, only notify if user is actively waiting
        if (userExpectsResponse) {
          const msg = `Session has been idle for ${idleMinutes} minutes. Checking if it needs attention...`;
          await this.deps.sendToTopic(topicId, msg).catch(() => {});
          this.emit('monitor:user-notified', { topicId, message: 'session_idle' });

          if (this.deps.triggerTriage) {
            await this.deps.triggerTriage(topicId, sessionName, `Session idle for ${idleMinutes} minutes, user waiting`);
          }
        }
        snap.notifiedAt = now;
        this.notificationCooldowns.set(topicId, now);
        break;
      }
    }
  }
}
