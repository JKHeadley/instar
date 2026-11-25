/**
 * GeminiPaygReconciliationStore — the invoice-drift records of the Gemini pay-per-use
 * lane (docs/specs/gemini-payg-metered-lane.md §7 "Invoice-drift reporting", §8 release
 * check (c)). REPORTING ONLY: nothing here is a gate input, and a record never moves a
 * cap.
 *
 * Each record is what the `gemini-payg-reconcile` job (or Run 2) read on Google's billing
 * page through the account lane's signed-in browser: the posting machine and the
 * server-resolved session, `source: browser-read`, the month, and the figure — or
 * `unmeasurable` when the page could not be read (never a guessed figure).
 *
 * Drift (> 10% AND > $2 against the ledger's committed month) is noticed only after ONE
 * re-read at least 6 hours later still shows it (§Self-Heal (c), max-attempts 1).
 */

import fs from 'node:fs';
import path from 'node:path';

export const RECON_DRIFT_PCT = 10;
export const RECON_DRIFT_USD = 2;
export const RECON_REREAD_AFTER_MS = 6 * 60 * 60 * 1000;

export interface ReconciliationRecord {
  at: string;
  machineId: string;
  session: string;
  source: 'browser-read';
  /** YYYY-MM (Pacific) — the billing month the figure is for. */
  month: string;
  figureUsd: number | null;
  unmeasurable: boolean;
  /** The ledger's committed figure for that month when the record was taken (current month only). */
  committedMonthUsd: number | null;
  driftPct: number | null;
  driftUsd: number | null;
  drifted: boolean;
}

export function computeDrift(figureUsd: number | null, committedUsd: number | null): { driftPct: number | null; driftUsd: number | null; drifted: boolean } {
  if (figureUsd === null || committedUsd === null) return { driftPct: null, driftUsd: null, drifted: false };
  const driftUsd = Math.round((figureUsd - committedUsd) * 100) / 100;
  const base = Math.max(Math.abs(committedUsd), Math.abs(figureUsd));
  const driftPct = base === 0 ? 0 : Math.round((Math.abs(driftUsd) / base) * 1000) / 10;
  return { driftPct, driftUsd, drifted: driftPct > RECON_DRIFT_PCT && Math.abs(driftUsd) > RECON_DRIFT_USD };
}

export class GeminiPaygReconciliationStore {
  readonly file: string;
  private readonly now: () => number;

  constructor(stateDir: string, now?: () => number) {
    this.file = path.join(stateDir, 'state', 'gemini-payg-reconciliation.jsonl');
    this.now = now ?? (() => Date.now());
  }

  list(limit = 200): ReconciliationRecord[] {
    let raw = '';
    try { raw = fs.readFileSync(this.file, 'utf-8'); } catch { return []; } // @silent-fallback-ok — no records yet
    const out: ReconciliationRecord[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as ReconciliationRecord); } catch { continue; } // torn trailing append
    }
    return out.slice(-Math.max(1, limit));
  }

  append(input: Omit<ReconciliationRecord, 'at' | 'source' | 'driftPct' | 'driftUsd' | 'drifted'>): { record: ReconciliationRecord; notify: boolean; rereadAfter: string | null } {
    const drift = computeDrift(input.figureUsd, input.committedMonthUsd);
    const record: ReconciliationRecord = { ...input, at: new Date(this.now()).toISOString(), source: 'browser-read', ...drift };
    const prior = this.list().filter((r) => r.month === record.month && r.drifted);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(record) + '\n', { mode: 0o600 });
    if (!record.drifted) return { record, notify: false, rereadAfter: null };
    // The self-heal is one re-read ≥ 6h after the first drifted read (max-attempts 1).
    const first = prior[0];
    if (first && this.now() - Date.parse(first.at) >= RECON_REREAD_AFTER_MS) return { record, notify: true, rereadAfter: null };
    const base = first ? Date.parse(first.at) : this.now();
    return { record, notify: false, rereadAfter: new Date(base + RECON_REREAD_AFTER_MS).toISOString() };
  }

  /** Release check (c): one real browser-read figure — `unmeasurable` does not count. */
  hasRealBrowserRead(): boolean {
    return this.list().some((r) => r.source === 'browser-read' && !r.unmeasurable && typeof r.figureUsd === 'number');
  }
}
