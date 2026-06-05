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
  /**
   * Optional deterministic response directive for system prompts whose safe
   * answer is known from the framework UI itself (e.g. Claude Code's optional
   * survey, Gemini CLI's loop-detection modal).
   * When set, the consumer should send `autoDismissKey` to the session and
   * SKIP the relay/classify pipeline entirely.
   */
  autoDismissKey?: string;
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
  /** LLM provider for intelligent prompt detection (falls back to regex-only if not set) */
  intelligence?: import('../core/types.js').IntelligenceProvider;
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
  autoDismissKey?: string;
}

function extractNumberedOptions(lines: string[]): PromptOption[] {
  const options: PromptOption[] = [];
  for (const line of lines) {
    const optMatch = line.match(/^\s*(?:[>❯●○◉]\s*)?(\d+)[.)]\s+(.+)$/);
    if (optMatch) {
      options.push({ key: optMatch[1], label: optMatch[2].trim() });
      continue;
    }

    const colonMatch = line.match(/(?:^|\s)(\d+)\s*[:.)]\s*([A-Za-z][^0-9]{2,})(?=\s+\d+\s*[:.)]|$)/g);
    if (!colonMatch) continue;
    for (const raw of colonMatch) {
      const parsed = raw.trim().match(/^(\d+)\s*[:.)]\s*(.+)$/);
      if (parsed) options.push({ key: parsed[1], label: parsed[2].trim() });
    }
  }
  return options;
}

function findOptionKey(options: PromptOption[], accept: RegExp, reject?: RegExp): string | null {
  const option = options.find(o => accept.test(o.label) && !(reject?.test(o.label)));
  return option?.key ?? null;
}

function detectGeminiSafeDefaultModal(lines: string[], fullWindow?: string[]): PatternMatch | null {
  const windowLines = fullWindow ?? lines;
  const haystack = windowLines.join('\n');
  const options = extractNumberedOptions(windowLines);

  if (/A potential loop was detected/i.test(haystack) && /loop detection/i.test(haystack)) {
    const key = findOptionKey(options, /\bkeep\b.*\b(loop detection|enabled)\b|\benabled\b/i, /\bdisable\b/i) ?? 'Enter';
    return {
      type: 'confirmation',
      summary: 'Gemini CLI loop-detection modal (auto-answer: keep enabled)',
      options: options.length > 0 ? options : [
        { key: 'Enter', label: 'Keep loop detection enabled' },
        { key: 'Escape', label: 'Cancel' },
      ],
      autoDismissKey: key,
    };
  }

  const isWorkspaceTrust = (
    /(?:workspace|folder|directory|project).{0,80}trust|trust.{0,80}(?:workspace|folder|directory|project)/i.test(haystack)
    && /(?:Gemini|gemini-cli|trusted workspace|trust this|do you trust|safe to run)/i.test(haystack)
  );
  if (isWorkspaceTrust) {
    const key = findOptionKey(options, /\b(trust|yes|allow)\b/i, /\b(don'?t|do not|no|untrusted|deny)\b/i) ?? 'Enter';
    return {
      type: 'confirmation',
      summary: 'Gemini CLI workspace-trust modal (auto-answer: trust workspace)',
      options: options.length > 0 ? options : [
        { key: 'Enter', label: 'Trust workspace' },
        { key: 'Escape', label: 'Cancel' },
      ],
      autoDismissKey: key,
    };
  }

  const isGeminiInstallConfirm = (
    /(?:Gemini|gemini-cli|MCP server|extension|tool).{0,120}(?:install|installation)|(?:install|installation).{0,120}(?:Gemini|gemini-cli|MCP server|extension|tool)/i.test(haystack)
    && /(?:Do you want to install|Need to install|Install .*\?|requires installation|Confirm install)/i.test(haystack)
  );
  if (isGeminiInstallConfirm) {
    return {
      type: 'confirmation',
      summary: 'Gemini CLI install-confirm modal (auto-answer: highlighted default)',
      options: options.length > 0 ? options : [
        { key: 'Enter', label: 'Use highlighted default' },
        { key: 'Escape', label: 'Cancel' },
      ],
      autoDismissKey: 'Enter',
    };
  }

  return null;
}

/**
 * Patterns for detecting interactive prompts in Claude Code terminal output.
 * Each pattern operates on stripped (no-ANSI) text.
 */
const PROMPT_PATTERNS: Array<{
  type: PromptType;
  test: (lines: string[], fullWindow?: string[]) => PatternMatch | null;
}> = [
  // Gemini CLI modal prompts that block autonomous sessions even in YOLO mode.
  // These are framework-level affordances with a known safe/default response,
  // so answer them before the relay/classifier path can wedge the session.
  {
    type: 'confirmation',
    test(lines, fullWindow) {
      return detectGeminiSafeDefaultModal(lines, fullWindow);
    },
  },

  // Claude Code OPTIONAL session feedback survey — non-blocking.
  // Shape: "How is Claude doing this session? (optional)" followed by
  //        "1: Bad  2: Fine  3: Good  0: Dismiss" on one line.
  // The session is NOT blocked — Claude continues working — so we
  // auto-dismiss (send "0") and skip relay to avoid Telegram spam.
  // Must run BEFORE the broad "question" pattern.
  {
    type: 'selection',
    test(lines, fullWindow) {
      const haystack = (fullWindow ?? lines).join('\n');
      if (!/How is Claude doing this session\?/i.test(haystack)) return null;
      // Confirm the canonical option row to avoid matching paraphrases
      // in normal agent output.
      const hasOptionRow = /\b0\s*[:.)]\s*Dismiss\b/i.test(haystack)
        && /\b1\s*[:.)]\s*Bad\b/i.test(haystack);
      if (!hasOptionRow) return null;
      return {
        type: 'selection',
        summary: 'Claude Code session-feedback survey (auto-dismiss — non-blocking)',
        options: [
          { key: '1', label: 'Bad' },
          { key: '2', label: 'Fine' },
          { key: '3', label: 'Good' },
          { key: '0', label: 'Dismiss' },
        ],
        autoDismissKey: '0',
      };
    },
  },

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

  // Plan approval — REMOVED: regex-based detection was too brittle and produced
  // false positives (e.g., matching git commit messages). Plan detection is now
  // handled by the LLM-based InputDetector path (see llmDetect method).
  // Keeping the type in the catalog for classification/relay compatibility.

  // Confirmation: "Esc to cancel · Tab to amend" (Claude Code UI)
  //                "Ctrl+C to cancel" (Codex CLI UI)
  // Provider-portability v1.0.0: both frameworks surface a cancel hint
  // at the bottom of their interactive UI when waiting on user input.
  // The escape key + Ctrl+C are both valid cancel signals across
  // terminals, so the prompt-response options match either UI.
  {
    type: 'confirmation',
    test(lines) {
      const joined = lines.join('\n');
      const isClaudeCancel = /Esc to cancel/i.test(joined);
      const isCodexCancel = /Ctrl\+?C to cancel|Press Ctrl-C to cancel/i.test(joined);
      if (!isClaudeCancel && !isCodexCancel) return null;
      return {
        type: 'confirmation',
        summary: isCodexCancel
          ? 'Confirmation prompt (Ctrl+C to cancel)'
          : 'Confirmation prompt (Esc to cancel)',
        options: [
          { key: 'Enter', label: 'Confirm' },
          { key: isCodexCancel ? 'Ctrl+C' : 'Escape', label: 'Cancel' },
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

  /** Track pending LLM detection calls to prevent overlap */
  private pendingLlmDetection = new Set<string>();

  /**
   * NO_PROMPT classification cache: session → bounded set of recent context
   * fingerprints already classified by the LLM as not a blocking prompt.
   *
   * Without this, an idle session showing the same terminal output across every
   * monitor tick re-asks the LLM "is this stuck?" every 5 seconds forever,
   * because the existing rate limit (lastLlmRelay) is only updated on a
   * successful emit. The cache short-circuits that loop: once we've classified
   * a given context as NO_PROMPT, we don't re-classify the identical context.
   * Cache is cleared in onInputSent() and cleanup().
   */
  private noPromptCache = new Map<string, { set: Set<string>; order: string[] }>();
  private static readonly NO_PROMPT_CACHE_MAX = 32;

  /**
   * Per-session cache generation counter. Incremented whenever the cache is
   * cleared for a session (onInputSent, cleanup). An in-flight llmDetect call
   * captures the generation at start; if it changes before the call's
   * recordNoPrompt write, the write is dropped — we don't want a stale
   * pre-input verdict to repopulate the cache after a clear.
   */
  private cacheGeneration = new Map<string, number>();

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
    // Some prompts (plans) span more than 5 lines, so pass full window too
    const tailLines = lines.slice(-5);

    // --- Pattern matching (simple structural patterns: y/n, Esc to cancel, etc.) ---
    for (const pattern of PROMPT_PATTERNS) {
      const match = pattern.test(tailLines, lines);
      if (!match) continue;

      const result = this.emitIfNew(sessionName, match, tailLines);
      if (result) return result;
    }

    // --- LLM-based detection (catches everything regex misses) ---
    // Only fire if: intelligence provider available, no pending LLM call for this session,
    // output has been stable for 3+ captures (strong quiescence signal), and cooldown allows
    const stableCount = this.stableCount.get(sessionName) ?? 0;
    if (this.config.intelligence && !this.pendingLlmDetection.has(sessionName) && stableCount >= 2) {
      const lastEmit = this.lastEmissionTime.get(sessionName);
      if (!lastEmit || Date.now() - lastEmit >= InputDetector.COOLDOWN_MS) {
        this.pendingLlmDetection.add(sessionName);
        this.llmDetect(sessionName, lines).catch(err => {
          console.error(`[PromptGate] LLM detection error for ${sessionName}: ${err.message}`);
        }).finally(() => {
          this.pendingLlmDetection.delete(sessionName);
        });
      }
    }

    return null;
  }

  /**
   * Emit a detected prompt if it passes dedup/cooldown checks.
   */
  private emitIfNew(sessionName: string, match: PatternMatch, tailLines: string[]): DetectedPrompt | null {
    const fingerprint = this.fingerprint(sessionName, match.type, tailLines.join('\n'));

    // Check rejected cooling
    const rejectedExpiry = this.rejectedFingerprints.get(fingerprint);
    if (rejectedExpiry && Date.now() < rejectedExpiry) return null;

    // Check dedup
    const emitted = this.emittedPrompts.get(sessionName) ?? new Set();
    if (emitted.has(fingerprint)) return null;

    // Check post-emission cooldown
    const lastEmit = this.lastEmissionTime.get(sessionName);
    if (lastEmit && Date.now() - lastEmit < InputDetector.COOLDOWN_MS) return null;

    const prompt: DetectedPrompt = {
      type: match.type,
      raw: tailLines.join('\n'),
      summary: match.summary,
      options: match.options,
      sessionName,
      detectedAt: Date.now(),
      id: randomBytes(6).toString('base64url'),
      autoDismissKey: match.autoDismissKey,
    };

    emitted.add(fingerprint);
    this.emittedPrompts.set(sessionName, emitted);
    this.lastEmissionTime.set(sessionName, Date.now());

    this.emit('prompt', prompt);
    return prompt;
  }

  /**
   * LLM-based prompt detection. Asks Haiku to analyze terminal output
   * and determine if the session is waiting for user input.
   * Fires asynchronously — emits 'prompt' event if detected.
   */
  /** Per-session LLM detection rate limit: max 1 LLM relay per session per 5 minutes */
  private llmRelayTimestamps = new Map<string, number>();
  private static readonly LLM_RELAY_COOLDOWN_MS = 300_000; // 5 minutes

  private async llmDetect(sessionName: string, lines: string[]): Promise<void> {
    const intelligence = this.config.intelligence;
    if (!intelligence) return;

    // Per-session rate limit for LLM-based relays
    const lastLlmRelay = this.llmRelayTimestamps.get(sessionName);
    if (lastLlmRelay && Date.now() - lastLlmRelay < InputDetector.LLM_RELAY_COOLDOWN_MS) return;

    // Pre-filter: skip if terminal shows Claude Code's standard status bar UI
    // These are persistent UI elements, NOT interactive prompts
    const tailText = lines.slice(-3).join('\n');
    // Optional session-feedback survey is non-blocking; the structural pattern
    // above (PROMPT_PATTERNS) already handles auto-dismiss. Skip LLM here so
    // the 5-min cooldown isn't burned on a prompt that doesn't block anything.
    const llmHaystack = lines.slice(-20).join('\n');
    if (/How is Claude doing this session\?/i.test(llmHaystack)) return;
    if (/bypass permissions on/i.test(tailText)) return;
    if (/esc to interrupt/i.test(tailText) && !/Do you want|Would you like|proceed\?/i.test(tailText)) return;
    if (/shift\+tab to cycle/i.test(tailText) && !/proceed\?|approve/i.test(tailText)) return;

    // Skip if terminal shows active Claude Code work (tool calls, thinking)
    if (/Scampering|Thinking|Reading \d+ file|Writing to|Editing/i.test(tailText)) return;

    // Sanitize: take last 20 lines, strip any remaining ANSI
    const context = lines.slice(-20).join('\n').slice(0, 3000);

    // Skip LLM call if we have already classified this exact context as
    // NO_PROMPT for this session. Idle sessions show the same output across
    // many ticks; without this cache they would re-burn ~720 LLM calls/hour
    // each asking the same question and getting the same answer.
    const contextFingerprint = createHash('sha256').update(context).digest('hex');
    const cached = this.noPromptCache.get(sessionName);
    if (cached && cached.set.has(contextFingerprint)) return;

    // Capture cache generation at call start. If onInputSent or cleanup runs
    // for this session before our verdict comes back, the generation will
    // increment and recordNoPrompt below will drop the (now-stale) write.
    const callGeneration = this.cacheGeneration.get(sessionName) ?? 0;

    const prompt = `You are analyzing terminal output from an AI agent session (Claude Code OR OpenAI Codex CLI). Your job is to determine if the session is BLOCKED at a system-level interactive prompt that prevents the agent from continuing.

Terminal output (last 20 lines):
<terminal>
${context}
</terminal>

RESPOND NO_PROMPT for ALL of these (they are NOT blocking prompts):
- Status bar elements: "bypass permissions on", "esc to interrupt", "shift+tab to cycle", "Ctrl+C to interrupt"
- Agent working: "Scampering", "Thinking", "Reading N files", "Writing to", "Editing", "Update Plan", "Step N"
- Empty prompt line (❯ for Claude, > for Codex) — agent is idle, not blocked
- Token counters, progress indicators, "tokens used"
- CONVERSATIONAL QUESTIONS from the agent like "Want me to...", "Should I...", "Shall we...", "Would you like me to..." — these are the agent asking a follow-up in its response text. The user can reply normally via Telegram. These do NOT block the session.

A REAL BLOCKING PROMPT looks like:
- Claude Code's SYSTEM UI asking "Do you want to create src/foo.ts?" with numbered options rendered by the terminal (not in the agent's text output)
- Plan approval: "Claude has written up a plan... Would you like to proceed?" with system-rendered numbered options (❯ 1. Yes  2. No)
- A y/n prompt: "Do you want to proceed? (y/n)" at the very bottom of the terminal
- "Esc to cancel · Tab to amend" — Claude Code's edit confirmation UI
- Codex CLI's "Ctrl+C to cancel" hint at the bottom while it waits on a decision
- Codex CLI's "Apply patch?" / "Run command?" approval prompt (when sandbox mode allows approvals)

KEY DISTINCTION: If the question appears INSIDE the agent's conversational response text (alongside other paragraphs of explanation), it's conversational — NOT a blocking prompt. Blocking prompts are rendered by the framework's UI at the bottom of the terminal, often with special formatting (❯, numbered options, keyboard hints like shift+tab or Ctrl+C).

If NOT a blocking prompt, respond exactly: NO_PROMPT

If it IS a genuine blocking system prompt, respond with JSON (no markdown fences):
{
  "type": "plan" | "permission" | "question" | "confirmation" | "selection",
  "summary": "Brief description of what the system is asking",
  "options": [
    {"key": "1", "label": "Short description of option 1"},
    {"key": "2", "label": "Short description of option 2"}
  ]
}

When in doubt, respond NO_PROMPT. False positives cause spam.`;

    try {
      const response = await intelligence.evaluate(prompt, {
        model: 'fast',
        maxTokens: 500,
        temperature: 0,
        attribution: { component: 'PromptGate' }, // attribution for /metrics/features
      });

      const trimmed = response.trim();
      if (trimmed === 'NO_PROMPT' || trimmed.startsWith('NO')) {
        // Cache only on the strict NO_PROMPT signal. The permissive
        // startsWith('NO') branch covers transient responses like "No idea"
        // that we don't want to memoize across the next 32 cycles.
        if (trimmed === 'NO_PROMPT') {
          this.recordNoPrompt(sessionName, contextFingerprint, callGeneration);
        }
        return;
      }

      // Parse JSON response
      let parsed: { type: PromptType; summary: string; options?: Array<{ key: string; label: string }> };
      try {
        // Handle potential markdown fences
        const jsonStr = trimmed.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
        parsed = JSON.parse(jsonStr);
      } catch {
        return; // Malformed response — skip
      }

      // Validate type
      const validTypes: PromptType[] = ['plan', 'permission', 'question', 'confirmation', 'selection'];
      if (!validTypes.includes(parsed.type)) return;

      // Validate options keys against allowlist
      const allowedKeys = new Set(['1', '2', '3', '4', '5', 'y', 'n', 'Enter', 'Escape']);
      const options = (parsed.options ?? []).filter(o => allowedKeys.has(o.key));

      const tailLines = lines.slice(-5);
      const match: PatternMatch = {
        type: parsed.type,
        summary: parsed.summary?.slice(0, 200) ?? 'Input requested',
        options: options.length > 0 ? options : undefined,
      };

      const emitted = this.emitIfNew(sessionName, match, tailLines);
      if (emitted) {
        this.llmRelayTimestamps.set(sessionName, Date.now());
      }
    } catch {
      // LLM call failed — silent fallback (regex-only detection continues)
    }
  }

  /**
   * Called when input is sent to a session — clears dedup cache
   * since the prompt has been answered.
   *
   * Also clears the per-session 5-minute LLM relay cooldown so that
   * a follow-up prompt (e.g. the next question in a multi-question form)
   * isn't silently blocked. Rate-limiting on the LLM call is still
   * provided by stableCount + post-emission cooldown.
   */
  onInputSent(sessionName: string): void {
    this.emittedPrompts.delete(sessionName);
    this.stableCount.delete(sessionName);
    this.lastOutput.delete(sessionName);
    this.lastEmissionTime.delete(sessionName); // Clear cooldown so new prompts can fire
    this.llmRelayTimestamps.delete(sessionName); // Allow LLM to fire for follow-up prompts
    this.noPromptCache.delete(sessionName); // Cleared so post-input output gets re-classified
    // Bump generation so any mid-flight llmDetect drops its NO_PROMPT write.
    this.cacheGeneration.set(sessionName, (this.cacheGeneration.get(sessionName) ?? 0) + 1);
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
    this.llmRelayTimestamps.delete(sessionName);
    this.pendingLlmDetection.delete(sessionName);
    this.noPromptCache.delete(sessionName);
    // Bump generation so any in-flight llmDetect for this session drops
    // its NO_PROMPT write. The generation entry itself is left in place —
    // it is tiny and a future llmDetect on the same session name (e.g. a
    // session restart that reuses the name) will pick up from here.
    this.cacheGeneration.set(sessionName, (this.cacheGeneration.get(sessionName) ?? 0) + 1);
  }

  /**
   * Record a NO_PROMPT classification for the given session and context
   * fingerprint, evicting the oldest entry if the per-session cache exceeds
   * NO_PROMPT_CACHE_MAX. FIFO is sufficient — these are pure memoizations of
   * an LLM verdict on a specific terminal-output snapshot.
   *
   * Drops the write if the cache generation has advanced since llmDetect
   * started — that means onInputSent or cleanup fired during the LLM call,
   * and our verdict was computed against output the session has now moved
   * past. Without this guard, the post-input cache could get repopulated
   * with a stale pre-input verdict.
   */
  private recordNoPrompt(sessionName: string, fingerprint: string, callGeneration: number): void {
    const currentGen = this.cacheGeneration.get(sessionName) ?? 0;
    if (currentGen !== callGeneration) return;

    let entry = this.noPromptCache.get(sessionName);
    if (!entry) {
      entry = { set: new Set(), order: [] };
      this.noPromptCache.set(sessionName, entry);
    }
    if (entry.set.has(fingerprint)) return;
    entry.set.add(fingerprint);
    entry.order.push(fingerprint);
    while (entry.order.length > InputDetector.NO_PROMPT_CACHE_MAX) {
      const evicted = entry.order.shift();
      if (evicted) entry.set.delete(evicted);
    }
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
