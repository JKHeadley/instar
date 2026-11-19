/**
 * Asking a helper at the start of a verify (docs/specs/local-verify-borrowed-slices-count.md, F
 * "Asking the helper"): one status request with a 2-second limit, the reduced rate for a silent
 * helper, and the helper's "I am here". The rule is in borrowedAsk.ts; this is the bookkeeping on
 * the practice record, shared by the main-verify observer (inside its detached task) and by the
 * server's side of a waiting change's verify.
 *
 * An answer counts only when its whole-status signature holds for the paired helper and it is
 * fresh. Nothing here throws into a verify.
 */
import type { MachineKeyLookup } from '../core/AppRecordSignatures.js';
import { ASK_LIMITS, askDecision, noteAsked, noteHere, noteSkipped, type AskDecision } from './borrowedAsk.js';
import type { HelperClient, HelperStatusView } from './borrowedClient.js';
import type { BorrowedPracticeStore } from './borrowedState.js';
import type { HelperTarget } from './helper/helperConfig.js';
import { verifyHelperStatus } from './helper/helperProtocol.js';

export interface HelperAskingDeps {
  store: BorrowedPracticeStore;
  client: HelperClient;
  keyLookup: () => MachineKeyLookup;
  audit(event: Record<string, unknown>): void;
  now: () => number;
  /** Called with every verified status answer (the practice record reads the image and runner version from it). */
  onStatus?: (h: HelperTarget, st: HelperStatusView) => void;
}

export class HelperAsking {
  constructor(private readonly d: HelperAskingDeps) {}

  private save(): void {
    try { this.d.store.save(); } catch (e) { this.d.audit({ event: 'borrowed-state-unwritable', detail: String(e instanceof Error ? e.message : e).slice(0, 200) }); }
  }

  /** Whether this verify asks the helper. A `skip` is counted (so the 5th verify asks again). */
  decide(h: HelperTarget): AskDecision {
    const st = this.d.store.get(h.machineId);
    const d = askDecision(st.ask, this.d.now());
    if (d === 'skip') { st.ask = noteSkipped(st.ask); this.save(); }
    return d;
  }

  /**
   * The one status request of a verify, with the 2-second limit. Returns the status when the
   * helper answered with a valid, fresh signature; null otherwise ("no helper for that verify").
   */
  async ask(h: HelperTarget, signal?: AbortSignal): Promise<HelperStatusView | null> {
    let view: HelperStatusView | null = null;
    try { view = await this.d.client.status(h, signal, undefined, ASK_LIMITS.statusTimeoutMs); } catch { view = null; } // @silent-fallback-ok: an unreachable helper is "no answer", counted below
    let ok = false;
    if (view) {
      const why = view.raw ? verifyHelperStatus(view.raw, h.machineId, this.d.keyLookup(), this.d.now()) : 'unsigned';
      if (why) this.d.audit({ event: 'borrowed-status-refused', helper: h.machineId, reason: why });
      ok = why === null;
    }
    const st = this.d.store.get(h.machineId);
    const before = st.ask;
    st.ask = noteAsked(st.ask, ok, this.d.now());
    if (!ok && st.ask.unanswered === ASK_LIMITS.slowAfterUnanswered) this.d.audit({ event: 'borrowed-asking-slowed', helper: h.machineId, since: st.ask.silentSince === null ? null : new Date(st.ask.silentSince).toISOString() });
    if (ok && before.unanswered >= ASK_LIMITS.slowAfterUnanswered) this.d.audit({ event: 'borrowed-asking-restored', helper: h.machineId, by: 'answer' });
    if (ok && view) { try { this.d.onStatus?.(h, view); } catch (e) { this.d.audit({ event: 'borrowed-seam-error', step: 'on-status', detail: String(e instanceof Error ? e.message : e).slice(0, 200) }); } }
    this.save();
    return ok ? view : null;
  }

  /** The helper's verified "I am here": asking on every verify again, at once. */
  here(helperMachineId: string): void {
    const st = this.d.store.get(helperMachineId);
    st.ask = noteHere();
    this.save();
  }
}
