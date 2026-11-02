/**
 * Target-side authority for remote desktop through the ordinary Mac lock.
 * Off is today's behaviour: with no setting, no marker and an empty proven
 * table this answers "off" and touches nothing.
 *
 * State that must outlive Node lives on the Mac, changed only by the helper
 * under a kernel lock. This class never takes that lock, so a suspended Node
 * cannot hold a relock up. It holds no password and has no route that makes one.
 * Spec: docs/specs/desktop-locked-screen.md.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import { classifyDesktopLock, isLockedClass, type DesktopLockPolicy, type DesktopLockSample, type DesktopLockState } from './DesktopLockState.js';
import { PROVEN_MACOS_VERSIONS, provenVersion, type DesktopProvenVersion } from './DesktopProvenVersions.js';

export const RELOCK_WATCH_MS = 120_000;
const WATCH_SLACK_MS = 30_000;
const POLICY_TTL_MS = 60_000;
const SWEEP_MS = 10_000;
const GUARD_ACK_MS = 3_000;
const HEARTBEAT_STALE_MS = 5_000;
export const MAX_GUARD_REPLACEMENTS = 3;
const RESUME_WINDOW_MS = 30_000;
export const RESPAWNS_PER_CHANGE = 3;
export const RESPAWNS_PER_REQUEST = 8;
const TERMINAL = new Set(['relocked', 'relock-failed', 'left-unlocked', 'closed-not-applicable']);
const BLOCKING = new Set(['owed', 'executing', 'watching']);

export interface DesktopLockedSettings { enabled: boolean; browserBox: boolean; chime: boolean }

export interface DesktopRelockMarker {
  state: string;
  agentId?: string;
  requestId?: string;
  deadlineMs?: number;
  resumeWindowMs?: number;
  relockNow?: boolean;
  typistPid?: number;
  typistStart?: string;
  guardPid?: number;
  guardStart?: string;
  guardReplacements?: number;
  enterPendingAt?: number;
  watchStart?: number;
  bootSession?: string;
  loginSession?: string;
  producerGone?: boolean;
  reported?: boolean;
}

/** The helper's state-op verb, in one call. */
export interface DesktopLockedHostPort {
  lockedOp(op: Record<string, unknown>): Promise<Record<string, unknown>>;
  startRelockGuard(key: string): Promise<void>;
  setLockedMode(mode: { root: string; refuse: string[]; chime?: boolean } | null): void;
}

export interface DesktopLockedDeps {
  host: DesktopLockedHostPort;
  agentId: string;
  settings: () => DesktopLockedSettings;
  saveSettings: (next: DesktopLockedSettings) => void;
  readPolicy: () => Promise<DesktopLockPolicy>;
  tunnelFirstTierActive: () => boolean;
  /** True only once the item is durably with the owner's attention surface. */
  raiseSecurity: (item: { key: string; title: string; body: string }) => boolean | Promise<boolean>;
  audit?: (event: Record<string, unknown>) => void;
  now?: () => number;
  root?: string;
  /** Only tests pass this. Production always uses the shipped table. */
  provenVersions?: readonly DesktopProvenVersion[];
}

/** A dead guard is replaced at most this often for one duty, then the duty fails loudly. */
export function decideGuardReplacement(replacements: number): 'replace' | 'give-up' {
  return replacements >= MAX_GUARD_REPLACEMENTS ? 'give-up' : 'replace';
}

/** 3 per state change and 8 per request; spends one or refuses. */
export function decideLockedRespawn(thisChange: number, total: number): boolean {
  return thisChange < RESPAWNS_PER_CHANGE && total < RESPAWNS_PER_REQUEST;
}

export class DesktopLockedController {
  readonly root: string;
  private readonly now: () => number;
  private readonly proven: readonly DesktopProvenVersion[];
  private policy: { value: DesktopLockPolicy; at: number } | null = null;
  private lastRawFlag: boolean | undefined;
  private lastOsMajor: number | undefined;
  private lastState: DesktopLockState = 'unknown';
  private readonly live = new Map<string, { key: string; generation: number }>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;
  private lastAdmissionRefusal: string | null = null;

  constructor(private readonly deps: DesktopLockedDeps) {
    this.root = deps.root ?? path.join(os.homedir(), '.instar', 'desktop-helper', 'locked');
    this.now = deps.now ?? Date.now;
    this.proven = deps.provenVersions ?? PROVEN_MACOS_VERSIONS;
  }

  private storeExists(): boolean { return fs.existsSync(path.join(this.root, 'locked-state.json')); }

  /** The feature needs the owner's setting AND a proven macOS. */
  active(osMajor: number | undefined = this.lastOsMajor): boolean {
    return this.deps.settings().enabled && !!provenVersion(this.proven, osMajor);
  }

  /** Why the enable route refuses. No route can reach past this. */
  enableRefusal(osMajor: number | undefined): string | null {
    return provenVersion(this.proven, osMajor) ? null : 'unsupported-macos';
  }

  /** Tells the host whether to spawn helpers with the feature on. */
  applyMode(osMajor: number | undefined): void {
    this.lastOsMajor = osMajor;
    const row = provenVersion(this.proven, osMajor);
    this.deps.host.setLockedMode(this.deps.settings().enabled && row
      ? { root: this.root, refuse: row.refuse, chime: this.deps.settings().chime } : null);
  }

  private async policyFor(flag: boolean | undefined): Promise<DesktopLockPolicy> {
    const fresh = this.policy && this.now() - this.policy.at < POLICY_TTL_MS;
    // Only a change in a raw input refreshes, or a refresh would feed itself.
    const changed = flag !== this.lastRawFlag;
    this.lastRawFlag = flag;
    if (fresh && !changed) return this.policy!.value;
    const refreshing = this.deps.readPolicy().then(value => {
      this.policy = { value, at: this.now() };
      return value;
    }, (): DesktopLockPolicy => {
      this.policy = { value: 'unreadable', at: this.now() };
      return 'unreadable';
    });
    return changed ? (void refreshing, 'pending') : refreshing;
  }

  async readState(sample: DesktopLockSample): Promise<DesktopLockState> {
    this.applyMode(sample.osMajor ?? sample.lockInputs?.osMajor);
    const state = classifyDesktopLock(sample, await this.policyFor(sample.screenLocked), this.now());
    this.lastState = state;
    return state;
  }

  wanted(): boolean { return this.deps.settings().enabled; }

  private async read(): Promise<{ markers: Record<string, DesktopRelockMarker>; disabled: boolean; dirty: boolean; attempts: { count: number }; bootSession?: string; loginSession?: string }> {
    if (!this.storeExists()) return { markers: {}, disabled: false, dirty: false, attempts: { count: 0 } };
    const reply = await this.deps.host.lockedOp({ op: 'read' });
    const state = (reply.state ?? {}) as { markers?: Record<string, DesktopRelockMarker>; disabled?: boolean; dirty?: unknown };
    return { markers: state.markers ?? {}, disabled: state.disabled === true, dirty: !!state.dirty,
      attempts: (reply.attempts ?? { count: 0 }) as { count: number },
      bootSession: reply.bootSession as string | undefined, loginSession: reply.loginSession as string | undefined };
  }

  private heartbeatAgeMs(key: string): number | null {
    try { return this.now() - fs.statSync(path.join(this.root, `hb-${key}`)).mtimeMs; }
    catch { return null; } // @silent-fallback-ok — no heartbeat file reads as stale, which replaces the guard.
  }

  private renewLease(key: string): void {
    const file = path.join(this.root, `lease-${key}`);
    fs.writeFileSync(file, '', { mode: 0o600 });
    // Truncating an empty file need not move its time; the guard reads the time.
    const stamp = new Date(this.now());
    fs.utimesSync(file, stamp, stamp);
  }

  /** The unlock happened, so nothing is left in a password field. */
  async noteUnlocked(): Promise<void> {
    await this.deps.host.lockedOp({ op: 'clear-dirty' });
  }

  private stale(marker: DesktopRelockMarker, key: string): boolean {
    const deadline = marker.state === 'watching'
      ? (marker.watchStart ?? 0) + RELOCK_WATCH_MS + WATCH_SLACK_MS
      : (marker.deadlineMs ?? 0);
    const age = this.heartbeatAgeMs(key);
    return this.now() >= deadline && (age === null || age > HEARTBEAT_STALE_MS);
  }

  /** Both must be confirmed gone before anything reopens. */
  private async stopRecorded(marker: DesktopRelockMarker): Promise<boolean> {
    const stop = async (pid?: number, start?: string): Promise<boolean> => {
      if (!pid || !start) return true;
      return (await this.deps.host.lockedOp({ op: 'kill-recorded', pid, start })).gone === true;
    };
    const [guard, typist] = [await stop(marker.guardPid, marker.guardStart), await stop(marker.typistPid, marker.typistStart)];
    return guard && typist;
  }

  /** Null admits. Runs even with the feature off, but only if a marker exists,
   * so a clean Mac stays byte for byte today's path. */
  async admissionRefusal(sameRequestId?: string): Promise<string | null> {
    if (!this.storeExists()) return null;
    const { markers, disabled, bootSession, loginSession } = await this.read();
    if (disabled && this.deps.settings().enabled) this.lastAdmissionRefusal = 'disabled';
    for (const [key, marker] of Object.entries(markers)) {
      if (marker.requestId === sameRequestId) continue;
      // That reboot or logout already ended the session, so no duty remains.
      if (BLOCKING.has(marker.state) && bootSession && (marker.bootSession !== bootSession
        || (loginSession && marker.loginSession !== loginSession))) {
        await this.deps.host.lockedOp({ op: 'close', key, to: 'closed-not-applicable' });
        continue;
      }
      if (marker.state === 'left-unlocked' && marker.producerGone !== true) {
        if (!await this.stopRecorded({ ...marker, guardPid: undefined })) return 'relock-failed-producer-alive';
        await this.deps.host.lockedOp({ op: 'set-producer-gone', key });
        continue;
      }
      if (marker.state === 'relock-failed') {
        if (marker.producerGone === false) {
          if (await this.stopRecorded(marker)) await this.deps.host.lockedOp({ op: 'set-producer-gone', key });
          else return 'relock-failed-producer-alive';
        }
        continue;
      }
      if (!BLOCKING.has(marker.state)) continue;
      if (!this.stale(marker, key)) return 'relock-pending';
      if (!await this.stopRecorded(marker)) return 'relock-pending-unconfirmed';
      await this.deps.host.lockedOp({ op: 'close', key, to: 'relock-failed', producerGone: true });
    }
    return null;
  }

  noteGrant(requestId: string): void {
    if (!this.live.has(requestId)) this.live.set(requestId, { key: `${requestId}.0`, generation: 0 });
    this.startSweep();
  }

  /** Marker first, then guard, then its acknowledgement. Nothing is typed
   * before all three. */
  async prepareSecret(requestId: string, deadlineMs: number): Promise<{ key: string } | { refused: string }> {
    // Stop may have landed already. A marker now would outlive its request.
    const entry = this.live.get(requestId);
    if (!entry) return { refused: 'grant-ended' };
    let key = entry.key;
    let reply = await this.deps.host.lockedOp({ op: 'marker-create', key, marker: {
      agentId: this.deps.agentId, requestId, deadlineMs, resumeWindowMs: RESUME_WINDOW_MS } });
    if (reply.error) return { refused: String(reply.error) };
    const existing = reply.marker as DesktopRelockMarker | undefined;
    if (existing?.state === 'relock-failed') return { refused: 'relock-failed' };
    if (existing && TERMINAL.has(existing.state)) {
      entry.generation++;
      key = `${requestId}.${entry.generation}`;
      entry.key = key;
      reply = await this.deps.host.lockedOp({ op: 'marker-create', key, marker: {
        agentId: this.deps.agentId, requestId, deadlineMs, resumeWindowMs: RESUME_WINDOW_MS } });
    }
    this.renewLease(key);
    const age = this.heartbeatAgeMs(key);
    if (age === null || age > HEARTBEAT_STALE_MS) {
      await this.deps.host.startRelockGuard(key);
      const until = this.now() + GUARD_ACK_MS;
      while (this.now() < until) {
        const seen = this.heartbeatAgeMs(key);
        if (seen !== null && seen <= HEARTBEAT_STALE_MS) return { key };
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return { refused: 'guard-not-alive' };
    }
    return { key };
  }

  /** Stop or the ceiling: relock now. Transport loss renews until the window. */
  async endRequest(requestId: string, reason: 'stop' | 'transport-lost'): Promise<void> {
    const entry = this.live.get(requestId);
    if (!entry) return;
    if (reason === 'stop') {
      this.live.delete(requestId);
      await this.deps.host.lockedOp({ op: 'relock-now', key: entry.key });
    }
  }

  /** Acknowledged only if this tap beat the guard. */
  async leaveUnlocked(requestId: string): Promise<boolean> {
    const entry = this.live.get(requestId);
    if (!entry) return false;
    const reply = await this.deps.host.lockedOp({ op: 'leave-unlocked', key: entry.key });
    this.deps.audit?.({ kind: 'leave-unlocked', ok: reply.ok === true });
    return reply.ok === true;
  }

  async refundAttempt(requestId: string): Promise<void> {
    await this.deps.host.lockedOp({ op: 'refund', requestId });
  }

  async enterPostedAt(requestId: string): Promise<number | null> {
    const entry = this.live.get(requestId);
    if (!entry) return null;
    return (await this.read()).markers[entry.key]?.enterPendingAt ?? null;
  }

  async disable(): Promise<void> {
    await this.deps.host.lockedOp({ op: 'set-disabled', disabled: true });
    const next = { ...this.deps.settings(), enabled: false };
    this.deps.saveSettings(next);
    this.deps.raiseSecurity({ key: 'desktop-locked-disabled', title: 'Remote desktop through the lock was turned off',
      body: 'Any open locked-screen session was ended. The dashboard PIN turns it back on.' });
  }

  async isDisabled(): Promise<boolean> { return (await this.read()).disabled; }

  async applySettings(patch: Partial<DesktopLockedSettings>): Promise<DesktopLockedSettings> {
    const next = { ...this.deps.settings(), ...patch };
    if (patch.enabled === true) await this.deps.host.lockedOp({ op: 'set-disabled', disabled: false });
    this.deps.saveSettings(next);
    this.applyMode(this.lastOsMajor);
    return next;
  }

  /** A hint for honest pages. The target still refuses, and a hostile front
   * can draw a box anyway; that limit is stated in the spec. */
  browserBoxShown(): boolean {
    return this.deps.settings().browserBox && this.deps.tunnelFirstTierActive();
  }

  /** Null when the password path is ready, else a named reason. */
  passwordRefusal(probe: DesktopLockSample & { inputGrant?: string; helperSource?: string },
    client: 'app' | 'browser', state: DesktopLockState): string | null {
    if (!this.active(probe.osMajor)) return 'unsupported-macos';
    if (probe.helperSource !== 'retained') return 'retained-helper-required';
    if (probe.inputGrant !== 'own') return 'own-input-grant-required';
    if (client === 'browser') {
      if (!this.deps.settings().browserBox) return 'browser-box-off';
      if (!this.deps.tunnelFirstTierActive()) return 'tunnel-not-first-tier';
    }
    return state === 'locked-in-session' ? null : 'not-locked';
  }

  private startSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => { void this.sweep().catch(() => { console.warn('[instar] locked-screen sweep failed'); }); }, SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** Covers a watch whose request has already ended, so "tells you" holds. */
  async sweep(boot = false): Promise<void> {
    if (this.sweeping || !this.storeExists()) return;
    this.sweeping = true;
    // Started before the read, so a slow or failed read cannot end the watching.
    this.startSweep();
    try {
      const untold = await this.reportGuardFailures();
      const { markers } = await this.read();
      const { bootSession, loginSession } = await this.read();
      let open = untold;
      for (const [key, marker] of Object.entries(markers)) {
        if (marker.agentId !== this.deps.agentId) continue;
        const sameSession = !bootSession || (marker.bootSession === bootSession
          && (!loginSession || marker.loginSession === loginSession));
        if (BLOCKING.has(marker.state) && !sameSession) {
          await this.deps.host.lockedOp({ op: 'close', key, to: 'closed-not-applicable' });
          continue;
        }
        if (BLOCKING.has(marker.state)) {
          open = true;
          const requestId = marker.requestId ?? '';
          if (this.live.has(requestId)) this.renewLease(key);
          else if (boot && marker.state === 'owed') await this.deps.host.lockedOp({ op: 'relock-now', key });
          const age = this.heartbeatAgeMs(key);
          if (age === null || age > HEARTBEAT_STALE_MS) await this.replaceGuard(key, marker);
        } else if (marker.state === 'relock-failed' && !marker.reported) {
          open = true;
          if (boot && sameSession) await this.retryFailed(key, marker);
          const told = await this.deps.raiseSecurity({ key: `desktop-relock-failed:${key}`, title: 'A Mac may still be unlocked',
            body: 'Instar could not confirm the relock after a remote desktop session. Lock it, or open it to check.' });
          // Unconfirmed stays unreported, so the next sweep tries again.
          if (told) await this.deps.host.lockedOp({ op: 'mark-reported', key });
        }
      }
      if (open) this.startSweep();
      else if (this.live.size === 0) this.stop();
    } catch {
      // The guard locks by itself. What fails here is telling the owner, so say so.
      await this.deps.raiseSecurity({ key: 'desktop-locked-store-unreadable', title: 'A Mac may need checking',
        body: 'Instar could not read its relock record for this Mac. Lock it, or open it to check.' });
    } finally { this.sweeping = false; }
  }

  /** A guard that lost its store leaves a file, and has already tried to lock. */
  private async reportGuardFailures(): Promise<boolean> {
    let untold = false;
    for (const name of fs.readdirSync(this.root).filter(file => file.startsWith('failed-'))) {
      const told = await this.deps.raiseSecurity({ key: `desktop-relock-${name}`, title: 'A Mac may still be unlocked',
        body: 'Instar lost its relock record after a remote desktop session and tried to lock the Mac. Check it.' });
      if (told) SafeFsExecutor.safeRmSync(path.join(this.root, name), { force: true, operation: 'src/core/DesktopLockedController.ts:reportGuardFailures' });
      else untold = true;
    }
    return untold;
  }

  private async retryFailed(key: string, marker: DesktopRelockMarker): Promise<void> {
    const requestId = marker.requestId ?? key.split('.')[0];
    const generation = Number(key.split('.')[1] ?? 0) + 1;
    const next = `${requestId}.${generation}`;
    await this.deps.host.lockedOp({ op: 'marker-create', key: next, marker: {
      agentId: this.deps.agentId, requestId, deadlineMs: this.now(), resumeWindowMs: RESUME_WINDOW_MS } });
    await this.deps.host.lockedOp({ op: 'relock-now', key: next });
    await this.deps.host.startRelockGuard(next);
  }

  private async replaceGuard(key: string, marker: DesktopRelockMarker): Promise<void> {
    const count = marker.guardReplacements ?? 0;
    const guardGone = !marker.guardPid || !marker.guardStart
      || (await this.deps.host.lockedOp({ op: 'kill-recorded', pid: marker.guardPid, start: marker.guardStart })).gone === true;
    if (decideGuardReplacement(count) === 'give-up') {
      const typistGone = !marker.typistPid || !marker.typistStart
        || (await this.deps.host.lockedOp({ op: 'kill-recorded', pid: marker.typistPid, start: marker.typistStart })).gone === true;
      await this.deps.host.lockedOp({ op: 'close', key, to: 'relock-failed', producerGone: guardGone && typistGone });
      return;
    }
    if (!guardGone) return;
    await this.deps.host.lockedOp({ op: 'set-guard', key, pid: 0, start: '', replacements: count + 1 });
    await this.deps.host.startRelockGuard(key);
  }

  async status(osMajor: number | undefined): Promise<Record<string, unknown>> {
    const { markers, disabled, attempts } = await this.read();
    const settings = this.deps.settings();
    return { enabled: settings.enabled, active: this.active(osMajor), disabled,
      browserBox: settings.browserBox, chime: settings.chime,
      refusal: this.enableRefusal(osMajor), lockState: this.lastState,
      attemptsToday: attempts.count ?? 0, lastAdmissionRefusal: this.lastAdmissionRefusal,
      openDuties: Object.values(markers).filter(item => BLOCKING.has(item.state)).length,
      failedRelocks: Object.values(markers).filter(item => item.state === 'relock-failed').length };
  }
}

export { isLockedClass };
