/**
 * The clean stopping point and the ask brakes (context-budget-layered-summaries
 * §7.3, §7.2 "Ask brakes", §13 Defaults; Phase 2, the runner's deterministic
 * inputs).
 *
 * A fold (shadow or live) asks a session for its handoff only when the server
 * can AFFIRMATIVELY show a clean stop with the evidence it has. Every input is
 * tri-state and anything `unknown` is NOT clean (recorded, never retried
 * silently):
 *  - the tmux session exists and its pane reads idle;
 *  - no live child process under it (hasLiveToolShell), no live helpers;
 *  - no background task open in its transcript: every `run_in_background` or
 *    `Monitor` start since the last fold has its task-notification completion;
 *  - no user message waiting (queued inbound rows, a pending injection);
 *  - the next commitment check-in is further away than the fold-duration
 *    bound × a safety factor (default 2).
 *
 * The ask brakes (P19): at most 2 asks per topic per rolling hour; a 30-minute
 * per-topic backoff after a veto, defer, not-yet or failed handoff; and, in
 * shadow mode, 1 in 3 clean stops sampled (reproducible: a hash of the topic
 * and the stop's sequence number, never Math.random). The brake state is a
 * small JSON file per topic under the layer root.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { contextLayersRoot } from './clearSeedPointer.js';

export type Tri = boolean | 'unknown';

export interface CleanStopEvidence {
  sessionExists: Tri;
  paneIdle: Tri;
  liveToolShell: Tri;
  liveHelpers: Tri;
  /** From the transcript (see `openBackgroundTasks`): null when the transcript could not be read. */
  openBackgroundTasks: number | null;
  waitingUserMessages: number | null;
  /** Epoch ms of the next commitment check-in for this topic; null = none scheduled; undefined = unknown. */
  nextCheckInAt: number | null | undefined;
  now: number;
  /** The fold-duration bound (Phase 0 measured; the runner passes its configured bound). */
  foldDurationMs: number;
  safetyFactor?: number;
}

export type CleanStopVerdict = { clean: true } | { clean: false; reason: string };

export function cleanStop(e: CleanStopEvidence): CleanStopVerdict {
  const no = (reason: string): CleanStopVerdict => ({ clean: false, reason });
  if (e.sessionExists !== true) return no(e.sessionExists === false ? 'no-session' : 'session-unknown');
  if (e.paneIdle !== true) return no(e.paneIdle === false ? 'mid-turn' : 'pane-unknown');
  if (e.liveToolShell !== false) return no(e.liveToolShell === true ? 'live-child-process' : 'child-process-unknown');
  if (e.liveHelpers !== false) return no(e.liveHelpers === true ? 'live-helpers' : 'helpers-unknown');
  if (e.openBackgroundTasks === null) return no('background-unknown');
  if (e.openBackgroundTasks > 0) return no('background-task-open');
  if (e.waitingUserMessages === null) return no('inbound-unknown');
  if (e.waitingUserMessages > 0) return no('user-message-waiting');
  if (e.nextCheckInAt === undefined) return no('check-in-unknown');
  if (e.nextCheckInAt !== null && e.nextCheckInAt - e.now <= e.foldDurationMs * (e.safetyFactor ?? 2)) return no('check-in-too-close');
  return { clean: true };
}

/**
 * The task id a background start's tool result names, from the shapes Claude
 * Code actually writes (observed 2026-11-20 on 2.1.x):
 *   Bash run_in_background: "Command running in background with ID: <id>."
 *   Monitor:                "Monitor started (task <id>, expires in …"
 *   Agent in background:    "… agentId: <id> …"
 * Anchored to those phrases, never a bare "task <word>".
 */
const START_ID_SHAPES: readonly RegExp[] = [
  /\bCommand running in background with ID: ([A-Za-z0-9_-]{4,64})\b/,
  /\bMonitor started \(task ([A-Za-z0-9_-]{4,64})[,)]/,
  /\bagentId: ([A-Za-z0-9_-]{4,64})\b/,
];
/** One task-notification block (parsed one block at a time, so ids never cross blocks). */
const NOTIFICATION_BLOCK = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const TERMINAL_STATUS = /^(completed|failed|killed|cancelled|stopped)$/i;

/**
 * Background tasks still open in a Claude Code transcript: `tool_use` blocks
 * with `input.run_in_background === true` (Bash, Agent) or a `Monitor` call,
 * minus those a later task-notification block reports in a terminal status. A
 * start whose id cannot be read from one of the known shapes is counted open
 * (unknown is not clean). Only entries after `afterEntry` (the last fold's
 * boundary) count.
 */
export function openBackgroundTasks(jsonl: string, o: { afterEntry?: string | null } = {}): number {
  const starts = new Map<string, string | null>(); // tool_use id → task id (null = unread)
  const done = new Set<string>();
  let started = !o.afterEntry;
  for (const raw of jsonl.split('\n')) {
    if (!raw.trim()) continue;
    let rec: { type?: string; uuid?: string; message?: { content?: unknown } };
    try { rec = JSON.parse(raw); } catch { continue; } // @silent-fallback-ok — a torn line carries no task
    if (!started) { if (rec.uuid === o.afterEntry) started = true; continue; }
    const content = rec.message?.content;
    // Completions are read ONLY from the record shape Claude Code injects a
    // notification as: a `user` record whose whole content is the notification.
    // A notification quoted in assistant text or in an operator message never
    // closes a task (that would make a clean stop look true while it runs).
    const texts: string[] = [];
    if (rec.type === 'user' && typeof content === 'string' && content.trimStart().startsWith('<task-notification>')) texts.push(content);
    if (Array.isArray(content)) {
      for (const b of content as Array<Record<string, unknown>>) {
        if (rec.type === 'assistant' && b?.type === 'tool_use' && typeof b.id === 'string') {
          const input = (b.input ?? {}) as Record<string, unknown>;
          if (input.run_in_background === true || b.name === 'Monitor') starts.set(b.id, null);
        } else if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string' && starts.has(b.tool_use_id)) {
          const t = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
          let id: string | null = null;
          for (const re of START_ID_SHAPES) { const m = re.exec(t); if (m) { id = m[1]; break; } }
          starts.set(b.tool_use_id, id);
        } else if (rec.type === 'user' && b?.type === 'text' && typeof b.text === 'string' && content.length === 1 && (b.text as string).trimStart().startsWith('<task-notification>')) {
          texts.push(b.text as string);
        }
      }
    }
    for (const t of texts) {
      for (const block of t.matchAll(NOTIFICATION_BLOCK)) {
        const id = /<task-id>\s*([A-Za-z0-9_-]{4,64})\s*<\/task-id>/.exec(block[1])?.[1];
        const status = /<status>\s*([A-Za-z]+)\s*<\/status>/.exec(block[1])?.[1];
        if (id && status && TERMINAL_STATUS.test(status)) done.add(id);
      }
    }
  }
  let open = 0;
  for (const taskId of starts.values()) if (taskId === null || !done.has(taskId)) open++;
  return open;
}

// ── Ask brakes ──────────────────────────────────────────────────────────────

export const ASK_BRAKES = {
  asksPerHour: 2,
  backoffMs: 30 * 60_000,
  sampleOneIn: 3,
} as const;

interface BrakeState { asks: number[]; backoffUntil: number | null; stopSeq: number }

const SAFE_TOPIC = /^[A-Za-z0-9-][A-Za-z0-9_-]{0,127}$/;
function brakeFile(stateDir: string, topicKey: string): string {
  if (!SAFE_TOPIC.test(topicKey)) throw new Error(`unsafe topic key: ${topicKey.slice(0, 64)}`);
  return path.join(contextLayersRoot(stateDir), topicKey, 'fold-asks.json');
}

function readBrakes(stateDir: string, topicKey: string): BrakeState {
  try {
    const v = JSON.parse(fs.readFileSync(brakeFile(stateDir, topicKey), 'utf-8')) as Partial<BrakeState>;
    return { asks: Array.isArray(v.asks) ? v.asks.filter((x) => Number.isFinite(x)) : [], backoffUntil: typeof v.backoffUntil === 'number' ? v.backoffUntil : null, stopSeq: typeof v.stopSeq === 'number' ? v.stopSeq : 0 };
  } catch {
    return { asks: [], backoffUntil: null, stopSeq: 0 }; // @silent-fallback-ok — no file yet, or a torn one: start empty (the brakes only ever make asking rarer)
  }
}

function writeBrakes(stateDir: string, topicKey: string, s: BrakeState): void {
  const file = brakeFile(stateDir, topicKey);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export type BrakeVerdict = { ask: true; stopSeq: number } | { ask: false; reason: 'backoff' | 'ask-cap' | 'not-sampled'; stopSeq: number };

/**
 * One clean stop seen: advance the stop counter and say whether to ask. The
 * sample is reproducible (sha256 of topic and stop number), so a replay of the
 * same stops samples the same ones.
 */
export function brakeOnStop(stateDir: string, topicKey: string, now: number, o: { shadow: boolean } = { shadow: true }): BrakeVerdict {
  const s = readBrakes(stateDir, topicKey);
  s.stopSeq += 1;
  s.asks = s.asks.filter((t) => now - t < 3_600_000);
  let v: BrakeVerdict;
  if (s.backoffUntil !== null && now < s.backoffUntil) v = { ask: false, reason: 'backoff', stopSeq: s.stopSeq };
  else if (s.asks.length >= ASK_BRAKES.asksPerHour) v = { ask: false, reason: 'ask-cap', stopSeq: s.stopSeq };
  else if (o.shadow && parseInt(crypto.createHash('sha256').update(`${topicKey}:${s.stopSeq}`).digest('hex').slice(0, 8), 16) % ASK_BRAKES.sampleOneIn !== 0) v = { ask: false, reason: 'not-sampled', stopSeq: s.stopSeq };
  else v = { ask: true, stopSeq: s.stopSeq };
  writeBrakes(stateDir, topicKey, s);
  return v;
}

/** An ask was made (counts toward the hourly cap). */
export function recordAsk(stateDir: string, topicKey: string, now: number): void {
  const s = readBrakes(stateDir, topicKey);
  s.asks = [...s.asks.filter((t) => now - t < 3_600_000), now];
  writeBrakes(stateDir, topicKey, s);
}

/** A veto, defer, not-yet or failed handoff: back off for 30 minutes. */
export function recordBackoff(stateDir: string, topicKey: string, now: number): void {
  const s = readBrakes(stateDir, topicKey);
  s.backoffUntil = now + ASK_BRAKES.backoffMs;
  writeBrakes(stateDir, topicKey, s);
}
