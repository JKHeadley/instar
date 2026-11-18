/**
 * identity-security-piece1e: who a Telegram sender is to this agent.
 * Spec: docs/specs/identity-security-piece1e-telegram-senders.md
 *
 *   owner      — the configured owner id (ownerUserId, else promptGate.ownerId); nobody becomes owner by writing
 *   authorized — on the explicit list, or a registered person with this Telegram id; '*' = everyone
 *                may TALK (controls follow the action table, never '*')
 *   stranger   — ONLY on positive evidence: a proven sender id that is none of the above, on an
 *                agent whose owner is known. An empty or missing list never means everyone.
 *   unknown    — anything else: no proven sender id, an unreadable list or registry, no owner known.
 *                Never refused for being unknown; such messages keep today's handling.
 */
export type TelegramSenderStanding = 'owner' | 'authorized' | 'stranger' | 'unknown';

export interface TelegramSenderAuthorityDeps {
  ownerId: () => number | string | undefined;
  /** The explicit list; undefined when unset; throws when it cannot be read. */
  allowList: () => ReadonlyArray<number | string> | undefined;
  /** Telegram ids of registered people; throws when the registry cannot be read. */
  registeredIds: () => ReadonlyArray<number | string>;
}

export function telegramSenderStanding(userId: number | string | undefined | null, deps: TelegramSenderAuthorityDeps, opts: { proven: boolean } = { proven: true }): TelegramSenderStanding {
  // A sender id counts only when proven: the server's own poller, or a lifeline forward the ingress
  // guard verified. Anything else is unknown, never a stranger.
  if (!opts.proven || userId === undefined || userId === null || String(userId) === '') return 'unknown';
  const id = String(userId);
  const owner = deps.ownerId();
  const ownerKnown = owner !== undefined && owner !== null && String(owner) !== '';
  if (ownerKnown && String(owner) === id) return 'owner';
  let unreadable = false;
  try {
    const list = deps.allowList();
    if (list && list.some((v) => String(v) === '*' || String(v) === id)) return 'authorized';
  } catch { unreadable = true; /* @silent-fallback-ok: reported as 'unknown' below, never as a stranger */ }
  try {
    if (deps.registeredIds().some((v) => String(v) === id)) return 'authorized';
  } catch { unreadable = true; /* @silent-fallback-ok: reported as 'unknown' below, never as a stranger */ }
  return unreadable || !ownerKnown ? 'unknown' : 'stranger';
}

export type TelegramSenderAction = 'message' | 'command' | 'session-control' | 'agent-control' | 'media';

const AGENT_CONTROLS = new Set(['/switch-account', '/local-model', '/route']);
const SESSION_CONTROLS = new Set(['/interrupt', '/restart', '/topic', '/claim', '/link', '/unlink']);

/**
 * The owner's join-request answer: `/approve`, `/decline` or `/deny` plus one code, exactly. Explicit
 * command syntax, never a stop: the relay path checks it before the emergency-stop classifier, which
 * otherwise reads "decline"/"deny" as a stop and swallows the command.
 */
export const JOIN_REQUEST_COMMAND = /^\/(approve|decline|deny)(?:@\w+)?\s+(\S+)\s*$/i;

/** Which row of the action table a slash command falls in (spec section 3). */
export function telegramCommandAction(text: string): TelegramSenderAction {
  const word = text.trim().split(/\s+/)[0]?.toLowerCase().replace(/@[\w]+$/, '') ?? '';
  if (AGENT_CONTROLS.has(word)) return 'agent-control';
  if (SESSION_CONTROLS.has(word)) return 'session-control';
  return 'command';
}

/**
 * The action table (spec section 3). `unknown` keeps today's handling (true here: this rule never
 * refuses it). '*' alone grants talking (messages and media) only. One-session controls: the owner or any authorized person until a
 * per-person session record exists (pieces 2 and 1f). Whole-agent controls: the owner only.
 */
export function standingMay(s: TelegramSenderStanding, action: TelegramSenderAction, opts: { viaWildcardOnly?: boolean } = {}): boolean {
  if (s === 'unknown' || s === 'owner') return true;
  if (s === 'stranger') return false;
  if (action === 'agent-control') return false;
  if (opts.viaWildcardOnly) return action === 'message' || action === 'media';
  return true;
}
