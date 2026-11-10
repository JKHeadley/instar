/**
 * PostCompact record store (context-budget-layered-summaries §9.1, §9.5, §9.7).
 *
 * Claude Code's PostCompact hook hands us `compact_summary`, the summary it
 * wrote when it compacted the conversation. The installed `post-compact.sh`
 * POSTs it to `/hooks/post-compact`; this module scrubs it and stores it under
 * the layer store for the session's topic:
 *
 *   <stateDir>/state/context-layers/<topicKey>/post-compact/<receivedAt>-<claudeSessionId>.json
 *
 * Root dirs 0700, files 0600 (as IdentityKeyFile does). The summary passes
 * `scrubForStore` and then a live-value pass against the agent's own secrets
 * (shape patterns miss a `KEY=value` dump of a real token). Observability
 * only in Phase 0: nothing reads these records to make a decision yet, and
 * every behaviour later keyed on them is conditioned on
 * `contextBudget.compactionRecovery.enabled` on that machine (§9.1).
 *
 * Bounded: at most MAX_RECORDS_PER_TOPIC records per topic (oldest pruned),
 * and a summary over MAX_SUMMARY_CHARS is stored as a pointer with its size.
 */
import fs from 'node:fs';
import path from 'node:path';
import { scrubForStore } from '../core/durableSecretScrub.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

export const MAX_RECORDS_PER_TOPIC = 50;
export const MAX_SUMMARY_CHARS = 512 * 1024;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const LIVE_SECRET_MIN_LEN = 12;

export interface PostCompactInput {
  topicKey: string;
  instarSessionId: string;
  claudeSessionId: string;
  trigger: string;
  summary: string;
  receivedAt: number;
}

export interface PostCompactRecord {
  schema: 'post-compact/1';
  topicKey: string;
  instarSessionId: string;
  claudeSessionId: string;
  trigger: 'manual' | 'auto' | 'unknown';
  summary: string;
  summaryChars: number;
  redactionKinds: string[];
  oversize: boolean;
  receivedAt: number;
}

export type PostCompactResult =
  | { recorded: true; file: string; record: PostCompactRecord }
  | { recorded: false; reason: 'unsafe-id' | 'write-failed' };

/** A topic key safe as one path segment: a Telegram topic number or `slack-<channel>`. */
export function isSafeTopicKey(k: string): boolean {
  return SAFE_ID.test(k);
}

export function postCompactDir(stateDir: string, topicKey: string): string {
  return path.join(stateDir, 'state', 'context-layers', topicKey, 'post-compact');
}

/** Replace every exact occurrence of a live secret value with a typed marker. */
export function redactLiveValues(text: string, liveSecrets: readonly string[]): { text: string; hit: boolean } {
  let out = text;
  let hit = false;
  const values = [...new Set(liveSecrets.filter((v) => typeof v === 'string' && v.length >= LIVE_SECRET_MIN_LEN))]
    .sort((a, b) => b.length - a.length);
  for (const v of values) {
    if (out.includes(v)) {
      out = out.split(v).join('[REDACTED:live-secret]');
      hit = true;
    }
  }
  return { text: out, hit };
}

export function recordPostCompact(
  stateDir: string,
  input: PostCompactInput,
  liveSecrets: readonly string[] = [],
): PostCompactResult {
  if (!isSafeTopicKey(input.topicKey) || !SAFE_ID.test(input.claudeSessionId) || !SAFE_ID.test(input.instarSessionId)) {
    return { recorded: false, reason: 'unsafe-id' };
  }
  const raw = typeof input.summary === 'string' ? input.summary : '';
  const oversize = raw.length > MAX_SUMMARY_CHARS;
  const redactionKinds = new Set<string>();
  let summary: string;
  if (oversize) {
    summary = `[REDACTED:oversize] (${raw.length} chars withheld)`;
    redactionKinds.add('oversize');
  } else {
    const scrubbed = scrubForStore(raw, { maxBytes: MAX_SUMMARY_CHARS + 1 });
    for (const r of scrubbed.redactions) redactionKinds.add(r.kind);
    const live = redactLiveValues(scrubbed.text, liveSecrets);
    if (live.hit) redactionKinds.add('live-secret');
    summary = live.text;
  }
  const trigger = input.trigger === 'manual' || input.trigger === 'auto' ? input.trigger : 'unknown';
  const record: PostCompactRecord = {
    schema: 'post-compact/1',
    topicKey: input.topicKey,
    instarSessionId: input.instarSessionId,
    claudeSessionId: input.claudeSessionId,
    trigger,
    summary,
    summaryChars: raw.length,
    redactionKinds: [...redactionKinds].sort(),
    oversize,
    receivedAt: input.receivedAt,
  };
  const dir = postCompactDir(stateDir, input.topicKey);
  try {
    for (const d of [path.join(stateDir, 'state', 'context-layers'), path.dirname(dir), dir]) {
      fs.mkdirSync(d, { recursive: true, mode: 0o700 });
      fs.chmodSync(d, 0o700);
    }
    const file = path.join(dir, `${input.receivedAt}-${input.claudeSessionId}.json`);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(tmp, file);
    pruneOldest(dir);
    return { recorded: true, file, record };
  } catch {
    return { recorded: false, reason: 'write-failed' };
  }
}

function pruneOldest(dir: string): void {
  const files = fs.readdirSync(dir).filter((f) => /^\d+-[A-Za-z0-9_-]+\.json$/.test(f)).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  for (const f of files.slice(0, Math.max(0, files.length - MAX_RECORDS_PER_TOPIC))) {
    SafeFsExecutor.safeRmSync(path.join(dir, f), { force: true, operation: 'src/monitoring/PostCompactStore.ts:pruneOldest' });
  }
}

/** Newest-first records for a topic (bounded by the per-topic cap). */
export function listPostCompactRecords(stateDir: string, topicKey: string): PostCompactRecord[] {
  if (!isSafeTopicKey(topicKey)) return [];
  const dir = postCompactDir(stateDir, topicKey);
  if (!fs.existsSync(dir)) return [];
  const out: PostCompactRecord[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort((a, b) => parseInt(b, 10) - parseInt(a, 10))) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as PostCompactRecord); } catch { /* @silent-fallback-ok — a torn record is skipped; the next write prunes it */ }
  }
  return out;
}
