/**
 * CollaborationRedriveEngine — proactively re-engage a COUNTERPART that has
 * gone silent on an unfinished cross-agent objective.
 *
 * Spec: docs/specs/collaboration-redrive-on-counterpart-silence.md (v3,
 * Justin-approved 2026-05-28). Fills the verified residual gap in the shipped
 * Threadline Conversation Keystone: loop-safety + continuity + done-detection
 * exist, but everything is inbound-reactive or operator-facing — nothing
 * proactively pokes the counterpart when they go silent. This engine sends a
 * bounded number of follow-up nudges, then escalates to the operator and
 * STOPS.
 *
 * Termination guarantee (load-bearing, the round-1 adversarial fix):
 *  - `redriveCount` is a DURABLE, MONOTONIC, REPLY-INDEPENDENT per-commitment
 *    counter on the Commitment record. A counterpart reply updates
 *    `lastReplyAt` (silence clock) but NEVER touches `redriveCount`. So even
 *    when two agents both run this engine pointed at each other, each side
 *    fires ≤ maxRedrives nudges on a given objective and then is permanently
 *    re-drive-ineligible. Multi-objective amplification is capped by the
 *    per-peer 24h cap and the engine-wide daily fuse.
 *  - The novelty guard is a DECORATIVE tiebreaker, not a bound. The durable
 *    cap is the only termination guarantee.
 *
 * The engine runs its OWN low-frequency sweep — it does NOT piggyback the
 * PromiseBeacon tick (the beacon only schedules `beaconEnabled && pending`
 * commitments, and most threadline-reply commitments are not beacon-enabled).
 *
 * Ships OFF by default (`monitoring.collaborationRedrive.enabled: false`).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { CommitmentTracker, Commitment } from './CommitmentTracker.js';
import type { CompletionEvaluator } from '../core/CompletionEvaluator.js';
import type { ThreadlineClient } from '../threadline/client/ThreadlineClient.js';
import type { CollaborationSurfacer } from '../threadline/CollaborationSurfacer.js';

// ── Public types ──────────────────────────────────────────────

export interface CollaborationRedriveConfig {
  enabled: boolean;
  sweepIntervalMs: number;
  silenceThresholdMs: number;
  maxRedrives: number;
  perPeerDailyCap: number;
  maxRedriveSendsPerDay: number;
  maxRedrivesPerTick: number;
  trustFloor: string;
  dedupeJaccard: number;
  /**
   * Dogfood fix (2026-05-28): an unresolvable peer name is a STABLE condition
   * (the name is missing from known-agents.json — it doesn't fix itself on
   * the next sweep). Without a cooldown, the engine escalated to the
   * Attention queue every few sweeps for every such peer → notification
   * flood on Echo, observed live. After this many ms since the last
   * unreachable-peer escalation for a given peer, the engine may escalate
   * again. Default 24h. Cooldown is durable (persisted to disk), so it
   * survives restart.
   */
  unreachableEscalationCooldownMs: number;
}

export const DEFAULT_REDRIVE_CONFIG: CollaborationRedriveConfig = {
  enabled: false,
  sweepIntervalMs: 5 * 60 * 1000,
  silenceThresholdMs: 45 * 60 * 1000,
  maxRedrives: 2,
  perPeerDailyCap: 3,
  maxRedriveSendsPerDay: 10,
  maxRedrivesPerTick: 1,
  trustFloor: 'verified',
  dedupeJaccard: 0.7,
  unreachableEscalationCooldownMs: 24 * 60 * 60 * 1000,
};

export interface CollaborationRedriveDeps {
  commitmentTracker: CommitmentTracker;
  completionEvaluator: CompletionEvaluator;
  relayClient?: ThreadlineClient;
  surfacer?: CollaborationSurfacer;
  raiseAttention?: (item: { title: string; body: string; priority?: 'low' | 'medium' | 'high'; source?: string }) => Promise<unknown>;
  knownAgentsPath: string;
  /**
   * Where to persist the per-peer "last unreachable escalation" timestamp
   * log (dogfood fix). Defaults next to `knownAgentsPath` if not set.
   */
  escalationLogPath?: string;
  now?: () => number;
  log?: { log: (m: string) => void; warn: (m: string) => void };
}

export interface TickResult {
  sent: number;
  skipped: Record<string, string>;
  dailyCountBefore: number;
  disabled: boolean;
}

// ── Implementation ────────────────────────────────────────────

const TERMINAL_STATUSES = new Set(['delivered', 'expired', 'withdrawn']);
const DAY_MS = 24 * 60 * 60 * 1000;

export class CollaborationRedriveEngine {
  private readonly cfg: CollaborationRedriveConfig;
  private readonly deps: CollaborationRedriveDeps;
  private readonly now: () => number;
  private readonly log: { log: (m: string) => void; warn: (m: string) => void };
  private sweepTimer: NodeJS.Timeout | null = null;
  /** Resolved path to the durable per-peer unreachable-escalation log. */
  private readonly escalationLogPath: string;
  /** In-memory cache of the on-disk escalation log; lazy-loaded. */
  private escalationLogCache: Record<string, string> | null = null;

  constructor(deps: CollaborationRedriveDeps, cfg: Partial<CollaborationRedriveConfig> = {}) {
    this.cfg = { ...DEFAULT_REDRIVE_CONFIG, ...cfg };
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? {
      log: (m) => console.log(`[CollabRedrive] ${m}`),
      warn: (m) => console.warn(`[CollabRedrive] ${m}`),
    };
    // Default the escalation log next to known-agents.json (already a
    // per-agent path under .instar/threadline) unless the caller overrides.
    this.escalationLogPath = deps.escalationLogPath
      ?? path.join(path.dirname(deps.knownAgentsPath), 'collab-redrive-escalation-log.json');
  }

  /**
   * Has it been at least `unreachableEscalationCooldownMs` since we last
   * escalated "can't reach <peer>" for this peer? Reads from the durable
   * log; if the cooldown has elapsed (or there's no record), the engine
   * may escalate again. Persistent across restart by design.
   */
  private shouldEscalateUnreachable(peer: string, nowMs: number): boolean {
    const log = this.loadEscalationLog();
    const lastIso = log[peer];
    if (!lastIso) return true;
    const lastMs = Date.parse(lastIso);
    if (!Number.isFinite(lastMs)) return true;
    return (nowMs - lastMs) >= this.cfg.unreachableEscalationCooldownMs;
  }

  private recordUnreachableEscalation(peer: string, nowMs: number): void {
    const log = this.loadEscalationLog();
    log[peer] = new Date(nowMs).toISOString();
    try {
      fs.mkdirSync(path.dirname(this.escalationLogPath), { recursive: true });
      fs.writeFileSync(this.escalationLogPath, JSON.stringify(log, null, 2));
    } catch (err) {
      this.log.warn(`failed to persist escalation log: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private loadEscalationLog(): Record<string, string> {
    if (this.escalationLogCache !== null) return this.escalationLogCache;
    try {
      const raw = fs.readFileSync(this.escalationLogPath, 'utf-8');
      const parsed = JSON.parse(raw);
      this.escalationLogCache = (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        ? (parsed as Record<string, string>)
        : {};
    } catch {
      this.escalationLogCache = {};
    }
    return this.escalationLogCache;
  }

  start(): void {
    if (this.sweepTimer) return;
    if (!this.cfg.enabled) {
      this.log.log('engine disabled; sweep NOT armed');
      return;
    }
    this.sweepTimer = setInterval(() => {
      void this.tick().catch((err) => this.log.warn(`tick error: ${err instanceof Error ? err.message : String(err)}`));
    }, this.cfg.sweepIntervalMs);
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
    this.log.log(`engine armed (sweep ${this.cfg.sweepIntervalMs}ms, silenceThreshold ${this.cfg.silenceThresholdMs}ms, maxRedrives ${this.cfg.maxRedrives})`);
  }

  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  async tick(): Promise<TickResult> {
    const result: TickResult = { sent: 0, skipped: {}, dailyCountBefore: 0, disabled: !this.cfg.enabled };
    if (!this.cfg.enabled) return result;

    const nowMs = this.now();
    const dayAgoMs = nowMs - DAY_MS;

    const allCommitments = this.deps.commitmentTracker.getActive();
    const recentSends = allCommitments.filter((c) => isWithin24h(c.lastRedriveAt, dayAgoMs));
    const dailyCount = recentSends.length;
    const perPeerCount = new Map<string, number>();
    for (const c of recentSends) {
      const k = c.relatedAgent ?? '<unknown>';
      perPeerCount.set(k, (perPeerCount.get(k) ?? 0) + 1);
    }
    result.dailyCountBefore = dailyCount;

    if (dailyCount >= this.cfg.maxRedriveSendsPerDay) {
      this.log.log(`engine-wide daily fuse tripped (${dailyCount}/${this.cfg.maxRedriveSendsPerDay}); skipping tick`);
      return result;
    }

    const candidates = allCommitments
      .filter((c) => c.verificationMethod === 'threadline-reply')
      .filter((c) => !TERMINAL_STATUSES.has(c.status))
      .sort((a, b) => referenceMs(a) - referenceMs(b));

    let perTickSent = 0;

    for (const c of candidates) {
      if (perTickSent >= this.cfg.maxRedrivesPerTick) {
        result.skipped[c.id] = 'per-tick-fuse';
        continue;
      }

      const elig = this.checkEligibility(c, nowMs);
      if (!elig.eligible) {
        result.skipped[c.id] = elig.reason;
        continue;
      }

      const peer = c.relatedAgent!;
      const peerCount = perPeerCount.get(peer) ?? 0;
      if (peerCount >= this.cfg.perPeerDailyCap) {
        result.skipped[c.id] = `per-peer-cap (${peerCount}/${this.cfg.perPeerDailyCap})`;
        continue;
      }
      if (dailyCount + perTickSent >= this.cfg.maxRedriveSendsPerDay) {
        result.skipped[c.id] = 'engine-wide-cap';
        continue;
      }

      const met = await this.checkCompletion(c).catch(() => false);
      if (met) {
        try {
          await this.deps.commitmentTracker.mutate(c.id, (prev) => ({
            ...prev,
            status: 'delivered',
            resolvedAt: new Date(nowMs).toISOString(),
            resolution: 'auto-closed by CollaborationRedriveEngine (objective met)',
          }));
          result.skipped[c.id] = 'objective-met-closed';
        } catch (err) {
          this.log.warn(`auto-close failed for ${c.id}: ${err instanceof Error ? err.message : String(err)}`);
          result.skipped[c.id] = 'objective-met-close-failed';
        }
        continue;
      }

      const fingerprint = this.resolveFingerprint(peer);
      if (!fingerprint) {
        // Dogfood fix (2026-05-28): unresolvable peer names are STABLE
        // conditions (the name is missing from known-agents.json — it won't
        // resolve itself on the next sweep). The original strike-counter
        // escalated every few sweeps and reset, producing a notification
        // flood. The cooldown is durable per-peer: at most one
        // "can't reach <peer> — unknown routing" item per peer per
        // `unreachableEscalationCooldownMs` (default 24h), persisted to
        // disk so it survives restart.
        result.skipped[c.id] = 'unresolved-name';
        if (this.shouldEscalateUnreachable(peer, nowMs) && this.deps.raiseAttention) {
          try {
            await this.deps.raiseAttention({
              title: `can't reach ${peer} — unknown routing`,
              body: `Tried to nudge ${peer} on commitment ${c.id} ("${c.userRequest.slice(0, 120)}") but no fingerprint resolved from known-agents.json. Add ${peer} to known-agents.json or close the commitment. (I will not raise this again for this peer for ${Math.round(this.cfg.unreachableEscalationCooldownMs / 3600000)}h.)`,
              priority: 'medium',
              source: 'collaboration-redrive',
            });
            this.recordUnreachableEscalation(peer, nowMs);
          } catch {
            // non-fatal
          }
        }
        continue;
      }

      const currentCount = (c.redriveCount ?? 0) + 1;
      const nudgeText = this.buildNudge(c, currentCount);

      const lastNudge = (c as Commitment & { lastRedriveText?: string }).lastRedriveText;
      if (lastNudge && jaccard3gram(lastNudge, nudgeText) >= this.cfg.dedupeJaccard) {
        result.skipped[c.id] = 'novelty-guard-near-dup';
        await this.escalateCapHit(c, 'novelty-guard near-duplicate nudges');
        continue;
      }

      const sendIsoTime = new Date(nowMs).toISOString();
      let mutatedCommitment: Commitment | null = null;
      try {
        mutatedCommitment = await this.deps.commitmentTracker.mutate(c.id, (prev) => ({
          ...prev,
          redriveCount: (prev.redriveCount ?? 0) + 1,
          lastRedriveAt: sendIsoTime,
          ...(typeof nudgeText === 'string' ? { lastRedriveText: nudgeText } : {}),
        } as Commitment));
      } catch (err) {
        this.log.warn(`mutate failed for ${c.id} (no send attempted): ${err instanceof Error ? err.message : String(err)}`);
        result.skipped[c.id] = 'mutate-failed';
        continue;
      }

      try {
        if (this.deps.relayClient) {
          this.deps.relayClient.sendPlaintext(fingerprint, nudgeText, c.relatedThreadId);
        } else {
          this.log.warn(`no relayClient injected; nudge for ${c.id} not transmitted`);
        }
      } catch (err) {
        this.log.warn(`relay send failed for ${c.id} (count already incremented per spec): ${err instanceof Error ? err.message : String(err)}`);
      }

      if (this.deps.surfacer) {
        try {
          await this.deps.surfacer.notify({
            threadId: c.relatedThreadId ?? `cmt-${c.id}`,
            title: 'collaboration re-drive',
            body: `Nudged ${peer} on ${c.id} (${mutatedCommitment?.redriveCount ?? '?'}/${this.cfg.maxRedrives}): ${nudgeText.slice(0, 200)}`,
            peerName: peer,
          });
        } catch {
          // non-fatal
        }
      }

      perTickSent++;
      perPeerCount.set(peer, peerCount + 1);
      result.sent++;

      const newCount = mutatedCommitment?.redriveCount ?? 0;
      if (newCount >= this.cfg.maxRedrives) {
        await this.escalateCapHit(c, `cap reached (${newCount}/${this.cfg.maxRedrives})`);
      }
    }

    return result;
  }

  checkEligibility(c: Commitment, nowMs: number): { eligible: true } | { eligible: false; reason: string } {
    if (c.verificationMethod !== 'threadline-reply') return { eligible: false, reason: 'not-threadline-reply' };
    if (TERMINAL_STATUSES.has(c.status)) return { eligible: false, reason: 'terminal-status' };

    const refIso = c.lastReplyAt ?? c.createdAt;
    const refMs = Date.parse(refIso);
    if (!Number.isFinite(refMs)) return { eligible: false, reason: 'invalid-reference-timestamp' };
    if (refMs > nowMs) return { eligible: false, reason: 'future-reference-timestamp' };

    const silenceMs = nowMs - refMs;
    if (silenceMs < this.cfg.silenceThresholdMs) return { eligible: false, reason: 'not-silent-yet' };

    const redriveCount = c.redriveCount ?? 0;
    if (redriveCount >= this.cfg.maxRedrives) return { eligible: false, reason: 'cap-reached' };

    if (c.lastRedriveAt) {
      const lastMs = Date.parse(c.lastRedriveAt);
      if (Number.isFinite(lastMs) && (nowMs - lastMs) < this.cfg.silenceThresholdMs) {
        return { eligible: false, reason: 'spacing-window' };
      }
    }

    if (!c.relatedAgent) return { eligible: false, reason: 'no-related-agent' };

    return { eligible: true };
  }

  private async checkCompletion(c: Commitment): Promise<boolean> {
    try {
      const condition = `The objective was: ${c.userRequest}. Has the counterpart (${c.relatedAgent ?? 'remote'}) clearly delivered the result?`;
      const transcriptTail = `Agent's stated commitment: ${c.agentResponse}\n\nLast known reply at: ${c.lastReplyAt ?? '(no reply yet)'}`;
      const verdict = await this.deps.completionEvaluator.evaluate(condition, transcriptTail);
      return verdict.met === true;
    } catch {
      return false;
    }
  }

  private resolveFingerprint(peerName: string): string | null {
    // Dogfood gap (2026-05-28): `relatedAgent` on a real threadline-reply
    // commitment is sometimes ALREADY a 32-char hex fingerprint, not a
    // display name (e.g. when the commitment was opened from an inbound
    // whose sender we only knew by fingerprint). The original v3 resolver
    // assumed display-name-only, so the lookup missed and every such
    // commitment skipped with `unresolved-name`. Verified live: ~10/15
    // open threadline-reply commitments on Echo used the fingerprint as
    // the peer field. Detect the fingerprint case structurally and use
    // it directly; otherwise fall back to the name lookup.
    if (CollaborationRedriveEngine.looksLikeFingerprint(peerName)) {
      return peerName.toLowerCase();
    }
    try {
      const raw = fs.readFileSync(this.deps.knownAgentsPath, 'utf-8');
      const data = JSON.parse(raw);
      const agents = (data.agents ?? data) as Array<{ publicKey?: string; name?: string }>;
      if (!Array.isArray(agents)) return null;
      const matches = agents.filter((a) => a.name === peerName && typeof a.publicKey === 'string');
      if (matches.length !== 1) return null;
      return matches[0].publicKey ?? null;
    } catch {
      return null;
    }
  }

  /**
   * `relatedAgent` looks like a Threadline fingerprint if it is exactly 32
   * hex characters (the format `computeFingerprint` produces — first 16
   * bytes of the Ed25519 public key, hex-encoded). Matched
   * case-insensitively; the resolver normalises to lowercase before use.
   */
  static looksLikeFingerprint(s: string): boolean {
    return typeof s === 'string' && /^[0-9a-f]{32}$/i.test(s);
  }

  private buildNudge(c: Commitment, attemptNumber: number): string {
    const peer = c.relatedAgent ?? 'there';
    const ask = c.userRequest.length > 240 ? `${c.userRequest.slice(0, 240)}…` : c.userRequest;
    const opener = attemptNumber === 1
      ? `Hi ${peer} — checking in on our open thread.`
      : `Hi ${peer} — second follow-up; the thread has been quiet for a while.`;
    const closing = attemptNumber === 1
      ? `Could you confirm where this stands or share a concrete next step? If you're blocked, what would unblock you?`
      : `Could you confirm where this stands? If you're blocked or this isn't a priority right now, just say so — I'll escalate to the operator and stop pinging. (This is my last automated nudge on this thread.)`;
    return [
      opener,
      ``,
      `The ask was: ${ask}`,
      ``,
      closing,
      ``,
      `— echo (automated nudge #${attemptNumber}; the conversation has been quiet)`,
    ].join('\n');
  }

  private async escalateCapHit(c: Commitment, reason: string): Promise<void> {
    if (!this.deps.raiseAttention) return;
    try {
      await this.deps.raiseAttention({
        title: `collaboration with ${c.relatedAgent ?? 'remote'} stalled — your call`,
        body: `${reason}. Commitment ${c.id}: "${c.userRequest.slice(0, 200)}". I sent the bounded follow-ups and have stopped; the operator decides next.`,
        priority: 'medium',
        source: 'collaboration-redrive',
      });
    } catch {
      // non-fatal
    }
  }
}

// ── Pure helpers (exported for unit testing) ──────────────────────────

export function referenceMs(c: Commitment): number {
  const ref = c.lastReplyAt ?? c.createdAt;
  const ms = Date.parse(ref);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

export function isWithin24h(iso: string | undefined, dayAgoMs: number): boolean {
  if (!iso) return false;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms >= dayAgoMs;
}

export function jaccard3gram(a: string, b: string): number {
  const A = ngrams(a, 3);
  const B = ngrams(b, 3);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

function ngrams(text: string, n: number): Set<string> {
  const words = (text || '').toLowerCase().normalize('NFC').split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) {
    out.add(words.slice(i, i + n).join(' '));
  }
  return out;
}
