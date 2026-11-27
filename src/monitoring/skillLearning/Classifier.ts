/**
 * Skill Learning Sentinel — the batch classifier (spec §3.1 "Tick", §3.6 `outcomeOfPrevRun`, §4).
 *
 * On every `tick()` it takes ≤ `llm.batchSize` pending request rows, re-reads each message's TEXT from
 * TopicMemory by `source` (the ledger never stores text), bounds it to `HEAD_CHARS` with an in-row
 * `[cut: N chars from the tail]` disclosure, and asks the fast tier — one call per batch, through the
 * shared `LlmQueue` background lane — for strict JSON per row:
 *
 *   `{ id, repeatable, procedureKey, paraphrase, outcomeOfPrevRun }`
 *
 * The prompt carries the topic's current key list so folding is by MEANING (reuse an existing key or
 * propose a new one). `scrubSecrets` runs on the text before the call and on the paraphrase after.
 *
 * Provenance is the PRECONDITION of every verdict (§4 "Unrecorded judgment → refuse"): each row's
 * verdict goes through `JudgmentProvenanceLog.recordDecision` as an arbiter row; a `null` return, or a
 * positive `writeErrors` delta since the last tick, discards the verdict — the row stays pending.
 *
 * A cut row never yields outcome attribution: on the head pass it is re-queued ALONE as `needs-full`
 * (the next tick runs it under the full budget); still cut there, it is classified without
 * `outcomeOfPrevRun`. An admission error (`LlmQueueAdmissionError`), a provider failure, or
 * unparseable output counts toward `classifierFailures24h`, raises a `DegradationReporter` row, and is
 * retried on the NEXT tick — never within one.
 */
import type { IntelligenceProvider } from '../../core/types.js';
import type { DecisionProvenanceBlock } from '../../core/decisionQualityTypes.js';
import { buildBoundedContext, buildStructuredSha256Identity, type DecisionRowInput } from '../../core/JudgmentProvenanceLog.js';
import { DP_SKILL_LEARNING_CLASSIFY } from '../../data/provenanceCoverage.js';
import type { TopicMessage } from '../../memory/TopicMemory.js';
import { scrubSecrets } from '../scrubSecrets.js';
import type { Ledger } from './Ledger.js';
import { newEventId } from './SeamFilter.js';
import type { Outcomes } from './Outcomes.js';
import type { OutcomeLabel, RequestRow, RowSource } from './types.js';

export const COMPONENT = 'skillLearning.classifier';
export const HEAD_CHARS = 2048;
export const FULL_CHARS = 16 * 1024;
export const PARAPHRASE_MAX = 160;
export const PROMPT_ID = 'skill-learning-classifier-v1';
/** Replies the model may give for `outcomeOfPrevRun`; mapped to §3.6 labels below. */
export const OUTCOME_OPTIONS = ['acknowledged', 'corrected', 'redo', 'routine-same-key', 'unrelated', 'none'] as const;
const OUTCOME_LABEL: Record<(typeof OUTCOME_OPTIONS)[number], OutcomeLabel | null> = {
  acknowledged: 'accepted', corrected: 'corrected', redo: 'redo', 'routine-same-key': 'accepted-inferred', unrelated: 'weak-positive', none: null,
};
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/;
const TEXT_MISS_LIMIT = 3;
const DAY_MS = 86_400_000;

/** `JudgmentProvenanceLog` as the classifier needs it (the real class satisfies this). */
export interface ProvenanceLike {
  recordDecision(input: DecisionRowInput): string | null;
  status(): { counters: Record<string, number> };
}

export interface DegradationLike {
  report(event: { feature: string; primary: string; fallback: string; reason: string; impact: string; internalOnly?: boolean }): void;
}

export interface ClassifierDeps {
  ledger: Ledger;
  machineId: string;
  topicMemory: { getMessagesSince(topicId: number, sinceIso: string, limit?: number): { messages: TopicMessage[]; complete: boolean } } | null;
  intelligence: IntelligenceProvider | null;
  queue: { enqueue(lane: 'background', fn: (signal: AbortSignal) => Promise<string>, costCents?: number): Promise<string> };
  provenance: ProvenanceLike | null;
  degradation?: DegradationLike | null;
  outcomes?: Outcomes;
  batchSize: number;
  /** Estimated cents per batch call, for the queue's daily cap. Default 1. */
  costCentsPerCall?: number;
  /** Days an unreadable row is held before the classifier retries it (`shadow.verdictReaskDays`). Default 14. */
  retryAfterDays?: number;
  now?: () => number;
  logger?: (message: string) => void;
}

export interface ClassifierCounters {
  ticks: number;
  llmCalls: number;
  classified: number;
  needsFull: number;
  cutNoAttribution: number;
  outcomesAttributed: number;
  discardedUnrecorded: number;
  provenanceSkippedTicks: number;
  textMisses: number;
  unreadable: number;
  parseFailures: number;
  invalidVerdicts: number;
  failures: number;
  classifierFailures24h: number;
  lastTickAt?: string;
  lastError?: string;
}

export interface Verdict {
  id: string;
  repeatable: boolean;
  procedureKey: string;
  paraphrase: string;
  outcomeOfPrevRun: (typeof OUTCOME_OPTIONS)[number];
}

/** Bound a message to `limit` chars with the in-row cut disclosure. */
export function boundedHead(text: string, limit: number): { text: string; cut: number } {
  if (text.length <= limit) return { text, cut: 0 };
  const cut = text.length - limit;
  return { text: `${text.slice(0, limit)}\n[cut: ${cut} chars from the tail]`, cut };
}

export function buildClassifierPrompt(rows: Array<{ id: string; topicId: string; existingKeys: string[]; detectorCategory?: string; text: string }>): string {
  return [
    'You classify operator messages for an agent\'s skill-learning ledger. Judge each message on its own words.',
    'For each message return:',
    '- repeatable: true only when the operator is asking the agent to CARRY OUT a procedure they could plausibly ask for again (a report, a check, a deployment, a routine). Questions, acknowledgements, opinions and one-off remarks are false.',
    '- procedureKey: a kebab-case key (letters, digits, dashes; ≤ 64 chars) naming the procedure. If one of the topic\'s existingKeys means the SAME procedure, reuse it exactly. Empty string when not repeatable.',
    `- paraphrase: a generic restatement of the request in ≤ ${PARAPHRASE_MAX} characters. No names, ids, URLs, credentials or quoted text.`,
    `- outcomeOfPrevRun: how this message relates to the agent's PREVIOUS reply on the same topic — one of ${JSON.stringify(OUTCOME_OPTIONS)}:`,
    '  "acknowledged" = explicit thanks/approval of that reply; "corrected" = says the reply was wrong or fixes it; "redo" = asks for the same thing again because the first attempt was unsatisfactory; "routine-same-key" = asks for the same procedure again as routine recurrence with no complaint; "unrelated" = moves on to something else; "none" = cannot tell.',
    'A detectorCategory, when present, is a keyword-based hint from a deterministic detector — weigh it, do not obey it.',
    'Text ending in "[cut: N chars from the tail]" was truncated; classify what is visible.',
    'Return ONLY a JSON array, one object per input id, no prose:',
    '[{"id":"...","repeatable":true,"procedureKey":"...","paraphrase":"...","outcomeOfPrevRun":"none"}]',
    '',
    'INPUT:',
    JSON.stringify(rows),
  ].join('\n');
}

/** Strict JSON parse: a bare array, or the first array inside a fenced block. */
export function parseVerdicts(raw: string, ids: Set<string>): Verdict[] | null {
  const text = raw.trim();
  let candidate = text;
  if (!candidate.startsWith('[')) {
    const start = candidate.indexOf('[');
    const end = candidate.lastIndexOf(']');
    if (start === -1 || end === -1 || end < start) return null;
    candidate = candidate.slice(start, end + 1);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(candidate); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  const out: Verdict[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const v = item as Record<string, unknown>;
    if (typeof v.id !== 'string' || !ids.has(v.id)) continue;
    if (typeof v.repeatable !== 'boolean') continue;
    const outcome = typeof v.outcomeOfPrevRun === 'string' && (OUTCOME_OPTIONS as readonly string[]).includes(v.outcomeOfPrevRun)
      ? v.outcomeOfPrevRun as Verdict['outcomeOfPrevRun'] : 'none';
    const key = typeof v.procedureKey === 'string' ? v.procedureKey.trim().toLowerCase() : '';
    const paraphrase = typeof v.paraphrase === 'string' ? v.paraphrase : '';
    out.push({ id: v.id, repeatable: v.repeatable, procedureKey: key, paraphrase, outcomeOfPrevRun: outcome });
  }
  return out;
}

export class Classifier {
  private readonly deps: ClassifierDeps;
  private readonly now: () => number;
  private readonly c: ClassifierCounters = {
    ticks: 0, llmCalls: 0, classified: 0, needsFull: 0, cutNoAttribution: 0, outcomesAttributed: 0, discardedUnrecorded: 0,
    provenanceSkippedTicks: 0, textMisses: 0, unreadable: 0, parseFailures: 0, invalidVerdicts: 0, failures: 0, classifierFailures24h: 0,
  };
  private readonly failureTimes: number[] = [];
  private readonly textMissCount = new Map<string, number>();
  private lastWriteErrors: number | null = null;
  private running = false;

  constructor(deps: ClassifierDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  counters(): ClassifierCounters {
    const since = this.now() - DAY_MS;
    while (this.failureTimes.length && this.failureTimes[0] < since) this.failureTimes.shift();
    return { ...this.c, classifierFailures24h: this.failureTimes.length };
  }

  /** One batch. Returns the number of rows classified (or re-queued) this tick. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try { return await this.runTick(); } finally { this.running = false; }
  }

  private async runTick(): Promise<number> {
    this.c.ticks++;
    this.c.lastTickAt = new Date(this.now()).toISOString();
    const { ledger, provenance } = this.deps;
    if (!provenance) { this.c.provenanceSkippedTicks++; this.c.lastError = 'provenance unavailable — verdicts refused'; return 0; }
    // Fail-closed (c): a write error since the last tick means the record cannot be trusted; refuse the tick.
    const writeErrors = provenance.status().counters.writeErrors ?? 0;
    if (this.lastWriteErrors !== null && writeErrors > this.lastWriteErrors) {
      this.lastWriteErrors = writeErrors;
      this.c.provenanceSkippedTicks++;
      this.c.lastError = 'provenance write errors since last tick — verdicts refused';
      return 0;
    }
    this.lastWriteErrors = writeErrors;

    let batch = ledger.pendingRows(Math.max(1, this.deps.batchSize));
    if (batch.length === 0) return 0;
    const fullPass = batch[0].state === 'needs-full';
    if (fullPass) batch = [batch[0]];
    const limit = fullPass ? FULL_CHARS : HEAD_CHARS;

    const items: Array<{ row: RequestRow; text: string; cut: number }> = [];
    let handled = 0;
    for (const row of batch) {
      const text = this.fetchText(row);
      if (text === null) {
        const k = sourceId(row.source);
        const misses = (this.textMissCount.get(k) ?? 0) + 1;
        this.textMissCount.set(k, misses);
        this.c.textMisses++;
        if (misses >= TEXT_MISS_LIMIT) { if (this.classifyUnreadable(row)) handled++; }
        continue;
      }
      const bounded = boundedHead(scrubSecrets(text), limit);
      items.push({ row, text: bounded.text, cut: bounded.cut });
    }
    if (items.length === 0) return handled;

    const promptRows = items.map(({ row, text }) => ({
      id: row.eventId, topicId: row.topicId, existingKeys: ledger.keysForTopic(row.topicId),
      ...(row.detectorCategory ? { detectorCategory: row.detectorCategory } : {}), text,
    }));
    const prompt = buildClassifierPrompt(promptRows);
    const ids = new Set(items.map((i) => i.row.eventId));

    let raw: string;
    try {
      const intelligence = this.deps.intelligence;
      if (!intelligence) throw new Error('no intelligence provider');
      this.c.llmCalls++;
      raw = await this.deps.queue.enqueue('background', (signal) => intelligence.evaluate(prompt, {
        signal,
        model: 'fast',
        maxTokens: Math.min(8192, 256 + items.length * 160),
        temperature: 0,
        attribution: { component: 'skillLearning.classifier', category: 'reflector', deferrable: true },
        provenance: this.provenanceBlock(prompt, promptRows.length),
      }), this.deps.costCentsPerCall ?? 1);
    } catch (err) {
      this.failure(`classifier call failed: ${err instanceof Error ? err.message : String(err)}`);
      return handled;
    }

    const verdicts = parseVerdicts(raw, ids);
    if (verdicts === null) {
      this.c.parseFailures++;
      this.failure('classifier returned unparseable output');
      return handled;
    }
    const byId = new Map(verdicts.map((v) => [v.id, v]));
    for (const item of items) {
      const v = byId.get(item.row.eventId);
      if (!v) { this.c.invalidVerdicts++; continue; }
      if (this.applyVerdict(item.row, v, { cut: item.cut > 0, fullPass, promptChars: prompt.length })) handled++;
    }
    return handled;
  }

  // ─── Per-row verdict ─────────────────────────────────────────────────

  private applyVerdict(row: RequestRow, v: Verdict, ctx: { cut: boolean; fullPass: boolean; promptChars: number }): boolean {
    const { ledger, provenance } = this.deps;
    if (!provenance) return false;
    const key = v.repeatable ? v.procedureKey : '';
    if (v.repeatable && !KEY_RE.test(key)) { this.c.invalidVerdicts++; return false; }
    const paraphrase = scrubSecrets(v.paraphrase).replace(/\s+/g, ' ').trim().slice(0, PARAPHRASE_MAX);
    const requeue = ctx.cut && !ctx.fullPass;
    const decision = requeue ? 'needs-full' : v.repeatable ? `record:${key}` : 'not-repeatable';

    // Provenance is the precondition: no record, no action.
    const before = provenance.status().counters.writeErrors ?? 0;
    const id = provenance.recordDecision({
      component: COMPONENT,
      decisionPoint: DP_SKILL_LEARNING_CLASSIFY,
      context: buildBoundedContext({
        sourceIdentitySha256: buildStructuredSha256Identity(sourceId(row.source)),
        topicId: row.topicId, identity: row.identity, detectorCategory: row.detectorCategory ?? null,
        existingKeys: ledger.keysForTopic(row.topicId).length, cut: ctx.cut, fullPass: ctx.fullPass, promptChars: ctx.promptChars,
      }),
      optionsPresented: ['record', 'fold', 'not-repeatable', 'needs-full', ...OUTCOME_OPTIONS],
      decision,
      reason: requeue ? 'head pass was cut — re-run alone under the full budget' : `outcomeOfPrevRun=${v.outcomeOfPrevRun}`,
      floor: 'conservative default: not recorded; a cut row never attributes an outcome; verdict refused without a provenance record',
      fallbackRung: 'arbiter:fast-tier-batch',
      arbiter: true,
      promptId: PROMPT_ID,
      contentClass: 'content-bearing',
    });
    const after = provenance.status().counters.writeErrors ?? 0;
    if (id === null || after > before) {
      this.c.discardedUnrecorded++;
      this.lastWriteErrors = after;
      return false; // the row stays pending
    }

    if (requeue) {
      ledger.append({ ...row, eventId: newEventId(), state: 'needs-full', machineId: this.deps.machineId });
      this.c.needsFull++;
      return true;
    }
    const { procedureKey: _priorKey, paraphrase: _priorParaphrase, ...base } = row;
    const classified: RequestRow = {
      ...base, eventId: newEventId(), state: 'classified', repeatable: v.repeatable, machineId: this.deps.machineId,
      ...(key ? { procedureKey: key } : {}), ...(paraphrase ? { paraphrase } : {}),
    };
    ledger.append(classified);
    this.c.classified++;
    this.deps.outcomes?.noteClassified(classified);

    if (ctx.cut) { this.c.cutNoAttribution++; return true; }
    const label = OUTCOME_LABEL[v.outcomeOfPrevRun];
    if (label && this.deps.outcomes) {
      const r = this.deps.outcomes.applyVerdict({ closingSource: row.source, label, ...(key ? { procedureKey: key } : {}) });
      if (r !== 'none') this.c.outcomesAttributed++;
    }
    return true;
  }

  /**
   * After TEXT_MISS_LIMIT ticks without the text, the deterministic rung HOLDS the row (`needs-full` with
   * `retryAfter = now + retryAfterDays`) instead of settling it: the text may land later (catch-up, a
   * restored TopicMemory), and a permanent not-repeatable would silently erase a real recurrence. Not an
   * arbiter decision (`arbiter: false`) — no model was asked.
   */
  private classifyUnreadable(row: RequestRow): boolean {
    const { ledger, provenance } = this.deps;
    if (!provenance) return false;
    const days = this.deps.retryAfterDays && this.deps.retryAfterDays > 0 ? this.deps.retryAfterDays : 14;
    const retryAfter = new Date(this.now() + days * DAY_MS).toISOString();
    const before = provenance.status().counters.writeErrors ?? 0;
    const id = provenance.recordDecision({
      component: COMPONENT, decisionPoint: DP_SKILL_LEARNING_CLASSIFY,
      context: buildBoundedContext({ sourceIdentitySha256: buildStructuredSha256Identity(sourceId(row.source)), topicId: row.topicId, textMisses: TEXT_MISS_LIMIT, retryAfter }),
      optionsPresented: ['record', 'fold', 'wait'], decision: 'wait',
      reason: `message text unavailable in TopicMemory after ${TEXT_MISS_LIMIT} ticks — held until ${retryAfter}, then retried`,
      floor: 'conservative default: not recorded; a hold, never a permanent verdict', fallbackRung: 'deterministic', arbiter: false, promptId: PROMPT_ID, contentClass: 'metadata',
    });
    if (id === null || (provenance.status().counters.writeErrors ?? 0) > before) { this.c.discardedUnrecorded++; return false; }
    ledger.append({ ...row, eventId: newEventId(), state: 'needs-full', retryAfter, machineId: this.deps.machineId });
    this.c.unreadable++;
    this.textMissCount.delete(sourceId(row.source));
    return true;
  }

  private failure(reason: string): void {
    this.c.failures++;
    this.c.lastError = reason;
    this.failureTimes.push(this.now());
    this.deps.logger?.(`[SkillLearning/Classifier] ${reason}`);
    try {
      this.deps.degradation?.report({
        feature: 'skill-learning-classifier',
        primary: 'batch-classify pending request rows on the fast tier',
        fallback: 'rows stay pending; retried next tick (visible backlog)',
        reason,
        impact: 'skill-learning recurrence evidence lags until the classifier recovers',
        internalOnly: true,
      });
    } catch { /* observability must never break the tick */ }
  }

  private provenanceBlock(prompt: string, rows: number): DecisionProvenanceBlock {
    return {
      decisionPoint: DP_SKILL_LEARNING_CLASSIFY,
      context: buildBoundedContext({ promptIdentitySha256: buildStructuredSha256Identity(prompt), promptChars: prompt.length, rows }),
      optionsPresented: ['record', 'fold', 'not-repeatable', 'needs-full', ...OUTCOME_OPTIONS],
      promptId: PROMPT_ID,
    };
  }

  /** The message text, re-read from TopicMemory by source (messageId first, then the exact timestamp). */
  private fetchText(row: RequestRow): string | null {
    const tm = this.deps.topicMemory;
    if (!tm) return null;
    const topicId = Number(row.topicId);
    if (!Number.isFinite(topicId)) return null;
    const sinceMs = Date.parse(row.at);
    const since = Number.isFinite(sinceMs) ? new Date(sinceMs - 1000).toISOString() : row.at;
    let messages: TopicMessage[];
    try { messages = tm.getMessagesSince(topicId, since, 200).messages; } catch { return null; }
    const wantId = Number(row.source.messageId);
    const byId = Number.isFinite(wantId) && wantId > 0 ? messages.find((m) => m.messageId === wantId && m.fromUser) : undefined;
    const hit = byId ?? messages.find((m) => m.fromUser && m.timestamp === row.at);
    return hit ? hit.text : null;
  }
}

function sourceId(source: RowSource): string {
  return `${source.channel}:${source.chatId}:${source.messageId}`;
}
