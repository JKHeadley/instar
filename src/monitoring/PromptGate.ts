/**
 * Prompt Gate — InputDetector
 *
 * Monitors terminal output from Claude Code sessions to detect interactive
 * prompts (permission requests, clarifying questions, plan approvals).
 * Phase 1: detection and logging only. No auto-approve, no relay.
 *
 * Hooks into SessionManager.monitorTick() via a dedicated capture loop,
 * NOT WebSocketManager (which only runs when dashboard clients connect).
 */

import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';

// ── Types ──────────────────────────────────────────────────────────

export type PromptType = 'permission' | 'question' | 'plan' | 'selection' | 'confirmation';

export interface DetectedPrompt {
  type: PromptType;
  raw: string;              // Terminal text (ephemeral — never persisted)
  summary: string;          // Human-readable one-liner
  options?: PromptOption[];
  sessionName: string;
  detectedAt: number;
  id: string;               // Unique prompt ID (12-char CSPRNG)
}

export interface PromptOption {
  key: string;    // What to send to tmux ("1", "y", "Enter", "Escape")
  label: string;  // Human-readable ("Yes", "No", "Cancel")
}

export interface InputDetectorConfig {
  /** Lines from buffer tail to examine (default: 50) */
  detectionWindowLines: number;
  /** Enable/disable detection */
  enabled: boolean;
}

// ── ANSI Stripping ─────────────────────────────────────────────────

/**
 * Strip ANSI escape sequences and control characters from terminal output.
 * Uses a comprehensive regex covering CSI, OSC, and other escape sequences.
 * Post-strip: remove control chars < 0x20 except \n and \t.
 */
export function stripAnsi(text: string): string {
  // CSI sequences: \x1b[ ... (letter)
  // OSC sequences: \x1b] ... (BEL or ST)
  // Other escapes: \x1b followed by single char
  // Also handle 8-bit CSI (0x9B) and OSC (0x9D)
  const ansiRegex = /[\x1b\x9b][\[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]|[\x1b]\].*?(?:\x07|\x1b\\)|[\x1b][^[\]0-9A-ORZcf-nqry=><~]/g;
  let stripped = text.replace(ansiRegex, '');

  // Remove control chars except \n (0x0A) and \t (0x09)
  stripped = stripped.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  return stripped;
}

// ── Pattern Catalog ────────────────────────────────────────────────

interface PatternMatch {
  type: PromptType;
  summary: string;
  options?: PromptOption[];
}

/**
 * Patterns for detecting interactive prompts in Claude Code terminal output.
 * Each pattern operates on stripped (no-ANSI) text.
 */
const PROMPT_PATTERNS: Array<{
  type: PromptType;
  test: (lines: string[]) => PatternMatch | null;
}> = [
  // File creation/edit permission: "Do you want to create <path>?" with numbered options
  {
    type: 'permission',
    test(lines) {
      const joined = lines.join('\n');
      const match = joined.match(/Do you want to (?:create|edit|write to|overwrite)\s+(.+?)\?/i);
      if (!match) return null;
      const filePath = match[1].trim();
      const options: PromptOption[] = [];

      // Look for numbered options (1. Yes, 2. Yes + ..., 3. No)
      for (const line of lines) {
        const optMatch = line.match(/^\s*(\d+)\.\s+(.+)$/);
        if (optMatch) {
          options.push({ key: optMatch[1], label: optMatch[2].trim() });
        }
      }

      return {
        type: 'permission',
        summary: `Permission: ${match[0].slice(0, 200)}`,
        options: options.length > 0 ? options : [
          { key: 'y', label: 'Yes' },
          { key: 'n', label: 'No' },
        ],
      };
    },
  },

  // Plan approval: "Plan:" header + "Do you want to proceed?"
  {
    type: 'plan',
    test(lines) {
      const joined = lines.join('\n');
      if (!/Plan:/i.test(joined)) return null;
      if (!/Do you want to proceed/i.test(joined)) return null;
      return {
        type: 'plan',
        summary: 'Plan approval requested',
        options: [
          { key: 'y', label: 'Approve' },
          { key: 'n', label: 'Reject' },
        ],
      };
    },
  },

  // Confirmation: "Esc to cancel · Tab to amend"
  {
    type: 'confirmation',
    test(lines) {
      const joined = lines.join('\n');
      if (!/Esc to cancel/i.test(joined)) return null;
      return {
        type: 'confirmation',
        summary: 'Confirmation prompt (Esc to cancel)',
        options: [
          { key: 'Enter', label: 'Confirm' },
          { key: 'Escape', label: 'Cancel' },
        ],
      };
    },
  },

  // Yes/No: "(y/n)" or "(Y/n)" suffix
  {
    type: 'confirmation',
    test(lines) {
      // Check only last 3 lines
      const tail = lines.slice(-3).join('\n');
      const match = tail.match(/(.{10,}?)\s*\(([yY])\/?([nN])\)\s*$/);
      if (!match) return null;
      return {
        type: 'confirmation',
        summary: match[1].trim().slice(0, 200),
        options: [
          { key: 'y', label: 'Yes' },
          { key: 'n', label: 'No' },
        ],
      };
    },
  },

  // Numbered selection: multiple numbered options + bare cursor
  {
    type: 'selection',
    test(lines) {
      const options: PromptOption[] = [];
      let hasQuestion = false;

      for (const line of lines) {
        if (line.includes('?')) hasQuestion = true;
        const optMatch = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
        if (optMatch) {
          options.push({ key: optMatch[1], label: optMatch[2].trim() });
        }
      }

      if (options.length < 2) return null;
      // Last line should be blank or short (cursor waiting)
      const lastLine = lines[lines.length - 1]?.trim() ?? '';
      if (lastLine.length > 20 && !lastLine.includes('>')) return null;

      return {
        type: 'selection',
        summary: hasQuestion ? 'Selection prompt' : 'Numbered selection',
        options,
      };
    },
  },

  // Clarifying question: text ending with "?" and no subsequent output
  // This is the broadest pattern — must be last in the list
  {
    type: 'question',
    test(lines) {
      // Check last non-empty line
      const nonEmpty = lines.filter(l => l.trim().length > 0);
      if (nonEmpty.length === 0) return null;
      const last = nonEmpty[nonEmpty.length - 1].trim();

      // Must end with "?" and be substantial (>20 chars to avoid false positives)
      if (!last.endsWith('?') || last.length < 20) return null;

      // Exclude common false positives: code comments, URLs, error messages
      if (last.startsWith('//') || last.startsWith('#') || last.includes('http')) return null;

      return {
        type: 'question',
        summary: last.slice(0, 200),
      };
    },
  },
];

// ── InputDetector ──────────────────────────────────────────────────

export class InputDetector extends EventEmitter {
  private lastOutput = new Map<string, string>();
  private stableCount = new Map<string, number>();
  private emittedPrompts = new Map<string, Set<string>>();

  /** Post-emission cooldown: session → timestamp of last emission */
  private lastEmissionTime = new Map<string, number>();
  private static readonly COOLDOWN_MS = 5000;

  /** Rejected prompt cooling: fingerprint → expiry timestamp */
  private rejectedFingerprints = new Map<string, number>();
  private static readonly REJECTED_COOLING_MS = 60_000;

  constructor(private config: InputDetectorConfig) {
    super();
  }

  /**
   * Called every monitor tick with captured terminal output.
   * Returns a DetectedPrompt if a new prompt is found, null otherwise.
   */
  onCapture(sessionName: string, rawOutput: string): DetectedPrompt | null {
    if (!this.config.enabled) return null;

    const stripped = stripAnsi(rawOutput);

    // Take only the last N lines (detection window)
    const allLines = stripped.split('\n');
    const lines = allLines.slice(-this.config.detectionWindowLines);
    const tailText = lines.join('\n');

    // --- Debounce: require 2 consecutive identical captures (quiescence) ---
    // First capture sets the baseline. Second identical capture confirms stability.
    const prev = this.lastOutput.get(sessionName);
    if (prev === tailText) {
      const count = (this.stableCount.get(sessionName) ?? 0) + 1;
      this.stableCount.set(sessionName, count);
      // count=1 means this is the 2nd identical capture — proceed
      if (count < 1) return null;
    } else {
      this.lastOutput.set(sessionName, tailText);
      this.stableCount.set(sessionName, 0);
      return null;
    }

    // --- Quiescence gating: only match at buffer tail (last 5 lines) ---
    const tailLines = lines.slice(-5);

    // --- Pattern matching ---
    for (const pattern of PROMPT_PATTERNS) {
      const match = pattern.test(tailLines);
      if (!match) continue;

      // Fingerprint for dedup
      const fingerprint = this.fingerprint(sessionName, match.type, tailLines.join('\n'));

      // Check rejected cooling
      const rejectedExpiry = this.rejectedFingerprints.get(fingerprint);
      if (rejectedExpiry && Date.now() < rejectedExpiry) continue;

      // Check dedup
      const emitted = this.emittedPrompts.get(sessionName) ?? new Set();
      if (emitted.has(fingerprint)) continue;

      // Check post-emission cooldown
      const lastEmit = this.lastEmissionTime.get(sessionName);
      if (lastEmit && Date.now() - lastEmit < InputDetector.COOLDOWN_MS) continue;

      // Emit the prompt
      const prompt: DetectedPrompt = {
        type: match.type,
        raw: tailLines.join('\n'),
        summary: match.summary,
        options: match.options,
        sessionName,
        detectedAt: Date.now(),
        id: randomBytes(6).toString('base64url'), // 8-char URL-safe ID
      };

      emitted.add(fingerprint);
      this.emittedPrompts.set(sessionName, emitted);
      this.lastEmissionTime.set(sessionName, Date.now());

      this.emit('prompt', prompt);
      return prompt;
    }

    return null;
  }

  /**
   * Called when input is sent to a session — clears dedup cache
   * since the prompt has been answered.
   */
  onInputSent(sessionName: string): void {
    this.emittedPrompts.delete(sessionName);
    this.stableCount.delete(sessionName);
    this.lastOutput.delete(sessionName);
    this.lastEmissionTime.delete(sessionName); // Clear cooldown so new prompts can fire
  }

  /**
   * Mark a prompt as rejected (user cancelled). Prevents re-fire for 60s.
   */
  onPromptRejected(sessionName: string, promptRaw: string, type: PromptType): void {
    const fingerprint = this.fingerprint(sessionName, type, promptRaw);
    this.rejectedFingerprints.set(fingerprint, Date.now() + InputDetector.REJECTED_COOLING_MS);
  }

  /**
   * Clean up stale state for a session that has ended.
   */
  cleanup(sessionName: string): void {
    this.lastOutput.delete(sessionName);
    this.stableCount.delete(sessionName);
    this.emittedPrompts.delete(sessionName);
    this.lastEmissionTime.delete(sessionName);
  }

  /**
   * Prune expired entries from rejectedFingerprints.
   */
  pruneRejected(): void {
    const now = Date.now();
    for (const [fp, expiry] of this.rejectedFingerprints) {
      if (now >= expiry) this.rejectedFingerprints.delete(fp);
    }
  }

  // ── Private ────────────────────────────────────────────────────

  private fingerprint(sessionName: string, type: string, text: string): string {
    const normalized = text.trim().replace(/\s+/g, ' ');
    return createHash('sha256')
      .update(`${sessionName}:${type}:${normalized}`)
      .digest('hex')
      .slice(0, 16);
  }
}
