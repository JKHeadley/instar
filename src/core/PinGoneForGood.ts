/**
 * SEC-170 part 3 of 3 (docs/specs/pool-wide-pin-budget.md §4 "A retirement", "Machines silent for 7 days", §5 "Alerts").
 *
 * Three small pure-ish pieces the owner surface and the agent-wide alert are built from:
 *
 *  1. GoneForGoodStore: `<stateDir>/state/pin-gone-for-good.json`, the owner's "gone for good" confirmations.
 *     A confirmation is written only after the owner approved it on the phone (Face ID, the SEC-018 owner-action
 *     flow) on this machine, or adopted from a pool member's machine-signed report. Phone device keys are
 *     machine-local (docs/specs/mobile-device-keys.md), so a peer cannot re-check the presence signature: it
 *     trusts the member that approved it, exactly as it trusts that member's acknowledgments. The floor that
 *     bounds a wrong or forged confirmation is unchanged: it takes effect only while no machine anywhere in the
 *     pool has had signed contact from the target for 7 days (PinShare), so at most it adds that machine's old
 *     share. A confirmation also lapses for good once the target is heard from after it was given, so a machine
 *     that came back and later went quiet again needs a fresh tap.
 *  2. silentMachines: the members silent for 7 days or more, for the one agent-wide Needs-you item, plus a
 *     fingerprint that changes only on something new, so a dismissed item stays quiet until then.
 *  3. poolFailureAlert: the agent-wide brute-force backstop (20 failures across machines within one hour), raised
 *     by one voice only: the lowest machine id among this machine and the peers with a fresh report.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeDurable, AGENT_PIN_BUDGET } from './PinShare.js';
import { GONE_FOR_GOOD_SILENCE_MS } from './PinShareTable.js';

export const GONE_FOR_GOOD_FILE = 'pin-gone-for-good.json';
/** Agent-wide alert: failures across all machines within this window (spec §5, §8 judgment-candidate). */
export const POOL_FAILURE_WINDOW_MS = 60 * 60 * 1000;
export const POOL_FAILURE_ALERT_THRESHOLD = AGENT_PIN_BUDGET;
/** The most confirmations one report may carry (a pool is far smaller). */
export const MAX_REPORTED_CONFIRMATIONS = 64;

export interface GoneForGoodRecord {
  /** Wall-clock ms when the owner confirmed it. */
  confirmedAt: number;
  /** 'owner-phone' when approved on this machine; 'relayed' when adopted from a member's signed report. */
  source: 'owner-phone' | 'relayed';
  /** The machine the owner approved it on. */
  approvedOn: string;
}

interface StoredFile { version: 1; machines: string[]; records: Record<string, GoneForGoodRecord> }

/** One confirmation as it travels in a signed report. */
export interface ReportedConfirmation { machineId: string; confirmedAt: number; approvedOn: string }

const MACHINE_ID = /^m_[0-9a-f]{32}$/;

export class GoneForGoodStore {
  private readonly file: string;
  constructor(stateDir: string, private readonly now: () => number = Date.now) {
    this.file = path.join(stateDir, 'state', GONE_FOR_GOOD_FILE);
  }

  /** Every recorded confirmation. An unreadable file reads as none (the strict side: the raise keeps waiting). */
  read(): Record<string, GoneForGoodRecord> {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Partial<StoredFile>;
      const out: Record<string, GoneForGoodRecord> = {};
      const recs = raw.records && typeof raw.records === 'object' ? raw.records : {};
      for (const id of Array.isArray(raw.machines) ? raw.machines : []) {
        const r = (recs as Record<string, Partial<GoneForGoodRecord>>)[id];
        if (typeof id !== 'string' || !r || typeof r.confirmedAt !== 'number' || !Number.isFinite(r.confirmedAt)) continue;
        out[id] = { confirmedAt: r.confirmedAt, source: r.source === 'owner-phone' ? 'owner-phone' : 'relayed', approvedOn: typeof r.approvedOn === 'string' ? r.approvedOn : '' };
      }
      return out;
    } catch {
      return {}; // @silent-fallback-ok — no confirmations is the strict side
    }
  }

  private write(records: Record<string, GoneForGoodRecord>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const machines = Object.keys(records).sort();
    // `machines` stays a flat list: part 2's reader (readGoneForGood) reads exactly that.
    writeDurable(this.file, JSON.stringify({ version: 1, machines, records } satisfies StoredFile, null, 2));
  }

  /** The owner approved "gone for good" for `machineId` on this machine. Saved before the caller reports success. */
  confirm(machineId: string, approvedOn: string): GoneForGoodRecord {
    if (!MACHINE_ID.test(machineId)) throw new Error('bad-machine-id');
    const records = this.read();
    const rec: GoneForGoodRecord = { confirmedAt: this.now(), source: 'owner-phone', approvedOn };
    records[machineId] = rec;
    this.write(records);
    return rec;
  }

  /**
   * Adopt confirmations from a member's machine-signed report. Keeps the newer of two records for one machine,
   * never adopts one for this machine itself, and ignores one dated in the future. Returns how many changed.
   */
  adopt(reported: readonly ReportedConfirmation[], selfId: string | null): number {
    const records = this.read();
    let changed = 0;
    const now = this.now();
    for (const c of reported.slice(0, MAX_REPORTED_CONFIRMATIONS)) {
      if (!c || !MACHINE_ID.test(c.machineId) || c.machineId === selfId) continue;
      if (typeof c.confirmedAt !== 'number' || !Number.isFinite(c.confirmedAt) || c.confirmedAt > now + 60_000) continue;
      const have = records[c.machineId];
      if (have && have.confirmedAt >= c.confirmedAt) continue;
      records[c.machineId] = { confirmedAt: c.confirmedAt, source: 'relayed', approvedOn: typeof c.approvedOn === 'string' ? c.approvedOn.slice(0, 64) : '' };
      changed += 1;
    }
    if (changed > 0) this.write(records);
    return changed;
  }

  /** The confirmations this machine reports to its peers. */
  reportable(): ReportedConfirmation[] {
    return Object.entries(this.read()).slice(0, MAX_REPORTED_CONFIRMATIONS).map(([machineId, r]) => ({ machineId, confirmedAt: r.confirmedAt, approvedOn: r.approvedOn }));
  }

  /**
   * The confirmations still standing: the target had been silent (no signed contact anywhere in the pool) for
   * 7 days when the owner confirmed it, and has not been heard from since. PinShare adds the 7-day silence and
   * the complete-records checks on top.
   */
  standing(contacts: ReadonlyMap<string, number>): Set<string> {
    const out = new Set<string>();
    // The silence must already have lasted 7 days when the owner confirmed it, so a confirmation can never be
    // set up ahead of time for a machine that is only briefly offline, and a member cannot re-arm a lapsed one
    // with a newer date while the machine is still being heard from.
    for (const [id, r] of Object.entries(this.read())) if ((contacts.get(id) ?? 0) + GONE_FOR_GOOD_SILENCE_MS <= r.confirmedAt) out.add(id);
    return out;
  }
}

/** Sanitize the confirmations field of a peer's report. */
export function parseReportedConfirmations(raw: unknown): ReportedConfirmation[] {
  if (!Array.isArray(raw)) return [];
  const out: ReportedConfirmation[] = [];
  for (const c of raw.slice(0, MAX_REPORTED_CONFIRMATIONS)) {
    if (!c || typeof c !== 'object') continue;
    const { machineId, confirmedAt, approvedOn } = c as Record<string, unknown>;
    if (typeof machineId !== 'string' || !MACHINE_ID.test(machineId) || typeof confirmedAt !== 'number' || !Number.isFinite(confirmedAt)) continue;
    out.push({ machineId, confirmedAt, approvedOn: typeof approvedOn === 'string' ? approvedOn.slice(0, 64) : '' });
  }
  return out;
}

export interface SilentMachineRow {
  machineId: string;
  /** Wall-clock ms of the latest sign of life known for it (signed contact, registry lastSeen or pairing). */
  silentSince: number;
  /** True when the owner has already confirmed it gone for good (still listed until it is retired). */
  confirmedGone: boolean;
}

export interface SilentMachinesInput {
  self: string | null;
  /** Non-retired registry members with their registry timestamps (ms; 0 when unknown). */
  members: ReadonlyArray<{ machineId: string; lastSeen: number; pairedAt: number }>;
  contacts: ReadonlyMap<string, number>;
  confirmed: ReadonlySet<string>;
  /** True when a raise or a pairing is being held back by a missing acknowledgment from a silent member. */
  heldBack: boolean;
  now: number;
}

/**
 * Members silent for 7 days or more, oldest silence first, with a fingerprint over what would make a dismissed
 * item worth raising again: the set of silent machines and whether one of them is holding something back.
 * A machine coming back drops out of the set; that changes the fingerprint too, but an item whose set only
 * shrank is not "something new", so the caller compares with `isNewSince`.
 */
export function silentMachines(input: SilentMachinesInput): { rows: SilentMachineRow[]; fingerprint: string; heldBack: boolean } {
  const rows: SilentMachineRow[] = [];
  for (const m of input.members) {
    if (m.machineId === input.self) continue;
    const since = Math.max(input.contacts.get(m.machineId) ?? 0, m.lastSeen || 0, m.pairedAt || 0);
    if (input.now - since >= GONE_FOR_GOOD_SILENCE_MS) rows.push({ machineId: m.machineId, silentSince: since, confirmedGone: input.confirmed.has(m.machineId) });
  }
  rows.sort((a, b) => a.silentSince - b.silentSince || (a.machineId < b.machineId ? -1 : 1));
  const heldBack = rows.length > 0 && input.heldBack;
  const fingerprint = fingerprintOf(rows.map((r) => r.machineId), heldBack);
  return { rows, fingerprint, heldBack };
}

export function fingerprintOf(silentIds: readonly string[], heldBack: boolean): string {
  return createHash('sha256').update(`${[...silentIds].sort().join(',')}|${heldBack ? 1 : 0}`).digest('hex').slice(0, 16);
}

/**
 * Is the current state "something new" since the owner dismissed `dismissed` (spec §4: another machine goes
 * silent, or a pairing or raise is held back by a silent machine)? A shrinking set is not new.
 */
export function isNewSince(dismissed: { silentIds: readonly string[]; heldBack: boolean } | null, now: { silentIds: readonly string[]; heldBack: boolean }): boolean {
  if (!dismissed) return now.silentIds.length > 0;
  const before = new Set(dismissed.silentIds);
  if (now.silentIds.some((id) => !before.has(id))) return true;
  return now.heldBack && !dismissed.heldBack;
}

/**
 * The agent-wide brute-force backstop. `counts` holds each machine's failures within the last hour (this machine's
 * own count included). Returns whether this machine is the one voice that raises the alert, and the total.
 */
export function poolFailureAlert(self: string, counts: ReadonlyMap<string, number>): { raise: boolean; total: number; voice: string } {
  let total = 0;
  for (const n of counts.values()) if (Number.isInteger(n) && n > 0) total += Math.min(n, 10_000);
  const voice = [self, ...counts.keys()].sort()[0];
  return { raise: total >= POOL_FAILURE_ALERT_THRESHOLD && voice === self, total, voice };
}

export const POOL_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Runs the agent-wide backstop on a timer: gathers each machine's last-hour count (this machine's own, plus each
 * peer's fresh report), and raises the existing brute-force alert through `report` when this machine is the one
 * voice and the total reaches 20, at most once per 30 minutes. Counting never changes what is admitted.
 */
export class PoolFailureAlerter {
  private lastAlertAt = -Infinity;
  constructor(private readonly deps: {
    self: () => string | null;
    ownCount: () => number;
    /** Peers with a fresh report that carries a count (so they run this build) and are not retired. */
    peerCounts: () => ReadonlyMap<string, number>;
    enabled: () => boolean;
    report: (total: number, machines: number) => void;
    now?: () => number;
  }) {}

  check(): { raised: boolean; total: number } {
    const self = this.deps.self();
    if (!this.deps.enabled() || !self) return { raised: false, total: 0 };
    const counts = new Map(this.deps.peerCounts());
    counts.delete(self);
    counts.set(self, this.deps.ownCount());
    const { raise, total } = poolFailureAlert(self, counts);
    const now = (this.deps.now ?? Date.now)();
    if (!raise || now - this.lastAlertAt < POOL_ALERT_COOLDOWN_MS) return { raised: false, total };
    this.lastAlertAt = now;
    this.deps.report(total, counts.size);
    return { raised: true, total };
  }
}
