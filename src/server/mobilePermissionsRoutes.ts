/**
 * Native "Permission slips" and "What I'm allowed to do" for the Instar iPhone app
 * (docs/specs/mobile-native-permissions.md).
 *
 *   GET  /mobile/permissions/slips                  — waiting approvals (this machine + peers, read-only
 *                                                      for peers) and active slips, trimmed
 *   GET  /mobile/permissions/features               — this machine's feature switches, trimmed
 *   POST /mobile/permissions/challenge              — a single-use challenge bound to one exact action
 *   POST /mobile/permissions/requests/:id/approve   — approve a waiting request held here
 *   POST /mobile/permissions/requests/:id/decline   — decline it, with a reason
 *   POST /mobile/permissions/features/:id           — set a switch on or off
 *   POST /mobile/secrets/requests                   — ask someone for a password or key (docs/specs/mobile-native-secrets-writes.md)
 *   POST /mobile/secrets/requests/:key/cancel       — cancel a waiting request held here
 *   POST /mobile/sessions/door/:conversation        — switch a conversation's engine and model (docs/specs/session-swap-any-conversation.md)
 *   POST /mobile/sessions/move/:topic               — move a conversation to another machine
 *   POST /mobile/sessions/close/:id                 — close a session
 *   POST /mobile/sessions/new                       — start a session
 *   POST /mobile/sessions/default                   — set or clear the default door and model for new topics
 *   POST /mobile/accounts/sign-in/start             — start a fresh sign-in for one account on one machine (docs/specs/account-sign-in-face-id.md)
 *   POST /mobile/accounts/add                       — add a Claude or Codex account and start its sign-in here (docs/specs/account-add-face-id.md)
 *
 * The reads: the bearer or an owner phone. The writes: ONLY an active owner phone that signs the
 * request with its device key AND carries a fresh presence-key signature (Face ID / Touch ID /
 * passcode, Secure Enclave; the key from docs/specs/mobile-console-device-signin.md) over a
 * single-use challenge bound to the device, the Host and the exact action line. That proof stands
 * in for the dashboard PIN the console asks for, and the action itself runs the console's own code
 * (injected by routes.ts), so the phone can never do more than the PIN-confirmed console.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isStorageFailure, storageErrorResponse } from '../core/storageMachineName.js';
import type { Request, Response, Router } from 'express';
import { ownerOrBearer, rowKey } from './mobileCapacityRoutes.js';
import { cleanText } from './mobilePlansPeopleRoutes.js';
import { conversationKeys } from '../core/conversationKeys.js';
import { cleanConversationTitle } from '../core/appConversationText.js';
import { TOKEN_RUN } from './mobileSecretsRoutes.js';
import { activeOwnerPhone, isConsoleTicketEnabled, normalHost, verifyPresenceSignature } from './mobileConsoleTicket.js';
import { arrivedOverLocalTls } from '../core/desktopTransport.js';
import type { MobilePairingService } from './mobilePairingRoutes.js';
import type { InstarConfig } from '../core/types.js';
import { resolveDevAgentGate } from '../core/devAgentGate.js';
import { featureEvidence } from '../monitoring/FeatureEvidenceLog.js';
import { FLOOR_ACTION_LABELS } from '../core/AuthorizationRequestStore.js';
import { verifiedEntityName } from '../messaging/shared/channelIdentity.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { maybeRotateJsonl } from '../utils/jsonl-rotation.js';
import { isTeamSwitchSetting, type TeamSwitchSetting } from '../core/TeamSwitches.js';
import { isNewAccountKind, type NewAccountKind } from '../core/newSubscriptionAccountId.js';

export const MOBILE_PERMISSIONS_SCHEMA_VERSION = 1;
export const PERMISSION_ACTION_VERSION = 'instar-permission-action-v1';
export const PERMISSION_CHALLENGE_TTL_MS = 60_000;
export const PERMISSION_CHALLENGE_PER_DEVICE = 4;
export const PERMISSION_CHALLENGE_TOTAL = 64;
export const MAX_APPROVAL_ROWS = 100;
export const MAX_SLIP_ROWS = 100;
export const MAX_REASON_CHARS = 500;
export const MAX_SECRET_LABEL_CHARS = 120;
export const MAX_SECRET_NOTE_CHARS = 500;
/** Peers read per answer (the phones-messages ceiling); any beyond are counted as not answering. */
export const MAX_PEERS = 16;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;
const TARGET_PATTERN = /^[a-z0-9._:-]{1,128}$/;
/** The disclosure word for a switch that records no consent (turning off, or an informational/local tier). */
export const NO_DISCLOSURE = 'none';
const CONSENT_TIERS = new Set(['network', 'self-governing']);
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const AUDIT_MAX_BYTES = 1024 * 1024;

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && !Array.isArray(x)) as Rec[] : []);
const ts = (v: unknown): number => { const t = typeof v === 'number' ? v : Date.parse(String(v ?? '')); return Number.isFinite(t) && t > 0 ? t : 0; };
const iso = (t: number): string | null => (t > 0 ? new Date(t).toISOString() : null);
const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

/**
 * `mobilePairing.permissionActions.enabled`: omitted ⇒ live on a development agent, dark on the fleet
 * (DEV_GATED_FEATURES). Read live on every request.
 */
export function isPermissionActionsEnabled(config: InstarConfig): boolean {
  return resolveDevAgentGate(config.mobilePairing?.permissionActions?.enabled, config);
}

// ── the action line ───────────────────────────────────────────────────────────

export type PermissionAction =
  | { kind: 'approve-request'; target: string; proposalHash: string }
  | { kind: 'decline-request'; target: string; reason: string }
  | { kind: 'set-feature'; target: string; value: 'enabled' | 'disabled'; disclosureHash: string }
  | { kind: 'request-secret'; target: 'new'; label: string; note: string; topicId: number | null }
  | { kind: 'cancel-secret'; target: string }
  | { kind: 'session-door'; target: string; framework: string; model: string | null; machine: string | null }
  | { kind: 'session-move'; target: string; to: string; confirmation: string | null }
  /** "Bring it back here" (app-conversations-in-the-pool §2.2): Face ID, behind the same write gate as Move. */
  | { kind: 'session-bring-back'; target: string; confirmed: boolean }
  | { kind: 'session-close'; target: string; tmux: string; machine: string | null }
  | { kind: Exclude<TeamActionKind, 'team-switch-on'>; target: 'team' }
  /** One setting turned on for the whole agent (team-switches-agent-wide); the setting is on the signed line. */
  | { kind: 'team-switch-on'; target: TeamSwitchSetting | 'team-access' }
  | { kind: 'session-new'; target: 'new'; name: string; platform: SessionPlatformChoice; framework: string | null; model: string | null; machine: string | null }
  | { kind: 'session-default'; target: 'new-topic-default'; framework: string | null; model: string | null }
  /** Start a fresh sign-in for one account on one machine (account-sign-in-face-id): the pair is the signed target. */
  | { kind: 'account-sign-in'; target: string; accountId: string; machineId: string }
  /** Add a Claude or Codex account (account-add-face-id): the kind is the signed target. */
  | { kind: 'account-add'; target: NewAccountKind };

export type SessionPlatformChoice = 'auto' | 'telegram' | 'slack' | 'app' | 'headless';
export type SessionAction = Extract<PermissionAction, { kind: `session-${string}` }>;
export const MAX_SESSION_NAME_CHARS = 120;
/** A door, model or machine as an action line can carry it: one word, nothing a line could be split on. */
const LINE_WORD = /^[A-Za-z0-9._:[\]-]{1,128}$/;
const TMUX_NAME = /^[a-zA-Z0-9_-]{1,200}$/;
const TOPIC_ID = /^[1-9][0-9]{0,15}$/;
const CONFIRMATION = /^[0-9a-f]{64}$/;
/** A subscription account id, exactly as the pool stores one (SubscriptionPool ID_RE), bounded. */
export const ACCOUNT_ID_PATTERN = /^[a-z0-9-]{1,64}$/;
/** A machine id as the pool names one (`m_<hex>`, or `local` with no mesh): one word, no `@`, bounded. */
export const SIGN_IN_MACHINE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** The signed target for an account sign-in: `<accountId>@<machineId>`, or null when either part is malformed. */
export function accountSignInTarget(accountId: unknown, machineId: unknown): string | null {
  if (typeof accountId !== 'string' || typeof machineId !== 'string') return null;
  if (!ACCOUNT_ID_PATTERN.test(accountId) || !SIGN_IN_MACHINE_PATTERN.test(machineId)) return null;
  return `${accountId}@${machineId}`;
}
/** The only fields POST /mobile/accounts/add reads; anything else is refused (never a credential). */
const ACCOUNT_ADD_FIELDS: ReadonlySet<string> = new Set(['provider', 'nickname', 'email', 'challenge', 'presenceSig']);
export const MAX_ACCOUNT_NICKNAME_CHARS = 60;
/** An absent optional field: nothing sent, or the empty string the phone's string fields use for it. */
const absent = (v: unknown): boolean => v === undefined || v === null || v === '';

/** The SHA-256 (hex) of the decline reason's exact UTF-8 bytes as sent (no trimming, no normalisation). */
export function reasonHash(reason: string): string { return sha256(reason); }

/** The exact line naming one action and its target (the decline reason by its hash). */
export function actionLine(a: PermissionAction): string {
  switch (a.kind) {
    case 'approve-request': return `approve-request ${a.target} ${a.proposalHash}`;
    case 'decline-request': return `decline-request ${a.target} ${reasonHash(a.reason)}`;
    case 'set-feature': return `set-feature ${a.target} ${a.value} ${a.disclosureHash}`;
    case 'request-secret': return `request-secret new ${reasonHash(a.label)} ${reasonHash(a.note)} ${a.topicId ?? 'none'}`;
    case 'cancel-secret': return `cancel-secret ${a.target}`;
    case 'session-door': return `session-door ${a.target} ${a.machine ?? 'here'} ${a.framework} ${a.model ?? 'none'}`;
    case 'session-move': return `session-move ${a.target} ${a.to} ${a.confirmation ?? 'none'}`;
    case 'session-bring-back': return `session-bring-back ${a.target} ${a.confirmed ? 'confirmed' : 'ask'}`;
    case 'session-close': return `session-close ${a.target} ${a.tmux} ${a.machine ?? 'here'}`;
    case 'team-off': case 'team-restore': case 'team-memory-privacy': case 'team-origin-gone': return `${a.kind} team`;
    case 'team-switch-on': return `team-switch-on ${a.target}`;
    case 'session-new': return `session-new new ${reasonHash(a.name)} ${a.platform} ${a.framework ?? 'none'} ${a.model ?? 'none'} ${a.machine ?? 'auto'}`;
    case 'session-default': return `session-default new-topic-default ${a.framework ?? 'none'} ${a.model ?? 'none'}`;
    case 'account-sign-in': return `account-sign-in ${a.target}`;
    case 'account-add': return `account-add ${a.target}`;
  }
}

/** The exact bytes the presence key signs for one action. */
/** What the owner confirms with Face ID on the team screens. */
export type TeamActionKind = 'team-off' | 'team-restore' | 'team-memory-privacy' | 'team-origin-gone' | 'team-switch-on';

export function permissionPresenceMessage(deviceId: string, host: string, challenge: string, line: string): string {
  return `${PERMISSION_ACTION_VERSION}\n${deviceId}\n${host.toLowerCase()}\n${challenge}\n${line}`;
}

/** Builds an action from its parts, or names what is wrong with them. */
export function buildAction(kind: unknown, target: unknown, extra: { value?: unknown; reason?: unknown; proposalHash?: unknown; disclosureHash?: unknown; label?: unknown; note?: unknown; topicId?: unknown; framework?: unknown; model?: unknown; machine?: unknown; to?: unknown; confirmation?: unknown; tmux?: unknown; name?: unknown; platform?: unknown }): { ok: true; action: PermissionAction } | { ok: false; error: string } {
  // An account sign-in names `<accountId>@<machineId>`, split and re-checked part by part.
  if (kind === 'account-sign-in') {
    if (typeof target !== 'string') return { ok: false, error: 'bad-target' };
    const at = target.indexOf('@');
    const accountId = at > 0 ? target.slice(0, at) : '';
    const machineId = at > 0 ? target.slice(at + 1) : '';
    return accountSignInTarget(accountId, machineId) === target ? { ok: true, action: { kind, target, accountId, machineId } } : { ok: false, error: 'bad-target' };
  }
  // A session door names a conversation reference, whose Slack form has uppercase ids (checked below).
  if (typeof target !== 'string' || (kind === 'session-door' ? !conversationKeys(target) : !TARGET_PATTERN.test(target))) return { ok: false, error: 'bad-target' };
  if (kind === 'team-off' || kind === 'team-restore' || kind === 'team-memory-privacy' || kind === 'team-origin-gone') return { ok: true, action: { kind, target: 'team' } };
  if (kind === 'account-add') return isNewAccountKind(target) ? { ok: true, action: { kind, target } } : { ok: false, error: 'bad-target' };
  // 'team-access': everything team access needs, in one Face ID (one signed line names it, so it cannot be replayed as one setting).
  if (kind === 'team-switch-on') return isTeamSwitchSetting(target) || target === 'team-access' ? { ok: true, action: { kind, target: target as TeamSwitchSetting | 'team-access' } } : { ok: false, error: 'bad-setting' };
  if (kind === 'approve-request') {
    if (typeof extra.proposalHash !== 'string' || !/^[0-9a-f]{64}$/.test(extra.proposalHash)) return { ok: false, error: 'bad-proposal-hash' };
    return { ok: true, action: { kind, target, proposalHash: extra.proposalHash } };
  }
  if (kind === 'decline-request') {
    if (typeof extra.reason !== 'string' || extra.reason.trim().length === 0) return { ok: false, error: 'reason-required' };
    if (extra.reason.length > MAX_REASON_CHARS) return { ok: false, error: 'reason-too-long' };
    return { ok: true, action: { kind, target, reason: extra.reason } };
  }
  if (kind === 'set-feature') {
    if (extra.value !== 'enabled' && extra.value !== 'disabled') return { ok: false, error: 'bad-value' };
    const d = extra.disclosureHash ?? NO_DISCLOSURE;
    if (typeof d !== 'string' || !(d === NO_DISCLOSURE || /^[0-9a-f]{64}$/.test(d))) return { ok: false, error: 'bad-disclosure-hash' };
    return { ok: true, action: { kind, target, value: extra.value, disclosureHash: d } };
  }
  if (kind === 'request-secret') {
    if (target !== 'new') return { ok: false, error: 'bad-target' };
    const label = extra.label;
    if (typeof label !== 'string' || label.trim().length === 0) return { ok: false, error: 'label-required' };
    if (label !== label.trim()) return { ok: false, error: 'bad-label' };
    if (label.length > MAX_SECRET_LABEL_CHARS) return { ok: false, error: 'label-too-long' };
    const note = extra.note ?? '';
    if (typeof note !== 'string' || note.length > MAX_SECRET_NOTE_CHARS) return { ok: false, error: 'note-too-long' };
    if (CONTROL_CHARS.test(label) || CONTROL_CHARS.test(note.replace(/[\n\t]/g, ' '))) return { ok: false, error: 'bad-characters' };
    if (holdsToken(label) || holdsToken(note)) return { ok: false, error: 'looks-like-a-secret' };
    // The phone sends its fields as strings, so a topic may arrive as its digits.
    const raw = extra.topicId ?? null;
    const topic = typeof raw === 'string' && /^[1-9][0-9]{0,15}$/.test(raw) ? Number(raw) : raw;
    if (topic !== null && !(typeof topic === 'number' && Number.isSafeInteger(topic) && topic > 0)) return { ok: false, error: 'bad-topic' };
    return { ok: true, action: { kind, target, label, note, topicId: topic as number | null } };
  }
  if (kind === 'cancel-secret') {
    if (!/^[0-9a-f]{16}$/.test(target)) return { ok: false, error: 'bad-target' };
    return { ok: true, action: { kind, target } };
  }
  if (kind === 'session-door' || kind === 'session-move' || kind === 'session-bring-back' || kind === 'session-close' || kind === 'session-new' || kind === 'session-default') return buildSessionAction(kind, target, extra);
  return { ok: false, error: 'bad-action' };
}

/** The session controls' actions. Every field that changes what runs is on the signed line. */
function buildSessionAction(kind: SessionAction['kind'], target: string, x: { framework?: unknown; model?: unknown; machine?: unknown; to?: unknown; confirmation?: unknown; tmux?: unknown; name?: unknown; platform?: unknown }): { ok: true; action: PermissionAction } | { ok: false; error: string } {
  // `none`, `here` and `auto` mean an absent field on the line, so no field may be one of them.
  const word = (v: unknown): v is string => typeof v === 'string' && LINE_WORD.test(v) && v !== 'none' && v !== 'here' && v !== 'auto';
  const optional = (v: unknown): string | null | undefined => (absent(v) ? null : word(v) ? v : undefined);
  const machine = optional(x.machine);
  const model = optional(x.model);
  if (machine === undefined) return { ok: false, error: 'bad-machine' };
  if (model === undefined) return { ok: false, error: 'bad-model' };
  if (kind === 'session-door') {
    // Any conversation (session-swap-any-conversation §3.5): a reference, or a bare Telegram topic
    // id from an older app. The signed line carries the target exactly as sent.
    if (!conversationKeys(target)) return { ok: false, error: 'bad-target' };
    if (!word(x.framework)) return { ok: false, error: 'bad-framework' };
    return { ok: true, action: { kind, target, framework: x.framework, model, machine } };
  }
  if (kind === 'session-move') {
    // A Telegram topic or an app conversation (app-conversations-in-the-pool §2.5), re-validated with
    // its real case. A Slack conversation stays with its connection, so it has no move to sign.
    if (!TOPIC_ID.test(target) && conversationKeys(target)?.kind !== 'app') return { ok: false, error: 'bad-target' };
    if (!word(x.to)) return { ok: false, error: 'bad-machine' };
    if (!absent(x.confirmation) && !(typeof x.confirmation === 'string' && CONFIRMATION.test(x.confirmation))) return { ok: false, error: 'bad-confirmation' };
    return { ok: true, action: { kind, target, to: x.to, confirmation: absent(x.confirmation) ? null : x.confirmation as string } };
  }
  if (kind === 'session-bring-back') {
    if (conversationKeys(target)?.kind !== 'app') return { ok: false, error: 'bad-target' };
    return { ok: true, action: { kind, target, confirmed: x.confirmation === 'confirmed' } };
  }
  if (kind === 'session-close') {
    if (typeof x.tmux !== 'string' || !TMUX_NAME.test(x.tmux)) return { ok: false, error: 'bad-session-name' };
    return { ok: true, action: { kind, target, tmux: x.tmux, machine } };
  }
  const framework = optional(x.framework);
  if (framework === undefined) return { ok: false, error: 'bad-framework' };
  if (kind === 'session-default') {
    if (target !== 'new-topic-default') return { ok: false, error: 'bad-target' };
    if (framework === null && model !== null) return { ok: false, error: 'bad-framework' };
    return { ok: true, action: { kind, target, framework, model } };
  }
  if (target !== 'new') return { ok: false, error: 'bad-target' };
  const name = x.name;
  if (typeof name !== 'string' || name.trim().length === 0) return { ok: false, error: 'name-required' };
  if (name !== name.trim() || name.length > MAX_SESSION_NAME_CHARS) return { ok: false, error: 'bad-name' };
  if (CONTROL_CHARS.test(name) || holdsToken(name)) return { ok: false, error: 'bad-name' };
  const platform = x.platform ?? 'auto';
  if (platform !== 'auto' && platform !== 'telegram' && platform !== 'slack' && platform !== 'app' && platform !== 'headless') return { ok: false, error: 'bad-platform' };
  // Engine, model and machine never apply to Slack or terminal-only. A signed line never names a choice the route would drop.
  if ((platform === 'slack' || platform === 'headless') && (framework !== null || model !== null || machine !== null)) return { ok: false, error: 'bad-platform' };
  // An app conversation takes an engine and model, but no machine until part 3.
  if (platform === 'app' && machine !== null) return { ok: false, error: 'bad-platform' };
  // An app conversation's title is at most 80 characters: refused here, before Face ID, not after.
  if (platform === 'app' && cleanConversationTitle(name) !== name) return { ok: false, error: 'bad-name' };
  if (framework === null && model !== null) return { ok: false, error: 'bad-framework' };
  return { ok: true, action: { kind, target, name, platform, framework, model, machine } };
}

/** The fields one request can carry into `buildAction`. */
function actionExtras(b: Rec): Parameters<typeof buildAction>[2] {
  return { value: b.value, reason: b.reason, proposalHash: b.proposalHash, disclosureHash: b.disclosureHash, label: b.label, note: b.note, topicId: b.topicId, framework: b.framework, model: b.model, machine: b.machine, to: b.to, confirmation: b.confirmation, tmux: b.tmux, name: b.name, platform: b.platform };
}

/** Text that holds a token, before or after cleaning: a name is not where a key goes. */
function holdsToken(s: string): boolean {
  return TOKEN_RUN.test(s) || TOKEN_RUN.test(cleanText(s, 1000) ?? '');
}

// ── challenges ────────────────────────────────────────────────────────────────

/**
 * Single-use secrets bound to a device, a Host and one exact action line. Only the SHA-256 of each
 * secret is kept, in memory. Consuming deletes the entry before it is judged.
 */
export class ActionChallengeStore {
  private readonly entries = new Map<string, { deviceId: string; host: string; line: string; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = PERMISSION_CHALLENGE_TTL_MS,
    private readonly perDevice = PERMISSION_CHALLENGE_PER_DEVICE, private readonly total = PERMISSION_CHALLENGE_TOTAL) {}

  issue(deviceId: string, host: string, line: string): { secret: string; expiresAt: number; ref: string } {
    this.prune();
    const mine = [...this.entries.entries()].filter(([, e]) => e.deviceId === deviceId);
    for (let i = 0; i <= mine.length - this.perDevice; i++) this.entries.delete(mine[i]![0]);
    while (this.entries.size >= this.total) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    const secret = crypto.randomBytes(32).toString('base64url');
    const expiresAt = this.now() + this.ttlMs;
    const digest = sha256(secret);
    this.entries.set(digest, { deviceId, host: host.toLowerCase(), line, expiresAt });
    return { secret, expiresAt, ref: digest.slice(0, 12) };
  }

  /** Deletes the secret first; true only when it was live and bound to exactly this device, Host and line. */
  consume(secret: unknown, deviceId: string, host: string, line: string): boolean {
    if (typeof secret !== 'string' || !SECRET_PATTERN.test(secret)) return false;
    const digest = sha256(secret);
    const e = this.entries.get(digest);
    if (!e) return false;
    this.entries.delete(digest);
    return e.expiresAt > this.now() && e.deviceId === deviceId && e.host === host.toLowerCase() && e.line === line;
  }

  size(): number { this.prune(); return this.entries.size; }

  private prune(): void {
    const t = this.now();
    for (const [k, e] of this.entries) if (e.expiresAt <= t) this.entries.delete(k);
  }
}

// ── audit ─────────────────────────────────────────────────────────────────────

export type PermissionAuditEvent = 'account-sign-in' | 'account-add' | 'team-changed' | 'challenge' | 'approved' | 'declined' | 'feature-set' | 'secret-requested' | 'secret-cancelled' | 'session-action' | 'refused';
export interface PermissionAuditRow { at: string; event: PermissionAuditEvent; deviceId: string | null; route?: string; personId?: string | null; action?: string; target?: string; requestKey?: string; value?: string; reason?: string; status?: number }

/** Metadata-only trail of every phone permission write (never a decline text, never a secret). A record, not a gate. */
export class PermissionActionAudit {
  readonly file: string;
  constructor(stateDir: string, private readonly now: () => number = Date.now) {
    this.file = path.join(stateDir, 'state', 'mobile-permission-actions.jsonl');
  }
  record(row: Omit<PermissionAuditRow, 'at'>): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      maybeRotateJsonl(this.file, { maxBytes: AUDIT_MAX_BYTES, keepRatio: 0.5 });
      fs.appendFileSync(this.file, JSON.stringify({ at: new Date(this.now()).toISOString(), ...row }) + '\n', { mode: 0o600 });
    } catch (err) {
      // @silent-fallback-ok — not silent: reported through DegradationReporter; the audit never fails the request
      featureEvidence.record('mobilePairing.permissionActions', { kind: 'error', reason: 'audit row not written', context: { event: row.event } });
      report('MobilePermissions.audit', 'the phone permission audit row is written', 'the action still runs and its own records (mandate audit, feature events) are written', err);
    }
  }
}

function report(feature: string, primary: string, fallback: string, err: unknown): void {
  try {
    DegradationReporter.getInstance().report({
      feature, primary, fallback,
      reason: err instanceof Error ? err.name : 'unknown error',
      impact: 'The owner\'s phone shows less here, or a phone action has a thinner record, until this recovers.',
    });
  } catch { /* @silent-fallback-ok — reporting must never turn an answer into a crash */ }
}

// ── read summaries ────────────────────────────────────────────────────────────

export interface ApprovalInput {
  id: string; createdByAgent?: unknown; createdAt?: unknown; requestExpiresAt?: unknown;
  headline?: unknown; reason?: unknown; heldOnThisMachine?: unknown; createdOnMachine?: unknown;
  /** The SHA-256 of the request's structured proposal, computed fresh at read time (what an approve signs). */
  proposalHash?: unknown;
  /** The grantee resolved to a registered person by name; without one the row cannot be approved here. */
  recipientKnown?: unknown;
}
export interface MobileApproval { id: string; key: string; proposalHash: string | null; headline: string; reason: string | null; agent: string; askedAt: string | null; expiresAt: string | null; here: boolean; machine: string | null }
export interface MobileSlip { key: string; title: string; summary: string; expiresAt: string | null; grants: string[]; invalid: boolean; machine: string | null }
export type PartState = 'ok' | 'off' | 'unavailable';

export interface LocalSlips {
  approvals: { state: PartState; rows: ApprovalInput[] };
  slips: { state: PartState; mandates: Rec[]; invalidIds: string[] };
}

/** One approval row in the phone's words. Peer rows are never actionable here. */
export function approvalRow(r: ApprovalInput, opts: { local: boolean; machine: string | null }): MobileApproval | null {
  if (typeof r.id !== 'string' || !TARGET_PATTERN.test(r.id)) return null;
  const headline = cleanText(r.headline, 400);
  if (!headline) return null;
  return {
    id: r.id,
    key: rowKey('permission-approval', `${opts.machine ?? 'here'}:${r.id}`),
    // Only a row held here can be approved from this answer, so only it carries the hash an approve signs.
    proposalHash: opts.local && r.heldOnThisMachine === true && r.recipientKnown === true && typeof r.proposalHash === 'string' && /^[0-9a-f]{64}$/.test(r.proposalHash) ? r.proposalHash : null,
    headline,
    reason: cleanText(r.reason, 300),
    agent: cleanText(r.createdByAgent, 80) ?? 'an agent',
    askedAt: iso(ts(r.createdAt)),
    expiresAt: iso(ts(r.requestExpiresAt)),
    here: opts.local && r.heldOnThisMachine === true,
    machine: opts.local ? (r.heldOnThisMachine === true ? null : 'another machine') : opts.machine,
  };
}

/** One active slip in words: no fingerprints, Slack ids, bounds or proofs. */
export function slipRow(m: Rec, opts: { now: number; invalid: boolean; machine: string | null; personName: (uid: string) => string | null }): MobileSlip | null {
  const id = typeof m.id === 'string' ? m.id : null;
  if (!id) return null;
  const scope = typeof m.scope === 'string' ? m.scope : '';
  const live = arr(m.grants).filter((g) => ts(g.expiresAt) > opts.now);
  const grants = live.map((g) => {
    const who = typeof g.grantedTo === 'string' ? cleanText(opts.personName(g.grantedTo), 60) : null;
    const action = typeof g.floorAction === 'string' ? (FLOOR_ACTION_LABELS[g.floorAction] ?? 'take an action') : 'take an action';
    // The time is the slip's own `expiresAt` (a grant never outlives its slip); the phone words it locally.
    return `${who ?? 'A person'} may ${action}`;
  });
  const authorities = arr(m.authorities).length;
  return {
    key: rowKey('permission-slip', `${opts.machine ?? 'here'}:${id}`),
    title: scope === 'user-authority-grant' ? 'A person may act' : (cleanText(scope.replace(/[-_]+/g, ' '), 80) ?? 'A permission slip'),
    summary: grants.length ? grants.join('; ') : `${authorities} ${authorities === 1 ? 'thing' : 'things'} these two agents may do together`,
    expiresAt: iso(ts(m.expiresAt)),
    grants,
    invalid: opts.invalid,
    machine: opts.machine,
  };
}

export interface PeerSlips { machineId: string; state: 'ok'; data: unknown }
export interface PeerUnreached { machineId: string; state: 'unreached' }

/**
 * The phone's Permission slips answer. Approvals soonest-expiring first; when capped, the rows cut
 * are the latest-expiring ones and `total` keeps the full count. Peers' rows are read-only.
 */
export function summarizeSlips(local: LocalSlips, peers: Array<PeerSlips | PeerUnreached>, opts: {
  now: number; personName: (uid: string) => string | null; nicknameOf: (id: string) => string | null; offlineMachineIds: string[];
}): Rec {
  const name = (id: string) => cleanText(verifiedEntityName(id, opts.nicknameOf(id)), 60) ?? 'another machine';
  const approvals: MobileApproval[] = [];
  const slips: MobileSlip[] = [];
  let endedCount = 0;
  let approvalsState: PartState = local.approvals.state;
  let slipsState: PartState = local.slips.state;
  // A request asked on another machine can also appear in this machine's store; its holder's own row wins.
  const elsewhere: MobileApproval[] = [];
  if (local.approvals.state === 'ok') for (const r of local.approvals.rows) { const a = approvalRow(r, { local: true, machine: null }); if (a) (a.here ? approvals : elsewhere).push(a); }
  if (local.slips.state === 'ok') {
    const invalid = new Set(local.slips.invalidIds);
    for (const m of local.slips.mandates) {
      const active = m.revoked == null && ts(m.expiresAt) > opts.now;
      if (!active) { endedCount++; continue; }
      const s = slipRow(m, { now: opts.now, invalid: invalid.has(String(m.id)), machine: null, personName: opts.personName });
      if (s) slips.push(s);
    }
  }
  const unread: string[] = [];
  const cantTell: string[] = [];
  // Rows a peer read but did not return (its own cap): counted into the totals, never as zero.
  let peerApprovalsBeyond = 0, peerSlipsBeyond = 0;
  for (const p of peers) {
    if (p.state !== 'ok') { unread.push(p.machineId); continue; }
    const d = rec(p.data);
    const machine = name(p.machineId);
    const pa = rec(d.approvals), ps = rec(d.slips);
    if (pa.state !== 'ok' && pa.state !== 'off') cantTell.push(machine);
    else if (ps.state !== 'ok' && ps.state !== 'off') cantTell.push(machine);
    if (pa.state === 'ok') {
      if (approvalsState !== 'ok') approvalsState = 'ok';
      const rows = arr(pa.rows);
      for (const r of rows) {
        const a = approvalRow({ id: r.id as string, headline: r.headline, reason: r.reason, createdByAgent: r.agent, createdAt: r.askedAt, requestExpiresAt: r.expiresAt }, { local: false, machine });
        if (a) approvals.push(a);
      }
      if (Number.isInteger(pa.total) && (pa.total as number) > rows.length) peerApprovalsBeyond += (pa.total as number) - rows.length;
    }
    if (ps.state === 'ok') {
      if (slipsState !== 'ok') slipsState = 'ok';
      const active = arr(ps.active);
      if (Number.isInteger(ps.total) && (ps.total as number) > active.length) peerSlipsBeyond += (ps.total as number) - active.length;
      for (const s of active) {
        const title = cleanText(s.title, 80), summary = cleanText(s.summary, 600);
        if (!title || !summary) continue;
        slips.push({ key: rowKey('permission-slip', `${p.machineId}:${String(s.key ?? title)}`), title, summary, expiresAt: iso(ts(s.expiresAt)), grants: [], invalid: s.invalid === true, machine });
      }
      endedCount += Number.isInteger(ps.endedCount) && (ps.endedCount as number) > 0 ? ps.endedCount as number : 0;
    }
  }
  const seen = new Set(approvals.map((a) => a.id));
  for (const a of elsewhere) if (!seen.has(a.id)) approvals.push(a);
  const byExpiry = (a: { expiresAt: string | null }, b: { expiresAt: string | null }) => (ts(a.expiresAt) || Infinity) - (ts(b.expiresAt) || Infinity);
  approvals.sort(byExpiry);
  slips.sort(byExpiry);
  const unreadNames = unread.map(name);
  const offline = opts.offlineMachineIds.map(name);
  const approvalsTotal = approvals.length + peerApprovalsBeyond, slipsTotal = slips.length + peerSlipsBeyond;
  return {
    approvals: { state: approvalsState, rows: approvals.slice(0, MAX_APPROVAL_ROWS), total: approvalsTotal, truncated: approvalsTotal > Math.min(approvals.length, MAX_APPROVAL_ROWS) },
    slips: { state: slipsState, active: slips.slice(0, MAX_SLIP_ROWS), total: slipsTotal, endedCount, truncated: slipsTotal > Math.min(slips.length, MAX_SLIP_ROWS) },
    unread: { count: unread.length, names: unreadNames },
    offline: { count: offline.length, names: offline },
    cantTell: { count: cantTell.length, names: cantTell },
  };
}

/** This machine's slips only, as a peer reads them (`?scope=local`): rows already in the phone's words. */
export function summarizeLocalSlips(local: LocalSlips, opts: { now: number; personName: (uid: string) => string | null }): Rec {
  const s = summarizeSlips(local, [], { ...opts, nicknameOf: () => null, offlineMachineIds: [] });
  const approvals = rec(s.approvals), slips = rec(s.slips);
  // Only rows held on this machine (the reading machine marks every peer row read-only anyway).
  const here = arr(approvals.rows).filter((r) => r.here === true);
  return {
    approvals: { state: approvals.state, rows: here, total: here.length + Math.max(0, Number(approvals.total) - arr(approvals.rows).length) },
    slips: { state: slips.state, active: slips.active, total: slips.total, endedCount: slips.endedCount },
  };
}

const STATE_WORD: Record<string, string> = { enabled: 'On', disabled: 'Off', undiscovered: 'Not tried', aware: 'Seen', interested: 'Interested', deferred: 'Later', declined: 'Declined' };
const NEEDS_NOTICE = new Set(['on-after-restart', 'off-after-restart', 'recorded-only', 'not-recorded']);

export interface MobileConsent { tier: string; description: string | null; data: Array<{ text: string; goesTo: string | null }>; howToUndo: string | null; disclosureHash: string }
export interface MobileFeature { id: string; name: string; oneLiner: string | null; on: boolean; stateWords: string; switchable: boolean; readOnlyReason: string | null; notice: boolean; offWarning: string | null; consent: MobileConsent | null }

/**
 * What turning a consent-tier switch on records the owner agreed to (operatorSet stores an
 * `explicit-written` consent record with these data implications), in the phone's words, plus the
 * hash of exactly that disclosure. The turn-on action line carries the hash, so a phone switch-on
 * records consent only to the disclosure the phone was sent (the console's sheet shows the same list).
 */
export function consentDisclosure(def: Rec): MobileConsent | null {
  const tier = typeof def.consentTier === 'string' ? def.consentTier : '';
  if (!CONSENT_TIERS.has(tier)) return null;
  const description = cleanText(def.fullDescription, 1000) ?? cleanText(def.oneLiner, 200) ?? cleanText(def.name, 80);
  const data = arr(def.dataImplications).map((d) => ({
    text: cleanText(d.description, 300) ?? cleanText(d.dataType, 80) ?? 'Unnamed data',
    goesTo: typeof d.destination === 'string' && d.destination && d.destination !== 'local' ? cleanText(d.destination, 120) : null,
  }));
  const howToUndo = cleanText(def.reversibilityNote, 400);
  const disclosureHash = sha256(JSON.stringify([String(def.id), tier, description, data.map((d) => [d.text, d.goesTo]), howToUndo]));
  return { tier, description, data, howToUndo, disclosureHash };
}

/** The disclosure hash a switch to `to` must carry: the consent disclosure's for a consent-tier turn-on, else `none`. */
export function expectedDisclosure(def: Rec, to: 'enabled' | 'disabled'): string {
  return to === 'enabled' ? (consentDisclosure(def)?.disclosureHash ?? NO_DISCLOSURE) : NO_DISCLOSURE;
}

/** What turning a switch off from the phone can cost, said in the confirmation (spec Frontloaded Decision 12). */
export const OFF_WARNINGS: Record<string, string> = {
  'cloudflare-tunnel': 'Your phone may reach this agent through this tunnel. Turning it off can cut this phone off until it is turned back on from the console.',
  'external-operation-gate': 'This is a safety check. Turning it off lets the agent act on outside services without it.',
  'input-guard': 'This is a safety check. Turning it off lets messages reach the agent without it.',
  'response-review': 'This is a safety check. Turning it off lets the agent send replies without it.',
};

/** One feature switch in the phone's words, as the console flattens it (allowed-model.js flattenFeature). */
export function featureRow(f: Rec): MobileFeature | null {
  const def = rec(f.definition), st = rec(f.state), eff = f.effective && typeof f.effective === 'object' ? rec(f.effective) : null;
  const id = typeof def.id === 'string' && TARGET_PATTERN.test(def.id) ? def.id : null;
  if (!id) return null;
  const state = typeof st.discoveryState === 'string' ? st.discoveryState : 'undiscovered';
  const switchable = def.switchable !== false;
  const status = eff && typeof eff.status === 'string' ? eff.status : null;
  return {
    id,
    name: cleanText(verifiedEntityName(id, typeof def.name === 'string' ? def.name : null), 80) ?? 'Unnamed feature',
    oneLiner: cleanText(def.oneLiner, 200),
    on: switchable ? state === 'enabled' : status === 'on',
    stateWords: cleanText(eff?.summary, 200) ?? STATE_WORD[state] ?? 'Unknown',
    switchable,
    readOnlyReason: switchable ? null : (cleanText(def.honestyNote, 200) ?? cleanText(eff?.detail, 200) ?? 'This switch is read-only in this version.'),
    notice: status !== null && NEEDS_NOTICE.has(status),
    offWarning: OFF_WARNINGS[id] ?? null,
    consent: switchable ? consentDisclosure(def) : null,
  };
}

/**
 * Other machines' switches, read-only (each is switched on its own machine): one group per machine
 * that answered, in the phone's words; machines that did not answer and offline machines named.
 */
export function summarizePeerFeatures(peers: Array<PeerSlips | PeerUnreached>, opts: { nicknameOf: (id: string) => string | null; offlineMachineIds: string[] }): Rec {
  const name = (id: string) => cleanText(verifiedEntityName(id, opts.nicknameOf(id)), 60) ?? 'another machine';
  const otherMachines: Rec[] = [];
  const unread: string[] = [];
  for (const p of peers) {
    if (p.state !== 'ok') { unread.push(name(p.machineId)); continue; }
    const d = rec(p.data);
    const state = d.state === 'ok' || d.state === 'off' ? d.state : 'unavailable';
    // A peer's rows pass the same field allow-list as this machine's (rebuilt, never passed through).
    const features = arr(d.features).map((f) => featureRow({ definition: { id: f.id, name: f.name, oneLiner: f.oneLiner, switchable: f.switchable, honestyNote: f.readOnlyReason },
      state: { discoveryState: f.on === true ? 'enabled' : 'disabled' }, effective: { status: f.on === true ? 'on' : 'off', summary: f.stateWords } }))
      .filter((f): f is MobileFeature => f !== null).map((f) => ({ ...f, offWarning: null, consent: null }));
    otherMachines.push({ key: rowKey('permission-machine', p.machineId), name: name(p.machineId), state, features });
  }
  const offline = opts.offlineMachineIds.map(name);
  return { otherMachines, unread: { count: unread.length, names: unread }, offline: { count: offline.length, names: offline } };
}

// ── routes ────────────────────────────────────────────────────────────────────

export interface ActionResult { status: number; body: unknown }

export interface MobilePermissionsDeps {
  pairing: () => MobilePairingService | null;
  config: () => InstarConfig;
  stateDir: string;
  bearerOk: (req: Request) => boolean;
  localSlips: () => LocalSlips;
  personName: (slackUserId: string) => string | null;
  peerSlips: () => Promise<Array<PeerSlips | PeerUnreached>>;
  /** Each online peer's `GET /mobile/permissions/features?scope=local` (read-only here). */
  peerFeatures: () => Promise<Array<PeerSlips | PeerUnreached>>;
  offlineMachineIds?: () => string[];
  /** The answering machine's verified name, or null. */
  selfName?: () => string | null;
  nicknameOf: (machineId: string) => string | null;
  features: () => { state: PartState; list: Rec[] };
  /** One registry definition by id (null when unknown), for the disclosure a switch must carry. */
  featureDefinition: (id: string) => Rec | null;
  /** The console's approve path (after its PIN check), for a request held here whose proposal still hashes to `proposalHash`. */
  approve: (id: string, proposalHash: string, deviceId: string) => ActionResult;
  /** The console's deny path (after its PIN check). */
  deny: (id: string, reason: string, deviceId: string) => ActionResult;
  /** The console's operator-switch path (after its operator-session check). */
  setFeature: (req: Request, id: string, to: 'enabled' | 'disabled', deviceId: string, stillAuthorized: () => string | null) => Promise<ActionResult>;
  /** Ask for a password or key on this machine (mobileSecretsRoutes.ts `askForSecret`). Never answers a token or link. */
  requestSecret: (label: string, note: string, topicId: number | null) => ActionResult;
  /** Cancel the request behind this one-way key, on this machine. */
  cancelSecret: (key: string) => ActionResult;
  /** A session control: runs the dashboard's own route and answers in the phone's words (mobileSessionControlsRoutes.ts). */
  sessionAction?: (action: SessionAction, deviceId: string) => Promise<ActionResult>;
  /** Team access's Face ID actions (team-roles-and-access §3.6, §4.1). */
  teamAction?: (kind: TeamActionKind, req: Request, deviceId: string, target?: string) => Promise<ActionResult>;
  /**
   * Start a fresh sign-in for one account on one machine: the console's own
   * `POST /subscription-pool/matrix/start-cell` core after its PIN check (routes.ts runMatrixStartCell),
   * answering the same body. Face ID stands in for the PIN (account-sign-in-face-id).
   */
  startAccountSignIn?: (accountId: string, machineId: string, req: Request) => Promise<ActionResult>;
  /**
   * Add a Claude or Codex account and start its sign-in on this machine (routes.ts runAddAccountSignIn),
   * answering start-cell's body. The account joins the pool only when the sign-in completes with this email.
   */
  addAccount?: (input: { kind: NewAccountKind; nickname: string | null; email: string }) => Promise<ActionResult>;
  now?: () => number;
}

type Refusal = { status: number; error: string; detail?: string };

/** The route for an audit row. A secrets path is named, not copied: its key segment is caller-supplied text. */
function auditRoute(req: Request): string {
  return req.path.startsWith('/mobile/secrets/') ? '/mobile/secrets/requests' : req.path.slice(0, 120);
}

function principalDevice(req: Request): string | null {
  const p = (req as unknown as { instarPrincipal?: { kind: string; deviceId?: unknown } }).instarPrincipal;
  return p && p.kind === 'device' && typeof p.deviceId === 'string' ? p.deviceId : null;
}

/**
 * The console-ticket transport rule (mobileConsoleTicket.ts): this machine's own TLS front or
 * loopback (the tunnel connector) — stricter than the console's PIN unlock, which needs it only
 * while direct desktop access is on.
 */
function overLocalTls(req: Request): boolean {
  return arrivedOverLocalTls(req.secure, req.socket.remoteAddress, req.headers['x-forwarded-proto']);
}

/** What the caller could do here (shown before any button). */
export function actionsState(req: Request, deps: Pick<MobilePermissionsDeps, 'pairing' | 'config'>): { state: 'available' | 'console-only'; reason: string | null; presenceKey: boolean } {
  const p = (req as unknown as { instarPrincipal?: { kind: string; deviceId?: string } }).instarPrincipal;
  const svc = deps.pairing();
  if (!p || p.kind !== 'device' || typeof p.deviceId !== 'string') return { state: 'console-only', reason: 'bearer', presenceKey: false };
  const presenceKey = !!svc?.devices.get(p.deviceId)?.presenceKey;
  const config = deps.config();
  if (!svc || !svc.enabled() || !isPermissionActionsEnabled(config)) return { state: 'console-only', reason: 'off', presenceKey };
  if (!overLocalTls(req)) return { state: 'console-only', reason: 'transport', presenceKey };
  if (!activeOwnerPhone(svc, p.deviceId)) return { state: 'console-only', reason: 'not-owner', presenceKey };
  if (!config.dashboardPin) return { state: 'console-only', reason: 'no-pin', presenceKey };
  // A phone without its key enrols it through the console-ticket enrolment route, which that switch gates.
  if (!presenceKey && !isConsoleTicketEnabled(config)) return { state: 'console-only', reason: 'enrol-off', presenceKey };
  return { state: 'available', reason: null, presenceKey };
}

export function mountMobilePermissionsRoutes(router: Router, deps: MobilePermissionsDeps): void {
  const now = () => (deps.now ? deps.now() : Date.now());
  const challenges = new ActionChallengeStore(now);
  const audit = new PermissionActionAudit(deps.stateDir, now);
  const head = () => ({ schemaVersion: MOBILE_PERMISSIONS_SCHEMA_VERSION, generatedAt: new Date(now()).toISOString() });
  const readGuard = (req: Request, res: Response): boolean => {
    res.set('Cache-Control', 'no-store');
    if (ownerOrBearer(req, deps.bearerOk)) return true;
    res.status(403).json({ error: 'owner-phone-required', detail: 'Only the owner\'s phone can see permission slips and feature switches.' });
    return false;
  };
  const localSlips = (): LocalSlips => {
    try { return deps.localSlips(); } catch (err) {
      // @silent-fallback-ok — not silent: reported; both parts read as unavailable
      report('MobilePermissions.read', 'GET /mobile/permissions/slips reads this machine\'s approvals and slips', 'that part reads "can\'t tell"', err);
      return { approvals: { state: 'unavailable', rows: [] }, slips: { state: 'unavailable', mandates: [], invalidIds: [] } };
    }
  };

  router.get('/mobile/permissions/slips', async (req: Request, res: Response) => {
    if (!readGuard(req, res)) return;
    const local = req.query.scope === 'local';
    const l = localSlips();
    if (local) { res.json({ ...head(), ...summarizeLocalSlips(l, { now: now(), personName: deps.personName }) }); return; }
    let peers: Array<PeerSlips | PeerUnreached> = [];
    try { peers = await deps.peerSlips(); } catch (err) {
      // @silent-fallback-ok — not silent: reported; this machine's rows are still shown and peers are not counted
      report('MobilePermissions.read', 'GET /mobile/permissions/slips reads the other machines', 'only this machine\'s rows are shown', err);
    }
    let offline: string[] = [];
    try { offline = deps.offlineMachineIds?.() ?? []; } catch (err) {
      // @silent-fallback-ok — not silent: reported; offline machines are then not named
      report('MobilePermissions.read', 'the offline machine list', 'offline machines are not named', err);
    }
    res.json({ ...head(), actions: actionsState(req, deps), ...summarizeSlips(l, peers, { now: now(), personName: deps.personName, nicknameOf: deps.nicknameOf, offlineMachineIds: offline }) });
  });

  router.get('/mobile/permissions/features', async (req: Request, res: Response) => {
    if (!readGuard(req, res)) return;
    let part: { state: PartState; list: Rec[] };
    try { part = deps.features(); } catch (err) {
      // @silent-fallback-ok — not silent: reported; the list reads as unavailable
      report('MobilePermissions.read', 'GET /mobile/permissions/features reads the feature registry', 'the list reads "can\'t tell"', err);
      part = { state: 'unavailable', list: [] };
    }
    const features = part.state === 'ok' ? part.list.map(featureRow).filter((f): f is MobileFeature => f !== null) : [];
    if (req.query.scope === 'local') { res.json({ ...head(), state: part.state, features }); return; }
    let peers: Array<PeerSlips | PeerUnreached> = [];
    try { peers = await deps.peerFeatures(); } catch (err) {
      // @silent-fallback-ok — not silent: reported; only this machine's switches are shown and peers are not counted
      report('MobilePermissions.read', 'GET /mobile/permissions/features reads the other machines', 'only this machine\'s switches are shown', err);
    }
    let offline: string[] = [];
    try { offline = deps.offlineMachineIds?.() ?? []; } catch (err) {
      // @silent-fallback-ok — not silent: reported; offline machines are then not named
      report('MobilePermissions.read', 'the offline machine list', 'offline machines are not named', err);
    }
    // `machine`: the answering machine's name, so the phone titles its switches by name, never "This machine".
    res.json({ ...head(), actions: actionsState(req, deps), state: part.state, machine: cleanText(deps.selfName?.() ?? null, 60), features, ...summarizePeerFeatures(peers, { nicknameOf: deps.nicknameOf, offlineMachineIds: offline }) });
  });

  /** Steps 1–6 of the write gate (spec §3.3). Answers and returns null on refusal. */
  // `teamControl`: turning team access off, restoring it and requiring privacy must always work for
  // whoever could invite, so they do not hang on this feature's switch or the console PIN (§3.6).
  const writeGate = (req: Request, res: Response, teamControl = false): { deviceId: string; personId: string | null; host: string; presenceKey: string; svc: MobilePairingService } | null => {
    res.set('Cache-Control', 'no-store');
    // Every refusal leaves a trace before the answer (A Refusal Stays a Refusal); the bearer has no device id.
    const refuse = (r: Refusal, deviceId: string | null = principalDevice(req)): null => {
      audit.record({ event: 'refused', deviceId, route: auditRoute(req), reason: r.error, status: r.status });
      res.status(r.status).json({ error: r.error, ...(r.detail ? { detail: r.detail } : {}) });
      return null;
    };
    const svc = deps.pairing();
    const config = deps.config();
    if (!svc || !svc.enabled() || (!teamControl && !isPermissionActionsEnabled(config))) return refuse({ status: 503, error: 'permission-actions-off', detail: 'Changing permissions from the phone is turned off on this agent. Open the console to change this.' });
    const p = (req as unknown as { instarPrincipal?: { kind: string; deviceId?: string } }).instarPrincipal;
    if (!p || p.kind !== 'device' || typeof p.deviceId !== 'string') return refuse({ status: 403, error: 'device-signature-required', detail: 'Only the owner\'s paired phone can do this here. Open the console to change this.' });
    const deviceId = p.deviceId;
    if (!overLocalTls(req)) return refuse({ status: 403, error: 'secure-transport-required' }, deviceId);
    if (!activeOwnerPhone(svc, deviceId)) return refuse({ status: 403, error: 'owner-phone-required' }, deviceId);
    if (!teamControl && !config.dashboardPin) return refuse({ status: 503, error: 'console-pin-not-set', detail: 'The console has no PIN set, so it cannot approve or switch either. Set a PIN first.' }, deviceId);
    const d = svc.devices.get(deviceId);
    if (!d?.presenceKey) return refuse({ status: 409, error: 'presence-key-missing' }, deviceId);
    const raw = (req as unknown as { instarDeviceHost?: unknown }).instarDeviceHost;
    const host = normalHost(typeof raw === 'string' && raw.length > 0 ? raw : d.host ?? '');
    const person = svc.personOfDevice(d);
    return { deviceId, personId: person.userId ?? null, host, presenceKey: d.presenceKey, svc };
  };

  router.post('/mobile/permissions/challenge', (req: Request, res: Response) => {
    const b = rec(req.body);
    const g = writeGate(req, res, b.action === 'team-off' || b.action === 'team-restore' || b.action === 'team-memory-privacy' || b.action === 'team-origin-gone' || b.action === 'team-switch-on');
    if (!g) return;
    const built = buildAction(b.action, b.target, actionExtras(b));
    if (!built.ok) { audit.record({ event: 'refused', deviceId: g.deviceId, personId: g.personId, route: auditRoute(req), reason: built.error, status: 400 }); res.status(400).json({ error: built.error }); return; }
    const line = actionLine(built.action);
    const c = challenges.issue(g.deviceId, g.host, line);
    audit.record({ event: 'challenge', deviceId: g.deviceId, personId: g.personId, action: built.action.kind, target: built.action.target, ...(built.action.kind === 'set-feature' ? { value: built.action.value } : {}) });
    res.json({ challenge: c.secret, expiresAt: new Date(c.expiresAt).toISOString() });
  });

  /** Steps 7–9: the action line from the route, the challenge, the signature. */
  const proven = (req: Request, res: Response, g: { deviceId: string; personId: string | null; host: string; presenceKey: string }, action: PermissionAction): boolean => {
    const b = rec(req.body);
    const line = actionLine(action);
    const base = { deviceId: g.deviceId, personId: g.personId, action: action.kind, target: action.target, ...(action.kind === 'set-feature' ? { value: action.value } : {}) };
    if (!challenges.consume(b.challenge, g.deviceId, g.host, line)) {
      audit.record({ event: 'refused', ...base, reason: 'challenge-invalid', status: 401 });
      res.status(401).json({ error: 'challenge-invalid' });
      return false;
    }
    if (!verifyPresenceSignature(g.presenceKey, permissionPresenceMessage(g.deviceId, g.host, b.challenge as string, line), b.presenceSig)) {
      audit.record({ event: 'refused', ...base, reason: 'presence-invalid', status: 401 });
      res.status(401).json({ error: 'presence-invalid' });
      return false;
    }
    return true;
  };

  const finish = (res: Response, event: PermissionAuditEvent, action: PermissionAction, g: { deviceId: string; personId: string | null }, r: ActionResult): void => {
    const ok = r.status >= 200 && r.status < 300;
    // A request's signed target is `new`; its one-way key ties the row to the request it made.
    const madeKey = rec(r.body).key;
    // The action kind only: a target can name a secret path.
    if (ok) featureEvidence.record('mobilePairing.permissionActions', { kind: 'fired', reason: event, context: { action: action.kind } });
    audit.record({ event: ok ? event : 'refused', deviceId: g.deviceId, personId: g.personId, action: action.kind, target: action.target, ...(action.kind === 'request-secret' && typeof madeKey === 'string' ? { requestKey: madeKey } : {}), ...(action.kind === 'set-feature' ? { value: action.value } : {}), status: r.status, ...(ok ? {} : { reason: errorCode(r.body) }) });
    res.status(r.status).json(r.body);
  };

  router.post('/mobile/permissions/requests/:id/approve', (req: Request, res: Response) => {
    const g = writeGate(req, res);
    if (!g) return;
    const built = buildAction('approve-request', String(req.params.id), { proposalHash: rec(req.body).proposalHash });
    if (!built.ok) { audit.record({ event: 'refused', deviceId: g.deviceId, personId: g.personId, route: auditRoute(req), reason: built.error, status: 400 }); res.status(400).json({ error: built.error }); return; }
    if (!proven(req, res, g, built.action)) return;
    const a = built.action as Extract<PermissionAction, { kind: 'approve-request' }>;
    finish(res, 'approved', a, g, runAction(() => deps.approve(a.target, a.proposalHash, g.deviceId)));
  });

  router.post('/mobile/permissions/requests/:id/decline', (req: Request, res: Response) => {
    const g = writeGate(req, res);
    if (!g) return;
    const built = buildAction('decline-request', String(req.params.id), { reason: rec(req.body).reason });
    if (!built.ok) { audit.record({ event: 'refused', deviceId: g.deviceId, personId: g.personId, route: auditRoute(req), reason: built.error, status: 400 }); res.status(400).json({ error: built.error }); return; }
    if (!proven(req, res, g, built.action)) return;
    const a = built.action as Extract<PermissionAction, { kind: 'decline-request' }>;
    finish(res, 'declined', a, g, runAction(() => deps.deny(a.target, a.reason, g.deviceId)));
  });

  router.post('/mobile/secrets/requests', (req: Request, res: Response) => {
    const g = writeGate(req, res);
    if (!g) return;
    const body = rec(req.body);
    const built = buildAction('request-secret', 'new', { label: body.label, note: body.note, topicId: body.topicId });
    if (!built.ok) { audit.record({ event: 'refused', deviceId: g.deviceId, personId: g.personId, route: auditRoute(req), reason: built.error, status: 400 }); res.status(400).json({ error: built.error }); return; }
    if (!proven(req, res, g, built.action)) return;
    const a = built.action as Extract<PermissionAction, { kind: 'request-secret' }>;
    finish(res, 'secret-requested', a, g, runAction(() => deps.requestSecret(a.label, a.note, a.topicId)));
  });

  router.post('/mobile/secrets/requests/:key/cancel', (req: Request, res: Response) => {
    const g = writeGate(req, res);
    if (!g) return;
    const built = buildAction('cancel-secret', String(req.params.key), {});
    if (!built.ok) { audit.record({ event: 'refused', deviceId: g.deviceId, personId: g.personId, route: auditRoute(req), reason: built.error, status: 400 }); res.status(400).json({ error: built.error }); return; }
    if (!proven(req, res, g, built.action)) return;
    const a = built.action as Extract<PermissionAction, { kind: 'cancel-secret' }>;
    finish(res, 'secret-cancelled', a, g, runAction(() => deps.cancelSecret(a.target)));
  });

  // The session controls: one gate, one challenge store, one audit file, one switch. `target` comes from
  // the path when the path names one, so the signed line always names what the route will act on.
  const sessionRoute = (path: string, kind: SessionAction['kind'], targetOf: (req: Request) => string): void => {
    router.post(path, async (req: Request, res: Response) => {
      const g = writeGate(req, res);
      if (!g) return;
      const built = buildAction(kind, targetOf(req), actionExtras(rec(req.body)));
      if (!built.ok) { audit.record({ event: 'refused', deviceId: g.deviceId, personId: g.personId, route: auditRoute(req), reason: built.error, status: 400 }); res.status(400).json({ error: built.error }); return; }
      if (!proven(req, res, g, built.action)) return;
      const a = built.action as SessionAction;
      let r: ActionResult;
      try {
        r = deps.sessionAction ? await deps.sessionAction(a, g.deviceId) : { status: 503, body: { error: 'session-controls-unavailable', message: 'This agent cannot change sessions from the phone yet. Open the console to change this.' } };
      } catch (err) {
        // @silent-fallback-ok — not silent: reported; the phone is told the action did not run
        report('MobilePermissions.write', 'a phone session control runs the dashboard\'s route', 'the phone says it could not do it', err);
        r = { status: 500, body: { error: 'permission-action-failed', message: 'The agent could not do that. Try again in a moment.' } };
      }
      finish(res, 'session-action', a, g, r);
    });
  };
  sessionRoute('/mobile/sessions/door/:topic', 'session-door', (req) => String(req.params.topic));
  sessionRoute('/mobile/sessions/move/:topic', 'session-move', (req) => String(req.params.topic));
  sessionRoute('/mobile/sessions/bring-back/:conversation', 'session-bring-back', (req) => String(req.params.conversation));
  sessionRoute('/mobile/sessions/close/:id', 'session-close', (req) => String(req.params.id));
  sessionRoute('/mobile/sessions/new', 'session-new', () => 'new');
  sessionRoute('/mobile/sessions/default', 'session-default', () => 'new-topic-default');

  const teamRoute = (routePath: string, kind: TeamActionKind, targetOf: (req: Request) => unknown = () => 'team'): void => {
    router.post(routePath, async (req: Request, res: Response) => {
      const g = writeGate(req, res, true);
      if (!g) return;
      const built = buildAction(kind, targetOf(req), {});
      if (!built.ok) { audit.record({ event: 'refused', deviceId: g.deviceId, personId: g.personId, route: auditRoute(req), reason: built.error, status: 400 }); res.status(400).json({ error: built.error }); return; }
      if (!proven(req, res, g, built.action)) return;
      let r: ActionResult;
      try {
        r = deps.teamAction ? await deps.teamAction(kind, req, g.deviceId, built.action.target) : { status: 503, body: { error: 'team-access-unavailable', detail: 'Team access is not available on this agent.' } };
      } catch (err) {
        // The reason goes to the log. The phone gets words a person can use.
        console.warn(`[team-access] ${kind} failed: ${err instanceof Error ? err.message : String(err)}`);
        const body = { error: 'team-action-failed', detail: 'That did not work, and nothing changed. Try again.' };
        r = { status: 500, body: isStorageFailure(err) ? storageErrorResponse(body, deps.stateDir) : body };
      }
      finish(res, 'team-changed', built.action, g, r);
    });
  };
  teamRoute('/mobile/team/off', 'team-off');
  teamRoute('/mobile/team/restore', 'team-restore');
  teamRoute('/mobile/team/origin-gone', 'team-origin-gone');
  teamRoute('/mobile/team/memory-privacy', 'team-memory-privacy');
  // One tap turns a setting on for every machine of the agent. The setting is the signed target.
  teamRoute('/mobile/team/switches/turn-on', 'team-switch-on', (req) => rec(req.body).setting ?? rec(req.body).target);

  // Start a fresh sign-in for one account on one machine (docs/specs/account-sign-in-face-id.md). The pair
  // comes from the body and is the signed target, so a Face ID proof for one account starts no other.
  router.post('/mobile/accounts/sign-in/start', async (req: Request, res: Response) => {
    const g = writeGate(req, res);
    if (!g) return;
    const b = rec(req.body);
    const built = buildAction('account-sign-in', accountSignInTarget(b.accountId, b.machineId), {});
    if (!built.ok) { audit.record({ event: 'refused', deviceId: g.deviceId, personId: g.personId, route: auditRoute(req), reason: built.error, status: 400 }); res.status(400).json({ error: built.error, detail: 'That account or machine name is not one the agent knows how to read.' }); return; }
    if (!proven(req, res, g, built.action)) return;
    const a = built.action as Extract<PermissionAction, { kind: 'account-sign-in' }>;
    let r: ActionResult;
    try {
      r = deps.startAccountSignIn ? await deps.startAccountSignIn(a.accountId, a.machineId, req) : { status: 503, body: { error: 'account-sign-in-unavailable', detail: 'This agent cannot start a sign-in from the phone yet. Use the dashboard.' } };
    } catch (err) {
      // @silent-fallback-ok — not silent: reported; the phone is told the sign-in did not start
      report('MobilePermissions.write', 'a phone account sign-in runs the console\'s start-cell core', 'the phone says the sign-in did not start', err);
      r = { status: 500, body: { error: 'account-sign-in-failed', detail: 'The sign-in did not start. Try again in a moment.' } };
    }
    finish(res, 'account-sign-in', a, g, r);
  });

  // Add a Claude or Codex account (docs/specs/account-add-face-id.md). The kind is the signed target; the body
  // carries only the kind, an optional nickname and the account's email, never a credential.
  router.post('/mobile/accounts/add', async (req: Request, res: Response) => {
    const g = writeGate(req, res);
    if (!g) return;
    const b = rec(req.body);
    const refuse400 = (error: string, detail: string): void => {
      audit.record({ event: 'refused', deviceId: g.deviceId, personId: g.personId, route: auditRoute(req), reason: error, status: 400 });
      res.status(400).json({ error, detail });
    };
    const extra = Object.keys(b).find((k) => !ACCOUNT_ADD_FIELDS.has(k));
    if (extra !== undefined) { refuse400('unexpected-field', 'Only the account kind, a nickname and the account email can be sent here. Passwords and keys are never accepted.'); return; }
    const built = buildAction('account-add', b.provider, {});
    if (!built.ok) { refuse400(built.error, 'Choose Claude or Codex.'); return; }
    const nickname = absent(b.nickname) ? null : b.nickname;
    if (nickname !== null && (typeof nickname !== 'string' || nickname.trim() !== nickname || nickname.length > MAX_ACCOUNT_NICKNAME_CHARS || CONTROL_CHARS.test(nickname) || holdsToken(nickname))) { refuse400('bad-nickname', 'Use a short plain name for this account.'); return; }
    if (typeof b.email !== 'string' || b.email.length === 0 || b.email.length > 254 || CONTROL_CHARS.test(b.email) || !/^[^@\s]+@[^@\s]+$/.test(b.email.trim())) { refuse400('bad-email', 'Enter the email of the account you will sign in with.'); return; }
    if (!proven(req, res, g, built.action)) return;
    const a = built.action as Extract<PermissionAction, { kind: 'account-add' }>;
    let r: ActionResult;
    try {
      r = deps.addAccount ? await deps.addAccount({ kind: a.target, nickname: nickname as string | null, email: (b.email as string).trim() }) : { status: 503, body: { error: 'account-add-unavailable', detail: 'This agent cannot add accounts from the phone yet. Use the dashboard.' } };
    } catch (err) {
      // @silent-fallback-ok — not silent: reported; the phone is told the account was not added
      report('MobilePermissions.write', 'a phone add-account runs the account sign-in core', 'the phone says the account was not added', err);
      r = { status: 500, body: { error: 'account-add-failed', detail: 'The account was not added. Try again in a moment.' } };
    }
    finish(res, 'account-add', a, g, r);
  });

  router.post('/mobile/permissions/features/:id', async (req: Request, res: Response) => {
    const g = writeGate(req, res);
    if (!g) return;
    const built = buildAction('set-feature', String(req.params.id), { value: rec(req.body).to, disclosureHash: rec(req.body).disclosureHash });
    if (!built.ok) { audit.record({ event: 'refused', deviceId: g.deviceId, personId: g.personId, route: auditRoute(req), reason: built.error, status: 400 }); res.status(400).json({ error: built.error }); return; }
    if (!proven(req, res, g, built.action)) return;
    const a = built.action as Extract<PermissionAction, { kind: 'set-feature' }>;
    // The disclosure the phone signed must be the one turning this switch on records consent to now.
    const def = deps.featureDefinition(a.target);
    if (def && def.switchable !== false && expectedDisclosure(def, a.value) !== a.disclosureHash) {
      finish(res, 'feature-set', a, g, { status: 409, body: { error: 'disclosure-changed', detail: 'What this switch shares has changed. Look again before turning it on.' } });
      return;
    }
    let r: ActionResult;
    // Re-checked inside the per-feature chain, right before the switch runs.
    const stillAuthorized = (): string | null => {
      const svc = deps.pairing();
      const config = deps.config();
      if (!svc || !svc.enabled() || !isPermissionActionsEnabled(config)) return 'permission-actions-off';
      if (!config.dashboardPin) return 'console-pin-not-set';
      return activeOwnerPhone(svc, g.deviceId) ? null : 'owner-phone-required';
    };
    try { r = await deps.setFeature(req, a.target, a.value, g.deviceId, stillAuthorized); } catch (err) {
      // @silent-fallback-ok — not silent: reported; the phone is told the switch did not change
      report('MobilePermissions.write', 'POST /mobile/permissions/features/:id sets the switch', 'the phone says it could not change the switch', err);
      r = { status: 500, body: { error: 'feature-switch-failed' } };
    }
    finish(res, 'feature-set', a, g, r);
  });
}

function runAction(f: () => ActionResult): ActionResult {
  try { return f(); } catch (err) {
    // @silent-fallback-ok — not silent: reported; the phone is told the action did not run
    report('MobilePermissions.write', 'a phone approve or decline runs the console\'s path', 'the phone says it could not do it', err);
    return { status: 500, body: { error: 'permission-action-failed' } };
  }
}

function errorCode(body: unknown): string {
  const e = rec(body).error;
  if (typeof e === 'string') return e.slice(0, 80);
  const c = rec(e).code;
  return typeof c === 'string' ? c.slice(0, 80) : 'refused';
}
