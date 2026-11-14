/**
 * TeamSwitches — the settings a team needs, turned on for the whole agent (docs/specs/team-switches-agent-wide.md).
 *
 * A team needs memory privacy and app conversations on every machine. Those are per-machine config
 * keys, so before this the People screen listed each machine that had one off, one line per machine.
 * The owner's one tap now reaches every machine: each peer is sent a machine-signed request that
 * turns the one named setting on there (never off, never any other key) and asks for its own
 * supervised restart. A peer that does not answer is kept in a small pending file and tried again
 * on the team exchange's minute tick, and every answer is reported per machine.
 */
import fs from 'node:fs';
import path from 'node:path';
import { TEAM_ENFORCEMENT_VERSION, type MachineStanding } from './TeamAccessSync.js';

/**
 * The settings the owner can turn on for the whole agent. `files` (files in app conversations,
 * `mobilePairing.native.media.enabled`) is not something a team needs, so it never gets a People
 * line; it is here so the app's "Files are turned off" notice can offer the same one-tap turn-on.
 */
export type TeamSwitchSetting = 'memory-privacy' | 'app-conversations' | 'files';
export const TEAM_SWITCH_SETTINGS: readonly TeamSwitchSetting[] = ['memory-privacy', 'app-conversations', 'files'];
export function isTeamSwitchSetting(v: unknown): v is TeamSwitchSetting {
  return typeof v === 'string' && (TEAM_SWITCH_SETTINGS as readonly string[]).includes(v);
}

/** One line on the People screen: one setting, the machines it is off on, one action. */
export interface TeamSwitchLine {
  setting: TeamSwitchSetting | 'build';
  /** Always false: only a setting that is off somewhere gets a line. */
  on: false;
  offOn: string[];
  action: 'turn-on-everywhere' | 'update';
  /** Of `offOn`, the machines already asked to turn it on and not yet seen with it on (restarting, or being retried). */
  requested: string[];
}

/**
 * The agent-level summary. A machine on an older build is listed only under `build`: what it says
 * about the other two settings cannot be trusted, and updating it comes first.
 */
export function teamSwitchSummary(machines: ReadonlyArray<{ machineId: string; standing: MachineStanding }>, requested: ReadonlyArray<{ setting: TeamSwitchSetting; machineId: string }> = []): TeamSwitchLine[] {
  const off: Record<TeamSwitchSetting | 'build', string[]> = { 'app-conversations': [], 'memory-privacy': [], files: [], build: [] };
  for (const m of machines) {
    if (m.standing.enforcement < TEAM_ENFORCEMENT_VERSION) { off.build.push(m.machineId); continue; }
    if (!m.standing.native) off['app-conversations'].push(m.machineId);
    if (!m.standing.privacy) off['memory-privacy'].push(m.machineId);
  }
  // A machine owed a request but with no standing heard yet (no address right now) is not dropped from the line.
  const heard = new Set(machines.map((m) => m.machineId));
  for (const r of requested) if (!heard.has(r.machineId) && !off[r.setting].includes(r.machineId)) off[r.setting].push(r.machineId);
  const lines: TeamSwitchLine[] = [];
  for (const setting of ['app-conversations', 'memory-privacy', 'build'] as const) {
    if (off[setting].length === 0) continue;
    const asked = setting === 'build' ? [] : off[setting].filter((id) => requested.some((r) => r.setting === setting && r.machineId === id));
    lines.push({ setting, on: false, offOn: off[setting], action: setting === 'build' ? 'update' : 'turn-on-everywhere', requested: asked });
  }
  return lines;
}

/** What one machine did with the request. */
export type SwitchOutcome = 'applied' | 'already-on' | 'unreachable' | 'needs-update' | 'refused' | 'failed';

export interface MachineSwitchResult {
  machineId: string;
  self: boolean;
  outcome: SwitchOutcome;
  /** The same word as `outcome`, under the name the app reads. */
  result: SwitchOutcome;
  /** This machine will restart by itself to use the setting. */
  restarting: boolean;
  /** Not yet applied; it is tried again on its own. */
  willRetry: boolean;
}

export interface TurnOnResult { setting: TeamSwitchSetting; machines: MachineSwitchResult[] }

/** What a machine reports after applying the setting to itself. */
export interface LocalApply { changed: boolean; restarting: boolean }

/** A peer with an older build: it has no route for this, so it needs updating first. */
export class PeerLacksSwitchRoute extends Error {}
/** A peer that answered no on purpose (an unknown setting, a refusal). Not retried. */
export class PeerRefusedSwitch extends Error {}

export interface SwitchPeer {
  machineId: string;
  /** `requestedBy` names who asked (the owner's device), for the peer's own log. */
  turnOn(setting: TeamSwitchSetting, requestedBy?: string | null): Promise<LocalApply>;
}

/** A peer that answered but failed to apply it (could not write its config or request its restart). Retried. */
export class PeerSwitchFailed extends Error {}

export interface PendingSwitch { setting: TeamSwitchSetting; machineId: string; firstAt: number; lastTriedAt: number; attempts: number; lastOutcome: SwitchOutcome }

/** A pending request stops being retried after this long. The People line still shows the machine as off. */
export const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const BACKOFF_BASE_MS = 60_000;
/** How long a machine that said it is restarting is shown as asked before its standing must say on. */
const AWAITING_MS = 60 * 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;

export interface TeamSwitchDeps {
  selfMachineId(): string | null;
  peers(): SwitchPeer[];
  /** Every other machine of the agent, dialable or not. One with no address right now is listed and owed the request. */
  knownMachines?(): string[];
  /** Set the setting on this machine and ask for its own restart when that is needed. */
  applyLocal(setting: TeamSwitchSetting): LocalApply | Promise<LocalApply>;
  /** Where unanswered requests are kept, so a restart of this machine does not forget them. */
  file?: string;
  /** Does this machine now report the setting on? A request it answers by itself is not sent again. */
  reportsOn?(setting: TeamSwitchSetting, machineId: string): boolean;
  now?(): number;
  reportError?(err: unknown): void;
}

const key = (setting: TeamSwitchSetting, machineId: string) => `${setting}|${machineId}`;

export class TeamSwitchApplier {
  private readonly pendingMap = new Map<string, PendingSwitch>();
  /** Machines that applied it and are restarting: shown as asked until their standing says on, or for an hour. */
  private readonly awaiting = new Map<string, { setting: TeamSwitchSetting; machineId: string; at: number }>();
  private retrying = false;

  constructor(private readonly deps: TeamSwitchDeps) {
    if (!deps.file) return;
    try {
      const saved = JSON.parse(fs.readFileSync(deps.file, 'utf8')) as PendingSwitch[];
      for (const p of Array.isArray(saved) ? saved : []) {
        if (isTeamSwitchSetting(p?.setting) && typeof p.machineId === 'string') this.pendingMap.set(key(p.setting, p.machineId), p);
      }
    } catch {
      // @silent-fallback-ok — none yet, or unreadable: the People line still shows every machine that is off, and the owner can tap again.
    }
  }

  private now(): number { return (this.deps.now ?? Date.now)(); }

  private save(): void {
    if (!this.deps.file) return;
    try {
      fs.mkdirSync(path.dirname(this.deps.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.deps.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...this.pendingMap.values()]), { mode: 0o600 });
      fs.renameSync(tmp, this.deps.file);
    } catch (err) { this.deps.reportError?.(err); } // @silent-fallback-ok — reported; held in memory and retried this run
  }

  /** Requests sent and not yet answered, for the People line. */
  pending(): PendingSwitch[] { return [...this.pendingMap.values()]; }

  /** Every machine already asked and not yet seen with the setting on: unanswered, or applied and restarting. */
  requested(): Array<{ setting: TeamSwitchSetting; machineId: string }> {
    const t = this.now();
    for (const [k, a] of this.awaiting) if (t - a.at > AWAITING_MS || this.deps.reportsOn?.(a.setting, a.machineId)) this.awaiting.delete(k);
    return [...this.pending().map((p) => ({ setting: p.setting, machineId: p.machineId })), ...[...this.awaiting.values()].map((a) => ({ setting: a.setting, machineId: a.machineId }))];
  }

  private markAwaiting(setting: TeamSwitchSetting, machineId: string, restarting: boolean): void {
    if (restarting) this.awaiting.set(key(setting, machineId), { setting, machineId, at: this.now() });
  }

  /** A machine now reports the setting on: nothing left to send it. */
  settle(setting: TeamSwitchSetting, machineId: string): void {
    if (this.pendingMap.delete(key(setting, machineId))) this.save();
  }

  private async tryPeer(peer: SwitchPeer, setting: TeamSwitchSetting, requestedBy: string | null): Promise<MachineSwitchResult> {
    const base = { machineId: peer.machineId, self: false };
    let outcome: SwitchOutcome;
    let restarting = false;
    try {
      const r = await peer.turnOn(setting, requestedBy);
      outcome = r.changed || r.restarting ? 'applied' : 'already-on';
      restarting = r.restarting;
      this.markAwaiting(setting, peer.machineId, restarting);
    } catch (err) {
      outcome = err instanceof PeerLacksSwitchRoute ? 'needs-update' : err instanceof PeerRefusedSwitch ? 'refused' : err instanceof PeerSwitchFailed ? 'failed' : 'unreachable';
      // @silent-fallback-ok — not silent: the outcome is in the answer and the pending file, and the error is reported.
      if (outcome === 'unreachable' || outcome === 'failed') this.deps.reportError?.(err);
    }
    const k = key(setting, peer.machineId);
    // An older build may update itself, an unreachable machine may wake, and a failed apply may succeed next time.
    const willRetry = outcome === 'unreachable' || outcome === 'needs-update' || outcome === 'failed';
    if (willRetry) {
      const held = this.pendingMap.get(k);
      const t = this.now();
      this.pendingMap.set(k, { setting, machineId: peer.machineId, firstAt: held?.firstAt ?? t, lastTriedAt: t, attempts: (held?.attempts ?? 0) + 1, lastOutcome: outcome });
    } else {
      this.pendingMap.delete(k);
    }
    return { ...base, outcome, result: outcome, restarting, willRetry };
  }

  /**
   * Turn one setting on for the whole agent. Peers first, this machine last, because this machine's
   * restart must not cut the requests short. A machine that has gone quiet is listed, never skipped.
   */
  async turnOn(setting: TeamSwitchSetting, requestedBy: string | null = null): Promise<TurnOnResult> {
    const peers = this.deps.peers();
    const machines = await Promise.all(peers.map((p) => this.tryPeer(p, setting, requestedBy)));
    // A machine this one knows of but cannot dial right now is still owed the request, and is listed.
    const self0 = this.deps.selfMachineId();
    const dialable = new Set(peers.map((p) => p.machineId));
    for (const id of new Set(this.deps.knownMachines?.() ?? [])) {
      if (id === self0 || dialable.has(id)) continue;
      const k = key(setting, id);
      if (this.deps.reportsOn?.(setting, id)) {
        this.pendingMap.delete(k);
        machines.push({ machineId: id, self: false, outcome: 'already-on', result: 'already-on', restarting: false, willRetry: false });
        continue;
      }
      const held = this.pendingMap.get(k);
      const t = this.now();
      this.pendingMap.set(k, { setting, machineId: id, firstAt: held?.firstAt ?? t, lastTriedAt: t, attempts: (held?.attempts ?? 0) + 1, lastOutcome: 'unreachable' });
      machines.push({ machineId: id, self: false, outcome: 'unreachable', result: 'unreachable', restarting: false, willRetry: true });
    }
    this.save();
    const self = this.deps.selfMachineId() ?? 'this-machine';
    try {
      const r = await this.deps.applyLocal(setting);
      const outcome: SwitchOutcome = r.changed || r.restarting ? 'applied' : 'already-on';
      this.markAwaiting(setting, self, r.restarting);
      machines.push({ machineId: self, self: true, outcome, result: outcome, restarting: r.restarting, willRetry: false });
    } catch (err) {
      // @silent-fallback-ok — not silent: reported, and the answer says this machine failed.
      this.deps.reportError?.(err);
      machines.push({ machineId: self, self: true, outcome: 'failed', result: 'failed', restarting: false, willRetry: false });
    }
    return { setting, machines };
  }

  /** Try each unanswered request again, with a growing wait between tries. Runs on the team exchange's tick. */
  async retryPending(): Promise<MachineSwitchResult[]> {
    if (this.retrying || this.pendingMap.size === 0) return [];
    this.retrying = true;
    try {
      const t = this.now();
      const peers = new Map(this.deps.peers().map((p) => [p.machineId, p]));
      const out: MachineSwitchResult[] = [];
      let changed = false;
      for (const p of [...this.pendingMap.values()]) {
        if (t - p.firstAt > PENDING_MAX_AGE_MS || this.deps.reportsOn?.(p.setting, p.machineId)) { this.pendingMap.delete(key(p.setting, p.machineId)); changed = true; continue; }
        const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, p.attempts - 1));
        if (t - p.lastTriedAt < wait) continue;
        const peer = peers.get(p.machineId);
        if (!peer) continue; // no address right now; kept until it has one
        out.push(await this.tryPeer(peer, p.setting, null));
        changed = true;
      }
      if (changed) this.save();
      return out;
    } finally {
      this.retrying = false;
    }
  }
}
