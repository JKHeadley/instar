/**
 * PeerVisibilityGuard — P2.2 rider (WORKING-SET-HANDOFF-SPEC §3.6): improper
 * revocations and silently-missing peers must surface LOUDLY.
 *
 * Earned 2026-06-06: the Mini was revoked with NO `revokedBy`/`revokeReason`
 * (a write that bypassed `revokeMachine()`), making it invisible to the mesh
 * for ~10 hours while it held a topic's entire overnight working set.
 *
 * Two detections, both HYGIENE SIGNALS (they detect sloppy state, not
 * malicious action — populated fields are NOT authenticated and must never
 * be read as "this revocation is legitimate"):
 *
 * 1. `detectImproperRevocations(registry)` — a PURE helper (deliberately NOT
 *    inside `loadRegistry()`, a hot dependency-free read called 41+ times
 *    per boot): an entry with `revokedAt` set but `revokedBy`/`revokeReason`
 *    missing. The consumer surfaces findings via the agent-health attention
 *    lane, deduped ACROSS boots keyed on the entry's `revokedAt` (a
 *    crash-loop cannot re-spam it).
 *
 * 2. Peer-disappearance notice — pool transitions from N≥2 online to fewer
 *    and stays past a 30-min grace → ONE agent-health notice naming the
 *    machine + last known reason, and — when pending-pulls reference it —
 *    the stranded topic working sets. Coalesced per machine per episode;
 *    FLAP-BOUNDED: 3 episodes for one machine in 24h collapses to a single
 *    "machine X is flapping" notice (Bounded Notification Surface). Clears
 *    silently on stable re-peer.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { MachineRegistry, MachineRegistryEntry } from './types.js';

export const DEFAULT_DISAPPEARANCE_GRACE_MS = 30 * 60 * 1000;
export const FLAP_EPISODE_LIMIT = 3;
export const FLAP_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ImproperRevocation {
  machineId: string;
  nickname?: string;
  revokedAt: string;
  missing: ('revokedBy' | 'revokeReason')[];
}

/**
 * PURE: entries revoked without authorship/reason — the §3.6 hygiene signal.
 * Never inside loadRegistry(); the consumer (boot/refresh path) calls this.
 */
export function detectImproperRevocations(registry: MachineRegistry): ImproperRevocation[] {
  const out: ImproperRevocation[] = [];
  for (const [machineId, entry] of Object.entries(registry.machines ?? {})) {
    const e = entry as MachineRegistryEntry;
    if (!e.revokedAt) continue;
    const missing: ('revokedBy' | 'revokeReason')[] = [];
    if (!e.revokedBy) missing.push('revokedBy');
    if (!e.revokeReason) missing.push('revokeReason');
    if (missing.length) {
      out.push({
        machineId,
        ...(e.nickname ? { nickname: e.nickname } : {}),
        revokedAt: e.revokedAt,
        missing,
      });
    }
  }
  return out;
}

export interface GuardNotice {
  kind: 'improper-revocation' | 'peer-missing' | 'peer-flapping';
  machineId: string;
  title: string;
  body: string;
}

export interface PeerVisibilityGuardConfig {
  /** Absolute path to the agent's `.instar/` directory (durable dedupe state). */
  stateDir: string;
  selfMachineId: string;
  /** Surface one notice (agent-health attention lane upstream). Never throws back. */
  notify: (notice: GuardNotice) => void;
  /** Topics with pending-pulls naming a machine (the stranded working sets). */
  strandedTopicsFor?: (machineId: string) => Promise<number[]>;
  graceMs?: number;
  now?: () => Date;
  logger?: (msg: string) => void;
}

interface GuardStateShape {
  version: 1;
  /** revokedAt values already surfaced (cross-boot dedupe, §3.6.1). */
  surfacedRevocations: string[];
  /** machineId → episode-start ISO timestamps in the flap window. */
  episodes: Record<string, string[]>;
  /** machineId → true when a flap-collapse notice was already sent. */
  flapNotified: Record<string, boolean>;
}

interface MissingTracker {
  missingSinceMs: number;
  noticed: boolean;
}

export class PeerVisibilityGuard {
  private readonly d: PeerVisibilityGuardConfig;
  private readonly stateFile: string;
  private state: GuardStateShape | null = null;
  /** In-memory per-episode tracking (a notice fires once per episode). */
  private missing = new Map<string, MissingTracker>();

  constructor(config: PeerVisibilityGuardConfig) {
    this.d = config;
    this.stateFile = path.join(config.stateDir, 'state', 'coherence-journal', 'visibility-guard.json');
  }

  /**
   * §3.6.1 — call on boot + registry refresh with the loaded registry.
   * Surfaces each improper revocation ONCE across boots (keyed on revokedAt).
   */
  checkRevocations(registry: MachineRegistry): ImproperRevocation[] {
    const found = detectImproperRevocations(registry);
    const st = this.loadState();
    const fresh = found.filter((f) => !st.surfacedRevocations.includes(f.revokedAt));
    for (const f of fresh) {
      st.surfacedRevocations.push(f.revokedAt);
      this.safeNotify({
        kind: 'improper-revocation',
        machineId: f.machineId,
        title: `Machine ${f.nickname ?? f.machineId} was revoked without ${f.missing.join('/')}`,
        body:
          `${f.nickname ?? f.machineId} is marked revoked (at ${f.revokedAt}) but the revocation ` +
          `carries no ${f.missing.join(' or ')} — it did not go through revokeMachine(). ` +
          `HYGIENE SIGNAL ONLY: this detects a sloppy revocation, not a malicious one (and a ` +
          `populated field would not prove legitimacy either). If this machine should be in the ` +
          `pool, un-revoke it; its working sets are unreachable until then.`,
      });
    }
    if (fresh.length) this.persist(st);
    return found;
  }

  /**
   * §3.6.2 — call on a presence cadence with the CURRENT online view.
   * `expected` = machines that should be online (active, not revoked, not
   * self); `online` = machines recorded this pass.
   */
  async checkDisappearances(expected: string[], online: Set<string>): Promise<void> {
    const nowMs = (this.d.now?.() ?? new Date()).getTime();
    const grace = this.d.graceMs ?? DEFAULT_DISAPPEARANCE_GRACE_MS;
    const st = this.loadState();
    let dirty = false;

    for (const machineId of expected) {
      if (machineId === this.d.selfMachineId) continue;
      if (online.has(machineId)) {
        // Stable re-peer → episode closes SILENTLY (§3.6.2).
        if (this.missing.delete(machineId)) this.d.logger?.(`peer ${machineId} re-peered`);
        continue;
      }
      let tracker = this.missing.get(machineId);
      if (!tracker) {
        tracker = { missingSinceMs: nowMs, noticed: false };
        this.missing.set(machineId, tracker);
      }
      if (tracker.noticed || nowMs - tracker.missingSinceMs < grace) continue;

      // Episode confirmed past grace — flap accounting first.
      const episodes = (st.episodes[machineId] ?? []).filter(
        (iso) => nowMs - new Date(iso).getTime() < FLAP_WINDOW_MS,
      );
      episodes.push(new Date(nowMs).toISOString());
      st.episodes[machineId] = episodes;
      dirty = true;
      tracker.noticed = true;

      if (episodes.length > FLAP_EPISODE_LIMIT) {
        if (!st.flapNotified[machineId]) {
          st.flapNotified[machineId] = true;
          this.safeNotify({
            kind: 'peer-flapping',
            machineId,
            title: `Machine ${machineId} is flapping`,
            body:
              `${machineId} has dropped off the mesh ${episodes.length} times in 24h. ` +
              `Collapsing to this single notice — no further per-episode messages until ` +
              `it stabilizes (Bounded Notification Surface).`,
          });
        }
        continue;
      }
      // Flap-notified machines that stabilized under the limit get re-armed.
      if (st.flapNotified[machineId] && episodes.length <= FLAP_EPISODE_LIMIT) {
        delete st.flapNotified[machineId];
      }

      let stranded: number[] = [];
      try {
        stranded = (await this.d.strandedTopicsFor?.(machineId)) ?? [];
      } catch { /* @silent-fallback-ok: the stranded-topics enrichment is best-effort; the disappearance notice itself must still fire (WORKING-SET-HANDOFF-SPEC §3.6) */
      }
      const strandedLine = stranded.length
        ? ` Topic working set(s) stranded on it: ${stranded.join(', ')} — recover by bringing it back / un-revoking; the pending fetch re-fires automatically on its return.`
        : '';
      this.safeNotify({
        kind: 'peer-missing',
        machineId,
        title: `Machine ${machineId} has been unreachable for 30+ minutes`,
        body:
          `${machineId} should be in the pool but has not answered the presence pull past the ` +
          `grace window.${strandedLine}`,
      });
    }
    if (dirty) this.persist(st);
  }

  // ---- durable dedupe state -------------------------------------------------

  private loadState(): GuardStateShape {
    if (this.state) return this.state;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8')) as GuardStateShape;
      if (parsed?.version === 1) {
        this.state = {
          version: 1,
          surfacedRevocations: Array.isArray(parsed.surfacedRevocations) ? parsed.surfacedRevocations : [],
          episodes: parsed.episodes && typeof parsed.episodes === 'object' ? parsed.episodes : {},
          flapNotified: parsed.flapNotified && typeof parsed.flapNotified === 'object' ? parsed.flapNotified : {},
        };
        return this.state;
      }
    } catch { /* @silent-fallback-ok: absent/corrupt guard state only weakens notice dedupe (worst case one repeat notice) — never a failure (WORKING-SET-HANDOFF-SPEC §3.6) */
    }
    this.state = { version: 1, surfacedRevocations: [], episodes: {}, flapNotified: {} };
    return this.state;
  }

  private persist(st: GuardStateShape): void {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const tmp = `${this.stateFile}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
      fs.renameSync(tmp, this.stateFile);
    } catch (e) { /* @silent-fallback-ok: a failed dedupe persist risks one repeat notice after restart, never a lost detection (WORKING-SET-HANDOFF-SPEC §3.6) */
      this.d.logger?.(`guard state persist failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private safeNotify(notice: GuardNotice): void {
    try {
      this.d.notify(notice);
    } catch { /* @silent-fallback-ok: a notify-consumer failure must never break the guard's detection loop (WORKING-SET-HANDOFF-SPEC §3.6) */
    }
  }
}
