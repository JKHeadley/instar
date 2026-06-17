/**
 * WS5.2 §6.1a — the `subscription-account-meta` replicated JournalKind.
 *
 * Registry follow-me = METADATA ONLY (spec §6.1, R2). A redacted projection of a
 * SubscriptionAccount replicates so a peer machine KNOWS the account exists and how loaded it
 * is (`GET /subscription-pool?scope=pool`, WS5.1) WITHOUT ever holding its login. THE LOGIN
 * LOCATION (`configHome`) AND EVERY CREDENTIAL FIELD ARE STRIPPED — `configHome` is meaningless
 * cross-machine and replicating it would invite the "just point at the path" leak the boundary
 * forbids; no credential field exists in this shape at all.
 *
 * It rides the MODERN ReplicatedKindRegistry path (like the 8 WS2 `*-record` kinds): the
 * schema below is validated on top of the generic envelope by BOTH CoherenceJournal.validate()
 * (send/source-of-truth mirror) AND JournalSyncApplier.validateData (receive side) — both route
 * through `replicatedRegistry.getByKind()` first. This resolves the spec↔code divergence: the
 * spec cited the legacy inline `JournalSyncApplier.validateData` branch (line 574), but the
 * codebase moved to the registry; registering THIS schema satisfies the spec's intent (a strict
 * receive-side validator) on the current architecture. The dual-registry coupling test asserts
 * the kind is ALSO present in JOURNAL_KINDS — a kind without its validator suspect-flags peers.
 *
 * Free-text content-injection surface = `nickname`/`email` (operator/provider free text rendered
 * into agent context + the dashboard). Both are control-char-stripped + length-clamped (≤256).
 * `email` is operator/provider PII that lands at-rest in each same-operator peer's plaintext
 * coherence-journal replica — accepted as low-stakes (email is NEVER a secret); named, not silent.
 *
 * Ships DARK behind `multiMachine.accountFollowMe` (this kind only emits/applies when enabled).
 */

import {
  RESERVED_ENVELOPE_FIELDS,
  type StoreFieldSchema,
  type StoreValidateContext,
  type ReplicatedEnvelope,
  type ReplicatedOp,
} from './ReplicatedRecordEnvelope.js';
import type { ImpactTier } from './UnionReader.js';
import type { HlcTimestamp } from './HybridLogicalClock.js';

export const SUBSCRIPTION_ACCOUNT_META_STORE_KEY = 'subscriptionAccountMeta';
export const SUBSCRIPTION_ACCOUNT_META_KIND = 'subscription-account-meta';
/** Account meta is reference, not authority → LOW impact (latest-writer on the holder stream). */
export const SUBSCRIPTION_ACCOUNT_META_IMPACT_TIER: ImpactTier = 'low';

const MAX_FREETEXT = 256;

// Mirrors the source-of-truth closed sets in SubscriptionPool.ts (PROVIDERS/FRAMEWORKS/STATUSES
// are module-local there). KEEP IN SYNC — the receive-side validator must reject a value the
// local pool would reject. A drift is caught by the schema-parity unit test below.
const PROVIDERS = ['anthropic', 'openai', 'github-copilot', 'google'] as const;
const FRAMEWORKS = ['claude-code', 'codex-cli', 'gemini-cli', 'pi-cli'] as const;
const STATUSES = ['active', 'warming', 'rate-limited', 'needs-reauth', 'disabled'] as const;
const QUOTA_SOURCES = ['claude-code-usage-screen', 'oauth-usage-endpoint-fallback'] as const;
const ID_RE = /^[a-z0-9-]+$/;

const VALUE_FIELDS = ['id', 'nickname', 'email', 'provider', 'framework', 'status', 'quota'] as const;
// `op` is a RESERVED envelope field (owned by the envelope, never store-owned) — it is read from
// `raw` to branch put/delete but is NOT in knownFields. `deletedAt` IS a store field (tombstone).
const ALL_KNOWN_FIELDS: ReadonlyArray<string> = [...VALUE_FIELDS, 'deletedAt'];

function isIso8601(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 64) return false;
  const t = Date.parse(v);
  return Number.isFinite(t);
}

/** Non-empty, control-char-free, length-clamped free text. null ⇒ reject. */
function cleanText(v: unknown, { required }: { required: boolean }): string | null | undefined {
  if (v === undefined || v === null) return required ? null : undefined;
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(v)) return null; // control chars never survive
  const clamped = v.length > MAX_FREETEXT ? v.slice(0, MAX_FREETEXT) : v;
  if (required && clamped.length === 0) return null;
  return clamped;
}

/** Validate the optional AccountQuotaSnapshot projection strictly. undefined ⇒ absent; null ⇒ reject. */
function validateQuota(v: unknown): Record<string, unknown> | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return undefined; // absent quota is fine
  if (typeof v !== 'object' || Array.isArray(v)) return null;
  const q = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const knownQuota = ['fiveHour', 'sevenDay', 'perModel', 'extraUsage', 'source', 'measuredAt'];
  for (const k of Object.keys(q)) if (!knownQuota.includes(k)) return null; // extra key → reject

  for (const win of ['fiveHour', 'sevenDay'] as const) {
    if (q[win] !== undefined) {
      const w = q[win];
      if (typeof w !== 'object' || w === null || Array.isArray(w)) return null;
      const ww = w as Record<string, unknown>;
      for (const k of Object.keys(ww)) if (k !== 'utilizationPct' && k !== 'resetsAt') return null;
      if (typeof ww.utilizationPct !== 'number' || !Number.isFinite(ww.utilizationPct)) return null;
      if (!isIso8601(ww.resetsAt)) return null;
      out[win] = { utilizationPct: ww.utilizationPct, resetsAt: ww.resetsAt };
    }
  }
  if (q.perModel !== undefined) {
    if (typeof q.perModel !== 'object' || q.perModel === null || Array.isArray(q.perModel)) return null;
    const pm = q.perModel as Record<string, unknown>;
    for (const val of Object.values(pm)) {
      if (val !== null && (typeof val !== 'number' || !Number.isFinite(val))) return null;
    }
    out.perModel = pm;
  }
  if (q.extraUsage !== undefined) {
    const e = q.extraUsage;
    if (typeof e !== 'object' || e === null || Array.isArray(e)) return null;
    const ee = e as Record<string, unknown>;
    for (const k of Object.keys(ee)) if (!['isEnabled', 'usedCredits', 'monthlyLimit'].includes(k)) return null;
    if (typeof ee.isEnabled !== 'boolean') return null;
    if (typeof ee.usedCredits !== 'number' || !Number.isFinite(ee.usedCredits)) return null;
    if (typeof ee.monthlyLimit !== 'number' || !Number.isFinite(ee.monthlyLimit)) return null;
    out.extraUsage = { isEnabled: ee.isEnabled, usedCredits: ee.usedCredits, monthlyLimit: ee.monthlyLimit };
  }
  if (q.source !== undefined) {
    if (typeof q.source !== 'string' || !QUOTA_SOURCES.includes(q.source as (typeof QUOTA_SOURCES)[number])) return null;
    out.source = q.source;
  }
  if (q.measuredAt !== undefined) {
    if (!isIso8601(q.measuredAt)) return null;
    out.measuredAt = q.measuredAt;
  }
  return out;
}

export const subscriptionAccountMetaStoreSchema: StoreFieldSchema = {
  knownFields: ALL_KNOWN_FIELDS,
  validate(raw: Readonly<Record<string, unknown>>, ctx: StoreValidateContext): Record<string, unknown> | null {
    const op = raw.op;

    // ── DELETE (tombstone) branch — an account meta removal. Only deletedAt is a legal field.
    if (op === 'delete') {
      const deletedAt = isIso8601(raw.deletedAt) ? (raw.deletedAt as string) : undefined;
      for (const k of Object.keys(raw)) {
        if (k === 'op' || k === 'deletedAt') continue;
        if (VALUE_FIELDS.includes(k as (typeof VALUE_FIELDS)[number])) ctx.countDroppedField();
      }
      return deletedAt !== undefined ? { deletedAt } : {};
    }

    // ── VALUE (put) branch — the redacted, credential-free projection. ──────────
    // id — required, charset-clamped MIRRORING SubscriptionPool ID_RE (a forged id cannot
    // smuggle characters the local add() would reject).
    if (typeof raw.id !== 'string' || raw.id.length === 0 || raw.id.length > MAX_FREETEXT || !ID_RE.test(raw.id)) {
      return null;
    }
    const id = raw.id;

    // nickname — required, control-char-free, ≤256.
    const nickname = cleanText(raw.nickname, { required: true });
    if (nickname === null || nickname === undefined) return null;

    // email — OPTIONAL, control-char-free, ≤256.
    const email = cleanText(raw.email, { required: false });
    if (email === null) return null; // present-but-malformed → reject

    // provider / framework / status — required closed-set membership (markup can't survive an enum).
    if (typeof raw.provider !== 'string' || !PROVIDERS.includes(raw.provider as (typeof PROVIDERS)[number])) return null;
    if (typeof raw.framework !== 'string' || !FRAMEWORKS.includes(raw.framework as (typeof FRAMEWORKS)[number])) return null;
    if (typeof raw.status !== 'string' || !STATUSES.includes(raw.status as (typeof STATUSES)[number])) return null;

    // quota — OPTIONAL, strict shape; malformed → reject the whole record (§6.1a).
    const quota = validateQuota(raw.quota);
    if (quota === null) return null;

    // Extra/unknown STORE keys (incl. a smuggled configHome or any credential field) → reject.
    // Reserved envelope fields (op/recordKey/hlc/origin/observed) ride in `raw` and are the
    // envelope's, not the store's — exempt them from the store-field whitelist check.
    for (const k of Object.keys(raw)) {
      if (ALL_KNOWN_FIELDS.includes(k)) continue;
      if (RESERVED_ENVELOPE_FIELDS.includes(k)) continue;
      return null;
    }

    const out: Record<string, unknown> = {
      id,
      nickname,
      provider: raw.provider,
      framework: raw.framework,
      status: raw.status,
    };
    if (email !== undefined) out.email = email;
    if (quota !== undefined) out.quota = quota;
    return out;
  },
};

/** The ReplicatedKindRegistry registration for the `subscription-account-meta` store.
 *  server.ts registers this onto the shared registry; the dual-registry coupling test
 *  asserts `kind` is also present in JOURNAL_KINDS. */
export const SUBSCRIPTION_ACCOUNT_META_KIND_REGISTRATION = {
  kind: SUBSCRIPTION_ACCOUNT_META_KIND,
  store: SUBSCRIPTION_ACCOUNT_META_STORE_KEY,
  schema: subscriptionAccountMetaStoreSchema,
} as const;

/** The recordKey for an account's meta stream — the account id (charset-clamped at the schema). */
export function deriveSubscriptionAccountMetaRecordKey(accountId: string): string {
  return accountId;
}

/**
 * The redacted, credential-free projection that crosses the wire (R2 defense-in-depth).
 * Built by EXPLICIT ALLOWLIST (never by deleting fields off the source account) — so a future
 * field added to SubscriptionAccount, or a credential field, can NEVER ride along: only these
 * seven keys are ever copied, and `configHome` + every credential field are simply not among
 * them. The receive-side schema (subscriptionAccountMetaStoreSchema) independently rejects any
 * non-whitelisted key, so the boundary is enforced on BOTH ends.
 */
export function projectAccountToMeta(account: {
  id: string;
  nickname: string;
  email?: string;
  provider: string;
  framework: string;
  status: string;
  lastQuota?: unknown;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: account.id,
    nickname: account.nickname,
    provider: account.provider,
    framework: account.framework,
    status: account.status,
  };
  if (typeof account.email === 'string' && account.email.length > 0) out.email = account.email;
  if (account.lastQuota && typeof account.lastQuota === 'object') out.quota = account.lastQuota;
  return out;
}

interface AccountForProjection {
  id: string;
  nickname: string;
  email?: string;
  provider: string;
  framework: string;
  status: string;
  lastQuota?: unknown;
}

/** Build the full replicated envelope (projection + envelope fields) for an account-meta put. */
export function buildSubscriptionAccountMetaData(input: {
  account: AccountForProjection;
  hlc: HlcTimestamp;
  origin: string;
  observed?: HlcTimestamp;
}): Record<string, unknown> {
  const { account, hlc, origin, observed } = input;
  return {
    ...projectAccountToMeta(account),
    recordKey: deriveSubscriptionAccountMetaRecordKey(account.id),
    hlc,
    op: 'put' as ReplicatedOp,
    origin,
    ...(observed !== undefined ? { observed } : {}),
  };
}

/** Build the tombstone envelope for a removed account-meta. */
export function buildSubscriptionAccountMetaTombstoneData(input: {
  accountId: string;
  hlc: HlcTimestamp;
  origin: string;
  deletedAt: string;
  observed?: HlcTimestamp;
}): Record<string, unknown> {
  return {
    deletedAt: input.deletedAt,
    recordKey: deriveSubscriptionAccountMetaRecordKey(input.accountId),
    hlc: input.hlc,
    op: 'delete' as ReplicatedOp,
    origin: input.origin,
    ...(input.observed !== undefined ? { observed: input.observed } : {}),
  };
}

/** Emit seam for SubscriptionPool → the replicated meta stream (wired in server.ts, gated dark). */
export interface SubscriptionAccountMetaReplicationEmitter {
  /** Emit a redacted projection put for an account (on add / status / quota change). */
  emitPut(account: { id: string; nickname: string; email?: string; provider: string; framework: string; status: string; lastQuota?: unknown }): void;
  /** Emit a tombstone for a removed account. */
  emitDelete(accountId: string, deletedAt: string): void;
}

/** Contributing journal kinds (for rollback-unmerge's kindsForStore wiring). */
export function subscriptionAccountMetaContributingKinds(): string[] {
  return [SUBSCRIPTION_ACCOUNT_META_KIND];
}

/** Impact tier resolver for ReplicatedStoreReader.tierOf (LOW; conservative for unknown). */
export function subscriptionAccountMetaTierOf(_store: string): ImpactTier {
  return SUBSCRIPTION_ACCOUNT_META_IMPACT_TIER;
}

export type { ReplicatedEnvelope };
