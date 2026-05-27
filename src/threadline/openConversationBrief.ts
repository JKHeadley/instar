/**
 * openConversationBrief — builds the topic NAME + first-message SUMMARY for a
 * Threadline conversation being promoted into its own topic via "open this"
 * (CMT-567, continuation of the deterministic intercept in CMT-529).
 *
 * Three tiers, best-quality-first, each degrading WITHOUT ever failing the bind
 * (the caller `bindHubConversation` must always get a non-empty name + summary):
 *
 *   Tier A — LLM:      a real conversation (>=2 messages) → a Haiku call using the
 *                      proven PURPOSE-line convention (NOT JSON — see TopicSummarizer).
 *                      PURPOSE → name, body → summary. Runs on the `interactive`
 *                      lane (the operator is watching for the topic to appear).
 *   Tier B — template: deterministic brief from data already on hand (peer,
 *                      message count, last activity, last inbound line). Zero cost,
 *                      zero latency. Used when the LLM tier is skipped or fails.
 *   Tier C — slug:     no backing conversation at all (a hub-notice-only entry) →
 *                      slug name + the legacy tie-marker.
 *
 * The LLM is a GENERATOR, never a gate: any failure degrades the result, never
 * blocks the bind. Spec: docs/specs/THREADLINE-OPEN-THIS-LLM-NAMING-SPEC.md.
 */

import type { IntelligenceProvider } from '../core/types.js';
import type { LlmQueue } from '../monitoring/LlmQueue.js';
import { parsePurposeFromResponse } from '../memory/TopicSummarizer.js';

/** A scrubbed, never-empty name + summary for a newly-opened topic. */
export interface ConversationBrief {
  /** ≤ 40 chars, scrubbed, NEVER empty. */
  topicName: string;
  /** ≤ 600 chars, scrubbed, NEVER empty. */
  summary: string;
  /** Where each field actually came from (observability). */
  nameSource: 'llm' | 'template' | 'slug';
  summarySource: 'llm' | 'template' | 'slug';
  /** One-word reason for any non-LLM outcome — feeds the Fix-1d log line. */
  reason: 'ok' | 'no-conversation' | 'too-few-messages' | 'no-deps'
        | 'llm-timeout' | 'llm-abort' | 'llm-capped' | 'llm-error'
        | 'parse-empty' | 'credential-scrub';
  /** Wall-clock ms spent in this call (mostly the LLM wait). */
  latencyMs: number;
}

/** Minimal shape of a threadline message row (subset of ThreadlineMessageRow). */
interface BriefMessageRow {
  direction: 'in' | 'out';
  text: string;
  remoteAgentName: string;
  timestamp: string;
}

export interface BriefDeps {
  observability: { getThread(threadId: string): { messages: BriefMessageRow[] } | null } | null;
  llmQueue: LlmQueue | null;
  intelligence: Pick<IntelligenceProvider, 'evaluate'> | null;
  /**
   * Existing topicNameFor() — always returns a non-empty slug. Optional: the
   * server-built `briefDeps` doesn't carry it (topicNameFor is private to
   * hubCommands); `bindHubConversation` injects the real one so the brief's slug
   * matches the legacy path. A built-in default guards direct callers.
   */
  topicNameFallback?: (conv: unknown, threadId: string) => string;
  now?: () => number;
}

/** Minimal built-in slug used only when no topicNameFallback is supplied. */
function defaultSlug(conv: BriefConversation | null, threadId: string): string {
  const peer = (conv?.remoteAgent || conv?.participants?.peers?.[0] || 'agent').replace(/[^\w-]/g, '').slice(0, 24) || 'agent';
  return `${peer} · ${(threadId || 'thread').slice(0, 8)}`;
}

/** Conversation fields the brief reads (subset of the ConversationStore record). */
export interface BriefConversation {
  subject?: string;
  participants?: { peers?: string[] };
  remoteAgent?: string;
  lastInboundHash?: string;
  messageCount?: number;
  lastActivityAt?: string;
}

const NAME_MAX = 40;
const SUMMARY_MAX = 600;
const SNIPPET_MAX = 200;
const MIN_NAME = 4;
const LEGACY_MARKER = '💬 This Threadline conversation is now tied to this topic — updates will land here.';

// A literal secret VALUE (vendor-prefixed token, key block, long bearer-ish blob).
// Used on LLM output (a name/summary): the english words "token"/"password"/"secret"
// appear constantly in legitimate technical conversation ("token refresh", "API key
// rotation") — matching them would degrade most real summaries. We only block actual
// credential-looking VALUES here, not topic vocabulary.
const SECRET_VALUE_RE = /(sk-[A-Za-z0-9]{6,}|xox[baprs]-[A-Za-z0-9-]{6,}|gh[pousr]_[A-Za-z0-9]{6,}|AKIA[0-9A-Z]{8,}|-----BEGIN[ A-Z]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,})/;
// An assignment form ("password: hunter2", "api_key=abc123…") — only checked on RAW
// inbound message text (the Tier-B snippet), where a literal value could be pasted.
const SECRET_ASSIGN_RE = /(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|bearer)\s*[:=]\s*\S{6,}/i;

/** A leaked credential VALUE in LLM-authored prose (name/summary). */
function hasSecretValue(s: string): boolean {
  return SECRET_VALUE_RE.test(s);
}

/** A credential in RAW message text — value OR assignment form. */
function hasSecretInRaw(s: string): boolean {
  return SECRET_VALUE_RE.test(s) || SECRET_ASSIGN_RE.test(s);
}

/** Scrub + cap a candidate topic name. Returns null if it must degrade. */
function scrubName(raw: string): string | null {
  const collapsed = (raw ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!collapsed || hasSecretValue(collapsed)) return null;
  let capped = collapsed.slice(0, NAME_MAX).trim();
  // Cap on a word boundary so a long title doesn't read "…path resol".
  if (collapsed.length > NAME_MAX) {
    const lastSpace = capped.lastIndexOf(' ');
    if (lastSpace >= MIN_NAME) capped = capped.slice(0, lastSpace).trim();
  }
  if (capped.length < MIN_NAME) return null;
  return capped;
}

/** Scrub + cap a candidate summary. Returns null if it must degrade. */
function scrubSummary(raw: string): string | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed || hasSecretValue(trimmed)) return null;
  if (trimmed.length <= SUMMARY_MAX) return trimmed;
  // Cap on a word boundary at/under the limit.
  const slice = trimmed.slice(0, SUMMARY_MAX);
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > SUMMARY_MAX - 80 ? slice.slice(0, lastSpace) : slice).trim();
}

function peerName(conv: BriefConversation | null): string {
  return conv?.remoteAgent || conv?.participants?.peers?.[0] || 'an agent';
}

function relativeTime(iso: string | undefined, now: number): string {
  if (!iso) return 'recently';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'recently';
  const mins = Math.max(0, Math.round((now - then) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/**
 * Tier-B deterministic template summary. Always non-empty; scrubs the inbound
 * snippet (a cold first message could carry a secret).
 */
function templateSummary(
  conv: BriefConversation | null,
  messages: BriefMessageRow[],
  now: number,
): string {
  const peer = peerName(conv);
  const count = messages.length || conv?.messageCount || 0;
  const lastInbound = [...messages].reverse().find((m) => m.direction === 'in');
  const rawSnippet = (lastInbound?.text ?? conv?.lastInboundHash ?? '').trim();
  const snippet = rawSnippet && !hasSecretInRaw(rawSnippet)
    ? rawSnippet.replace(/\s+/g, ' ').slice(0, SNIPPET_MAX)
    : '';

  if (count <= 1) {
    const head = `💬 Conversation with ${peer} · just getting started.`;
    return snippet ? `${head}\nOpening message: "${snippet}"` : head;
  }
  const when = relativeTime(conv?.lastActivityAt ?? lastInbound?.timestamp, now);
  const head = `💬 Conversation with ${peer} · ${count} messages · last activity ${when}.`;
  return snippet ? `${head}\nLatest: "${snippet}"` : head;
}

function buildLlmPrompt(messages: BriefMessageRow[]): string {
  const recent = messages.slice(-10).map((m) => {
    const who = m.direction === 'in' ? (m.remoteAgentName || 'them') : 'me';
    const text = m.text.length > 800 ? `${m.text.slice(0, 800)}…` : m.text;
    return `${who}: ${text}`;
  });
  return [
    'You are preparing a forum topic for an operator who is about to open an ongoing',
    'agent-to-agent conversation into its own space. Write a short topic title and a',
    'brief orientation summary.',
    '',
    'Conversation (last messages, oldest → newest, each side labelled):',
    '<<<',
    recent.join('\n'),
    '>>>',
    '',
    'FORMAT — your response MUST be exactly:',
    'PURPOSE: <a 4-6 word title naming what this conversation is ABOUT — not who spoke,',
    '         no IDs, no emoji, no quotes>',
    '',
    '<2-4 plain sentences: who the other agent is, what this is about, and where it',
    ' currently stands (open question / decision pending / waiting on X). No markdown.>',
  ].join('\n');
}

/**
 * Build the name + summary for a conversation being opened into its own topic.
 * NEVER throws — always returns a usable, non-empty ConversationBrief.
 */
export async function generateConversationBrief(
  threadId: string,
  conv: BriefConversation | null,
  deps: BriefDeps,
  opts?: { timeoutMs?: number },
): Promise<ConversationBrief> {
  const now = (deps.now ?? Date.now)();
  // 15s default: a real Claude/Codex CLI call on a ~10-message thread measured
  // ~8s end-to-end during test-as-self (CLI cold-start dominates), so the
  // original 3.5s budget would have timed out the happy path on nearly every
  // real "open this" and silently fallen back to the template. 15s keeps the
  // LLM brief as the common outcome; it's a one-shot operator action, the call
  // is non-blocking (onTopicMessage is non-await/non-serial), and the template
  // still covers any call that overruns.
  const timeoutMs = opts?.timeoutMs ?? 15000;
  const slug = (deps.topicNameFallback ?? defaultSlug)(conv, threadId);

  // Tier C — no backing conversation at all.
  if (!conv) {
    return {
      topicName: slug, summary: LEGACY_MARKER,
      nameSource: 'slug', summarySource: 'slug', reason: 'no-conversation', latencyMs: 0,
    };
  }

  const messages = deps.observability?.getThread(threadId)?.messages ?? [];

  // Tier C — a conversation record exists but there's nothing to summarize.
  if (messages.length === 0) {
    return {
      topicName: slug, summary: LEGACY_MARKER,
      nameSource: 'slug', summarySource: 'slug', reason: 'no-conversation', latencyMs: 0,
    };
  }

  const tmpl = templateSummary(conv, messages, now);

  // Tier B (no LLM possible): deps missing.
  if (!deps.llmQueue || !deps.intelligence) {
    return {
      topicName: slug, summary: tmpl,
      nameSource: 'slug', summarySource: 'template', reason: 'no-deps', latencyMs: 0,
    };
  }

  // Tier B (LLM skipped): too few messages to be worth a call.
  if (messages.length < 2) {
    return {
      topicName: slug, summary: tmpl,
      nameSource: 'slug', summarySource: 'template', reason: 'too-few-messages', latencyMs: 0,
    };
  }

  // Tier A — LLM. Any failure degrades to the Tier-B template (per-field for scrub).
  const prompt = buildLlmPrompt(messages);
  const intelligence = deps.intelligence;
  let llmReason: ConversationBrief['reason'] = 'ok';
  let raw = '';
  try {
    raw = await deps.llmQueue.enqueue('interactive', async (signal) => {
      return await Promise.race([
        intelligence.evaluate(prompt, { model: 'fast', maxTokens: 320, timeoutMs, attribution: { component: 'openConversationBrief' } }),
        new Promise<never>((_, reject) => {
          const t = setTimeout(() => reject(new Error('LLM timeout')), timeoutMs);
          signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('LLM aborted')); });
        }),
      ]);
    }, 2);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    llmReason = /abort/i.test(msg) ? 'llm-abort'
      : /cap/i.test(msg) ? 'llm-capped'
      : /timeout/i.test(msg) ? 'llm-timeout'
      : 'llm-error';
  }

  if (llmReason !== 'ok' || !raw.trim()) {
    return {
      topicName: slug, summary: tmpl,
      nameSource: 'slug', summarySource: 'template',
      reason: llmReason !== 'ok' ? llmReason : 'parse-empty',
      latencyMs: ((deps.now ?? Date.now)()) - now,
    };
  }

  // Parse PURPOSE → name, body → summary. Guard the `body || text` echo edge:
  // a PURPOSE-only response returns the whole "PURPOSE: …" string as body.
  const { purpose, body } = parsePurposeFromResponse(raw.trim());
  const llmName = purpose ? scrubName(purpose) : null;
  const bodyIsRealSummary = !!body && !/^purpose:/i.test(body.trim());
  const llmSummary = bodyIsRealSummary ? scrubSummary(body) : null;

  const credentialScrubbed = (purpose && !llmName) || (bodyIsRealSummary && !llmSummary);

  return {
    topicName: llmName ?? slug,
    summary: llmSummary ?? tmpl,
    nameSource: llmName ? 'llm' : 'slug',
    summarySource: llmSummary ? 'llm' : 'template',
    reason: credentialScrubbed ? 'credential-scrub' : (llmName || llmSummary ? 'ok' : 'parse-empty'),
    latencyMs: ((deps.now ?? Date.now)()) - now,
  };
}

export const __testing = { scrubName, scrubSummary, templateSummary, buildLlmPrompt, relativeTime, LEGACY_MARKER };
