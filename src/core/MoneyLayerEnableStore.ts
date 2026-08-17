/**
 * MoneyLayerEnableStore — the durable half of the money-layer enable surface
 * (docs/specs/money-layer-operator-enable-surface.md §3).
 *
 * Deliberately a SEPARATE file from the caps store and deliberately OUTSIDE
 * `PATCHABLE_CONFIG_KEYS`: no route in instar may edit the money config file,
 * because a route that can is a larger authority than the one being added (§5).
 *
 * What is persisted, and what is NOT:
 *
 *   operatorEnabled        yes  — the operator's decision survives a crash
 *   lifecycleState         NO   — derived at boot; a stored in-progress state
 *                                 would be a lie after that process died
 *   lastTransitionAt       yes  — ages a stuck state
 *   failure record         yes  — a failure must not be forgotten by crashing
 *   lastObservedSourceState yes — so an enable-source TRANSITION can be audited
 *
 * Write discipline: tmp + fsync(file) + rename + fsync(dir). `rename` alone
 * gives atomic REPLACEMENT, not durability across a crash — the fsync pair is
 * what makes the record survive, and naming only `rename` would be an overclaim.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { EnableSourceState, MoneyFailureRecord } from './moneyLayerEnable.js';

export interface MoneyLayerEnableFile {
  version: number;
  /** The operator's persisted intent — the half of MLE-1 this surface owns. */
  operatorEnabled: boolean;
  /** ISO of the last state-affecting change; ages a stuck state. */
  lastTransitionAt: string | null;
  /** A failure with no successful enable since — cleared ONLY by a probe that actually passes. */
  failure: MoneyFailureRecord | null;
  /** The enable-source state as last OBSERVED by a writing path (never by a read). */
  lastObservedSourceState: EnableSourceState | null;
  /**
   * When a restart was last ACCEPTED, in epoch ms. Persisted because the action
   * being rate-limited is the one that ends the process: an in-memory cooldown
   * resets on every restart it authorizes, which is no cooldown at all.
   */
  lastRestartAcceptedAtMs?: number;
}

const EMPTY: MoneyLayerEnableFile = {
  version: 0,
  operatorEnabled: false,
  lastTransitionAt: null,
  failure: null,
  lastObservedSourceState: null,
};

/** Fail-closed validation: a PRESENT-but-malformed money file must never be silently defaulted. */
export function validateEnableFile(f: unknown): string | null {
  if (!f || typeof f !== 'object') return 'not an object';
  const o = f as Record<string, unknown>;
  if (typeof o.version !== 'number' || !Number.isFinite(o.version) || o.version < 0) return 'version must be a non-negative number';
  if (typeof o.operatorEnabled !== 'boolean') return 'operatorEnabled must be a boolean';
  if (o.lastTransitionAt !== null && typeof o.lastTransitionAt !== 'string') return 'lastTransitionAt must be an ISO string or null';
  if (o.lastObservedSourceState !== null && typeof o.lastObservedSourceState !== 'string') return 'lastObservedSourceState must be a string or null';
  if (o.lastRestartAcceptedAtMs !== undefined && (typeof o.lastRestartAcceptedAtMs !== 'number' || !Number.isFinite(o.lastRestartAcceptedAtMs) || o.lastRestartAcceptedAtMs < 0)) {
    return 'lastRestartAcceptedAtMs must be a non-negative number when present';
  }
  if (o.failure !== null) {
    const fr = o.failure as Record<string, unknown>;
    if (!fr || typeof fr !== 'object') return 'failure must be an object or null';
    if (fr.state !== 'probe-failed' && fr.state !== 'construction-failed') return 'failure.state must be probe-failed or construction-failed';
    if (typeof fr.failingComponent !== 'string' || !fr.failingComponent) return 'failure.failingComponent must be a non-empty string';
    if (typeof fr.at !== 'string') return 'failure.at must be an ISO string';
  }
  return null;
}

export interface MoneyLayerEnableStoreOptions {
  /** The agent's `.instar/` dir. */
  stateDir: string;
  now?: () => number;
}

export class MoneyLayerEnableStore {
  private readonly filePath: string;
  private readonly now: () => number;

  constructor(opts: MoneyLayerEnableStoreOptions) {
    const stateSub = path.join(opts.stateDir, 'state');
    fs.mkdirSync(stateSub, { recursive: true });
    this.filePath = path.join(stateSub, 'money-layer-enable.json');
    this.now = opts.now ?? (() => Date.now());
  }

  path(): string {
    return this.filePath;
  }

  /**
   * Read the durable record. A MISSING file is the legitimate never-enabled
   * state and reads as EMPTY; a PRESENT-but-corrupt file THROWS, because money
   * intent must never be silently defaulted to a clean-looking value.
   */
  read(): MoneyLayerEnableFile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch {
      // @silent-fallback-ok: ABSENT is the legitimate pre-enable state. Only
      // absence is safe to default; a present-but-corrupt file throws below.
      return structuredClone(EMPTY);
    }
    const parsed = JSON.parse(raw) as MoneyLayerEnableFile; // throws on corrupt → caller fails closed
    const err = validateEnableFile(parsed);
    if (err) throw new Error(`money-layer enable store invalid (fail-closed): ${err}`);
    return parsed;
  }

  /** The operator half of MLE-1, read LIVE. This is the source this surface writes, so a disable takes effect on the very next call. */
  operatorEnabled(): boolean {
    try {
      return this.read().operatorEnabled === true;
    } catch (err) {
      // @silent-fallback-ok: NOT silent — it logs loudly below. The degraded
      // value is FALSE, which withholds spend; that is the safe direction and
      // the only one available when the operator's decision is unreadable.
      // A corrupt store cannot assert intent. FALSE is the fail-closed answer:
      // it withholds spend rather than granting it on an unreadable file. It is
      // NOT silent, though — "the operator's money decision is unreadable" is
      // exactly the condition that must not degrade quietly into a clean-looking
      // "off", because the operator would see a disabled switch and no reason.
      console.error(
        `[money-layer] the operator-enable store at ${this.filePath} is UNREADABLE — reading intent as OFF (fail closed). ` +
          `The money layer will not come up until this file is repaired or removed: ${String(err)}`,
      );
      return false;
    }
  }

  /** Set the operator flag. Idempotent in intent — re-enabling never double-enables. */
  setOperatorEnabled(enabled: boolean): MoneyLayerEnableFile {
    return this.mutate((f) => {
      if (f.operatorEnabled !== enabled) f.lastTransitionAt = new Date(this.now()).toISOString();
      f.operatorEnabled = enabled;
    });
  }

  /**
   * Record a failure. Persisted so a crash cannot launder a failing layer into
   * a clean-looking `enable-pending-restart` at the next boot.
   */
  recordFailure(state: 'probe-failed' | 'construction-failed', failingComponent: string): MoneyLayerEnableFile {
    return this.mutate((f) => {
      f.failure = { state, failingComponent, at: new Date(this.now()).toISOString() };
      f.lastTransitionAt = new Date(this.now()).toISOString();
    });
  }

  /**
   * Clear the failure record. Called ONLY by a probe that actually passed —
   * never by the attempt itself, so a repeatedly-failing layer keeps reporting
   * the same honest failure rather than resetting on each try.
   */
  clearFailure(): MoneyLayerEnableFile {
    const current = this.readSafe();
    if (!current.failure) return current; // no write when there is nothing to clear
    return this.mutate((f) => {
      f.failure = null;
      f.lastTransitionAt = new Date(this.now()).toISOString();
    });
  }

  /** Persist the accepted-restart instant so the cooldown survives the restart it authorizes. */
  recordRestartAccepted(atMs: number): MoneyLayerEnableFile {
    return this.mutate((f) => {
      f.lastRestartAcceptedAtMs = atMs;
    });
  }

  /**
   * Compare-and-update the last observed enable-source state. Returns the
   * PREVIOUS value when it changed (so the caller appends the transition row),
   * or `null` when unchanged.
   *
   * Called ONLY from paths that are already mutating — money-layer construction
   * and each commit's post-verify step. A polled GET must never reach this:
   * making a read capable of audit writes would both contradict its contract
   * and let dashboard polling drive log volume (T32).
   */
  observeSourceState(state: EnableSourceState): EnableSourceState | null {
    const current = this.readSafe();
    if (current.lastObservedSourceState === state) return null;
    const previous = current.lastObservedSourceState;
    this.mutate((f) => {
      f.lastObservedSourceState = state;
    });
    return previous ?? 'disabled';
  }

  private readSafe(): MoneyLayerEnableFile {
    try {
      return this.read();
    } catch {
      // A corrupt file must not be silently overwritten by a mutation built on
      // a defaulted base — callers of mutate() surface the throw instead.
      throw new Error('money-layer enable store unreadable — refusing to write over it (fail closed)');
    }
  }

  private mutate(fn: (f: MoneyLayerEnableFile) => void): MoneyLayerEnableFile {
    const before = this.readSafe();
    const after = structuredClone(before);
    fn(after);
    after.version = before.version + 1;
    const err = validateEnableFile(after);
    if (err) throw new Error(`money-layer enable mutation rejected by validator: ${err}`);
    this.writeDurable(after);
    return after;
  }

  /**
   * tmp → fsync(file) → rename → fsync(dir). The fsync PAIR is the durability;
   * rename alone only gives atomic replacement.
   */
  private writeDurable(f: MoneyLayerEnableFile): void {
    const tmp = `${this.filePath}.tmp`;
    const dir = path.dirname(this.filePath);
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(f, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.filePath);
    let dirFd: number | null = null;
    try {
      dirFd = fs.openSync(dir, 'r');
      fs.fsyncSync(dirFd);
    } catch {
      // @silent-fallback-ok: directory fsync is unsupported on some platforms.
      // The file fsync above already carries the record's contents; losing the
      // rename's durability degrades to the previous value, never a torn one.
    } finally {
      if (dirFd !== null) {
        try {
          fs.closeSync(dirFd);
        } catch {
          /* @silent-fallback-ok: closing a probe descriptor */
        }
      }
    }
  }
}
