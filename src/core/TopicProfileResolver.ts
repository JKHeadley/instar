/**
 * TopicProfileResolver — the SINGLE resolution point for a topic's execution
 * profile (TOPIC-PROFILE-SPEC §5.2), called from spawnSessionForTopic and the
 * tier-escalation consult (§9). In-memory, O(1) per call.
 *
 * Precedence per field: profile-store pin > config default > global default.
 *  - model arm: topic-profile pin > `topicProfiles.defaults` config >
 *    `frameworkDefaultModels` > account default — with the §10.2 clamp run
 *    at THIS boundary for every source (an off-enum config default falls to
 *    the next layer with a once-per-transition disclosure; config never
 *    persists through the store, so a write-time-only clamp would leave a
 *    named hole).
 *  - framework arm: profile-store framework > `config.topicFrameworks`
 *    (the legacy config layer, read-through unchanged — Migration Parity) >
 *    global default. A pinned framework whose CLI is not launchable falls
 *    back to the global default with a once-per-transition notice (§3.5
 *    keep-working: a dead pane is NOT "today's behavior"). The launchability
 *    check is CHEAP/CACHED (fs.existsSync, TTL'd) — never a per-spawn
 *    subprocess.
 *  - A `/local-model` binding is provider-level and WINS the model arm for
 *    that framework (§5.2) — resolution defers to it; the write side refuses
 *    new cloud pins while a binding is active.
 *  - Read-time re-validation: a persisted model pin is re-checked against
 *    the CURRENT closed enum (the enum can shrink after write); a
 *    no-longer-member id falls back with a one-line notice.
 *  - Disabled-flag semantics (§5.2): reads HONOR existing on-disk pins even
 *    when `topicProfiles` is disabled — the flag gates writes, never reads.
 *
 * Fallback notices are deduped per (topic, pin, reason) STATE TRANSITION
 * (§5.2 round-3) — disclosed once, then audit-only until the pin or the
 * underlying condition changes.
 */

import fs from 'node:fs';
import type { IntelligenceFramework } from './intelligenceProviderFactory.js';
import type { TopicProfileStore, TopicProfile } from './TopicProfileStore.js';
import {
  validateModelId,
  EFFORT_LEVELS,
  type EffortLevel,
  type EscalationOverride,
  type ProfileModelTier,
  type ThinkingMode,
} from './topicProfileValidation.js';
import { resolveTierModel, type TierEscalationConfig } from './ModelTierEscalation.js';
import { SUPPORTED_FRAMEWORKS } from './TopicFrameworksStore.js';

export interface ResolvedTopicProfile {
  framework: IntelligenceFramework;
  /**
   * The model to pass to the launch builder (concrete id), or undefined for
   * the account default. Already clamped through the closed enum.
   */
  model: string | undefined;
  /** The baseline tier pin, when the pin is tier-shaped (§7 in-flight row eligibility). */
  modelTier: ProfileModelTier | null;
  thinkingMode: ThinkingMode | undefined;
  /**
   * The Claude Code `--effort` level to pass at spawn, or undefined for none.
   * An invalid stored value FAILS OPEN to undefined (no `--effort` passed) —
   * resolution never throws and never hands the CLI a bad value.
   */
  effort: EffortLevel | undefined;
  /** §9 — default 'inherit' (the heavy-work ultra mandate stays in force). */
  escalationOverride: EscalationOverride;
  /** Which layer supplied each arm (audit/readout). */
  sources: { framework: string; model: string; thinkingMode: string; effort: string };
  /**
   * Once-per-transition fallback notices to surface (empty in the common
   * case). Already deduped — the caller may send them verbatim.
   */
  notices: string[];
}

export interface TopicProfileResolverOptions {
  store: TopicProfileStore;
  /** Global default framework (sessions.framework / INSTAR_FRAMEWORK). */
  defaultFramework: () => IntelligenceFramework;
  /** Legacy config-level framework defaults (`config.topicFrameworks`). */
  configTopicFrameworks: () => Record<string, string>;
  /** `topicProfiles.defaults` — per-topic config-default profiles (§12.5). */
  configProfileDefaults: () => Record<string, { model?: string; thinkingMode?: string; effort?: string }>;
  /** `frameworkDefaultModels` config layer. */
  frameworkDefaultModels: () => Partial<Record<IntelligenceFramework, string>>;
  /** Live tier-escalation config — resolves a modelTier pin to a concrete id. */
  tierEscalationConfig: () => TierEscalationConfig | undefined;
  /** Active `/local-model` binding for a topic (wins the model arm, §5.2). */
  localModelBinding: (topicKey: string) => { provider: string; model?: string } | null;
  /** Resolve the framework's CLI binary path (for the launchability check). */
  frameworkBinaryPath: (framework: IntelligenceFramework) => string | null;
  /** Audit sink for fallback events (one line each, even when deduped). */
  audit?: (event: Record<string, unknown>) => void;
}

/** Launchability cache TTL — re-stat the binary at most this often. */
const LAUNCHABILITY_TTL_MS = 60_000;

export class TopicProfileResolver {
  private readonly opts: TopicProfileResolverOptions;
  /** (topic|pin|reason) keys already disclosed — once-per-transition dedupe. */
  private disclosedFallbacks = new Set<string>();
  private launchabilityCache = new Map<string, { ok: boolean; at: number }>();

  constructor(opts: TopicProfileResolverOptions) {
    this.opts = opts;
  }

  /** O(1) — cache reads only; the single resolution point (§5.2). */
  resolve(topicKey: number | string): ResolvedTopicProfile {
    const key = String(topicKey);
    const pin: TopicProfile | null = this.opts.store.resolve(key);
    const notices: string[] = [];

    // ── framework arm ────────────────────────────────────────────────────
    let framework: IntelligenceFramework | null = null;
    let frameworkSource = 'global-default';
    if (pin?.framework) {
      if (this.isLaunchable(pin.framework)) {
        framework = pin.framework;
        frameworkSource = 'profile-pin';
        this.clearTransition(key, 'framework-unlaunchable');
      } else {
        const notice = this.onceNotice(
          key,
          'framework-unlaunchable',
          `this topic is pinned to ${pin.framework}, but its CLI isn't launchable here — using the default framework until it is`,
        );
        if (notice) notices.push(notice);
        this.opts.audit?.({
          type: 'fallback',
          reason: 'framework-unlaunchable',
          topic: key,
          pinned: pin.framework,
        });
      }
    }
    if (!framework) {
      const configFw = this.opts.configTopicFrameworks()[key];
      if (configFw && (SUPPORTED_FRAMEWORKS as readonly string[]).includes(configFw) && this.isLaunchable(configFw as IntelligenceFramework)) {
        framework = configFw as IntelligenceFramework;
        frameworkSource = 'config-default';
      }
    }
    if (!framework) {
      framework = this.opts.defaultFramework();
      frameworkSource = frameworkSource === 'global-default' ? 'global-default' : frameworkSource;
    }

    // ── model arm ────────────────────────────────────────────────────────
    let model: string | undefined;
    let modelTier: ProfileModelTier | null = null;
    let modelSource = 'account-default';

    const localBinding = this.opts.localModelBinding(key);
    if (localBinding && framework === 'codex-cli') {
      // §5.2 — a local binding is provider-level and wins the model arm.
      model = localBinding.model ?? undefined;
      modelSource = 'local-model-binding';
    } else if (pin?.model != null) {
      // Read-time re-validation against the CURRENT enum (§10.2).
      const err = validateModelId(pin.model, framework);
      if (err === null) {
        model = pin.model;
        modelSource = 'profile-pin';
        this.clearTransition(key, 'model-pin-invalid');
      } else {
        const notice = this.onceNotice(
          key,
          'model-pin-invalid',
          `this topic's pinned model is no longer available (${err.reason}) — using the default model until you re-pin`,
        );
        if (notice) notices.push(notice);
        this.opts.audit?.({ type: 'fallback', reason: 'model-pin-invalid', topic: key, failure: err.failure });
      }
    } else if (pin?.modelTier != null) {
      // A tier pin resolves server-side through FABLE's tier resolver
      // (closed-enum by construction; null = account default, honest no-op).
      const resolved = resolveTierModel(framework, pin.modelTier, this.opts.tierEscalationConfig());
      modelTier = pin.modelTier;
      if (resolved) {
        model = resolved;
        modelSource = 'profile-tier-pin';
      }
    }
    if (model === undefined && modelSource === 'account-default') {
      const configDefaults = this.opts.configProfileDefaults()[key];
      if (configDefaults?.model) {
        const err = validateModelId(configDefaults.model, framework);
        if (err === null) {
          model = configDefaults.model;
          modelSource = 'topicProfiles-config-default';
          this.clearTransition(key, 'config-model-invalid');
        } else {
          const notice = this.onceNotice(
            key,
            'config-model-invalid',
            `the configured default model for this topic isn't valid (${err.reason}) — falling through`,
          );
          if (notice) notices.push(notice);
          this.opts.audit?.({ type: 'fallback', reason: 'config-model-invalid', topic: key, failure: err.failure });
        }
      }
    }
    if (model === undefined && modelSource === 'account-default') {
      const fwDefault = this.opts.frameworkDefaultModels()[framework];
      if (fwDefault) {
        model = fwDefault;
        modelSource = 'frameworkDefaultModels';
      }
    }

    // ── thinking arm ─────────────────────────────────────────────────────
    let thinkingMode: ThinkingMode | undefined;
    let thinkingSource = 'unset';
    if (pin?.thinkingMode != null) {
      thinkingMode = pin.thinkingMode;
      thinkingSource = 'profile-pin';
    } else {
      const configDefaults = this.opts.configProfileDefaults()[key];
      const configThinking = configDefaults?.thinkingMode;
      if (configThinking) {
        if (['off', 'low', 'medium', 'high', 'max'].includes(configThinking)) {
          thinkingMode = configThinking as ThinkingMode;
          thinkingSource = 'topicProfiles-config-default';
        } else {
          const notice = this.onceNotice(
            key,
            'config-thinking-invalid',
            `the configured default thinking mode for this topic isn't valid — ignoring it`,
          );
          if (notice) notices.push(notice);
          this.opts.audit?.({ type: 'fallback', reason: 'config-thinking-invalid', topic: key });
        }
      }
    }

    // ── effort arm (claude `--effort` direct pin) ────────────────────────
    // FAIL-OPEN: any stored/config value not in the closed enum resolves to
    // undefined (no `--effort` passed). Resolution never throws and never
    // hands the CLI a value it would reject (e.g. a legacy 'ultracode' pin).
    let effort: EffortLevel | undefined;
    let effortSource = 'unset';
    if (pin?.effort != null) {
      if ((EFFORT_LEVELS as readonly string[]).includes(pin.effort)) {
        effort = pin.effort;
        effortSource = 'profile-pin';
        this.clearTransition(key, 'effort-pin-invalid');
      } else {
        const notice = this.onceNotice(
          key,
          'effort-pin-invalid',
          `this topic's pinned effort level is no longer valid — ignoring it`,
        );
        if (notice) notices.push(notice);
        this.opts.audit?.({ type: 'fallback', reason: 'effort-pin-invalid', topic: key });
      }
    } else {
      const configDefaults = this.opts.configProfileDefaults()[key];
      const configEffort = configDefaults?.effort;
      if (configEffort) {
        if ((EFFORT_LEVELS as readonly string[]).includes(configEffort)) {
          effort = configEffort as EffortLevel;
          effortSource = 'topicProfiles-config-default';
        } else {
          const notice = this.onceNotice(
            key,
            'config-effort-invalid',
            `the configured default effort level for this topic isn't valid — ignoring it`,
          );
          if (notice) notices.push(notice);
          this.opts.audit?.({ type: 'fallback', reason: 'config-effort-invalid', topic: key });
        }
      }
    }

    return {
      framework,
      model,
      modelTier,
      thinkingMode,
      effort,
      // §9 — honor-on-read covers the escalation arm even when the feature
      // flag is off; absent = 'inherit' (the mandate stays in force).
      escalationOverride: pin?.escalationOverride ?? 'inherit',
      sources: { framework: frameworkSource, model: modelSource, thinkingMode: thinkingSource, effort: effortSource },
      notices,
    };
  }

  /**
   * §5.2 cheap/cached launchability: fs.existsSync on the resolved binary
   * path with a TTL — never an unconditional per-spawn subprocess.
   */
  private isLaunchable(framework: IntelligenceFramework): boolean {
    const cached = this.launchabilityCache.get(framework);
    if (cached && Date.now() - cached.at < LAUNCHABILITY_TTL_MS) return cached.ok;
    // Fail toward "launchable" whenever the check cannot actually verify
    // absence: this check is a cheap SIGNAL whose only job is to catch a
    // provably-missing binary before a dead pane; a pin must never be
    // re-routed on the checker's own blind spot (null path / unreadable
    // PATH). Genuinely broken CLIs are the §10.4 breaker's authority.
    let ok = true;
    try {
      const bin = this.opts.frameworkBinaryPath(framework);
      if (bin !== null) {
        if (bin.includes('/')) {
          ok = fs.existsSync(bin);
        } else {
          // Bare command name (e.g. claudePath: 'claude') — resolve via PATH.
          const pathEntries = (process.env.PATH ?? '').split(':').filter(Boolean);
          ok = pathEntries.length === 0
            ? true
            : pathEntries.some((dir) => fs.existsSync(`${dir}/${bin}`));
        }
      }
    } catch {
      // @silent-fallback-ok: deliberate fail-OPEN — this probe is only a
      // cheap missing-binary SIGNAL; a pin must never be re-routed because
      // the prober itself errored (null path, unreadable PATH, fs error).
      // A genuinely broken CLI is the §10.4 breaker's authority, not this
      // check's — see the comment block above.
      ok = true;
    }
    this.launchabilityCache.set(framework, { ok, at: Date.now() });
    return ok;
  }

  /** Once-per-(topic,pin,reason) transition dedupe (§5.2 round-3). */
  private onceNotice(topicKey: string, reason: string, text: string): string | null {
    const dedupeKey = `${topicKey}|${reason}`;
    if (this.disclosedFallbacks.has(dedupeKey)) return null;
    this.disclosedFallbacks.add(dedupeKey);
    return text;
  }

  /** The condition cleared — re-arm the notice for a future recurrence. */
  private clearTransition(topicKey: string, reason: string): void {
    this.disclosedFallbacks.delete(`${topicKey}|${reason}`);
  }
}
