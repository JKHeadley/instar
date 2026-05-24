/**
 * HumanAsDetectorLog — treats every human-caught coherence break as a
 * first-class diagnostic signal about which automated layer FAILED.
 *
 * The insight (Dawn's 2026-04-26 Lesson, "Justin Pointing Things Out =
 * Guardian Failure"): when a human has to surface something wrong — a stale
 * claim, a contradiction, a state incoherence — that is not a normal input to
 * be quietly fixed. It is evidence that some monitor/gate/guardian that was
 * supposed to catch it didn't. Logging these over time produces a heat map of
 * "where the human is doing the system's job," which tells you which automated
 * layers are dead weight and which coverage gaps are real.
 *
 * Instar already has CoherenceMonitor, CoherenceGate, and DegradationReporter —
 * but all of those watch the system's OWN state. None of them treat a human
 * correction as a signal. This closes that gap.
 *
 * Pattern mirrors DegradationReporter: singleton, configure() at startup,
 * append-only JSONL persistence, best-effort and never throws into the caller.
 *
 * Usage:
 *   const log = HumanAsDetectorLog.getInstance();
 *   log.configure({ stateDir, agentName });
 *   // On every inbound human message:
 *   log.observe({ text, topicId, messageId, source: 'telegram' });
 *
 * Ported from Dawn's human-as-detector.jsonl infrastructure.
 */

import fs from 'node:fs';
import path from 'node:path';

/** A detected human-as-detector signal. */
export interface HumanDetectorSignal {
  /** ISO timestamp when the signal was recorded */
  ts: string;
  /** Where the correction arrived from (telegram, slack, lifeline, ...) */
  source: string;
  /** Topic/channel id, if known */
  topicId: number | null;
  /** Message id, if known */
  messageId: number | null;
  /** Coarse classification of what kind of break the human surfaced */
  category: HumanDetectorCategory;
  /** Which automated layer should plausibly have caught this first */
  suspectedFailedLayer: string;
  /** Confidence the message really is a human-caught coherence break */
  confidence: 'low' | 'medium' | 'high';
  /** Why the classifier fired (the signal phrases it matched) */
  matchedSignals: string[];
  /** Short preview of the human's message (truncated) */
  messagePreview: string;
}

export type HumanDetectorCategory =
  | 'factual-correction'      // "that's wrong", "actually X is Y"
  | 'staleness'               // "out of date", "you said that days ago"
  | 'contradiction'           // "but you just said", "that contradicts"
  | 'source-of-truth-drift'   // "the record says X but you said Y"
  | 'repeat-ask'              // "I already told you", "again?"
  | 'meta-failure';           // "why didn't the system catch this"

interface SignalRule {
  /** Regex tested against the lowercased message text */
  pattern: RegExp;
  category: HumanDetectorCategory;
  /** Which guardian/monitor should have caught this class of break */
  suspectedLayer: string;
  /** Weight toward confidence */
  weight: number;
  /** Human-readable label for matchedSignals */
  label: string;
}

// Conservative signal set — biased toward precision over recall. A missed
// signal is a lost data point; a false positive pollutes the heat map.
const SIGNAL_RULES: SignalRule[] = [
  { pattern: /\bthat'?s (not right|wrong|incorrect|false)\b/, category: 'factual-correction', suspectedLayer: 'CoherenceGate / output-sanity', weight: 3, label: "that's wrong" },
  { pattern: /\b(this|that) is (wrong|incorrect|false)\b/, category: 'factual-correction', suspectedLayer: 'CoherenceGate / output-sanity', weight: 3, label: 'this is wrong' },
  { pattern: /\byou (said|claimed|told me)\b.*\b(but|however|actually|not)\b/, category: 'contradiction', suspectedLayer: 'CoherenceMonitor (self-claim consistency)', weight: 3, label: 'you said X but' },
  { pattern: /\bthat contradicts\b|\bcontradicts what\b/, category: 'contradiction', suspectedLayer: 'CoherenceMonitor (self-claim consistency)', weight: 3, label: 'contradicts' },
  { pattern: /\b(out of date|outdated|stale|no longer true|already (resolved|fixed|done))\b/, category: 'staleness', suspectedLayer: 'freshness-gate / state-of-truth registry', weight: 3, label: 'stale/outdated' },
  { pattern: /\bthe (record|registry|state|file) says\b/, category: 'source-of-truth-drift', suspectedLayer: 'source-of-truth registry sync', weight: 2, label: 'record says' },
  { pattern: /\bi (already (told|said)|just told you)\b/, category: 'repeat-ask', suspectedLayer: 'commitment/memory recall', weight: 2, label: 'I already told you' },
  { pattern: /\bwhy (didn'?t|did no|wasn'?t).*(catch|caught|detect|flag|notice)\b/, category: 'meta-failure', suspectedLayer: 'guardian coverage (no owner)', weight: 3, label: 'why not caught' },
  { pattern: /\bactually,?\s/, category: 'factual-correction', suspectedLayer: 'CoherenceGate / output-sanity', weight: 1, label: 'actually,' },
  { pattern: /\bthat'?s not (what|how)\b/, category: 'factual-correction', suspectedLayer: 'CoherenceGate / output-sanity', weight: 2, label: "that's not what/how" },
];

const PREVIEW_MAX = 220;

export class HumanAsDetectorLog {
  private static instance: HumanAsDetectorLog | null = null;

  private stateDir: string | null = null;
  private agentName = 'unknown';
  /** In-memory ring of recent signals (for health/summary without disk reads) */
  private recent: HumanDetectorSignal[] = [];

  private constructor() {}

  static getInstance(): HumanAsDetectorLog {
    if (!HumanAsDetectorLog.instance) {
      HumanAsDetectorLog.instance = new HumanAsDetectorLog();
    }
    return HumanAsDetectorLog.instance;
  }

  /** Reset singleton for testing. */
  static resetForTesting(): void {
    HumanAsDetectorLog.instance = null;
  }

  configure(opts: { stateDir: string; agentName?: string }): void {
    this.stateDir = opts.stateDir;
    if (opts.agentName) this.agentName = opts.agentName;
    // Repopulate the in-memory ring from disk so the heat map survives the
    // frequent restarts instar undergoes (auto-update, lifeline coordination).
    this.hydrateFromDisk();
  }

  /**
   * Classify a piece of human text WITHOUT recording it. Pure, deterministic,
   * no I/O — this is the unit-testable core.
   *
   * Returns null if the text doesn't look like a coherence-break correction.
   */
  classify(text: string): {
    category: HumanDetectorCategory;
    suspectedFailedLayer: string;
    confidence: 'low' | 'medium' | 'high';
    matchedSignals: string[];
  } | null {
    if (!text || typeof text !== 'string') return null;
    const lower = text.toLowerCase();

    const matched: SignalRule[] = [];
    for (const rule of SIGNAL_RULES) {
      if (rule.pattern.test(lower)) matched.push(rule);
    }
    if (matched.length === 0) return null;

    // Strongest-weight rule decides the category & suspected layer.
    const top = matched.reduce((a, b) => (b.weight > a.weight ? b : a));
    const totalWeight = matched.reduce((sum, r) => sum + r.weight, 0);

    // A lone weight-1 signal ("actually,") is too weak on its own.
    if (totalWeight < 2) return null;

    const confidence: 'low' | 'medium' | 'high' =
      totalWeight >= 5 ? 'high' : totalWeight >= 3 ? 'medium' : 'low';

    return {
      category: top.category,
      suspectedFailedLayer: top.suspectedLayer,
      confidence,
      matchedSignals: matched.map((r) => r.label),
    };
  }

  /**
   * Observe an inbound human message. If it looks like a coherence-break
   * correction, record it. Returns the recorded signal, or null if the message
   * wasn't a correction. Never throws.
   */
  observe(input: {
    text: string;
    source: string;
    topicId?: number | null;
    messageId?: number | null;
  }): HumanDetectorSignal | null {
    try {
      const verdict = this.classify(input.text);
      if (!verdict) return null;

      const signal: HumanDetectorSignal = {
        ts: new Date().toISOString(),
        source: input.source,
        topicId: input.topicId ?? null,
        messageId: input.messageId ?? null,
        category: verdict.category,
        suspectedFailedLayer: verdict.suspectedFailedLayer,
        confidence: verdict.confidence,
        matchedSignals: verdict.matchedSignals,
        messagePreview: input.text.slice(0, PREVIEW_MAX),
      };

      this.recent.push(signal);
      if (this.recent.length > 200) this.recent = this.recent.slice(-200);

      this.persist(signal);

      // Visible, never silent — mirrors DegradationReporter's console signal.
      console.warn(
        `[HUMAN-AS-DETECTOR] ${signal.category} (${signal.confidence}) — ` +
        `suspected layer that should have caught it: ${signal.suspectedFailedLayer}`,
      );

      return signal;
    } catch {
      // Best-effort — a logging failure must never break message handling.
      return null;
    }
  }

  /** Recent in-memory signals (for health checks / summary endpoint). */
  getRecent(): HumanDetectorSignal[] {
    return [...this.recent];
  }

  /**
   * Summarize signals grouped by suspected failed layer — the heat map of
   * "where the human is doing the system's job."
   */
  summarizeByLayer(): Array<{ layer: string; count: number; categories: string[] }> {
    const byLayer = new Map<string, { count: number; categories: Set<string> }>();
    for (const s of this.recent) {
      const entry = byLayer.get(s.suspectedFailedLayer) ?? { count: 0, categories: new Set<string>() };
      entry.count++;
      entry.categories.add(s.category);
      byLayer.set(s.suspectedFailedLayer, entry);
    }
    return [...byLayer.entries()]
      .map(([layer, v]) => ({ layer, count: v.count, categories: [...v.categories] }))
      .sort((a, b) => b.count - a.count);
  }

  // ── Internal ──────────────────────────────────────────────

  private persist(signal: HumanDetectorSignal): void {
    if (!this.stateDir) return;
    try {
      const dir = path.join(this.stateDir, 'metrics');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const filePath = path.join(dir, 'human-as-detector.jsonl');
      // Persist METADATA ONLY — never the user's raw words. messagePreview
      // stays in the in-memory ring for this session's heat map, but is kept
      // OFF disk so a secret/PII a user types mid-correction can't leak into
      // the append-only audit trail. Mode 0600 is defense-in-depth on the
      // metadata that remains (file mode applies only on creation).
      const { messagePreview: _omitFromDisk, ...metadata } = signal;
      fs.appendFileSync(
        filePath,
        JSON.stringify({ ...metadata, agentName: this.agentName }) + '\n',
        { mode: 0o600 },
      );
    } catch {
      // Disk persistence is best-effort; the console.warn is the safety net.
    }
  }

  /**
   * Best-effort: repopulate the in-memory ring from the last 200 persisted
   * records. The heat map (summarizeByLayer + recent) reads only the ring, so
   * without this it would silently empty on every restart even though the full
   * history is on disk. Persisted records carry no messagePreview (kept off
   * disk by persist()), so hydrated entries have an empty preview — the byLayer
   * counts, which are the point of the heat map, are fully restored.
   */
  private hydrateFromDisk(): void {
    if (!this.stateDir) return;
    try {
      const filePath = path.join(this.stateDir, 'metrics', 'human-as-detector.jsonl');
      if (!fs.existsSync(filePath)) return;
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter((l) => l.trim());
      const hydrated: HumanDetectorSignal[] = [];
      for (const line of lines.slice(-200)) {
        try {
          const r = JSON.parse(line) as Partial<HumanDetectorSignal>;
          if (!r.category || !r.suspectedFailedLayer) continue;
          hydrated.push({
            ts: r.ts ?? '',
            source: r.source ?? 'unknown',
            topicId: r.topicId ?? null,
            messageId: r.messageId ?? null,
            category: r.category,
            suspectedFailedLayer: r.suspectedFailedLayer,
            confidence: r.confidence ?? 'low',
            matchedSignals: r.matchedSignals ?? [],
            messagePreview: r.messagePreview ?? '',
          });
        } catch {
          // skip a malformed line — best-effort hydration
        }
      }
      this.recent = hydrated;
    } catch {
      // unreadable file → start with an empty ring; never throw at startup
    }
  }
}

/** Minimal shape of an inbound message-logged entry the wiring reads. */
export interface InboundMessageEntry {
  fromUser?: boolean;
  text?: string;
  topicId?: number | null;
  messageId?: number | null;
}

/**
 * The gating decision used where the log is chained onto a message adapter's
 * onMessageLogged: observe ONLY inbound HUMAN messages that carry text. Agent
 * messages and empty entries are skipped. Extracted from the server wiring so
 * the inbound-human gate is unit-testable (wiring-integrity), not buried inline.
 */
export function observeInboundMessage(
  log: HumanAsDetectorLog,
  entry: InboundMessageEntry,
  source = 'telegram',
): HumanDetectorSignal | null {
  if (!entry.fromUser || !entry.text) return null;
  return log.observe({
    text: entry.text,
    source,
    topicId: entry.topicId ?? null,
    messageId: entry.messageId ?? null,
  });
}
