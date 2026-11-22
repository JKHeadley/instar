/**
 * SEC-157: the encrypted stored copy of a Secret Drop submission has an absolute age limit.
 *
 * A submission is persisted (encrypted) so it survives a restart before the agent uses it. Before this
 * change nothing ever removed an unused copy, and the retrieve fallback returned one of any age, so a
 * secret the agent never consumed stayed on disk, retrievable, forever. Now a copy older than
 * {@link DURABLE_DROP_MAX_AGE_MS} (or with no readable receive time) is treated as gone: the fallback
 * deletes it instead of returning it, and a sweep removes every such copy at startup and on each new
 * submission. The in-memory copy keeps its own 30-minute cap; this bounds the disk copy.
 */

/** How long an unused stored submission survives: long enough for a restart or a quiet night, then gone. */
export const DURABLE_DROP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** A receive time more than this far ahead of now is not trusted (counted as expired). */
export const DURABLE_DROP_FUTURE_SKEW_MS = 5 * 60 * 1000;

/** Is a stored copy past its age limit? An unreadable, missing or far-future receive time counts as expired. */
export function durableDropExpired(receivedAt: unknown, nowMs: number): boolean {
  if (typeof receivedAt !== 'string') return true;
  const t = Date.parse(receivedAt);
  if (!Number.isFinite(t)) return true;
  // A receive time well in the future (a clock that jumped back) would otherwise hold the copy until then.
  if (t - nowMs > DURABLE_DROP_FUTURE_SKEW_MS) return true;
  return nowMs - t > DURABLE_DROP_MAX_AGE_MS;
}

/** The part of SecretStore the sweep needs (whole-file read and write: one write for any number removed). */
export interface DurableDropStore {
  read(): Record<string, unknown>;
  write(secrets: Record<string, unknown>): void;
}

/**
 * Remove every stored submission past its age limit. Returns how many were removed. Writes only when
 * something is removed. Never logs a token or a value.
 */
export function sweepExpiredDurableDrops(store: DurableDropStore, nowMs: number): number {
  const secrets = store.read();
  const drops = secrets.secretDrops;
  if (!drops || typeof drops !== 'object' || Array.isArray(drops)) return 0;
  const kept: Record<string, unknown> = {};
  let removed = 0;
  for (const [token, rec] of Object.entries(drops as Record<string, unknown>)) {
    const receivedAt = rec && typeof rec === 'object' ? (rec as { receivedAt?: unknown }).receivedAt : undefined;
    if (durableDropExpired(receivedAt, nowMs)) removed++;
    else kept[token] = rec;
  }
  if (removed === 0) return 0;
  if (Object.keys(kept).length === 0) delete secrets.secretDrops;
  else secrets.secretDrops = kept;
  store.write(secrets);
  return removed;
}
