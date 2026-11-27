/**
 * Trust-journey section 6, "Checked at load", and the durable change log (6a).
 *
 * Every trust-level change is written to the store's change log; a raise names its consumption.
 * At load, each stored level is checked against that log: a level wider than the last committed
 * change, a raise with no durable consumption, or a key whose history this build cannot read is
 * restored to the stricter committed level. A failed check supplies no permission and never removes
 * a restriction. A level with no logged history predates the log and is left as it is (the legacy
 * import, stage 0 part C, labels those).
 */
import { DEFAULT_TRUST, type AdaptiveTrust, type TrustChangeEvent } from '../AdaptiveTrust.js';
import type { OperationMutability, TrustLevel } from '../ExternalOperationGate.js';
import { isTrustLevelRaise, type OperatorProof } from '../TrustRaiseGuard.js';
import type { TrustJourneyStore } from './TrustJourneyStore.js';

export interface Narrowed { key: string; from: string; to: string; why: string }

export function checkTrustProfileAgainstLog(trust: AdaptiveTrust, store: TrustJourneyStore): Narrowed[] {
  const out: Narrowed[] = [];
  const profile = trust.getProfile();
  for (const [service, st] of Object.entries(profile.services ?? {})) {
    for (const [op, entry] of Object.entries(st.operations ?? {})) {
      if (!entry) continue;
      const key = `${service}.${op}`;
      const level = entry.level as TrustLevel;
      let target: TrustLevel | null = null;
      let why = '';
      // An entry labelled "default" must hold the default: a wider value under that label is a hand edit.
      const dflt = DEFAULT_TRUST[op as OperationMutability];
      if (entry.source === 'default' && dflt && isTrustLevelRaise(dflt, level)) {
        target = dflt; why = 'it is labelled default but is wider than the default';
      }
      if (!target && store.hasUnreadableHistory(key) && isTrustLevelRaise('approve-always', level)) {
        target = 'approve-always'; why = 'its history holds a record this version cannot read';
      }
      const last = store.lastChange(key);
      if (!target && last) {
        if (isTrustLevelRaise(last.to as TrustLevel, level)) {
          target = last.to as TrustLevel; why = 'the stored level is wider than the last committed change';
        } else if (last.direction === 'raise' && !(last.consumptionId && store.consumption(last.consumptionId))) {
          target = ((last.from as TrustLevel | null) ?? 'approve-always'); why = 'the last raise has no recorded approval';
        }
      }
      if (target && isTrustLevelRaise(target, level)) {
        const ev = trust.restoreFromCommittedLog(service, op as OperationMutability, target, `proof check at load: ${why}`);
        if (ev) out.push({ key, from: level, to: target, why });
      }
    }
  }
  return out;
}

/**
 * Writes each trust change to the store. A narrowing is written in the background (losing it can
 * only make the load check stricter, never wider); a raise's write is awaited by `drain()` before
 * the approval is reported, so a raise the person was told about is durable.
 */
export class TrustChangeLogWriter {
  private pending: Array<Promise<boolean>> = [];
  constructor(private readonly store: TrustJourneyStore, private readonly onFail: (key: string) => void = () => {}) {}

  observe = (event: TrustChangeEvent, proof: OperatorProof | null): void => {
    const key = `${event.service}.${event.operation}`;
    const direction = event.from === event.to ? 'same' : isTrustLevelRaise(event.from, event.to) ? 'raise' : 'lower';
    const p = this.store.write('change', {
      changeId: `${key}:${event.timestamp}`, key, from: event.from, to: event.to, direction,
      ...(proof ? { consumptionId: proof.receiptRef } : {}), source: event.source,
    }).then((r) => { if (!r.ok) this.onFail(key); return r.ok; });
    this.pending.push(p);
  };

  /** Resolves true when every change written so far is durable. */
  async drain(): Promise<boolean> {
    const all = this.pending.splice(0);
    const results = await Promise.all(all);
    return results.every(Boolean);
  }
}
