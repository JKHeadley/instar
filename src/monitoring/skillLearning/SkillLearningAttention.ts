/**
 * SkillLearningAttention — the Skill Learning Sentinel's six attention items (spec
 * docs/specs/skill-learning-sentinel.md §3.10, items 1–6), each behind the self-heal it declares
 * (Self-Heal Before Notify): the operator hears only when the heal itself is exhausted.
 *
 * Items 1–4 are gated: one `SelfHealGate` per item (`hardware-bound`, `durable-machine-local`), dedupe key
 * `<item>.<sha256(procedureKey)[0..24]>`, 3 attempts with 1 h / 6 h / 24 h backoff, breaker 3 heals of one key
 * in 7 days → escalate, and the notice lands inside the same tick the gate exhausts (measured and audited
 * against the 120 s ceiling the spec names). The heals themselves are injected (3A's bounded revert, 3B's
 * retire proposal, the two family swaps) and run ASYNC off the gate: the gate's remediation must be
 * synchronous (deviation (z)), so it returns the outcome the previous heal recorded, and an `attempted` verdict
 * launches the next heal. A heal that `healed` closes the episode (`recordHealthy`); a `terminal` heal (the
 * reverted version is harmful too / nothing is retirable) notifies at once — there is nothing left to retry.
 * Items 3/4 swap ONCE per episode: a refusal or failure after the swap notifies.
 *
 * Items 5 (unmeasured skill, revert breaker, equal-epoch split-brain) and 6 (growth) are notify-only: no gate,
 * no heal, the numbers in plain words; item 6 refuses nothing and is silent.
 *
 * Every tick, attempt, heal, notice and cause-clear is audited to `logs/skill-learning.jsonl`
 * (`kind: 'attention'`, scrubbed metadata only). Durable state (open notices, recorded heal outcomes, swap
 * markers, episodes) is per machine under `skill-learning/`; a lease move therefore restarts an episode on the
 * new holder (recorded in the slice's side-effects artifact).
 *
 * Multi-machine: heals and notices run on the lease holder only (§3.2 single writer). A standby ticks, audits
 * `governed: fence-stale`, and touches neither the gates nor the attention store.
 */
/* @self-action-controller: skill-learning-attention-notify */
/* @self-action-controller: skill-learning-heal-revert-first */
/* @self-action-controller: skill-learning-heal-index-retire */
/* @self-action-controller: skill-learning-drafter-family-swap */
/* @self-action-controller: skill-learning-classifier-failure-swap */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SelfHealGate, type SelfHealAuditEvent, type SelfHealEpisodeRecord, type SelfHealEpisodeStore, type SelfHealNotice, type SelfHealRemediationResult } from '../../core/SelfHealGate.js';
import { consumeAdmissionToken, governor } from '../selfaction/governor.js';
import type { Admission, AdmissionToken, AdmitOpts, DerivedTarget } from '../selfaction/types.js';
import { scrubSecrets } from '../scrubSecrets.js';
import {
  SKILL_LEARNING_PATHS,
  type SkillLearningAttentionLike, type SkillLearningAttentionObservation, type SkillLearningConfig,
  type SkillLearningHealOutcome, type SkillLearningHeals, type SkillLearningSignals,
} from './types.js';

// ─── Controller ids and brakes ────────────────────────────────────────────

export type GatedItem = 1 | 2 | 3 | 4;
export type AttentionItem = GatedItem | 5 | 6;

export const SKILL_LEARNING_HEAL_IDS: Readonly<Record<GatedItem, string>> = {
  1: 'skill-learning-heal-revert-first',
  2: 'skill-learning-heal-index-retire',
  3: 'skill-learning-drafter-family-swap',
  4: 'skill-learning-classifier-failure-swap',
};
export const SKILL_LEARNING_ATTENTION_NOTIFY_ID = 'skill-learning-attention-notify';

/** Minted once at module scope (raw-string admit at emit sites is lint-forbidden). */
const HEAL_GOVERNORS = {
  1: governor.for('skill-learning-heal-revert-first'),
  2: governor.for('skill-learning-heal-index-retire'),
  3: governor.for('skill-learning-drafter-family-swap'),
  4: governor.for('skill-learning-classifier-failure-swap'),
} as const;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The P19 brakes every gated item declares (spec §3.10). */
export const ATTENTION_BRAKES = {
  maxAttempts: 3,
  backoffMs: [HOUR_MS, 6 * HOUR_MS, 24 * HOUR_MS] as const,
  flap: { maxRecoveries: 3, windowMs: 7 * DAY_MS },
  /**
   * The spec's `max-notification-latency 120s` after exhaustion: measured from the LAST FAILED HEAL to the notice
   * (the last allowed heal's failure exhausts the gate in the same turn, so the interval never waits for a tick),
   * audited per notice; a miss (e.g. the attention store refused the write and a later tick retried) reports a
   * degradation. NOT the gate's
   * `notificationLatencyCeilingMs`: that field is a sustained-failure latch (it would notify at the second
   * attempt, 61 minutes into the episode, before the heals are exhausted), so the gate's latch is pinned to the
   * wall clock and this ceiling is enforced here.
   */
  notificationLatencyCeilingMs: 120_000,
  /** Long enough for 0 h + 1 h + 7 h attempts plus tick jitter; a holder asleep for three days mid-episode notifies `wall-clock`. */
  maxWallClockMs: 3 * DAY_MS,
  /** Item 3: consecutive drafter refusals before the family swap. */
  refusalStreak: 5,
  /** Item 4: classifier failures / calls over 24 h, strictly above. */
  classifierFailureRate: 0.5,
} as const;

/** Dedupe keys are `<item>.<24 hex>`: any procedure key, however hostile, lands inside the gate's regex. */
export function attentionDedupeKey(item: GatedItem, procedureKey: string): string {
  return `${item}.${crypto.createHash('sha256').update(procedureKey).digest('hex').slice(0, 24)}`;
}

/** The attention id/conditionKey suffix: the key itself when it is a plain slug, else a hash — ids never carry hostile text. */
export function attentionKeyLabel(key: string): string {
  return /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(key) ? key : `h-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
}

export function attentionConditionKey(item: AttentionItem, key: string): string {
  return `skill-learning:${item}:${attentionKeyLabel(key)}`;
}

// ─── Durable episode store (JSON, per machine, prunable) ──────────────────

/**
 * A `SelfHealEpisodeStore` on one JSON file per machine. Chosen over the shared `SqliteSelfHealEpisodeStore`
 * because that store caps 256 episodes with no delete path and an exhausted episode is monotonic: per-skill
 * dedupe keys would fill it for good. This one prunes closed episodes (`remove`, called on cause-clear) and
 * bounds itself at `maxEpisodes`; a full store refuses `create`, which the gate reports as `state-failure`.
 * Single-writer by construction (one sentinel per machine); the revision CAS guards re-entrancy in-process.
 */
export class JsonSelfHealEpisodeStore implements SelfHealEpisodeStore {
  private rows = new Map<string, SelfHealEpisodeRecord>();
  private loaded = false;
  constructor(private readonly file: string, private readonly maxEpisodes = 512) {}
  private ensure(): void {
    if (this.loaded) return;
    this.loaded = true;
    let raw: string;
    try { raw = fs.readFileSync(this.file, 'utf-8'); } catch { return; } // @silent-fallback-ok — no file yet: an empty store (the first episode creates it)
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return; } // @silent-fallback-ok — a corrupt file reads as empty; the gate re-creates episodes and the audit log keeps the history
    const rows = (parsed as { episodes?: unknown })?.episodes;
    if (!Array.isArray(rows)) return;
    for (const r of rows) if (r && typeof r === 'object' && typeof (r as SelfHealEpisodeRecord).key === 'string') this.rows.set((r as SelfHealEpisodeRecord).key, structuredClone(r as SelfHealEpisodeRecord));
  }
  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, episodes: [...this.rows.values()] })}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  load(key: string): SelfHealEpisodeRecord | null { this.ensure(); const row = this.rows.get(key); return row ? structuredClone(row) : null; }
  create(record: SelfHealEpisodeRecord): SelfHealEpisodeRecord | null {
    this.ensure();
    if (this.rows.has(record.key) || this.rows.size >= this.maxEpisodes) return null;
    this.rows.set(record.key, structuredClone(record)); this.save();
    return structuredClone(record);
  }
  mutate(key: string, expectedRevision: number, update: (record: SelfHealEpisodeRecord) => SelfHealEpisodeRecord, guard?: () => boolean): SelfHealEpisodeRecord | null {
    this.ensure();
    const current = this.rows.get(key);
    if (!current || current.revision !== expectedRevision) return null;
    if (guard && !guard()) return null;
    const next = update(structuredClone(current));
    if (next.key !== key || next.revision !== expectedRevision + 1) throw new Error('self-heal mutation must increment revision once');
    if (current.status === 'exhausted' && next.status !== 'exhausted') throw new Error('self-heal exhausted state is monotonic');
    this.rows.set(key, structuredClone(next)); this.save();
    return structuredClone(next);
  }
  /** Drop a closed episode so a recurrence starts fresh (the gate itself never deletes). */
  remove(key: string): boolean { this.ensure(); const had = this.rows.delete(key); if (had) this.save(); return had; }
  size(): number { this.ensure(); return this.rows.size; }
}

// ─── Options and state ────────────────────────────────────────────────────

export interface SkillLearningAttentionOptions {
  stateDir: string;
  machineId: string;
  config: Pick<SkillLearningConfig, 'growthSignals' | 'retire'>;
  heals: SkillLearningHeals;
  createAttentionItem: (obs: SkillLearningAttentionObservation) => Promise<unknown> | unknown;
  clearAttentionCondition: (match: { conditionKey: string }, resolution: string, options: { reconcile: true }) => { closed: number; refusedSticky: number } | void;
  degradation?: { report(event: { feature: string; primary: string; fallback: string; reason: string; impact: string }): void } | null;
  evidence?: { record(featureId: string, input: { kind: 'fired' | 'held' | 'error' | 'outcome'; reason: string; context?: Record<string, unknown> }): string | null } | null;
  /** Default: `JsonSelfHealEpisodeStore` at `skill-learning/self-heal-episodes.<machineId>.json`. */
  episodeStore?: SelfHealEpisodeStore & { remove?(key: string): boolean };
  /** Governor seams (tests inject allow-all fakes; the default is the real per-item handle). */
  admit?: (item: GatedItem, target: DerivedTarget, opts: AdmitOpts) => Promise<Admission>;
  consumeToken?: (token: AdmissionToken, controllerId: string, opts: { targetKey: string; nowMs: number }) => { proceed: boolean; valid: boolean; reason?: string };
  bootId?: string;
  now?: () => number;
  logger?: (message: string) => void;
}

interface AttentionState {
  version: 1;
  /** Open notices by conditionKey: one notice per condition episode, across restarts. */
  open: Record<string, { item: AttentionItem; key: string; at: string; reason: string }>;
  /** The outcome the last heal recorded per dedupe key — what the synchronous remediation returns (deviation (z)). */
  outcomes: Record<string, { healed: boolean; reason: string; terminal: boolean; at: string }>;
  /** A heal that healed, with the condition's marker at the time: the same marker afterwards = waiting on the heal's effect. */
  healed: Record<string, { at: string; marker: number }>;
  /** Gated conditions seen on the holder, so their episodes close (`recordHealthy`) when the condition clears. */
  episodes: Record<string, { item: GatedItem; key: string; since: string }>;
  /** Notices whose attention-store write failed: retried every tick, latency still measured from the original failure. */
  pendingNotices: Record<string, { item: AttentionItem; key: string; title: string; summary: string; reason: string; words: string; failedAt: number }>;
}

interface Condition {
  item: AttentionItem;
  key: string;
  title: string;
  summary: string;
  /** Gated items: the evidence counter the heal is meant to move (version / strike time / streak / failures). */
  marker: number;
  heal?: () => Promise<SkillLearningHealOutcome>;
  /** Items 3/4: a swap happens once per episode; the condition moving past the swap's marker notifies. */
  swapOnce?: boolean;
}

interface GateCtx { item: GatedItem; key: string; dedupe: string }

export interface AttentionTickSummary {
  at: string;
  holdsLease: boolean;
  conditions: number;
  healsLaunched: number;
  notices: number;
  cleared: number;
  governed: number;
  /** Per gated condition this tick: the gate's verdict (tests read this). */
  verdicts: Array<{ item: AttentionItem; key: string; outcome: string; reason: string }>;
}

const SKILL_LEARNING_FEATURE = 'monitoring.skillLearning';

// ─── The controller ───────────────────────────────────────────────────────

export class SkillLearningAttention implements SkillLearningAttentionLike {
  private readonly o: SkillLearningAttentionOptions;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private readonly store: SelfHealEpisodeStore & { remove?(key: string): boolean };
  private readonly gates: Record<GatedItem, SelfHealGate<GateCtx>>;
  private readonly inFlight = new Map<string, Promise<void>>();
  /** The condition under `gate.attempt` right now, by gate id — the gate's notify callback carries no dedupe key. */
  private readonly attempting = new Map<string, { cond: Condition; startedAt: number; /** When the heal this attempt accounts for failed (the spec's latency interval starts here). */ failedAt?: number }>();
  private state: AttentionState;
  private stateDirty = false;
  /** Notices created inside the current tick (every path: gate exhaustion, terminal heal, notify-only items). */
  private tickNotices = 0;

  constructor(options: SkillLearningAttentionOptions) {
    this.o = options;
    this.now = options.now ?? (() => Date.now());
    this.log = options.logger ?? (() => {});
    this.store = options.episodeStore ?? new JsonSelfHealEpisodeStore(path.join(options.stateDir, 'skill-learning', `self-heal-episodes.${options.machineId}.json`));
    this.state = this.readState();
    const mk = (item: GatedItem): SelfHealGate<GateCtx> => new SelfHealGate<GateCtx>({
      id: SKILL_LEARNING_HEAL_IDS[item], controllerResource: 'hardware-bound', episodeAuthority: 'durable-machine-local', classId: `skill-learning-attention-${item}`,
      severity: () => 'recoverable',
      dedupeKey: (ctx) => ctx.dedupe,
      eligible: () => ({ eligible: this.signals?.holdsLease === true, fence: this.signals?.holdsLease ? String(this.signals.epoch ?? 'local') : null }),
      remediation: (ctx) => this.remediation(ctx),
      maxAttempts: ATTENTION_BRAKES.maxAttempts, maxWallClockMs: ATTENTION_BRAKES.maxWallClockMs,
      backoffMs: (attempt) => ATTENTION_BRAKES.backoffMs[Math.min(ATTENTION_BRAKES.backoffMs.length, Math.max(1, attempt)) - 1],
      // The gate's latch is a sustained-failure signal (see ATTENTION_BRAKES.notificationLatencyCeilingMs): pinned to the wall clock so only exhaustion notifies.
      notificationLatencyCeilingMs: ATTENTION_BRAKES.maxWallClockMs,
      flap: { ...ATTENTION_BRAKES.flap },
      remediationActions: { operation: HEAL_OPERATION[item], idempotencyGuard: 'one heal in flight per dedupe key; the recorded outcome is consumed once', compensation: 'the heal is bounded by its own caller (commit protocol / family swap); the gate only counts attempts' },
    }, {
      admit: (target, opts) => (this.o.admit ? this.o.admit(item, target, opts) : HEAL_GOVERNORS[item].admit(target, opts)),
      consumeToken: (token, controllerId, opts) => (this.o.consumeToken ?? consumeAdmissionToken)(token, controllerId, opts),
      notify: (notice) => this.onGateNotice(item, notice),
      audit: (event) => this.onGateAudit(event),
      now: this.now, episodeStore: this.store, bootId: options.bootId,
    });
    this.gates = { 1: mk(1), 2: mk(2), 3: mk(3), 4: mk(4) };
  }

  private signals: SkillLearningSignals | null = null;

  /** Wait for every in-flight heal (tests; the sentinel's stop may call it too). */
  async settle(): Promise<void> { await Promise.all([...this.inFlight.values()]); }

  /** Read-only snapshot for status/console: open notices and recorded outcomes. */
  snapshot(): { open: AttentionState['open']; outcomes: AttentionState['outcomes']; inFlight: number } {
    return { open: structuredClone(this.state.open), outcomes: structuredClone(this.state.outcomes), inFlight: this.inFlight.size };
  }

  // ─── Tick ─────────────────────────────────────────────────────────────

  async tick(signals: SkillLearningSignals): Promise<AttentionTickSummary> {
    this.signals = signals;
    this.tickNotices = 0;
    const summary: AttentionTickSummary = { at: new Date(signals.at).toISOString(), holdsLease: signals.holdsLease, conditions: 0, healsLaunched: 0, notices: 0, cleared: 0, governed: 0, verdicts: [] };
    const conditions = this.conditions(signals);
    summary.conditions = conditions.length;
    if (!signals.holdsLease) {
      // A standby neither heals nor notifies (§3.2 single writer): every present condition is recorded as governed.
      for (const c of conditions) { summary.governed++; summary.verdicts.push({ item: c.item, key: c.key, outcome: 'governed', reason: 'fence-stale' }); }
      if (conditions.length) this.audit({ event: 'governed', reason: 'fence-stale', conditions: conditions.map((c) => ({ item: c.item, key: attentionKeyLabel(c.key) })) });
      return summary;
    }
    await this.retryPendingNotices();
    const present = new Set<string>();
    for (const c of conditions) {
      present.add(attentionConditionKey(c.item, c.key));
      if (c.item <= 4) {
        const v = await this.handleGated(c as Condition & { item: GatedItem }, summary);
        summary.verdicts.push({ item: c.item, key: c.key, outcome: v.outcome, reason: v.reason });
      } else {
        const sent = await this.notify(c, 'condition', c.summary);
        summary.verdicts.push({ item: c.item, key: c.key, outcome: sent ? 'notified' : 'open', reason: 'notify-only' });
      }
    }
    summary.cleared = this.clearAbsent(present);
    summary.notices = this.tickNotices;
    this.flushState();
    return summary;
  }

  // ─── Conditions from the signals ──────────────────────────────────────

  private conditions(s: SkillLearningSignals): Condition[] {
    const out: Condition[] = [];
    const seen = new Set<string>();
    const push = (c: Condition): void => { const k = `${c.item}:${c.key}`; if (seen.has(k)) return; seen.add(k); out.push(c); };
    for (const r of s.harmRetired ?? []) {
      const reason = r.reason ? ` (${plain(r.reason)})` : '';
      push({
        item: 1, key: r.skill, marker: r.version,
        title: `I retired the skill "${r.skill}" for harm and could not safely revert it`,
        summary: `Version ${r.version} of "${r.skill}" was retired because using it caused harm${reason}. I tried reverting to the version before it first.`,
        heal: this.o.heals.revertFirst ? () => this.o.heals.revertFirst!({ skill: r.skill, version: r.version }) : undefined,
      });
    }
    for (const r of s.indexCostTooHigh ?? []) {
      const bytes = r.indexBytes === null ? 'an unmeasured' : `${r.indexBytes.toLocaleString('en-US')} bytes of`;
      const room = r.claudeHeadroomChars === null ? '' : ` with ${r.claudeHeadroomChars.toLocaleString('en-US')} characters of room left`;
      push({
        item: 2, key: r.key, marker: Number.isFinite(Date.parse(r.at)) ? Date.parse(r.at) : 0,
        title: `A skill I wanted to write would make the skill index too costly`,
        summary: `The reviewer judged the index too costly for the draft${r.name ? ` "${r.name}"` : ''} (${bytes} skill index${room}). I asked it to propose retiring the lowest-scored unused skill first.`,
        heal: this.o.heals.retireLowestUnused ? () => this.o.heals.retireLowestUnused!({ key: r.key, indexBytes: r.indexBytes, claudeHeadroomChars: r.claudeHeadroomChars }) : undefined,
      });
    }
    for (const [key, streak] of Object.entries(s.refusalStreaks ?? {})) {
      if (!(streak >= ATTENTION_BRAKES.refusalStreak)) continue;
      push({
        item: 3, key, marker: streak, swapOnce: true,
        title: `The skill drafter has refused the same request ${streak} times in a row`,
        summary: `${streak} consecutive drafts for one recurring request were refused. I swapped the drafter to another model family once.`,
        heal: this.o.heals.swapDrafterFamily ? () => this.o.heals.swapDrafterFamily!({ key, streak }) : undefined,
      });
    }
    const cl = s.classifier;
    if (cl && cl.calls24h !== null && cl.calls24h > 0 && cl.failures24h / cl.calls24h > ATTENTION_BRAKES.classifierFailureRate) {
      const rate = cl.failures24h / cl.calls24h;
      push({
        item: 4, key: 'classifier', marker: cl.failures24h, swapOnce: true,
        title: `The request classifier is failing most of the time`,
        summary: `${cl.failures24h} of ${cl.calls24h} classifier calls failed in the last 24 hours (${Math.round(rate * 100)}%). I swapped it to another model family once.`,
        heal: this.o.heals.swapClassifierFamily ? () => this.o.heals.swapClassifierFamily!({ failures24h: cl.failures24h, calls24h: cl.calls24h!, rate }) : undefined,
      });
    }
    const floor = this.o.config.retire.measurableFloor;
    const minRuns = this.o.config.retire.minCorroboratedRuns;
    for (const sk of s.skills ?? []) {
      if (sk.uses < minRuns || sk.measurableRate === null || sk.measurableRate >= floor) continue;
      push({
        item: 5, key: `unmeasured.${sk.name}`, marker: 0,
        title: `I cannot measure whether the skill "${sk.name}" works`,
        summary: `"${sk.name}" ran ${sk.uses} times but only ${sk.corroborated} of those runs could be checked (${Math.round(sk.measurableRate * 100)}%, below the ${Math.round(floor * 100)}% floor). Nothing is wrong by itself; its score cannot be trusted either way.`,
      });
    }
    for (const b of s.revertBreakers ?? []) {
      push({
        item: 5, key: `revert-breaker.${b.key}`, marker: 0,
        title: `A learned skill${b.skill ? ` ("${b.skill}")` : ''} was reverted too often and is now locked`,
        summary: `The revert breaker tripped for one recurring request${b.skill ? ` served by "${b.skill}"` : ''}${b.reason ? ` (${plain(b.reason)})` : ''} at ${b.at}. I will not patch or revert it again until you unlock it.`,
      });
    }
    for (const sb of s.splitBrain ?? []) {
      push({
        item: 5, key: `split-brain.${sb.name}`, marker: 0,
        title: `Two machines wrote different versions of the skill "${sb.name}" at the same time`,
        summary: `Both bodies of "${sb.name}" carry the same epoch${sb.detail ? ` (${plain(sb.detail)})` : ''}. Neither is in use: both are proposals now, and the skill waits for your pick.`,
      });
    }
    const limit = Math.max(0, Math.floor(this.o.config.growthSignals.createdPerWeekNotice));
    const created = s.createdLast7d ?? [];
    if (created.length > limit) {
      const names = created.map((c) => `${c.name}${c.kind === 'proposal' ? ' (proposal' : ' (skill'}${c.arbiterOnly ? ', arbiter-only' : c.disagreement === 'default-only' ? ', default rung only' : ''})`).join(', ');
      push({
        item: 6, key: 'growth', marker: 0,
        title: `${created.length} skills drafted in 7 days (your notice level is ${limit})`,
        summary: `This week: ${names}. This is a signal for your review, not a limit — nothing was refused.`,
      });
    }
    return out;
  }

  // ─── Gated items ──────────────────────────────────────────────────────

  private async handleGated(c: Condition & { item: GatedItem }, summary: AttentionTickSummary): Promise<{ outcome: string; reason: string }> {
    if ((c.item === 1 || c.item === 2) && this.signals?.live === false) {
      // Shadow mode writes nothing (§3.3): the revert and the retire proposal are live writes, so their items wait for live mode.
      this.audit({ event: 'governed', reason: 'shadow', item: c.item, key: attentionKeyLabel(c.key) });
      return { outcome: 'governed', reason: 'shadow' };
    }
    const dedupe = attentionDedupeKey(c.item, c.key);
    const ctx: GateCtx = { item: c.item, key: c.key, dedupe };
    if (!this.state.episodes[dedupe]) { this.state.episodes[dedupe] = { item: c.item, key: c.key, since: new Date(this.now()).toISOString() }; this.stateDirty = true; }
    if (this.inFlight.has(dedupe)) return { outcome: 'busy', reason: 'heal-in-flight' };
    const recorded = this.state.outcomes[dedupe];
    if (recorded?.terminal) return { outcome: 'terminal', reason: recorded.reason };
    const healed = this.state.healed[dedupe];
    if (healed) {
      if (c.marker <= healed.marker) return { outcome: 'waiting', reason: 'heal-done-marker-unmoved' };
      if (c.swapOnce) {
        // Swapped once; the condition moved past the swap ⇒ the only step left is the operator.
        this.state.outcomes[dedupe] = { healed: false, reason: 'swapped-once-still-failing', terminal: true, at: new Date(this.now()).toISOString() };
        this.stateDirty = true;
        this.audit({ event: 'heal-terminal', item: c.item, key: attentionKeyLabel(c.key), reason: 'swapped-once-still-failing', marker: c.marker, swappedAtMarker: healed.marker });
        await this.notify(c, 'heal-terminal', 'the swap did not stop the failures');
        return { outcome: 'terminal', reason: 'swapped-once-still-failing' };
      }
      delete this.state.healed[dedupe]; this.stateDirty = true;    // items 1/2: new evidence ⇒ the gate may heal again (its breaker bounds it)
    }
    const failedAt = recorded ? Date.parse(recorded.at) : NaN;
    const result = await this.attemptGate(c, ctx, Number.isFinite(failedAt) ? failedAt : undefined);
    if (result.outcome === 'attempted') { this.launch(c, ctx); summary.healsLaunched++; }
    return { outcome: result.outcome, reason: result.reason };
  }

  /** One `gate.attempt`, with the condition (and the failure it accounts for) visible to the gate's notify callback. */
  private async attemptGate(c: Condition & { item: GatedItem }, ctx: GateCtx, failedAt?: number): Promise<{ outcome: string; reason: string; noticeAttempted?: boolean }> {
    const gateId = SKILL_LEARNING_HEAL_IDS[c.item];
    this.attempting.set(gateId, { cond: c, startedAt: this.now(), failedAt });
    let result: { outcome: string; reason: string; noticeAttempted?: boolean };
    try { result = await this.gates[c.item].attempt(ctx); }
    finally { this.attempting.delete(gateId); }
    this.audit({ event: 'gate', item: c.item, key: attentionKeyLabel(c.key), outcome: result.outcome, reason: result.reason, marker: c.marker, sameTurn: failedAt !== undefined && failedAt === this.now() });
    return result;
  }

  /** Synchronous (the gate forbids async): the outcome the previous heal recorded, consumed once. */
  private remediation(ctx: GateCtx): SelfHealRemediationResult {
    const recorded = this.state.outcomes[ctx.dedupe];
    if (!recorded) return { outcome: 'not-healed', evidence: 'source-absent' };
    delete this.state.outcomes[ctx.dedupe]; this.stateDirty = true;
    return recorded.healed ? { outcome: 'healed', evidence: 'repaired' } : { outcome: 'not-healed', evidence: 'verification-failed' };
  }

  private launch(c: Condition & { item: GatedItem }, ctx: GateCtx): void {
    this.audit({ event: 'heal-launched', item: c.item, key: attentionKeyLabel(c.key), available: Boolean(c.heal) });
    const run = (async (): Promise<void> => {
      let out: SkillLearningHealOutcome;
      if (!c.heal) out = { healed: false, reason: 'heal-unavailable' };
      else {
        try { out = await c.heal(); }
        catch (err) { out = { healed: false, reason: 'heal-threw', detail: (err instanceof Error ? err.message : String(err)).slice(0, 200) }; } // @silent-fallback-ok — recorded as this heal's outcome and audited below; the gate's attempt cap and backoff bound the retry
      }
      await this.recordOutcome(c, ctx, out);
    })();
    const tracked = run.finally(() => { this.inFlight.delete(ctx.dedupe); this.flushState(); });
    this.inFlight.set(ctx.dedupe, tracked);
  }

  private async recordOutcome(c: Condition & { item: GatedItem }, ctx: GateCtx, out: SkillLearningHealOutcome): Promise<void> {
    const at = new Date(this.now()).toISOString();
    const reason = out.healed ? 'healed' : out.reason;
    this.audit({ event: 'heal-result', item: c.item, key: attentionKeyLabel(c.key), healed: out.healed, reason, terminal: !out.healed && out.terminal === true, detail: out.detail ? plain(out.detail).slice(0, 200) : null });
    this.o.evidence?.record(SKILL_LEARNING_FEATURE, { kind: out.healed ? 'outcome' : 'held', reason: `attention-heal:${c.item}:${reason}`, context: { item: c.item, key: attentionKeyLabel(c.key) } });
    if (out.healed) {
      delete this.state.outcomes[ctx.dedupe];
      this.state.healed[ctx.dedupe] = { at, marker: c.marker };
      const r = this.gates[c.item].recordHealthy(ctx);
      this.audit({ event: 'episode-recovered', item: c.item, key: attentionKeyLabel(c.key), outcome: r.outcome, reason: r.reason });
      this.stateDirty = true;
      return;
    }
    const failedAt = this.now();
    this.state.outcomes[ctx.dedupe] = { healed: false, reason, terminal: out.terminal === true, at };
    this.stateDirty = true;
    if (out.terminal) { await this.notify(c, 'heal-terminal', out.detail ? plain(out.detail) : reason, failedAt); return; }
    // The LAST allowed heal just failed: the spec's interval (last failed heal → operator notice) must not wait for the
    // next tick, so the gate exhausts now and the notice goes out in this same turn.
    const row = this.store.load(`${SKILL_LEARNING_HEAL_IDS[c.item]}:${ctx.dedupe}`);
    if (row?.status === 'active' && row.attempts >= ATTENTION_BRAKES.maxAttempts) {
      const r = await this.attemptGate(c, ctx, failedAt);
      if (r.outcome === 'exhausted') { this.state.outcomes[ctx.dedupe] = { healed: false, reason: `exhausted:${r.reason}`, terminal: true, at }; this.stateDirty = true; }
    }
  }

  // ─── Notices ──────────────────────────────────────────────────────────

  private async onGateNotice(item: GatedItem, notice: SelfHealNotice): Promise<void> {
    const live = this.attempting.get(SKILL_LEARNING_HEAL_IDS[item]);
    if (!live) {
      // A notice outside an attempt (the governor's queued continuation, a store failure): no condition to name.
      await this.notify({ item, key: `state-failure`, marker: 0, title: `My skill-learning self-heal record failed`, summary: `The self-heal bookkeeping for skill-learning item ${item} failed (${notice.reason}). Heals for it are paused until the record is readable again.` }, notice.reason, notice.reason);
      return;
    }
    const words = NOTICE_WORDS[notice.reason] ?? notice.reason;
    await this.notify(live.cond, notice.reason, words, live.failedAt ?? live.startedAt);
  }

  /**
   * One notice per condition episode (durable dedupe by conditionKey); returns true when a row was created.
   * `failedAt` = when the heal this notice follows failed (the spec's latency interval starts there); a notify-only
   * item has no heal, so its interval starts now.
   */
  private async notify(c: Condition, reason: string, words: string, failedAt: number = this.now()): Promise<boolean> {
    const conditionKey = attentionConditionKey(c.item, c.key);
    if (this.state.open[conditionKey]) { this.audit({ event: 'notify-deduped', item: c.item, key: attentionKeyLabel(c.key), reason }); return false; }
    const latencyMs = Math.max(0, this.now() - failedAt);
    const obs: SkillLearningAttentionObservation = {
      id: conditionKey, conditionKey, category: 'skill-learning', priority: c.item <= 4 ? 'HIGH' : 'NORMAL',
      title: plain(c.title), summary: c.item <= 4 ? `${plain(c.summary)} ${words}` : plain(c.summary),
      needsUser: c.item <= 5, silent: c.item === 6, sourceContext: 'skill-learning-sentinel',
    };
    try { await this.o.createAttentionItem(obs); }
    catch (err) { // @silent-fallback-ok — audited + reported as a degradation right here, and the notice is kept in `pendingNotices` (durable) so every later tick retries it with the latency still counted from the original failure
      const message = err instanceof Error ? err.message : String(err);
      this.state.pendingNotices[conditionKey] = { item: c.item, key: c.key, title: c.title, summary: c.summary, reason, words, failedAt };
      this.stateDirty = true;
      this.audit({ event: 'notify-failed', item: c.item, key: attentionKeyLabel(c.key), reason, error: plain(message).slice(0, 200) });
      this.o.degradation?.report({ feature: 'skill-learning-attention', primary: `attention item ${conditionKey}`, fallback: 'retried next tick', reason: message.slice(0, 200), impact: 'the operator has not yet been told about an exhausted skill-learning heal' });
      return false;
    }
    delete this.state.pendingNotices[conditionKey];
    this.state.open[conditionKey] = { item: c.item, key: c.key, at: new Date(this.now()).toISOString(), reason };
    this.stateDirty = true;
    this.tickNotices++;
    const withinCeiling = latencyMs <= ATTENTION_BRAKES.notificationLatencyCeilingMs;
    this.audit({ event: 'notify', item: c.item, key: attentionKeyLabel(c.key), conditionKey, reason, priority: obs.priority, needsUser: obs.needsUser, silent: obs.silent, latencyMs, withinCeiling });
    this.o.evidence?.record(SKILL_LEARNING_FEATURE, { kind: 'fired', reason: `attention:${c.item}:${reason}`, context: { conditionKey, latencyMs } });
    if (!withinCeiling) this.o.degradation?.report({ feature: 'skill-learning-attention', primary: 'notice within 120 s of the last failed heal', fallback: `notice sent after ${latencyMs} ms`, reason: reason === 'retry' ? 'the attention store refused the first write' : 'the notice path outlived the ceiling', impact: 'the operator heard late' });
    return true;
  }

  /** Notices the attention store refused earlier: tried again, still timed from their original failure. */
  private async retryPendingNotices(): Promise<void> {
    for (const [conditionKey, p] of Object.entries(this.state.pendingNotices)) {
      if (this.state.open[conditionKey]) { delete this.state.pendingNotices[conditionKey]; this.stateDirty = true; continue; }
      await this.notify({ item: p.item, key: p.key, title: p.title, summary: p.summary, marker: 0 }, 'retry', p.words, p.failedAt);
    }
  }

  /** Conditions seen before and absent now: close the notice (cause-cleared), close the episode, forget the outcome. */
  private clearAbsent(present: Set<string>): number {
    let cleared = 0;
    for (const [conditionKey, row] of Object.entries(this.state.open)) {
      if (present.has(conditionKey)) continue;
      let closed = 0;
      try { closed = (this.o.clearAttentionCondition({ conditionKey }, 'the condition cleared on its own', { reconcile: true }) as { closed: number } | undefined)?.closed ?? 0; }
      catch (err) { this.audit({ event: 'cause-clear-failed', item: row.item, key: attentionKeyLabel(row.key), error: plain(err instanceof Error ? err.message : String(err)).slice(0, 200) }); continue; } // @silent-fallback-ok — audited on the line above; the row stays `open` and the clear is retried next tick
      delete this.state.open[conditionKey]; this.stateDirty = true; cleared++;
      this.audit({ event: 'cause-cleared', item: row.item, key: attentionKeyLabel(row.key), conditionKey, closed, closedBy: 'cause-cleared' });
    }
    for (const [dedupe, ep] of Object.entries(this.state.episodes)) {
      if (present.has(attentionConditionKey(ep.item, ep.key)) || this.inFlight.has(dedupe)) continue;
      const ctx: GateCtx = { item: ep.item, key: ep.key, dedupe };
      const fullKey = `${SKILL_LEARNING_HEAL_IDS[ep.item]}:${dedupe}`;
      const row = this.store.load(fullKey);
      // Still active ⇒ the cause cleared by itself: the gate records healthy (a recovery for its breaker). Already
      // recovered ⇒ the heal's own recordHealthy counted it. Exhausted is monotonic inside the gate ⇒ drop the row so a
      // recurrence starts a fresh episode.
      const r = row?.status === 'active' ? this.gates[ep.item].recordHealthy(ctx) : { outcome: row?.status ?? 'absent', reason: 'no-op' };
      const removed = row?.status === 'exhausted' ? this.store.remove?.(fullKey) ?? false : false;
      delete this.state.episodes[dedupe]; delete this.state.outcomes[dedupe]; delete this.state.healed[dedupe]; this.stateDirty = true;
      this.audit({ event: 'episode-closed', item: ep.item, key: attentionKeyLabel(ep.key), outcome: r.outcome, reason: r.reason, removed });
    }
    return cleared;
  }

  // ─── Audit and state ──────────────────────────────────────────────────

  private onGateAudit(event: SelfHealAuditEvent): void {
    this.audit({ event: `gate:${event.event}`, gate: event.controllerId, reason: event.reason ?? null, attempt: event.attempt ?? null, elapsedMs: event.elapsedMs ?? null });
  }

  private audit(row: Record<string, unknown>): void {
    const file = path.join(this.o.stateDir, SKILL_LEARNING_PATHS.log);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.appendFileSync(file, `${JSON.stringify({ ts: new Date(this.now()).toISOString(), machineId: this.o.machineId, kind: 'attention', ...row })}\n`, { mode: 0o600 });
    } catch (err) { this.log(`[SkillLearningAttention] audit append failed: ${err instanceof Error ? err.message : String(err)}`); } // @silent-fallback-ok — logged to the process log; an unwritable audit never blocks a heal or a notice (No Silent Degradation: the logger line is the report)
  }

  private get statePath(): string { return path.join(this.o.stateDir, 'skill-learning', `attention-state.${this.o.machineId}.json`); }

  private readState(): AttentionState {
    const empty: AttentionState = { version: 1, open: {}, outcomes: {}, healed: {}, episodes: {}, pendingNotices: {} };
    let raw: string;
    try { raw = fs.readFileSync(this.statePath, 'utf-8'); } catch { return empty; } // @silent-fallback-ok — no state yet (first run on this machine)
    try {
      const parsed = JSON.parse(raw) as Partial<AttentionState>;
      return { version: 1, open: parsed.open ?? {}, outcomes: parsed.outcomes ?? {}, healed: parsed.healed ?? {}, episodes: parsed.episodes ?? {}, pendingNotices: parsed.pendingNotices ?? {} };
    } catch (err) { this.log(`[SkillLearningAttention] state unreadable, starting empty: ${err instanceof Error ? err.message : String(err)}`); return empty; } // @silent-fallback-ok — logged; a corrupt state file means notices may repeat once (the attention store dedupes by conditionKey)
  }

  private flushState(): void {
    if (!this.stateDirty) return;
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
      const tmp = `${this.statePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.statePath);
      this.stateDirty = false;
    } catch (err) { this.log(`[SkillLearningAttention] state write failed: ${err instanceof Error ? err.message : String(err)}`); } // @silent-fallback-ok — logged; the in-memory state stands for this process and is rewritten on the next tick
  }
}

const HEAL_OPERATION: Record<GatedItem, string> = {
  1: 'bounded-revert-first (CommitProtocol.write revert, §3.7)',
  2: 'reviewer-proposed-retire-lowest-unused (§3.9)',
  3: 'swap-drafter-family-once',
  4: 'swap-classifier-family-once',
};

const NOTICE_WORDS: Record<string, string> = {
  'max-attempts': 'I tried the fix three times over a day and it did not hold. You will need to look.',
  flap: 'The fix worked three times in seven days and the problem keeps coming back. You will need to look.',
  'wall-clock': 'I could not finish the fix inside three days. You will need to look.',
  'state-failure': 'My record of the fix attempts failed, so I stopped trying. You will need to look.',
  latency: 'The fix has been failing for longer than I allow. You will need to look.',
};

function plain(text: string): string { return scrubSecrets(String(text)).replace(/\s+/g, ' ').trim(); }

// ─── Signals derived from the sentinel's log tail (the sentinel's getter calls these) ──────────

/** The last `maxBytes` of a JSONL file as parsed rows (a partial first line is dropped). */
export function readLogTail(file: string, maxBytes = 2 * 1024 * 1024): Record<string, unknown>[] {
  let fd: number;
  try { fd = fs.openSync(file, 'r'); } catch { return []; } // @silent-fallback-ok — no log yet means no rows
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf-8');
    if (start > 0) { const nl = text.indexOf('\n'); text = nl >= 0 ? text.slice(nl + 1) : ''; }
    const out: Record<string, unknown>[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { const row = JSON.parse(line) as unknown; if (row && typeof row === 'object') out.push(row as Record<string, unknown>); }
      catch { continue; } // @silent-fallback-ok — a torn line (crash mid-append) is skipped; every other row still counts
    }
    return out;
  } finally { fs.closeSync(fd); }
}

/** Refusal reasons that are the DRAFTER's (item 3), not the reviewer's, the evidence cut or the commit protocol. */
export function isDrafterRefusal(row: Record<string, unknown>): boolean {
  if (row.kind !== 'draft-refused') return false;
  const reason = String(row.reason ?? '');
  if (row.stage === 'review') return false;
  if (reason === 'provider-error' || reason === 'unparseable' || reason === 'unrecorded' || reason === 'invalid-name') return true;
  return reason.startsWith('lint:') || reason.startsWith('action:');
}

/** Item 3: consecutive drafter refusals per key since the key's last successful draft (chronological rows). */
export function deriveRefusalStreaks(rows: Record<string, unknown>[]): Record<string, number> {
  const streaks: Record<string, number> = {};
  for (const row of rows) {
    const key = typeof row.key === 'string' ? row.key : null;
    if (!key) continue;
    if (isDrafterRefusal(row)) streaks[key] = (streaks[key] ?? 0) + 1;
    else if (row.kind === 'create' || row.kind === 'would-create' || row.kind === 'covered-by') streaks[key] = 0;
  }
  for (const k of Object.keys(streaks)) if (streaks[k] === 0) delete streaks[k];
  return streaks;
}

/** Item 2: index-cost strikes inside the last 7 days, the latest per key. */
export function deriveIndexCostStrikes(rows: Record<string, unknown>[], nowMs: number): SkillLearningSignals['indexCostTooHigh'] {
  const latest = new Map<string, SkillLearningSignals['indexCostTooHigh'][number]>();
  for (const row of rows) {
    if (row.kind !== 'index-cost' || row.verdict !== 'strike' || typeof row.key !== 'string') continue;
    const at = typeof row.ts === 'string' ? row.ts : '';
    const t = Date.parse(at);
    if (!Number.isFinite(t) || nowMs - t > 7 * DAY_MS || t > nowMs) continue;
    latest.set(row.key, {
      key: row.key, name: typeof row.name === 'string' ? row.name : undefined,
      indexBytes: typeof row.indexBytes === 'number' ? row.indexBytes : null,
      claudeHeadroomChars: typeof row.claudeHeadroomChars === 'number' ? row.claudeHeadroomChars : null, at,
    });
  }
  return [...latest.values()];
}
