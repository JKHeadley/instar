/**
 * The current run of the lease (SEC-088 part 2, docs/specs/trust-records-holder-authored.md decision 3).
 *
 * A grant counts only where it was written and only inside the writer's current run: this machine
 * holds the lease now at epoch N, and it was seen holding every epoch from the grant's epoch to N.
 * Lease acquisition always writes the current epoch + 1, so an epoch another machine held is never in
 * this machine's held set; a same-machine lapse and re-acquire (N -> N+1) keeps the run.
 *
 * The held set lives in `state/trust-held-epochs.json`, own and local (never replicated, never in the
 * backup set), stored as sorted closed ranges so it stays small while epochs climb. It is never
 * lowered; missing or unreadable, it starts empty, so only grants written from then on count.
 * Nothing here reads an epoch from a record another machine wrote.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { TrustRunView } from './TrustJourneyStore.js';

/** One consistent read of the coordinator's lease view. */
export interface LeaseSnapshot {
  /** This machine holds the lease now (the coordinator's own check, including its monotonic self-fence). */
  holds: boolean;
  /** The effective lease epoch, or null when unknown. */
  epoch: number | null;
  /** True while the coordinator sees a split-brain contest or has suspended itself. */
  contested: boolean;
  /** True when the coordinator names another machine as the holder at `epoch`. */
  foreignHolder?: boolean;
  /**
   * Epochs any peer's lease (live or expired) shows another machine held, from the coordinator's
   * machine-authenticated peer observations. An expired lease at N still proves the peer held N.
   */
  peerHeldEpochs?: number[];
}

export interface TrustRunTrackerDeps {
  stateDir: string;
  /** True when the agent has more than one machine (the machine registry). */
  multiMachine: () => boolean;
  /** The coordinator's lease view; null when no coordinator is attached or it failed. */
  lease: () => LeaseSnapshot | null;
  /** Called once when this machine starts a new run (it took the lease after another holder, or an epoch went unseen). */
  onNewRun?: (startEpoch: number, previousEpoch: number | null) => void;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

type Range = [number, number];

const MAX_RANGES = 256;
const MAX_FOREIGN = 4096;

export class TrustRunTracker implements TrustRunView {
  private ranges: Range[] = [];
  /**
   * Epochs seen held by another machine or contested: no run spans one (a same-epoch tie included).
   * Pruned by value only: an epoch below the oldest held range can never be inside a counting span,
   * so dropping it changes nothing; past the bound every run ends (fail closed).
   */
  private foreign: number[] = [];
  private readonly file: string;

  constructor(private readonly d: TrustRunTrackerDeps) {
    this.file = path.join(d.stateDir, 'state', 'trust-held-epochs.json');
    this.ranges = this.load();
  }

  private load(): Range[] {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { ranges?: unknown; foreign?: unknown };
      if (Array.isArray(j.foreign)) this.foreign = j.foreign.filter((x): x is number => Number.isSafeInteger(x) && (x as number) >= 0);
      if (!Array.isArray(j.ranges)) return [];
      const out: Range[] = [];
      for (const r of j.ranges) {
        if (Array.isArray(r) && r.length === 2 && Number.isSafeInteger(r[0]) && Number.isSafeInteger(r[1]) && r[0] >= 0 && r[1] >= r[0]) out.push([r[0], r[1]]);
      }
      return out.sort((a, b) => a[0] - b[0]);
    } catch { // @silent-fallback-ok: a missing or unreadable file starts empty, so only grants written from now on count (fail closed)
      return [];
    }
  }

  private save(): void {
    this.pruneForeign();
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ ranges: this.ranges, foreign: this.foreign }), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) { // a lost write only makes later grants absent (fail closed); logged
      this.d.log?.('trust-held-epochs-write-failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private pruneForeign(): void {
    const minStart = this.ranges.length ? this.ranges[0][0] : 0;
    this.foreign = [...new Set(this.foreign.filter((f) => f >= minStart))].sort((a, b) => a - b);
    if (this.foreign.length > MAX_FOREIGN) {
      // Fail closed: rather than drop a foreign epoch that might lie inside a span, end every run.
      this.ranges = [];
      this.foreign = [];
      this.d.log?.('trust-run-foreign-overflow', { limit: MAX_FOREIGN });
    }
  }

  private has(epoch: number): boolean { return this.ranges.some(([a, b]) => a <= epoch && epoch <= b); }

  /** The newest epoch this machine was seen holding, or null. */
  newest(): number | null { return this.ranges.length ? this.ranges[this.ranges.length - 1][1] : null; }

  /** The epoch the current run began at (the start of the range holding the newest epoch), or null. */
  runStart(): number | null { return this.ranges.length ? this.ranges[this.ranges.length - 1][0] : null; }

  heldCount(): number { return this.ranges.reduce((n, [a, b]) => n + (b - a + 1), 0); }

  private add(epoch: number): void {
    if (this.has(epoch)) return;
    const prevNewest = this.newest();
    const startsRun = !this.has(epoch - 1);
    this.ranges.push([epoch, epoch]);
    this.ranges.sort((a, b) => a[0] - b[0]);
    const merged: Range[] = [];
    for (const r of this.ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    }
    // Only the newest ranges matter for a run; older ones are kept for the summary, bounded.
    this.ranges = merged.slice(-MAX_RANGES);
    this.save();
    if (startsRun && (prevNewest === null || epoch > prevNewest)) {
      // A first observation (the upgrade, a lost file, a first take of the lease) starts a run too:
      // nothing from before it counts, so a profile raised earlier is narrowed like after a hand-over.
      this.d.log?.('trust-run-started', { epoch, previous: prevNewest, cause: prevNewest === null ? 'first observation' : 'another holder in between or an unobserved epoch' });
      this.d.onNewRun?.(epoch, prevNewest);
    }
  }

  /**
   * Marks epochs foreign (the coordinator's split-brain detection: a peer claimed the same or a higher
   * epoch while this machine held). No run spans a foreign epoch, so a tie resolved between two reads
   * still ends the run. Only narrows.
   */
  markForeign(epochs: number[], why: string): void {
    let changed = false;
    for (const e of epochs) {
      if (Number.isSafeInteger(e) && e >= 0 && !this.foreign.includes(e)) { this.foreign.push(e); changed = true; }
    }
    if (!changed) return;
    this.pruneForeign();
    this.cached = null;
    this.save();
    this.d.log?.('trust-run-foreign-epoch', { epochs, why });
  }

  /** Reads the lease once and records the epoch when this machine holds it uncontested. Returns the snapshot. */
  observe(): LeaseSnapshot | null {
    if (!this.d.multiMachine()) return null;
    this.cached = null;
    let s: LeaseSnapshot | null = null;
    try { s = this.d.lease(); } catch { s = null; } // @silent-fallback-ok: an unreadable lease view counts as unknown, so no grant counts (fail closed)
    const valid = !!s && s.epoch !== null && Number.isSafeInteger(s.epoch) && s.epoch >= 0;
    // An epoch another machine was seen holding, or contested, is foreign for good: no run spans it,
    // so a same-epoch tie the coordinator later resolves still ends the run.
    const mark: number[] = [];
    if (s && valid && (s.contested || s.foreignHolder)) mark.push(s.epoch!);
    for (const e of s?.peerHeldEpochs ?? []) if (Number.isSafeInteger(e) && e >= 0) mark.push(e);
    const fresh = mark.filter((e) => !this.foreign.includes(e));
    if (fresh.length) {
      this.foreign.push(...fresh);
      this.pruneForeign();
      this.save();
      this.d.log?.('trust-run-foreign-epoch', { epochs: fresh, contested: !!s?.contested, foreignHolder: !!s?.foreignHolder });
    }
    if (s && valid && s.holds && !s.contested && !s.foreignHolder) this.add(s.epoch!);
    return s;
  }

  // ── TrustRunView ──
  multiMachine(): boolean { return this.d.multiMachine(); }

  writeEpoch(): number | null {
    if (!this.d.multiMachine()) return null;
    const s = this.observe();
    if (!s || s.epoch === null || !Number.isSafeInteger(s.epoch) || s.epoch < 0) return null;
    // A machine not holding the lease writes its grant marked as a standby write (`s<N>`), which
    // never counts in any run, even after it takes the lease.
    return s.holds && !s.contested && !s.foreignHolder ? s.epoch : -1 - s.epoch;
  }

  private cached: { at: number; s: LeaseSnapshot | null } | null = null;
  /** A lease read shared by the many record checks of one query (half a second); admission re-reads fresh. */
  private recent(): LeaseSnapshot | null {
    const now = Date.now();
    if (this.cached && now - this.cached.at < 500) return this.cached.s;
    const s = this.observe();
    this.cached = { at: now, s };
    return s;
  }

  inRun(epoch: number | null): boolean {
    if (!this.d.multiMachine()) return true;
    if (epoch === null) return false; // a key written before this build: outside every run
    const s = this.recent();
    if (!s || !s.holds || s.contested || s.foreignHolder || s.epoch === null) return false;
    if (epoch > s.epoch) return false;
    if (this.foreign.some((f) => f >= epoch && f <= s.epoch!)) return false;
    // Every epoch from the grant's to now must be one this machine held: one range covers [epoch, N].
    return this.ranges.some(([a, b]) => a <= epoch && b >= s.epoch!);
  }
}
