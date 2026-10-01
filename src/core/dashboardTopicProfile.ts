/**
 * Dashboard door + model controls (docs/specs/dashboard-door-model-controls.md).
 *
 * The pieces the three dashboard writes share, kept out of routes.ts so each is
 * unit-testable on its own:
 *  - `buildTopicProfileOptions` — GET /topic-profile/options (§3.1): the door
 *    INVENTORY plus a `selectable` verdict computed by running every
 *    `{framework, model}` through the SAME predicate the writes use.
 *  - `validateDashboardProfileChoice` — the ONE dashboard write predicate
 *    (§3.5): `validateProfileFields` + `enabledFrameworks` membership +
 *    `availability !== 'unavailable'`. Conversational and /topic-profile/:id
 *    pins keep their fail-open behavior; only the three dashboard writes are
 *    stricter (an intentional, machine-readable divergence).
 *  - `NewTopicDefaultStore` — state/new-topic-default-profile.json (§3.2).
 *  - `seedTopicProfileAtCreation` — the ONLY seeding code (§3.5): validate →
 *    `mutateIfAbsent` → regime filter (the model axis is DROPPED, never
 *    shadowed, outside fully-live) → audit → one disclosure line, only when
 *    the store answered `seeded`.
 *  - The pool seam contract (§3.3 2b): `SessionPoolLocalClaim` answers
 *    `dark | not-authoritative | ready`, consumed only through
 *    `claimDashboardCreatedTopic` / `settleDashboardCreatedTopic`. The CAS,
 *    journal emit, nonce, confirm and release live in server.ts next to the
 *    router (routes never call `cas`).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { IntelligenceFramework } from './intelligenceProviderFactory.js';
import { SUPPORTED_FRAMEWORKS } from './TopicFrameworksStore.js';
import { KNOWN_MODEL_IDS } from './ModelTierEscalation.js';
import { PER_TOKEN_LANE_MODEL_IDS, validateProfileFields } from './topicProfileValidation.js';
import { FRAMEWORK_DISPLAY_NAMES } from './IdentityRenderer.js';
import { atomicWriteFileSync } from './hostSemaphoreCore.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import type { DoorAdmissibility, DoorAvailability } from './TopicProfileResolver.js';
import type { ProfileWriteRegime } from './topicProfileWriteSurface.js';
import type { CasResult } from './SessionOwnershipRegistry.js';
import type { OwnershipAction } from './SessionOwnership.js';

export type TopicProfileRegimeName = 'fully-live' | 'dry-run' | 'disabled';

export function regimeName(r: ProfileWriteRegime): TopicProfileRegimeName {
  if (!r.enabled) return 'disabled';
  return r.dryRun ? 'dry-run' : 'fully-live';
}

export function frameworkLabel(framework: string): string {
  return FRAMEWORK_DISPLAY_NAMES[framework] ?? framework;
}

// ── the ONE dashboard write predicate (§3.5) ──────────────────────────────

export interface DashboardChoiceDeps {
  /** `config.enabledFrameworks` — unset means every supported door. */
  enabledFrameworks: () => readonly string[] | undefined;
  /** Tri-state door admissibility (TopicProfileResolver.doorAdmissibility). */
  doorAdmissibility: (framework: IntelligenceFramework) => DoorAdmissibility;
}

export type DashboardChoiceRefusal = {
  ok: false;
  code: 'invalid-framework' | 'invalid-model' | 'framework-not-enabled' | 'dashboard-unavailable-door';
  reason: string;
  /** Present on the intentional divergence: chat / API pins still accept it. */
  chatPinAllowed?: true;
};

export type DashboardChoiceResult =
  | { ok: true; framework: IntelligenceFramework; model: string | null }
  | DashboardChoiceRefusal;

export function validateDashboardProfileChoice(
  deps: DashboardChoiceDeps,
  choice: { framework: unknown; model?: unknown },
): DashboardChoiceResult {
  if (typeof choice.framework !== 'string') {
    return { ok: false, code: 'invalid-framework', reason: '"framework" is required (string)' };
  }
  if (choice.model !== undefined && choice.model !== null && typeof choice.model !== 'string') {
    return { ok: false, code: 'invalid-model', reason: '"model" must be a string or null' };
  }
  const model = (choice.model ?? null) as string | null;
  const checked = validateProfileFields({ framework: choice.framework, model }, 'claude-code');
  if (!checked.ok) {
    return {
      ok: false,
      code: checked.error.field === 'framework' ? 'invalid-framework' : 'invalid-model',
      reason: checked.error.reason,
    };
  }
  const framework = choice.framework as IntelligenceFramework;
  const enabled = deps.enabledFrameworks();
  if (enabled && !enabled.includes(framework)) {
    return {
      ok: false,
      code: 'framework-not-enabled',
      reason: `${frameworkLabel(framework)} is not enabled on this agent (enabledFrameworks)`,
    };
  }
  const adm = deps.doorAdmissibility(framework);
  if (adm.availability === 'unavailable') {
    const why = adm.reason === 'grok-interactive-ungated'
      ? `${frameworkLabel(framework)} needs the interactive-sessions opt-in on this machine`
      : `${frameworkLabel(framework)} isn't installed on this machine`;
    return {
      ok: false,
      code: 'dashboard-unavailable-door',
      chatPinAllowed: true,
      reason: `${why} — you can still pin it in chat and it will fall back with a notice`,
    };
  }
  return { ok: true, framework, model };
}

// ── GET /topic-profile/options (§3.1) ─────────────────────────────────────

export interface NewTopicDefaultRecord {
  framework: IntelligenceFramework;
  model: string | null;
  updatedAt: string;
  updatedBy: string;
}

export interface TopicProfileOptionsDeps extends DashboardChoiceDeps {
  frameworkDefaultModels: () => Partial<Record<string, string>>;
  regime: () => ProfileWriteRegime;
  newTopicDefault: () => NewTopicDefaultRecord | null;
}

export interface DoorOption {
  framework: IntelligenceFramework;
  label: string;
  available: boolean;
  availability: DoorAvailability;
  reason: string | null;
  /** True iff `{framework, model: null}` passes the dashboard write predicate. */
  selectable: boolean;
  /** Present when the door is not selectable but a chat/API pin would still be accepted. */
  chatOnly?: true;
  models: string[];
  defaultModel: string | null;
  defaultModelDropped?: string;
}

export interface TopicProfileOptions {
  regime: TopicProfileRegimeName;
  doors: DoorOption[];
  newTopicDefault: {
    framework: IntelligenceFramework | null;
    model: string | null;
    updatedAt: string | null;
    updatedBy: string | null;
    replication: 'local-only';
  };
}

export function buildTopicProfileOptions(deps: TopicProfileOptionsDeps): TopicProfileOptions {
  const enabled = deps.enabledFrameworks();
  const inventory = SUPPORTED_FRAMEWORKS.filter((fw) => !enabled || enabled.includes(fw));
  const fwDefaults = deps.frameworkDefaultModels();
  const doors: DoorOption[] = inventory.map((framework) => {
    const adm = deps.doorAdmissibility(framework);
    const denied = new Set(PER_TOKEN_LANE_MODEL_IDS[framework] ?? []);
    const known = (KNOWN_MODEL_IDS as Record<string, readonly string[]>)[framework] ?? [];
    // Only the pairs that pass the write predicate are offered.
    const models = known.filter(
      (m) => !denied.has(m) && validateDashboardProfileChoice(deps, { framework, model: m }).ok,
    );
    const nullChoice = validateDashboardProfileChoice(deps, { framework, model: null });
    const door: DoorOption = {
      framework,
      label: frameworkLabel(framework),
      available: adm.availability !== 'unavailable',
      availability: adm.availability,
      reason: nullChoice.ok ? adm.reason : nullChoice.reason,
      selectable: nullChoice.ok,
      ...(!nullChoice.ok && nullChoice.chatPinAllowed ? { chatOnly: true as const } : {}),
      models,
      defaultModel: null,
    };
    // defaultModel is NORMALIZED through the same check — never offered or
    // preselected when the configured default would be refused.
    const configured = fwDefaults[framework];
    if (configured) {
      const check = validateDashboardProfileChoice(deps, { framework, model: configured });
      if (check.ok) door.defaultModel = configured;
      else door.defaultModelDropped = check.reason;
    }
    return door;
  });
  const def = deps.newTopicDefault();
  return {
    regime: regimeName(deps.regime()),
    doors,
    newTopicDefault: {
      framework: def?.framework ?? null,
      model: def?.model ?? null,
      updatedAt: def?.updatedAt ?? null,
      updatedBy: def?.updatedBy ?? null,
      replication: 'local-only',
    },
  };
}

// ── the new-topic default record (§3.2) ───────────────────────────────────

export class NewTopicDefaultStore {
  readonly filePath: string;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, 'state', 'new-topic-default-profile.json');
  }

  /** Read live. A missing or unreadable file means "no default" — nothing changes anywhere. */
  read(): NewTopicDefaultRecord | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch {
      // @silent-fallback-ok: absent file IS the "no default set" state (§3.2).
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<NewTopicDefaultRecord>;
      if (typeof parsed.framework !== 'string' || !(SUPPORTED_FRAMEWORKS as readonly string[]).includes(parsed.framework)) {
        return null;
      }
      return {
        framework: parsed.framework as IntelligenceFramework,
        model: typeof parsed.model === 'string' ? parsed.model : null,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
        updatedBy: typeof parsed.updatedBy === 'string' ? parsed.updatedBy : '',
      };
    } catch {
      // @silent-fallback-ok: a corrupt record reads as "no default" — the
      // create path then behaves exactly as today; the next save rewrites it.
      return null;
    }
  }

  write(record: NewTopicDefaultRecord): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    atomicWriteFileSync(this.filePath, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o644,
      operation: 'new-topic-default-profile:write',
    });
  }

  /** `{clear:true}` deletes the record — absence is the "no default" state. */
  clear(): boolean {
    if (!fs.existsSync(this.filePath)) return false;
    SafeFsExecutor.safeUnlinkSync(this.filePath, { operation: 'new-topic-default-profile:clear' });
    return true;
  }
}

// ── the creation seed service (§3.2 / §3.5) ───────────────────────────────

export type CreationSeedSource = 'dashboard-create' | 'new-topic-default';

export interface CreationSeedDeps extends DashboardChoiceDeps {
  store: {
    mutateIfAbsent(
      topicKey: string,
      seed: { framework: IntelligenceFramework; model?: string | null; updatedBy: string },
    ): Promise<'seeded' | 'present'>;
  };
  regime: () => ProfileWriteRegime;
  audit: (event: Record<string, unknown>) => void;
  /** Fire-and-forget disclosure line (fixed template, deterministic producer). */
  disclose: (topicKey: string, text: string) => Promise<unknown>;
}

export type CreationSeedResult =
  | { outcome: 'seeded'; framework: IntelligenceFramework; model: string | null; modelDropped: TopicProfileRegimeName | null }
  | { outcome: 'present' }
  | DashboardChoiceRefusal & { outcome: 'refused' };

export async function seedTopicProfileAtCreation(
  deps: CreationSeedDeps,
  topicKey: string,
  source: CreationSeedSource,
  explicit: { framework: unknown; model?: unknown },
): Promise<CreationSeedResult> {
  // §3.5 validation INSIDE the service — the store checks only tier/model exclusion.
  const valid = validateDashboardProfileChoice(deps, explicit);
  if (!valid.ok) return { ...valid, outcome: 'refused' };
  const regime = regimeName(deps.regime());
  // The model axis follows the regime: live only under fully-live, otherwise
  // DROPPED (never shadowed). The framework axis is live in every regime.
  const modelDropped = valid.model !== null && regime !== 'fully-live' ? regime : null;
  const model = modelDropped ? null : valid.model;
  const updatedBy = `system:${source}`;
  const outcome = await deps.store.mutateIfAbsent(topicKey, { framework: valid.framework, model, updatedBy });
  deps.audit({
    type: 'creation-seed',
    outcome,
    topic: topicKey,
    principal: updatedBy,
    framework: valid.framework,
    model,
    ...(modelDropped ? { note: `model-not-applied:${modelDropped}`, droppedModel: valid.model } : {}),
  });
  if (outcome === 'present') return { outcome: 'present' };
  const text = model
    ? `This topic starts on ${frameworkLabel(valid.framework)} · ${model} — chosen at creation`
    : modelDropped
      ? `This topic starts on ${frameworkLabel(valid.framework)} — chosen at creation (model not applied on this install)`
      : `This topic starts on ${frameworkLabel(valid.framework)} — chosen at creation`;
  // A held or slow send never blocks the create; the audit row is the record.
  void deps.disclose(topicKey, text).catch(() => {
    /* @silent-fallback-ok: the disclosure line is the courtesy; the audit row above is the durable record (§3.2) */
  });
  return { outcome: 'seeded', framework: valid.framework, model, modelDropped };
}

// ── the pool seam (§3.3 2b) ───────────────────────────────────────────────

export interface ReadyPoolClaimOps {
  place(sessionKey: string): { ok: boolean; reason?: string };
  confirm(sessionKey: string): boolean;
  release(sessionKey: string): boolean;
}

export interface DashboardPoolClaimOpsDeps {
  /** The AUTHORITATIVE ownership registry (the router's). */
  ownershipRegistry: {
    read(sessionKey: string): { ownerMachineId: string } | null;
    cas(action: OwnershipAction, ctx: { sessionKey: string; sender: string; nonce: string }): CasResult;
  };
  selfMachineId: string;
  /** The router's nonce stream (`${self}:${kind}:${++routerNonce}`). */
  nextNonce: (kind: 'c' | 'rel') => string;
  /** The coherence-journal emit — every cas pairs with it. */
  emitPlacement: (sessionKey: string, r: CasResult, reason: 'placed' | 'released', prevOwner?: string) => void;
  /** The existing local-claim confirm (claims only a self-owned `placing` record). */
  confirmLocal: (sessionKey: string) => boolean;
}

/**
 * The `ready` ops over the authoritative registry (§3.3 2b). place = self-place
 * + journal emit; confirm = the local-claim closure; release =
 * confirm-if-placing → release → journal emit (release from `placing` is
 * refused by the FSM, hence the confirm first).
 */
export function createDashboardPoolClaimOps(deps: DashboardPoolClaimOpsDeps): ReadyPoolClaimOps {
  const self = deps.selfMachineId;
  return {
    place: (sk) => {
      const prevOwner = deps.ownershipRegistry.read(sk)?.ownerMachineId;
      const r = deps.ownershipRegistry.cas({ type: 'place', machineId: self }, { sessionKey: sk, sender: self, nonce: deps.nextNonce('c') });
      deps.emitPlacement(sk, r, 'placed', prevOwner);
      return r.ok ? { ok: true } : { ok: false, reason: r.reason };
    },
    confirm: (sk) => deps.confirmLocal(sk),
    release: (sk) => {
      deps.confirmLocal(sk);
      const prevOwner = deps.ownershipRegistry.read(sk)?.ownerMachineId;
      const r = deps.ownershipRegistry.cas({ type: 'release', machineId: self }, { sessionKey: sk, sender: self, nonce: deps.nextNonce('rel') });
      deps.emitPlacement(sk, r, 'released', prevOwner);
      return r.ok;
    },
  };
}

export type SessionPoolLocalClaimAnswer =
  | { kind: 'dark' }
  | { kind: 'not-authoritative'; holderMachineId: string | null; holderNickname: string | null }
  | ({ kind: 'ready' } & ReadyPoolClaimOps);

export interface SessionPoolLocalClaimInputs {
  /** `_sessionRouter && _sessionPoolStage() !== 'dark'` — evaluated at call time. */
  routerLive: () => boolean;
  /** Placement replication (boot snapshot). */
  replicationOn: boolean;
  /** NULLABLE: null when no lease coordinator exists (never treated as "holds"). */
  holdsLease: (() => boolean) | null;
  holder: () => { machineId: string | null; nickname: string | null };
  ops: ReadyPoolClaimOps;
}

/**
 * The seam's predicate (§3.3 2b). `ready` only when router-live AND
 * replication on AND this machine holds the lease; a null lease accessor is
 * `not-authoritative` with a null holder — never the fail-open `: true`.
 */
export function evaluateSessionPoolLocalClaim(inputs: SessionPoolLocalClaimInputs): SessionPoolLocalClaimAnswer {
  if (!inputs.routerLive()) return { kind: 'dark' };
  if (inputs.holdsLease === null) {
    return { kind: 'not-authoritative', holderMachineId: null, holderNickname: null };
  }
  if (!inputs.replicationOn || !inputs.holdsLease()) {
    const h = inputs.holder();
    return { kind: 'not-authoritative', holderMachineId: h.machineId, holderNickname: h.nickname };
  }
  return { kind: 'ready', ...inputs.ops };
}

export type DashboardClaimResult =
  | { kind: 'dark' }
  | { kind: 'placed'; ops: ReadyPoolClaimOps }
  | { kind: 'not-authoritative'; holderMachineId: string | null; holderNickname: string | null }
  | { kind: 'refused'; reason: string };

/**
 * Place ownership for a topic the handler just CREATED (never on reuse).
 * Re-evaluates the seam at this moment: a lease that moved since the
 * pre-creation check answers `not-authoritative`.
 */
export function claimDashboardCreatedTopic(
  seam: (() => SessionPoolLocalClaimAnswer) | undefined,
  sessionKey: string,
): DashboardClaimResult {
  const answer = seam?.() ?? { kind: 'dark' as const };
  if (answer.kind === 'dark') return { kind: 'dark' };
  if (answer.kind === 'not-authoritative') return answer;
  const r = answer.place(sessionKey);
  return r.ok
    ? { kind: 'placed', ops: { place: answer.place, confirm: answer.confirm, release: answer.release } }
    : { kind: 'refused', reason: r.reason ?? 'place-refused' };
}

/**
 * Settle a placement made by `claimDashboardCreatedTopic`, with the SAME ops
 * that placed it. `spawn-threw` ⇒ release (confirm-if-placing → release →
 * journal); every other outcome ⇒ confirm — a live or in-flight local
 * session must keep its record (releasing would invite the duplicate 2b
 * prevents). A `dark` claim has nothing to settle.
 */
export function settleDashboardCreatedTopic(
  claim: DashboardClaimResult,
  sessionKey: string,
  outcome: 'spawned' | 'register-failed' | 'spawn-in-flight' | 'spawn-threw',
): 'confirmed' | 'released' | 'unsettled' | 'none' {
  if (claim.kind !== 'placed') return 'none';
  if (outcome === 'spawn-threw') return claim.ops.release(sessionKey) ? 'released' : 'unsettled';
  return claim.ops.confirm(sessionKey) ? 'confirmed' : 'unsettled';
}

// ── the spawn thunk (§3.3 steps 4+5) ──────────────────────────────────────

export type SpawnForTopicResult =
  | { ok: true; session: string; registered: true }
  | { ok: true; session: string; registered: false; registerError: string }
  | { ok: false; code: 'topic-has-session' | 'topic-spawning' | 'telegram-routing-not-wired' };

export interface SpawnForTopicDeps {
  /** Late-bound spawningTopics guard — null until Telegram routing wires. */
  guard: () => { has(topic: number): boolean; add(topic: number): string; clear(topic: number, token: string): void } | null;
  /** The Telegram adapter's binding surface — null when no adapter. */
  telegram: () => { getSessionForTopic(topicId: number): string | null | undefined; registerTopicSession(topicId: number, session: string, name?: string): void } | null;
  /** The ONE spawn chokepoint, called with silentStart. A throw propagates. */
  spawn: (topicId: number, name: string) => Promise<string>;
}

/**
 * Spawn a just-created topic through the chokepoint AND register its binding,
 * both under ONE spawningTopics token cleared in `finally`. Mirrors the inbound
 * "no session mapped" gate first, then has() → add() with NO await between
 * them (add() overwrites and never refuses a duplicate, so has() is the guard).
 */
export function createSpawnForTopic(deps: SpawnForTopicDeps): (topicId: number, name: string) => Promise<SpawnForTopicResult> {
  return async (topicId, name) => {
    const guard = deps.guard();
    const tg = deps.telegram();
    if (!guard || !tg) return { ok: false, code: 'telegram-routing-not-wired' };
    if (tg.getSessionForTopic(topicId)) return { ok: false, code: 'topic-has-session' };
    if (guard.has(topicId)) return { ok: false, code: 'topic-spawning' };
    const token = guard.add(topicId);
    try {
      const session = await deps.spawn(topicId, name);
      try {
        tg.registerTopicSession(topicId, session, name);
        return { ok: true, session, registered: true };
      } catch (err) {
        return { ok: true, session, registered: false, registerError: err instanceof Error ? err.message : String(err) };
      }
    } finally {
      guard.clear(topicId, token);
    }
  };
}
