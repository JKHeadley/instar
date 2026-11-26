/**
 * One agent-wide record of the system topics (📢 Updates, 🔔 Attention,
 * 🩺 Agent Health).
 *
 * Only the machine holding the serving lease may CREATE a system topic. Every
 * other machine ADOPTS the holder's topic ids: it reads them from the holder's
 * `GET /telegram/system-topics` and records them through
 * `StateManager.adoptSystemTopicId`, the one write a read-only standby is
 * allowed for these keys. Before this, a standby that had never saved an id
 * created a fresh topic on every boot, could not save it (standby state is
 * read-only), and created another on the next boot — one machine minted 41
 * "Updates" topics that way.
 */
import { SYSTEM_TOPIC_STATE_KEYS } from '../core/StateManager.js';

export type SystemTopicKind = keyof typeof SYSTEM_TOPIC_STATE_KEYS;
export type SystemTopicIds = Partial<Record<SystemTopicKind, number>>;
export const SYSTEM_TOPIC_KINDS = Object.keys(SYSTEM_TOPIC_STATE_KEYS) as SystemTopicKind[];

function topicId(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 1 ? value : undefined;
}

/** This machine's recorded system topic ids (absent kinds omitted). */
export function readSystemTopicIds(get: (key: string) => unknown): SystemTopicIds {
  const ids: SystemTopicIds = {};
  for (const kind of SYSTEM_TOPIC_KINDS) {
    let raw: unknown;
    try { raw = get(SYSTEM_TOPIC_STATE_KEYS[kind]); } catch { raw = undefined; } // @silent-fallback-ok — an unreadable key reads as absent
    const id = topicId(raw);
    if (id !== undefined) ids[kind] = id;
  }
  return ids;
}

/** Validate a peer's `GET /telegram/system-topics` body; anything malformed is dropped. */
export function parseSystemTopicIds(raw: unknown): SystemTopicIds {
  const ids: SystemTopicIds = {};
  const body = raw && typeof raw === 'object' ? (raw as { topics?: unknown }).topics : undefined;
  if (!body || typeof body !== 'object') return ids;
  for (const kind of SYSTEM_TOPIC_KINDS) {
    const id = topicId((body as Record<string, unknown>)[kind]);
    if (id !== undefined) ids[kind] = id;
  }
  return ids;
}

/** The pure core: which kinds differ from the holder's record (absent remote kinds never clear a local id). */
export function planAdoption(local: SystemTopicIds, remote: SystemTopicIds): Array<{ kind: SystemTopicKind; topicId: number }> {
  const plan: Array<{ kind: SystemTopicKind; topicId: number }> = [];
  for (const kind of SYSTEM_TOPIC_KINDS) {
    const id = remote[kind];
    if (id !== undefined && local[kind] !== id) plan.push({ kind, topicId: id });
  }
  return plan;
}

export type SystemTopicAdoptionOutcome =
  | 'holder' | 'no-holder' | 'fetch-failed' | 'holder-has-none' | 'unchanged' | 'adopted';

export interface SystemTopicAdoptionDeps {
  /** True while this machine holds the serving lease (it owns the record). */
  holdsLease: () => boolean;
  /** The current lease holder's machine id, or null when unresolved. */
  leaseHolder: () => string | null;
  selfMachineId: string;
  /** Read the holder's system topic ids (throws or resolves malformed on failure). */
  fetchHolder: (holderMachineId: string) => Promise<unknown>;
  get: (key: string) => unknown;
  adopt: (key: string, topicId: number) => void;
  /** Run on the holder each pass: a machine that booted as standby and was promoted
   * later still gets its own topics ensured (the boot ensure* ran read-only). */
  ensureOwn?: () => Promise<void>;
  log?: (line: string) => void;
}

/**
 * Converge this machine's system topic ids onto the lease holder's. A no-op on
 * the holder itself. Never creates a topic, never clears a local id the holder
 * does not report, and never throws.
 */
export async function adoptHolderSystemTopics(deps: SystemTopicAdoptionDeps): Promise<{ outcome: SystemTopicAdoptionOutcome; adopted: SystemTopicKind[] }> {
  let holds = false;
  try { holds = deps.holdsLease(); } catch { holds = false; } // @silent-fallback-ok — an unreadable lease is treated as standby; adoption never creates anything
  if (holds) {
    try { await deps.ensureOwn?.(); }
    catch (err) { deps.log?.(`[system-topics] ensuring own system topics failed: ${err instanceof Error ? err.message : String(err)}`); }
    return { outcome: 'holder', adopted: [] };
  }
  let holder: string | null = null;
  try { holder = deps.leaseHolder(); } catch { holder = null; } // @silent-fallback-ok — no holder ⇒ nothing to adopt yet; retried next pass
  if (!holder || holder === deps.selfMachineId) return { outcome: 'no-holder', adopted: [] };
  let remote: SystemTopicIds;
  try { remote = parseSystemTopicIds(await deps.fetchHolder(holder)); }
  catch (err) {
    deps.log?.(`[system-topics] could not read the lease holder's system topics: ${err instanceof Error ? err.message : String(err)}`);
    return { outcome: 'fetch-failed', adopted: [] };
  }
  if (Object.keys(remote).length === 0) return { outcome: 'holder-has-none', adopted: [] };
  const adopted: SystemTopicKind[] = [];
  for (const { kind, topicId } of planAdoption(readSystemTopicIds(deps.get), remote)) {
    try { deps.adopt(SYSTEM_TOPIC_STATE_KEYS[kind], topicId); adopted.push(kind); }
    catch (err) { deps.log?.(`[system-topics] could not record adopted ${kind} topic ${topicId}: ${err instanceof Error ? err.message : String(err)}`); }
  }
  if (adopted.length) deps.log?.(`[system-topics] adopted the lease holder's ${adopted.map(k => `${k}=${remote[k]}`).join(', ')}`);
  return { outcome: adopted.length ? 'adopted' : 'unchanged', adopted };
}

/**
 * The anti-thrash brake: a holder whose record keeps CHANGING is a defect to
 * surface, not a signal to follow. Each kind may be re-adopted at most this
 * many times per boot; past it the loop refuses, logs once, and holds the last
 * adopted id (the convergence model is `system-topic-adoption` in
 * src/testing/selfActionRegistry.ts).
 */
export const MAX_ADOPTS_PER_KIND_PER_BOOT = 3;
/** Wrap `adopt` with the per-kind cap. Pure: the model and the loop share it. */
export function withAdoptionBrake(adopt: SystemTopicAdoptionDeps['adopt'], log?: (line: string) => void, max = MAX_ADOPTS_PER_KIND_PER_BOOT): SystemTopicAdoptionDeps['adopt'] {
  const counts = new Map<string, number>();
  return (key, topicId) => {
    const n = counts.get(key) ?? 0;
    if (n >= max) {
      if (n === max) { counts.set(key, n + 1); log?.(`[system-topics] ${key} changed ${max} times since boot — holding the last adopted id; the holder's record is flapping`); }
      return;
    }
    counts.set(key, n + 1);
    /* @self-action-controller: system-topic-adoption */
    adopt(key, topicId);
  };
}

/** Re-adopt on a cadence so a lease move or a holder-side record change converges. */
export const SYSTEM_TOPIC_ADOPTION_INTERVAL_MS = 30 * 60_000;
export const SYSTEM_TOPIC_ADOPTION_FIRST_DELAY_MS = 20_000;
/**
 * Until the first pass that actually READ the holder's record, a pass that could
 * not (no lease holder known yet right after boot, the holder unreachable, or an
 * empty answer) is retried on this short delay instead of waiting a full
 * interval. Bounded: after `SYSTEM_TOPIC_ADOPTION_MAX_SHORT_RETRIES` the loop
 * falls back to the cadence. (Mama PC, 2026-10-20: the +20 s pass ran before
 * the lease holder was resolved, so adoption only landed at +30 min.)
 */
export const SYSTEM_TOPIC_ADOPTION_RETRY_MS = 2 * 60_000;
export const SYSTEM_TOPIC_ADOPTION_MAX_SHORT_RETRIES = 10;
const RETRY_OUTCOMES: ReadonlySet<SystemTopicAdoptionOutcome> = new Set(['no-holder', 'fetch-failed', 'holder-has-none']);

/** Run `adoptHolderSystemTopics` once shortly after boot, then on a cadence. Returns a stop function. */
export function startSystemTopicAdoptionLoop(deps: SystemTopicAdoptionDeps, timing: { firstDelayMs?: number; intervalMs?: number; retryMs?: number; maxShortRetries?: number } = {}): () => void {
  const braked: SystemTopicAdoptionDeps = { ...deps, adopt: withAdoptionBrake(deps.adopt, deps.log) };
  const retryMs = timing.retryMs ?? SYSTEM_TOPIC_ADOPTION_RETRY_MS;
  const maxShortRetries = timing.maxShortRetries ?? SYSTEM_TOPIC_ADOPTION_MAX_SHORT_RETRIES;
  let running = false, stopped = false, shortRetries = 0, converged = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const tick = () => {
    if (running || stopped) return;
    running = true;
    void adoptHolderSystemTopics(braked).then(result => {
      if (stopped || converged) return;
      if (!RETRY_OUTCOMES.has(result.outcome)) { converged = true; return; }
      if (shortRetries >= maxShortRetries) return; // the cadence owns it from here
      shortRetries += 1;
      retry = setTimeout(tick, retryMs); // a READ retry; the adopt emit above carries the controller marker
      retry.unref?.();
    }).finally(() => { running = false; });
  };
  const first = setTimeout(tick, timing.firstDelayMs ?? SYSTEM_TOPIC_ADOPTION_FIRST_DELAY_MS);
  const every = setInterval(tick, timing.intervalMs ?? SYSTEM_TOPIC_ADOPTION_INTERVAL_MS);
  first.unref?.(); every.unref?.();
  return () => { stopped = true; clearTimeout(first); clearInterval(every); if (retry) clearTimeout(retry); };
}
