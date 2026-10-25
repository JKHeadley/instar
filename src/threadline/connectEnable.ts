/**
 * Connect-enable: switch this agent's agent network (Threadline relay) and
 * verified pairing on at its person's request, and make it take effect
 * without the person doing anything.
 *
 * Why a restart and not a hot start: the relay client, trust manager, invite
 * engine, listener manager and pipe spawner are all built once at boot
 * (ThreadlineBootstrap + server.ts) and handed to the routes as fixed
 * references. Starting them live would mean a second, parallel wiring path for
 * a dozen components. The server already has one supervised way to restart
 * itself (the `state/restart-requested.json` flag the auto-updater writes,
 * consumed by the lifeline supervisor or the ForegroundRestartWatcher), and a
 * server restart does not end the agent's tmux sessions, so the conversation
 * that asked simply waits and carries on. This module decides whether that
 * restart is needed, safe and allowed, and requests it through that path.
 *
 * Restart rules:
 *  - Never restart when pairing already works here (`ready`).
 *  - Never restart when a restart would not help: this machine is a quiet
 *    standby, or relay and pairing are already on but this machine holds no
 *    invite engine (another machine holds the relay).
 *  - Never write a second request while one is waiting.
 *  - One restart per cooldown: if this agent already restarted for this and is
 *    still not ready, say so instead of restarting again.
 *  - Never restart without a running lifeline: with nothing to bring the server
 *    back, a restart would take the asking conversation's server down for good.
 *  - Defer, like an update restart, while another session is actively working
 *    (the asking session is excluded: it is the one waiting). A deferred
 *    request is retried by the server itself for five minutes (as long as the
 *    agent waits before telling its person it could not), then dropped.
 *
 * Spec / review: upgrades/side-effects/threadline-enable-without-restart.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { processCommandLine, processStartMs } from '../core/processIdentity.js';

/** How long after a restart for this we refuse to ask for another one. */
export const CONNECT_ENABLE_RESTART_COOLDOWN_MS = 10 * 60_000;
/** How often a deferred request re-checks whether it may restart now. */
export const CONNECT_ENABLE_RETRY_MS = 30_000;
/**
 * How long a deferred request keeps retrying by itself. Matches how long the agent
 * waits for pairing before telling its person it could not switch it on, so the
 * server never restarts after the person has been told it would not.
 */
export const CONNECT_ENABLE_DEFER_MAX_MS = 5 * 60_000;
/** What the agent tells its person: supervisor poll (10s) plus a server boot. */
export const CONNECT_ENABLE_BACK_IN_SECONDS = 60;
/** Who the restart flag says asked for it. */
export const CONNECT_ENABLE_REQUESTED_BY = 'threadline-connect-enable';

export type ConnectEnableState =
  | 'ready'
  | 'restarting'
  | 'deferred'
  | 'unavailable-here'
  | 'not-ready-after-restart'
  | 'restart-unavailable'
  /** A deferred request waited CONNECT_ENABLE_DEFER_MAX_MS and stopped: config written, restart still pending. */
  | 'gave-up';

export interface ConnectEnableInputs {
  /** The pairing routes answer here right now (gate on AND an invite engine exists). */
  ready: boolean;
  /** The running process booted with the relay on. */
  bootRelayEnabled: boolean;
  /** The running process resolves the verified-pairing gate on. */
  bootPairingEnabled: boolean;
  /** This machine would own the relay after a restart (not a quiet standby). */
  ownsRelayAfterRestart: boolean;
  /** A restart request is already waiting to be picked up. */
  restartAlreadyPending: boolean;
  /** Our last restart request, if any. */
  lastRequest: ConnectEnableRequestRecord | null;
  /** This process's pid (a request made by this pid has not restarted yet). */
  pid: number;
  now: number;
  /** Sessions that would hold a restart right now, the asking session excluded. */
  blockers: string[];
  /** A lifeline is running that brings the server back after it exits. */
  supervised: boolean;
}

export interface ConnectEnableDecision {
  state: ConnectEnableState;
  /** Write relayEnabled + verifiedPairing.enabled = true to config. */
  writeConfig: boolean;
  /** Write the supervised-restart request now. */
  requestRestart: boolean;
  reason: string;
}

export interface ConnectEnableRequestRecord {
  requestedAt: string;
  /** pid of the process that wrote the request (the one that must restart). */
  pid: number;
}

/** Pure decision. No I/O; every input is passed in so the rules are testable. */
export function decideConnectEnable(i: ConnectEnableInputs): ConnectEnableDecision {
  if (i.ready) {
    return { state: 'ready', writeConfig: false, requestRestart: false, reason: 'pairing already works on this machine' };
  }
  if (!i.ownsRelayAfterRestart) {
    return {
      state: 'unavailable-here', writeConfig: false, requestRestart: false,
      reason: 'this machine is a standby (multiMachine.telegramPolling is false), so it would not run the relay after a restart; the machine that holds the relay has to do this',
    };
  }
  if (i.bootRelayEnabled && i.bootPairingEnabled) {
    // Both already on in the running process, yet no invite engine: a restart changes nothing.
    return {
      state: 'unavailable-here', writeConfig: false, requestRestart: false,
      reason: 'the relay and pairing are already on, but this machine does not hold the relay (another machine does) or its invite store could not be opened',
    };
  }
  const recent = i.lastRequest ? i.now - Date.parse(i.lastRequest.requestedAt) : Number.POSITIVE_INFINITY;
  if (i.restartAlreadyPending || (i.lastRequest && i.lastRequest.pid === i.pid && recent < CONNECT_ENABLE_RESTART_COOLDOWN_MS)) {
    return { state: 'restarting', writeConfig: true, requestRestart: false, reason: 'a restart is already on its way' };
  }
  if (i.lastRequest && recent < CONNECT_ENABLE_RESTART_COOLDOWN_MS) {
    // A process restarted for this (different pid) and pairing still does not work: do not loop.
    return {
      state: 'not-ready-after-restart', writeConfig: false, requestRestart: false,
      reason: 'the server already restarted for this and pairing is still not available; restarting again would not help',
    };
  }
  if (!i.supervised) {
    // Without a lifeline the server would consume the flag, shut down, and stay down,
    // taking the asking conversation's server with it. Config is written: the next
    // restart by any route applies it.
    return {
      state: 'restart-unavailable', writeConfig: true, requestRestart: false,
      reason: 'no lifeline is running to bring the server back after a restart, so it was not restarted; the change applies at the next restart',
    };
  }
  if (i.blockers.length > 0) {
    return {
      state: 'deferred', writeConfig: true, requestRestart: false,
      reason: `waiting for other work to settle (active sessions, or holds on in-flight work such as a pending pairing invite): ${i.blockers.join(', ')}`,
    };
  }
  return { state: 'restarting', writeConfig: true, requestRestart: true, reason: 'restarting the server so the change takes effect' };
}

/** One plain sentence the agent can say to its person for each state. */
export function sayToPerson(state: ConnectEnableState): string {
  switch (state) {
    case 'ready':
      return '';
    case 'restarting':
      return `I'm switching on my connection to other agents. I'll be back in about a minute, then I'll give you the invite.`;
    case 'deferred':
      return `I'm switching on my connection to other agents. I'm letting some work I'm doing elsewhere finish first, which can take a few minutes, then I'll give you the invite.`;
    case 'unavailable-here':
      return `My connection to other agents runs on another of my machines, so I'll make the invite from there.`;
    case 'not-ready-after-restart':
    case 'restart-unavailable':
    case 'gave-up':
      return `I couldn't switch on my connection to other agents by myself this time.`;
  }
}

/**
 * Set the two keys in `<stateDir>/config.json`, leaving everything else as it is.
 *
 * There is no shared config writer or lock to join: PATCH /config, PATCH /updates/config, the
 * Threadline MCP server and the CLI each do a plain read-modify-write. Inside this server
 * process no writer can interleave with this one (every step here is synchronous, one
 * event-loop turn). Another PROCESS can (the MCP server, the CLI, a session editing the file),
 * so this is a compare-and-swap: just before the rename it re-reads the file, and if it changed
 * since it was read, it starts again from the new content (up to 5 tries), so a concurrent
 * edit is never overwritten with stale content. What remains is the gap between that re-read
 * and the rename, which no unlocked writer here closes.
 */
export function writeConnectConfig(stateDir: string, hooks: { beforeCommit?: () => void } = {}): void {
  const configPath = path.join(stateDir, 'config.json');
  const readText = (): string | null => (fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : null);
  for (let attempt = 0; attempt < 5; attempt++) {
    const before = readText();
    const raw = before !== null ? JSON.parse(before) as Record<string, unknown> : {};
    const tl = (raw.threadline && typeof raw.threadline === 'object' ? raw.threadline : {}) as Record<string, unknown>;
    const vp = (tl.verifiedPairing && typeof tl.verifiedPairing === 'object' ? tl.verifiedPairing : {}) as Record<string, unknown>;
    if (tl.relayEnabled === true && vp.enabled === true) return;
    tl.relayEnabled = true;
    vp.enabled = true;
    tl.verifiedPairing = vp;
    raw.threadline = tl;
    // config.json holds the auth token and is written 0600 at init: keep its mode.
    let mode = 0o600;
    try { mode = fs.statSync(configPath).mode & 0o777; } catch { /* @silent-fallback-ok — new file: 0600 */ }
    const tmp = `${configPath}.${process.pid}.connect.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(raw, null, 2), { mode });
      fs.chmodSync(tmp, mode); // writeFileSync's mode is masked by the umask
      hooks.beforeCommit?.();
      if (readText() !== before) {
        // Someone else wrote config.json since we read it: redo from their content.
        SafeFsExecutor.safeUnlinkSync(tmp, { operation: 'src/threadline/connectEnable.ts:config-cas-retry' });
        console.warn('[connect-enable] config.json changed while being updated; re-reading');
        continue;
      }
      fs.renameSync(tmp, configPath);
      return;
    } catch (err) {
      try { SafeFsExecutor.safeUnlinkSync(tmp, { operation: 'src/threadline/connectEnable.ts:config-tmp-cleanup' }); } catch { /* @silent-fallback-ok — nothing to clean */ }
      throw err;
    }
  }
  throw new Error('config.json kept changing while it was being updated; not written');
}

/** True when a command line is an Instar lifeline (`… instar … lifeline start …`). */
export function isInstarLifelineCommand(command: string | null): boolean {
  if (!command) return false;
  return /\blifeline\s+start\b/.test(command) && /instar/i.test(command);
}

/**
 * A lifeline holds this agent's lock, and the process at the lock's pid really is THAT
 * lifeline:
 *  - its command line (`ps -p <pid> -o command=`) is an Instar lifeline, and
 *  - its start time equals the `procStart` the lifeline recorded in the lock
 *    (`processStartMs`, 1 s resolution), so a pid since reused by a different process,
 *    including ANOTHER agent's lifeline (whose command line would also match), is refused.
 * A missing lock, a dead pid, a lock without a numeric `procStart` (legacy, or ps failed when
 * it was written), an unreadable start time or command line all fail CLOSED: no restart,
 * because nothing proven would bring the server back.
 */
export function lifelineRunning(
  stateDir: string,
  commandOf: (pid: number) => string | null = processCommandLine,
  startOf: (pid: number) => number | null = processStartMs,
): boolean {
  let lock: { pid?: unknown; procStart?: unknown };
  try {
    lock = JSON.parse(fs.readFileSync(path.join(stateDir, 'lifeline.lock'), 'utf-8')) as { pid?: unknown; procStart?: unknown };
  } catch {
    return false; // @silent-fallback-ok — no readable lock means no lifeline
  }
  const pid = lock?.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  if (typeof lock.procStart !== 'number' || !Number.isFinite(lock.procStart)) return false;
  const liveStart = startOf(pid);
  if (liveStart === null || liveStart !== lock.procStart) return false;
  return isInstarLifelineCommand(commandOf(pid));
}

const flagPathFor = (stateDir: string) => path.join(stateDir, 'state', 'restart-requested.json');
const recordPathFor = (stateDir: string) => path.join(stateDir, 'state', 'threadline-connect-enable.json');
const statusPathFor = (stateDir: string) => path.join(stateDir, 'state', 'threadline-connect-enable-status.json');

/** The last outcome the server reached by itself (a give-up), readable by GET /threadline/pairing/enable. */
export interface ConnectEnableStatus {
  state: ConnectEnableState;
  at: string;
  reason: string;
  configWritten: boolean;
  restartPending: boolean;
}

export function readConnectEnableStatus(stateDir: string): ConnectEnableStatus | null {
  try {
    return JSON.parse(fs.readFileSync(statusPathFor(stateDir), 'utf-8')) as ConnectEnableStatus;
  } catch {
    return null; // @silent-fallback-ok — nothing recorded
  }
}

function writeConnectEnableStatus(stateDir: string, status: ConnectEnableStatus): void {
  try {
    fs.mkdirSync(path.dirname(statusPathFor(stateDir)), { recursive: true });
    fs.writeFileSync(statusPathFor(stateDir), JSON.stringify(status, null, 2));
  } catch (err) {
    console.error(`[connect-enable] could not record status: ${String(err)}`);
  }
}

/** A restart request (from anyone) is waiting and has not expired. */
export function restartRequestPending(stateDir: string, now = Date.now()): boolean {
  try {
    const data = JSON.parse(fs.readFileSync(flagPathFor(stateDir), 'utf-8')) as { expiresAt?: string };
    return !data.expiresAt || Date.parse(data.expiresAt) > now;
  } catch {
    return false; // @silent-fallback-ok — no readable flag means nothing is pending
  }
}

export function readConnectEnableRecord(stateDir: string): ConnectEnableRequestRecord | null {
  try {
    const r = JSON.parse(fs.readFileSync(recordPathFor(stateDir), 'utf-8')) as ConnectEnableRequestRecord;
    return typeof r.requestedAt === 'string' && typeof r.pid === 'number' ? r : null;
  } catch {
    return null; // @silent-fallback-ok — no record means no earlier request
  }
}

/**
 * Write the supervised-restart request: the same flag and shape the auto-updater
 * and the money-layer surface use, with NO targetVersion (a targetVersion makes
 * the supervisor treat it as an update and restart the lifeline too).
 *
 * A supervisor from before this release counts restarts per targetVersion and
 * skips the third with the same one; with no version, every config restart
 * shares one count that never resets. A count file with no targetVersion is
 * therefore not an update loop, and it is removed so this restart is not
 * silently skipped. Returns false when the request could not be written.
 */
export function writeConnectRestartRequest(stateDir: string, now = Date.now(), pid = process.pid): boolean {
  try {
    const dir = path.join(stateDir, 'state');
    fs.mkdirSync(dir, { recursive: true });
    const countFile = path.join(dir, 'restart-version-count.json');
    try {
      const c = JSON.parse(fs.readFileSync(countFile, 'utf-8')) as { targetVersion?: string };
      if (!c.targetVersion) SafeFsExecutor.safeUnlinkSync(countFile, { operation: 'src/threadline/connectEnable.ts:unversioned-restart-count' });
    } catch { /* @silent-fallback-ok — no count file, nothing to clear */ }
    const flag = {
      requestedAt: new Date(now).toISOString(),
      requestedBy: CONNECT_ENABLE_REQUESTED_BY,
      reason: 'agent network and pairing switched on at the operator\'s request',
      plannedRestart: true,
      expiresAt: new Date(now + 60 * 60_000).toISOString(),
      pid,
    };
    const flagPath = flagPathFor(stateDir);
    const tmp = `${flagPath}.${pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(flag, null, 2));
    fs.renameSync(tmp, flagPath);
    // The restart is queued from here on, so report it as queued even if the cooldown
    // record cannot be written (the only cost is a missing cooldown, logged).
    try {
      const record: ConnectEnableRequestRecord = { requestedAt: flag.requestedAt, pid };
      fs.writeFileSync(recordPathFor(stateDir), JSON.stringify(record));
    } catch (err) {
      console.error(`[connect-enable] restart requested, but its cooldown record could not be written: ${String(err)}`);
    }
    return true;
  } catch (err) {
    console.error(`[connect-enable] restart request could not be written: ${String(err)}`);
    return false;
  }
}

export interface ConnectEnableControllerDeps {
  stateDir: string;
  isReady: () => boolean;
  bootRelayEnabled: () => boolean;
  bootPairingEnabled: () => boolean;
  ownsRelayAfterRestart: () => boolean;
  /** Active sessions that would hold a restart, minus the named asker(s). */
  blockers: (excludeSessionNames: string[]) => string[];
  /** A lifeline is running to bring the server back (default: lifelineRunning(stateDir)). */
  supervised?: () => boolean;
  now?: () => number;
  pid?: number;
  retryMs?: number;
}

export interface ConnectEnableResult extends ConnectEnableDecision {
  sayToPerson: string;
  backInSeconds?: number;
  blockingSessions?: string[];
}

/**
 * Holds the one deferred request (if any) and retries it. In memory only: any
 * restart, for whatever reason, already applies the config, so a deferred
 * request does not need to survive one.
 */
/* @self-action-controller: threadline-connect-enable-restart */
export class ConnectEnableController {
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private deferredExclude: string[] = [];
  private deferredSince = 0;

  constructor(private readonly d: ConnectEnableControllerDeps) {}

  private inputs(exclude: string[]): ConnectEnableInputs {
    const now = this.d.now?.() ?? Date.now();
    return {
      ready: this.d.isReady(),
      bootRelayEnabled: this.d.bootRelayEnabled(),
      bootPairingEnabled: this.d.bootPairingEnabled(),
      ownsRelayAfterRestart: this.d.ownsRelayAfterRestart(),
      restartAlreadyPending: restartRequestPending(this.d.stateDir, now),
      lastRequest: readConnectEnableRecord(this.d.stateDir),
      pid: this.d.pid ?? process.pid,
      now,
      blockers: this.d.blockers(exclude),
      supervised: this.d.supervised ? this.d.supervised() : lifelineRunning(this.d.stateDir),
    };
  }

  /** Handle a request. `excludeSessionNames` is the asking session (it is the one waiting). */
  request(excludeSessionNames: string[]): ConnectEnableResult {
    const i = this.inputs(excludeSessionNames);
    if (!this.retryTimer) {
      // A fresh request (not a retry tick) supersedes an earlier give-up.
      try { SafeFsExecutor.safeUnlinkSync(statusPathFor(this.d.stateDir), { operation: 'src/threadline/connectEnable.ts:status-clear' }); } catch { /* @silent-fallback-ok — none */ }
    }
    const decision = decideConnectEnable(i);
    if (decision.writeConfig) writeConnectConfig(this.d.stateDir);
    let state = decision.state;
    let reason = decision.reason;
    if (decision.requestRestart && !writeConnectRestartRequest(this.d.stateDir, i.now, i.pid)) {
      state = 'restart-unavailable';
      reason = 'the restart request could not be written';
    }
    if (state === 'deferred') this.armRetry(excludeSessionNames);
    else this.disarm();
    return {
      ...decision,
      state,
      reason,
      sayToPerson: sayToPerson(state),
      ...(state === 'restarting' || state === 'deferred' ? { backInSeconds: CONNECT_ENABLE_BACK_IN_SECONDS } : {}),
      ...(state === 'deferred' ? { blockingSessions: i.blockers } : {}),
    };
  }

  /** One retry tick (exposed for tests). Returns the state it reached. */
  retryTick(): ConnectEnableState {
    const now = this.d.now?.() ?? Date.now();
    if (now - this.deferredSince > CONNECT_ENABLE_DEFER_MAX_MS) {
      // The agent has told its person by now that it could not switch this on; never
      // restart after that. The config stays written, so the next restart (an update, or
      // the agent asking again) applies it.
      const blockers = this.d.blockers(this.deferredExclude);
      const reason = `waited ${Math.round(CONNECT_ENABLE_DEFER_MAX_MS / 60_000)} minutes and ${blockers.length ? `still held by: ${blockers.join(', ')}` : 'gave up'}; config is written, the restart is still pending and applies at the next restart`;
      console.log(`[connect-enable] gave-up: ${reason}`);
      writeConnectEnableStatus(this.d.stateDir, { state: 'gave-up', at: new Date(now).toISOString(), reason, configWritten: true, restartPending: true });
      this.disarm();
      return 'gave-up';
    }
    return this.request(this.deferredExclude).state; // request() disarms on any non-deferred answer
  }

  /** What a caller polling GET /threadline/pairing/enable sees. */
  status(): { deferred: boolean; deferredSince: string | null; last: ConnectEnableStatus | null } {
    return {
      deferred: this.retryTimer !== null,
      deferredSince: this.retryTimer ? new Date(this.deferredSince).toISOString() : null,
      last: readConnectEnableStatus(this.d.stateDir),
    };
  }

  isDeferred(): boolean {
    return this.retryTimer !== null;
  }

  private armRetry(exclude: string[]): void {
    this.deferredExclude = exclude;
    if (this.retryTimer) return;
    this.deferredSince = this.d.now?.() ?? Date.now();
    this.retryTimer = setInterval(() => {
      try { this.retryTick(); } catch (err) { console.error(`[connect-enable] retry failed: ${String(err)}`); }
    }, this.d.retryMs ?? CONNECT_ENABLE_RETRY_MS);
    this.retryTimer.unref?.();
  }

  disarm(): void {
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = null;
  }
}
