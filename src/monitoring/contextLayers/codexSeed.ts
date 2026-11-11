/**
 * The Codex next-prompt seed (context-budget-layered-summaries §9.6 Codex
 * column, "Fresh-context seed after compaction": "the real carrier is the
 * `UserPromptSubmit` hook, which delivers the standing packet on the first
 * prompt after a detected compaction … seed by next-prompt delivery, disclosed
 * in the packet marker"; §9.1 context epoch and seeded marker; §7.7).
 *
 * Shape: the installed per-prompt hook (`telegram-topic-context.sh`, the same
 * hook for Claude Code and Codex) asks the server, on a Codex prompt that names
 * a topic, whether this prompt is the first after a compaction it has not
 * seeded. The server answers from the session's own rollout: the newest
 * engine-written `compacted` entry (after the rollout's first usage reading,
 * so a fork's inherited copy never counts) is the compaction, and its
 * `window_id` is the CONTEXT EPOCH. When the rollout shows that epoch not yet
 * seeded, the server builds and verifies the topic's standing packet now (S10's stager) and
 * returns it wrapped in its disclosure marker; the hook prints it and then
 * acknowledges, and the acknowledgement writes the seeded marker (the record a
 * later §7.7 delta hook keys on). So:
 *  - "seeded" is read from the ROLLOUT, not the marker: Codex records the
 *    hook's output as a developer message, so a seed is seeded once the model
 *    has it. A delivery Codex dropped (the hook killed, the output discarded)
 *    is retried on the next prompt; a delivered one is never repeated;
 *  - only the FIRST topic prompt after the compaction is offered the seed, with
 *    one retry (`MAX_EARLIER_PROMPTS`), never a compaction many prompts old;
 *  - only the topic's own live Codex session is offered it (`sessionBound`);
 *  - an unverified packet is never delivered: the prompt gets today's output,
 *    and the canary (which reads the same rollout evidence) counts that
 *    compaction as not recovered. A failing topic is not rebuilt more than
 *    once per `FAILURE_BACKOFF_MS`.
 *
 * The server only READS the rollout (incrementally, cached per path), and only
 * a path shaped like an engine rollout of the named session.
 *
 * RULE 3.1 RATIONALE (CodexCompactionReader, a Codex rollout reader):
 * - Criticality: moderate. A misread means the seed is not delivered (that
 *   prompt keeps today's briefing) or is delivered once more. It never corrupts
 *   state, and never blocks or reroutes a message.
 * - Frequency: once per Codex topic prompt, incremental and cached per rollout.
 * - Stability: semi-stable. Codex's private rollout schema was measured on
 *   0.156.1-0.167.1 (S16, S17). The entry kinds come from the shared
 *   `classifyCodexRolloutEntry`.
 * - Fallback: today's per-prompt output. The drift check is the adapter
 *   verification suite (codexAdapterSuite.ts), re-run on every Codex version
 *   change: it reads `partial` when a `compacted` entry loses its `window_id`,
 *   and `absent` when no compaction or hook delivery is seen.
 * - Verdict: deterministic, with the version-triggered suite standing in as its canary.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { classifyCodexRolloutEntry, codexRolloutLineMayMatter, CODEX_SEED_HEADER } from '../CodexRolloutParser.js';
import { seedMarkerPath } from '../compactionSeedMarker.js';

/** The framework discriminator value a Codex session carries (`INSTAR_FRAMEWORK`). */
export const CODEX_FRAMEWORK = 'codex-cli';
/** A topic whose packet failed verification is not rebuilt more often than this. */
export const FAILURE_BACKOFF_MS = 5 * 60_000;
/** Seeded epochs remembered per session (the canary reads them; bounded). */
export const SEEDED_EPOCHS_MAX = 50;
/** Read at most this much new rollout per call (a huge backlog is read across prompts). */
const MAX_READ_BYTES = 32 * 1024 * 1024;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** The line the delivered seed carries; the canary and the reader find it in the rollout as model input. */
export { CODEX_SEED_HEADER };
/**
 * How many earlier topic prompts may follow a compaction before its seed is no
 * longer offered: 1 allows exactly one retry when the first delivery never
 * reached the model (the hook was killed, Codex dropped the output); more would
 * seed a compaction long past, e.g. on the day the layers are switched on.
 */
export const MAX_EARLIER_PROMPTS = 1;

export interface CodexCompaction {
  windowId: string; at: number | null; version: string | null;
  /** The seed for this compaction reached the model: its header is in a developer message after the `compacted` entry. */
  seeded: boolean;
  /** The delivered packet's nonce, when seeded. */
  seedNonce: string | null;
  /** sha256 of each topic prompt written after the compaction (bounded). */
  promptsAfter: string[];
}

interface RolloutCursor { size: number; offset: number; usageSeen: boolean; version: string | null; latest: CodexCompaction | null; mtimeMs: number }

/**
 * Is `p` an engine rollout of session `sessionId`? `rollout-<stamp>-<sessionId>.jsonl`,
 * a regular file (not a symlink), under a `sessions` directory. Returns the
 * resolved path or null.
 */
export function validateCodexRolloutPath(p: unknown, sessionId: string): string | null {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096 || !SESSION_ID_RE.test(sessionId)) return null;
  if (!path.isAbsolute(p)) return null;
  const base = path.basename(p);
  if (!base.startsWith('rollout-') || !base.endsWith(`-${sessionId}.jsonl`)) return null;
  if (!p.split(path.sep).includes('sessions')) return null;
  try {
    const st = fs.lstatSync(p);
    if (!st.isFile() || st.isSymbolicLink()) return null;
  } catch { return null; } // @silent-fallback-ok — not on disk: nothing to seed
  return p;
}

/** Incremental reader of the newest post-usage `compacted` entry per rollout. */
export class CodexCompactionReader {
  private readonly cursors = new Map<string, RolloutCursor>();
  constructor(private readonly maxEntries = 500) {}

  latest(rolloutPath: string): CodexCompaction | null {
    let st: fs.Stats;
    try { st = fs.statSync(rolloutPath); } catch { return null; } // @silent-fallback-ok — vanished rollout: nothing to seed
    let c = this.cursors.get(rolloutPath);
    if (!c || st.size < c.offset) c = { size: 0, offset: 0, usageSeen: false, version: null, latest: null, mtimeMs: 0 };
    if (st.size > c.offset) {
      const len = Math.min(st.size - c.offset, MAX_READ_BYTES);
      const buf = Buffer.alloc(len);
      try {
        const fd = fs.openSync(rolloutPath, 'r');
        try { fs.readSync(fd, buf, 0, len, c.offset); } finally { fs.closeSync(fd); }
      } catch { return c.latest; } // @silent-fallback-ok — an unreadable read leaves the last answer
      const lastNl = buf.lastIndexOf(0x0a);
      if (lastNl >= 0) {
        for (const line of buf.subarray(0, lastNl).toString('utf-8').split('\n')) {
          if (!codexRolloutLineMayMatter(line)) continue;
          let e: Record<string, unknown>;
          try { e = JSON.parse(line) as Record<string, unknown>; } catch { continue; } // @silent-fallback-ok — a torn rollout line is skipped
          const k = classifyCodexRolloutEntry(e);
          if (!k) continue;
          if (k.kind === 'meta') { if (k.version && (!c.version || c.usageSeen)) c.version = k.version; continue; }
          if (k.kind === 'usage') { c.usageSeen = true; continue; }
          if (k.kind === 'compacted') { if (c.usageSeen) c.latest = { windowId: k.windowId, at: k.at, version: c.version, seeded: false, seedNonce: null, promptsAfter: [] }; continue; }
          if (!c.latest) continue;
          if (k.kind === 'seed') { c.latest.seeded = true; c.latest.seedNonce = k.nonce; continue; }
          if (k.kind === 'prompt' && k.topic && c.latest.promptsAfter.length < 20) c.latest.promptsAfter.push(k.textSha256);
        }
        c.offset += lastNl + 1;
      } else if (len === MAX_READ_BYTES) c.offset += len; // one line over the window is skipped
    }
    c.size = st.size; c.mtimeMs = st.mtimeMs;
    this.cursors.delete(rolloutPath); this.cursors.set(rolloutPath, c);
    while (this.cursors.size > this.maxEntries) this.cursors.delete(this.cursors.keys().next().value as string);
    return c.latest;
  }
}

// ── The seeded marker (shared shape with the Claude Code compact seed) ─────

export interface CodexSeedMarker {
  sessionId: string;
  /** The context epoch seeded last (the compaction's `window_id`). */
  epoch: string;
  source: 'compact';
  engine: typeof CODEX_FRAMEWORK;
  /** §9.6: Codex has no post-compaction seed hook, so the packet rides the next prompt. */
  delivery: 'next-prompt';
  carrier: string;
  seededAt: number;
  /** Every epoch this session was seeded for (newest last, bounded), so a later epoch never hides an earlier one. */
  epochs: Array<{ epoch: string; seededAt: number; carrier: string }>;
}

export function readCodexSeedMarker(stateDir: string, sessionId: string): CodexSeedMarker | null {
  const p = seedMarkerPath(stateDir, sessionId);
  if (!p) return null;
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf-8')) as CodexSeedMarker;
    if (v?.sessionId !== sessionId || v.engine !== CODEX_FRAMEWORK || !Array.isArray(v.epochs)) return null;
    return v;
  } catch { return null; } // @silent-fallback-ok — no (readable) marker reads as "not seeded": the next prompt seeds
}

/** Was this epoch seeded for this session? */
export function codexEpochSeeded(stateDir: string, sessionId: string, epoch: string): { seededAt: number; carrier: string } | null {
  const m = readCodexSeedMarker(stateDir, sessionId);
  const hit = m?.epochs.find((e) => e.epoch === epoch);
  return hit ? { seededAt: hit.seededAt, carrier: hit.carrier } : null;
}

export function writeCodexSeedMarker(stateDir: string, sessionId: string, epoch: string, carrier: string, now: number): CodexSeedMarker {
  const p = seedMarkerPath(stateDir, sessionId);
  if (!p) throw new Error('unsafe session id');
  const prev = readCodexSeedMarker(stateDir, sessionId);
  const epochs = (prev?.epochs ?? []).filter((e) => e.epoch !== epoch);
  const existing = prev?.epochs.find((e) => e.epoch === epoch);
  epochs.push(existing ?? { epoch, seededAt: now, carrier });
  const m: CodexSeedMarker = {
    sessionId, epoch, source: 'compact', engine: CODEX_FRAMEWORK, delivery: 'next-prompt',
    carrier: existing?.carrier ?? carrier, seededAt: existing?.seededAt ?? now, epochs: epochs.slice(-SEEDED_EPOCHS_MAX),
  };
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(m), { mode: 0o600 });
  fs.renameSync(tmp, p);
  return m;
}

/** Wrap a verified packet in its disclosure marker (the delimited body keeps S10's nonce = sha256 rule). */
export function renderCodexSeed(packetText: string, sha256Hex: string, epoch: string): string {
  const n = sha256Hex.slice(0, 8);
  return [
    CODEX_SEED_HEADER,
    `Your context was compacted (context epoch ${epoch.slice(0, 36)}). Codex has no post-compaction seed hook, so this topic's`,
    'standing packet is delivered with this prompt instead (next-prompt delivery). It replaces the usual topic',
    'briefing for this one prompt. Read it, then answer the message below; nothing needs to be re-asked.',
    `--- STANDING PACKET ${n} ---`,
    packetText,
    `--- END STANDING PACKET ${n} ---`,
  ].join('\n');
}

// ── The service the routes call ─────────────────────────────────────────────

export type CodexSeedOffer =
  | { deliver: true; epoch: string; carrier: string; text: string }
  | { deliver: false; reason: 'not-codex' | 'bad-request' | 'no-rollout' | 'not-this-topic-session' | 'no-compaction' | 'already-seeded' | 'not-first-prompt' | 'packet-unverified' | 'packet-backoff' };

export interface CodexSeedDeps {
  stateDir: string;
  /** Build, verify and stage the topic's packet now (S10's stager). */
  stageNow(topicKey: string): { ok: true; delivered: string; sha256: string } | { ok: false; reason: string };
  /**
   * Is `sessionId` a live Codex session of topic `topicId` on this machine?
   * When given, a seed is offered only to that session (so a request can never
   * pull another topic's packet through a rollout of its own).
   */
  sessionBound?(topicId: number, sessionId: string): boolean;
  now?: () => number;
}

export interface CodexSeedStatus { offers: number; delivered: number; acks: number; alreadySeeded: number; notFirstPrompt: number; noCompaction: number; unverified: number; backoff: number; rejected: number }

export class CodexSeedService {
  private readonly reader = new CodexCompactionReader();
  private readonly failedAt = new Map<string, number>();
  private readonly st: CodexSeedStatus = { offers: 0, delivered: 0, acks: 0, alreadySeeded: 0, notFirstPrompt: 0, noCompaction: 0, unverified: 0, backoff: 0, rejected: 0 };
  private readonly now: () => number;
  constructor(private readonly d: CodexSeedDeps) { this.now = d.now ?? Date.now; }

  /** The hook's question: is this prompt the first after a compaction this session was not seeded for? */
  offer(req: { topicId: unknown; sessionId: unknown; transcriptPath: unknown; framework: unknown; promptSha256?: unknown }): CodexSeedOffer {
    this.st.offers++;
    if (req.framework !== CODEX_FRAMEWORK) { this.st.rejected++; return { deliver: false, reason: 'not-codex' }; }
    const topic = typeof req.topicId === 'number' || typeof req.topicId === 'string' ? String(req.topicId) : '';
    const sid = typeof req.sessionId === 'string' ? req.sessionId : '';
    if (!/^\d{1,15}$/.test(topic) || !SESSION_ID_RE.test(sid)) { this.st.rejected++; return { deliver: false, reason: 'bad-request' }; }
    const rollout = validateCodexRolloutPath(req.transcriptPath, sid);
    if (!rollout) { this.st.rejected++; return { deliver: false, reason: 'no-rollout' }; }
    if (this.d.sessionBound && !this.d.sessionBound(Number(topic), sid)) { this.st.rejected++; return { deliver: false, reason: 'not-this-topic-session' }; }
    const c = this.reader.latest(rollout);
    if (!c) { this.st.noCompaction++; return { deliver: false, reason: 'no-compaction' }; }
    // Seeded means the MODEL received it (the seed is in the rollout as model input), not
    // that an acknowledgement arrived: a delivery Codex dropped is retried on the next prompt.
    if (c.seeded) { this.st.alreadySeeded++; return { deliver: false, reason: 'already-seeded' }; }
    // The FIRST prompt after the compaction (the current prompt may or may not be written yet,
    // so it is excluded by its hash), with one retry; never a compaction many prompts old.
    const current = typeof req.promptSha256 === 'string' ? req.promptSha256 : '';
    if (c.promptsAfter.filter((h) => h !== current).length > MAX_EARLIER_PROMPTS) { this.st.notFirstPrompt++; return { deliver: false, reason: 'not-first-prompt' }; }
    const failed = this.failedAt.get(topic);
    if (failed !== undefined && this.now() - failed < FAILURE_BACKOFF_MS) { this.st.backoff++; return { deliver: false, reason: 'packet-backoff' }; }
    let r: ReturnType<CodexSeedDeps['stageNow']>;
    try { r = this.d.stageNow(topic); } catch (e) { r = { ok: false, reason: e instanceof Error ? e.message : String(e) }; }
    if (!r.ok) { this.failedAt.set(topic, this.now()); this.st.unverified++; return { deliver: false, reason: 'packet-unverified' }; }
    this.failedAt.delete(topic);
    this.st.delivered++;
    return { deliver: true, epoch: c.windowId, carrier: `packet:${r.sha256.slice(0, 8)}`, text: renderCodexSeed(r.delivered, r.sha256, c.windowId) };
  }

  /** The hook printed the seed: write the seeded marker for that epoch (only an epoch the rollout really holds). */
  ack(req: { sessionId: unknown; epoch: unknown; carrier: unknown; transcriptPath: unknown }): { ok: true; marker: CodexSeedMarker } | { ok: false; reason: string } {
    const sid = typeof req.sessionId === 'string' ? req.sessionId : '';
    const epoch = typeof req.epoch === 'string' ? req.epoch : '';
    const carrier = typeof req.carrier === 'string' && /^packet:[0-9a-f]{8}$/.test(req.carrier) ? req.carrier : '';
    if (!SESSION_ID_RE.test(sid) || !epoch || epoch.length > 200 || !carrier) return { ok: false, reason: 'bad-request' };
    const rollout = validateCodexRolloutPath(req.transcriptPath, sid);
    if (!rollout) return { ok: false, reason: 'no-rollout' };
    const c = this.reader.latest(rollout);
    if (!c || c.windowId !== epoch) return { ok: false, reason: 'not-the-current-epoch' };
    this.st.acks++;
    return { ok: true, marker: writeCodexSeedMarker(this.d.stateDir, sid, epoch, carrier, this.now()) };
  }

  status(): CodexSeedStatus { return { ...this.st }; }
}
