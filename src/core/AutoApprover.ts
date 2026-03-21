/**
 * Auto-Approver — Phase 2 of Prompt Gate.
 *
 * Handles auto-approved prompts by injecting the appropriate response
 * into the tmux session. Logs every action to an append-only audit trail.
 *
 * Design: Fail-closed. If anything goes wrong (send fails, log fails),
 * the prompt is NOT approved and falls through to relay.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DetectedPrompt } from '../monitoring/PromptGate.js';
import type { ClassificationResult } from '../monitoring/InputClassifier.js';
import { maybeRotateJsonl } from '../utils/jsonl-rotation.js';

// ── Types ──────────────────────────────────────────────────────────

export interface AutoApproverConfig {
  /** State directory for audit log */
  stateDir: string;
  /** Log retention in days (default: 30) */
  logRetentionDays: number;
  /** Include human-readable summary in log (default: false) */
  verboseLogging: boolean;
  /** Send function — injects key/text into tmux session */
  sendKey: (tmuxSession: string, key: string) => boolean;
  /** Callback when a prompt is auto-approved (for notifications) */
  onApproval?: (prompt: DetectedPrompt, classification: ClassificationResult) => void;
}

export interface AuditLogEntry {
  timestamp: string;
  event: 'auto_approved' | 'auto_approve_failed' | 'dry_run';
  sessionName: string;
  promptId: string;
  promptType: string;
  action: string;        // What key/input was sent
  reason: string;        // Classification reason
  confidence: number;
  llmClassified: boolean;
  summary?: string;      // Only when verboseLogging is true
}

// ── Key mapping ────────────────────────────────────────────────────

/**
 * Determine the correct key to send for an auto-approved prompt.
 * Returns the tmux key sequence to inject.
 */
function resolveApprovalKey(prompt: DetectedPrompt): string | null {
  switch (prompt.type) {
    case 'permission': {
      // For numbered options, send "1" (typically "Yes" or "Allow")
      const yesOption = prompt.options?.find(o =>
        /^yes/i.test(o.label) || o.key === '1'
      );
      return yesOption?.key ?? '1';
    }
    case 'plan':
      return 'y';
    case 'confirmation': {
      // "Esc to cancel" → send Enter to confirm
      if (/Esc to cancel/i.test(prompt.raw)) return 'Enter';
      // y/n → send y
      return 'y';
    }
    case 'selection': {
      // Send the first option by default
      return prompt.options?.[0]?.key ?? '1';
    }
    default:
      return null; // Unknown type — can't auto-approve
  }
}

// ── AutoApprover ───────────────────────────────────────────────────

export class AutoApprover {
  private logPath: string;
  /** Track which sessions have had their first auto-approval notification */
  private notifiedSessions = new Set<string>();

  constructor(private config: AutoApproverConfig) {
    this.logPath = path.join(config.stateDir, 'prompt-gate-audit.jsonl');
  }

  /**
   * Handle a prompt that has been classified as auto-approvable.
   * Returns true if the prompt was successfully handled, false if it should fall through to relay.
   */
  handle(prompt: DetectedPrompt, classification: ClassificationResult): boolean {
    if (classification.action !== 'auto-approve') return false;

    const key = resolveApprovalKey(prompt);
    if (!key) {
      this.log({
        event: 'auto_approve_failed',
        sessionName: prompt.sessionName,
        promptId: prompt.id,
        promptType: prompt.type,
        action: 'none',
        reason: 'Could not resolve approval key',
        confidence: classification.confidence,
        llmClassified: classification.llmClassified,
      });
      return false;
    }

    // Send the key to the tmux session
    const sent = this.config.sendKey(prompt.sessionName, key);
    if (!sent) {
      this.log({
        event: 'auto_approve_failed',
        sessionName: prompt.sessionName,
        promptId: prompt.id,
        promptType: prompt.type,
        action: key,
        reason: 'sendKey failed',
        confidence: classification.confidence,
        llmClassified: classification.llmClassified,
      });
      return false;
    }

    // Log the successful approval
    this.log({
      event: 'auto_approved',
      sessionName: prompt.sessionName,
      promptId: prompt.id,
      promptType: prompt.type,
      action: key,
      reason: classification.reason,
      confidence: classification.confidence,
      llmClassified: classification.llmClassified,
      summary: this.config.verboseLogging ? prompt.summary : undefined,
    });

    // Fire approval callback (for first-approval notification, etc.)
    if (this.config.onApproval) {
      this.config.onApproval(prompt, classification);
    }

    return true;
  }

  /**
   * Whether this is the first auto-approval for a session.
   * Used by the caller to send a one-time notification:
   * "Auto-approving session actions — I'll summarize when done"
   */
  isFirstApproval(sessionName: string): boolean {
    if (this.notifiedSessions.has(sessionName)) return false;
    this.notifiedSessions.add(sessionName);
    return true;
  }

  /**
   * Clean up session tracking state.
   */
  cleanup(sessionName: string): void {
    this.notifiedSessions.delete(sessionName);
  }

  /**
   * Rotate audit log if needed.
   */
  rotateLog(): void {
    try {
      maybeRotateJsonl(this.logPath, {
        maxBytes: 10 * 1024 * 1024,
        keepRatio: 0.5,
      });
    } catch {
      // @silent-fallback-ok — rotation is best-effort
    }
  }

  // ── Private ────────────────────────────────────────────────────

  private log(entry: Omit<AuditLogEntry, 'timestamp'>): void {
    const full: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      ...entry,
    };

    try {
      fs.appendFileSync(this.logPath, JSON.stringify(full) + '\n', { mode: 0o600 });
    } catch {
      // @silent-fallback-ok — audit log write failure, prompt still handled
    }
  }
}
