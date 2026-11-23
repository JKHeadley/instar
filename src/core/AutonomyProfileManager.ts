/**
 * AutonomyProfileManager — Unified self-evolution governance for Instar.
 *
 * Coordinates all autonomy-related subsystems through a single profile setting.
 * Users interact conversationally ("go autonomous", "supervise everything").
 * The agent translates intent into config changes via this manager.
 *
 * Four profiles: cautious → supervised → collaborative → autonomous
 * Each maps to defaults for: evolution, safety, trust, updates, agent autonomy.
 * Individual overrides take precedence over profile defaults.
 *
 * Part of the Adaptive Autonomy System spec.
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
  AutonomyProfileLevel,
  ResolvedAutonomyState,
  NotificationPreferences,
  InstarConfig,
  AgentAutonomyLevel,
} from './types.js';
import type { AdaptiveTrust, TrustElevationSuggestion } from './AdaptiveTrust.js';
import type { EvolutionManager } from './EvolutionManager.js';
import { orgCapRefusal, profileRaises, proofCovers, proposalHashOf, raiseRefusal, TrustRaiseRefusedError, type OperatorProof } from './TrustRaiseGuard.js';

// ── Profile Defaults ─────────────────────────────────────────────────

/** Discovery aggressiveness: how proactively the agent surfaces features */
export type DiscoveryAggressiveness = 'passive' | 'contextual' | 'proactive';

interface ProfileDefaults {
  evolutionApprovalMode: 'ai-assisted' | 'autonomous';
  safetyLevel: 1 | 2;
  agentAutonomyLevel: AgentAutonomyLevel;
  autoApplyUpdates: boolean;
  autoRestart: boolean;
  trustAutoElevate: boolean;
  /** How aggressively to surface undiscovered features */
  discoveryAggressiveness: DiscoveryAggressiveness;
}

export const PROFILE_DEFAULTS: Record<AutonomyProfileLevel, ProfileDefaults> = {
  cautious: {
    evolutionApprovalMode: 'ai-assisted',
    safetyLevel: 1,
    agentAutonomyLevel: 'supervised',
    autoApplyUpdates: false,
    autoRestart: false,
    trustAutoElevate: false,
    discoveryAggressiveness: 'passive',      // Only on user request (pull-only)
  },
  supervised: {
    evolutionApprovalMode: 'ai-assisted',
    safetyLevel: 1,
    agentAutonomyLevel: 'supervised',
    autoApplyUpdates: true,
    autoRestart: false,
    trustAutoElevate: true,
    discoveryAggressiveness: 'contextual',   // Surface when problem matches
  },
  collaborative: {
    evolutionApprovalMode: 'ai-assisted',
    safetyLevel: 1,
    agentAutonomyLevel: 'collaborative',
    autoApplyUpdates: true,
    autoRestart: true,
    trustAutoElevate: true,
    discoveryAggressiveness: 'proactive',    // Full evaluator triggers
  },
  autonomous: {
    evolutionApprovalMode: 'autonomous',
    safetyLevel: 2,
    agentAutonomyLevel: 'autonomous',
    autoApplyUpdates: true,
    autoRestart: true,
    trustAutoElevate: true,
    discoveryAggressiveness: 'proactive',    // Full evaluator triggers
  },
};

// ── Autonomy State Persistence ───────────────────────────────────────

interface AutonomyStateFile {
  profile: AutonomyProfileLevel;
  setAt: string;
  setBy: 'user' | 'system' | 'earned' | 'org-policy';
  notifications: NotificationPreferences;
  /** Track profile change history for trust recovery */
  history: Array<{
    from: AutonomyProfileLevel;
    to: AutonomyProfileLevel;
    at: string;
    reason: string;
  }>;
}

// ── Manager ──────────────────────────────────────────────────────────

export class AutonomyProfileManager {
  private stateDir: string;
  private statePath: string;
  private state: AutonomyStateFile;
  private config: InstarConfig;
  private adaptiveTrust: AdaptiveTrust | null;
  private evolution: EvolutionManager | null;

  /** The organization's independence cap, read live from the applied pack (docs/specs/org-pack-and-join.md §D). */
  private orgCap: (() => { level: AutonomyProfileLevel; orgName: string } | null) | null;

  constructor(opts: {
    stateDir: string;
    config: InstarConfig;
    adaptiveTrust?: AdaptiveTrust | null;
    evolution?: EvolutionManager | null;
    orgCap?: () => { level: AutonomyProfileLevel; orgName: string } | null;
  }) {
    this.orgCap = opts.orgCap ?? null;
    this.stateDir = opts.stateDir;
    this.statePath = path.join(opts.stateDir, 'state', 'autonomy-profile.json');
    this.config = opts.config;
    this.adaptiveTrust = opts.adaptiveTrust ?? null;
    this.evolution = opts.evolution ?? null;
    this.state = this.loadOrCreate();
  }

  // ── Public API ───────────────────────────────────────────────────

  /**
   * Get the current autonomy profile level.
   */
  getProfile(): AutonomyProfileLevel {
    return this.state.profile;
  }

  /**
   * Get the fully resolved autonomy state (profile defaults + config overrides).
   */
  getResolvedState(): ResolvedAutonomyState {
    const defaults = PROFILE_DEFAULTS[this.state.profile];

    return {
      profile: this.state.profile,
      // Config overrides take precedence over profile defaults
      evolutionApprovalMode:
        (this.config.evolution as unknown as Record<string, unknown> | undefined)?.approvalMode as 'ai-assisted' | 'autonomous'
        ?? defaults.evolutionApprovalMode,
      safetyLevel: this.config.safety?.level ?? defaults.safetyLevel,
      agentAutonomyLevel: this.config.agentAutonomy?.level ?? defaults.agentAutonomyLevel,
      autoApplyUpdates: this.config.updates?.autoApply ?? defaults.autoApplyUpdates,
      autoRestart: (this.config.updates as unknown as Record<string, unknown> | undefined)?.autoRestart as boolean
        ?? defaults.autoRestart,
      trustAutoElevate:
        this.config.externalOperations?.trust?.autoElevateEnabled ?? defaults.trustAutoElevate,
      discoveryAggressiveness:
        (this.config as unknown as Record<string, unknown>).discoveryAggressiveness as 'passive' | 'contextual' | 'proactive'
        ?? defaults.discoveryAggressiveness,
    };
  }

  /**
   * Set the autonomy profile. Returns the new resolved state.
   * This is the main entry point for conversational autonomy changes.
   */
  /** Durable change-log hook (trust-journey 6a): told of every switch, with the proof for a raise. */
  private changeObserver: ((from: AutonomyProfileLevel, to: AutonomyProfileLevel, proof: OperatorProof | null) => void) | null = null;
  setChangeObserver(fn: ((from: AutonomyProfileLevel, to: AutonomyProfileLevel, proof: OperatorProof | null) => void) | null): void { this.changeObserver = fn; }

  setProfile(level: AutonomyProfileLevel, reason: string, proof?: OperatorProof | null): ResolvedAutonomyState {
    const oldProfile = this.state.profile;
    // An organization's cap holds even against a valid proof (org-pack-and-join §D).
    const cap = this.orgCap?.() ?? null;
    if (cap && profileRaises(cap.level, level).length > 0) {
      throw new TrustRaiseRefusedError(orgCapRefusal(cap));
    }
    // A profile whose permissions are wider than the current one is a raise (trust-journey
    // decision 4): it needs the person's proof for this exact switch.
    const raises = profileRaises(oldProfile, level);
    if (raises.length > 0 && !proofCovers(proof, proposalHashOf({ kind: 'autonomy-profile', from: oldProfile, to: level }))) {
      throw new TrustRaiseRefusedError(raiseRefusal(raises));
    }

    this.state.history.push({
      from: oldProfile,
      to: level,
      at: new Date().toISOString(),
      reason,
    });

    // Keep history manageable
    if (this.state.history.length > 50) {
      this.state.history = this.state.history.slice(-50);
    }

    this.state.profile = level;
    this.state.setAt = new Date().toISOString();
    this.state.setBy = 'user';
    this.save();

    // Apply profile defaults to config file
    this.applyProfileToConfig(level);
    try { this.changeObserver?.(oldProfile, level, proof ?? null); } catch { /* @silent-fallback-ok: the writer reports its own failures */ }

    return this.getResolvedState();
  }

  /**
   * Lower the profile to an organization's cap (org-pack-and-join §D). A narrowing, so no proof.
   * Returns the previous profile when it lowered, or null when already at or below the cap.
   */
  lowerForOrgPolicy(cap: AutonomyProfileLevel, orgName: string): AutonomyProfileLevel | null {
    const from = this.state.profile;
    if (profileRaises(cap, from).length === 0) return null;
    this.state.history.push({ from, to: cap, at: new Date().toISOString(), reason: `Lowered by ${orgName}'s policy` });
    if (this.state.history.length > 50) this.state.history = this.state.history.slice(-50);
    this.state.profile = cap;
    this.state.setAt = new Date().toISOString();
    this.state.setBy = 'org-policy';
    this.save();
    this.applyProfileToConfig(cap);
    return from;
  }

  /**
   * Clamp the three authority settings to an organization's cap (org-pack-and-join §D): any of
   * `safety.level`, `agentAutonomy.level` and `evolution.approvalMode` set looser than the cap
   * profile's value, explicitly or not, is rewritten in config.json. Returns the previous values of
   * the ones it changed (for restore on leave), or null when nothing changed.
   */
  /** The three authority settings as config.json holds them now (staged before an org apply). */
  authoritySettings(): Record<string, unknown> {
    const configPath = path.join(this.stateDir, 'config.json');
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, Record<string, unknown> | undefined>;
      const out: Record<string, unknown> = {};
      if (raw.safety?.level !== undefined) out['safety.level'] = raw.safety.level;
      if (raw.agentAutonomy?.level !== undefined) out['agentAutonomy.level'] = raw.agentAutonomy.level;
      if (raw.evolution?.approvalMode !== undefined) out['evolution.approvalMode'] = raw.evolution.approvalMode;
      return out;
    } catch { return {}; } // @silent-fallback-ok — no config means nothing to restore
  }

  clampForOrgPolicy(cap: AutonomyProfileLevel): Record<string, unknown> | null {
    const configPath = path.join(this.stateDir, 'config.json');
    if (!fs.existsSync(configPath)) return null;
    const d = PROFILE_DEFAULTS[cap];
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, Record<string, unknown> | undefined>;
    const order = ['supervised', 'collaborative', 'autonomous'];
    const prev: Record<string, unknown> = {};
    const safety = (raw.safety ??= {});
    if (typeof safety.level === 'number' && safety.level > d.safetyLevel) { prev['safety.level'] = safety.level; safety.level = d.safetyLevel; }
    const aa = (raw.agentAutonomy ??= {});
    if (typeof aa.level === 'string' && order.indexOf(aa.level) > order.indexOf(d.agentAutonomyLevel)) { prev['agentAutonomy.level'] = aa.level; aa.level = d.agentAutonomyLevel; }
    const evo = (raw.evolution ??= {});
    if (evo.approvalMode === 'autonomous' && d.evolutionApprovalMode !== 'autonomous') { prev['evolution.approvalMode'] = evo.approvalMode; evo.approvalMode = d.evolutionApprovalMode; }
    if (Object.keys(prev).length === 0) return null;
    fs.writeFileSync(configPath, JSON.stringify(raw, null, 2));
    // The running server reads these from memory too: apply the clamp there now, not at the next restart.
    const live = this.config as unknown as Record<string, Record<string, unknown> | undefined>;
    if ('safety.level' in prev) (live.safety ??= {}).level = d.safetyLevel;
    if ('agentAutonomy.level' in prev) (live.agentAutonomy ??= {}).level = d.agentAutonomyLevel;
    if ('evolution.approvalMode' in prev) (live.evolution ??= {}).approvalMode = d.evolutionApprovalMode;
    return prev;
  }

  /** Put back clamped settings on leave, each only if it still holds the cap's value (unchanged since). */
  restoreClampedSettings(prev: Record<string, unknown>, cap: AutonomyProfileLevel): void {
    const configPath = path.join(this.stateDir, 'config.json');
    if (!fs.existsSync(configPath)) return;
    const d = PROFILE_DEFAULTS[cap];
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, Record<string, unknown> | undefined>;
    if ('safety.level' in prev && raw.safety?.level === d.safetyLevel) raw.safety.level = prev['safety.level'];
    if ('agentAutonomy.level' in prev && raw.agentAutonomy?.level === d.agentAutonomyLevel) raw.agentAutonomy.level = prev['agentAutonomy.level'];
    if ('evolution.approvalMode' in prev && raw.evolution?.approvalMode === d.evolutionApprovalMode) raw.evolution.approvalMode = prev['evolution.approvalMode'];
    fs.writeFileSync(configPath, JSON.stringify(raw, null, 2));
    const live = this.config as unknown as Record<string, Record<string, unknown> | undefined>;
    if (raw.safety && live.safety) live.safety.level = raw.safety.level;
    if (raw.agentAutonomy && live.agentAutonomy) live.agentAutonomy.level = raw.agentAutonomy.level;
    if (raw.evolution && live.evolution) live.evolution.approvalMode = raw.evolution.approvalMode;
  }

  /**
   * Undo an organization's lowering when the agent leaves (org-pack-and-join §D, "On leave"): puts
   * back the saved profile only if the profile is still exactly where the policy left it (`setBy`
   * 'org-policy' at the cap). It restores what the person already had; it is never a new raise.
   */
  restoreAfterOrgPolicy(previous: AutonomyProfileLevel, cap: AutonomyProfileLevel): boolean {
    if (this.state.setBy !== 'org-policy' || this.state.profile !== cap) return false;
    this.state.history.push({ from: cap, to: previous, at: new Date().toISOString(), reason: 'Organization left: restored' });
    if (this.state.history.length > 50) this.state.history = this.state.history.slice(-50);
    this.state.profile = previous;
    this.state.setAt = new Date().toISOString();
    this.state.setBy = 'user';
    this.save();
    this.applyProfileToConfig(previous);
    return true;
  }

  /**
   * Get a natural language summary of the current autonomy state.
   * This is what the agent shows when users ask "what's my autonomy setup?"
   */
  getNaturalLanguageSummary(): string {
    const resolved = this.getResolvedState();
    const lines: string[] = [];

    lines.push(`Profile: ${resolved.profile}`);

    // Evolution
    const evoLabel = resolved.evolutionApprovalMode === 'autonomous'
      ? 'autonomous (I approve my own evolution proposals, you get notified)'
      : 'ai-assisted (I propose, you approve)';
    lines.push(`Evolution: ${evoLabel}`);

    // Safety
    const safetyLabel = resolved.safetyLevel === 2
      ? 'self-verifying (I reason about risky commands before running them)'
      : 'ask-first (I check with you before risky commands)';
    lines.push(`Safety: ${safetyLabel}`);

    // Updates
    const updateParts: string[] = [];
    updateParts.push(resolved.autoApplyUpdates ? 'auto-apply on' : 'manual updates');
    updateParts.push(resolved.autoRestart ? 'auto-restart on' : 'manual restart');
    lines.push(`Updates: ${updateParts.join(', ')}`);

    // Discovery
    const discoveryLabel = resolved.discoveryAggressiveness === 'passive'
      ? 'passive (only on user request)'
      : resolved.discoveryAggressiveness === 'contextual'
      ? 'contextual (surface when problem matches)'
      : 'proactive (full evaluator triggers)';
    lines.push(`Feature discovery: ${discoveryLabel}`);

    // Trust
    if (this.adaptiveTrust) {
      const summary = this.adaptiveTrust.getSummary();
      lines.push('');
      lines.push('Trust status:');
      lines.push(summary);
    }

    // Pending elevations
    const elevations = this.getPendingElevations();
    if (elevations.length > 0) {
      lines.push('');
      lines.push('Elevation opportunities:');
      for (const e of elevations) {
        lines.push(`  ${e.service} ${e.operation}: ${e.currentLevel} -> ${e.suggestedLevel} (${e.reason})`);
      }
    }

    // Evolution stats
    if (this.evolution) {
      const dashboard = this.evolution.getDashboard();
      const proposed = dashboard.evolution.byStatus['proposed'] ?? 0;
      if (proposed > 0) {
        lines.push('');
        lines.push(`Pending evolution proposals: ${proposed}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Get all pending trust elevation suggestions.
   */
  getPendingElevations(): TrustElevationSuggestion[] {
    if (!this.adaptiveTrust) return [];
    return this.adaptiveTrust.getPendingElevations();
  }

  /**
   * Get the notification preferences.
   */
  getNotificationPreferences(): NotificationPreferences {
    return { ...this.state.notifications };
  }

  /**
   * Update notification preferences.
   */
  setNotificationPreferences(prefs: Partial<NotificationPreferences>): void {
    this.state.notifications = { ...this.state.notifications, ...prefs };
    this.save();
  }

  /**
   * Get the profile change history.
   */
  getHistory(): AutonomyStateFile['history'] {
    return [...this.state.history];
  }

  /**
   * Get a complete dashboard view suitable for API responses.
   */
  getDashboard(): {
    profile: AutonomyProfileLevel;
    resolved: ResolvedAutonomyState;
    summary: string;
    elevations: TrustElevationSuggestion[];
    notifications: NotificationPreferences;
    history: AutonomyStateFile['history'];
    availableProfiles: Array<{ level: AutonomyProfileLevel; description: string }>;
  } {
    return {
      profile: this.state.profile,
      resolved: this.getResolvedState(),
      summary: this.getNaturalLanguageSummary(),
      elevations: this.getPendingElevations(),
      notifications: this.getNotificationPreferences(),
      history: this.state.history.slice(-10),
      availableProfiles: [
        { level: 'cautious', description: 'I want to see and approve everything' },
        { level: 'supervised', description: 'Handle routine stuff, ask me about important things' },
        { level: 'collaborative', description: 'Work together — I trust your judgment on most things' },
        { level: 'autonomous', description: 'Handle everything yourself, just keep me informed' },
      ],
    };
  }

  // ── Private ──────────────────────────────────────────────────────

  /**
   * Apply profile defaults to the config.json file.
   * Only sets values that aren't already explicitly overridden.
   */
  private applyProfileToConfig(level: AutonomyProfileLevel): void {
    const configPath = path.join(this.stateDir, 'config.json');
    if (!fs.existsSync(configPath)) return;

    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const defaults = PROFILE_DEFAULTS[level];

      // Set the profile itself
      raw.autonomyProfile = level;

      // Apply defaults where not explicitly set
      // Safety
      if (!raw.safety) raw.safety = {};
      raw.safety.level = raw.safety.level ?? defaults.safetyLevel;

      // Updates
      if (!raw.updates) raw.updates = {};
      raw.updates.autoApply = raw.updates.autoApply ?? defaults.autoApplyUpdates;
      raw.updates.autoRestart = raw.updates.autoRestart ?? defaults.autoRestart;

      // Agent autonomy
      if (!raw.agentAutonomy) raw.agentAutonomy = {};
      raw.agentAutonomy.level = raw.agentAutonomy.level ?? defaults.agentAutonomyLevel;

      // External operations trust
      if (raw.externalOperations) {
        if (!raw.externalOperations.trust) raw.externalOperations.trust = {};
        raw.externalOperations.trust.autoElevateEnabled =
          raw.externalOperations.trust.autoElevateEnabled ?? defaults.trustAutoElevate;
      }

      fs.writeFileSync(configPath, JSON.stringify(raw, null, 2));
    } catch {
      // Config write failure is non-fatal — state file still tracks the profile
    }
  }

  private loadOrCreate(): AutonomyStateFile {
    if (fs.existsSync(this.statePath)) {
      try {
        return JSON.parse(fs.readFileSync(this.statePath, 'utf-8'));
      } catch {
        // Corrupt — recreate
      }
    }

    // Derive initial profile from existing config
    const initial = this.deriveProfileFromConfig();
    return {
      profile: initial,
      setAt: new Date().toISOString(),
      setBy: 'system',
      notifications: {
        evolutionDigest: 'immediate',
        trustElevationSuggestions: true,
        migrationNotifications: true,
      },
      history: [],
    };
  }

  /** The profile this agent's config gives when no profile was ever set (the narrowing target after a new lease run). */
  configuredDefaultProfile(): AutonomyProfileLevel { return this.deriveProfileFromConfig(); }

  /**
   * Infer the autonomy profile from existing config settings.
   * Used when first creating the autonomy state (backward compatibility).
   */
  private deriveProfileFromConfig(): AutonomyProfileLevel {
    // If explicitly set in config, use it
    if (this.config.autonomyProfile) return this.config.autonomyProfile;

    // Otherwise infer from existing settings
    const safety = this.config.safety?.level ?? 1;
    const autonomy = this.config.agentAutonomy?.level ?? 'collaborative';
    const autoApply = this.config.updates?.autoApply ?? true;

    if (safety === 2 && autonomy === 'autonomous') return 'autonomous';
    if (autonomy === 'collaborative' && autoApply) return 'collaborative';
    if (autonomy === 'supervised') return 'supervised';
    if (!autoApply) return 'cautious';

    return 'collaborative'; // sensible default
  }

  private save(): void {
    try {
      const dir = path.dirname(this.statePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
    } catch {
      // Non-fatal — state save should never break the system
    }
  }
}
