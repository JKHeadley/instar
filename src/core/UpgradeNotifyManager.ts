/**
 * Upgrade Notify Manager — reliable delivery of upgrade guides to agents.
 *
 * After an update, a short Claude session is spawned to:
 *   1. Notify the user via Telegram
 *   2. Update MEMORY.md with new capabilities
 *   3. Acknowledge the guide (instar upgrade-ack)
 *
 * This module owns the verification and retry logic:
 *   - After the session completes, check if the pending guide was cleared
 *   - If not, retry with a more capable model (haiku → sonnet)
 *   - Log success/failure for observability
 *
 * Born from the observation that fire-and-forget Haiku sessions silently
 * fail ~30% of the time on multi-step tasks. Verification closes the loop.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ModelTier, Session } from './types.js';
import type { GenericModelTier } from './frameworkSessionLaunch.js';

export interface UpgradeNotifyConfig {
  /** Path to pending-upgrade-guide.md */
  pendingGuidePath: string;
  /** Project directory */
  projectDir: string;
  /** .instar state directory */
  stateDir: string;
  /** Server port */
  port: number;
  /** Dashboard PIN (if set) */
  dashboardPin: string;
  /** Tunnel URL (if available) */
  tunnelUrl: string;
  /** Current installed version */
  currentVersion: string;
  /** Telegram reply script path (empty if not found) */
  replyScript: string;
  /** Telegram topic ID for upgrade notifications */
  notifyTopicId: number;
}

export interface UpgradeNotifyResult {
  /** Whether the upgrade guide was successfully acknowledged */
  success: boolean;
  /** Generic tier used for the successful (or last attempted) escalation step */
  model: GenericModelTier;
  /** Number of attempts made */
  attempts: number;
  /** Error message if failed */
  error?: string;
}

/** Callback to spawn a session — injected for testability. Accepts a
 *  generic tier OR a Claude tier name OR a raw model id; resolution
 *  happens inside SessionManager's framework-aware launch builder. */
export type SessionSpawner = (options: {
  name: string;
  prompt: string;
  model: GenericModelTier | ModelTier | string;
  jobSlug: string;
  maxDurationMinutes: number;
}) => Promise<Session>;

/** Callback to check if a session has completed */
export type SessionCompletionChecker = (sessionId: string) => boolean;

/** Callback to log activity events */
export type ActivityLogger = (event: {
  type: string;
  summary: string;
  metadata?: Record<string, unknown>;
}) => void;

/** Model escalation chain — try faster models first, escalate on failure.
 *  Uses generic tier names so the same chain works for Claude, Codex, and
 *  any future framework. Each framework's headless launch builder maps
 *  the tier to its own model id via resolveModelForFramework. */
const MODEL_CHAIN: GenericModelTier[] = ['fast', 'balanced'];

/** Default timing constants (overridable via UpgradeNotifyTiming for testing) */
const DEFAULT_SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_POLL_INTERVAL_MS = 10_000; // 10 seconds
const DEFAULT_POST_COMPLETION_DELAY_MS = 5_000; // 5 seconds

export interface UpgradeNotifyTiming {
  sessionTimeoutMs?: number;
  pollIntervalMs?: number;
  postCompletionDelayMs?: number;
}

export class UpgradeNotifyManager {
  private config: UpgradeNotifyConfig;
  private spawnSession: SessionSpawner;
  private isSessionComplete: SessionCompletionChecker;
  private logActivity: ActivityLogger;
  private timing: Required<UpgradeNotifyTiming>;

  constructor(
    config: UpgradeNotifyConfig,
    spawnSession: SessionSpawner,
    isSessionComplete: SessionCompletionChecker,
    logActivity: ActivityLogger,
    timing?: UpgradeNotifyTiming,
  ) {
    this.config = config;
    this.spawnSession = spawnSession;
    this.isSessionComplete = isSessionComplete;
    this.logActivity = logActivity;
    this.timing = {
      sessionTimeoutMs: timing?.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS,
      pollIntervalMs: timing?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      postCompletionDelayMs: timing?.postCompletionDelayMs ?? DEFAULT_POST_COMPLETION_DELAY_MS,
    };
  }

  /**
   * Run the upgrade notification with verification and retry.
   * Returns the result of the notification attempt.
   */
  async notify(): Promise<UpgradeNotifyResult> {
    const guideContent = this.readPendingGuide();
    if (!guideContent) {
      return { success: true, model: 'fast', attempts: 0 }; // Nothing to do
    }

    let lastError: string | undefined;

    for (let i = 0; i < MODEL_CHAIN.length; i++) {
      const model = MODEL_CHAIN[i];
      const attempt = i + 1;

      console.log(`[UpgradeNotify] Attempt ${attempt}/${MODEL_CHAIN.length} with ${model}...`);

      try {
        const prompt = this.buildPrompt(guideContent);
        const session = await this.spawnSession({
          name: 'upgrade-notify',
          prompt,
          model,
          jobSlug: 'upgrade-notify',
          maxDurationMinutes: 5,
        });

        // Wait for session to complete
        const completed = await this.waitForCompletion(session.id);
        if (!completed) {
          lastError = `Session timed out after ${this.timing.sessionTimeoutMs / 1000}s`;
          console.warn(`[UpgradeNotify] ${lastError} (${model})`);
          continue;
        }

        // Brief delay for filesystem sync
        await new Promise(r => setTimeout(r, this.timing.postCompletionDelayMs));

        // Check if the pending guide was acknowledged
        if (this.isAcknowledged()) {
          console.log(`[UpgradeNotify] Success — guide acknowledged on attempt ${attempt} (${model})`);
          this.logActivity({
            type: 'upgrade_notify_success',
            summary: `Upgrade guide delivered and acknowledged (${model}, attempt ${attempt})`,
            metadata: { model, attempt },
          });
          return { success: true, model, attempts: attempt };
        }

        lastError = `Session completed but guide was not acknowledged`;
        console.warn(`[UpgradeNotify] ${lastError} (${model}) — ${i < MODEL_CHAIN.length - 1 ? 'escalating model' : 'no more retries'}`);

      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        console.error(`[UpgradeNotify] Spawn failed (${model}): ${lastError}`);
      }
    }

    // All attempts exhausted
    console.error(`[UpgradeNotify] All ${MODEL_CHAIN.length} attempts failed. Pending guide preserved for next session-start.`);
    this.logActivity({
      type: 'upgrade_notify_failed',
      summary: `Upgrade guide notification failed after ${MODEL_CHAIN.length} attempts: ${lastError}`,
      metadata: { attempts: MODEL_CHAIN.length, lastError },
    });

    return {
      success: false,
      model: MODEL_CHAIN[MODEL_CHAIN.length - 1],
      attempts: MODEL_CHAIN.length,
      error: lastError,
    };
  }

  /**
   * Build the upgrade-notify prompt with all context.
   */
  buildPrompt(guideContent: string): string {
    const { dashboardPin, currentVersion, replyScript, notifyTopicId } = this.config;
    const dashboardUrl = this.config.tunnelUrl
      ? `${this.config.tunnelUrl}/dashboard`
      : `http://localhost:${this.config.port}/dashboard`;
    const hasReplyScript = !!replyScript;

    return [
      'IMPORTANT: You are a SHORT-LIVED session with a SPECIFIC task. Do NOT search for files or explore the codebase. Everything you need is in this prompt.',
      '',
      'You have been updated to a new Instar version. Read the upgrade guide below, then do ALL THREE steps.',
      'IMPORTANT: The guide below contains ONLY what is new in THIS update. Do not mention features from previous updates.',
      '',
      '',
      '## Step 1: Notify your user',
      '',
      'Compose a brief, personalized message (3-8 sentences) for your user about the new features.',
      '   RULES:',
      '   - Write like you\'re texting a friend — warm, conversational, no jargon',
      '   - This should NOT look like a changelog or release notes',
      '   - Lead with the biggest USER-VISIBLE feature',
      '   - Include CONCRETE details — actual URLs, PINs, things they can click/use right now',
      '   - NEVER mention "bearer tokens", "auth tokens", version numbers in headers, or internal implementation details',
      '   - Focus on what matters to THEM, not internal plumbing',
      '   - NO bullet lists, NO markdown headers, NO technical formatting — just natural sentences',
      '',
      '   CONCRETE DETAILS TO INCLUDE:',
      `   - Dashboard URL: ${dashboardUrl}`,
      dashboardPin ? `   - Dashboard PIN: ${dashboardPin}` : '   - No dashboard PIN set',
      `   - Current version: ${currentVersion}`,
      '',
      'Send the message via Telegram:',
      hasReplyScript && notifyTopicId
        ? `   Run: cat <<'MSGEOF' | bash ${replyScript} ${notifyTopicId}\nYOUR_MESSAGE_HERE\nMSGEOF`
        : '   Use the telegram-reply script in .instar/scripts/ to send to the updates topic.',
      '',
      '## Step 2: Update your memory with new capabilities',
      '',
      'Read the upgrade guide\'s "Summary of New Capabilities" section and add the relevant information to your MEMORY.md file (.instar/MEMORY.md).',
      'This ensures you KNOW about these capabilities in every future session — not just this one.',
      '',
      'Add a section like:',
      '```',
      '## Capabilities Added in vX.Y.Z',
      '- Brief description of each capability',
      '- How to use it (API endpoints, commands, automatic behaviors)',
      '- Any behavioral changes you should be aware of',
      '```',
      '',
      'Keep it concise — focus on WHAT you can now do and HOW to do it, not the implementation details.',
      'If there are existing capability notes in MEMORY.md, update or merge rather than duplicate.',
      '',
      '## Step 3: Acknowledge',
      '',
      'Run: instar upgrade-ack',
      '',
      'Do all three steps, then exit. Do not search for files or read config files beyond MEMORY.md.',
      '',
      '--- UPGRADE GUIDE ---',
      guideContent,
      '--- END GUIDE ---',
    ].join('\n');
  }

  /**
   * Check if the pending guide has been acknowledged (file removed by upgrade-ack).
   */
  isAcknowledged(): boolean {
    return !fs.existsSync(this.config.pendingGuidePath);
  }

  /**
   * Read the pending upgrade guide content. Returns null if no guide exists.
   */
  private readPendingGuide(): string | null {
    try {
      if (!fs.existsSync(this.config.pendingGuidePath)) return null;
      const content = fs.readFileSync(this.config.pendingGuidePath, 'utf-8');
      return content.trim() || null;
    } catch {
      // @silent-fallback-ok — pending guide returns null
      return null;
    }
  }

  /**
   * Poll until the session completes or times out.
   */
  private async waitForCompletion(sessionId: string): Promise<boolean> {
    const deadline = Date.now() + this.timing.sessionTimeoutMs;

    while (Date.now() < deadline) {
      if (this.isSessionComplete(sessionId)) {
        return true;
      }
      await new Promise(r => setTimeout(r, this.timing.pollIntervalMs));
    }

    return false;
  }
}
