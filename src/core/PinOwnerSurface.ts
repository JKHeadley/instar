/**
 * SEC-170 part 3 of 3: the owner's side of the pool-wide PIN budget (docs/specs/pool-wide-pin-budget.md §4).
 *
 *  - silent(): the one agent-wide list of machines silent for 7 days or more, the data behind the single
 *    Needs-you item. It says whether the item should show: a dismissed item stays quiet until something new
 *    (another machine goes silent, or a raise starts being held back by a silent machine).
 *  - requestGoneForGood(id): the "It's gone for good" choice. It never applies anything itself: it registers a
 *    server-worded pending owner approval (the SEC-018 flow), which the owner approves on the phone with Face ID.
 *  - onApproved(purpose, id): called by the phone approval route. Consumes the approval and saves the confirmation.
 *
 * Signal, not authority: the list proposes; only the owner retires a machine or confirms it gone, and a
 * confirmation counts toward a raise only while PinShare's pool-wide 7-day silence check agrees.
 */
import fs from 'node:fs';
import path from 'node:path';
import { GoneForGoodStore, silentMachines, isNewSince, type SilentMachineRow } from './PinGoneForGood.js';
import { writeDurable } from './PinShare.js';
import { featureEvidence } from '../monitoring/FeatureEvidenceLog.js';

export const GONE_FOR_GOOD_PURPOSE = 'pin-gone-for-good';
const DISMISS_FILE = 'pin-silent-dismissed.json';

export interface PinOwnerSurfaceDeps {
  stateDir: string;
  store: GoneForGoodStore;
  enabled: () => boolean;
  self: () => string | null;
  /** Non-retired registry members with registry timestamps (ms; 0 when unknown) and a display name. */
  members: () => Array<{ machineId: string; name: string; lastSeen: number; pairedAt: number }>;
  contacts: () => ReadonlyMap<string, number>;
  /** True while this machine's share is below its equal entry, i.e. a raise is waiting on acknowledgments. */
  raiseWaiting: () => boolean;
  pending: { register(req: { purpose: string; actionKey: string; title: string; why: string; machine: string }): unknown; remove(purpose: string, actionKey: string): void };
  approvals: { consume(key: { purpose: string; actionKey: string }): string | null };
  machineName: () => string;
  /** Re-read the share after a confirmation is saved. */
  invalidate: () => void;
  now?: () => number;
}

export interface SilentMachinesView {
  enabled: boolean;
  rows: Array<SilentMachineRow & { name: string }>;
  heldBack: boolean;
  fingerprint: string;
  /** True when the owner dismissed the item and nothing new has happened since. */
  dismissed: boolean;
  /** Whether the Needs-you item should be showing now. */
  show: boolean;
}

export type GoneForGoodRequestResult =
  | { ok: true; pending: true }
  | { ok: true; already: true }
  | { ok: false; reason: 'off' | 'not-silent' | 'self' };

interface DismissRecord { silentIds: string[]; heldBack: boolean; fingerprint: string; at: number }

export class PinOwnerSurface {
  private readonly now: () => number;
  private readonly dismissFile: string;
  constructor(private readonly deps: PinOwnerSurfaceDeps) {
    this.now = deps.now ?? Date.now;
    this.dismissFile = path.join(deps.stateDir, 'state', DISMISS_FILE);
  }

  silent(): SilentMachinesView {
    if (!this.deps.enabled()) return { enabled: false, rows: [], heldBack: false, fingerprint: '', dismissed: false, show: false };
    const members = this.deps.members();
    const contacts = this.deps.contacts();
    const confirmed = this.deps.store.standing(contacts);
    const { rows, fingerprint, heldBack } = silentMachines({ self: this.deps.self(), members, contacts, confirmed, heldBack: this.deps.raiseWaiting(), now: this.now() });
    const names = new Map(members.map((m) => [m.machineId, m.name]));
    let dismissedRec = this.readDismissed();
    // A machine that came back drops out of the dismissal, so going silent again later counts as something new.
    if (dismissedRec) {
      const now = new Set(rows.map((r) => r.machineId));
      const kept = dismissedRec.silentIds.filter((x) => now.has(x));
      if (kept.length !== dismissedRec.silentIds.length) {
        dismissedRec = { ...dismissedRec, silentIds: kept };
        try { writeDurable(this.dismissFile, JSON.stringify(dismissedRec)); } catch { /* @silent-fallback-ok — an unsaved trim only means the item may stay quiet once more */ }
      }
    }
    const current = { silentIds: rows.map((r) => r.machineId), heldBack };
    const fresh = isNewSince(dismissedRec, current);
    const dismissed = rows.length > 0 && !!dismissedRec && !fresh;
    return { enabled: true, rows: rows.map((r) => ({ ...r, name: names.get(r.machineId) || 'A computer with no name yet' })), heldBack, fingerprint, dismissed, show: rows.length > 0 && !dismissed };
  }

  /** Dismiss the item as it stands now. A stale fingerprint (the list changed since it was shown) is refused. */
  dismiss(fingerprint: string): { ok: boolean } {
    const view = this.silent();
    if (!view.enabled || view.rows.length === 0 || view.fingerprint !== fingerprint) return { ok: false };
    const rec: DismissRecord = { silentIds: view.rows.map((r) => r.machineId), heldBack: view.heldBack, fingerprint, at: this.now() };
    fs.mkdirSync(path.dirname(this.dismissFile), { recursive: true });
    writeDurable(this.dismissFile, JSON.stringify(rec));
    return { ok: true };
  }

  requestGoneForGood(machineId: string): GoneForGoodRequestResult {
    if (!this.deps.enabled()) return { ok: false, reason: 'off' };
    if (machineId === this.deps.self()) return { ok: false, reason: 'self' };
    const row = this.silent().rows.find((r) => r.machineId === machineId);
    // Only a machine on the owner's list (silent for 7 days or more) can be confirmed gone.
    if (!row) return { ok: false, reason: 'not-silent' };
    if (row.confirmedGone) return { ok: true, already: true };
    const since = new Date(row.silentSince).toISOString().slice(0, 10);
    this.deps.pending.register({
      purpose: GONE_FOR_GOOD_PURPOSE,
      actionKey: machineId,
      title: `Is ${row.name} gone for good?`,
      why: `${row.name} has not been heard from since ${since}. Confirm only if it was wiped, lost or destroyed: its share of the PIN guess limit then goes back to your other computers. Approve on your phone with Face ID; this request expires in 5 minutes.`,
      machine: this.deps.machineName(),
    });
    return { ok: true, pending: true };
  }

  /** The phone approval route calls this after recording a verified approval. */
  onApproved(purpose: string, machineId: string): boolean {
    if (purpose !== GONE_FOR_GOOD_PURPOSE || !this.deps.enabled()) return false;
    if (!this.deps.approvals.consume({ purpose, actionKey: machineId })) return false;
    this.deps.pending.remove(purpose, machineId);
    try {
      this.deps.store.confirm(machineId, this.deps.self() ?? '');
    } catch {
      return false; // @silent-fallback-ok — the phone route turns false into a visible "could not save it, ask again"
    }
    featureEvidence.record('pinBudgetPoolWide', { kind: 'fired', reason: 'owner confirmed a silent computer gone for good from the phone' });
    this.deps.invalidate();
    return true;
  }

  private readDismissed(): DismissRecord | null {
    try {
      const r = JSON.parse(fs.readFileSync(this.dismissFile, 'utf-8')) as Partial<DismissRecord>;
      if (!Array.isArray(r.silentIds)) return null;
      return { silentIds: r.silentIds.filter((x): x is string => typeof x === 'string'), heldBack: !!r.heldBack, fingerprint: String(r.fingerprint ?? ''), at: Number(r.at) || 0 };
    } catch {
      return null; // @silent-fallback-ok — no dismissal on record shows the item, the safe side for an owner notice
    }
  }
}
