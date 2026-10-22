/**
 * Health of `main` for local-verify (spec docs/specs/local-verify-merge-authority.md
 * §2 "Post-merge verify of main", §3 main-red admission, Self-heal (c)).
 *
 * States:
 *   healthy       — the last `main` verify that counted was green.
 *   main-suspect  — a `main` verify failed once (re-run pending), or the state is
 *                   unknown (missing/unreadable watermark, a lease taken over from a
 *                   different machine, or `main` unverified for too long). Merges
 *                   are repair-only; no notice yet.
 *   main-red      — the re-run failed too. ONE deduped signal `local-verify:main-red`.
 *
 * Cleared only by a green verify of a head equal to or descending from the head
 * that went red (`git merge-base --is-ancestor`, through the verifier's git funnel).
 * An unknown-state suspect (no red head) is cleared by any green `main` verify.
 *
 * The watermark `state/local-verify/main-health.json` is a restriction: it can only
 * make admission stricter. Boot / same-machine re-acquisition with a readable
 * healthy file keeps `healthy`; a missing or unreadable file, or a different
 * machine, enters `main-suspect`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

export type MainHealthState = 'healthy' | 'main-suspect' | 'main-red';

export interface MainHealthSnapshot {
  state: MainHealthState;
  /** The newest `main` head whose verify failed (null for an unknown-state suspect or healthy). */
  redHead: string | null;
  /** Why the state is what it is (boot-unknown, lease-foreign, first-failure, rerun-failed, unverified-too-long, green). */
  reason: string;
  lastGreenHead: string | null;
  since: number;
}

interface Watermark {
  v: 1;
  machineId: string;
  state: MainHealthState;
  redHead: string | null;
  lastGreenHead: string | null;
  reason: string;
  updatedAt: string;
  /** The serving-lease epoch this machine held when it last wrote (null = unknown / single machine). */
  leaseEpoch?: number | null;
  /** The machine that held the lease at that epoch (this machine — the watermark is machine-local). */
  holderMachineId?: string;
}

export interface MainHealthSeams {
  now(): number;
  /** `git merge-base --is-ancestor <ancestor> <descendant>`; null when it cannot be decided. */
  isAncestor(ancestor: string, descendant: string): Promise<boolean | null>;
  /** Deduped attention signal (`local-verify:main-red`, `local-verify:main-unverified`). */
  signal?(key: string, detail: Record<string, unknown>): void;
  /** Called synchronously after every state change (the event-driven withdrawal hooks in here). */
  onChange?(snap: MainHealthSnapshot, prev: MainHealthSnapshot): void;
  audit(event: Record<string, unknown>): void;
}

export const MAIN_HEALTH_LIMITS = Object.freeze({
  /** A merge with no green `main` verify after it for this long enters main-suspect. */
  unverifiedSuspectMs: 3 * 60 * 60 * 1000,
});

export class MainHealth {
  private snap: MainHealthSnapshot;
  private readonly file: string;
  private readonly machineId: string;
  private readonly seams: MainHealthSeams;
  /** The red head whose single flake re-run has already been spent. */
  private rerunSpentFor: string | null = null;
  private readonly raised = new Set<string>();
  /** The lease epoch recorded in the watermark (kept across boots until an acquisition supplies a new one). */
  private leaseEpoch: number | null = null;

  constructor(stateDir: string, machineId: string, seams: MainHealthSeams) {
    this.file = path.join(stateDir, 'state', 'local-verify', 'main-health.json');
    this.machineId = machineId;
    this.seams = seams;
    this.snap = { state: 'main-suspect', redHead: null, reason: 'not-loaded', lastGreenHead: null, since: seams.now() };
  }

  get watermarkPath(): string { return this.file; }

  snapshot(): MainHealthSnapshot { return { ...this.snap }; }

  isHealthy(): boolean { return this.snap.state === 'healthy'; }

  /**
   * Boot, or lease (re-)acquisition. `foreignHolder` is true when a different
   * machine held the lease since this machine last did (unknown ⇒ false: the
   * watermark decides).
   */
  load(opts: { foreignHolder?: boolean; epoch?: number | null } = {}): MainHealthSnapshot {
    const w = this.readWatermark();
    // A gap from the stored epoch means another holder came in between (a
    // same-machine re-acquisition is the next epoch): treated as a different machine.
    const stored = typeof w?.leaseEpoch === 'number' ? w.leaseEpoch : null;
    const epochGap = typeof opts.epoch === 'number' && stored !== null && opts.epoch !== stored && opts.epoch !== stored + 1;
    this.leaseEpoch = opts.epoch !== undefined ? opts.epoch : stored;
    if (opts.foreignHolder || epochGap) {
      if (epochGap) this.seams.audit({ event: 'main-health-epoch-gap', storedEpoch: stored, epoch: opts.epoch });
      this.set({ state: 'main-suspect', redHead: w?.redHead ?? null, reason: epochGap ? 'lease-epoch-gap' : 'lease-foreign', lastGreenHead: w?.lastGreenHead ?? null });
    } else if (!w || w.machineId !== this.machineId) {
      this.set({ state: 'main-suspect', redHead: w?.redHead ?? null, reason: w ? 'watermark-other-machine' : 'boot-unknown', lastGreenHead: w?.lastGreenHead ?? null });
    } else {
      // A readable watermark of this machine: kept as-is (healthy stays healthy, a freeze survives).
      this.set({ state: w.state, redHead: w.redHead, reason: w.state === 'healthy' ? 'watermark-healthy' : w.reason, lastGreenHead: w.lastGreenHead });
    }
    return this.snapshot();
  }

  /**
   * Result of a `main` verify. Returns what the caller must do next:
   *   'rerun'          — re-run this head once (first failure → main-suspect)
   *   'cleared'        — unhealthy → healthy (re-run failed PR verifies)
   *   'none'
   */
  async onVerify(head: string, outcome: 'success' | 'failure' | 'error'): Promise<'rerun' | 'cleared' | 'none'> {
    if (outcome === 'error') return 'none'; // only `failure` counts as red
    if (outcome === 'success') {
      if (this.snap.state === 'healthy') {
        this.set({ ...this.snap, lastGreenHead: head, reason: 'green' });
        return 'none';
      }
      const red = this.snap.redHead;
      let clears = red === null || red === head;
      if (!clears && red) {
        const anc = await this.seams.isAncestor(red, head).catch(() => null);
        clears = anc === true;
        if (anc === null) this.seams.audit({ event: 'main-health-ancestry-unknown', redHead: red, head });
      }
      if (!clears) {
        this.seams.audit({ event: 'main-health-green-not-descendant', redHead: red, head });
        return 'none';
      }
      const wasRed = this.snap.state === 'main-red';
      if (this.snap.state === 'main-suspect' && red) this.seams.audit({ event: 'main-flake', head: red });
      this.rerunSpentFor = null;
      this.raised.delete('local-verify:main-red');
      this.raised.delete('local-verify:main-unverified');
      this.set({ state: 'healthy', redHead: null, reason: 'green', lastGreenHead: head });
      return wasRed || red !== null ? 'cleared' : 'none';
    }
    // failure
    if (this.snap.state === 'healthy' || (this.snap.state === 'main-suspect' && this.rerunSpentFor !== head && this.snap.redHead !== head)) {
      this.rerunSpentFor = head;
      this.set({ ...this.snap, state: 'main-suspect', redHead: head, reason: 'first-failure' });
      return 'rerun';
    }
    // The re-run failed too (or a further head failed while already red).
    this.set({ ...this.snap, state: 'main-red', redHead: head, reason: 'rerun-failed' });
    this.raise('local-verify:main-red', { redHead: head, rollback: "monitoring.greenPrAutoMerge.floor: 'actions' if the red is environmental" });
    return 'none';
  }

  /** `main` has gone unverified (no green verify after a merge) for too long. */
  noteUnverifiedAge(oldestUnverifiedAt: number | null): void {
    if (oldestUnverifiedAt === null) return;
    const age = this.seams.now() - oldestUnverifiedAt;
    if (age <= MAIN_HEALTH_LIMITS.unverifiedSuspectMs) return;
    if (this.snap.state === 'healthy') this.set({ ...this.snap, state: 'main-suspect', reason: 'unverified-too-long' });
    this.raise('local-verify:main-unverified', { ageMs: age });
  }

  private raise(key: string, detail: Record<string, unknown>): void {
    if (this.raised.has(key)) return;
    this.raised.add(key);
    this.seams.audit({ event: 'signal', key, ...detail });
    try { this.seams.signal?.(key, detail); } catch { /* @silent-fallback-ok: a signal sink failure never changes the state */ }
  }

  private set(next: Omit<MainHealthSnapshot, 'since'>): void {
    const prev = this.snap;
    const changed = prev.state !== next.state || prev.redHead !== next.redHead;
    this.snap = { ...next, since: changed ? this.seams.now() : prev.since };
    // Watermark first, then the synchronous withdrawal hook.
    this.writeWatermark();
    if (changed && prev.reason !== 'not-loaded') {
      this.seams.audit({ event: 'main-health', from: prev.state, to: next.state, redHead: next.redHead, reason: next.reason });
      try { this.seams.onChange?.(this.snapshot(), prev); } catch { /* @silent-fallback-ok: the next reconcile pass withdraws */ }
    }
  }

  private readWatermark(): Watermark | null {
    try {
      const o = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Watermark;
      if (o && o.v === 1 && typeof o.machineId === 'string'
        && (o.state === 'healthy' || o.state === 'main-suspect' || o.state === 'main-red')) return o;
    } catch { /* @silent-fallback-ok: missing/unreadable ⇒ main-suspect (the restrictive direction) */ }
    return null;
  }

  private writeWatermark(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const w: Watermark = {
        v: 1, machineId: this.machineId, state: this.snap.state, redHead: this.snap.redHead,
        lastGreenHead: this.snap.lastGreenHead, reason: this.snap.reason, updatedAt: new Date(this.seams.now()).toISOString(),
        leaseEpoch: this.leaseEpoch, holderMachineId: this.machineId,
      };
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(w)); /* state-registry: local-verify-main-health */
      fs.renameSync(tmp, this.file);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      this.seams.audit({ event: 'main-health-write-failed', state: this.snap.state, detail });
      // A stricter state that cannot be recorded must not leave an older, looser
      // watermark behind: remove it, so the next boot enters main-suspect.
      if (this.snap.state !== 'healthy') {
        try {
          SafeFsExecutor.safeRmSync(this.file, { force: true, operation: 'local-verify:main-health-unwritable' });
          this.seams.audit({ event: 'main-health-watermark-removed', state: this.snap.state });
        } catch (e2) {
          this.seams.audit({ event: 'main-health-watermark-remove-failed', detail: e2 instanceof Error ? e2.message : String(e2) });
        }
      }
    }
  }
}
