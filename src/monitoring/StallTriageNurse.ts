/**
 * StallTriageNurse — LLM-powered session recovery for stalled sessions.
 *
 * Instar version: Uses IntelligenceProvider for LLM calls, EventEmitter for
 * typed events, and StateManager for persistence across restarts.
 *
 * When a message goes unanswered, the nurse:
 * 1. Gathers context (tmux output, session liveness, recent messages)
 * 2. Diagnoses the problem via LLM (IntelligenceProvider or direct API)
 * 3. Executes a treatment action (nudge, interrupt, unstick, restart)
 * 4. Verifies the action worked
 * 5. Escalates if needed (up to maxEscalations)
 */

import { EventEmitter } from 'events';
import type { IntelligenceProvider, IntelligenceOptions } from '../core/types.js';
import type { StateManager } from '../core/StateManager.js';
import { DegradationReporter } from './DegradationReporter.js';
import { ANTHROPIC_MODELS, resolveModelId } from '../core/models.js';
import type {
  StallTriageConfig,
  TreatmentAction,
  TriageDiagnosis,
  TriageContext,
  TriageResult,
  TriageRecord,
  TriageEvents,
  TriageDeps,
  ProcessInfo,
} from './StallTriageNurse.types.js';

// Re-export types for convenience
export type {
  StallTriageConfig,
  TreatmentAction,
  TriageDiagnosis,
  TriageContext,
  TriageResult,
  TriageRecord,
  TriageEvents,
  TriageDeps,
  ProcessInfo,
};

// ─── Constants ──────────────────────────────────────────────

const DEFAULT_POST_INTERVENTION_DELAY_MS = 3000;

const DEFAULT_CONFIG: Required<StallTriageConfig> = {
  enabled: true,
  apiKey: '',
  model: resolveModelId(process.env.STALL_TRIAGE_MODEL || 'sonnet'),
  maxTokens: 2000,
  apiTimeoutMs: 15000,
  cooldownMs: 180000,
  verifyDelayMs: 10000,
  maxEscalations: 2,
  useIntelligenceProvider: true,
  postInterventionDelayMs: DEFAULT_POST_INTERVENTION_DELAY_MS,
  restartLoopThreshold: 3,
  restartLoopWindowMs: 600_000, // 10 minutes
};

const ACTION_ESCALATION_ORDER: TreatmentAction[] = [
  'status_update',
  'nudge',
  'interrupt',
  'unstick',
  'restart',
];

const SYSTEM_PROMPT = `You are a session recovery specialist for Claude Code sessions running in tmux. Your job is to diagnose why a session is not responding to a user's Telegram message and recommend the best recovery action.

You will receive terminal output from the session, the session's liveness status, recent message history, and the pending message that went unanswered.

Diagnose the situation and recommend ONE of these actions:

1. **status_update** — The session is actively working (you see tool calls, output, thinking indicators). It just hasn't replied yet. Tell the user to wait.
   Terminal signatures: spinner characters, "Read", "Write", "Edit", "Bash", "Grep", "Glob" tool names, "thinking", token counts, active output scrolling.

2. **nudge** — The session might be waiting for input or slightly stuck. A newline keystroke could unstick it.
   Terminal signatures: blank prompt, "Press Enter to continue", cursor blinking at end of output, session idle but alive.

3. **interrupt** — The session is stuck in a loop or waiting state. An Escape key should break it out.
   Terminal signatures: repeated patterns, "waiting for", spinning without progress, same output for extended period, permission prompts.

4. **unstick** — The session is running a hung process (build, test, network call). Ctrl+C should kill the stuck process.
   Terminal signatures: long-running command with no output, build/test hanging, curl/fetch timeout, "npm run" with no progress.

5. **restart** — The session is dead, crashed, or so broken that only a full restart will help.
   Terminal signatures: "Session ended", exit codes, error stack traces, empty/no output, "bash" prompt (Claude exited).

Respond with a JSON object (no markdown fences):
{
  "summary": "Brief technical diagnosis of what's happening",
  "action": "status_update|nudge|interrupt|unstick|restart",
  "confidence": "high|medium|low",
  "userMessage": "Friendly message to send to the user explaining what's happening and what you're doing"
}`;

// ─── Fast-path heuristic ─────────────────────────────────────

/**
 * Detect the "typed-but-not-submitted" terminal state: the ❯ prompt has
 * non-empty text in it, but no processing indicators suggest work is in flight.
 * This exact state occurs when bracketed-paste injection typed the message
 * but the trailing Enter was eaten, leaving the session idle at the prompt.
 *
 * Conservative thresholds (length >= 20 chars, no processing glyphs) keep
 * false positives near-zero — and even a false positive would just send a
 * safe Enter keystroke.
 */
export function detectTypedButNotSubmitted(tmuxOutput: string): boolean {
  if (!tmuxOutput) return false;
  // Processing indicators — if any of these are present, the session is NOT stuck.
  // ⎿ = tool result header, ✶ = Coalescing, ⏺ = assistant speaking,
  // plus common text indicators.
  const processingGlyphs = ['⎿', '✶', '⏺', 'Coalescing', 'thinking', 'esc to interrupt'];
  for (const glyph of processingGlyphs) {
    if (tmuxOutput.includes(glyph)) return false;
  }
  // Find the most recent ❯ line and check that it has meaningful content after the glyph.
  const lines = tmuxOutput.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const idx = line.indexOf('❯');
    if (idx === -1) continue;
    const after = line.slice(idx + 1).trim();
    // Text length > 20 chars avoids false positives from stray characters
    // or terminal rendering artifacts.
    if (after.length >= 20) return true;
    return false;
  }
  return false;
}

// ─── Class ──────────────────────────────────────────────────

export class StallTriageNurse extends EventEmitter {
  private config: Required<StallTriageConfig>;
  private deps: TriageDeps;
  private state: StateManager | null;
  private intelligence: IntelligenceProvider | null;
  private cooldowns = new Map<number, number>();
  private activeCases = new Map<number, { sessionName: string; startedAt: number }>();
  private history: TriageRecord[] = [];
  /** Track restart timestamps per topic for loop detection */
  private restartTimestamps = new Map<number, number[]>();
  private static readonly MAX_HISTORY = 50;
  private static readonly STATE_KEY = 'triage-active';

  constructor(
    deps: TriageDeps,
    opts?: {
      config?: Partial<StallTriageConfig>;
      state?: StateManager;
      intelligence?: IntelligenceProvider;
    },
  ) {
    super();
    this.deps = deps;
    this.state = opts?.state ?? null;
    this.intelligence = opts?.intelligence ?? null;
    this.config = {
      ...DEFAULT_CONFIG,
      ...opts?.config,
      apiKey: opts?.config?.apiKey || process.env.ANTHROPIC_API_KEY || '',
      // Resolve tier names in model config (e.g., 'sonnet' → 'claude-sonnet-4-6')
      model: resolveModelId(opts?.config?.model || DEFAULT_CONFIG.model),
    };

    // Load persisted state
    this.loadState();
  }

  // ─── Typed Event Emitters ─────────────────────────────────

  override emit<K extends keyof TriageEvents>(event: K, data: TriageEvents[K]): boolean {
    return super.emit(event, data);
  }

  override on<K extends keyof TriageEvents>(event: K, listener: (data: TriageEvents[K]) => void): this {
    return super.on(event, listener);
  }

  // ─── Public API ───────────────────────────────────────────

  /**
   * Check if a topic was recently triaged and is in cooldown.
   */
  isInCooldown(topicId: number): boolean {
    const lastTriaged = this.cooldowns.get(topicId);
    if (!lastTriaged) return false;
    return Date.now() - lastTriaged < this.config.cooldownMs;
  }

  /**
   * Get current status for health checks and API.
   */
  getStatus(): { enabled: boolean; activeCases: number; historyCount: number; cooldowns: number } {
    return {
      enabled: this.config.enabled,
      activeCases: this.activeCases.size,
      historyCount: this.history.length,
      cooldowns: this.cooldowns.size,
    };
  }

  /**
   * Get the history of past triage records (capped at MAX_HISTORY).
   */
  getHistory(limit?: number): TriageRecord[] {
    const records = [...this.history];
    return limit ? records.slice(-limit) : records;
  }

  /**
   * Check if a topic is in a restart loop (too many restarts in a short window).
   * Returns the count of recent restarts if in a loop, or 0 if not.
   */
  isInRestartLoop(topicId: number): number {
    const timestamps = this.restartTimestamps.get(topicId);
    if (!timestamps) return 0;

    const now = Date.now();
    const windowMs = this.config.restartLoopWindowMs;
    const recent = timestamps.filter(ts => now - ts < windowMs);

    // Update the stored timestamps to only keep recent ones
    if (recent.length !== timestamps.length) {
      if (recent.length === 0) {
        this.restartTimestamps.delete(topicId);
      } else {
        this.restartTimestamps.set(topicId, recent);
      }
    }

    return recent.length >= this.config.restartLoopThreshold ? recent.length : 0;
  }

  /**
   * Record a restart for loop detection tracking.
   */
  private recordRestart(topicId: number): void {
    const timestamps = this.restartTimestamps.get(topicId) || [];
    timestamps.push(Date.now());
    // Keep only timestamps within the window
    const windowMs = this.config.restartLoopWindowMs;
    const now = Date.now();
    const recent = timestamps.filter(ts => now - ts < windowMs);
    this.restartTimestamps.set(topicId, recent);
  }

  /**
   * Main entry point. Gathers context, diagnoses via LLM, executes treatment,
   * verifies, and escalates if needed.
   */
  async triage(
    topicId: number,
    sessionName: string,
    pendingMessage: string,
    injectedAt: number,
    trigger: 'watchdog' | 'telegram_stall' | 'manual' = 'telegram_stall',
  ): Promise<TriageResult> {
    if (!this.config.enabled) {
      return { resolved: false, actionsTaken: [], diagnosis: null, fallbackReason: 'disabled', trigger };
    }

    // Check cooldown
    if (this.isInCooldown(topicId)) {
      return { resolved: false, actionsTaken: [], diagnosis: null, fallbackReason: 'cooldown_active', trigger };
    }

    // Prevent concurrent triage on same topic
    if (this.activeCases.has(topicId)) {
      return { resolved: false, actionsTaken: [], diagnosis: null, fallbackReason: 'already_triaging', trigger };
    }

    this.activeCases.set(topicId, { sessionName, startedAt: Date.now() });
    this.saveState();
    this.emit('triage:started', { topicId, sessionName, trigger });

    const actionsTaken: TreatmentAction[] = [];
    let lastDiagnosis: TriageDiagnosis | null = null;

    try {
      // Gather context
      const context = this.gatherContext(topicId, sessionName, pendingMessage, injectedAt);

      // Short-circuit: dead/missing session → restart immediately (no LLM needed)
      if (context.sessionStatus === 'missing' || context.sessionStatus === 'dead') {
        const userMessage = `Session "${sessionName}" is ${context.sessionStatus}. Restarting it now...`;
        const diagnosis: TriageDiagnosis = {
          summary: `Session ${context.sessionStatus}`,
          action: 'restart',
          confidence: 'high',
          userMessage,
        };
        await this.executeAction('restart', context, userMessage);
        actionsTaken.push('restart');
        this.deps.clearStallForTopic(topicId);
        this.emit('triage:resolved', { topicId, actionsTaken });

        const result: TriageResult = { resolved: true, actionsTaken, diagnosis, trigger };
        this.recordResult(topicId, sessionName, result);
        return result;
      }

      // Fast-path: typed-but-not-submitted → nudge (single Enter) without LLM.
      // This is the exact failure mode where bracketed-paste injection lands text
      // in the input box but the trailing Enter gets eaten; a single Enter
      // unsticks it. We short-circuit the LLM both to save a round-trip and to
      // recover in seconds instead of waiting on model latency.
      if (detectTypedButNotSubmitted(context.tmuxOutput)) {
        const userMessage = 'Detected typed-but-not-submitted input — pressing Enter to submit.';
        const diagnosis: TriageDiagnosis = {
          summary: 'Input text present at ❯ prompt with no processing activity — Enter was eaten.',
          action: 'nudge',
          confidence: 'high',
          userMessage,
        };
        await this.executeAction('nudge', context, userMessage);
        actionsTaken.push('nudge');
        this.emit('triage:treated', { topicId, action: 'nudge' });
        const recovered = await this.verifyAction('nudge', context);
        if (recovered) {
          this.deps.clearStallForTopic(topicId);
          this.emit('triage:resolved', { topicId, actionsTaken });
          const result: TriageResult = { resolved: true, actionsTaken, diagnosis, trigger };
          this.recordResult(topicId, sessionName, result);
          return result;
        }
        // Nudge didn't unstick it — refresh context so the LLM sees the post-nudge state,
        // then fall through to normal diagnosis + escalation.
        context.tmuxOutput = this.deps.captureSessionOutput(sessionName, 50)?.slice(-3000) || '';
      }

      // Diagnose via LLM
      lastDiagnosis = await this.diagnose(context);
      this.emit('triage:diagnosed', { topicId, diagnosis: lastDiagnosis });
      actionsTaken.push(lastDiagnosis.action);

      // Execute the recommended action
      await this.executeAction(lastDiagnosis.action, context, lastDiagnosis.userMessage);
      this.emit('triage:treated', { topicId, action: lastDiagnosis.action });

      // Verify the action worked
      const recovered = await this.verifyAction(lastDiagnosis.action, context);
      if (recovered) {
        this.deps.clearStallForTopic(topicId);
        this.emit('triage:resolved', { topicId, actionsTaken });
        const result: TriageResult = { resolved: true, actionsTaken, diagnosis: lastDiagnosis, trigger };
        this.recordResult(topicId, sessionName, result);
        return result;
      }

      // Escalation loop — each step is more aggressive, with user-visible status updates
      let currentActionIndex = ACTION_ESCALATION_ORDER.indexOf(lastDiagnosis.action);
      let escalations = 0;

      const ACTION_DESCRIPTIONS: Record<TreatmentAction, string> = {
        status_update: 'checking status',
        nudge: 'nudging the session',
        interrupt: 'sending interrupt signal',
        unstick: 'killing stuck process',
        restart: 'restarting the session with full conversation context',
      };

      while (escalations < this.config.maxEscalations && currentActionIndex < ACTION_ESCALATION_ORDER.length - 1) {
        escalations++;
        currentActionIndex++;
        const nextAction = ACTION_ESCALATION_ORDER[currentActionIndex];
        const prevAction = ACTION_ESCALATION_ORDER[currentActionIndex - 1];
        actionsTaken.push(nextAction);

        this.emit('triage:escalated', { topicId, from: prevAction, to: nextAction });
        console.log(`[StallTriageNurse] Escalating from ${prevAction} to ${nextAction} for topic ${topicId}`);

        const desc = ACTION_DESCRIPTIONS[nextAction] || nextAction;
        const escalationMessage = `That didn't work. Escalating — ${desc}...`;
        await this.executeAction(nextAction, context, escalationMessage);
        this.emit('triage:treated', { topicId, action: nextAction });

        // Re-capture context for verification (output may have changed from previous action)
        context.tmuxOutput = this.deps.captureSessionOutput(sessionName, 50)?.slice(-3000) || '';

        const escalationRecovered = await this.verifyAction(nextAction, context);
        if (escalationRecovered) {
          this.deps.clearStallForTopic(topicId);
          this.emit('triage:resolved', { topicId, actionsTaken });
          const result: TriageResult = { resolved: true, actionsTaken, diagnosis: lastDiagnosis, trigger };
          this.recordResult(topicId, sessionName, result);
          return result;
        }
      }

      // If we haven't tried restart yet and all else failed, force restart
      if (!actionsTaken.includes('restart')) {
        actionsTaken.push('restart');
        const restartMsg = `Recovery attempts exhausted. Restarting session with full conversation context...`;
        await this.executeAction('restart', context, restartMsg);
        this.emit('triage:treated', { topicId, action: 'restart' });
        this.deps.clearStallForTopic(topicId);

        // Verify restart
        await this.delay(this.config.verifyDelayMs);
        if (this.deps.isSessionAlive(sessionName)) {
          this.emit('triage:resolved', { topicId, actionsTaken });
          const result: TriageResult = { resolved: true, actionsTaken, diagnosis: lastDiagnosis, trigger };
          this.recordResult(topicId, sessionName, result);
          return result;
        }
      }

      // Exhausted all escalations — notify user with actionable instructions
      const failReason = 'max_escalations_reached';
      await this.deps.sendToTopic(topicId,
        `I wasn't able to recover the session automatically. You can:\n` +
        `• Send a new message to this topic (will auto-spawn a fresh session)\n` +
        `• Use /restart to force a fresh start`
      ).catch(() => {});
      this.emit('triage:failed', { topicId, reason: failReason, actionsTaken });
      const result: TriageResult = {
        resolved: false, actionsTaken, diagnosis: lastDiagnosis,
        fallbackReason: failReason, trigger,
      };
      this.recordResult(topicId, sessionName, result);
      return result;

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[StallTriageNurse] Triage failed for topic ${topicId}:`, err);
      this.emit('triage:failed', { topicId, reason: errMsg, actionsTaken });
      const result: TriageResult = {
        resolved: false, actionsTaken, diagnosis: lastDiagnosis,
        fallbackReason: `error: ${errMsg}`, trigger,
      };
      this.recordResult(topicId, sessionName, result);
      return result;
    } finally {
      this.activeCases.delete(topicId);
      this.saveState();
    }
  }

  // ─── Heuristic Pre-Filter ────────────────────────────────

  /**
   * Fast pattern-based diagnosis that runs BEFORE the LLM.
   * Returns a diagnosis if a known pattern matches, or null to fall through to LLM.
   */
  heuristicDiagnose(context: TriageContext): TriageDiagnosis | null {
    const output = context.tmuxOutput;
    if (!output) return null;

    // Pattern 1: Running bash command with "(running)" indicator
    // NOTE: "(running)" is a NORMAL Claude Code indicator for any executing Bash tool.
    // Only fire this heuristic if the session has been waiting 10+ minutes, since
    // test suites, builds, and installs legitimately take several minutes.
    // For shorter waits, let the LLM diagnose (it's much better at distinguishing
    // "running test suite" from "hung curl command").
    if (context.waitMinutes >= 10 &&
        /\(running\)/i.test(output) &&
        /timeout|etime|\.py|\.sh|curl|npm|node|bash|python|pnpm/i.test(output)) {
      return {
        summary: `Bash command running with (running) indicator for ${context.waitMinutes}+ minutes — likely hung process`,
        action: 'unstick',
        confidence: 'high',
        userMessage: `Session "${context.sessionName}" has a command that appears stuck (${context.waitMinutes} min). Sending Ctrl+C to recover...`,
      };
    }

    // Pattern 2: OAuth/browser flow waiting for user interaction
    if (/OAuth|please click|Opening browser|click Allow|authorize|authentication.*browser/i.test(output)) {
      return {
        summary: 'Session waiting for browser/OAuth interaction that will never complete in headless mode',
        action: 'unstick',
        confidence: 'high',
        userMessage: `Session "${context.sessionName}" is stuck waiting for a browser interaction. Interrupting and redirecting...`,
      };
    }

    // Pattern 3: Context nearly exhausted (≤3%)
    const contextMatch = output.match(/Context left until auto-compact:\s*([0-9]+)%/);
    if (contextMatch) {
      const pct = parseInt(contextMatch[1], 10);
      if (pct <= 3) {
        return {
          summary: `Context nearly exhausted (${pct}%) — session needs restart to recover`,
          action: 'restart',
          confidence: 'high',
          userMessage: `Session "${context.sessionName}" has run out of context space (${pct}% remaining). Restarting with fresh context...`,
        };
      }
    }

    // Pattern 4: Bare shell prompt (Claude has exited)
    const shellPromptPattern = /^\$\s*$/m;
    const bashVersionPattern = /bash-[\d.]+\$\s*$/m;
    if (shellPromptPattern.test(output) || bashVersionPattern.test(output)) {
      // Make sure Claude isn't actively working (tool calls in progress)
      const claudeActivityPattern = /claude|Read\(|Write\(|Edit\(|Bash\(|Grep\(|Glob\(|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/;
      if (!claudeActivityPattern.test(output)) {
        return {
          summary: 'Shell prompt visible — Claude process has likely exited',
          action: 'restart',
          confidence: 'high',
          userMessage: `Session "${context.sessionName}" appears to have ended. Restarting it now...`,
        };
      }
    }

    // Pattern 5: Fatal errors
    if (/ENOMEM|SIGKILL|out of memory|panic|fatal error/i.test(output)) {
      return {
        summary: 'Fatal error detected in session output',
        action: 'restart',
        confidence: 'high',
        userMessage: `Session "${context.sessionName}" encountered a fatal error. Restarting...`,
      };
    }

    // Pattern 6: "esc to interrupt" visible for 3+ minutes
    if (/esc to interrupt/i.test(output) && context.waitMinutes >= 3) {
      return {
        summary: `"esc to interrupt" visible for ${context.waitMinutes}+ minutes — session stuck in tool call`,
        action: 'interrupt',
        confidence: 'medium',
        userMessage: `Session "${context.sessionName}" appears stuck on a long-running operation. Interrupting it...`,
      };
    }

    return null; // No heuristic match — fall through to LLM
  }

  // ─── Private Methods ──────────────────────────────────────

  private gatherContext(
    topicId: number,
    sessionName: string,
    pendingMessage: string,
    injectedAt: number,
  ): TriageContext {
    const tmuxOutput = this.deps.captureSessionOutput(sessionName, 50) || '';
    const alive = this.deps.isSessionAlive(sessionName);
    const sessionStatus: TriageContext['sessionStatus'] = alive ? 'alive' : 'missing';

    const rawHistory = this.deps.getTopicHistory(topicId, 10);
    const recentMessages = rawHistory.map(m => ({
      sender: m.fromUser ? 'User' : 'Agent',
      text: m.text.slice(0, 200),
      timestamp: m.timestamp,
    }));

    return {
      sessionName,
      topicId,
      tmuxOutput: tmuxOutput.slice(-3000),
      sessionStatus,
      recentMessages,
      pendingMessage: pendingMessage.slice(0, 100),
      waitMinutes: Math.floor((Date.now() - injectedAt) / 60000),
    };
  }

  private async diagnose(context: TriageContext): Promise<TriageDiagnosis> {
    // Layer 1: Heuristic pre-filter (fast, free, catches obvious patterns)
    const heuristic = this.heuristicDiagnose(context);
    if (heuristic) return heuristic;

    // Layer 2: LLM diagnosis (accurate, costs money)
    try {
      const prompt = this.buildDiagnosisPrompt(context);
      let rawResponse: string;

      if (this.config.useIntelligenceProvider && this.intelligence) {
        rawResponse = await this.intelligence.evaluate(prompt, {
          model: 'balanced',
          maxTokens: this.config.maxTokens,
        });
      } else if (this.config.apiKey) {
        rawResponse = await this.callAnthropicApi(prompt);
      } else {
        throw new Error('No intelligence provider or API key configured');
      }

      return this.parseDiagnosis(rawResponse);
    } catch (err) {
      console.warn(`[StallTriageNurse] LLM diagnosis failed, trying process-tree fallback:`, err);
      DegradationReporter.getInstance().report({
        feature: 'StallTriageNurse.diagnosis',
        primary: 'LLM-powered diagnosis of session stall root cause',
        fallback: 'Process-tree analysis then regex-based heuristic on terminal output',
        reason: `LLM diagnosis failed: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'Stall recovery uses process-tree or heuristic fallback — may apply wrong treatment.',
      });

      // Layer 3: Process-tree fallback (check actual child processes)
      const processTreeDiagnosis = await this.processTreeFallback(context);
      if (processTreeDiagnosis) return processTreeDiagnosis;

      // Layer 4: Terminal output heuristic fallback — start with interrupt (Escape)
      // instead of nudge. A newline does nothing to a session that's busy working.
      // Escape interrupts the current tool call, giving the session a chance to
      // notice the pending user message.
      const output = context.tmuxOutput || '';
      let action: TreatmentAction = 'interrupt';
      let summary = 'LLM diagnosis unavailable, using heuristic';
      let userMessage = `Session "${context.sessionName}" isn't responding. Trying to interrupt it...`;

      if (context.sessionStatus === 'missing' || context.sessionStatus === 'dead') {
        action = 'restart';
        summary = `Session ${context.sessionStatus} (heuristic)`;
        userMessage = `Session "${context.sessionName}" has stopped. Restarting it now...`;
      } else if (output.includes('error') || output.includes('Error') || output.includes('SIGTERM') || output.includes('exited')) {
        action = 'restart';
        summary = 'Terminal shows error/exit indicators (heuristic)';
        userMessage = `Session "${context.sessionName}" appears to have crashed. Restarting it...`;
      } else if (context.waitMinutes >= 5) {
        action = 'interrupt';
        summary = `Session alive but unresponsive for ${context.waitMinutes} min (heuristic)`;
        userMessage = `Session "${context.sessionName}" has been unresponsive for ${context.waitMinutes} minutes. Trying to interrupt it...`;
      }

      return { summary, action, confidence: 'low', userMessage };
    }
  }

  /**
   * Process-tree fallback: when LLM is unavailable, check actual child processes
   * to see if something is stuck.
   */
  private async processTreeFallback(context: TriageContext): Promise<TriageDiagnosis | null> {
    if (!this.deps.getStuckProcesses) return null;

    try {
      const stuckProcesses = await this.deps.getStuckProcesses(context.sessionName);
      if (stuckProcesses.length === 0) return null;

      const stuck = stuckProcesses[0];
      const elapsedMin = Math.round(stuck.elapsedMs / 60000);
      return {
        summary: `Stuck child process detected via process tree: "${stuck.command.slice(0, 80)}" (${elapsedMin}min)`,
        action: 'unstick',
        confidence: 'medium',
        userMessage: `Session "${context.sessionName}" has a stuck process (running for ${elapsedMin} minutes). Sending Ctrl+C to recover...`,
      };
    } catch {
      // @silent-fallback-ok — process tree analysis is best-effort
      return null;
    }
  }

  private buildDiagnosisPrompt(context: TriageContext): string {
    const messageHistory = context.recentMessages.length > 0
      ? context.recentMessages.map(m => `[${m.timestamp}] ${m.sender}: ${m.text}`).join('\n')
      : '(no recent messages)';

    return [
      SYSTEM_PROMPT,
      '',
      '--- Current Situation ---',
      `Session: ${context.sessionName}`,
      `Status: ${context.sessionStatus}`,
      `Wait time: ${context.waitMinutes} minutes`,
      `Pending message: "${context.pendingMessage}"`,
      '',
      '--- Recent messages ---',
      messageHistory,
      '',
      '--- Terminal output (last 50 lines) ---',
      context.tmuxOutput || '(empty — no output captured)',
    ].join('\n');
  }

  async callAnthropicApi(prompt: string): Promise<string> {
    if (!this.config.apiKey) {
      throw new Error('No Anthropic API key configured');
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(this.config.apiTimeoutMs),
    });

    if (response.status === 429) {
      throw new Error('Rate limited (429)');
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`API error ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = await response.json() as any;
    const textBlock = data?.content?.find((b: any) => b.type === 'text');
    return textBlock?.text || '';
  }

  parseDiagnosis(rawResponse: string): TriageDiagnosis {
    const fallback: TriageDiagnosis = {
      summary: 'Could not parse LLM response',
      action: 'nudge',
      confidence: 'low',
      userMessage: 'Session may be stuck. Trying to nudge it...',
    };

    if (!rawResponse || rawResponse.trim().length === 0) {
      return fallback;
    }

    try {
      let cleaned = rawResponse.trim();
      // Strip markdown code fences if present
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      // Sometimes the response has text before the JSON — find the JSON object
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return fallback;

      const parsed = JSON.parse(jsonMatch[0]);

      const validActions: TreatmentAction[] = ['status_update', 'nudge', 'interrupt', 'unstick', 'restart'];
      const validConfidences = ['high', 'medium', 'low'];

      if (!validActions.includes(parsed.action)) {
        return { ...fallback, summary: `Invalid action: ${parsed.action}` };
      }

      return {
        summary: String(parsed.summary || fallback.summary),
        action: parsed.action as TreatmentAction,
        confidence: validConfidences.includes(parsed.confidence) ? parsed.confidence : 'low',
        userMessage: String(parsed.userMessage || fallback.userMessage),
      };
    } catch {
      // @silent-fallback-ok — JSON parse in heuristic path
      return fallback;
    }
  }

  private async executeAction(
    action: TreatmentAction,
    context: TriageContext,
    userMessage: string,
  ): Promise<void> {
    console.log(`[StallTriageNurse] Executing ${action} for session "${context.sessionName}" (topic ${context.topicId})`);

    switch (action) {
      case 'status_update':
        await this.deps.sendToTopic(context.topicId, userMessage).catch(err => {
          console.warn(`[StallTriageNurse] sendToTopic failed:`, err);
        });
        break;

      case 'nudge':
        this.deps.sendInput(context.sessionName, '');  // sendInput adds Enter
        await this.deps.sendToTopic(context.topicId, userMessage).catch(err => {
          console.warn(`[StallTriageNurse] sendToTopic failed:`, err);
        });
        break;

      case 'interrupt':
        this.deps.sendKey(context.sessionName, 'Escape');
        await this.deps.sendToTopic(context.topicId, userMessage).catch(err => {
          console.warn(`[StallTriageNurse] sendToTopic failed:`, err);
        });
        await this.sendPostInterventionFollowUp(context, 'interrupt');
        break;

      case 'unstick':
        this.deps.sendKey(context.sessionName, 'C-c');
        await this.deps.sendToTopic(context.topicId, userMessage).catch(err => {
          console.warn(`[StallTriageNurse] sendToTopic failed:`, err);
        });
        await this.sendPostInterventionFollowUp(context, 'unstick');
        break;

      case 'restart':
        await this.deps.sendToTopic(context.topicId, userMessage).catch(err => {
          console.warn(`[StallTriageNurse] sendToTopic failed:`, err);
        });
        await this.deps.respawnSession(context.sessionName, context.topicId, { silent: true });
        break;
    }
  }

  /**
   * After interrupt/unstick, inject a system message into the session so the
   * Claude instance knows what happened and can recover gracefully.
   */
  private async sendPostInterventionFollowUp(
    context: TriageContext,
    action: 'interrupt' | 'unstick',
  ): Promise<void> {
    await this.delay(this.config.postInterventionDelayMs);

    const actionDesc = action === 'unstick'
      ? 'The previous command was automatically interrupted (Ctrl+C) by the session recovery system because it appeared stuck.'
      : 'The previous operation was interrupted (Escape) by the session recovery system because it appeared stuck.';

    const followUp = `[system] ${actionDesc}\nThe user's pending message was: "${context.pendingMessage}"\nPlease acknowledge this to the user via Telegram and continue with an alternative approach if needed.`;

    this.deps.sendInput(context.sessionName, followUp + '\n');
  }

  async verifyAction(action: TreatmentAction, context: TriageContext): Promise<boolean> {
    if (action === 'status_update') {
      return true;
    }

    await this.delay(this.config.verifyDelayMs);

    if (action === 'restart') {
      return this.deps.isSessionAlive(context.sessionName);
    }

    // For nudge/interrupt/unstick: check if the session actually responded to the
    // user, not just if output changed. An actively working session always produces
    // output changes, which caused false positives where autonomous work was mistaken
    // for recovery (the session was doing Phase 4 work, not addressing the user's message).
    const newOutput = this.deps.captureSessionOutput(context.sessionName, 50) || '';

    // Check 1: Did the session send a Telegram reply?
    // Look for "Sent X chars" in the new output, which indicates telegram-reply.py ran
    const sentCharsPattern = /Sent \d+ chars to topic/;
    if (sentCharsPattern.test(newOutput)) return true;

    // Check 2: Is the session now processing the user's message?
    // Look for NEW tool calls that reference the pending message content
    if (context.pendingMessage) {
      const messageKeywords = context.pendingMessage.split(/\s+/).filter(w => w.length > 3).slice(0, 3);
      const hasMessageReference = messageKeywords.some(kw =>
        newOutput.includes(kw) && !(context.tmuxOutput || '').includes(kw)
      );
      if (hasMessageReference) return true;
    }

    // Check 3: Look for NEW tool call activity (not pre-existing autonomous work)
    const workIndicators = ['Read(', 'Write(', 'Edit(', 'Bash(', 'Grep(', 'Glob(', 'telegram-reply', 'tool_use'];
    const hasNewWork = workIndicators.some(indicator => {
      const oldCount = (context.tmuxOutput || '').split(indicator).length;
      const newCount = newOutput.split(indicator).length;
      return newCount > oldCount;
    });
    if (hasNewWork) return true;

    // If output is identical, definitely not recovered
    if (newOutput === context.tmuxOutput) return false;

    // Output changed but no evidence of user-message handling.
    // This is the false-positive case: session is doing autonomous work
    // and the output naturally changes. Don't count this as recovery.
    console.log(`[StallTriageNurse] Output changed after ${action} but no Telegram reply or tool activity detected — not counting as recovered`);
    return false;
  }

  // ─── State Persistence ────────────────────────────────────

  private loadState(): void {
    if (!this.state) return;
    try {
      const saved = this.state.get<TriageRecord[]>(StallTriageNurse.STATE_KEY);
      if (Array.isArray(saved)) {
        this.history = saved.slice(-StallTriageNurse.MAX_HISTORY);
      }
    } catch {
      // @silent-fallback-ok — state load during early startup
    }
  }

  private saveState(): void {
    if (!this.state) return;
    try {
      this.state.set(StallTriageNurse.STATE_KEY, this.history);
    } catch {
      // @silent-fallback-ok — state persistence is best-effort
    }
  }

  private recordResult(topicId: number, sessionName: string, result: TriageResult): void {
    this.cooldowns.set(topicId, Date.now());

    const record: TriageRecord = {
      topicId,
      sessionName,
      timestamp: new Date().toISOString(),
      result,
    };
    this.history.push(record);
    if (this.history.length > StallTriageNurse.MAX_HISTORY) {
      this.history.shift();
    }

    this.saveState();
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
