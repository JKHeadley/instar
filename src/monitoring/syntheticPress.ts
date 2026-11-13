/* @self-action-controller: context-budget-synthetic-press */
/**
 * Synthetic press targets (context-budget-layered-summaries §9.1: "The
 * synthetic press is a gated sentinel action on **throwaway sessions only**,
 * never on a live operator topic"; §7.8).
 *
 * A throwaway press target is a session nobody is talking to: its name carries
 * the reserved prefix `cb-press-` (it was started for this purpose), it is bound
 * to NO channel (no Telegram topic, no Slack channel, and the Telegram adapter
 * maps no topic to its tmux session), it is not a job, it runs Claude Code with
 * a known engine session (the canary needs its transcript), and it is not
 * protected. Every other session is refused, with the reason, before the press.
 */

import path from 'node:path';
import { SelfHealGate, SqliteSelfHealEpisodeStore, type SelfHealEpisodeStore, type SelfHealGateDeps, type SelfHealRemediationResult, type SelfHealSpec } from '../core/SelfHealGate.js';
import type { CompactionCanary } from './compactionCanary.js';

export const PRESS_TARGET_PREFIX = 'cb-press-';
export const SYNTHETIC_PRESS_ID = 'context-budget-synthetic-press';
/** At most this many presses per machine per day, at least this far apart (the gate's attempts and backoff). */
export const PRESS_MAX_PER_DAY = 3;
export const PRESS_MIN_INTERVAL_MS = 60 * 60_000;

export interface PressCandidate {
  id: string;
  name: string;
  tmuxSession: string;
  framework?: string;
  telegramTopicId?: number;
  slackChannelId?: string;
  jobSlug?: string;
  claudeSessionId?: string;
}

export type PressRefusal = 'not-throwaway' | 'channel-bound' | 'job-session' | 'not-claude-code' | 'no-engine-session' | 'protected';

export interface PressTargetChecks {
  /** A channel the live adapters map to this tmux session (Telegram topic, Slack channel…), if any. */
  channelFor?(tmuxSession: string): unknown;
  isProtected?(tmuxSession: string): boolean;
}

/** Null when the session may be pressed; otherwise why it may not. Channel binding is checked FIRST of the binding checks. */
export function pressTargetRefusal(s: PressCandidate, c: PressTargetChecks = {}): PressRefusal | null {
  if (typeof s.telegramTopicId === 'number' || (typeof s.slackChannelId === 'string' && s.slackChannelId !== '')) return 'channel-bound';
  let mapped: unknown = null;
  try { mapped = c.channelFor?.(s.tmuxSession) ?? null; } catch { mapped = 'unknown'; } // @silent-fallback-ok — an adapter that cannot answer is treated as bound (refuse)
  if (mapped !== null && mapped !== undefined && mapped !== '' && mapped !== 0) return 'channel-bound';
  if (!s.name.startsWith(PRESS_TARGET_PREFIX)) return 'not-throwaway';
  if (s.jobSlug) return 'job-session';
  if (s.framework !== undefined && s.framework !== 'claude-code') return 'not-claude-code';
  if (!s.claudeSessionId) return 'no-engine-session';
  let prot = true;
  try { prot = c.isProtected?.(s.tmuxSession) ?? false; } catch { prot = true; } // @silent-fallback-ok — unknown protection refuses
  if (prot) return 'protected';
  return null;
}

/** The key a press target's artifacts (PostCompact records) are filed under: one safe path segment, never a topic number. */
export function pressTopicKey(instarSessionId: string): string | null {
  const k = `press-${instarSessionId}`;
  return /^[A-Za-z0-9_-]{1,128}$/.test(k) ? k : null;
}

export interface SyntheticPressDeps {
  stateDir: string;
  machineId: string;
  canary: CompactionCanary;
  /** Compaction recovery switched on (§9.1: a press is the recovery path's positive control; off ⇒ nothing to verify). */
  switchOn(): boolean;
  /** The running sessions on this machine (the press picks only a throwaway target among them). */
  candidates(): PressCandidate[];
  checks: PressTargetChecks;
  /** Not actively working AND the pane shows a ready prompt. */
  isIdle(tmuxSession: string): boolean;
  /** Press `/compact` through the adapter's control-command path (SessionManager.injectInternalControlCommand). */
  press(tmuxSession: string): boolean;
  admit: SelfHealGateDeps['admit'];
  consumeToken: SelfHealGateDeps['consumeToken'];
  episodeStore?: SelfHealEpisodeStore;
  audit?: (e: { event: string; reason?: string }) => void;
  now?: () => number;
  bootId?: string;
}

type PressCtx = { day: string; target: PressCandidate };
export type PressTickOutcome = 'off' | 'not-needed' | 'pending' | 'no-target' | 'pressed' | 'refused' | 'bounded' | 'failed';

/**
 * The canary's positive control (§9.1): a server-pressed compaction on a
 * THROWAWAY session, recorded through `CompactionCanary.recordSyntheticPress`
 * before the press, so the boundary that follows counts as a synthetic
 * positive and the canary can reach `healthy`. It presses only while the
 * current verification epoch has no complete synthetic positive for this
 * machine and no press is still waiting for its boundary. Bounded through the
 * SelfHealGate (its own store): one episode per machine per day, at most
 * `PRESS_MAX_PER_DAY` presses, `PRESS_MIN_INTERVAL_MS` apart.
 */
export class SyntheticPress {
  private readonly now: () => number;
  private readonly gate: SelfHealGate<PressCtx>;
  private last: { at: number; outcome: PressTickOutcome; detail?: string } | null = null;

  constructor(private readonly d: SyntheticPressDeps) {
    this.now = d.now ?? Date.now;
    const store = d.episodeStore ?? new SqliteSelfHealEpisodeStore(path.join(d.stateDir, 'state', 'context-budget', 'synthetic-press-episodes.db'));
    const slug = (d.machineId.toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^[^a-z0-9]+/, '') || 'm').slice(0, 40);
    const spec: SelfHealSpec<PressCtx> = {
      id: SYNTHETIC_PRESS_ID, controllerResource: 'hardware-bound', episodeAuthority: 'durable-machine-local', classId: 'context-budget-synthetic-press',
      severity: () => 'recoverable',
      dedupeKey: (c) => `${slug}.press.${c.day}`,
      eligible: (c) => (pressTargetRefusal(c.target, d.checks) === null ? { eligible: true, fence: `${c.day}:${c.target.tmuxSession}` } : { eligible: false, fence: null }),
      remediationMode: 'async',
      remediationAsync: async (c) => this.pressOnce(c),
      maxRemediationMs: 30_000,
      maxAttempts: PRESS_MAX_PER_DAY,
      maxWallClockMs: 24 * 60 * 60_000,
      backoffMs: () => PRESS_MIN_INTERVAL_MS,
      // A day of presses is one episode; nothing about it is an operator matter.
      notificationLatencyCeilingMs: 24 * 60 * 60_000,
      flap: { maxRecoveries: PRESS_MAX_PER_DAY, windowMs: 24 * 60 * 60_000 },
      remediationActions: { operation: 'press-synthetic-compaction', idempotencyGuard: 'one episode per machine per day; a press still awaiting its boundary blocks another', compensation: 'none needed: a press on a throwaway session changes only that session' },
    };
    this.gate = new SelfHealGate(spec, {
      admit: d.admit, consumeToken: d.consumeToken, episodeStore: store, now: this.now, bootId: d.bootId,
      // Reaching the daily press bound is recorded, never paged.
      notify: (n) => { d.audit?.({ event: 'press-bound', reason: n.reason }); },
      audit: (e) => d.audit?.({ event: `press-gate:${e.event}`, ...(e.reason ? { reason: e.reason } : {}) }),
    });
  }

  private async pressOnce(c: PressCtx): Promise<SelfHealRemediationResult> {
    // Re-checked at action time: never on a channel-bound or live operator session.
    const refusal = pressTargetRefusal(c.target, this.d.checks);
    if (refusal) { this.d.audit?.({ event: 'press-refused', reason: `${c.target.tmuxSession}: ${refusal}` }); return { outcome: 'not-healed', evidence: 'fence-stale' }; }
    if (!this.d.isIdle(c.target.tmuxSession)) return { outcome: 'not-healed', evidence: 'fence-stale' };
    // Recorded BEFORE the press: the boundary it produces must find it (a press with no boundary is recorded only).
    this.d.canary.recordSyntheticPress(c.target.claudeSessionId as string);
    const ok = this.d.press(c.target.tmuxSession);
    this.d.audit?.({ event: ok ? 'press-sent' : 'press-failed', reason: c.target.tmuxSession });
    // Not "healed": a press is verified by the canary, and the gate's attempts and backoff are the press budget.
    return { outcome: 'not-healed', evidence: ok ? 'verification-failed' : 'io-error' };
  }

  async tick(): Promise<PressTickOutcome> {
    const out = await this.tickInner();
    this.last = { at: this.now(), outcome: out };
    return out;
  }

  private async tickInner(): Promise<PressTickOutcome> {
    let on = false;
    try { on = this.d.switchOn(); } catch { on = false; } // @silent-fallback-ok — an unreadable switch presses nothing
    if (!on) return 'off';
    const rep = this.d.canary.report(true);
    if (rep.groups.some((g) => g.machine === this.d.machineId && g.engine === 'claude-code' && g.synthetic >= 1)) return 'not-needed';
    if (this.d.canary.pressPending()) return 'pending';
    const target = this.d.candidates().find((s) => pressTargetRefusal(s, this.d.checks) === null && this.d.isIdle(s.tmuxSession));
    if (!target) return 'no-target';
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const res = await this.gate.attempt({ day, target });
    if (res.outcome === 'attempted' && res.reason === 'verification-failed') return 'pressed';
    if (res.outcome === 'attempted' && res.reason === 'io-error') return 'failed';
    if (res.outcome === 'attempted') return 'refused';
    if (res.outcome === 'state-failure') throw new Error(`press episode store: ${res.reason}`);
    return 'bounded'; // backoff, exhausted for the day, governed
  }

  prune(): void { this.gate.pruneTerminal(); }

  status(): { last: { at: number; outcome: PressTickOutcome } | null } { return { last: this.last }; }
}
