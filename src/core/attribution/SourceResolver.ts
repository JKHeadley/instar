/**
 * SourceResolver — does a `[source: ...]` marker point at a real logged message, and
 * can that be established from here? Spec: docs/specs/attribution-paper-trail.md section 2.
 *
 * The outcomes stay distinct on purpose. A machine that is down, a date older than a log's
 * retained range, or a declared record gap means "cannot be checked here". `not-found` means
 * "not on any live machine"; a retired machine cannot be ruled out, so it never means "false".
 */
import fs from 'node:fs';
import readline from 'node:readline';
import type { MessageAuthorship } from '../AspAuthorshipJoin.js';
import type { SourceRef } from './marker.js';

export interface LocalLookup {
  /** The raw log row, or null when this machine does not hold it. */
  row: Record<string, unknown> | null;
  /** The UTC date of this machine's oldest retained row. Null when the log is empty or absent. */
  retainedFrom: string | null;
  /** The row existed and the person deleted it. */
  removed?: boolean;
  /** The row is a pinned copy: it is no longer in this machine's log. */
  pinned?: boolean;
  /** This machine's ASP verdict for the row. That ledger is per machine, so a peer sends its own. */
  authorship?: MessageAuthorship;
}

export type LocalReader = (ref: SourceRef) => Promise<LocalLookup>;

export interface PeerAnswer {
  machine: string;
  /** False for no answer, a timeout, or any non-2xx: an older peer's 404 is not an answer. */
  answered: boolean;
  lookup?: LocalLookup;
}

export type ResolveOutcome = 'found' | 'pinned-copy' | 'not-found' | 'unverifiable' | 'unreachable' | 'removed';

export interface ResolveResult {
  outcome: ResolveOutcome;
  row?: Record<string, unknown>;
  machine?: string;
  /** Peers that did not answer. A `found` can still list these. */
  failed: string[];
  /** The ASP verdict that stands for the row: the weaker when two machines hold one. */
  authorship?: MessageAuthorship;
}

/** Agent-written or rejected outranks any gap; a gap outranks `human`. The weakest verdict wins. */
const AUTHORSHIP_WEAKNESS: Record<MessageAuthorship, number> = {
  rejected: 4,
  'agent-outbound': 3,
  'agent-verified': 3,
  UNRESOLVED: 2,
  unclassifiable: 1,
  human: 0,
};

export function weakerAuthorship(a: MessageAuthorship | undefined, b: MessageAuthorship | undefined): MessageAuthorship | undefined {
  if (!a) return b;
  if (!b) return a;
  return AUTHORSHIP_WEAKNESS[a] >= AUTHORSHIP_WEAKNESS[b] ? a : b;
}

export interface SourceResolverDeps {
  readLocal: LocalReader;
  askPeers?: (ref: SourceRef) => Promise<PeerAnswer[]>;
  readPin?: (ref: SourceRef) => Record<string, unknown> | null;
  dropPin?: (ref: SourceRef) => void;
  /** This machine's ASP verdict for a row a peer returned. Undefined when it holds none. */
  localAuthorship?: (ref: SourceRef, row: Record<string, unknown>) => MessageAuthorship | undefined;
  recordGaps?: Array<{ from: string; to: string }> | (() => Array<{ from: string; to: string }>);
  machineName: string;
  now?: () => number;
}

const NEGATIVE_CACHE_MS = 5 * 60_000;

function refKey(ref: SourceRef): string {
  return `${ref.channel}|${ref.conversation}|${ref.message}|${ref.date}`;
}

export class SourceResolver {
  private readonly inFlight = new Map<string, Promise<ResolveResult>>();
  private readonly negatives = new Map<string, { at: number; result: ResolveResult }>();

  constructor(private readonly deps: SourceResolverDeps) {}

  /**
   * Answers from this machine only. This is what peers call, so lookups never fan out twice.
   * A pin answers here too: on a peer it may be the only copy left.
   */
  async resolveLocal(ref: SourceRef): Promise<LocalLookup> {
    const local = await this.deps.readLocal(ref);
    if (local.removed) {
      this.deps.dropPin?.(ref);
      return local;
    }
    if (local.row) return local;
    const pin = this.deps.readPin?.(ref) ?? null;
    return pin ? { ...local, row: pin, pinned: true } : local;
  }

  resolve(ref: SourceRef): Promise<ResolveResult> {
    const key = refKey(ref);
    const running = this.inFlight.get(key);
    if (running) return running;
    const now = this.deps.now?.() ?? Date.now();
    const negative = this.negatives.get(key);
    if (negative && now - negative.at < NEGATIVE_CACHE_MS) return Promise.resolve(negative.result);
    this.negatives.delete(key);
    const run = this.resolveOnce(ref).then((result) => {
      // A down machine is not cached: a citation to it is re-checked as soon as it returns.
      if (result.outcome === 'not-found' || result.outcome === 'unverifiable') {
        if (this.negatives.size >= 5000) this.negatives.clear();
        this.negatives.set(key, { at: now, result });
      }
      return result;
    }).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, run);
    return run;
  }

  private async resolveOnce(ref: SourceRef): Promise<ResolveResult> {
    const local = await this.deps.readLocal(ref);
    if (local.removed) return this.removed(ref, []);
    if (local.row) return { outcome: 'found', row: local.row, machine: this.deps.machineName, failed: [], authorship: local.authorship };

    const answers = this.deps.askPeers ? await this.deps.askPeers(ref) : [];
    const failed = answers.filter((answer) => !answer.answered).map((answer) => answer.machine);
    const heard = answers.filter((answer) => answer.answered && answer.lookup);

    if (heard.some((answer) => answer.lookup!.removed)) return this.removed(ref, failed);
    const hit = heard.find((answer) => answer.lookup!.row && !answer.lookup!.pinned) ?? heard.find((answer) => answer.lookup!.row);
    if (hit) {
      const row = hit.lookup!.row!;
      return {
        outcome: hit.lookup!.pinned ? 'pinned-copy' : 'found',
        row,
        machine: hit.machine,
        failed,
        authorship: weakerAuthorship(hit.lookup!.authorship, this.deps.localAuthorship?.(ref, row)),
      };
    }

    const pin = this.deps.readPin?.(ref) ?? null;
    if (pin) return { outcome: 'pinned-copy', row: pin, machine: this.deps.machineName, failed };

    if (this.inGap(ref.date)) return { outcome: 'unverifiable', failed };
    if (failed.length) return { outcome: 'unreachable', failed };

    // Every machine answered. `not-found` needs the date inside every retained range.
    const ranges = [local.retainedFrom, ...heard.map((answer) => answer.lookup!.retainedFrom)];
    const allCover = ranges.every((from) => from !== null && from <= ref.date);
    return { outcome: allCover ? 'not-found' : 'unverifiable', failed };
  }

  private removed(ref: SourceRef, failed: string[]): ResolveResult {
    this.deps.dropPin?.(ref);
    return { outcome: 'removed', failed };
  }

  private inGap(date: string): boolean {
    const gaps = typeof this.deps.recordGaps === 'function' ? this.deps.recordGaps() : this.deps.recordGaps;
    return (gaps ?? []).some((gap) => gap.from <= date && date <= gap.to);
  }
}

/**
 * Reads one JSONL log by streaming, returning the first row the predicate accepts and the
 * date of the oldest row. Logs reach hundreds of MB, so they are never read whole.
 */
export async function scanJsonlLog(
  file: string,
  matches: (row: Record<string, unknown>) => boolean,
): Promise<LocalLookup> {
  if (!fs.existsSync(file)) return { row: null, retainedFrom: null };
  const lines = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  let retainedFrom: string | null = null;
  let found: Record<string, unknown> | null = null;
  for await (const line of lines) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (retainedFrom === null && typeof row.timestamp === 'string') retainedFrom = row.timestamp.slice(0, 10);
    if (matches(row)) {
      found = row;
      lines.close();
      break;
    }
  }
  return { row: found, retainedFrom };
}

/**
 * One pass over a log for many wanted rows. Used by `find`, whose candidates would otherwise
 * each cost a full scan of a log that reaches hundreds of MB.
 */
export async function scanJsonlMany(
  file: string,
  keyOf: (row: Record<string, unknown>) => string | null,
  wanted: Set<string> | null,
  limit = 500,
  accept: (row: Record<string, unknown>) => boolean = () => true,
): Promise<Map<string, Record<string, unknown>>> {
  const found = new Map<string, Record<string, unknown>>();
  if (!fs.existsSync(file)) return found;
  const lines = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const key = keyOf(row);
    if (key === null || (wanted && !wanted.has(key)) || !accept(row)) continue;
    found.set(key, row);
    if ((wanted && found.size >= wanted.size) || found.size >= limit) {
      lines.close();
      break;
    }
  }
  return found;
}
