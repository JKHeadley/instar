/**
 * DarkFlagMaturationRegistry — Standard B of `maturation-followthrough-fix`.
 *
 * Every dark flag gets an **owner**, a **deadline** and a **proof-of-life**
 * record, durably, keyed on the `/guards` inventory key from Standard A.
 *
 * Why this exists: the maturation engine could only see features whose SPEC
 * opted in (3 rollout tracks out of 1,201 items), so the real inventory of
 * dark / dry-run switches aged out of sight. G3 (`guardPostureView` +
 * `guardAcceptedFallbacks` + `GuardPostureProbe`) already classifies a
 * load-bearing dark guard and already owns the operator's accept lever. This
 * registry deliberately adds ONLY the dimension G3 does not carry —
 * owner + deadline + proof-of-life — and composes with it rather than
 * duplicating a parallel classification or a second accept path.
 *
 * Load-bearing invariants (each has a test on both sides):
 *  - **Signal, never authority.** Nothing here flips a flag, accepts a risk, or
 *    blocks anything. It records and classifies; promotion stays the operator's
 *    (or, for an agent-owned rung, a later increment's explicit decision).
 *  - **Deadlines are monotonic / flap-robust.** `firstObservedDarkAt` and
 *    `deadline` are written once per guard key and NEVER moved by a transient
 *    `on → dark` re-entry. Without this a flapping guard resets its window
 *    forever and escapes the `expired-unproven` finding this exists to raise.
 *  - **Migration is not a clean slate.** On the FIRST registration against a
 *    tree that already carries dark flags, those flags are NOT granted a fresh
 *    incubation window — they are `legacy-unproven`, un-owned, deadline already
 *    overdue, so the forgotten backlog is the first digest's headline by
 *    construction rather than being masked for another window.
 *  - **Nothing is silently dropped.** A guard key that disappears from the
 *    inventory is tombstoned (`killed` / `superseded`), retained, never deleted,
 *    so history survives a rename or removal.
 *  - **Machine-local BY DESIGN.** A guard's effective state is a fact about the
 *    machine it runs on, so this registry grades THIS machine's own flags. A
 *    file written by another machine is never merged (see `load()`); the
 *    cross-machine view is the existing `GET /guards?scope=pool` merge.
 *
 * Spec: docs/specs/maturation-followthrough-fix.md (Standard B).
 */

import fs from 'fs';
import path from 'path';

import type { GuardEffectiveState, GuardRow } from './guardPostureView.js';
import type { GrowthRiskTier } from './GrowthMilestoneAnalyst.js';

/** Who is accountable for graduating or killing this flag. `null` = UN-OWNED,
 *  which is itself a surfaced finding — never a silently-tolerated state. An
 *  owner is only ever derived from a real code source; it is never invented. */
export type DarkFlagOwner = 'agent' | 'operator' | null;

export type DarkFlagState =
  /** Inside its incubation window. */
  | 'incubating'
  /**
   * Window elapsed AND the flag has shown signs of life.
   *
   * Deliberately NOT a readiness verdict. Readiness is owned by the D7
   * recurring scorer (`BlockerLifecycleService.evaluateMaturation`, spec
   * feature-maturation-recurring-evaluation.md, operator-approved 2026-07-21
   * under the directive "extend, never duplicate"). D7 decides its `ready`
   * status by checking a feature's DECLARED measurement contract against fresh
   * observations. This registry knows only that a window closed and the flag
   * fired at least once — a far weaker fact. Two components answering "is this
   * ready?" by different rules is the "criterion lives in two places that
   * disagree" defect THIS spec names as a reason the engine stalled, so this
   * state stops short of the claim and hands the question on.
   */
  | 'window-elapsed'
  /** Window expired, NOT proved → extend / fix / kill? */
  | 'expired-unproven'
  /** Already dark at first registration, window unanchorable → overdue now. */
  | 'legacy-unproven'
  /** Left dark under its own power. Terminal-but-revisitable. */
  | 'graduated'
  /** Gone from the inventory (removed). Tombstone — retained, never deleted. */
  | 'killed'
  /** Gone from the inventory because it was renamed/merged into another key. */
  | 'superseded';

export interface DarkFlagHistoryEntry {
  at: string;
  from: DarkFlagState | null;
  to: DarkFlagState;
  reason: string;
}

export interface DarkFlagEntry {
  guardKey: string;
  /** MONOTONIC. Written once; never moved by a later on→dark toggle. */
  firstObservedDarkAt: string;
  /** MONOTONIC. `firstObservedDarkAt + windowDays`, or `firstObservedDarkAt`
   *  itself for a legacy entry (already overdue). */
  deadline: string;
  owner: DarkFlagOwner;
  state: DarkFlagState;
  riskTier: GrowthRiskTier;
  windowDays: number;
  /** Honest tri-state. `'unknown'` when no evidence source is wired — it is
   *  treated as NOT proved for promotion but reported as unknown, never as
   *  proved. (Same honesty rule as `classifyRollout`'s `proved`.) */
  proofOfLife: boolean | 'unknown';
  proofCount?: number;
  /** Mirrored from G3 so a consumer can route a load-bearing flag to the
   *  EXISTING `loadBearingGap` surface instead of raising a competing row. */
  loadBearing?: true;
  criticalPath?: string;
  lastObservedState: GuardEffectiveState | 'absent';
  lastObservedAt: string;
  /** The exact posture it held when it stopped being dark (honesty: a flag that
   *  left dark as `on-unverified` is not the same evidence as `on-confirmed`). */
  graduatedAtState?: GuardEffectiveState;
  /** Set when the entry was born already-dark with no anchorable history. */
  legacyAtRegistration?: true;
  /** Append-only. Only genuine state CHANGES are appended, not every tick. */
  history: DarkFlagHistoryEntry[];
}

export interface DarkFlagRegistryFile {
  version: 1;
  /** The machine whose flags these are. A foreign file is never merged. */
  machineId: string;
  entries: Record<string, DarkFlagEntry>;
}

/** The dark set, exactly as Standard A defines it: a guard that is off because
 *  it ships dark or has diverged from its default, or one that is on but
 *  toothless (dry-run). These are the switches that can age out of sight. */
export function isDarkSubject(row: GuardRow): boolean {
  if (row.effective === 'on-dry-run') return true;
  return row.offClass === 'dark-default' || row.offClass === 'diverged-from-default';
}

/** States that mean "this guard is actually on". Leaving the dark set into one
 *  of these is graduation; the exact state is retained for honesty. */
const ON_STATES: ReadonlySet<GuardEffectiveState> = new Set<GuardEffectiveState>([
  'on-confirmed',
  'on-unverified',
  'on-stale',
  'on-blind',
]);

/** Whole fractional days between an ISO instant and `now`. */
export function daysBetween(iso: string, now: Date): number {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 0;
  return (now.getTime() - then) / 86_400_000;
}

function addDays(iso: string, days: number): string {
  const base = new Date(iso).getTime();
  if (!Number.isFinite(base)) return iso;
  return new Date(base + days * 86_400_000).toISOString();
}

/** Classify a live dark entry from its own monotonic deadline. Mirrors
 *  `classifyRollout`'s contract: an unproved expiry is `expired-unproven`, and
 *  `'unknown'` proof can NEVER produce `window-elapsed`. Readiness itself is
 *  D7's call, never this function's. */
export function classifyDarkFlag(
  firstObservedDarkAt: string,
  windowDays: number,
  proofOfLife: boolean | 'unknown',
  now: Date,
  legacy: boolean,
): DarkFlagState {
  if (legacy) {
    // A legacy entry is overdue by construction. Its window can be marked
    // elapsed-with-evidence once the flag genuinely fires, and it can graduate
    // out of the dark set — but it is never "incubating", which is the masking
    // this rule exists to prevent.
    return proofOfLife === true ? 'window-elapsed' : 'legacy-unproven';
  }
  const expired = daysBetween(firstObservedDarkAt, now) >= windowDays;
  if (!expired) return 'incubating';
  return proofOfLife === true ? 'window-elapsed' : 'expired-unproven';
}

export interface ReconcileInput {
  rows: GuardRow[];
  existing: Record<string, DarkFlagEntry>;
  /** True when the registry had no entries at all — the migration case. */
  firstRegistration: boolean;
  now: Date;
  windowFor: (row: GuardRow) => { tier: GrowthRiskTier; windowDays: number };
  /** `undefined` ⇒ no evidence source wired ⇒ `proofOfLife: 'unknown'`. */
  proofCountFor: (row: GuardRow) => number | undefined;
  minProof: number;
  ownerFor: (row: GuardRow) => DarkFlagOwner;
  /** Optional rename map: old key → new key, so a rename tombstones as
   *  `superseded` rather than `killed`. Absent ⇒ every disappearance is
   *  `killed` (the honest default — we do not guess at a rename). */
  supersededBy?: Record<string, string>;
}

export interface ReconcileResult {
  entries: Record<string, DarkFlagEntry>;
  changed: boolean;
}

/**
 * PURE reconciliation. No fs, no clock of its own — everything is threaded in,
 * the same discipline `buildGuardInventory` follows, so every edge is unit
 * testable on both sides.
 */
export function reconcileDarkFlagEntries(input: ReconcileInput): ReconcileResult {
  const nowIso = input.now.toISOString();
  const entries: Record<string, DarkFlagEntry> = {};
  for (const [k, v] of Object.entries(input.existing)) {
    entries[k] = { ...v, history: [...(v.history ?? [])] };
  }
  let changed = false;

  const transition = (entry: DarkFlagEntry, to: DarkFlagState, reason: string): void => {
    if (entry.state === to) return;
    entry.history.push({ at: nowIso, from: entry.state, to, reason });
    entry.state = to;
    changed = true;
  };

  const seen = new Set<string>();

  for (const row of input.rows) {
    seen.add(row.key);
    const dark = isDarkSubject(row);
    const prev = entries[row.key];

    if (!dark) {
      if (!prev) continue; // never tracked and not dark — nothing to record
      // Left the dark set. Graduation is only claimed for a genuinely-on state;
      // 'missing' / 'errored' / 'diverged-pending-restart' / 'off-runtime-divergent'
      // prove nothing, so the entry keeps its state and only records the sighting.
      if (ON_STATES.has(row.effective)) {
        prev.graduatedAtState = row.effective;
        transition(prev, 'graduated', `left dark set as ${row.effective}`);
      }
      if (prev.lastObservedState !== row.effective) changed = true;
      prev.lastObservedState = row.effective;
      prev.lastObservedAt = nowIso;
      continue;
    }

    const { tier, windowDays } = input.windowFor(row);
    const proofCount = input.proofCountFor(row);
    const proofOfLife: boolean | 'unknown' =
      proofCount === undefined ? 'unknown' : proofCount >= input.minProof;

    if (!prev) {
      // A brand-new dark subject. On the FIRST registration run it is legacy
      // (already dark before we were looking) — it must NOT be handed a fresh
      // window, or the forgotten backlog stays hidden for another window.
      const legacy = input.firstRegistration;
      const entry: DarkFlagEntry = {
        guardKey: row.key,
        firstObservedDarkAt: nowIso,
        deadline: legacy ? nowIso : addDays(nowIso, windowDays),
        owner: legacy ? null : input.ownerFor(row),
        state: 'incubating', // replaced immediately by the transition below
        riskTier: tier,
        windowDays,
        proofOfLife,
        ...(proofCount === undefined ? {} : { proofCount }),
        ...(row.loadBearing ? { loadBearing: row.loadBearing } : {}),
        ...(row.criticalPath ? { criticalPath: row.criticalPath } : {}),
        lastObservedState: row.effective,
        lastObservedAt: nowIso,
        ...(legacy ? { legacyAtRegistration: true as const } : {}),
        history: [],
      };
      const state = classifyDarkFlag(entry.firstObservedDarkAt, windowDays, proofOfLife, input.now, legacy);
      entry.history.push({
        at: nowIso,
        from: null,
        to: state,
        reason: legacy ? 'first registration — already dark, window unanchorable' : 'newly observed dark',
      });
      entry.state = state;
      entries[row.key] = entry;
      changed = true;
      continue;
    }

    // Existing entry, still/again dark. firstObservedDarkAt and deadline are
    // MONOTONIC — a re-entry continues the original window, it does not restart
    // it. Only the live-evidence fields move.
    if (prev.proofOfLife !== proofOfLife || prev.proofCount !== proofCount) changed = true;
    prev.proofOfLife = proofOfLife;
    if (proofCount === undefined) delete prev.proofCount;
    else prev.proofCount = proofCount;
    prev.riskTier = tier;
    prev.windowDays = windowDays;
    // Keep the STORED deadline consistent with the window the classifier
    // actually uses, without ever shortening it. classifyDarkFlag computes from
    // firstObservedDarkAt + windowDays, so a widened window (e.g. the guard
    // became load-bearing and moved to the highRisk tier) would otherwise leave
    // `deadline` reporting an earlier date than the behaviour — a field that
    // quietly disagrees with the logic is how a reader gets misled. Monotonic by
    // construction: max() can only ever move it later.
    if (!prev.legacyAtRegistration) {
      const fromWindow = addDays(prev.firstObservedDarkAt, windowDays);
      const next = new Date(fromWindow).getTime() > new Date(prev.deadline).getTime()
        ? fromWindow
        : prev.deadline;
      if (next !== prev.deadline) {
        prev.deadline = next;
        changed = true;
      }
    }
    if (row.loadBearing) prev.loadBearing = row.loadBearing;
    else delete prev.loadBearing;
    if (row.criticalPath) prev.criticalPath = row.criticalPath;
    else delete prev.criticalPath;
    if (prev.owner === null && !prev.legacyAtRegistration) {
      const derived = input.ownerFor(row);
      if (derived !== null) {
        prev.owner = derived;
        changed = true;
      }
    }
    if (prev.lastObservedState !== row.effective) changed = true;
    prev.lastObservedState = row.effective;
    prev.lastObservedAt = nowIso;

    const state = classifyDarkFlag(
      prev.firstObservedDarkAt,
      prev.windowDays,
      proofOfLife,
      input.now,
      prev.legacyAtRegistration === true,
    );
    const reEntered = prev.state === 'graduated' || prev.state === 'killed' || prev.state === 'superseded';
    transition(prev, state, reEntered ? 'returned to the dark set — original window continues' : 'reclassified');
  }

  // Anything tracked but absent from the inventory is TOMBSTONED, never dropped.
  for (const [key, entry] of Object.entries(entries)) {
    if (seen.has(key)) continue;
    if (entry.state === 'killed' || entry.state === 'superseded') continue;
    const into = input.supersededBy?.[key];
    if (entry.lastObservedState !== 'absent') changed = true;
    entry.lastObservedState = 'absent';
    entry.lastObservedAt = nowIso;
    transition(
      entry,
      into ? 'superseded' : 'killed',
      into ? `absent from inventory — superseded by ${into}` : 'absent from inventory',
    );
  }

  return { entries, changed };
}

export interface DarkFlagMaturationRegistryDeps {
  /** The agent stateDir root (the registry lives under `state/`). */
  stateDir: string;
  /** THIS machine's id — a file written by another machine is never merged. */
  machineId: string;
  onError?: (where: string, err: unknown) => void;
}

/** Thin durable wrapper around the pure reconciler. The ONLY stateful part. */
export class DarkFlagMaturationRegistry {
  private readonly filePath: string;
  private readonly deps: DarkFlagMaturationRegistryDeps;

  constructor(deps: DarkFlagMaturationRegistryDeps) {
    this.deps = deps;
    this.filePath = path.join(deps.stateDir, 'state', 'dark-flag-maturation.json');
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    } catch (err) {
      this.deps.onError?.('mkdir', err);
    }
  }

  get path(): string {
    return this.filePath;
  }

  /**
   * Read this machine's registry. A missing file is first-run. A corrupt file,
   * or one stamped with ANOTHER machine's id, yields an empty registry — the
   * safe direction for an observe-only surface: we re-observe and re-anchor
   * rather than grading this machine against a peer's posture. The caller sees
   * `firstRegistration: true`, so the migration rule then classifies the live
   * dark set as `legacy-unproven` instead of handing it a fresh clean window.
   *
   * `firstRegistration` keys on the FILE, not on emptiness. A valid file that
   * happens to hold no entries means "we were already watching and nothing was
   * dark" — a flag that appears afterwards is genuinely new and must get a real
   * incubation window. Keying on emptiness instead would stamp that brand-new
   * flag as pre-existing backlog, which is wrong in the over-surfacing
   * direction and would report "already dark before anyone was watching" about
   * a flag we watched arrive.
   */
  load(): { entries: Record<string, DarkFlagEntry>; firstRegistration: boolean; foreign: boolean } {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch {
      // @silent-fallback-ok: missing file is the expected first-run state.
      return { entries: {}, firstRegistration: true, foreign: false };
    }
    // From here the file EXISTS. Only corruption or foreign ownership may
    // re-assert first-registration below; a valid-but-empty file must not.
    try {
      const parsed = JSON.parse(raw) as Partial<DarkFlagRegistryFile>;
      const entries = parsed?.entries;
      if (!entries || typeof entries !== 'object') {
        // Malformed shape (no entries map) — treat as never-registered and
        // re-anchor conservatively, same as a parse failure.
        return { entries: {}, firstRegistration: true, foreign: false };
      }
      if (parsed.machineId && parsed.machineId !== this.deps.machineId) {
        // Machine-local BY DESIGN: a peer's registry is not authoritative here.
        this.deps.onError?.('load', new Error(`registry belongs to machine ${parsed.machineId}`));
        return { entries: {}, firstRegistration: true, foreign: true };
      }
      return {
        entries: entries as Record<string, DarkFlagEntry>,
        // The file is present and parseable: we were watching. Not first-run,
        // even with zero entries.
        firstRegistration: false,
        foreign: false,
      };
    } catch (err) {
      this.deps.onError?.('parse', err);
      return { entries: {}, firstRegistration: true, foreign: false };
    }
  }

  save(entries: Record<string, DarkFlagEntry>): void {
    const file: DarkFlagRegistryFile = { version: 1, machineId: this.deps.machineId, entries };
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(file, null, 2));
    } catch (err) {
      this.deps.onError?.('save', err);
    }
  }

  /** Reconcile against a live inventory and persist. Returns every entry. */
  reconcile(input: Omit<ReconcileInput, 'existing' | 'firstRegistration'>): DarkFlagEntry[] {
    const { entries: existing, firstRegistration } = this.load();
    const { entries, changed } = reconcileDarkFlagEntries({ ...input, existing, firstRegistration });
    if (changed || firstRegistration) this.save(entries);
    return Object.values(entries);
  }
}
