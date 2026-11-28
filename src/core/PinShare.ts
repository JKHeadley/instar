/**
 * PinShare — SEC-170 part 1 of 2 (docs/specs/pool-wide-pin-budget.md §3, §4).
 *
 * The agent's unknown-browser PIN budget is 20 wrong guesses per 5 minutes for the whole agent,
 * not 20 per machine. Each machine owns a fixed share of the 20 and counts its own attempts in its
 * own PinAttemptStore; the shares sum to at most 20, so a stranger who knows every address still
 * gets at most 20 per window.
 *
 * Part 1 carries the floor of the design: the canonical division (equal, remainder one each in id
 * order), the applied share stored durably in two copies, and the rule that a machine may LOWER its
 * own share at any moment but never raises it on its own. Raises, the hand-down to a newly paired
 * machine, recovery from lost records and the owner's "gone for good" are the agreement protocol of
 * part 2 of 2; until then a retirement keeps every share where it is (the safe side).
 *
 * Membership is read from this machine's own registry: every entry that is not revoked (active or
 * pending), plus this machine. A pending pairing counts, which only lowers shares.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';

/** The agent-wide budget (identity-security-piece1c's ratified figure for one machine). */
export const AGENT_PIN_BUDGET = 20;

/**
 * The canonical division of `total` among `memberIds`: floor(total / N) each, plus one for the first
 * (total mod N) members in sorted id order. Always sums to `total` (for N >= 1). Deterministic, so
 * every machine computing it from the same membership gets the same table.
 */
export function canonicalShares(memberIds: readonly string[], total = AGENT_PIN_BUDGET): Record<string, number> {
  const ids = [...new Set(memberIds)].sort();
  const out: Record<string, number> = {};
  if (ids.length === 0) return out;
  const base = Math.floor(total / ids.length);
  const rem = total % ids.length;
  ids.forEach((id, i) => { out[id] = base + (i < rem ? 1 : 0); });
  return out;
}

export function membershipHash(memberIds: readonly string[]): string {
  return createHash('sha256').update([...new Set(memberIds)].sort().join('\n')).digest('hex').slice(0, 32);
}

interface StoredShare {
  v: 1;
  applied: number;
  members: string[];
  hash: string;
  updatedAt: number;
}

export interface PinShareDeps {
  stateDir: string;
  /** Live `security.pinBudget.poolWide` (dev-gated, file-only). */
  enabled: () => boolean;
  /** This machine's id and the ids of every registry entry that is not revoked. Null = unknown. */
  membership: () => { self: string; members: string[] } | null;
  now?: () => number;
}

export interface PinShareState {
  enabled: boolean;
  share: number;
  members: number;
  /** 'off' | 'never-paired' | 'applied' | 'unknown-membership' | 'records-lost' */
  basis: string;
}

const RECOMPUTE_MS = 5_000;

export class PinShareProvider {
  private readonly file: string;
  private readonly prevFile: string;
  private readonly now: () => number;
  private stored: StoredShare | null = null;
  /** Both copies existed but neither could be read: share 0 until part 2's recovery (spec §4). */
  private recordsLost = false;
  private loaded = false;
  private cache: { at: number; state: PinShareState } | null = null;
  private persistFailureReported = false;

  constructor(private readonly deps: PinShareDeps) {
    const dir = path.join(deps.stateDir, 'state');
    this.file = path.join(dir, 'pin-share.json');
    this.prevFile = path.join(dir, 'pin-share.prev.json');
    this.now = deps.now ?? (() => Date.now());
  }

  /** The unknown-browser cap this machine enforces right now. 20 when the switch is off. */
  share(): number {
    return this.state().share;
  }

  state(): PinShareState {
    const now = this.now();
    if (this.cache && now - this.cache.at < RECOMPUTE_MS) return this.cache.state;
    const state = this.compute();
    this.cache = { at: now, state };
    return state;
  }

  /** Drop the short cache (tests, and a registry change the caller knows about). */
  invalidate(): void { this.cache = null; }

  private compute(): PinShareState {
    let enabled = false;
    try { enabled = this.deps.enabled(); } catch { enabled = false; } // @silent-fallback-ok — an unreadable switch is off, which is today's per-machine 20
    if (!enabled) return { enabled: false, share: AGENT_PIN_BUDGET, members: 1, basis: 'off' };
    this.ensureLoaded();
    if (this.recordsLost) return { enabled: true, share: 0, members: this.stored?.members.length ?? 0, basis: 'records-lost' };

    let m: { self: string; members: string[] } | null = null;
    try { m = this.deps.membership(); } catch { m = null; } // @silent-fallback-ok — handled as unknown membership below, which never raises
    if (!m || !m.self) {
      // Unknown membership never raises: keep the stored share, or refuse if there is none.
      return { enabled: true, share: this.stored ? this.stored.applied : 0, members: this.stored?.members.length ?? 0, basis: 'unknown-membership' };
    }
    const members = [...new Set([...m.members, m.self])].sort();
    const entry = canonicalShares(members)[m.self] ?? 0;

    if (!this.stored) {
      // First table on this machine (spec §6 "Turning it on"): take the lower of 20 and its entry.
      const applied = Math.min(AGENT_PIN_BUDGET, entry);
      this.write({ v: 1, applied, members, hash: membershipHash(members), updatedAt: this.now() });
      return { enabled: true, share: applied, members: members.length, basis: members.length === 1 ? 'never-paired' : 'applied' };
    }
    if (entry < this.stored.applied) {
      // Lowering needs no agreement and applies at once (spec §4 "Seeing a new table").
      this.write({ v: 1, applied: entry, members, hash: membershipHash(members), updatedAt: this.now() });
    }
    // Never raise here: a raise needs every machine's acknowledgment (part 2 of 2).
    const share = this.stored.applied;
    return { enabled: true, share, members: members.length, basis: members.length === 1 && share === AGENT_PIN_BUDGET ? 'never-paired' : 'applied' };
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    const primary = this.read(this.file);
    if (primary.value) { this.stored = primary.value; return; }
    const prev = this.read(this.prevFile);
    if (prev.value) {
      this.stored = prev.value;
      this.write(prev.value); // repair the primary copy from the second one
      return;
    }
    if (primary.existed || prev.existed) {
      this.recordsLost = true;
      DegradationReporter.getInstance().report({ feature: 'PinBudget.recordsLost',
        primary: 'This machine\'s share of the agent\'s PIN guess limit is read from its own records',
        fallback: 'Both copies of the record are damaged, so this machine refuses PIN sign-in from new browsers',
        reason: `pin-share records unreadable (${primary.reason ?? 'missing'}; ${prev.reason ?? 'missing'})`,
        impact: 'New browsers cannot sign in with the PIN on this computer until its share is restored. Browsers that signed in before, the phone and this computer itself still work.' });
    }
    // Neither copy ever existed: the first table is written on first use (compute()).
  }

  private read(file: string): { value: StoredShare | null; existed: boolean; reason?: string } {
    let text: string;
    try { text = fs.readFileSync(file, 'utf-8'); } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      return { value: null, existed: code !== 'ENOENT', reason: code ?? 'unreadable' };
    }
    try {
      const raw = JSON.parse(text) as StoredShare;
      if (!raw || raw.v !== 1 || !Number.isInteger(raw.applied) || raw.applied < 0 || raw.applied > AGENT_PIN_BUDGET
        || !Array.isArray(raw.members) || raw.members.some((x) => typeof x !== 'string')) throw new Error('invalid');
      return { value: raw, existed: true };
    } catch {
      return { value: null, existed: true, reason: 'corrupt' };
    }
  }

  /**
   * Durable write of both copies (temporary file, flush, rename, flush the folder). The new value is
   * applied in memory even if the write fails: every write here lowers or first-sets the share, and
   * a lower share is the safe side. A failure is reported once per episode.
   */
  private write(value: StoredShare): void {
    this.stored = value;
    try {
      for (const f of [this.file, this.prevFile]) writeDurable(f, JSON.stringify(value));
      this.persistFailureReported = false;
    } catch (err) {
      if (!this.persistFailureReported) {
        this.persistFailureReported = true;
        DegradationReporter.getInstance().report({ feature: 'PinBudget.persist',
          primary: 'This machine\'s share of the PIN guess limit is saved to disk',
          fallback: 'The lower share is enforced in memory',
          reason: err instanceof Error ? err.message : String(err),
          impact: 'None now. A restart before the next successful save could bring back the previous, larger share on this computer.' });
      }
    }
  }
}

/** Write a small file so it survives a crash or power loss: temp file, fsync, rename, fsync the folder. */
export function writeDurable(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  try {
    const dfd = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch { /* @silent-fallback-ok — some filesystems refuse a directory fsync; the rename itself has landed */ }
}

/** Reads `security.pinBudget.poolWide` live from the settings file (dev-gated, file-only). */
export function pinBudgetPoolWideReader(projectDir: string, resolve: (v: boolean | undefined, cfg: never) => boolean): () => boolean {
  const configPath = path.join(projectDir, '.instar', 'config.json');
  let cached: { at: number; value: boolean } | null = null;
  return () => {
    const now = Date.now();
    if (cached && now - cached.at < RECOMPUTE_MS) return cached.value;
    let value = false;
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { security?: { pinBudget?: { poolWide?: boolean } } };
      value = resolve(cfg.security?.pinBudget?.poolWide, cfg as never);
    } catch {
      // @silent-fallback-ok — an unreadable file keeps the last known value (off before the first read).
      value = cached?.value ?? false;
    }
    cached = { at: now, value };
    return value;
  };
}

/**
 * Membership from this machine's own registry: itself plus every entry that is not revoked. No
 * machine identity, or no registry, means this machine has never been paired (it keeps 20).
 */
export function registryMembership(identity: {
  hasIdentity(): boolean;
  loadIdentity(): { machineId: string };
  loadRegistry(): { machines: Record<string, { status?: string; revokedAt?: string | null }> };
}): () => { self: string; members: string[] } | null {
  return () => {
    if (!identity.hasIdentity()) return { self: 'never-paired', members: [] };
    const self = identity.loadIdentity().machineId;
    let machines: Record<string, { status?: string; revokedAt?: string | null }> = {};
    try { machines = identity.loadRegistry().machines ?? {}; } catch { return null; } // @silent-fallback-ok — unreadable registry is unknown membership, which never raises
    const members = Object.entries(machines)
      .filter(([, e]) => e && e.status !== 'revoked' && !e.revokedAt)
      .map(([id]) => id);
    return { self, members };
  };
}
