/**
 * SEC-170 part 3 of 3: the owner's side of the pool-wide PIN budget (docs/specs/pool-wide-pin-budget.md §4).
 *
 *  - silent(): the one agent-wide list of machines silent for 7 days or more, the data behind the single
 *    Needs-you item. It says whether the item should show: a dismissed item stays quiet until something new
 *    (another machine goes silent, or a raise starts being held back by a silent machine).
 *  - precheck/apply(id, choice, fingerprint): the owner's two choices for a listed computer, "retire" (remove its
 *    pairing) and "gone-for-good" (record that it was wiped, lost or destroyed). Only the owner's phone reaches
 *    apply, through a Face ID permission action whose signed line names the computer, the choice and the list
 *    version (POST /mobile/pin-budget/silent-machine). No bearer token or dashboard PIN reaches it.
 *
 * Signal, not authority: the list proposes; only the owner retires a machine or confirms it gone, and a
 * confirmation counts toward a raise only while PinShare's pool-wide 7-day silence check agrees.
 */
import fs from 'node:fs';
import path from 'node:path';
import { GoneForGoodStore, silentMachines, isNewSince, type SilentMachineRow } from './PinGoneForGood.js';
import { writeDurable } from './PinShare.js';
import { featureEvidence } from '../monitoring/FeatureEvidenceLog.js';

export type SilentChoice = 'retire' | 'gone-for-good';
const DISMISS_FILE = 'pin-silent-dismissed.json';

export interface PinOwnerSurfaceDeps {
  stateDir: string;
  store: GoneForGoodStore;
  enabled: () => boolean;
  self: () => string | null;
  /** Non-retired registry members with registry timestamps (ms; 0 when unknown) and a display name. */
  members: () => Array<{ machineId: string; name: string; lastSeen: number; pairedAt: number }>;
  /** True when this id is in the registry and already retired (revoked). */
  isRetired: (machineId: string) => boolean;
  contacts: () => ReadonlyMap<string, number>;
  /** False when some member's contact records could not be read (the list may then be incomplete). */
  evidenceComplete: () => boolean;
  /** True while this machine's share is below its equal entry, i.e. a raise is waiting on acknowledgments. */
  raiseWaiting: () => boolean;
  /** Retire (revoke) the machine in the replicated registry, by this machine. Throws on failure. */
  retire: (machineId: string) => void;
  /** Re-read the share after a change. */
  invalidate: () => void;
  now?: () => number;
}

export interface SilentMachinesView {
  enabled: boolean;
  rows: Array<SilentMachineRow & { name: string }>;
  heldBack: boolean;
  evidenceComplete: boolean;
  fingerprint: string;
  /** True when the owner dismissed the item and nothing new has happened since. */
  dismissed: boolean;
  /** Whether the Needs-you item should be showing now. */
  show: boolean;
}

/** A route answer: status and JSON body (the phone route passes it through). */
export interface SurfaceResult { status: number; body: Record<string, unknown> }

interface DismissRecord { silentIds: string[]; heldBack: boolean; fingerprint: string; at: number }

const OFF: SurfaceResult = { status: 503, body: { error: 'pin-budget-off', detail: 'The pool-wide PIN guess limit is off on this agent.' } };

export class PinOwnerSurface {
  private readonly now: () => number;
  private readonly dismissFile: string;
  constructor(private readonly deps: PinOwnerSurfaceDeps) {
    this.now = deps.now ?? Date.now;
    this.dismissFile = path.join(deps.stateDir, 'state', DISMISS_FILE);
  }

  silent(): SilentMachinesView {
    if (!this.deps.enabled()) return { enabled: false, rows: [], heldBack: false, evidenceComplete: true, fingerprint: '', dismissed: false, show: false };
    const members = this.deps.members();
    const contacts = this.deps.contacts();
    const confirmed = this.deps.store.standing(contacts);
    const { rows, fingerprint, heldBack } = silentMachines({ self: this.deps.self(), members, contacts, confirmed, heldBack: this.deps.raiseWaiting(), now: this.now() });
    const names = new Map(members.map((m) => [m.machineId, m.name]));
    let dismissedRec = this.readDismissed();
    // A machine that came back drops out of the dismissal, so going silent again later counts as something new.
    if (dismissedRec) {
      const listed = new Set(rows.map((r) => r.machineId));
      const kept = dismissedRec.silentIds.filter((x) => listed.has(x));
      if (kept.length !== dismissedRec.silentIds.length) {
        dismissedRec = { ...dismissedRec, silentIds: kept };
        try { writeDurable(this.dismissFile, JSON.stringify(dismissedRec)); } catch { /* @silent-fallback-ok — an unsaved trim only means the item may stay quiet once more */ }
      }
    }
    const current = { silentIds: rows.map((r) => r.machineId), heldBack };
    const fresh = isNewSince(dismissedRec, current);
    const dismissed = rows.length > 0 && !!dismissedRec && !fresh;
    let evidenceComplete = true;
    try { evidenceComplete = this.deps.evidenceComplete(); } catch { evidenceComplete = false; } // @silent-fallback-ok — unknown is reported as incomplete
    return { enabled: true, rows: rows.map((r) => ({ ...r, name: names.get(r.machineId) || 'A computer with no name yet' })), heldBack, evidenceComplete, fingerprint, dismissed, show: rows.length > 0 && !dismissed };
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

  /**
   * Can this choice succeed now? Null when it can; otherwise the refusal, answered before any Face ID is asked for.
   * "Already" counts as able to proceed: apply then answers { already: true } without changing anything.
   */
  precheck(machineId: string, choice: SilentChoice, fingerprint: string): SurfaceResult | null {
    if (!this.deps.enabled()) return OFF;
    if (machineId === this.deps.self()) return { status: 409, body: { error: 'self', detail: 'This is the computer you are connected to, so it cannot be retired or confirmed gone from here.' } };
    if (this.already(machineId, choice)) return null;
    const view = this.silent();
    if (view.fingerprint !== fingerprint) return { status: 409, body: { error: 'list-changed', detail: 'The list of silent computers changed since you saw it. Look again, then choose.' } };
    if (!view.rows.some((r) => r.machineId === machineId)) return { status: 409, body: { error: 'not-silent', detail: 'Only a computer that has been silent for 7 days or more can be retired or confirmed gone from this list.' } };
    // Retiring cannot be undone, so it waits until every computer's records could be read: an unreadable record
    // might hold recent contact from a computer that only looks silent. (A gone-for-good confirmation is already
    // held back downstream until the records are complete.)
    if (choice === 'retire' && !view.evidenceComplete) return { status: 409, body: { error: 'evidence-incomplete', detail: 'Some of your computers could not be checked just now, so I cannot be sure this one is really silent. Try again in a few minutes.' } };
    return null;
  }

  /** Apply the owner's choice. Reached only after the owner's signed Face ID tap; re-checks everything first. */
  apply(machineId: string, choice: SilentChoice, fingerprint: string): SurfaceResult {
    const refusal = this.precheck(machineId, choice, fingerprint);
    if (refusal) return refusal;
    if (this.already(machineId, choice)) return { status: 200, body: { ok: true, already: true } };
    try {
      if (choice === 'retire') this.deps.retire(machineId);
      else this.deps.store.confirm(machineId, this.deps.self() ?? '');
    } catch {
      return { status: 500, body: { error: 'apply-failed', detail: 'That did not work, and nothing changed. Try again.' } }; // @silent-fallback-ok — the phone shows this; nothing was saved
    }
    featureEvidence.record('pinBudgetPoolWide', { kind: 'fired', reason: choice === 'retire' ? 'owner retired a silent computer from the phone' : 'owner confirmed a silent computer gone for good from the phone' });
    this.deps.invalidate();
    return { status: 200, body: choice === 'retire'
      ? { ok: true, applied: choice, detail: 'Retired. It can no longer connect to your other computers. It still holds a copy of the agent\'s keys, so rotate them if it may be in someone else\'s hands.' }
      : { ok: true, applied: choice } };
  }

  private already(machineId: string, choice: SilentChoice): boolean {
    if (choice === 'retire') return this.deps.isRetired(machineId);
    return !!this.deps.store.read()[machineId] && this.deps.store.standing(this.deps.contacts()).has(machineId);
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
