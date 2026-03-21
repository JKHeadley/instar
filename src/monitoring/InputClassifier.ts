/**
 * Input Classifier — Phase 2 of Prompt Gate.
 *
 * Classifies detected prompts as auto-approvable or relay-required.
 * Uses a two-stage approach:
 *   1. Rule-based classification (fast path) for clear-cut cases
 *   2. LLM classification (Haiku-tier) for ambiguous matches
 *
 * Classification decisions are based on:
 *   - Prompt type (permission, question, plan, selection, confirmation)
 *   - File paths (in-project vs outside-project)
 *   - Operation safety (destructive keywords)
 *   - Config-level overrides (per-topic, per-type)
 */

import path from 'node:path';
import type { IntelligenceProvider } from '../core/types.js';
import type { DetectedPrompt, PromptType } from './PromptGate.js';

// ── Types ──────────────────────────────────────────────────────────

export type ClassificationAction = 'auto-approve' | 'relay' | 'block';

export interface ClassificationResult {
  action: ClassificationAction;
  reason: string;
  confidence: number;          // 0–1, where 1 = certain
  promptId: string;
  promptType: PromptType;
  llmClassified: boolean;      // Whether LLM was consulted
  classifiedAt: number;
}

export interface InputClassifierConfig {
  /** Project root directory (for in-project path checks) */
  projectDir: string;

  /** Auto-approve sub-config */
  autoApprove: {
    enabled: boolean;
    fileCreation: boolean;
    fileEdits: boolean;
    planApproval: boolean;
  };

  /** Dry-run mode: log but don't auto-approve */
  dryRun: boolean;

  /** IntelligenceProvider for LLM classification (optional) */
  intelligence?: IntelligenceProvider;
}

// ── Destructive patterns ───────────────────────────────────────────

/**
 * Patterns that indicate destructive or risky operations.
 * If any of these appear in the prompt summary or raw text, force relay.
 */
const DESTRUCTIVE_PATTERNS = [
  /\brm\s+-rf?\b/i,
  /\bdelete\b/i,
  /\bremove\b/i,
  /\bdrop\b/i,
  /\bforce\b/i,
  /\boverwrite\b/i,
  /\b--force\b/i,
  /\b--hard\b/i,
  /\brevert\b/i,
  /\breset\b/i,
  /\btruncate\b/i,
  /\bdestroy\b/i,
];

/**
 * Paths that should never be auto-approved regardless of config.
 * These are system-critical or sensitive locations.
 */
const BLOCKED_PATH_PATTERNS = [
  /^\/etc\//,
  /^\/usr\//,
  /^\/var\//,
  /^\/System\//,
  /^\/Library\//,
  /^\/(root|home\/[^/]+)\/.ssh\//,
  /\.env$/,
  /credentials/i,
  /\.pem$/,
  /\.key$/,
  /node_modules\//,
];

// ── InputClassifier ────────────────────────────────────────────────

export class InputClassifier {
  private normalizedProjectDir: string;

  constructor(private config: InputClassifierConfig) {
    this.normalizedProjectDir = path.resolve(config.projectDir);
  }

  /**
   * Classify a detected prompt.
   * Returns the recommended action and reasoning.
   */
  async classify(prompt: DetectedPrompt): Promise<ClassificationResult> {
    // Questions are always relayed — they need human input by definition
    if (prompt.type === 'question') {
      return this.result(prompt, 'relay', 'Clarifying questions always require human response', 1.0, false);
    }

    // If auto-approve is disabled globally, relay everything
    if (!this.config.autoApprove.enabled) {
      return this.result(prompt, 'relay', 'Auto-approve disabled', 1.0, false);
    }

    // Check for destructive operations — always relay
    if (this.isDestructive(prompt)) {
      return this.result(prompt, 'relay', 'Destructive operation detected', 1.0, false);
    }

    // Rule-based classification by prompt type
    const ruleResult = this.classifyByRules(prompt);
    if (ruleResult) return ruleResult;

    // Ambiguous cases: use LLM classification if available
    if (this.config.intelligence) {
      return this.classifyWithLLM(prompt);
    }

    // No LLM available, conservative default: relay
    return this.result(prompt, 'relay', 'Ambiguous prompt, no LLM classifier available', 0.5, false);
  }

  // ── Rule-based classification ──────────────────────────────────

  private classifyByRules(prompt: DetectedPrompt): ClassificationResult | null {
    switch (prompt.type) {
      case 'permission':
        return this.classifyPermission(prompt);
      case 'plan':
        return this.classifyPlan(prompt);
      case 'confirmation':
        return this.classifyConfirmation(prompt);
      case 'selection':
        // Selections are inherently ambiguous — relay or use LLM
        return null;
      default:
        return null;
    }
  }

  private classifyPermission(prompt: DetectedPrompt): ClassificationResult | null {
    // Extract file path from summary: "Permission: Do you want to create <path>?"
    const pathMatch = prompt.summary.match(/(?:create|edit|write to|overwrite)\s+(.+?)(?:\?|$)/i);
    if (!pathMatch) return null; // Can't determine path — ambiguous

    const filePath = pathMatch[1].trim();

    // Check against blocked paths
    if (this.isBlockedPath(filePath)) {
      return this.result(prompt, 'relay', `Sensitive path: ${filePath}`, 1.0, false);
    }

    // Check if it's in the project directory
    const isInProject = this.isInProjectDir(filePath);

    // File creation
    if (/create/i.test(prompt.summary)) {
      if (this.config.autoApprove.fileCreation && isInProject) {
        return this.result(prompt, 'auto-approve', `File creation in project dir: ${filePath}`, 0.95, false);
      }
      if (!isInProject) {
        return this.result(prompt, 'relay', `File creation outside project: ${filePath}`, 1.0, false);
      }
      return this.result(prompt, 'relay', 'File creation auto-approve disabled', 1.0, false);
    }

    // File edits
    if (/edit|write to/i.test(prompt.summary)) {
      if (this.config.autoApprove.fileEdits && isInProject) {
        return this.result(prompt, 'auto-approve', `File edit in project dir: ${filePath}`, 0.95, false);
      }
      if (!isInProject) {
        return this.result(prompt, 'relay', `File edit outside project: ${filePath}`, 1.0, false);
      }
      return this.result(prompt, 'relay', 'File edit auto-approve disabled', 1.0, false);
    }

    // Overwrite — always relay (destructive)
    if (/overwrite/i.test(prompt.summary)) {
      return this.result(prompt, 'relay', `Overwrite operation: ${filePath}`, 1.0, false);
    }

    return null; // Ambiguous permission type
  }

  private classifyPlan(prompt: DetectedPrompt): ClassificationResult | null {
    if (this.config.autoApprove.planApproval) {
      return this.result(prompt, 'auto-approve', 'Plan approval auto-approved', 0.9, false);
    }
    return this.result(prompt, 'relay', 'Plan approval requires user review', 1.0, false);
  }

  private classifyConfirmation(prompt: DetectedPrompt): ClassificationResult | null {
    // "Esc to cancel" confirmations are typically safe edit/tool confirmations
    if (/Esc to cancel/i.test(prompt.raw)) {
      // These are Claude Code's standard tool confirmations — safe to approve
      if (this.config.autoApprove.fileEdits) {
        return this.result(prompt, 'auto-approve', 'Standard tool confirmation', 0.9, false);
      }
    }
    // y/n confirmations need more context — ambiguous
    return null;
  }

  // ── LLM classification ─────────────────────────────────────────

  private async classifyWithLLM(prompt: DetectedPrompt): Promise<ClassificationResult> {
    const intelligence = this.config.intelligence!;
    const systemPrompt = [
      'You are classifying an interactive prompt from a Claude Code terminal session.',
      'Decide whether it is safe to auto-approve or should be relayed to the human operator.',
      '',
      'Respond with EXACTLY one word: APPROVE or RELAY',
      '',
      'APPROVE when:',
      '- File creation/edit within the project directory',
      '- Standard development operations (tests, builds, linting)',
      '- Plan approval for non-destructive work',
      '',
      'RELAY when:',
      '- The prompt asks the human a question requiring thought',
      '- File operations outside the project directory',
      '- Destructive operations (delete, remove, overwrite, force)',
      '- You are unsure',
      '',
      `Project directory: ${this.normalizedProjectDir}`,
      '',
      `Prompt type: ${prompt.type}`,
      `Summary: ${prompt.summary}`,
      `Terminal text (last 5 lines):`,
      prompt.raw,
    ].join('\n');

    try {
      const response = await intelligence.evaluate(systemPrompt, {
        model: 'fast',
        maxTokens: 10,
        temperature: 0,
      });

      const normalized = response.trim().toUpperCase();
      if (normalized.startsWith('APPROVE')) {
        return this.result(prompt, 'auto-approve', 'LLM classified as safe', 0.85, true);
      }
      // Default to relay for any non-APPROVE response
      return this.result(prompt, 'relay', `LLM classified as relay: ${response.trim().slice(0, 50)}`, 0.85, true);
    } catch (err) {
      // LLM failure — conservative fallback
      return this.result(prompt, 'relay', `LLM classification failed: ${(err as Error).message?.slice(0, 100)}`, 0.3, true);
    }
  }

  // ── Path utilities ─────────────────────────────────────────────

  /**
   * Check if a file path is within the project directory.
   * Resolves relative paths and prevents path traversal.
   */
  isInProjectDir(filePath: string): boolean {
    // Resolve to absolute path, treating relative paths as relative to project dir
    const resolved = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(this.normalizedProjectDir, filePath);

    return resolved.startsWith(this.normalizedProjectDir + path.sep) ||
           resolved === this.normalizedProjectDir;
  }

  /**
   * Check if a path matches any blocked patterns.
   */
  isBlockedPath(filePath: string): boolean {
    const resolved = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(this.normalizedProjectDir, filePath);

    return BLOCKED_PATH_PATTERNS.some(p => p.test(resolved));
  }

  // ── Helpers ────────────────────────────────────────────────────

  private isDestructive(prompt: DetectedPrompt): boolean {
    const text = `${prompt.summary} ${prompt.raw}`;
    return DESTRUCTIVE_PATTERNS.some(p => p.test(text));
  }

  private result(
    prompt: DetectedPrompt,
    action: ClassificationAction,
    reason: string,
    confidence: number,
    llmClassified: boolean,
  ): ClassificationResult {
    return {
      action: this.config.dryRun && action === 'auto-approve' ? 'relay' : action,
      reason: this.config.dryRun && action === 'auto-approve' ? `[DRY RUN] Would auto-approve: ${reason}` : reason,
      confidence,
      promptId: prompt.id,
      promptType: prompt.type,
      llmClassified,
      classifiedAt: Date.now(),
    };
  }
}
