/**
 * AgentTelegramComms — agent-to-agent Telegram comms primitive.
 *
 * Spec: docs/specs/MENTOR-LIVE-READINESS-SPEC.md §Fix 2a (approved 2026-05-27).
 *
 * A robust, recipient-knows-it's-from-an-agent channel any agent can use to message
 * another agent's bot over Telegram, with the indicator AND the anti-loop machinery as
 * first-class infra. Justin's framing: "robust infra that indicates the message is from
 * another agent… leverage infra to prevent the ping pong trap." The mentor is its first
 * consumer (see MentorOnboarding*), but nothing here is mentor-specific.
 *
 * Every message carries a VISIBLE marker prefix in the body so (a) humans can audit at a
 * glance and (b) the Telegram chat history alone reconstructs a round-trip when ledgers
 * are unavailable:
 *
 *   [a2a:from=<sender> to=<recipient> role=<role> id=<id> corr=<corr> ts=<unix-ms> v=1]
 *
 *   <body>
 *
 * This file is the PURE logic (marker parse/format + routing decision + cycle-detection
 * key). I/O (the actual Telegram send + the audit ledgers + the processed-id store) is
 * injected so every branch is unit-testable. See §Fix 2a for the routing matrix and the
 * anti-loop invariants this enforces.
 */

/** Current marker schema version. Bumps are explicit (reader-first rule — see spec). */
export const A2A_VERSION = 1;

/** Marker field-value charset (spec: deterministic parsing, avoids invisible/escaping
 *  cases). Agent/role/id/corr match this; ts and v are positive integers. */
const TOKEN = '[A-Za-z0-9._:-]+';

/**
 * Strict marker regex — anchored to the start, consumes exactly the first line plus the
 * required blank-line separator, then captures the body. Field ORDER is fixed (so the
 * parse is deterministic and a reordered/extra-field marker is "malformed", not silently
 * accepted). All of from/to/role/id/corr/ts/v are REQUIRED (corr + ts required per
 * round-2/3 convergence — missing corr would collapse the cycle-detection key; missing ts
 * disables replay-window defense).
 */
const MARKER_RE = new RegExp(
  `^\\[a2a:from=(${TOKEN}) to=(${TOKEN}) role=(${TOKEN}) id=(${TOKEN}) corr=(${TOKEN}) ts=([0-9]+) v=([0-9]+)\\]\\n\\n([\\s\\S]*)$`,
);

/** A marker-shaped first line WITHOUT the strict full match — used only to distinguish
 *  "not an agent message at all" (fall through to user handling) from "looks like one but
 *  is malformed" (drop as a security event, NEVER fall through). */
const MARKER_PREFIX_RE = /^\[a2a:/;

export interface A2aMarker {
  from: string;
  to: string;
  role: string;
  id: string;
  corr: string;
  ts: number;
  v: number;
}

export interface A2aMessage extends A2aMarker {
  body: string;
}

export interface A2aSendFields {
  from: string;
  to: string;
  role: string;
  /** Stable id; minted by the caller/sender if absent. */
  id: string;
  /** Correlation id. Prompts self-correlate (corr === id); replies carry the prompt's id. */
  corr: string;
  ts: number;
}

/**
 * Result of parsing an inbound Telegram message body for an a2a marker.
 * - `no-marker`: not an agent message → caller falls through to normal user handling.
 * - `malformed`: marker-shaped but invalid → caller DROPS (security event), never falls
 *   through to user handling (spoof / broken-sender defense).
 */
export type ParseResult =
  | { ok: true; msg: A2aMessage }
  | { ok: false; kind: 'no-marker' }
  | { ok: false; kind: 'malformed'; detail: string };

/** Format a marker + body for sending. The inverse of {@link parseMarker}. */
export function formatMarker(fields: A2aSendFields, body: string): string {
  for (const [k, v] of Object.entries({
    from: fields.from,
    to: fields.to,
    role: fields.role,
    id: fields.id,
    corr: fields.corr,
  })) {
    if (!new RegExp(`^${TOKEN}$`).test(String(v))) {
      throw new Error(`AgentTelegramComms.formatMarker: field "${k}" value "${v}" violates the a2a charset ${TOKEN}`);
    }
  }
  if (!Number.isInteger(fields.ts) || fields.ts <= 0) {
    throw new Error(`AgentTelegramComms.formatMarker: ts must be a positive integer, got ${fields.ts}`);
  }
  return (
    `[a2a:from=${fields.from} to=${fields.to} role=${fields.role} id=${fields.id} ` +
    `corr=${fields.corr} ts=${fields.ts} v=${A2A_VERSION}]\n\n${body}`
  );
}

/** Parse an inbound message body. Strict — see {@link ParseResult}. */
export function parseMarker(raw: string): ParseResult {
  if (typeof raw !== 'string' || !MARKER_PREFIX_RE.test(raw)) {
    return { ok: false, kind: 'no-marker' };
  }
  const m = MARKER_RE.exec(raw);
  if (!m) {
    return { ok: false, kind: 'malformed', detail: 'marker prefix present but failed strict parse' };
  }
  const [, from, to, role, id, corr, tsStr, vStr, body] = m;
  const ts = Number(tsStr);
  const v = Number(vStr);
  if (!Number.isInteger(ts) || ts <= 0) {
    return { ok: false, kind: 'malformed', detail: `invalid ts "${tsStr}"` };
  }
  if (!Number.isInteger(v) || v <= 0) {
    return { ok: false, kind: 'malformed', detail: `invalid v "${vStr}"` };
  }
  return { ok: true, msg: { from, to, role, id, corr, ts, v, body } };
}

/** Per-recipient routing configuration (spec §Fix 2a recipient + anti-loop). */
export interface RecipientConfig {
  /** This agent's own name (the `to` an inbound message must target). */
  localAgent: string;
  /** Known agents → their Telegram bot identity. Only senders here are trusted. */
  knownAgents: Record<string, { botId: string }>;
  /**
   * Per-source role acceptance (round-2 adversarial F6): `{ fromAgent: allowedRoles[] }`.
   * A compromised/buggy known agent sending an unexpected role is dropped, even if that
   * role is accepted from a DIFFERENT source. Scoped admission.
   */
  acceptRoles: Record<string, string[]>;
  /** Replay window: reject markers whose ts is outside ±this from now. Default 24h. */
  skewWindowMs: number;
  /** Highest marker version this recipient understands. Newer → dead-letter, not crash. */
  maxVersion: number;
}

/**
 * Inbound message context the caller resolves from the Telegram update. The bot-identity
 * fields are the SPOOF DEFENSE: a human user typing a marker-shaped string has
 * `senderIsBot === false` and no `senderChatId` → dropped (round-2 adversarial F1).
 */
export interface IncomingContext {
  /** The raw message body (marker + body, or arbitrary user text). */
  raw: string;
  /** `from.is_bot` from the Telegram update. */
  senderIsBot: boolean;
  /** `sender_chat.id` from the Telegram update when present (group bot-as-channel relay).
   *  Its mere presence is part of the spoof defense (a human user has none). */
  senderChatId?: string;
  /** The effective sender bot identity = `sender_chat.id ?? from.id`. Matched against the
   *  allowlist's `botId`. The caller resolves this from the Telegram update. */
  senderBotId?: string;
  /** Wall-clock now (ms) — injected for testability. */
  now: number;
}

export type RouteDropReason =
  | 'agent-marker-malformed'
  | 'agent-marker-stale-or-future'
  | 'agent-marker-spoofed-by-user'
  | 'agent-marker-wrong-recipient'
  | 'agent-marker-unsupported-version'
  | 'agent-marker-unknown'
  | 'agent-marker-duplicate'
  | 'agent-marker-role-not-allowed-from-source'
  | 'agent-marker-unexpected-role'
  | 'agent-marker-unknown-role';

export type RouteDecision =
  | { action: 'fall-through' }
  | { action: 'route'; msg: A2aMessage }
  | { action: 'drop'; reason: RouteDropReason; detail?: string; msg?: A2aMessage };

/**
 * The recipient routing matrix (spec §Fix 2a "Routing matrix"). PURE — every branch is a
 * decision the caller then acts on (route to a role-handler, or drop + write an audit
 * row). `knownRole` tells whether the role is one this recipient has a handler for at all;
 * `isProcessed` is the idempotency check against the processed-id store.
 */
export function decideRoute(
  ctx: IncomingContext,
  cfg: RecipientConfig,
  deps: { isProcessed: (id: string) => boolean; knownRole: (role: string) => boolean },
): RouteDecision {
  const parsed = parseMarker(ctx.raw);
  if (!parsed.ok && parsed.kind === 'no-marker') return { action: 'fall-through' };
  if (!parsed.ok) return { action: 'drop', reason: 'agent-marker-malformed', detail: parsed.detail };

  const msg = parsed.msg;

  // Replay / clock-skew window (round-2 adversarial F2).
  if (Math.abs(ctx.now - msg.ts) > cfg.skewWindowMs) {
    return { action: 'drop', reason: 'agent-marker-stale-or-future', msg };
  }

  // Unsupported version → dead-letter, never crash (reader-first rule).
  if (msg.v > cfg.maxVersion) {
    return { action: 'drop', reason: 'agent-marker-unsupported-version', msg };
  }

  // SPOOF DEFENSE (round-2 adversarial F1): a real user typing a marker-shaped string is
  // not a bot and has no sender_chat. Drop before any allowlist/role check — a human-typed
  // marker must NEVER reach a role-handler, even if from/id happen to match.
  if (!ctx.senderIsBot && ctx.senderChatId === undefined) {
    return { action: 'drop', reason: 'agent-marker-spoofed-by-user', msg };
  }

  // Recipient targeting.
  if (msg.to !== cfg.localAgent) {
    return { action: 'drop', reason: 'agent-marker-wrong-recipient', msg };
  }

  // Sender allowlist + bot-identity match.
  const known = cfg.knownAgents[msg.from];
  if (!known || (ctx.senderBotId !== undefined && known.botId !== ctx.senderBotId)) {
    return { action: 'drop', reason: 'agent-marker-unknown', msg };
  }

  // Idempotency (round-2 adversarial: Telegram retry / adapter restart).
  if (deps.isProcessed(msg.id)) {
    return { action: 'drop', reason: 'agent-marker-duplicate', msg };
  }

  // Per-source role acceptance (round-2 adversarial F6): scoped admission.
  const allowedFromSource = cfg.acceptRoles[msg.from] ?? [];
  if (!allowedFromSource.includes(msg.role)) {
    // Distinguish "this recipient has no handler for the role at all" from "the role
    // exists but isn't allowed from THIS source" — both drop, different audit codes.
    if (!deps.knownRole(msg.role)) {
      return { action: 'drop', reason: 'agent-marker-unknown-role', msg };
    }
    return { action: 'drop', reason: 'agent-marker-role-not-allowed-from-source', msg };
  }

  return { action: 'route', msg };
}

/**
 * Cycle-detection key (spec §Fix 2a anti-loop #3): keyed on the full tuple so legitimate
 * unrelated traffic never collides. `corr` is always present (required in the marker), so
 * the key cannot collapse to `undefined`.
 */
export function cycleKey(fields: {
  fromBotId: string;
  toBotId: string;
  topicId: number | string;
  role: string;
  corr: string;
}): string {
  return `${fields.fromBotId}|${fields.toBotId}|${fields.topicId}|${fields.role}|${fields.corr}`;
}

/**
 * In-memory cycle detector. A send is refused (unless `cycleOk`) when the same key was
 * seen within `windowMs` — the structural guard against tight role↔reply ping-pong.
 */
export class CycleDetector {
  private readonly recent = new Map<string, number>();
  constructor(private readonly windowMs: number) {}

  /** Returns true if sending this key now would trip cycle-detection. */
  wouldTrip(key: string, now: number): boolean {
    this.evict(now);
    const last = this.recent.get(key);
    return last !== undefined && now - last < this.windowMs;
  }

  /** Record a send/receive of this key at `now`. */
  mark(key: string, now: number): void {
    this.recent.set(key, now);
    this.evict(now);
  }

  private evict(now: number): void {
    for (const [k, t] of this.recent) {
      if (now - t >= this.windowMs) this.recent.delete(k);
    }
  }
}
