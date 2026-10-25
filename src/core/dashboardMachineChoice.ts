/**
 * dashboardMachineChoice — the Machine pick in the dashboard New Session box
 * (docs/specs/dashboard-new-session-machine-choice.md).
 *
 * `resolveCreateMachineChoice` is the pure resolver behind the optional
 * `machine` field on POST /sessions/create. It maps the operator's pick
 * (a nickname or a machineId) onto auto / this machine / another machine, or a
 * refusal that is answered BEFORE anything is created. It reuses the same
 * nickname set the "move this to <nickname>" path uses, so a name that works
 * for a move works here.
 */

import { buildRelocationNicknameSet } from './RelocationNicknameSet.js';
import { resolveSelfNickname } from './SelfNicknameResolver.js';

/** The minimal capacity shape the resolver reads (a MachineCapacity subset). */
export interface MachineChoiceCapacity {
  machineId: string;
  nickname?: string;
  online?: boolean;
  quotaState?: { blocked?: boolean } | null;
}

export type CreateMachineChoice =
  | { kind: 'auto' }
  | { kind: 'self'; machineId: string; nickname: string }
  | { kind: 'remote'; machineId: string; nickname: string; quotaBlocked: boolean }
  | { kind: 'error'; status: 400 | 404 | 409; code: 'machine-invalid' | 'unknown-machine' | 'machine-offline'; error: string; known?: string[] };

/** True when the request carries a machine pick at all (absent / '' / 'auto' ⇒ Automatic). */
export function hasMachinePick(machine: unknown): boolean {
  if (machine === undefined || machine === null) return false;
  if (typeof machine !== 'string') return true; // a non-string is a pick — and a malformed one
  const m = machine.trim().toLowerCase();
  return m !== '' && m !== 'auto';
}

export function resolveCreateMachineChoice(opts: {
  machine: unknown;
  selfMachineId: string | null;
  capacities: readonly MachineChoiceCapacity[];
}): CreateMachineChoice {
  const { machine, selfMachineId, capacities } = opts;
  if (!hasMachinePick(machine)) return { kind: 'auto' };
  if (typeof machine !== 'string' || machine.length > 128) {
    return { kind: 'error', status: 400, code: 'machine-invalid', error: '"machine" must be a machine nickname or id (a string)' };
  }
  const want = machine.trim();
  const selfNickname = resolveSelfNickname({ selfMachineId, localCapacities: capacities });
  const { nickToMachine, knownNicknames } = buildRelocationNicknameSet({ capacities, selfMachineId, selfNickname });
  const machineId = nickToMachine.get(want.toLowerCase())
    ?? (capacities.some((c) => c.machineId === want) || want === selfMachineId ? want : null);
  if (!machineId) {
    return {
      kind: 'error',
      status: 404,
      code: 'unknown-machine',
      error: `There is no machine called "${want}". Known: ${knownNicknames.join(', ') || '(none)'}`,
      known: knownNicknames,
    };
  }
  const cap = capacities.find((c) => c.machineId === machineId);
  const nickname = cap?.nickname?.trim() || (machineId === selfMachineId ? selfNickname : null) || machineId;
  if (machineId === selfMachineId) return { kind: 'self', machineId, nickname };
  if (cap?.online !== true) {
    return {
      kind: 'error',
      status: 409,
      code: 'machine-offline',
      error: `${nickname} is offline right now, so the topic was not created. Pick another machine or Automatic.`,
    };
  }
  return { kind: 'remote', machineId, nickname, quotaBlocked: cap.quotaState?.blocked === true };
}

// ── the remote start (spec §3.4 step 3) ──────────────────────────────────

/** The start command carried to the target inside a `deliverMessage` payload. */
export interface DashboardCreateStart {
  framework: string | null;
  model: string | null;
  source: 'dashboard-create' | 'new-topic-default' | null;
  machineNickname: string;
}

/** The outcome of ONE checked deliver: a definitive answer, or unknown. */
export type DeliverOutcome =
  | { kind: 'accepted' }
  | { kind: 'rejected'; detail: string }
  | { kind: 'unknown'; detail: string };

export interface StartTopicOnMachineDeps {
  /** The current ownership record, or null when never seen. */
  readOwnership: (sessionKey: string) => { status: string; ownerMachineId: string | null; ownershipEpoch: number } | null;
  /** One ownership CAS (with the router's nonce + journaling). */
  cas: (sessionKey: string, action: { type: 'place' | 'claim' | 'release'; machineId: string }) => { ok: boolean; epoch: number; reason?: string };
  /**
   * ONE checked deliverMessage to the target. `accepted` = the target recorded it
   * (`queued`, or `duplicate` — already recorded); `rejected` = the target (or its
   * mesh gate) definitively refused it; `unknown` = no definitive answer (timeout,
   * transport error, 5xx, missing ack) — the target MAY have started it.
   */
  deliver: (target: string, env: { sessionKey: string; messageId: string; payload: { dashboardCreate: DashboardCreateStart }; ownershipEpoch: number }) => Promise<DeliverOutcome>;
  nonce: () => string;
}

export type StartTopicOnMachineResult =
  | { ok: true; epoch: number; settled: boolean }
  | { ok: false; code: 'topic-owned-elsewhere'; reason: string }
  | { ok: false; code: 'start-failed'; error: string; released: boolean; settled: boolean }
  | { ok: false; code: 'start-unknown'; error: string; settled: boolean }
  /** The claim lost and the record now names ANOTHER owner (a lease move or a
   *  reconciler placed it during the deliver round trip): nothing here is pinned
   *  or posted — the new owner's placement stands. `delivered` says what the
   *  target was told, so the caller can say the target MAY also start it. */
  | { ok: false; code: 'start-superseded'; delivered: DeliverOutcome['kind']; ownerNow: string | null; epochNow: number; statusNow: string; error?: string };

/** Classify a mesh reply + ack for a deliverMessage into a DeliverOutcome. */
export function classifyDeliverReply(reply: { ok: boolean; status?: number; reason?: string; result?: unknown } | null, thrown?: unknown): DeliverOutcome {
  if (thrown !== undefined) return { kind: 'unknown', detail: thrown instanceof Error ? thrown.message : String(thrown) };
  if (!reply) return { kind: 'unknown', detail: 'no reply' };
  if (!reply.ok) {
    const status = reply.status ?? 0;
    const detail = `${status} ${reply.reason ?? ''}`.trim();
    // 4xx = the target's verify / RBAC / freshness / handler gate answered: definitive.
    // 408 comes from something BETWEEN the machines (a proxy/tunnel timeout): unknown.
    return status >= 400 && status < 500 && status !== 408 ? { kind: 'rejected', detail } : { kind: 'unknown', detail };
  }
  const accepted = reply.result && typeof reply.result === 'object' ? (reply.result as { accepted?: unknown }).accepted : undefined;
  if (accepted === 'queued' || accepted === 'duplicate') return { kind: 'accepted' };
  if (accepted === 'stale-ownership' || accepted === 'sender-rejected') return { kind: 'rejected', detail: String(accepted) };
  return { kind: 'unknown', detail: 'no ack' };
}

/**
 * place(target) → checked deliver → settle:
 *  - accepted ⇒ claim (active@target);
 *  - rejected ⇒ claim then release (and NO pin), so the record rests `released`,
 *    never `placing`, and the topic is free for ordinary placement;
 *  - unknown  ⇒ claim and KEEP (the target may be running it — releasing would
 *    deny a live session its record); the next real message forwards there.
 */
/** Extra deliver attempts after a THROWN one (same messageId). Bounded; see 3b. */
export const DELIVER_THROW_RETRIES = 2;
const DELIVER_RETRY_BACKOFF_MS = 250;

export async function startTopicOnMachine(
  deps: StartTopicOnMachineDeps,
  sessionKey: string,
  target: string,
  start: DashboardCreateStart,
  /** Write the topic's pin. Called once ownership is settled on the target, on an
   *  accepted or unknown start only: a target that definitively REFUSED the start is
   *  never pinned (a persistent refusal — a verify/RBAC gate — would strand every
   *  later message on it); the release leaves the topic unowned AND unpinned, so the
   *  next message is placed automatically. */
  pin?: () => Promise<boolean> | boolean,
): Promise<StartTopicOnMachineResult> {
  const cur = deps.readOwnership(sessionKey);
  if (cur && cur.status !== 'released') {
    return { ok: false, code: 'topic-owned-elsewhere', reason: `record-${cur.status}` };
  }
  const placed = deps.cas(sessionKey, { type: 'place', machineId: target });
  if (!placed.ok) return { ok: false, code: 'topic-owned-elsewhere', reason: placed.reason ?? 'place-refused' };
  // ONE checked deliver, retried with the SAME messageId only when the attempt
  // THREW (transport error / timeout) — the router's own L4 discipline, safe
  // because the target's receipt ledger answers `duplicate` for a copy it already
  // recorded (and `duplicate` is accepted). A reply that REACHED the target
  // (5xx / 408 / no ack) is not retried: the target may be mid-start.
  const messageId = `dashboard-create:${sessionKey}:${deps.nonce()}`;
  let outcome: DeliverOutcome = { kind: 'unknown', detail: 'not attempted' };
  for (let attempt = 0; attempt <= DELIVER_THROW_RETRIES; attempt++) {
    try {
      outcome = await deps.deliver(target, { sessionKey, messageId, payload: { dashboardCreate: start }, ownershipEpoch: placed.epoch });
      break;
    } catch (err) {
      outcome = { kind: 'unknown', detail: err instanceof Error ? err.message : String(err) };
      if (attempt < DELIVER_THROW_RETRIES) await new Promise((r) => setTimeout(r, DELIVER_RETRY_BACKOFF_MS * (attempt + 1)));
    }
  }
  // Settle: claim placing→active, retried once (a lost CAS must never leave a
  // resting `placing` record, which queues every later message).
  // Fenced by the placement GENERATION, not just the machine: our place landed at
  // `placed.epoch`; the one transition that confirms THIS placement is the claim at
  // `placed.epoch + 1` (ours, or the router's concurrent confirm). Every CAS bumps
  // the epoch by exactly one, so a newer placement — even onto the same target —
  // reads at another epoch and is never claimed, released or pinned from here.
  const ownGeneration = (r: { status: string; ownerMachineId: string | null; ownershipEpoch: number } | null): boolean =>
    !!r && r.ownerMachineId === target
    && ((r.status === 'placing' && r.ownershipEpoch === placed.epoch) || (r.status === 'active' && r.ownershipEpoch === placed.epoch + 1));
  let claimed = deps.cas(sessionKey, { type: 'claim', machineId: target });
  if (!claimed.ok) {
    const r = deps.readOwnership(sessionKey);
    if (r?.status === 'placing' && ownGeneration(r)) claimed = deps.cas(sessionKey, { type: 'claim', machineId: target });
  }
  const now = claimed.ok ? null : deps.readOwnership(sessionKey);
  if (!claimed.ok && !ownGeneration(now)) {
    // Superseded: the record is no longer this placement's generation (another
    // owner, a newer placement onto the same target, or released). The newer
    // record wins — nothing pinned, released or posted from here.
    return {
      ok: false, code: 'start-superseded', delivered: outcome.kind,
      ownerNow: now?.ownerMachineId ?? null, epochNow: now?.ownershipEpoch ?? placed.epoch, statusNow: now?.status ?? 'missing',
      ...(outcome.kind === 'rejected' ? { error: outcome.detail } : {}),
    };
  }
  // Our generation: `active@target` at placed.epoch+1 means the router's concurrent
  // confirm settled it for us; `placing@target` at placed.epoch is the unconfirmed case.
  const activeHere = claimed.ok || now?.status === 'active';
  const settled = activeHere;
  if (outcome.kind !== 'rejected') {
    try { await pin?.(); } catch { /* @silent-fallback-ok: the caller's pin reports its own failure (machine-pin-not-written notice) */ }
  }
  if (outcome.kind === 'accepted') return { ok: true, epoch: claimed.ok ? claimed.epoch : placed.epoch, settled };
  if (outcome.kind === 'unknown') return { ok: false, code: 'start-unknown', error: outcome.detail, settled };
  const released = activeHere ? deps.cas(sessionKey, { type: 'release', machineId: target }).ok : false;
  return { ok: false, code: 'start-failed', error: outcome.detail, released, settled: released };
}

/**
 * Owner-side recognizer for the start command. Accepts ONLY a payload OBJECT
 * shaped `{ dashboardCreate: {...} }` with no text — never a string (a queued
 * or typed JSON string is ordinary conversation text, not a command).
 */
export function parseDashboardCreatePayload(payload: unknown): DashboardCreateStart | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  if ('text' in p) return null;
  const keys = Object.keys(p);
  if (keys.length !== 1 || keys[0] !== 'dashboardCreate') return null;
  const d = p.dashboardCreate;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const r = d as Record<string, unknown>;
  const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
  const framework = r.framework == null ? null : str(r.framework, 64);
  if (r.framework != null && framework === null) return null;
  const model = r.model == null ? null : str(r.model, 128);
  if (r.model != null && model === null) return null;
  const source = r.source === 'dashboard-create' || r.source === 'new-topic-default' ? r.source : null;
  if (framework !== null && source === null) return null;
  const machineNickname = str(r.machineNickname, 128) ?? '';
  return { framework, model, source, machineNickname };
}

/** The machine-rename pattern (MachineIdentity): 1–40 letters, digits, spaces, hyphens. */
const NICKNAME_RE = /^[A-Za-z0-9 -]{1,40}$/;

/** A nickname safe to put in a Telegram notice; falls back to the machineId. */
export function safeMachineLabel(nickname: string | null | undefined, machineId: string): string {
  const n = (nickname ?? '').trim();
  return NICKNAME_RE.test(n) ? n : machineId;
}

// ── the owner-side start (spec §3.4 step 4) ──────────────────────────────

export interface DashboardCreateStartRunnerDeps {
  /** Telegram configured on this machine. */
  telegramReady: () => boolean;
  getSessionForTopic: (topicId: number) => string | null | undefined;
  isSessionAlive: (session: string) => boolean;
  topicName: (topicId: number) => string | null | undefined;
  /** The topic-profile seed deps, or null when the context is not wired yet. */
  seedDeps: () => import('./dashboardTopicProfile.js').CreationSeedDeps | null;
  seed: typeof import('./dashboardTopicProfile.js').seedTopicProfileAtCreation;
  /** The parent's spawn thunk (spawningTopics guard + binding), or null. */
  spawnForTopic: () => ((topicId: number, name: string) => Promise<import('./dashboardTopicProfile.js').SpawnForTopicResult>) | null;
  /** One fixed-template line into the topic (deterministic producer). */
  notice: (topicId: number, text: string) => void;
  audit: (event: Record<string, unknown>) => void;
  /** This machine's label for notices (already passed through safeMachineLabel). */
  selfLabel: () => string;
}

/**
 * Seed (re-validated here, disclosure suppressed — the creator posted the line)
 * then spawn silently. Every failure is posted into the topic and audited.
 */
export function createDashboardCreateStartRunner(deps: DashboardCreateStartRunnerDeps): (topicId: number, start: DashboardCreateStart) => Promise<void> {
  return async (topicId, start) => {
    const key = String(topicId);
    const audit = (e: Record<string, unknown>): void => {
      try { deps.audit({ type: 'dashboard-machine-start', topic: key, ...e }); } catch { /* observability */ }
    };
    if (!deps.telegramReady()) { audit({ outcome: 'no-telegram' }); return; }
    const existing = deps.getSessionForTopic(topicId);
    if (existing && deps.isSessionAlive(existing)) { audit({ outcome: 'session-already-live' }); return; }
    const label = deps.selfLabel();
    if (start.framework && start.source) {
      const sd = deps.seedDeps();
      if (!sd) {
        audit({ outcome: 'seed-skipped', reason: 'topic-profile-not-wired' });
        deps.notice(topicId, `The chosen door could not be applied on ${label} (door settings are not ready there yet); this topic starts on its default door.`);
      } else {
        try {
          const seed = await deps.seed({ ...sd, disclose: () => Promise.resolve(undefined) }, key, start.source, { framework: start.framework, model: start.model });
          audit({ outcome: `seed-${seed.outcome}`, framework: start.framework, model: start.model });
          if (seed.outcome === 'refused') {
            deps.notice(topicId, `The chosen door could not be applied on ${label} (${seed.reason}); this topic starts on its default door.`);
          } else if (seed.outcome === 'seeded' && seed.modelDropped) {
            deps.notice(topicId, `The chosen model is not applied on ${label} (${seed.modelDropped}); this topic starts on the chosen door with its default model.`);
          }
        } catch (err) {
          audit({ outcome: 'seed-threw', error: err instanceof Error ? err.message : String(err) });
          deps.notice(topicId, `The chosen door could not be recorded on ${label}; this topic starts on its default door.`);
        }
      }
    }
    const spawnFor = deps.spawnForTopic();
    if (!spawnFor) {
      audit({ outcome: 'spawn-not-wired' });
      deps.notice(topicId, `Couldn't start this session on ${label}: session start is not ready there yet. Send a message here to try again.`);
      return;
    }
    try {
      const spawned = await spawnFor(topicId, deps.topicName(topicId) ?? `topic-${topicId}`);
      if (!spawned.ok) {
        audit({ outcome: `spawn-${spawned.code}` });
        if (spawned.code === 'telegram-routing-not-wired') {
          deps.notice(topicId, `Couldn't start this session on ${label}: Telegram routing is not ready there yet. Send a message here to try again.`);
        }
        return;
      }
      audit({ outcome: spawned.registered ? 'started' : 'started-unregistered', session: spawned.session, ...(spawned.registered ? {} : { registerError: spawned.registerError }) });
      if (!spawned.registered) {
        // The session runs but is not bound to the topic: the next message would
        // start a second one. Say so, rather than leave the first orphaned silently.
        deps.notice(topicId, `The session started on ${label} but could not be bound to this topic; your next message here starts a fresh session there.`);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      audit({ outcome: 'spawn-threw', error: reason });
      deps.notice(topicId, `Couldn't start this session on ${label}: ${reason.slice(0, 200)}. Send a message here to try again.`);
    }
  };
}
