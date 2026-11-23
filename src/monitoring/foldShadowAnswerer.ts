/**
 * The shadow answerer (context-budget-layered-summaries §10 "Shadow mode",
 * §9.3 carriers; Phase 2 slice P2-3b).
 *
 * In shadow mode the probe is answered by a THROWAWAY headless session seeded
 * with the staged packet, never by the live session. It runs:
 *  - under the live session's model, so the would-be `lost` rate predicts live
 *    behaviour;
 *  - with none of the agent's authority (`omitAuthEnv`) and one narrow
 *    credential instead: a memory-session token bound to the SYNTHETIC place
 *    `fold-probe:<topic>`, which the session guard lets reach only that topic's
 *    chunk lookups;
 *  - with Bash as its only tool (`confinedTools`), and the fold-marker tool
 *    policy on top: its marker is written under the Instar session id the
 *    coordinator chose BEFORE the spawn, so the policy holds from the first
 *    tool call (no file reads at all; only an exact localhost lookup GET);
 *  - bounded in wall-clock time, killed at the bound.
 *
 * Lookups are corroborated, not claimed: the answer names the chunk keys it
 * used, and a claimed key counts only when the answerer's own transcript holds
 * a matching lookup call. That is the evidence a `retrievable` grade needs.
 *
 * The token is revoked when the answerer ends; the marker is a fold carrier
 * (released by the fold record's terminal transition, never here).
 * Owner-only like every fold step; deps are injected so this module holds no
 * policy of its own about when a shadow fold runs (that is the runner's, P2-4).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { writeFoldMarker } from './foldMarker.js';
import { CLAUDE_CODE_FRAMEWORK } from '../core/frameworkFacts.js';
import { boundedEnds } from '../core/boundedInput.js';
import type { ProbeAnswer } from './foldGrade.js';
import type { ProbeQuestion } from './foldProbe.js';

export const ANSWERER_DEFAULTS = {
  /** Wall-clock bound for the whole answer turn (§9.3: every step has its own bound). */
  boundMs: 10 * 60_000,
  pollMs: 5_000,
  /** A transcript larger than this is not read for corroboration (the answerer is one short turn). */
  maxTranscriptBytes: 8 * 1024 * 1024,
  maxAnswerChars: 4_000,
} as const;

export interface AnswererDeps {
  stateDir: string;
  port: number;
  /** SessionManager.spawnSession, bound. */
  spawn(opts: {
    name: string; prompt: string; framework: typeof CLAUDE_CODE_FRAMEWORK; model?: string;
    omitAuthEnv: true; confinedTools: string[]; requireToolConfinement: true;
    sessionId: string; instarSessionId: string; memorySessionToken: string; maxDurationMinutes: number;
  }): Promise<{ id: string; tmuxSession: string }>;
  isAlive(tmuxSession: string): boolean;
  kill(instarSessionId: string): Promise<unknown>;
  issueToken(instarSessionId: string, topicKey: string): string;
  revokeTokens(instarSessionId: string): void;
  /** findClaudeJobTranscript, bound to the project dir. */
  findTranscript(claudeSessionUuid: string): string | null;
  /** finalAssistantText. */
  finalText(jsonl: string): string;
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

export interface AnswererInput {
  topicKey: string;
  foldId: string;
  packetText: string;
  questions: readonly ProbeQuestion[];
  /** The live session's model, so the shadow predicts live behaviour. */
  model?: string;
  boundMs?: number;
}

export type AnswererOutcome =
  | { status: 'answered'; answers: ProbeAnswer[]; unanswered: string[]; instarSessionId: string; lookupCalls: number; elapsedMs: number }
  | { status: 'timeout' | 'no-transcript' | 'unparseable' | 'spawn-failed'; detail: string; instarSessionId: string; elapsedMs: number };

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** A chunk lookup the fold-marker policy allows (the same exact shapes). */
// Exactly the hook's accepted shape (fold-marker guard LOOKUP_RE + LOOKUP_PATHS): same flags, same
// key characters (no ':'), the same optional query suffix.
const CHUNK_LOOKUP = /^curl(?: -(?:s|sS|fsS|sf))?(?: -H "Authorization: Bearer \$(?:AUTH|INSTAR_AUTH_TOKEN)")? "http:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})\/topic\/(-?\d{1,15})\/chunks(?:\/([A-Za-z0-9_.-]{1,128}))?(?:\?[A-Za-z0-9_.~%=&+\-]*)?"$/;

export function buildAnswererPrompt(i: { packetText: string; questions: readonly ProbeQuestion[]; port: number; topicKey: string }): string {
  const lookup = `curl -s -H "Authorization: Bearer $INSTAR_AUTH_TOKEN" "http://localhost:${i.port}/topic/${i.topicKey}/chunks"`;
  return [
    i.packetText,
    '',
    '=== PROBE (internal; not from the operator) ===',
    'The context above was restored from a summary. Answer each question below from it. Answer from what you know now; if a question needs a detail the summary does not hold, you may look it up, and ONLY this way:',
    `- list the older chunks: ${lookup}`,
    `- read one chunk: the same command with /<chunk key> added to the end of the URL`,
    'No other command and no other tool is available. Do not guess: if you cannot answer, say so.',
    'Questions:',
    ...i.questions.map((q) => `- [${q.id}] ${q.question.replace(/[\r\n]+/g, ' ')}`),
    '',
    'Reply with ONLY this JSON, no other text: {"answers":[{"id":"<question id>","answer":"<your answer>","usedChunks":["<chunk key you read for this answer>", ...]}]}',
  ].join('\n');
}

/** The text of a tool_result block (string, or text parts). */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : '')).join('');
  return '';
}

/** A successful lookup returned a JSON body that is not an error (a denied, 4xx or 404 call does not). */
function succeeded(r: { is_error?: unknown; content?: unknown }): boolean {
  if (r.is_error === true) return false;
  const t = resultText(r.content).trim();
  if (!t.startsWith('{')) return false;
  try { const v = JSON.parse(t) as Record<string, unknown>; return !!v && typeof v === 'object' && !('error' in v); } catch { return false; }
}

/**
 * The chunk keys (and list calls) the answerer's own transcript shows it
 * fetched SUCCESSFULLY from this topic: each matching tool call is paired with
 * its tool result by id, and counts only when that result is a non-error JSON
 * body (§10: `retrievable` needs the logged lookup, not a claimed one).
 */
export function lookupsInTranscript(jsonl: string, o: { port: number; topicKey: string }): { keys: Set<string>; listCalls: number; total: number; failed: number } {
  const calls = new Map<string, string | null>(); // tool_use id → chunk key (null = the list)
  const results = new Map<string, boolean>();
  for (const raw of jsonl.split('\n')) {
    if (!raw.trim()) continue;
    let rec: { type?: string; message?: { content?: unknown } };
    try { rec = JSON.parse(raw); } catch { continue; } // @silent-fallback-ok — a torn line is not a lookup
    if (!Array.isArray(rec.message?.content)) continue;
    for (const b of rec.message!.content as Array<Record<string, unknown>>) {
      if (rec.type === 'assistant' && b?.type === 'tool_use' && typeof b.id === 'string') {
        const cmd = (b.input as { command?: unknown } | undefined)?.command;
        if (typeof cmd !== 'string') continue;
        const m = CHUNK_LOOKUP.exec(cmd.trim());
        if (!m || Number(m[1]) !== o.port || m[2] !== o.topicKey) continue;
        calls.set(b.id, m[3] ?? null);
      } else if (rec.type === 'user' && b?.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        results.set(b.tool_use_id, succeeded(b as { is_error?: unknown; content?: unknown }));
      }
    }
  }
  const keys = new Set<string>();
  let listCalls = 0; let total = 0; let failed = 0;
  for (const [id, key] of calls) {
    if (results.get(id) !== true) { failed++; continue; }
    total++;
    if (key) keys.add(key); else listCalls++;
  }
  return { keys, listCalls, total, failed };
}

/** Parse the answerer's reply into graded-ready answers, corroborating each claimed lookup. */
export function parseAnswers(text: string, questions: readonly ProbeQuestion[], seen: { keys: Set<string> }): { answers: ProbeAnswer[]; unanswered: string[] } | null {
  let v: unknown;
  const t = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/, '$1');
  try { v = JSON.parse(t); } catch { return null; } // @silent-fallback-ok — unreadable answers are `unparseable` to the caller, which records `answerer-unparseable`
  const list = (v as { answers?: unknown } | null)?.answers;
  if (!Array.isArray(list)) return null;
  const ids = new Set(questions.map((q) => q.id));
  const byId = new Map<string, ProbeAnswer>();
  for (const a of list) {
    if (!a || typeof a !== 'object') continue;
    const r = a as Record<string, unknown>;
    if (typeof r.id !== 'string' || !ids.has(r.id) || byId.has(r.id) || typeof r.answer !== 'string') continue;
    const claimed = Array.isArray(r.usedChunks) ? r.usedChunks.filter((k): k is string => typeof k === 'string') : [];
    // Corroboration (§10 item 3): only a lookup the transcript shows counts.
    const lookups = claimed.filter((k) => seen.keys.has(k)).map((k) => `GET chunk ${k}`);
    byId.set(r.id, { questionId: r.id, answer: boundedEnds(r.answer, ANSWERER_DEFAULTS.maxAnswerChars), lookups });
  }
  return { answers: [...byId.values()], unanswered: questions.map((q) => q.id).filter((id) => !byId.has(id)) };
}

export async function runShadowAnswerer(d: AnswererDeps, i: AnswererInput): Promise<AnswererOutcome> {
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = now();
  const bound = i.boundMs ?? ANSWERER_DEFAULTS.boundMs;
  if (!SAFE_ID.test(i.foldId) || !/^-?\d{1,15}$/.test(i.topicKey)) throw new Error('shadow-answerer: unsafe fold or topic id');
  const instarSessionId = `fold-probe-${i.foldId}`.slice(0, 128);
  const claudeUuid = crypto.randomUUID();
  const elapsed = () => now() - started;

  // The marker first, keyed by the id the spawn will carry: the tool policy holds from the first call.
  if (!writeFoldMarker(d.stateDir, { instarSessionId, foldId: i.foldId, topicKey: i.topicKey, expiresAt: started + bound * 3 }, started)) {
    return { status: 'spawn-failed', detail: 'could not write the fold marker', instarSessionId, elapsedMs: elapsed() };
  }
  const token = d.issueToken(instarSessionId, i.topicKey);
  try {
    let session: { id: string; tmuxSession: string };
    try {
      session = await d.spawn({
        name: `fold-probe-${i.topicKey}-${i.foldId.slice(-8)}`,
        prompt: buildAnswererPrompt({ packetText: i.packetText, questions: i.questions, port: d.port, topicKey: i.topicKey }),
        framework: CLAUDE_CODE_FRAMEWORK, ...(i.model ? { model: i.model } : {}),
        omitAuthEnv: true, confinedTools: ['Bash'], requireToolConfinement: true,
        sessionId: claudeUuid, instarSessionId, memorySessionToken: token,
        maxDurationMinutes: Math.max(1, Math.ceil(bound / 60_000)),
      });
    } catch (e) {
      return { status: 'spawn-failed', detail: e instanceof Error ? e.message.slice(0, 200) : 'spawn failed', instarSessionId, elapsedMs: elapsed() };
    }
    while (d.isAlive(session.tmuxSession)) {
      if (elapsed() >= bound) {
        await d.kill(session.id);
        return { status: 'timeout', detail: `no answer within ${Math.round(bound / 1000)} s`, instarSessionId, elapsedMs: elapsed() };
      }
      await sleep(ANSWERER_DEFAULTS.pollMs);
    }
    const file = d.findTranscript(claudeUuid);
    if (!file) return { status: 'no-transcript', detail: 'the answerer left no transcript', instarSessionId, elapsedMs: elapsed() };
    let jsonl: string;
    try {
      const st = await fs.promises.stat(file);
      if (st.size > ANSWERER_DEFAULTS.maxTranscriptBytes) return { status: 'no-transcript', detail: `transcript too large to corroborate (${st.size} bytes)`, instarSessionId, elapsedMs: elapsed() };
      jsonl = await fs.promises.readFile(file, 'utf-8');
    } catch (e) {
      return { status: 'no-transcript', detail: e instanceof Error ? e.message.slice(0, 200) : 'unreadable transcript', instarSessionId, elapsedMs: elapsed() };
    }
    const seen = lookupsInTranscript(jsonl, { port: d.port, topicKey: i.topicKey });
    const parsed = parseAnswers(d.finalText(jsonl), i.questions, seen);
    if (!parsed) return { status: 'unparseable', detail: 'the answerer did not reply with the answers JSON', instarSessionId, elapsedMs: elapsed() };
    return { status: 'answered', answers: parsed.answers, unanswered: parsed.unanswered, instarSessionId, lookupCalls: seen.total, elapsedMs: elapsed() };
  } finally {
    d.revokeTokens(instarSessionId);
  }
}
