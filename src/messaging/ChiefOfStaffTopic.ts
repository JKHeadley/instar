/**
 * ChiefOfStaffTopic — the Chief of Staff's own Telegram conversation (docs/specs/chief-of-staff-topic.md
 * §1.4, Migration and rollout).
 *
 * One forum topic per agent, created ONLY by the serving-lease holder and ONLY while the dev-gated
 * `chiefOfStaff.enabled` resolves on; a standby never mints it (it adopts the holder's id through the
 * system-topic adoption loop, like Attention / Updates). The topic is pinned in the forum (Telegram
 * cannot nest topics, so on a Telegram-only agent the pin IS the surface), renamed when the owner
 * changes `chiefOfStaff.displayName`, and unpinned — never deleted — when the feature is switched off
 * (rollback keeps the history and the id; switching back on re-pins the same topic).
 *
 * Owner-only input (§6) is enforced by the inbound handler in server.ts, not here.
 */

export const CHIEF_OF_STAFF_TOPIC_STATE_KEY = 'chief-of-staff-topic';
/** The title the topic was last given, so a renamed `displayName` is applied exactly once. */
export const CHIEF_OF_STAFF_TOPIC_NAME_STATE_KEY = 'chief-of-staff-topic-name';
/** Whether the greeting is currently pinned (cleared on rollback so a re-enable re-pins). */
export const CHIEF_OF_STAFF_TOPIC_PINNED_STATE_KEY = 'chief-of-staff-topic-pinned';
/** The greeting's message id once delivered — a retry pins THIS id, it never sends a second greeting. */
export const CHIEF_OF_STAFF_TOPIC_GREETING_STATE_KEY = 'chief-of-staff-topic-greeting';
/** When the greeting was last held by the notification gate; no re-send within 24h (one held copy, not one per boot). */
export const CHIEF_OF_STAFF_TOPIC_GREETING_HELD_STATE_KEY = 'chief-of-staff-topic-greeting-held-at';
const GREETING_RESEND_AFTER_MS = 24 * 3_600_000;
export const CHIEF_OF_STAFF_TOPIC_EMOJI = '🧭';
/** Telegram forum icon colour (pink) — distinct from Attention (yellow), Updates (blue), Health. */
export const CHIEF_OF_STAFF_TOPIC_COLOR = 16749490;
export const DEFAULT_CHIEF_OF_STAFF_DISPLAY_NAME = 'Chief of Staff';

export interface ChiefOfStaffTopicTelegram {
  findOrCreateForumTopic(name: string, iconColor?: number, opts?: { origin?: 'user' | 'system' | 'auto'; label?: string; bounded?: boolean }): Promise<{ topicId: number; name: string; reused: boolean }>;
  editForumTopic(topicId: number, name?: string, iconColor?: number): Promise<boolean>;
  /** The greeting send — the server supplies the STAMPED (notification-enveloped) topic send: an unstamped send is held by the selectivity gate and can never be pinned. */
  sendGreeting(topicId: number, text: string): Promise<{ messageId?: number } | { messageId?: never }>;
  pinTopicMessage(topicId: number, messageId: number): Promise<boolean>;
  unpinTopicMessages(topicId: number): Promise<boolean>;
}

export interface ChiefOfStaffTopicState {
  readonly readOnly: boolean;
  get<T>(key: string): T | null;
  set(key: string, value: unknown): void;
}

export interface EnsureChiefOfStaffTopicOptions {
  /** The dev-gated feature switch, read live. */
  enabled: () => boolean;
  /** `chiefOfStaff.displayName`, read live; empty ⇒ the default. */
  displayName: () => string | undefined;
  log?: (line: string) => void;
  warn?: (line: string) => void;
  now?: () => number;
}

export type EnsureChiefOfStaffTopicOutcome =
  | { outcome: 'dark' }                                   // feature off, no topic recorded: nothing created
  | { outcome: 'unpinned'; topicId: number }              // feature off, topic recorded: pin removed (rollback), topic kept
  | { outcome: 'kept-dark'; topicId: number }             // feature off, topic recorded and already unpinned
  | { outcome: 'standby-awaiting-adoption' }              // feature on, standby, nothing recorded yet
  | { outcome: 'created'; topicId: number; pinned: boolean }
  | { outcome: 'reused'; topicId: number; pinned: boolean }
  | { outcome: 'renamed'; topicId: number }
  | { outcome: 'present'; topicId: number }
  | { outcome: 'failed'; reason: string };

export function chiefOfStaffTopicTitle(displayName: string | undefined): string {
  const name = (displayName ?? '').trim() || DEFAULT_CHIEF_OF_STAFF_DISPLAY_NAME;
  return `${CHIEF_OF_STAFF_TOPIC_EMOJI} ${name.slice(0, 96)}`;
}

export const CHIEF_OF_STAFF_GREETING =
  'This is your Chief of Staff — the one place to check in on everything your agent is working on.\n\n' +
  'It watches each project you bind here, restarts work that stalls, flags drift, verifies "done" against the checklist you set, ' +
  'and writes you one note a day with what needs you. Say something here and it stays awake; go quiet for a while and it pauses on its own.';

function topicIdOf(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 1 ? raw : null;
}

/**
 * Find-or-create, rename, pin, or roll back the Chief of Staff topic. Idempotent: safe on every boot.
 * Never throws on Telegram failures — the outcome names them and the next boot retries.
 */
export async function ensureChiefOfStaffTopic(
  telegram: ChiefOfStaffTopicTelegram,
  state: ChiefOfStaffTopicState,
  opts: EnsureChiefOfStaffTopicOptions,
): Promise<EnsureChiefOfStaffTopicOutcome> {
  const log = opts.log ?? (() => {});
  const warn = opts.warn ?? log;
  let enabled = false;
  try { enabled = opts.enabled(); } catch { /* @silent-fallback-ok: an unreadable gate reads as OFF — nothing is created or pinned on a doubt */ enabled = false; }
  const existing = topicIdOf(state.get(CHIEF_OF_STAFF_TOPIC_STATE_KEY));

  if (!enabled) {
    if (existing === null) return { outcome: 'dark' };
    // Rollback (spec: "`enabled: false` … unpins and leaves the topic"). Holder only; a standby cannot write the flag.
    if (state.readOnly) return { outcome: 'kept-dark', topicId: existing };
    if (state.get<boolean>(CHIEF_OF_STAFF_TOPIC_PINNED_STATE_KEY) !== true) return { outcome: 'kept-dark', topicId: existing };
    const ok = await telegram.unpinTopicMessages(existing).catch(() => /* @silent-fallback-ok: a failed unpin is reported as kept-dark and retried next boot */ false);
    if (ok) { state.set(CHIEF_OF_STAFF_TOPIC_PINNED_STATE_KEY, false); log(`  Chief of Staff topic ${existing}: feature off — unpinned (topic kept)`); return { outcome: 'unpinned', topicId: existing }; }
    warn(`  Chief of Staff topic ${existing}: feature off but the pin could not be removed; will retry next boot`);
    return { outcome: 'kept-dark', topicId: existing };
  }

  const title = chiefOfStaffTopicTitle(opts.displayName());
  if (existing !== null) {
    if (state.readOnly) return { outcome: 'present', topicId: existing };
    const lastTitle = state.get<string>(CHIEF_OF_STAFF_TOPIC_NAME_STATE_KEY);
    let renamed = false;
    if (lastTitle !== title) {
      const ok = await telegram.editForumTopic(existing, title, CHIEF_OF_STAFF_TOPIC_COLOR).catch(() => /* @silent-fallback-ok: a failed rename is warned and retried next boot; the topic keeps its old title meanwhile */ false);
      if (ok) { state.set(CHIEF_OF_STAFF_TOPIC_NAME_STATE_KEY, title); renamed = true; log(`  Chief of Staff topic ${existing}: renamed to "${title}"`); }
      else warn(`  Chief of Staff topic ${existing}: rename to "${title}" failed; will retry next boot`);
    }
    // Re-pin after a rollback → re-enable.
    if (state.get<boolean>(CHIEF_OF_STAFF_TOPIC_PINNED_STATE_KEY) !== true) await pinGreeting(telegram, state, existing, warn, opts.now ?? Date.now);
    return renamed ? { outcome: 'renamed', topicId: existing } : { outcome: 'present', topicId: existing };
  }

  if (state.readOnly) {
    log('  Chief of Staff topic: none recorded yet — waiting to adopt the lease holder\'s');
    return { outcome: 'standby-awaiting-adoption' };
  }
  try {
    const topic = await telegram.findOrCreateForumTopic(title, CHIEF_OF_STAFF_TOPIC_COLOR, { origin: 'system', bounded: true, label: 'boot-chief-of-staff' });
    state.set(CHIEF_OF_STAFF_TOPIC_STATE_KEY, topic.topicId);
    state.set(CHIEF_OF_STAFF_TOPIC_NAME_STATE_KEY, title);
    const pinned = await pinGreeting(telegram, state, topic.topicId, warn, opts.now ?? Date.now);
    log(`  ${topic.reused ? 'Reusing' : 'Created'} Chief of Staff topic: ${topic.topicId}${pinned ? ' (pinned)' : ''}`);
    return { outcome: topic.reused ? 'reused' : 'created', topicId: topic.topicId, pinned };
  } catch (err) { /* @silent-fallback-ok: not silent — the outcome names the failure, it is warned, nothing is recorded, and the next boot retries */
    const reason = err instanceof Error ? err.message : String(err);
    warn(`  Failed to create Chief of Staff topic: ${reason}`);
    return { outcome: 'failed', reason };
  }
}

async function pinGreeting(telegram: ChiefOfStaffTopicTelegram, state: ChiefOfStaffTopicState, topicId: number, warn: (l: string) => void, now: () => number): Promise<boolean> {
  try {
    let messageId = state.get<number>(CHIEF_OF_STAFF_TOPIC_GREETING_STATE_KEY);
    if (typeof messageId !== 'number') {
      const heldAt = state.get<number>(CHIEF_OF_STAFF_TOPIC_GREETING_HELD_STATE_KEY);
      if (typeof heldAt === 'number' && now() - heldAt < GREETING_RESEND_AFTER_MS) return false; // one held copy, not one per boot
      const sent = await telegram.sendGreeting(topicId, CHIEF_OF_STAFF_GREETING);
      const id = (sent as { messageId?: number }).messageId;
      if (typeof id !== 'number') { state.set(CHIEF_OF_STAFF_TOPIC_GREETING_HELD_STATE_KEY, now()); warn(`  Chief of Staff topic ${topicId}: greeting held by the notification gate; I will not re-send it for 24h and will pin it once it is delivered`); return false; }
      messageId = id;
      state.set(CHIEF_OF_STAFF_TOPIC_GREETING_STATE_KEY, messageId);
    }
    const ok = await telegram.pinTopicMessage(topicId, messageId);
    if (ok) state.set(CHIEF_OF_STAFF_TOPIC_PINNED_STATE_KEY, true);
    else warn(`  Chief of Staff topic ${topicId}: pin failed; will retry next boot`);
    return ok;
  } catch (err) { /* @silent-fallback-ok: a failed greeting/pin is reported in the outcome and retried next boot; the topic itself is recorded */
    warn(`  Chief of Staff topic ${topicId}: greeting/pin failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
