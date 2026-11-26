import fs from 'node:fs';
import path from 'node:path';
import { FIRST_PART_LIMITS, type FirstPartGroup } from './firstPart.js';

// ── The assignment of pull requests ────────────────────────────────────

/**
 * The coordinator's assignment of pull requests to `with` or `without`. Drawn once per pull
 * request, when it is first queued, and never redrawn while remembered (the newest 5000). An
 * unreadable file starts empty: pull requests seen again are then drawn again, which the audit
 * row of each draw makes visible.
 */
export class FirstPartGroups {
  private prs: Map<number, { group: FirstPartGroup; at: number }> | null = null;

  constructor(
    readonly file: string,
    private readonly now: () => number,
    private readonly audit: (event: Record<string, unknown>) => void,
    private readonly random: () => number = Math.random,
  ) {}

  private load(): Map<number, { group: FirstPartGroup; at: number }> {
    if (this.prs) return this.prs;
    const prs = new Map<number, { group: FirstPartGroup; at: number }>();
    try {
      const size = fs.statSync(this.file).size;
      if (size <= FIRST_PART_LIMITS.listMaxBytes) {
        const doc = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as { v?: unknown; prs?: unknown };
        if (doc && doc.v === 1 && doc.prs && typeof doc.prs === 'object') {
          for (const [k, v] of Object.entries(doc.prs as Record<string, unknown>)) {
            const x = v as { group?: unknown; at?: unknown } | null;
            const pr = Number(k);
            if (Number.isSafeInteger(pr) && pr > 0 && x && (x.group === 'with' || x.group === 'without') && typeof x.at === 'number') prs.set(pr, { group: x.group, at: x.at });
          }
        } else this.audit({ event: 'first-part-groups-unreadable', reason: 'unparseable' });
      } else this.audit({ event: 'first-part-groups-unreadable', reason: 'oversized', bytes: size });
    } catch (e) {
      // @silent-fallback-ok: an absent file is the normal first state; anything else is audited and starts empty.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.audit({ event: 'first-part-groups-unreadable', reason: 'unreadable', detail: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    }
    this.prs = prs;
    return prs;
  }

  /** The assignment of `pr`, or null when it has none yet. */
  get(pr: number): FirstPartGroup | null {
    return this.load().get(pr)?.group ?? null;
  }

  /** The assignment of `pr`, drawn now (and saved) when it has none. */
  assign(pr: number): FirstPartGroup {
    const prs = this.load();
    const have = prs.get(pr);
    if (have) return have.group;
    const group: FirstPartGroup = this.random() < 0.5 ? 'with' : 'without';
    prs.set(pr, { group, at: this.now() });
    if (prs.size > FIRST_PART_LIMITS.groupsKept) {
      const order = [...prs.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
      for (const [k] of order.slice(0, prs.size - FIRST_PART_LIMITS.groupsKept)) prs.delete(k);
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, prs: Object.fromEntries(prs) }), { mode: 0o600 }); /* state-registry: local-verify-likely-failing */
      fs.renameSync(tmp, this.file);
    } catch (e) {
      // @silent-fallback-ok: the draw holds in memory until a restart; the audit row below still records it.
      this.audit({ event: 'first-part-groups-write-failed', detail: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    }
    this.audit({ event: 'first-part-assigned', pr, group });
    return group;
  }
}

// ── Measure 5: machine-minutes per change to its first pass ────────────

export interface ChangeVerify {
  pr: number;
  startedAt: string;
  finishedAt: string;
  outcome: 'success' | 'failure' | 'error';
  derived?: boolean;
}

export interface MinutesPerChange {
  /** Pull requests enrolled (their first verify fell inside the enrolment window). */
  enrolled: number;
  /** Machine-minutes per enrolled pull request, over each one's 7 days up to and including its first pass. */
  minutesPerChange: number | null;
  /** The share that reached a first pass within its 7 days. */
  reachedPass: number | null;
}

/**
 * Measure 5. Pull requests are enrolled by their FIRST verify inside `[from, to)` and grouped by
 * the assignment `groupOf` gives (the draw made when the pull request was first queued, never the
 * setting of a later verify); each is followed for the same 7 days from that first verify, on
 * every machine. Minutes count every verify of it that started inside those 7 days, up to and
 * including its first pass. A pull request with no assignment is left out. Pure.
 */
export function minutesPerChange(
  verifies: readonly ChangeVerify[],
  groupOf: (pr: number) => FirstPartGroup | null,
  window: { from: number; to: number; followMs?: number },
): Record<FirstPartGroup, MinutesPerChange> {
  const follow = window.followMs ?? 7 * 24 * 60 * 60_000;
  const byPr = new Map<number, Array<{ start: number; end: number; outcome: string; derived: boolean }>>();
  for (const v of verifies) {
    const start = Date.parse(v.startedAt); const end = Date.parse(v.finishedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    const list = byPr.get(v.pr) ?? [];
    list.push({ start, end, outcome: v.outcome, derived: v.derived === true });
    byPr.set(v.pr, list);
  }
  const acc: Record<FirstPartGroup, { enrolled: number; minutes: number; passed: number }> = { with: { enrolled: 0, minutes: 0, passed: 0 }, without: { enrolled: 0, minutes: 0, passed: 0 } };
  for (const [pr, list] of byPr) {
    list.sort((a, b) => a.start - b.start);
    const first = list[0].start;
    if (list[0].derived) continue;
    if (first < window.from || first >= window.to) continue;
    const group = groupOf(pr);
    if (!group) continue;
    const a = acc[group];
    a.enrolled++;
    for (const v of list) {
      if (v.start - first > follow) break;
      if (!v.derived) a.minutes += (v.end - v.start) / 60_000;
      if (v.outcome === 'success') { if (v.end - first <= follow) a.passed++; break; }
    }
  }
  const row = (a: { enrolled: number; minutes: number; passed: number }): MinutesPerChange => ({
    enrolled: a.enrolled,
    minutesPerChange: a.enrolled ? Math.round((a.minutes / a.enrolled) * 10) / 10 : null,
    reachedPass: a.enrolled ? Math.round((a.passed / a.enrolled) * 1000) / 1000 : null,
  });
  return { with: row(acc.with), without: row(acc.without) };
}
