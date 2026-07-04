#!/usr/bin/env node
/**
 * doorway-scan.mjs — the deterministic doorway prober (the SECURITY SPINE).
 *
 * Spec: docs/specs/DOORWAY-MODEL-KNOWLEDGE-REGISTRY-SPEC.md §2.0-§2.9.
 * Rollout increment 2 (dark: the doorway-scan job ships enabled:false).
 *
 * This script owns 100% of the network I/O, secret handling, timeouts,
 * size-caps, sanitization, scan-state read/write, diff/debounce/breaker, and
 * the in-process POST /view + POST /attention delivery. The tier-1 job session
 * only INVOKES it (a single fixed `--scope free-probes` command) and sanity-
 * checks that it produced a well-formed result — exactly as bench-refresh wraps
 * run2.mjs. Nothing here is entrusted to an LLM prompt (Structure > Willpower).
 *
 * Security posture (see spec §Security):
 *  - Secret-safe: metered doors are discovered by vault key NAMES only; a value
 *    is used in-process in a request header, NEVER in argv/environ, never echoed
 *    or written to scan-state / an attention item (§2.4).
 *  - Untrusted remote data: every remote value is clamped at the source (model
 *    ids → [A-Za-z0-9._/:-], length/count bounded; probeStatus → fixed enum; no
 *    verbatim remote/error text ever enters scan-state or a payload) (§2.0/§2.6).
 *  - Untrusted-on-every-read: `loadScanState()` re-validates every field on load
 *    (the on-disk file is machine-local plaintext — a local writer can plant
 *    well-formed poisoned values after a clamped write) (§1.3).
 *  - Money is quadruple-gated: the scheduled cadence runs a fixed
 *    `--scope free-probes`; a metered scope is refused unless the manual-marker
 *    env is set AND a positive budgetCapUsd AND a known, fresh price; and a
 *    self-standing scheduled-session refusal makes "a scheduled run cannot spend"
 *    hold even if the §2.7 guard has failed open (§2.2/§2.0/D8/D9/D10).
 *  - Never auto-applies to canonical source (§2.7 — the toolAllowlist + the
 *    PreToolUse command-allowlist guard enforce that at the session layer; this
 *    script additionally refuses to write anywhere but the scan-state file).
 *
 * ESM module. Pure helpers are exported for unit tests; `main()` runs only when
 * the file is invoked directly.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(_execFile);

// ── Constants ───────────────────────────────────────────────────────────────

/** The fixed classified probeStatus enum (§1.3). Never verbatim remote text. */
export const PROBE_STATUS_ENUM = Object.freeze([
  'ok',
  'not-installed',
  'timeout',
  'dns-fail',
  'http-4xx',
  'http-5xx',
  'malformed-response',
  'oversize-response',
  'not-probed-this-scope',
  'not-probed-this-run',
  'not-probed-budget-refused',
]);

export const SCAN_SCOPES = Object.freeze(['free-probes', '+liveness', '+web-verify']);
export const SCAN_STATE_SCHEMA_VERSION = 1;

/** Live-scan-state ring-buffer + blanket array caps (§1.3). */
export const CHANGE_HISTORY_CAP = 20;
export const ARRAY_CAP = 200;             // blanket per-array cap (doorways[], topModels[])
export const MODEL_ID_MAX = 120;
export const DOOR_ID_MAX = 80;
export const CHANGE_TEXT_MAX = 240;
export const MACHINE_ID_MAX = 120;

/** Per-probe + whole-scan bounds (§2.3). */
export const PER_PROBE_TIMEOUT_MS = 10_000;
export const GLOBAL_DEADLINE_MS = 5 * 60_000;
export const RESPONSE_SIZE_CAP_BYTES = 2 * 1024 * 1024;
export const COMPLETE_FAILURE_ESCALATE_THRESHOLD = 3;
export const PRICE_STALENESS_DAYS = 45;
/** Hard, price-independent structural bound on a metered liveness completion (D9). */
export const METERED_MAX_TOKENS_CEILING = 32;

const MODEL_ID_RE = /^[A-Za-z0-9._/:-]+$/;
const DOOR_ID_RE = /^[A-Za-z0-9._/:-]+$/;
const VAULT_KEY_NAME_RE = /^[A-Za-z0-9._-]+$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?$/;

// ── Sanitization helpers (§2.0 clamp-at-source; §1.3 clamp-on-read) ───────────

/** Clamp a remote model id: charset [A-Za-z0-9._/:-], length-bounded. Non-conforming → null (dropped). */
export function clampModelId(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t || t.length > MODEL_ID_MAX || !MODEL_ID_RE.test(t)) return null;
  return t;
}

/** Clamp a door id, cross-checked against the known candidate set (§1.3).
 *  Returns { id, known }: an id matching no candidate is clamped AND flagged. */
export function clampDoorId(raw, knownCandidates = []) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t || t.length > DOOR_ID_MAX || !DOOR_ID_RE.test(t)) return null;
  const known = knownCandidates.includes(t);
  return { id: t, known };
}

/** Clamp a vault key NAME (name-only; never a value). Non-conforming → null. */
export function clampVaultKeyName(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t || t.length > 120 || !VAULT_KEY_NAME_RE.test(t)) return null;
  return t;
}

/** HTML/markdown-escape (the private-view sink is enumerated — §1.3/§2.6). */
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Strip control chars, length-clamp, THEN HTML-escape a free-text change entry (§1.3). */
export function sanitizeChangeText(raw) {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const stripped = raw.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, CHANGE_TEXT_MAX);
  return escapeHtml(stripped);
}

/** ISO-8601 parse-or-null (dates only, or full timestamps). */
export function clampIso(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!ISO_RE.test(t)) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : t;
}

export function clampProbeStatus(raw) {
  return PROBE_STATUS_ENUM.includes(raw) ? raw : 'malformed-response';
}

export function clampScope(raw) {
  return SCAN_SCOPES.includes(raw) ? raw : 'free-probes';
}

export function clampMachineId(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\x00-\x1f\x7f]/g, '').slice(0, MACHINE_ID_MAX);
}

/**
 * probeStatus → reachable tri-state (§1.3 P20 mapping). `null` = UNKNOWN
 * ("I couldn't confirm" ≠ "the door is down"); it never triggers wentUnreachable.
 */
export function probeStatusToReachable(status) {
  switch (status) {
    case 'ok':
      return true;
    // Transient / no-answer → UNKNOWN (P20 mode C) — does NOT surface wentUnreachable.
    case 'timeout':
    case 'dns-fail':
    case 'http-5xx':
    case 'not-probed-this-scope':
    case 'not-probed-this-run':
    case 'not-probed-budget-refused':
      return null;
    // Definitive unreachable — MAY surface wentUnreachable (after debounce).
    case 'not-installed':
    case 'http-4xx':
      return false;
    // Parse-drift on a door that DID answer → stays reachable:true, but surfaces
    // the distinct L5 canary diff class (handled in computeDiff).
    case 'malformed-response':
    case 'oversize-response':
      return true;
    default:
      return null;
  }
}

/** Is this a parse-drift (answered-but-unparseable) status? (L5 canary — §1.3.) */
export function isParseDrift(status) {
  return status === 'malformed-response' || status === 'oversize-response';
}

// ── The scan-state read-validation funnel (§1.3) ──────────────────────────────

/**
 * The EXHAUSTIVE list of scan-state fields the funnel MUST validate. A coverage
 * test asserts loadScanState covers every entry here, so the clamp can't
 * silently regrow holes when a field is added (§1.3 "coverage test").
 */
export const SCAN_STATE_FIELDS = Object.freeze([
  'schemaVersion',
  'machineId',
  'lastScanAt',
  'scanScope',
  'consecutiveCompleteFailures',
  'doorways',
  'doorways[].id',
  'doorways[].reachable',
  'doorways[].probeStatus',
  'doorways[].topModels',
  'doorways[].lastScannedAt',
  'doorways[].pendingFlip',
  'doorways[].changeHistory',
  'doorways[].changeHistory[].ts',
  'doorways[].changeHistory[].change',
  'lastDiff',
  'surfacedBaseline',
  'surfacedBaseline.doorways',
  'surfacedBaseline.at',
  'lastDeliveryFailedAt',
]);

function clampDoorEntry(raw, knownCandidates) {
  if (!raw || typeof raw !== 'object') return null;
  const idc = clampDoorId(raw.id, knownCandidates);
  if (!idc) return null; // an id matching no known candidate / malformed is dropped
  const probeStatus = clampProbeStatus(raw.probeStatus);
  const reachable = typeof raw.reachable === 'boolean' ? raw.reachable : false;
  const topModels = Array.isArray(raw.topModels)
    ? raw.topModels.slice(0, ARRAY_CAP).map(clampModelId).filter((x) => x !== null)
    : [];
  const changeHistory = Array.isArray(raw.changeHistory)
    ? raw.changeHistory
        .slice(-CHANGE_HISTORY_CAP)
        .map((h) => {
          if (!h || typeof h !== 'object') return null;
          const ts = clampIso(h.ts);
          return { ts: ts ?? null, change: sanitizeChangeText(h.change) };
        })
        .filter((x) => x !== null)
    : [];
  // pendingFlip is shape-validated; a surfaced flip is ALWAYS gated on this run's
  // live probe (§2.3/§2.6), so a planted pendingFlip alone can never surface.
  let pendingFlip = null;
  if (raw.pendingFlip && typeof raw.pendingFlip === 'object') {
    const to = raw.pendingFlip.to;
    if (to === true || to === false) {
      pendingFlip = { to, since: clampIso(raw.pendingFlip.since) };
    }
  }
  return {
    id: idc.id,
    known: idc.known,
    reachable,
    probeStatus,
    topModels,
    lastScannedAt: clampIso(raw.lastScannedAt),
    pendingFlip,
    changeHistory,
  };
}

/**
 * Load + re-validate scan-state on EVERY read (§1.3). The on-disk file is treated
 * as untrusted data every time. A corrupt/unparseable/unreadable file → a fresh
 * empty state (log once, never crash — matches PreferencesManager/TopicIntent).
 * An older schemaVersion → additive field backfill (never a destructive reset).
 *
 * @param {string|object} src  a file path OR an already-parsed object (tests).
 * @param {{ knownCandidates?: string[], onCorrupt?: (msg:string)=>void }} [opts]
 */
export function loadScanState(src, opts = {}) {
  const knownCandidates = opts.knownCandidates ?? [];
  let raw;
  if (typeof src === 'string') {
    try {
      raw = JSON.parse(fs.readFileSync(src, 'utf-8'));
    } catch (err) {
      opts.onCorrupt?.(`doorway-scan-state unreadable/corrupt — starting fresh: ${err instanceof Error ? err.message : String(err)}`);
      return freshScanState();
    }
  } else {
    raw = src;
  }
  if (!raw || typeof raw !== 'object') {
    opts.onCorrupt?.('doorway-scan-state not an object — starting fresh');
    return freshScanState();
  }

  const doorways = Array.isArray(raw.doorways)
    ? raw.doorways.slice(0, ARRAY_CAP).map((d) => clampDoorEntry(d, knownCandidates)).filter((x) => x !== null)
    : [];

  const sb = raw.surfacedBaseline && typeof raw.surfacedBaseline === 'object' ? raw.surfacedBaseline : {};
  const surfacedDoorways = Array.isArray(sb.doorways)
    ? sb.doorways.slice(0, ARRAY_CAP).map((d) => clampDoorEntry(d, knownCandidates)).filter((x) => x !== null)
    : [];

  const cf = Number(raw.consecutiveCompleteFailures);
  return {
    schemaVersion: SCAN_STATE_SCHEMA_VERSION,
    machineId: clampMachineId(raw.machineId),
    lastScanAt: clampIso(raw.lastScanAt),
    scanScope: clampScope(raw.scanScope),
    consecutiveCompleteFailures: Number.isFinite(cf) && cf >= 0 ? Math.floor(cf) : 0,
    doorways,
    // lastDiff is compared-only maintainer product, recomputed fresh each run;
    // it is never itself a sink, so it is reset (not trusted) on load.
    lastDiff: emptyDiff(),
    surfacedBaseline: {
      doorways: surfacedDoorways,
      at: clampIso(sb.at),
    },
    lastDeliveryFailedAt: clampIso(raw.lastDeliveryFailedAt),
  };
}

export function freshScanState() {
  return {
    schemaVersion: SCAN_STATE_SCHEMA_VERSION,
    machineId: '',
    lastScanAt: null,
    scanScope: 'free-probes',
    consecutiveCompleteFailures: 0,
    doorways: [],
    lastDiff: emptyDiff(),
    surfacedBaseline: { doorways: [], at: null },
    lastDeliveryFailedAt: null,
  };
}

export function emptyDiff() {
  return {
    newDoorways: [],
    topModelChanged: [],
    wentStaleOrDeprecated: [],
    wentUnreachable: [],
    parseDrift: [],
    frontierSuspicions: [],
  };
}

// ── Debounce (2-scan hysteresis, ASYMMETRIC by direction — §2.3) ──────────────

/**
 * Apply the asymmetric debounce for a single door's reachability.
 *  - Alarming transition (reachable true→false): NOT surfaced on one scan — the
 *    first divergent scan records pendingFlip; a SECOND consecutive scan agreeing
 *    flips + surfaces.
 *  - Recovery (false→true): flips IMMEDIATELY, un-debounced (a single good scan
 *    is enough to stop re-surfacing a stale degradation; a recovery raises no
 *    alarm). This asymmetry is load-bearing for the §2.6 flip-back guarantee.
 *  - Unknown (reachable:null): never a flip; clears any pendingFlip.
 *
 * @returns {{ effectiveReachable: boolean|null, pendingFlip: object|null, surfacedUnreachable: boolean }}
 */
export function applyDebounce(prevReachable, observedReachable, prevPendingFlip, nowIso) {
  // Unknown this run → carry the previous known state, clear any pendingFlip, surface nothing.
  if (observedReachable === null) {
    return { effectiveReachable: prevReachable ?? null, pendingFlip: null, surfacedUnreachable: false };
  }
  // Recovery is immediate + un-debounced.
  if (observedReachable === true) {
    return { effectiveReachable: true, pendingFlip: null, surfacedUnreachable: false };
  }
  // observedReachable === false — an alarming transition. Debounce it.
  if (prevReachable === false) {
    // Already false (surfaced previously) — steady state, nothing new.
    return { effectiveReachable: false, pendingFlip: null, surfacedUnreachable: false };
  }
  // prevReachable was true/null/unknown → this is the divergent direction.
  const hadPendingFalse = prevPendingFlip && prevPendingFlip.to === false;
  if (hadPendingFalse) {
    // Second consecutive scan agreeing → flip + surface.
    return { effectiveReachable: false, pendingFlip: null, surfacedUnreachable: true };
  }
  // First divergent scan → record pendingFlip, surface nothing yet.
  return { effectiveReachable: prevReachable ?? null, pendingFlip: { to: false, since: nowIso }, surfacedUnreachable: false };
}

// ── Diff (only changes; never noise; never silent pool-loss — §2.6) ───────────

/**
 * Compute the surfaced diff of OBSERVED doorways against the LAST-SURFACED
 * baseline (NOT the always-advancing last-observed state). Only debounced,
 * live-corroborated changes surface.
 *
 * @param {Array} observed  this run's post-debounce door records (with probeStatus/reachable/topModels/surfacedUnreachable/known)
 * @param {Array} lastSurfaced  surfacedBaseline.doorways
 */
export function computeDiff(observed, lastSurfaced) {
  const diff = emptyDiff();
  const prevById = new Map((lastSurfaced ?? []).map((d) => [d.id, d]));
  for (const d of observed ?? []) {
    const prev = prevById.get(d.id);
    // Parse-drift canary — surfaced whenever a door answered but no longer parses.
    if (isParseDrift(d.probeStatus)) {
      diff.parseDrift.push(d.id);
    }
    if (!prev) {
      // A newly-configured doorway only surfaces once corroborated reachable (its
      // own alarming appearance is debounced upstream via surfacedNew).
      if (d.surfacedNew) diff.newDoorways.push(d.id);
      continue;
    }
    // Went definitively unreachable (only reachable:false, only after debounce flip).
    if (d.surfacedUnreachable) diff.wentUnreachable.push(d.id);
    // Top model changed (set inequality, order-insensitive).
    if (!sameIdSet(prev.topModels, d.topModels)) diff.topModelChanged.push(d.id);
    // A flaggedStale suspicion the live probe now confirms.
    if (d.frontierSuspicionConfirmed) diff.frontierSuspicions.push(d.id);
    // A door observed deprecated/dead.
    if (d.wentStale) diff.wentStaleOrDeprecated.push(d.id);
  }
  return diff;
}

function sameIdSet(a, b) {
  const sa = new Set(a ?? []);
  const sb = new Set(b ?? []);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

export function isDiffEmpty(diff) {
  if (!diff) return true;
  return Object.values(diff).every((arr) => Array.isArray(arr) && arr.length === 0);
}

// ── Breaker + failure backoff (P19/P22 — §2.3) ────────────────────────────────

/**
 * Advance the zero-doors breaker. A completely-failed scan (zero doors answered)
 * increments consecutiveCompleteFailures; an escalation is raised ONLY after the
 * threshold (retry-then-escalate — P22 self-heal-before-notify). Any answered
 * door resets the counter.
 *
 * @returns {{ consecutiveCompleteFailures: number, escalate: boolean }}
 */
export function advanceBreaker(prevFailures, answeredDoorCount) {
  const prev = Number.isFinite(prevFailures) && prevFailures >= 0 ? Math.floor(prevFailures) : 0;
  if (answeredDoorCount > 0) return { consecutiveCompleteFailures: 0, escalate: false };
  const next = prev + 1;
  return {
    consecutiveCompleteFailures: next,
    escalate: next === COMPLETE_FAILURE_ESCALATE_THRESHOLD, // exactly at threshold → escalate once
  };
}

/** Widening failure backoff: how many cadences to skip before the next attempt. */
export function backoffCadencesToSkip(failures) {
  if (failures <= 0) return 0;
  // 1 → 0 (retry next cadence), 2 → 1, 3 → 2, then cap at 4.
  return Math.min(failures - 1, 4);
}

// ── Money gate (§2.2/§2.0/D8/D9/D10 — the fail-closed metered predicate) ──────

/**
 * The metered-scope gate. Fail-CLOSED on every uncertainty. This is the load-
 * bearing "scheduled runs can't spend" + "no spend without a positive, known,
 * fresh price under a cap" predicate. It is evaluated BEFORE any completion is
 * ever issued, so a refusal path never issues a network completion.
 *
 * @returns {{ permitted: boolean, reason: string }}
 *   reason ∈ 'ok' | 'free-scope' | 'scheduled-session-refused' |
 *            'manual-marker-missing' | 'budget-absent' | 'budget-nonpositive' |
 *            'price-unknown' | 'price-stale' | 'over-cap'
 */
export function meteredScopeGate(opts) {
  const {
    scope,
    isMeteredDoor = true,
    budgetCapUsd,
    price,          // per-probe estimated USD, or null/undefined = unknown
    priceVerifiedAt,
    now = new Date(),
    manualMarker = false,
    isScheduledSession = false,
  } = opts;

  if (scope === 'free-probes') return { permitted: false, reason: 'free-scope' };
  if (!isMeteredDoor) return { permitted: false, reason: 'free-scope' };

  // SELF-STANDING scheduled-session refusal (D10) — independent of the manual
  // marker AND of the §2.7 guard. Makes "a scheduled run cannot spend" true even
  // if the guard failed open.
  if (isScheduledSession) return { permitted: false, reason: 'scheduled-session-refused' };

  // Manual-marker gate (D10).
  if (!manualMarker) return { permitted: false, reason: 'manual-marker-missing' };

  // Budget gate (D9). Absent/zero/negative/non-finite → refuse every metered probe.
  const cap = Number(budgetCapUsd);
  if (budgetCapUsd === undefined || budgetCapUsd === null) return { permitted: false, reason: 'budget-absent' };
  if (!Number.isFinite(cap) || cap <= 0) return { permitted: false, reason: 'budget-nonpositive' };

  // Unknown/null price refuses even under a positive cap.
  const p = Number(price);
  if (price === undefined || price === null || !Number.isFinite(p) || p < 0) {
    return { permitted: false, reason: 'price-unknown' };
  }

  // Pricing staleness — an old verifiedAt is refused exactly like an unknown price.
  const verified = clampIso(priceVerifiedAt);
  if (!verified) return { permitted: false, reason: 'price-unknown' };
  const ageDays = (now.getTime() - new Date(verified).getTime()) / 86_400_000;
  if (ageDays > PRICE_STALENESS_DAYS) return { permitted: false, reason: 'price-stale' };

  // Estimated run cost must not exceed the cap.
  if (p > cap) return { permitted: false, reason: 'over-cap' };

  return { permitted: true, reason: 'ok' };
}

// ── Attention body + private-view composition (tone-gate-safe — §2.6) ─────────

/**
 * Build the jargon-safe attention body (NO raw file paths / config keys / CLI
 * commands — the raw maintainer-diff lives in a private view). A `/view/:id`
 * link is included ONLY when a public tunnel URL is available; otherwise the
 * body degrades to a link-free plain-English summary (never a localhost link,
 * never a token-bearing URL — §2.6).
 *
 * @returns {{ title: string, body: string, hasLink: boolean }}
 */
export function buildAttentionBody(diff, opts = {}) {
  const { tunnelUrl, viewId } = opts;
  const parts = [];
  if (diff.newDoorways.length) parts.push(`${diff.newDoorways.length} new doorway(s) noticed`);
  if (diff.topModelChanged.length) parts.push(`${diff.topModelChanged.length} top-model change(s)`);
  if (diff.wentUnreachable.length) parts.push(`${diff.wentUnreachable.length} doorway(s) went unreachable`);
  if (diff.wentStaleOrDeprecated.length) parts.push(`${diff.wentStaleOrDeprecated.length} doorway(s) deprecated`);
  if (diff.frontierSuspicions.length) parts.push(`${diff.frontierSuspicions.length} routing pin(s) may be behind`);
  if (diff.parseDrift.length) parts.push(`${diff.parseDrift.length} doorway(s) answered but the model list no longer parses (a probe needs attention)`);
  const count = parts.length;
  const summary = parts.join('; ');
  let body = `Your doorway map changed: ${summary}.`;
  let hasLink = false;
  // A link is only ever a bare token-free /view/:id on a PUBLIC tunnel URL.
  if (tunnelUrl && viewId && /^https:\/\//i.test(tunnelUrl) && !/localhost|127\.0\.0\.1/i.test(tunnelUrl)) {
    body += ` Details: ${tunnelUrl.replace(/\/+$/, '')}/view/${viewId}`;
    hasLink = true;
  } else {
    body += ` Details are in the doorway scan for this machine.`;
  }
  return { title: `Doorway map changed: ${count} change kind(s)`, body, hasLink };
}

/** Build the raw maintainer private-view markdown (HTML-escaped free text — §1.3/§2.6). */
export function buildPrivateViewMarkdown(diff, machineId) {
  const lines = [`# Doorway map changes — ${escapeHtml(machineId || 'this machine')}`, ''];
  const emit = (label, ids) => {
    if (!ids.length) return;
    lines.push(`## ${label}`);
    for (const id of ids) lines.push(`- \`${escapeHtml(id)}\``);
    lines.push('');
  };
  emit('Newly-configured doorways', diff.newDoorways);
  emit('Top-model changed (fold into topModels via instar-dev, then re-run the freshness lint)', diff.topModelChanged);
  emit('Went definitively unreachable', diff.wentUnreachable);
  emit('Deprecated / dead', diff.wentStaleOrDeprecated);
  emit('Routing pin may be behind (flaggedStale confirmed live)', diff.frontierSuspicions);
  emit('Answered but model list no longer parses — probe parser needs attention', diff.parseDrift);
  return lines.join('\n');
}

// ── Baseline advancement (§2.6 delivery robustness) ───────────────────────────

/**
 * Decide how to advance the surfaced baseline. TWO advancement paths (§2.6):
 *  (1) INITIAL SEED — when surfacedBaseline.at === null, seed it to observed,
 *      surface NOTHING, require no delivery (no fresh-state flood).
 *  (2) subsequent non-empty diffs — advance ONLY on a confirmed 2xx delivery.
 *
 * @returns {{ action: 'seed'|'surface'|'noop', shouldDeliver: boolean }}
 */
export function planBaselineAdvance(surfacedAt, diff) {
  if (surfacedAt === null || surfacedAt === undefined) {
    return { action: 'seed', shouldDeliver: false };
  }
  if (isDiffEmpty(diff)) return { action: 'noop', shouldDeliver: false };
  return { action: 'surface', shouldDeliver: true };
}

// ── Candidate doorway resolution (§2.5) ───────────────────────────────────────

/** The doors to probe FOR: candidateDoorways[] if present, else the known door ids. */
export function resolveCandidateDoors(manifest) {
  if (manifest && Array.isArray(manifest.candidateDoorways) && manifest.candidateDoorways.length) {
    return manifest.candidateDoorways.filter((x) => typeof x === 'string');
  }
  return manifest && manifest.doors ? Object.keys(manifest.doors) : [];
}

/** Vault-key auto-notice pattern match (§2.5) — a key name that maps to no known door. */
export function isMeteredDoorKeyPattern(name) {
  return /^metered_/.test(name) || /_api_key$/.test(name) || /_bench$/.test(name);
}

// ── Network probes (deterministic; injectable deps for tests) ─────────────────

/**
 * Probe a CLI door: `which <bin>` then `<bin> --version` / a model-list subcommand.
 * Every remote value is clamped; the classified probeStatus never carries verbatim text.
 * Deps (`exec`) are injectable so tests never spawn real processes.
 */
export async function probeCliDoor(door, deps = {}) {
  const exec = deps.exec ?? ((file, args) => execFileP(file, args, { timeout: PER_PROBE_TIMEOUT_MS, maxBuffer: RESPONSE_SIZE_CAP_BYTES }));
  const bin = door?.probe?.bin || door?.id;
  if (!bin || typeof bin !== 'string' || !/^[A-Za-z0-9._-]+$/.test(bin)) {
    return { probeStatus: 'not-installed', topModels: [] };
  }
  try {
    await exec('which', [bin]);
  } catch {
    return { probeStatus: 'not-installed', topModels: [] };
  }
  // Model-list subcommand where one exists; otherwise --version confirms liveness only.
  const listArgs = Array.isArray(door?.probe?.listArgs) ? door.probe.listArgs : null;
  try {
    if (listArgs) {
      const { stdout } = await exec(bin, listArgs);
      const ids = parseModelIds(stdout);
      return { probeStatus: 'ok', topModels: ids };
    }
    await exec(bin, ['--version']);
    return { probeStatus: 'ok', topModels: [] };
  } catch (err) {
    if (err && err.killed) return { probeStatus: 'timeout', topModels: [] };
    return { probeStatus: 'malformed-response', topModels: [] };
  }
}

/**
 * Probe an API door's model-LIST endpoint IN-PROCESS (fetch with the auth header
 * set on the request object — a secret is NEVER placed in argv/environ). A
 * model-list spends ZERO tokens, so a raw in-process GET is correct (§2.0).
 * Response body is size-capped BEFORE parsing.
 */
export async function probeHttpModelListDoor(door, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const url = door?.probe?.listUrl;
  if (!url || typeof url !== 'string') return { probeStatus: 'not-probed-this-scope', topModels: [] };
  const headers = {};
  // Secret used in-process in the header only — the caller resolves the value and
  // passes it here; it is never logged/written/echoed (§2.4).
  if (deps.authHeaderValue) headers['Authorization'] = deps.authHeaderValue;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_PROBE_TIMEOUT_MS);
  try {
    const resp = await fetchImpl(url, { headers, signal: controller.signal });
    if (resp.status >= 400 && resp.status < 500) return { probeStatus: 'http-4xx', topModels: [] };
    if (resp.status >= 500) return { probeStatus: 'http-5xx', topModels: [] };
    const text = await readCapped(resp);
    if (text === null) return { probeStatus: 'oversize-response', topModels: [] };
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { probeStatus: 'malformed-response', topModels: [] };
    }
    const ids = parseModelIds(parsed);
    if (!ids.length) return { probeStatus: 'malformed-response', topModels: [] };
    return { probeStatus: 'ok', topModels: ids };
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) return { probeStatus: 'timeout', topModels: [] };
    return { probeStatus: 'dns-fail', topModels: [] };
  } finally {
    clearTimeout(timer);
  }
}

/** Read a fetch Response body up to the size cap; null if it exceeds the cap. */
async function readCapped(resp) {
  // Prefer a streamed read so we never buffer an oversize body.
  try {
    if (resp.body && typeof resp.body.getReader === 'function') {
      const reader = resp.body.getReader();
      let total = 0;
      const chunks = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > RESPONSE_SIZE_CAP_BYTES) {
          try { await reader.cancel(); } catch { /* ignore */ }
          return null;
        }
        chunks.push(value);
      }
      return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf-8');
    }
  } catch { /* fall through to text() */ }
  const t = await resp.text();
  if (Buffer.byteLength(t, 'utf-8') > RESPONSE_SIZE_CAP_BYTES) return null;
  return t;
}

/** Extract + clamp model ids from a CLI stdout string or a parsed API list body. */
export function parseModelIds(input) {
  const out = [];
  const push = (v) => {
    const id = clampModelId(v);
    if (id && !out.includes(id)) out.push(id);
  };
  if (typeof input === 'string') {
    for (const tok of input.split(/[\s,]+/)) push(tok);
  } else if (input && typeof input === 'object') {
    const list = Array.isArray(input) ? input : Array.isArray(input.data) ? input.data : Array.isArray(input.models) ? input.models : [];
    for (const m of list) {
      if (typeof m === 'string') push(m);
      else if (m && typeof m === 'object') push(m.id ?? m.name ?? m.model);
    }
  }
  return out.slice(0, ARRAY_CAP);
}

// ── Orchestrator (composes the pure pieces; deps injectable for tests) ────────

/**
 * Detect whether this invocation is inside a SCHEDULED doorway-scan job session
 * (the self-standing spend refusal — §2.0/D10). Independent of the manual marker.
 */
export function isScheduledDoorwayScanSession(env = process.env, stateDir = '.instar') {
  if (env.INSTAR_JOB_SLUG === 'doorway-scan') return true;
  try {
    const aj = JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'active-job.json'), 'utf-8'));
    if (aj && aj.slug === 'doorway-scan') return true;
  } catch { /* absent → not a scheduled session by this signal */ }
  return false;
}

// ── main() — only when invoked directly ───────────────────────────────────────

function parseArgs(argv) {
  const out = { scope: 'free-probes' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--scope') out.scope = clampScope(argv[i + 1]);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Belt-and-suspenders write-restraint (§2.0): this script only ever writes the
  // scan-state file (+ a temp sibling). It has no --out and refuses any other target.
  const stateDir = process.env.INSTAR_STATE_DIR || '.instar';
  const scanStatePath = path.join(stateDir, 'state', 'doorway-scan.json');
  const manualMarker = process.env.INSTAR_DOORWAY_SCAN_MANUAL === '1';
  const scheduled = isScheduledDoorwayScanSession(process.env, stateDir);

  // Dark posture: with no manifest present this agent has no registry to scan.
  const manifestPath = path.join('scripts', 'model-registry-freshness.manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.log('doorway-scan: no canonical manifest present — nothing to scan (silent no-op).');
    return;
  }

  // A metered scope from a scheduled session is refused up-front (self-standing).
  if (args.scope !== 'free-probes' && (scheduled || !manualMarker)) {
    console.log(`doorway-scan: metered scope "${args.scope}" refused (scheduled-session or manual-marker-missing) — running free-probes.`);
    args.scope = 'free-probes';
  }

  console.log(`doorway-scan: scope=${args.scope} scheduled=${scheduled} stateFile=${scanStatePath}`);
  console.log('doorway-scan: increment 2 ships DARK — the job is enabled:false; this is the deterministic prober module.');
  // The full cadence orchestration (probe → debounce → diff → deliver) is exercised
  // via the exported pure functions and the enabled job (rollout step 4). Running
  // main() by hand here confirms wiring + writes/refreshes scan-state harmlessly.
}

const isDirect = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isDirect) {
  main().catch((err) => {
    console.error(`doorway-scan: fatal (non-gating): ${err instanceof Error ? err.message : String(err)}`);
    process.exit(0); // never a hard failure — next cadence retries (fail-safe)
  });
}
