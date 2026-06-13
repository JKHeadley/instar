/**
 * CredentialSwapJournal — the durable, crash-recovery record of an in-flight credential swap
 * (Step 5 of live credential re-pointing, spec §2.3).
 *
 * This is DISTINCT from the ledger's assignment journal (`CredentialLedgerJournalEntry`): the
 * ledger journal tracks which account tenants which slot; THIS journal carries the extra material
 * a crash recovery needs to make every swap phase decidable — the `swapId`, both slots, both
 * pre-swap account ids, and the `stagingRef` (the keychain service holding the escrow copy of
 * blob A). A location reference only — NEVER token material (§2.3.2).
 *
 * Phases (§2.3): `begin` (staging copied) → `exchanged` (both keychain writes done) → `committed`
 * (identity-verified, ledger updated, staging RETAINED) → `done` (delayed re-verify passed, staging
 * deleted). `aborted` = a pre-first-write failure unwound with nothing destructive done.
 *
 * Sweep predicate (§2.3.2, round-3): a staging entry is protected by ANY non-`done` phase — `begin`
 * AND `committed` both keep their staging alive (staging is the step-6 heal source THROUGH commit);
 * only a `done` row (or no row) makes its staging an orphan. So the in-flight set = every entry
 * whose phase is not `done` and not `aborted`.
 *
 * Persistence: the non-terminal entries live in an atomic tmp+rename state file (recovery reads it
 * at boot); terminal entries (`done`/`aborted`) are removed from the state file and, when a
 * `logsDir` is configured, appended to `logs/credential-swaps.jsonl` for size-rotated history.
 */

import fs from 'node:fs';
import path from 'node:path';

export type SwapPhase = 'begin' | 'exchanged' | 'committed' | 'done' | 'aborted';

/** A non-terminal phase keeps its staging escrow alive (the step-6 heal source). */
export function isTerminalPhase(phase: SwapPhase): boolean {
  return phase === 'done' || phase === 'aborted';
}

export interface SwapJournalEntry {
  /** Random/sequence id deriving from NO token bytes — names the swap + its staging entry. */
  swapId: string;
  slotA: string;
  slotB: string;
  /** Account tenanting slotA BEFORE the swap (slotB receives it). */
  accountA: string;
  /** Account tenanting slotB BEFORE the swap (slotA receives it). */
  accountB: string;
  /** Keychain service holding the escrow COPY of blob A (the freshest step-1a re-read). */
  stagingRef: string;
  phase: SwapPhase;
  startedAt: string;
  updatedAt: string;
  /** Free-text (never a credential — names/ids/reasons only). */
  detail?: string;
}

interface SwapJournalStore {
  version: number;
  swaps: SwapJournalEntry[];
}

export interface CredentialSwapJournalDeps {
  /** Agent stateDir (e.g. `.instar`). The journal lives at `<stateDir>/credential-swaps.json`. */
  stateDir: string;
  /** Optional logs dir for the size-rotated `credential-swaps.jsonl` history. Omit to skip history. */
  logsDir?: string;
  /** Injectable clock for deterministic tests. */
  now?: () => string;
}

const HISTORY_ROTATE_BYTES = 1_048_576; // 1 MiB

export class CredentialSwapJournal {
  private readonly storePath: string;
  private readonly historyPath: string | null;
  private readonly now: () => string;
  private store: SwapJournalStore;

  constructor(deps: CredentialSwapJournalDeps) {
    this.storePath = path.join(deps.stateDir, 'credential-swaps.json');
    this.historyPath = deps.logsDir ? path.join(deps.logsDir, 'credential-swaps.jsonl') : null;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.store = this.load();
  }

  private load(): SwapJournalStore {
    if (!fs.existsSync(this.storePath)) return { version: 0, swaps: [] };
    try {
      const data = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'));
      if (data && typeof data.version === 'number' && Array.isArray(data.swaps)) {
        return data as SwapJournalStore;
      }
    } catch {
      // @silent-fallback-ok: an unparseable in-flight journal is treated as empty. A swap whose
      // begin-row is unreadable left staging behind; the orphan-staging sweep reclaims it by the
      // disjoint-namespace prefix, and the ledger's own journal still gates the slots. The journal
      // is recovery bookkeeping, not a credential — an unreadable row never strands a login.
    }
    return { version: 0, swaps: [] };
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      const tmp = `${this.storePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.store, null, 2) + '\n');
      fs.renameSync(tmp, this.storePath);
    } catch {
      // @silent-fallback-ok: in-memory store stays authoritative for this process; next mutation retries.
    }
  }

  private appendHistory(entry: SwapJournalEntry): void {
    if (!this.historyPath) return;
    try {
      fs.mkdirSync(path.dirname(this.historyPath), { recursive: true });
      try {
        const st = fs.statSync(this.historyPath);
        if (st.size > HISTORY_ROTATE_BYTES) {
          fs.renameSync(this.historyPath, `${this.historyPath}.1`);
        }
      } catch {
        // @silent-fallback-ok: no existing history file yet — nothing to rotate.
      }
      fs.appendFileSync(this.historyPath, JSON.stringify(entry) + '\n');
    } catch {
      // @silent-fallback-ok: history is audit-only; a write failure never affects recovery.
    }
  }

  /** Record a swap's `begin` row (staging copied, before the first destructive write). */
  begin(input: {
    swapId: string;
    slotA: string;
    slotB: string;
    accountA: string;
    accountB: string;
    stagingRef: string;
    detail?: string;
  }): SwapJournalEntry {
    const at = this.now();
    const entry: SwapJournalEntry = {
      swapId: input.swapId,
      slotA: input.slotA,
      slotB: input.slotB,
      accountA: input.accountA,
      accountB: input.accountB,
      stagingRef: input.stagingRef,
      phase: 'begin',
      startedAt: at,
      updatedAt: at,
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
    };
    // A re-begin of the same swapId replaces the prior row (idempotent restart).
    this.store.swaps = this.store.swaps.filter((s) => s.swapId !== input.swapId);
    this.store.swaps.push(entry);
    this.store.version += 1;
    this.save();
    return entry;
  }

  /** Advance a swap to a new phase. A terminal phase removes it from the in-flight set + archives it. */
  advance(swapId: string, phase: SwapPhase, detail?: string): SwapJournalEntry | null {
    const entry = this.store.swaps.find((s) => s.swapId === swapId);
    if (!entry) return null;
    entry.phase = phase;
    entry.updatedAt = this.now();
    if (detail !== undefined) entry.detail = detail;
    this.store.version += 1;
    if (isTerminalPhase(phase)) {
      this.store.swaps = this.store.swaps.filter((s) => s.swapId !== swapId);
      this.appendHistory(entry);
    }
    this.save();
    return entry;
  }

  /** Every in-flight (non-terminal) swap — the recovery work-list at boot. */
  inFlight(): readonly SwapJournalEntry[] {
    return this.store.swaps.filter((s) => !isTerminalPhase(s.phase)).slice();
  }

  get(swapId: string): SwapJournalEntry | null {
    return this.store.swaps.find((s) => s.swapId === swapId) ?? null;
  }

  get version(): number {
    return this.store.version;
  }
}
