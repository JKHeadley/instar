/**
 * ConversationRegistry — durable, channel-agnostic conversation identity
 * (docs/specs/durable-conversation-identity.md §3, increment 1: registry +
 * crash-proof journal + eager mint foundation).
 *
 * The registry is the JOIN TABLE between canonical key (string), structured
 * tuple, and minted NEGATIVE numeric id (§2). It is SPARSE: Telegram positive
 * ids are NEVER registered (a positive id IS its own identity, forever);
 * only minted (non-Telegram) conversations live here.
 *
 * Durability model (§3.3/§3.4 — the WAL rule):
 *   - The id is assigned SYNCHRONOUSLY in-memory (probe included) against the
 *     authoritative cache + reverse index, so the id RETURNED always equals
 *     the id that will PERSIST — no misdelivery window.
 *   - A PROBED or durable-binding-forced mint append+fsyncs ONE journal line
 *     to `<stateDir>/conversation-registry.jsonl` (the §3.4 journal-path PIN:
 *     stateDir ROOT, beside shared-state.jsonl — the one shape the deployed
 *     BackupManager.expandGlob actually expands, R3-C4) BEFORE the id is
 *     handed to the caller.
 *   - A pure speculative non-probed mint appends its audit line WITHOUT fsync
 *     (§3.4 fsync discipline; §8 audit completeness) — its candidate re-mints
 *     deterministically for free after a crash.
 *   - The O(N) full-store JSON snapshot (`<stateDir>/state/conversation-registry.json`)
 *     is BATCHED off the hot path with a SIZE-ADAPTIVE interval (§3.4 —
 *     the CommitmentTracker 2026-06-21 freeze precedent), and moves to an
 *     off-loop write past the pinned trigger (>20k entries / >2MB).
 *
 * Increment scope note: the §3.5/§3.5.1 replication merge, the §3.5.2 bind-pin
 * overlay WRITERS, and the §5.0(a) E1 dedup WRITERS land in their own §6.1
 * increments. The journal op ENUM, replay application, and snapshot
 * completeness for those ops ship NOW (§3.4 record framing is frozen), so a
 * later increment's records — and a rollback across one — replay correctly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import {
  ConversationTuple,
  candidateIdForRoutingKey,
  canonicalKeyFor,
  MAX_PROBE_DISTANCE,
  parseCanonicalKey,
  routingKeyForTuple,
  SLACK_WORKSPACE_ID_RE,
  tupleForRoutingKey,
  tupleKeyFor,
  walkDisplacement,
  WORKSPACE_PLACEHOLDER,
} from './conversationIdentity.js';

/** Entry origins (§3.4). `deliverToConversation` resolves ONLY the three local
 *  origins; a pure `replicated` entry is read-context (KYP, §3.5). */
export type ConversationOrigin = 'adopted-legacy-hash' | 'minted-probed' | 'adopted-replicated' | 'replicated';

export interface ConversationEntry {
  id: number;
  platform: 'slack';
  /** Identity-adjacent metadata (§3.1) — `_` until locally authenticated. */
  workspaceId: string;
  channelId: string;
  threadTs: string | null;
  mintedAt: string;
  mintedBy: string;
  origin: ConversationOrigin;
  /** LOCAL-authoritative delivery state (§5.1); advisory display only when replicated. */
  reachability: 'ok' | 'unreachable';
  hlc: { physical: number; logical: number; node: string };
  /** Display-only, refreshable; UNTRUSTED peer data when replicated (§3.5 B3). */
  label?: string;
}

export type ConversationDescriptor =
  | { platform: 'telegram'; topicId: number; passThrough: true }
  | {
      platform: 'slack';
      id: number;
      key: string;
      channelId: string;
      threadTs: string | null;
      workspaceId: string;
      origin: ConversationOrigin;
      reachability: 'ok' | 'unreachable';
      label?: string;
      /** Present when the queried id was an alias — one hop, never a chain (§3.5). */
      aliasOf?: number;
    };

/** Speculative (inbound-triggered) mint result — NEVER throws: identity never
 *  costs a message (§3.6 fail-toward-delivery). `id: null` = no durable id;
 *  callers keep legacy behavior for that message. */
export interface InboundMintResult {
  id: number | null;
  created: boolean;
  registered: boolean;
  degraded?:
    | 'unparseable-key'
    | 'multi-workspace-unsupported'
    | 'recording-disabled'
    | 'breaker-dropped'
    | 'probe-overflow';
}

/** Durable-binding-forced mint result (§3.3 breaker carve-out) — typed refusals,
 *  never silent drops (adversarial-B). */
export type DurableMintResult =
  | { ok: true; id: number; created: boolean }
  | {
      ok: false;
      error:
        | 'unparseable-key'
        | 'multi-workspace-unsupported'
        | 'conversation-recording-disabled'
        | 'conversation-registration-capacity'
        | 'mint-failure';
    };

/** §3.4 record framing — ONE self-contained JSON object per line. FROZEN op enum. */
export const JOURNAL_OPS = [
  'mint',
  'alias',
  'reachability',
  'bind-pin',
  'bind-release',
  'ambiguous-send',
  'send-retire',
  'send-intent',
  'send-intent-resolved',
] as const;
export type JournalOp = (typeof JOURNAL_OPS)[number];

interface JournalRecord {
  seq: number;
  op: string;
  ts: string;
  key?: string;
  tuple?: [string, string, string | null];
  id?: number;
  origin?: ConversationOrigin;
  hlc?: { physical: number; logical: number; node: string };
  target?: number; // alias target
  reachability?: 'ok' | 'unreachable';
  conversationId?: number;
  logicalSendId?: string;
  lane?: 'logical' | 'content-hash';
  refcount?: number;
}

/** Pinned defaults (§3.3 mint-rate breaker — Bounded Blast Radius). */
export interface MintBreakerConfig {
  windowMs?: number;
  speculativePerWindow?: number;
  durableBindingPerWindow?: number;
}

export interface ConversationRegistryDeps {
  /** The StateManager stateDir root (`.instar`). Snapshot lives at
   *  `<stateDir>/state/conversation-registry.json`; journal at the stateDir
   *  ROOT `<stateDir>/conversation-registry.jsonl` (§3.4 journal-path PIN). */
  stateDir: string;
  /** mintedBy / hlc.node stamp. Lazy — resolved per record. */
  machineId: () => string;
  now?: () => Date;
  /** D1 kill-switch (§3.6/§9) — read LIVE at the chokepoint, no restart. */
  isRecordingEnabled?: () => boolean;
  /** Narrower escape hatch: keep recording, skip the durable-path fsync (§9). */
  isJournalFsyncDisabled?: () => boolean;
  /** The LOCAL authenticated workspace source (§3.1 — SlackAdapter.getWorkspaceId; config-sourced today). */
  getLocalWorkspaceId?: () => string | undefined;
  /** Config-declared fleet pin (§3.1 source 1 — authoritative when present). */
  getConfigWorkspacePin?: () => string | undefined;
  breaker?: MintBreakerConfig;
  /** ONE deduped attention item per episode — the caller routes to the real
   *  attention surface. Dedupe key is stable per episode class. */
  onAttention?: (dedupeKey: string, title: string, body: string) => void;
  log?: (line: string) => void;
  /** Journal rotation knobs (§3.4 — pinned defaults 8 MB / 50k lines). */
  journalRotateBytes?: number;
  journalRotateLines?: number;
  /** Snapshot batching knobs (§3.4 — pinned defaults 2000ms base / 5000 step / 60000ms max). */
  snapshotBaseIntervalMs?: number;
  snapshotAdaptiveStep?: number;
  snapshotMaxIntervalMs?: number;
}

interface SnapshotShape {
  version: 1;
  snapshotHighWaterSeq: number;
  workspacePin?: { value: string; source: 'config' | 'local-observed'; confirmedLocally: boolean };
  conversations: Record<string, ConversationEntry>;
  aliases: Record<string, number>;
  /** §3.4 snapshot-completeness corollary (R4-M2/R6-M1): journal-applied state
   *  the prune rule depends on — live bind-pins, unretired ambiguous-send
   *  entries, unresolved send-intents. LOCAL state, never on any wire. */
  bindPins: Record<string, { tuple: [string, string, string | null]; refcount: number }>;
  ambiguousSends: Record<string, { recordedAt: string }>;
  sendIntents: Record<string, { lane: 'logical' | 'content-hash'; seq: number }>;
}

const ENTRY_CEILING = 50000; // §3.4 JSON-store design ceiling
const ENTRY_THRESHOLD = 40000; // 80% of ceiling — the pinned tripwire (R3-minor)
const FILE_BYTES_THRESHOLD = 8 * 1024 * 1024; // 80% of ~10MB
const OFFLOOP_ENTRY_TRIGGER = 20000; // §3.4 pinned off-loop flush trigger
const OFFLOOP_BYTES_TRIGGER = 2 * 1024 * 1024;
const PENDING_MINT_MAX = 1000; // §3.6 pinned
const BREAKER_MAX_TRACKED_CHANNELS = 512; // bounded budget-state map (§3.3, R3-minor)

export class ConversationRegistry {
  private readonly d: ConversationRegistryDeps;
  private readonly snapshotPath: string;
  private readonly journalPath: string;

  // ── Authoritative in-memory cache + synchronous indexes (§3.4 1–2) ──
  private conversations = new Map<string, ConversationEntry>(); // canonical key → entry
  private byId = new Map<number, ConversationEntry>(); // id→entry reverse index
  private byTuple = new Map<string, ConversationEntry>(); // tupleKey → entry
  private aliases = new Map<number, number>(); // loserId → winnerId (one hop)

  // ── Derived indexes (§3.4 3–5) — rebuilt at boot, maintained at assign time ──
  private reservedCanonicals = new Map<number, string>(); // cand → owning tupleKey
  private displacedAssignments = new Map<number, string>(); // offset → owning tupleKey (GLOBAL — R4-C1)
  private candClaimants = new Map<number, Set<string>>(); // cand → claimant tupleKeys

  // ── §5.0(a)/§3.5.2 journal-applied state (writers land in later increments) ──
  private bindPins = new Map<number, { tuple: [string, string, string | null]; refcount: number }>();
  private ambiguousSends = new Map<string, { recordedAt: string }>();
  private sendIntents = new Map<string, { lane: 'logical' | 'content-hash'; seq: number }>();

  private workspacePin: { value: string; source: 'config' | 'local-observed'; confirmedLocally: boolean } | null = null;

  // ── Journal state ──
  private seqCounter = 0;
  private snapshotHighWaterSeq = 0;
  private journalFd: number | null = null;
  private journalBytes = 0;
  private journalLines = 0;
  /** Unknown-op skip-and-preserve set (R8-minor-2) → snapshot-flush SUSPENSION (R9-M1/R10-M1). */
  private unappliedUnknownOps: Array<{ seq: number; op: string }> = [];

  // ── Snapshot batching ──
  private snapshotTimer: NodeJS.Timeout | null = null;
  private snapshotDirty = false;
  private lastSnapshotBytes = 0;
  private batchDepth = 0; // adoption-pass batched-save window (§6.2)
  private flushInFlight = false;

  // ── Breaker + degradation state ──
  private breakerWindows = new Map<string, { windowStartMs: number; speculative: number; durable: number; episodeNotified: boolean }>();
  private breakerEpisodes = 0;
  private pendingMints = new Map<string, { firstAt: string }>();
  private pendingMintDrops = 0;

  // ── Observability ──
  private lastMintAt: string | null = null;
  private durabilityIncidents = 0;
  private snapshotQuarantinedAt: string | null = null;
  private journalQuarantinedAt: string | null = null;
  private adoptionState: { ranAt: string; adopted: number; skippedUnauthorized: number } | null = null;
  private loaded = false;

  constructor(deps: ConversationRegistryDeps) {
    this.d = deps;
    this.snapshotPath = path.join(deps.stateDir, 'state', 'conversation-registry.json');
    this.journalPath = path.join(deps.stateDir, 'conversation-registry.jsonl');
  }

  private now(): Date {
    return (this.d.now ?? (() => new Date()))();
  }

  private log(line: string): void {
    try {
      this.d.log?.(line);
    } catch {
      /* observability never gates */
    }
  }

  private attention(dedupeKey: string, title: string, body: string): void {
    try {
      this.d.onAttention?.(dedupeKey, title, body);
    } catch {
      /* attention is observability — never gates identity or delivery */
    }
  }

  private recordingEnabled(): boolean {
    try {
      return this.d.isRecordingEnabled ? this.d.isRecordingEnabled() !== false : true;
    } catch {
      return true;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Boot: snapshot load + journal replay (§3.4 WAL crash-consistency contract)
  // ─────────────────────────────────────────────────────────────────────────

  /** Idempotent boot-time load: snapshot, then journal tail replay in global
   *  `seq` order across rotated files (§6.2 recovery order 1–2). */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      fs.mkdirSync(path.join(this.d.stateDir, 'state'), { recursive: true });
    } catch {
      /* exists */
    }
    this.loadSnapshot();
    this.replayJournal();
    this.rebuildDerivedIndexes();
    this.applyAliasAssignmentFilter(); // R6-M3 pin 2: the disjointness invariant holds at every BOOT fixpoint
    if (this.unappliedUnknownOps.length > 0) {
      const first = this.unappliedUnknownOps[0];
      const kinds = [...new Set(this.unappliedUnknownOps.map((u) => u.op))].join(', ');
      this.attention(
        'conversation-registry:unknown-op',
        'Conversation registry journal holds records from a newer version',
        `${this.unappliedUnknownOps.length} journal record(s) with unrecognized op kind(s) [${kinds}] were skipped-and-preserved (version skew, not corruption — R8-minor-2). SNAPSHOT FLUSHING IS SUSPENDED (R9-M1/R10-M1): the on-disk snapshot stays the pre-skew one (high-water ${this.snapshotHighWaterSeq}, first unapplied seq ${first.seq}) until a recognizing version re-upgrades and replays them in position. Journal retention grows for the suspension's duration.`,
      );
    }
    // Resolve the config workspace pin (source 1 — authoritative when present).
    const configPin = this.readConfigPin();
    if (configPin) {
      this.workspacePin = { value: configPin, source: 'config', confirmedLocally: true };
    }
  }

  private readConfigPin(): string | undefined {
    try {
      const v = this.d.getConfigWorkspacePin?.();
      return v && SLACK_WORKSPACE_ID_RE.test(v) ? v : undefined;
    } catch {
      return undefined;
    }
  }

  private loadSnapshot(): void {
    if (!fs.existsSync(this.snapshotPath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.snapshotPath, 'utf-8')) as SnapshotShape;
      if (!raw || typeof raw !== 'object' || raw.version !== 1) throw new Error('unrecognized snapshot shape');
      this.snapshotHighWaterSeq = typeof raw.snapshotHighWaterSeq === 'number' ? raw.snapshotHighWaterSeq : 0;
      this.seqCounter = this.snapshotHighWaterSeq;
      if (raw.workspacePin && typeof raw.workspacePin.value === 'string') this.workspacePin = raw.workspacePin;
      for (const [key, entry] of Object.entries(raw.conversations ?? {})) {
        if (!entry || typeof entry.id !== 'number' || !(entry.id < 0) || !Number.isSafeInteger(entry.id)) continue; // id<0 clamp on every write (§3.3)
        this.indexEntry(key, entry);
      }
      for (const [loser, winner] of Object.entries(raw.aliases ?? {})) {
        const l = Number(loser);
        if (Number.isSafeInteger(l) && l < 0 && typeof winner === 'number' && winner < 0) this.aliases.set(l, winner);
      }
      for (const [id, pin] of Object.entries(raw.bindPins ?? {})) {
        const n = Number(id);
        if (Number.isSafeInteger(n) && pin && Array.isArray(pin.tuple) && typeof pin.refcount === 'number') {
          this.bindPins.set(n, { tuple: pin.tuple as [string, string, string | null], refcount: pin.refcount });
        }
      }
      for (const [k, v] of Object.entries(raw.ambiguousSends ?? {})) {
        if (v && typeof v.recordedAt === 'string') this.ambiguousSends.set(k, v);
      }
      for (const [k, v] of Object.entries(raw.sendIntents ?? {})) {
        if (v && (v.lane === 'logical' || v.lane === 'content-hash') && typeof v.seq === 'number') this.sendIntents.set(k, v);
      }
      this.lastSnapshotBytes = fs.statSync(this.snapshotPath).size;
    } catch (err) {
      // Corrupt-file quarantine-aside (§3.6 — the TopicPlacementPinStore
      // pattern): preserve aside, ONE deduped attention item, rebuild from the
      // journal (a journal-only rebuild replays every retained file from empty
      // state in global seq order — §3.4 rotation note).
      const aside = `${this.snapshotPath}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(this.snapshotPath, aside);
      } catch {
        /* best-effort — the report below still fires */
      }
      this.snapshotQuarantinedAt = this.now().toISOString();
      this.snapshotHighWaterSeq = 0;
      this.seqCounter = 0;
      this.attention(
        'conversation-registry:snapshot-corrupt',
        'Conversation registry snapshot was corrupt — quarantined aside',
        `state/conversation-registry.json failed to parse (${err instanceof Error ? err.message : String(err)}) and was preserved at ${aside}. Rebuilding from the journal (§6.2 recovery order: backup restore is the PRIMARY path if the journal is also damaged).`,
      );
    }
  }

  /** Retained journal files in replay order: rotated (ascending epoch) then live. */
  private journalFiles(): string[] {
    const dir = this.d.stateDir;
    const base = path.basename(this.journalPath);
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.startsWith(`${base}.`) && /\.\d+$/.test(n));
    } catch {
      names = [];
    }
    const rotated = names
      .map((n) => ({ n, epoch: Number(n.slice(base.length + 1)) }))
      .sort((a, b) => a.epoch - b.epoch)
      .map((x) => path.join(dir, x.n));
    return fs.existsSync(this.journalPath) ? [...rotated, this.journalPath] : rotated;
  }

  private replayJournal(): void {
    const files = this.journalFiles();
    if (files.length === 0) return;

    // Torn-tail handling (§3.4): a crash mid-append leaves the LIVE file's last
    // line unterminated — only a fully-written, newline-terminated line is a
    // committed record. The torn tail is DISCARDED (truncated) so later appends
    // can never fuse onto an uncommitted fragment.
    if (fs.existsSync(this.journalPath)) {
      try {
        const buf = fs.readFileSync(this.journalPath);
        if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) {
          const lastNl = buf.lastIndexOf(0x0a);
          fs.truncateSync(this.journalPath, lastNl === -1 ? 0 : lastNl + 1);
          this.log('[conversation-registry] discarded torn journal tail (uncommitted record)');
        }
      } catch {
        /* read failure falls through to the per-line handling below */
      }
    }

    const records: Array<{ rec: JournalRecord; file: string }> = [];
    let halted = false;
    for (const file of files) {
      if (halted) break;
      let content: string;
      try {
        content = fs.readFileSync(file, 'utf-8');
      } catch {
        continue;
      }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.length === 0) continue;
        let rec: JournalRecord;
        try {
          rec = JSON.parse(line) as JournalRecord;
          if (!rec || typeof rec.seq !== 'number' || typeof rec.op !== 'string') throw new Error('malformed record');
        } catch {
          // NON-tail corruption fails CLOSED (R7-minor-3): a newline-TERMINATED
          // line failing parse is a storage lie, never skipped — HALT the replay
          // into the quarantine-aside path + attention + durability incident.
          const aside = `${file}.corrupt-${Date.now()}`;
          try {
            fs.renameSync(file, aside);
          } catch {
            /* preserve best-effort */
          }
          this.journalQuarantinedAt = this.now().toISOString();
          this.durabilityIncidents++; // §3.7 broadened SQLite-migration trigger input
          this.attention(
            'conversation-registry:journal-corrupt',
            'Conversation registry journal corruption — replay halted',
            `A committed (newline-terminated) journal record in ${path.basename(file)} failed to parse at line ${i + 1}. The file was preserved aside at ${aside}; replay halted at that point (records before it are applied). This counts as a DURABILITY INCIDENT (§3.7 — evaluate the SQLite migration). Backup restore is the primary recovery path (§6.2).`,
          );
          halted = true;
          break;
        }
        records.push({ rec, file });
      }
    }

    records.sort((a, b) => a.rec.seq - b.rec.seq); // single global seq order (R3-M14)
    let maxSeq = this.snapshotHighWaterSeq;
    for (const { rec } of records) {
      if (rec.seq > maxSeq) maxSeq = rec.seq;
      if (rec.seq <= this.snapshotHighWaterSeq) continue; // snapshot already incorporates it
      this.applyJournalRecord(rec);
    }
    // Boot counter resumes from the max seen — never 0/1 (R3-M14).
    this.seqCounter = Math.max(this.seqCounter, maxSeq);
    this.journalBytes = fs.existsSync(this.journalPath) ? fs.statSync(this.journalPath).size : 0;
    this.journalLines = 0;
    if (fs.existsSync(this.journalPath)) {
      try {
        const content = fs.readFileSync(this.journalPath, 'utf-8');
        this.journalLines = content.length === 0 ? 0 : content.split('\n').filter((l) => l.length > 0).length;
      } catch {
        /* count is rotation bookkeeping only */
      }
    }
  }

  /** Idempotent, seq-ordered application (§3.4) — safe to re-run any number of times. */
  private applyJournalRecord(rec: JournalRecord): void {
    if (!(JOURNAL_OPS as readonly string[]).includes(rec.op)) {
      // UNKNOWN-op tolerance (R8-minor-2): version skew, not corruption — skip
      // the application, PRESERVE the line (append-only; never rewritten), and
      // suspend snapshot flushing (R9-M1/R10-M1) until a recognizing version
      // applies it. The deduped attention item is raised once after replay.
      this.unappliedUnknownOps.push({ seq: rec.seq, op: rec.op });
      return;
    }
    switch (rec.op as JournalOp) {
      case 'mint': {
        if (typeof rec.id !== 'number' || !(rec.id < 0) || !Array.isArray(rec.tuple)) return;
        const tuple: ConversationTuple = { platform: 'slack', channelId: rec.tuple[1], threadTs: rec.tuple[2] ?? null };
        const tKey = tupleKeyFor(tuple);
        const existing = this.byTuple.get(tKey);
        if (existing) {
          // Re-apply / metadata upgrade (the `_`→teamId upgrade is journaled as
          // op:"mint" with the rewritten key — §3.1): same tuple, refreshed key.
          if (rec.key && rec.key !== canonicalKeyFor(tuple, existing.workspaceId)) {
            const parsed = parseCanonicalKey(rec.key);
            if (parsed && parsed.workspaceId !== existing.workspaceId) {
              this.conversations.delete(canonicalKeyFor(tuple, existing.workspaceId));
              existing.workspaceId = parsed.workspaceId;
              this.conversations.set(rec.key, existing);
            }
          }
          return; // idempotent
        }
        const parsed = rec.key ? parseCanonicalKey(rec.key) : null;
        const entry: ConversationEntry = {
          id: rec.id,
          platform: 'slack',
          workspaceId: parsed?.workspaceId ?? WORKSPACE_PLACEHOLDER,
          channelId: tuple.channelId,
          threadTs: tuple.threadTs,
          mintedAt: rec.ts,
          mintedBy: rec.hlc?.node ?? 'unknown',
          origin: rec.origin ?? 'adopted-legacy-hash',
          reachability: 'ok',
          hlc: rec.hlc ?? { physical: Date.parse(rec.ts) || 0, logical: 0, node: 'unknown' },
        };
        this.indexEntry(canonicalKeyFor(tuple, entry.workspaceId), entry);
        return;
      }
      case 'alias': {
        if (typeof rec.id === 'number' && typeof rec.target === 'number') this.aliases.set(rec.id, rec.target);
        return;
      }
      case 'reachability': {
        if (typeof rec.id !== 'number' || !rec.reachability) return;
        const entry = this.byId.get(rec.id);
        if (entry) entry.reachability = rec.reachability;
        return;
      }
      case 'bind-pin': {
        if (typeof rec.id !== 'number' || !Array.isArray(rec.tuple)) return;
        const existing = this.bindPins.get(rec.id);
        if (existing) existing.refcount = rec.refcount ?? existing.refcount + 1;
        else this.bindPins.set(rec.id, { tuple: rec.tuple as [string, string, string | null], refcount: rec.refcount ?? 1 });
        return;
      }
      case 'bind-release': {
        if (typeof rec.id !== 'number') return;
        const pin = this.bindPins.get(rec.id);
        if (!pin) return;
        pin.refcount = rec.refcount ?? pin.refcount - 1;
        if (pin.refcount <= 0) this.bindPins.delete(rec.id);
        return;
      }
      case 'ambiguous-send': {
        if (typeof rec.conversationId !== 'number' || !rec.logicalSendId) return;
        this.ambiguousSends.set(`${rec.conversationId}|${rec.logicalSendId}`, { recordedAt: rec.ts });
        this.sendIntents.delete(`${rec.conversationId}|${rec.logicalSendId}`);
        return;
      }
      case 'send-retire': {
        if (typeof rec.conversationId !== 'number' || !rec.logicalSendId) return;
        this.ambiguousSends.delete(`${rec.conversationId}|${rec.logicalSendId}`);
        this.sendIntents.delete(`${rec.conversationId}|${rec.logicalSendId}`);
        return;
      }
      case 'send-intent': {
        if (typeof rec.conversationId !== 'number' || !rec.logicalSendId) return;
        // Malformed/unknown lane resolves toward RETRY (content-hash treatment)
        // — R9-minor-1/R10-low-2 (loss-is-never-silent picks retry).
        const lane = rec.lane === 'logical' ? 'logical' : 'content-hash';
        this.sendIntents.set(`${rec.conversationId}|${rec.logicalSendId}`, { lane, seq: rec.seq });
        return;
      }
      case 'send-intent-resolved': {
        if (typeof rec.conversationId !== 'number' || !rec.logicalSendId) return;
        this.sendIntents.delete(`${rec.conversationId}|${rec.logicalSendId}`);
        return;
      }
    }
  }

  private indexEntry(key: string, entry: ConversationEntry): void {
    this.conversations.set(key, entry);
    this.byId.set(entry.id, entry);
    this.byTuple.set(tupleKeyFor({ platform: 'slack', channelId: entry.channelId, threadTs: entry.threadTs }), entry);
  }

  /** Derived indexes 3–5 (§3.4) — pure functions of the entry set, rebuilt at boot. */
  private rebuildDerivedIndexes(): void {
    this.reservedCanonicals.clear();
    this.displacedAssignments.clear();
    this.candClaimants.clear();
    for (const entry of this.conversations.values()) {
      const tuple: ConversationTuple = { platform: 'slack', channelId: entry.channelId, threadTs: entry.threadTs };
      const cand = candidateIdForRoutingKey(routingKeyForTuple(tuple));
      const tKey = tupleKeyFor(tuple);
      let claimants = this.candClaimants.get(cand);
      if (!claimants) {
        claimants = new Set();
        this.candClaimants.set(cand, claimants);
      }
      claimants.add(tKey);
      if (entry.id === cand) this.reservedCanonicals.set(cand, tKey);
      else this.displacedAssignments.set(entry.id, tKey);
    }
  }

  /** R5-C1/R6-M3: the assignment-beats-alias filter re-run over composed state —
   *  an alias shadowing a reserved canonical or an assigned displacement offset
   *  is dropped exactly as it would be at ingest. */
  private applyAliasAssignmentFilter(): void {
    for (const aliasId of [...this.aliases.keys()]) {
      if (this.reservedCanonicals.has(aliasId) || this.displacedAssignments.has(aliasId)) {
        this.aliases.delete(aliasId);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Journal append (§3.4 — dedicated single-writer discipline, G3)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Append ONE newline-terminated record. `seq` assignment and the byte-write
   * happen atomically per record under a synchronous append (Node's
   * single-threaded sync I/O IS the append mutex — no interleaving is
   * possible), satisfying the §3.4 G3 single-writer contract.
   */
  private appendJournal(rec: Omit<JournalRecord, 'seq' | 'ts'>, opts: { fsync: boolean }): number {
    const seq = ++this.seqCounter;
    const line = `${JSON.stringify({ seq, ...rec, ts: this.now().toISOString() })}\n`;
    this.rotateJournalIfNeeded(Buffer.byteLength(line));
    if (this.journalFd === null) {
      const created = !fs.existsSync(this.journalPath);
      this.journalFd = fs.openSync(this.journalPath, 'a');
      if (created) this.fsyncDir(); // directory entry durable on file creation (§3.4)
    }
    fs.writeSync(this.journalFd, line);
    this.journalBytes += Buffer.byteLength(line);
    this.journalLines += 1;
    if (opts.fsync && !(this.d.isJournalFsyncDisabled?.() ?? false)) {
      try {
        fs.fsyncSync(this.journalFd);
      } catch {
        /* macOS platform footnote (§3.4): cheap-fsync is the deliberate choice */
      }
    }
    return seq;
  }

  private fsyncDir(): void {
    try {
      const dirFd = fs.openSync(this.d.stateDir, 'r');
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      /* @silent-fallback-ok — directory fsync is best-effort, platform-dependent (§3.4 macOS footnote); the record append itself is the durability authority */
    }
  }

  private rotateJournalIfNeeded(incomingBytes: number): void {
    const rotateBytes = this.d.journalRotateBytes ?? 8388608;
    const rotateLines = this.d.journalRotateLines ?? 50000;
    if (this.journalBytes + incomingBytes <= rotateBytes && this.journalLines < rotateLines) return;
    if (!fs.existsSync(this.journalPath)) return;
    if (this.journalFd !== null) {
      try {
        fs.fsyncSync(this.journalFd);
      } catch {
        /* @silent-fallback-ok — pre-rotation fsync is best-effort; every durable record already fsynced at append time (§3.3 WAL rule) */
      }
      fs.closeSync(this.journalFd);
      this.journalFd = null;
    }
    // Unique all-digit suffix (two rotations can land in one millisecond; the
    // suffix must keep matching the retained-file scan + the backup glob).
    let suffix = Date.now();
    while (fs.existsSync(`${this.journalPath}.${suffix}`)) suffix++;
    const rotatedPath = `${this.journalPath}.${suffix}`;
    fs.renameSync(this.journalPath, rotatedPath);
    this.fsyncDir();
    this.journalBytes = 0;
    this.journalLines = 0;
    this.pruneRotatedJournals();
  }

  /**
   * Prune ONLY fully-superseded rotated files: every record ≤ the PERSISTED
   * snapshot high-water, older than the 7-day retention floor (§8 — a recovery
   * requirement), and containing no unapplied unknown-op record (R8-minor-2).
   * Under snapshot suspension the persisted high-water stays pre-skew, so every
   * file the eventual re-upgrade needs is retained MECHANICALLY (R10-M1).
   */
  private pruneRotatedJournals(): void {
    const persistedHighWater = this.readPersistedHighWater();
    const retentionFloorMs = 7 * 24 * 60 * 60 * 1000;
    const unknownSeqs = new Set(this.unappliedUnknownOps.map((u) => u.seq));
    for (const file of this.journalFiles()) {
      if (file === this.journalPath) continue;
      try {
        const stat = fs.statSync(file);
        if (this.now().getTime() - stat.mtimeMs < retentionFloorMs) continue;
        const content = fs.readFileSync(file, 'utf-8');
        let maxSeq = 0;
        let hasUnknown = false;
        for (const line of content.split('\n')) {
          if (!line) continue;
          try {
            const rec = JSON.parse(line) as JournalRecord;
            if (typeof rec.seq === 'number' && rec.seq > maxSeq) maxSeq = rec.seq;
            if (!(JOURNAL_OPS as readonly string[]).includes(rec.op) || unknownSeqs.has(rec.seq)) hasUnknown = true;
          } catch {
            hasUnknown = true; // @silent-fallback-ok — fails toward RETENTION: a file we cannot fully read is never pruned (§3.4)
          }
        }
        if (!hasUnknown && maxSeq > 0 && maxSeq <= persistedHighWater) {
          SafeFsExecutor.safeUnlinkSync(file, { operation: 'conversation-registry journal rotation prune (fully-superseded rotated file — §3.4)' });
        }
      } catch {
        /* @silent-fallback-ok — prune is hygiene; a failed prune retains the file (the safe direction), never gates identity */
      }
    }
  }

  private readPersistedHighWater(): number {
    try {
      const raw = JSON.parse(fs.readFileSync(this.snapshotPath, 'utf-8')) as SnapshotShape;
      return typeof raw?.snapshotHighWaterSeq === 'number' ? raw.snapshotHighWaterSeq : 0;
    } catch {
      // @silent-fallback-ok — an unreadable snapshot reads as high-water 0, so the
      // prune rule supersedes NOTHING (fails toward retaining every journal file).
      return 0;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Snapshot (batched, size-adaptive — §3.4)
  // ─────────────────────────────────────────────────────────────────────────

  private scheduleSnapshot(): void {
    this.snapshotDirty = true;
    if (this.batchDepth > 0) return; // batched-save window (§6.2 adoption pass)
    if (this.unappliedUnknownOps.length > 0) return; // SUSPENSION (R9-M1/R10-M1)
    if (this.snapshotTimer) return;
    const base = this.d.snapshotBaseIntervalMs ?? 2000;
    const step = this.d.snapshotAdaptiveStep ?? 5000;
    const max = this.d.snapshotMaxIntervalMs ?? 60000;
    const interval = Math.min(Math.max(base * Math.ceil(Math.max(this.conversations.size, 1) / step), base), max);
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      void this.flushSnapshot();
    }, interval);
    this.snapshotTimer.unref?.();
  }

  /** Force a flush now (shutdown/tests). Honors the unknown-op suspension. */
  async flushSnapshot(): Promise<void> {
    if (this.flushInFlight) return;
    if (this.unappliedUnknownOps.length > 0) return; // pre-skew snapshot stays put (R10-M1)
    this.flushInFlight = true;
    try {
      const shape: SnapshotShape = {
        version: 1,
        snapshotHighWaterSeq: this.seqCounter,
        ...(this.workspacePin ? { workspacePin: this.workspacePin } : {}),
        conversations: Object.fromEntries(this.conversations),
        aliases: Object.fromEntries([...this.aliases].map(([k, v]) => [String(k), v])),
        bindPins: Object.fromEntries([...this.bindPins].map(([k, v]) => [String(k), v])),
        ambiguousSends: Object.fromEntries(this.ambiguousSends),
        sendIntents: Object.fromEntries(this.sendIntents),
      };
      const serialized = JSON.stringify(shape, null, 2);
      const tmp = `${this.snapshotPath}.tmp`;
      if (this.conversations.size > OFFLOOP_ENTRY_TRIGGER || this.lastSnapshotBytes > OFFLOOP_BYTES_TRIGGER) {
        // §3.4 pinned off-loop trigger: async write of the pre-serialized buffer.
        await fs.promises.writeFile(tmp, serialized);
        await fs.promises.rename(tmp, this.snapshotPath);
      } else {
        fs.writeFileSync(tmp, serialized);
        fs.renameSync(tmp, this.snapshotPath);
      }
      this.snapshotHighWaterSeq = shape.snapshotHighWaterSeq;
      this.lastSnapshotBytes = Buffer.byteLength(serialized);
      this.snapshotDirty = false;
      this.maybeRaiseGrowthTripwire();
    } catch (err) {
      this.log(`[conversation-registry] snapshot flush failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.flushInFlight = false;
    }
  }

  private maybeRaiseGrowthTripwire(): void {
    if (this.conversations.size >= ENTRY_THRESHOLD || this.lastSnapshotBytes >= FILE_BYTES_THRESHOLD) {
      this.attention(
        'conversation-registry:growth-threshold',
        'Conversation registry approaching its JSON-store ceiling',
        `entryCount=${this.conversations.size} (ceiling ~${ENTRY_CEILING}) / fileSizeBytes=${this.lastSnapshotBytes}. The §11.10 append-journal-as-primary / SQLite migration must land BEFORE the ceiling (scalability-G2).`,
      );
    }
  }

  /** Batched-save window for the adoption pass / bursts (§3.4/§6.2): one flush. */
  beginBatch(): void {
    this.batchDepth++;
  }

  endBatch(): void {
    this.batchDepth = Math.max(0, this.batchDepth - 1);
    if (this.batchDepth === 0 && this.snapshotDirty) this.scheduleSnapshot();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Mint (§3.3)
  // ─────────────────────────────────────────────────────────────────────────

  /** §3.3 `candidateCollides` — pure O(1) lookups, never a live-tuple scan:
   *  (a) reserved canonical of a DIFFERENT tuple; (b) alias table; (c) the
   *  GLOBAL displaced-assignment set (R4-C1). */
  private candidateCollides(id: number, tKey: string): boolean {
    const reserved = this.reservedCanonicals.get(id);
    if (reserved !== undefined && reserved !== tKey) return true;
    if (this.aliases.has(id)) return true;
    const displaced = this.displacedAssignments.get(id);
    if (displaced !== undefined && displaced !== tKey) return true;
    return false;
  }

  /** Resolve the fleet workspace pin (§3.1 order: config → stored candidate). */
  private resolvedWorkspacePin(): { value: string; confirmedLocally: boolean } | null {
    const configPin = this.readConfigPin();
    if (configPin) return { value: configPin, confirmedLocally: true };
    return this.workspacePin;
  }

  /**
   * Workspace admission for a mint (§3.1). Returns the workspaceId to record
   * (concrete or `_`), or 'refused' on the per-machine multi-workspace gate.
   */
  private admitWorkspace(): string | 'refused' {
    let observed: string | undefined;
    try {
      observed = this.d.getLocalWorkspaceId?.();
    } catch {
      // @silent-fallback-ok — a throwing workspace source degrades to the `_`
      // placeholder (upgrades in place later, §3.1) — never a blocked mint.
      observed = undefined;
    }
    if (!observed || !SLACK_WORKSPACE_ID_RE.test(observed)) return WORKSPACE_PLACEHOLDER;
    const pin = this.resolvedWorkspacePin();
    if (!pin) {
      // First concrete LOCAL observation writes the candidate and is immediately
      // confirmed for it — self-corroboration is the designed single-machine /
      // first-machine path (R6-minor-5).
      this.workspacePin = { value: observed, source: 'local-observed', confirmedLocally: true };
      this.scheduleSnapshot();
      return observed;
    }
    if (pin.value !== observed && pin.confirmedLocally) {
      this.attention(
        'conversation-registry:multi-workspace',
        'Second Slack workspace refused (multi-workspace-unsupported)',
        `A mint arrived authenticated to workspace ${observed}, but this fleet's pin is ${pin.value}. Phase 1 supports exactly ONE Slack workspace (§3.1); Slack Connect / multi-workspace identity is Phase 7.1. Check conversationIdentity.workspacePin.`,
      );
      return 'refused';
    }
    return observed;
  }

  /** Breaker window state for a channel — bounded map with stale-window eviction (§3.3, R3-minor). */
  private breakerWindow(channelId: string): { windowStartMs: number; speculative: number; durable: number; episodeNotified: boolean } {
    const windowMs = this.d.breaker?.windowMs ?? 600000;
    const nowMs = this.now().getTime();
    let w = this.breakerWindows.get(channelId);
    if (!w || nowMs - w.windowStartMs >= windowMs) {
      w = { windowStartMs: nowMs, speculative: 0, durable: 0, episodeNotified: false };
      if (!this.breakerWindows.has(channelId) && this.breakerWindows.size >= BREAKER_MAX_TRACKED_CHANNELS) {
        // Evict the stalest window — never a monotonic map (Bounded Blast Radius).
        let oldest: string | null = null;
        let oldestStart = Infinity;
        for (const [k, v] of this.breakerWindows) {
          if (v.windowStartMs < oldestStart) {
            oldestStart = v.windowStartMs;
            oldest = k;
          }
        }
        if (oldest) this.breakerWindows.delete(oldest);
      }
      this.breakerWindows.set(channelId, w);
    }
    return w;
  }

  /**
   * Speculative (inbound-triggered) get-or-create mint (§6.3 eager mint).
   * NEVER throws and never blocks delivery — every failure degrades toward
   * "no durable id" or a collision-checked read (§3.6).
   */
  mintForInbound(routingKey: string, opts?: { label?: string }): InboundMintResult {
    this.load();
    const tuple = tupleForRoutingKey(routingKey);
    if (!tuple) return { id: null, created: false, registered: false, degraded: 'unparseable-key' };
    return this.mintTuple(tuple, { durableBinding: false, label: opts?.label, origin: undefined });
  }

  /**
   * Durable-binding-forced mint (§3.3 breaker carve-out): registered REGARDLESS
   * of the speculative budget, journal line fsynced BEFORE the id returns (the
   * WAL rule). Its OWN higher budget yields a typed capacity refusal at the
   * cap — never a silent drop (adversarial-B).
   */
  mintForDurableBinding(routingKey: string, opts?: { label?: string }): DurableMintResult {
    this.load();
    const tuple = tupleForRoutingKey(routingKey);
    if (!tuple) return { ok: false, error: 'unparseable-key' };
    if (!this.recordingEnabled()) {
      // R2-integration-§9: an unjournaled bind would be unresolvable after a
      // restart — refuse, typed + loud. Positive Telegram binds are unaffected
      // (they never reach the registry).
      this.attention(
        'conversation-registry:recording-disabled-bind',
        'Durable bind on a minted conversation refused — recording is disabled',
        'conversationIdentity.recording.enabled is false (the emergency kill-switch). A durable-state open on a MINTED id is refused while recording is off (typed conversation-recording-disabled): an unjournaled bind would silently die on restart. Re-enable recording to restore minted binds.',
      );
      return { ok: false, error: 'conversation-recording-disabled' };
    }
    const existing = this.byTuple.get(tupleKeyFor(tuple));
    if (existing) {
      this.maybeUpgradeWorkspace(existing);
      return { ok: true, id: existing.id, created: false };
    }
    const w = this.breakerWindow(tuple.channelId);
    const durableCap = this.d.breaker?.durableBindingPerWindow ?? 50;
    if (w.durable >= durableCap) {
      this.attention(
        'conversation-registry:durable-capacity',
        'Durable-binding mint budget exhausted for a channel',
        `Channel ${tuple.channelId} exceeded ${durableCap} durable-binding registrations in the window. The binding-open is refused with a typed conversation-registration-capacity error — never a silent drop (§3.3 adversarial-B).`,
      );
      return { ok: false, error: 'conversation-registration-capacity' };
    }
    const res = this.mintTuple(tuple, { durableBinding: true, label: opts?.label });
    if (res.id === null || !res.registered) {
      if (res.degraded === 'multi-workspace-unsupported') return { ok: false, error: 'multi-workspace-unsupported' };
      return { ok: false, error: 'mint-failure' };
    }
    w.durable++;
    return { ok: true, id: res.id, created: res.created };
  }

  /** §3.1 in-place `_`→teamId upgrade — LOCAL authenticated source ONLY. */
  private maybeUpgradeWorkspace(entry: ConversationEntry): void {
    if (entry.workspaceId !== WORKSPACE_PLACEHOLDER) return;
    const admitted = this.admitWorkspace();
    if (admitted === 'refused' || admitted === WORKSPACE_PLACEHOLDER) return;
    const tuple: ConversationTuple = { platform: 'slack', channelId: entry.channelId, threadTs: entry.threadTs };
    const oldKey = canonicalKeyFor(tuple, entry.workspaceId);
    this.conversations.delete(oldKey);
    entry.workspaceId = admitted;
    const newKey = canonicalKeyFor(tuple, admitted);
    this.conversations.set(newKey, entry);
    // Journaled (§3.1) as an idempotent op:"mint" re-apply with the rewritten
    // key (the op enum has no distinct upgrade op — §3.4/R6-low-2 precedent).
    this.appendJournal(
      {
        op: 'mint',
        key: newKey,
        tuple: [tuple.platform, tuple.channelId, tuple.threadTs],
        id: entry.id,
        origin: entry.origin,
        hlc: entry.hlc,
      },
      { fsync: false },
    );
    this.scheduleSnapshot();
    this.log(`[conversation-registry] workspace upgraded in place: ${oldKey} → ${newKey} (id ${entry.id})`);
  }

  private mintTuple(
    tuple: ConversationTuple,
    opts: { durableBinding: boolean; label?: string; origin?: ConversationOrigin },
  ): InboundMintResult {
    const tKey = tupleKeyFor(tuple);
    const existing = this.byTuple.get(tKey);
    if (existing) {
      this.maybeUpgradeWorkspace(existing);
      if (opts.label && opts.label !== existing.label) {
        existing.label = opts.label; // write-on-change (§3.4 G4)
        this.scheduleSnapshot();
      }
      return { id: existing.id, created: false, registered: true };
    }

    const routingKey = routingKeyForTuple(tuple);
    const candidate = candidateIdForRoutingKey(routingKey);

    const workspace = this.admitWorkspace();
    if (workspace === 'refused') {
      return { id: null, created: false, registered: false, degraded: 'multi-workspace-unsupported' };
    }

    if (!this.recordingEnabled()) {
      // D1 degradation (§3.6): behavior-identical to legacy hashing — candidate
      // + collision-checked read (B6), NO durable write, NO journal fsync.
      return { id: this.collisionCheckedRead(candidate, tKey), created: false, registered: false, degraded: 'recording-disabled' };
    }

    if (!opts.durableBinding) {
      const w = this.breakerWindow(tuple.channelId);
      const cap = this.d.breaker?.speculativePerWindow ?? 200;
      if (w.speculative >= cap) {
        // The breaker DROPS speculative registrations to NOWHERE (zero pending
        // state) — the candidate re-mints for free on a later inbound. Delivery
        // still proceeds on a collision-checked read (B6).
        this.breakerEpisodes++;
        if (!w.episodeNotified) {
          w.episodeNotified = true;
          this.attention(
            'conversation-registry:mint-breaker',
            'Mint-rate breaker engaged for a channel',
            `Channel ${tuple.channelId} exceeded ${cap} new speculative conversation registrations in the window. Further inbound registrations this window are dropped (they re-mint later); delivery is unaffected (§3.3 Bounded Blast Radius).`,
          );
        }
        return { id: this.collisionCheckedRead(candidate, tKey), created: false, registered: false, degraded: 'breaker-dropped' };
      }
      w.speculative++;
    }

    const walk = walkDisplacement(candidate, (id) => this.candidateCollides(id, tKey));
    if (!walk.ok) {
      // Probe overflow (astronomically unlikely) degrades to the §3.6
      // pending-mint path — never a silently-un-ingestable id.
      const key = canonicalKeyFor(tuple, workspace);
      if (!this.pendingMints.has(key)) {
        if (this.pendingMints.size >= PENDING_MINT_MAX) this.pendingMintDrops++;
        else this.pendingMints.set(key, { firstAt: this.now().toISOString() });
      }
      return { id: null, created: false, registered: false, degraded: 'probe-overflow' };
    }

    const probed = walk.probes > 0;
    const nowIso = this.now().toISOString();
    const machineId = this.safeMachineId();
    const entry: ConversationEntry = {
      id: walk.id,
      platform: 'slack',
      workspaceId: workspace,
      channelId: tuple.channelId,
      threadTs: tuple.threadTs,
      mintedAt: nowIso,
      mintedBy: machineId,
      // A fresh non-probed local mint's id IS the legacy-hash id — the honest
      // origin within the frozen §3.4 enum; probed mints are 'minted-probed'.
      origin: opts.origin ?? (probed ? 'minted-probed' : 'adopted-legacy-hash'),
      reachability: 'ok',
      hlc: { physical: this.now().getTime(), logical: 0, node: machineId },
      ...(opts.label ? { label: opts.label } : {}),
    };
    const key = canonicalKeyFor(tuple, workspace);

    // Synchronous assignment: authoritative cache + reverse + tuple index +
    // derived occupancy — the id RETURNED equals the id that will PERSIST.
    this.indexEntry(key, entry);
    let claimants = this.candClaimants.get(candidate);
    if (!claimants) {
      claimants = new Set();
      this.candClaimants.set(candidate, claimants);
    }
    claimants.add(tKey);
    if (!probed) this.reservedCanonicals.set(candidate, tKey);
    else this.displacedAssignments.set(walk.id, tKey);

    // WAL rule (§3.3): a PROBED or durable-binding-forced mint append+fsyncs
    // ONE journal line BEFORE the id is returned (not re-derivable after a
    // crash). A pure SPECULATIVE non-probed mint performs NO synchronous
    // journal write — it rides the batched snapshot only (§3.4 fsync
    // discipline; its candidate re-mints deterministically for free).
    if (probed || opts.durableBinding) {
      this.appendJournal(
        {
          op: 'mint',
          key,
          tuple: [tuple.platform, tuple.channelId, tuple.threadTs],
          id: entry.id,
          origin: entry.origin,
          hlc: entry.hlc,
        },
        { fsync: true },
      );
    }
    this.pendingMints.delete(key);
    this.lastMintAt = nowIso;
    this.scheduleSnapshot();
    return { id: entry.id, created: true, registered: true };
  }

  private safeMachineId(): string {
    try {
      return this.d.machineId() || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * B6 collision-checked read for degraded paths (breaker-drop / recording-off):
   * never delivers on a raw candidate occupied by a DIFFERENT tuple — resolves
   * via the same key-derived probe for the READ ONLY (no registration).
   */
  private collisionCheckedRead(candidate: number, tKey: string): number {
    const walk = walkDisplacement(candidate, (id) => this.candidateCollides(id, tKey));
    return walk.ok ? walk.id : candidate;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Resolution (§2/§8)
  // ─────────────────────────────────────────────────────────────────────────

  /** `resolve(id)`: positive → Telegram pass-through; negative → registry
   *  lookup, aliases followed exactly ONE hop; unknown → null. */
  resolve(id: number): ConversationDescriptor | null {
    this.load();
    if (!Number.isSafeInteger(id) || id === 0) return null;
    if (id > 0) return { platform: 'telegram', topicId: id, passThrough: true };
    const aliasTarget = this.aliases.get(id);
    const entry = this.byId.get(aliasTarget ?? id);
    if (!entry) return null;
    return {
      platform: 'slack',
      id: entry.id,
      key: canonicalKeyFor({ platform: 'slack', channelId: entry.channelId, threadTs: entry.threadTs }, entry.workspaceId),
      channelId: entry.channelId,
      threadTs: entry.threadTs,
      workspaceId: entry.workspaceId,
      origin: entry.origin,
      reachability: entry.reachability,
      ...(entry.label !== undefined ? { label: entry.label } : {}),
      ...(aliasTarget !== undefined ? { aliasOf: aliasTarget } : {}),
    };
  }

  /** Forward lookup by canonical key OR transport sessionKey — mints NOTHING (§8). */
  resolveByKey(keyOrSessionKey: string): ConversationDescriptor | null {
    this.load();
    if (/^\d+$/.test(keyOrSessionKey)) {
      return { platform: 'telegram', topicId: Number(keyOrSessionKey), passThrough: true };
    }
    const parsed = parseCanonicalKey(keyOrSessionKey);
    const tuple = parsed?.tuple ?? tupleForRoutingKey(keyOrSessionKey);
    if (!tuple) return null;
    const entry = this.byTuple.get(tupleKeyFor(tuple));
    return entry ? this.resolve(entry.id) : null;
  }

  /**
   * `idForSessionKey` — GET-OR-CREATE (§6.0 #12, a named mint chokepoint).
   * Positive numeric session keys pass through; Slack routing keys mint.
   */
  idForSessionKey(sessionKey: string): number | null {
    this.load();
    if (/^\d+$/.test(sessionKey)) return Number(sessionKey);
    return this.mintForInbound(sessionKey).id;
  }

  /** Read-only inventory for GET /conversations (§8). */
  list(opts?: { platform?: string; limit?: number }): Array<{ key: string; entry: ConversationEntry }> {
    this.load();
    const limit = Math.max(1, Math.min(opts?.limit ?? 500, 5000));
    const out: Array<{ key: string; entry: ConversationEntry }> = [];
    for (const [key, entry] of this.conversations) {
      if (opts?.platform && entry.platform !== opts.platform) continue;
      out.push({ key, entry });
      if (out.length >= limit) break;
    }
    return out;
  }

  aliasTable(): Record<string, number> {
    this.load();
    return Object.fromEntries([...this.aliases].map(([k, v]) => [String(k), v]));
  }

  entryCount(): number {
    this.load();
    return this.conversations.size;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Adoption pass (§6.2)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Idempotent boot-time ensure: pre-register channel-level conversations from
   * the channel registry with their legacy-hash ids, inside ONE batched-save
   * window. GATED to channels with ≥1 authorized-sender message on record
   * (security-B8) — an auto-join channel mints lazily on its first authorized
   * inbound instead. A pre-population CONVENIENCE, not a recovery requirement.
   */
  runAdoptionPass(
    channels: Array<{ channelId: string; name?: string }>,
    hasAuthorizedTraffic: (channelId: string) => boolean,
  ): { adopted: number; skippedUnauthorized: number } {
    this.load();
    let adopted = 0;
    let skippedUnauthorized = 0;
    this.beginBatch();
    try {
      for (const ch of channels) {
        let authorized = false;
        try {
          authorized = hasAuthorizedTraffic(ch.channelId);
        } catch {
          authorized = false; // fail toward not-pre-minting (it mints lazily later)
        }
        if (!authorized) {
          skippedUnauthorized++;
          continue;
        }
        const res = this.mintForInbound(ch.channelId, ch.name ? { label: ch.name } : undefined);
        if (res.created) adopted++;
      }
    } finally {
      this.endBatch();
    }
    this.adoptionState = { ranAt: this.now().toISOString(), adopted, skippedUnauthorized };
    this.log(`[conversation-registry] adoption pass: ${adopted} adopted, ${skippedUnauthorized} skipped (no authorized traffic)`);
    return { adopted, skippedUnauthorized };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Health (§8 — the e2e "feature is alive" target)
  // ─────────────────────────────────────────────────────────────────────────

  health(): Record<string, unknown> {
    this.load();
    const byOrigin: Record<string, number> = {};
    const byPlatform: Record<string, number> = {};
    for (const entry of this.conversations.values()) {
      byOrigin[entry.origin] = (byOrigin[entry.origin] ?? 0) + 1;
      byPlatform[entry.platform] = (byPlatform[entry.platform] ?? 0) + 1;
    }
    let fileSizeBytes = 0;
    try {
      fileSizeBytes = fs.existsSync(this.snapshotPath) ? fs.statSync(this.snapshotPath).size : 0;
    } catch {
      /* observability */
    }
    let retainedJournalBytes = 0;
    try {
      for (const f of this.journalFiles()) retainedJournalBytes += fs.statSync(f).size;
    } catch {
      /* observability */
    }
    return {
      // Resident-heap honesty (§3.4): entryCount is the heap axis — resident
      // heap is plausibly 5–10× fileSizeBytes at the 100k envelope.
      entryCount: this.conversations.size,
      fileSizeBytes,
      byPlatform,
      byOrigin,
      aliasCount: this.aliases.size,
      lastMintAt: this.lastMintAt,
      adoptionPass: this.adoptionState,
      recordingEnabled: this.recordingEnabled(),
      workspacePin: this.workspacePin ? { value: this.workspacePin.value, source: this.workspacePin.source } : null,
      mintBudget: {
        channelsTracked: this.breakerWindows.size,
        breakerEpisodes: this.breakerEpisodes,
      },
      pendingMints: { count: this.pendingMints.size, dropped: this.pendingMintDrops },
      quarantine: {
        snapshotQuarantinedAt: this.snapshotQuarantinedAt,
        journalQuarantinedAt: this.journalQuarantinedAt,
        durabilityIncidents: this.durabilityIncidents,
      },
      // Snapshot-suspension observability (R11-low-1).
      snapshotSuspended: this.unappliedUnknownOps.length > 0,
      firstUnappliedUnknownSeq: this.unappliedUnknownOps[0]?.seq ?? null,
      unappliedUnknownCount: this.unappliedUnknownOps.length,
      retainedJournalBytes,
      ceiling: {
        entryCeiling: ENTRY_CEILING,
        thresholdReached: this.conversations.size >= ENTRY_THRESHOLD || fileSizeBytes >= FILE_BYTES_THRESHOLD,
      },
      seq: { counter: this.seqCounter, snapshotHighWaterSeq: this.snapshotHighWaterSeq },
    };
  }

  /** Close file handles + flush (shutdown/tests). */
  async close(): Promise<void> {
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    await this.flushSnapshot();
    if (this.journalFd !== null) {
      try {
        fs.fsyncSync(this.journalFd);
        fs.closeSync(this.journalFd);
      } catch {
        /* @silent-fallback-ok — shutdown teardown; durable records were fsynced at append time */
      }
      this.journalFd = null;
    }
  }
}
