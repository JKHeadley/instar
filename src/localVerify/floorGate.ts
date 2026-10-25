/**
 * The floor follows what GitHub actually enforces (spec
 * docs/specs/local-verify-merge-authority.md §4 "The floor follows what GitHub
 * actually enforces", §3 "Floor selection is one function", Rollback).
 *
 * Each reconcile pass reads two non-admin endpoints:
 *   GET /repos/{o}/{r}/rules/branches/main  (ruleset rules)        — edit A
 *   GET /repos/{o}/{r}/branches/main        (classic protection)   — edit B
 * plus `current_user_can_bypass` from GET /repos/{o}/{r}/rulesets/{id}.
 *
 * The `local` floor is EFFECTIVE only when the ruleset requires
 * `instar/local-verify` (no integration_id, strict off) AND classic protection has
 * no required contexts AND the agent cannot bypass the ruleset (`never`); otherwise
 * `awaiting-edit-a` / `awaiting-edit-b` / `bypass-not-never` / `settings-unreadable`.
 * Neither endpoint requiring any status check ⇒ ONE HIGH signal.
 *
 * `floorFor(pr)` is the ONE floor-selection function, used by the status
 * projection now and by safe-merge (via the server) and the watcher later.
 * The mirror stays on whenever the check is required; unreadable ⇒ treated as
 * required — independent of `monitoring.localVerify.enabled`.
 *
 * Fail closed (2026-10-25): the CONFIGURED floor decides which authority may say
 * `success`. An eligible PR of a configured-local install is on the local floor
 * even while the settings are not (yet, or transiently not) effective — it then
 * carries a named `localHold()` and projects `pending`, never the Actions mirror.
 * On 2026-10-25T04:08:46Z one of the three settings reads (the ruleset bypass)
 * failed, `state()` read `settings-unreadable`, `floorFor` answered `actions`,
 * and the mirror posted `success · actions-floor green` on five heads the local
 * suite had never passed; GitHub's native auto-merge merged all five. The Actions
 * floor is for installs whose configured floor IS `actions` (and for ineligible
 * PRs, whose merge authority was never local).
 */

import { LOCAL_VERIFY_STATUS_CONTEXT, type FloorMode } from './statusProjection.js';

/** The `instar-main-protection` ruleset (current_user_can_bypass is readable without admin). */
export const MAIN_PROTECTION_RULESET_ID = 15247386;

export type FloorSettingsState =
  | 'effective'
  | 'awaiting-edit-a'
  | 'awaiting-edit-b'
  | 'bypass-not-never'
  | 'settings-unreadable'
  | 'config-actions';

export interface FloorSettings {
  /** The ruleset requires instar/local-verify (any form); null = unreadable. */
  rulesetRequiresCheck: boolean | null;
  /** …and in the form edit A specifies (no integration_id, strict off). */
  rulesetEditA: boolean;
  /** Every context the ruleset requires (for the mirror's union). */
  rulesetContexts: string[];
  /** Classic protection's required contexts; null = unreadable. */
  classicContexts: string[] | null;
  /** `current_user_can_bypass`; null = unreadable. */
  bypass: string | null;
  /** True when both endpoints were read and neither requires any status check. */
  noRequiredChecksAnywhere: boolean;
}

/** Pure: parse the two endpoint bodies + the bypass value. */
export function evaluateFloorSettings(rules: unknown, branch: unknown, bypass: string | null): FloorSettings {
  let rulesetRequiresCheck: boolean | null = null;
  let rulesetEditA = false;
  let rulesetContexts: string[] = [];
  if (Array.isArray(rules)) {
    rulesetRequiresCheck = false;
    rulesetContexts = [];
    for (const rule of rules as Array<Record<string, unknown>>) {
      if (rule?.type !== 'required_status_checks') continue;
      const params = (rule.parameters ?? {}) as { required_status_checks?: Array<{ context?: string; integration_id?: number | null }>; strict_required_status_checks_policy?: boolean };
      for (const c of params.required_status_checks ?? []) {
        if (typeof c?.context !== 'string') continue;
        rulesetContexts.push(c.context);
        if (c.context === LOCAL_VERIFY_STATUS_CONTEXT) {
          rulesetRequiresCheck = true;
          if ((c.integration_id === undefined || c.integration_id === null) && params.strict_required_status_checks_policy !== true) rulesetEditA = true;
        }
      }
    }
  }
  // Classic protection: `protected: false` is the only "requires nothing" answer.
  // `protected: true` without a readable `protection` block (or no `protected`
  // field at all) is unreadable — never read as "no required contexts".
  let classicContexts: string[] | null = null;
  if (branch && typeof branch === 'object') {
    const b = branch as { protected?: boolean; protection?: { enabled?: boolean; required_status_checks?: { contexts?: unknown; checks?: Array<{ context?: string }> } | null } };
    if (b.protected === false) {
      classicContexts = [];
    } else if (b.protection && typeof b.protection === 'object') {
      const rsc = b.protection.required_status_checks;
      const set = new Set<string>();
      if (rsc && Array.isArray(rsc.contexts)) for (const c of rsc.contexts) if (typeof c === 'string') set.add(c);
      if (rsc && Array.isArray(rsc.checks)) for (const c of rsc.checks) if (typeof c?.context === 'string') set.add(c.context);
      classicContexts = [...set];
    }
  }
  const noRequiredChecksAnywhere = rulesetRequiresCheck !== null && classicContexts !== null
    && rulesetContexts.length === 0 && classicContexts.length === 0;
  return { rulesetRequiresCheck, rulesetEditA, rulesetContexts, classicContexts, bypass, noRequiredChecksAnywhere };
}

/** Pure: the settings state for a configured floor. */
export function floorSettingsState(s: FloorSettings, configFloor: FloorMode): FloorSettingsState {
  if (configFloor !== 'local') return 'config-actions';
  if (s.rulesetRequiresCheck === null || s.classicContexts === null || s.bypass === null) return 'settings-unreadable';
  if (!s.rulesetEditA) return 'awaiting-edit-a';
  if (s.classicContexts.length > 0) return 'awaiting-edit-b';
  if (s.bypass !== 'never') return 'bypass-not-never';
  return 'effective';
}

export interface FloorGateSeams {
  /** GET /repos/{o}/{r}/rules/branches/main → parsed array; null on read failure. */
  readRulesBranches(): Promise<unknown | null>;
  /** GET /repos/{o}/{r}/branches/main → parsed object; null on read failure. */
  readBranch(): Promise<unknown | null>;
  /** GET /repos/{o}/{r}/rulesets/{id} → `current_user_can_bypass`; null on read failure. */
  readRulesetBypass(): Promise<string | null>;
  now(): number;
  signal?(key: string, detail: Record<string, unknown>): void;
  audit(event: Record<string, unknown>): void;
}

export interface FloorGateConfig {
  repo: string;
  /** `monitoring.greenPrAutoMerge.floor`, read live. */
  configFloor(): FloorMode;
  /** `monitoring.greenPrAutoMerge.repo`, read live. */
  watcherRepo(): string;
}

export class FloorGate {
  private settings: FloorSettings | null = null;
  private lastReadAt: number | null = null;
  private lastState: FloorSettingsState | null = null;
  private readonly raised = new Set<string>();

  constructor(private readonly cfg: FloorGateConfig, private readonly seams: FloorGateSeams) {}

  async refresh(): Promise<FloorSettings> {
    const [rules, branch, bypass] = await Promise.all([
      this.seams.readRulesBranches().catch(() => null),
      this.seams.readBranch().catch(() => null),
      this.seams.readRulesetBypass().catch(() => null),
    ]);
    const s = evaluateFloorSettings(rules, branch, bypass);
    this.settings = s;
    this.lastReadAt = this.seams.now();
    const state = this.state();
    if (state !== this.lastState) {
      this.seams.audit({ event: 'floor-settings', state, from: this.lastState, rulesetRequiresCheck: s.rulesetRequiresCheck, classicContexts: s.classicContexts?.length ?? null, bypass: s.bypass });
      this.lastState = state;
    }
    if (s.noRequiredChecksAnywhere) this.raise('local-verify:no-required-checks', { severity: 'HIGH' });
    else this.raised.delete('local-verify:no-required-checks');
    if (this.cfg.configFloor() === 'local' && s.bypass !== null && s.bypass !== 'never') this.raise('local-verify:bypass-not-never', { bypass: s.bypass });
    else if (s.bypass === 'never') this.raised.delete('local-verify:bypass-not-never');
    return s;
  }

  private raise(key: string, detail: Record<string, unknown>): void {
    if (this.raised.has(key)) return;
    this.raised.add(key);
    this.seams.audit({ event: 'signal', key, ...detail });
    try { this.seams.signal?.(key, detail); } catch { /* @silent-fallback-ok: a sink failure never changes the floor */ }
  }

  state(): FloorSettingsState {
    if (!this.settings) return this.cfg.configFloor() === 'local' ? 'settings-unreadable' : 'config-actions';
    return floorSettingsState(this.settings, this.cfg.configFloor());
  }

  /**
   * True when GitHub requires `instar/local-verify` — through the ruleset OR classic
   * protection. Unreadable ⇒ true (the mirror stays on).
   */
  checkRequired(): boolean {
    const known = this.checkRequiredKnown();
    return known === null ? true : known;
  }

  /** Required (true), readably not required (false), or unknown (null). */
  checkRequiredKnown(): boolean | null {
    const s = this.settings;
    if (!s) return null;
    if (s.rulesetRequiresCheck === true || (s.classicContexts ?? []).includes(LOCAL_VERIFY_STATUS_CONTEXT)) return true;
    if (s.rulesetRequiresCheck === null || s.classicContexts === null) return null;
    return false;
  }

  /** The two settings endpoints (rules + branch) were both read on the last refresh. */
  settingsReadable(): boolean {
    return !!this.settings && this.settings.rulesetRequiresCheck !== null && this.settings.classicContexts !== null;
  }

  /** The configured floor is local for this install's repo (config local, the watcher's repo is this repo). */
  configuredLocal(): boolean {
    return this.cfg.configFloor() === 'local' && this.cfg.repo === this.cfg.watcherRepo();
  }

  /**
   * The single floor-selection function (§3). The CONFIGURED floor decides: an
   * eligible PR of a configured-local install is on the local floor whether or not
   * GitHub's settings are effective right now — see `localHold()` for the latter.
   * A settings state other than `effective` never moves a PR onto the Actions mirror.
   */
  floorFor(pr: { repo: string; eligible: boolean }): FloorMode {
    return this.configuredLocal() && pr.repo === this.cfg.repo && pr.eligible ? 'local' : 'actions';
  }

  /**
   * Why the local floor cannot vouch for a head right now: the settings state when
   * it is not `effective` (`settings-unreadable`, `awaiting-edit-a`, …); null when
   * effective or when the configured floor is not local. The projection turns a
   * hold into `pending · local-floor-held:<reason>` — never into the mirror.
   */
  localHold(): string | null {
    if (!this.configuredLocal()) return null;
    const state = this.state();
    return state === 'effective' ? null : state;
  }

  /** Contexts the mirror unions in (excluding instar/local-verify, done by the projection). */
  contexts(): { protectionContexts: string[]; rulesetContexts: string[] } {
    return { protectionContexts: this.settings?.classicContexts ?? [], rulesetContexts: this.settings?.rulesetContexts ?? [] };
  }

  status(): { state: FloorSettingsState; configFloor: FloorMode; checkRequired: boolean; settings: FloorSettings | null; lastReadAt: string | null } {
    return {
      state: this.state(), configFloor: this.cfg.configFloor(), checkRequired: this.checkRequired(), settings: this.settings,
      lastReadAt: this.lastReadAt === null ? null : new Date(this.lastReadAt).toISOString(),
    };
  }
}
