/**
 * SessionActivitySentinel — Monitors running sessions for undigested activity.
 *
 * The sentinel is a background process that runs inside the Instar server,
 * watching for sessions that have accumulated unprocessed activity. It creates
 * mid-session "mini-digests" using an LLM, and produces a synthesis when
 * sessions complete.
 *
 * Trigger points:
 *   1. Periodic scan (every 30-60 min) — checks running sessions
 *   2. Session completion (sessionComplete event) — creates synthesis
 *   3. On-demand (API/CLI) — manual digest trigger
 *
 * Concurrency:
 *   - Idempotent via hash(sessionId + startedAt + endedAt) digest keys
 *   - Dormant sessions skipped (lastActivity <= lastDigest)
 *   - Minimum activity threshold prevents noisy digests
 *
 * LLM failure handling:
 *   - Failed digests saved to pending queue
 *   - Exponential backoff: 1min, 5min, 15min
 *   - After 3 retries, raw content archived
 *
 * Implements Phase 3 of PROP-memory-architecture.md v3.1.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Session } from '../core/types.js';
import type { IntelligenceProvider } from '../core/types.js';
import { EpisodicMemory, type ActivityDigest, type SessionSynthesis, type SentinelState } from '../memory/EpisodicMemory.js';
import { ActivityPartitioner, type TelegramLogEntry, type ActivityUnit } from '../memory/ActivityPartitioner.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface SentinelConfig {
  stateDir: string;
  intelligence: IntelligenceProvider;
  /** Function to get current running sessions */
  getActiveSessions: () => Session[];
  /** Function to capture tmux output for a session */
  captureSessionOutput: (tmuxSession: string) => string | null;
  /** Function to get Telegram messages for a topic */
  getTelegramMessages?: (topicId: number, since?: string) => TelegramLogEntry[];
  /** Function to get the Telegram topic linked to a session */
  getTopicForSession?: (tmuxSession: string) => number | null;
  /** Max retries before archiving pending content (default: 3) */
  maxRetries?: number;
}

export interface SentinelReport {
  scannedAt: string;
  sessionsScanned: number;
  digestsCreated: number;
  sessionsSkipped: number;
  errors: Array<{ sessionId: string; error: string }>;
}

export interface SynthesisReport {
  sessionId: string;
  digestCount: number;
  synthesisCreated: boolean;
  error?: string;
}

// ─── SessionActivitySentinel ────────────────────────────────────────

export class SessionActivitySentinel {
  private readonly config: SentinelConfig;
  private readonly episodicMemory: EpisodicMemory;
  private readonly partitioner: ActivityPartitioner;
  private readonly maxRetries: number;

  constructor(config: SentinelConfig) {
    this.config = config;
    this.episodicMemory = new EpisodicMemory({ stateDir: config.stateDir });
    this.partitioner = new ActivityPartitioner();
    this.maxRetries = config.maxRetries ?? 3;
  }

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * Scan all running sessions for undigested activity.
   * Called periodically (every 30-60 min) by the scheduler.
   */
  async scan(): Promise<SentinelReport> {
    const report: SentinelReport = {
      scannedAt: new Date().toISOString(),
      sessionsScanned: 0,
      digestsCreated: 0,
      sessionsSkipped: 0,
      errors: [],
    };

    const sessions = this.config.getActiveSessions();
    const state = this.episodicMemory.getSentinelState();

    // Process any pending retries first
    await this.retryPending(state);

    for (const session of sessions) {
      report.sessionsScanned++;

      try {
        const sessionState = state.sessions[session.id];
        const lastDigestedAt = sessionState?.lastDigestedAt;

        // Check if there's new activity since last digest
        if (lastDigestedAt && sessionState?.lastActivityAt) {
          if (sessionState.lastActivityAt <= lastDigestedAt) {
            report.sessionsSkipped++;
            continue;
          }
        }

        const digests = await this.digestActivity(session, lastDigestedAt);
        report.digestsCreated += digests.length;

        // Update sentinel state
        if (digests.length > 0) {
          const latest = digests[digests.length - 1];
          state.sessions[session.id] = {
            lastDigestedAt: latest.endedAt,
            lastActivityAt: latest.endedAt,
            digestCount: (sessionState?.digestCount ?? 0) + digests.length,
          };
        }
      } catch (err: any) {
        report.errors.push({ sessionId: session.id, error: err.message });
      }
    }

    state.lastScanAt = report.scannedAt;
    this.episodicMemory.saveSentinelState(state);

    return report;
  }

  /**
   * Digest a specific session's recent activity.
   * Returns activity digests created.
   */
  async digestActivity(session: Session, lastDigestedAt?: string): Promise<ActivityDigest[]> {
    // Capture session output
    const sessionOutput = this.config.captureSessionOutput(session.tmuxSession);
    if (!sessionOutput || sessionOutput.trim().length === 0) return [];

    // Get linked Telegram messages if available
    let telegramMessages: TelegramLogEntry[] | undefined;
    if (this.config.getTopicForSession && this.config.getTelegramMessages) {
      const topicId = this.config.getTopicForSession(session.tmuxSession);
      if (topicId) {
        telegramMessages = this.config.getTelegramMessages(topicId, lastDigestedAt);
      }
    }

    // Partition into activity units
    const units = this.partitioner.partition({
      sessionOutput,
      telegramMessages,
      lastDigestedAt,
    });

    if (units.length === 0) return [];

    // Digest each unit via LLM
    const digests: ActivityDigest[] = [];
    const topicId = this.config.getTopicForSession?.(session.tmuxSession) ?? undefined;

    for (const unit of units) {
      try {
        const digest = await this.digestUnit(session, unit, topicId);
        if (digest) {
          digests.push(digest);
        }
      } catch (err: any) {
        // Save to pending queue for retry
        const rawContent = this.formatUnitForPending(session, unit);
        this.episodicMemory.savePending(session.id, rawContent);
      }
    }

    return digests;
  }

  /**
   * Synthesize all mini-digests into a session-level summary.
   * Called when a session completes.
   */
  async synthesizeSession(session: Session): Promise<SynthesisReport> {
    const report: SynthesisReport = {
      sessionId: session.id,
      digestCount: 0,
      synthesisCreated: false,
    };

    // First, create any remaining digests for unprocessed activity
    const state = this.episodicMemory.getSentinelState();
    const lastDigestedAt = state.sessions[session.id]?.lastDigestedAt;

    try {
      const finalDigests = await this.digestActivity(session, lastDigestedAt);
      report.digestCount += finalDigests.length;
    } catch {
      // Continue to synthesis even if final digest fails
    }

    // Get all digests for this session
    const allDigests = this.episodicMemory.getSessionActivities(session.id);
    report.digestCount = allDigests.length;

    if (allDigests.length === 0) return report;

    // Synthesize
    try {
      const synthesis = await this.buildSynthesis(session, allDigests);
      this.episodicMemory.saveSynthesis(synthesis);
      report.synthesisCreated = true;
    } catch (err: any) {
      report.error = err.message;
    }

    return report;
  }

  /**
   * Get the underlying EpisodicMemory instance (for route wiring).
   */
  getEpisodicMemory(): EpisodicMemory {
    return this.episodicMemory;
  }

  // ─── LLM Digestion ─────────────────────────────────────────────

  private async digestUnit(
    session: Session,
    unit: ActivityUnit,
    telegramTopicId?: number,
  ): Promise<ActivityDigest | null> {
    const prompt = this.buildDigestPrompt(session, unit);

    const response = await this.config.intelligence.evaluate(prompt, {
      model: 'fast',      // Haiku tier for cost efficiency
      maxTokens: 800,
      temperature: 0.3,
    });

    const parsed = this.parseDigestResponse(response);
    if (!parsed) return null;

    const digestId = this.episodicMemory.saveDigest({
      sessionId: session.id,
      sessionName: session.name,
      startedAt: unit.startedAt,
      endedAt: unit.endedAt,
      telegramTopicId,
      summary: parsed.summary,
      actions: parsed.actions,
      entities: [],  // Entity extraction is a separate step (future)
      learnings: parsed.learnings,
      significance: parsed.significance,
      themes: parsed.themes,
      boundarySignal: unit.boundarySignal,
    });

    return this.episodicMemory.getDigest(session.id, digestId)!;
  }

  private buildDigestPrompt(session: Session, unit: ActivityUnit): string {
    const lines: string[] = [];

    lines.push('You are analyzing a chunk of an AI agent\'s work session to create a concise activity digest.');
    lines.push('');
    lines.push(`Session: ${session.name}`);
    if (session.jobSlug) lines.push(`Job: ${session.jobSlug}`);
    lines.push(`Activity period: ${unit.startedAt} to ${unit.endedAt}`);
    lines.push(`Boundary signal: ${unit.boundarySignal}`);
    lines.push('');

    if (unit.telegramContent) {
      lines.push('=== CONVERSATION (human + agent) ===');
      lines.push(this.truncate(unit.telegramContent, 3000));
      lines.push('');
    }

    if (unit.sessionContent) {
      lines.push('=== SESSION OUTPUT (agent actions) ===');
      lines.push(this.truncate(unit.sessionContent, 3000));
      lines.push('');
    }

    lines.push('Respond in this EXACT JSON format (no other text):');
    lines.push('{');
    lines.push('  "summary": "2-3 sentence overview of what happened in this activity unit",');
    lines.push('  "actions": ["key action 1", "key action 2"],');
    lines.push('  "learnings": ["insight or lesson learned"],');
    lines.push('  "significance": 5,');
    lines.push('  "themes": ["topic1", "topic2"]');
    lines.push('}');
    lines.push('');
    lines.push('RULES:');
    lines.push('- significance is 1-10 (1=trivial, 5=normal, 8+=major milestone)');
    lines.push('- themes are 1-3 word topic tags');
    lines.push('- actions are specific: "committed migration engine", not "wrote code"');
    lines.push('- learnings are insights, not descriptions: "FTS5 requires sync triggers", not "worked on FTS5"');

    return lines.join('\n');
  }

  private parseDigestResponse(response: string): {
    summary: string;
    actions: string[];
    learnings: string[];
    significance: number;
    themes: string[];
  } | null {
    try {
      // Extract JSON from response (may have surrounding text)
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);

      return {
        summary: String(parsed.summary || ''),
        actions: Array.isArray(parsed.actions) ? parsed.actions.map(String) : [],
        learnings: Array.isArray(parsed.learnings) ? parsed.learnings.map(String) : [],
        significance: Math.min(10, Math.max(1, Number(parsed.significance) || 5)),
        themes: Array.isArray(parsed.themes) ? parsed.themes.map(String) : [],
      };
    } catch {
      return null;
    }
  }

  // ─── Session Synthesis ──────────────────────────────────────────

  private async buildSynthesis(session: Session, digests: ActivityDigest[]): Promise<SessionSynthesis> {
    const prompt = this.buildSynthesisPrompt(session, digests);

    const response = await this.config.intelligence.evaluate(prompt, {
      model: 'fast',
      maxTokens: 1024,
      temperature: 0.3,
    });

    const parsed = this.parseSynthesisResponse(response);

    const topicId = this.config.getTopicForSession?.(session.tmuxSession) ?? undefined;

    return {
      sessionId: session.id,
      sessionName: session.name,
      startedAt: session.startedAt,
      endedAt: session.endedAt || new Date().toISOString(),
      jobSlug: session.jobSlug,
      telegramTopicId: topicId,
      activityDigestIds: digests.map(d => d.id),
      summary: parsed.summary,
      keyOutcomes: parsed.keyOutcomes,
      allEntities: [...new Set(digests.flatMap(d => d.entities))],
      allLearnings: [...new Set(digests.flatMap(d => d.learnings))],
      significance: parsed.significance,
      themes: [...new Set(digests.flatMap(d => d.themes))],
      followUp: parsed.followUp,
    };
  }

  private buildSynthesisPrompt(session: Session, digests: ActivityDigest[]): string {
    const lines: string[] = [];

    lines.push('You are creating a coherent session synthesis from multiple activity digests.');
    lines.push('');
    lines.push(`Session: ${session.name}`);
    if (session.jobSlug) lines.push(`Job: ${session.jobSlug}`);
    lines.push(`Duration: ${session.startedAt} to ${session.endedAt || 'ongoing'}`);
    lines.push(`Activity units: ${digests.length}`);
    lines.push('');
    lines.push('=== ACTIVITY DIGESTS (chronological) ===');

    for (const digest of digests) {
      lines.push(`\n--- ${digest.startedAt} [${digest.boundarySignal}] (significance: ${digest.significance}) ---`);
      lines.push(digest.summary);
      if (digest.actions.length > 0) lines.push(`Actions: ${digest.actions.join(', ')}`);
      if (digest.learnings.length > 0) lines.push(`Learnings: ${digest.learnings.join(', ')}`);
    }

    lines.push('');
    lines.push('Respond in this EXACT JSON format (no other text):');
    lines.push('{');
    lines.push('  "summary": "3-5 sentence coherent overview of the entire session",');
    lines.push('  "keyOutcomes": ["outcome 1", "outcome 2"],');
    lines.push('  "significance": 7,');
    lines.push('  "followUp": "What the next session should do (or null if nothing pending)"');
    lines.push('}');

    return lines.join('\n');
  }

  private parseSynthesisResponse(response: string): {
    summary: string;
    keyOutcomes: string[];
    significance: number;
    followUp?: string;
  } {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { summary: response.slice(0, 500), keyOutcomes: [], significance: 5 };
      }

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        summary: String(parsed.summary || ''),
        keyOutcomes: Array.isArray(parsed.keyOutcomes) ? parsed.keyOutcomes.map(String) : [],
        significance: Math.min(10, Math.max(1, Number(parsed.significance) || 5)),
        followUp: parsed.followUp ? String(parsed.followUp) : undefined,
      };
    } catch {
      return { summary: response.slice(0, 500), keyOutcomes: [], significance: 5 };
    }
  }

  // ─── Pending Retry ──────────────────────────────────────────────

  private async retryPending(state: SentinelState): Promise<void> {
    // Check all sessions for pending items
    const pendingDir = path.join(this.config.stateDir, 'episodes', 'pending');
    if (!fs.existsSync(pendingDir)) return;

    for (const sessionId of fs.readdirSync(pendingDir)) {
      const items = this.episodicMemory.getPending(sessionId);
      for (const item of items) {
        if (item.retryCount >= this.maxRetries) {
          // Archive and remove — exceeded max retries
          this.episodicMemory.removePending(sessionId, item.id);
          continue;
        }

        // Exponential backoff: 1min, 5min, 15min
        const backoffMs = [60_000, 300_000, 900_000][item.retryCount] ?? 900_000;
        const lastAttempt = new Date(item.createdAt).getTime() + (backoffMs * item.retryCount);
        if (Date.now() < lastAttempt) continue;

        // Retry the digestion
        try {
          const response = await this.config.intelligence.evaluate(item.content, {
            model: 'fast',
            maxTokens: 800,
            temperature: 0.3,
          });

          const parsed = this.parseDigestResponse(response);
          if (parsed) {
            this.episodicMemory.removePending(sessionId, item.id);
          } else {
            this.episodicMemory.incrementPendingRetry(sessionId, item.id);
          }
        } catch {
          this.episodicMemory.incrementPendingRetry(sessionId, item.id);
        }
      }
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────

  private formatUnitForPending(session: Session, unit: ActivityUnit): string {
    return this.buildDigestPrompt(session, unit);
  }

  private truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars) + '\n... [truncated]';
  }
}
