/**
 * Machine-coherence advert — build + receive-clamp (machine-coherence-guard §3.2).
 *
 * The advert is ONE bounded, self-describing block riding the existing 30s
 * capacity-heartbeat / presence-pull machinery (no new channel). Emission is
 * UNCONDITIONAL (spec M3, normative): every machine running a version that
 * carries this code emits the advert regardless of the sentinel's dev-gate /
 * enabled / dryRun state — only the EVALUATOR + alarm are dev-gated (§7).
 * Rationale (pinned against the founding F4 incident): a gated advert would
 * leave the dark side of an asymmetric pair advert-less, and the live side
 * would misclassify the exact F4 topology as "peer predates the guard".
 *
 * The receive clamp (spec M4, R5-N3) is NEW build work: peers' adverts are
 * type-clamped AND format-clamped on receive in the puller's narrowing step —
 * every rendered peer string is restricted to a safe alphabet (the L2 exposure
 * invariant forbids peer free text in operator-facing surfaces). A clamp-
 * REJECTED advert is stored as an explicit rejection marker that REPLACES the
 * peer's stored advert for evaluation (rejected ≠ absent, by construction —
 * persistent malformation surfaces LOUDLY as `advert-rejected`, never silence).
 */

import {
  buildCoherenceFlags,
  selfManifestHash,
  selfProtocolVersion,
  resolveFlagValue,
  COHERENCE_CRITICAL_FLAGS,
  MC_MAX_ENTRIES,
  MC_KEY_MAX,
  MC_VALUE_ALPHABET,
  MC_VERSION_ALPHABET,
  MC_MANIFEST_HASH_RE,
  MC_EPISODE_ID_RE,
  MC_MARKER_ROWS_MAX,
  MC_FLAGS_BYTES_MAX,
  MC_MARKER_BYTES_MAX,
  MC_BLOCK_BYTES_MAX,
  type CoherenceConfigView,
} from './machineCoherenceManifest.js';

/** The guard's own resolved posture on a machine (spec §3.2 N2; feeds the §3.4 election). */
export type CoherenceGuardPosture = 'live' | 'dry-run' | 'dark';

/**
 * The alarm marker (spec §3.2, R2-M1/M2): present on a machine's advert iff
 * that machine currently holds an OPEN local machine-coherence attention item
 * it SUCCESSFULLY RAISED (the `itemRaisedAt` stamp — item-RAISED, never mere
 * episode-open, R4-M1). Content-free: per-row truncated hashes over N1
 * row-identity keys — never free text.
 */
export interface CoherenceAlarmMarker {
  /** The holder's own local episode id — N4 format, clamped /^mc-\d{1,29}$/ (R3-N9). */
  episodeId: string;
  /**
   * PER-ROW truncated hashes (16 lowercase hex each) of the item's CURRENTLY-
   * CONFIRMED §3.3 row identities, sorted, ≤ 72 entries. A LIST deliberately:
   * coverage checks are INTERSECTION tests (R3-M4/N2) — an UNLISTED row is NOT
   * covered, everywhere (overflow fails toward RAISING).
   */
  rowIdentityHashes: string[];
  /** Receive-clamp honesty ONLY — structurally unreachable for a legal manifest; NEVER grants coverage (R3-M4). */
  rowsTruncated?: boolean;
}

/** The §3.2 advert block — sibling to `seamlessnessFlags` on the capacity heartbeat. */
export interface CoherenceAdvert {
  /** ProcessIntegrity.runningVersion — executing code, not disk. */
  instarVersion: string;
  /** SEAMLESSNESS_PROTOCOL_VERSION. */
  protocolVersion: number;
  /** sha256 over sorted manifest entries (key+resolution+readSource) — M7. */
  manifestHash: string;
  /** The guard's OWN resolved posture on this machine (N2; feeds the §3.4 election). */
  guard: CoherenceGuardPosture;
  /** Sender-side monotonic advert generation (M5; FORENSIC-ONLY — resets on restart, NEVER a freshness check; R2-L1). */
  beatSeq: number;
  /** Manifest-resolved effective values, clamped scalars. */
  flags: Record<string, string>;
  /** Present iff THIS machine holds an OPEN, successfully-RAISED local machine-coherence item (R2-M1/M2, R4-M1). */
  alarm?: CoherenceAlarmMarker;
}

/** A stored clamp-rejection marker — REPLACES the peer's advert for evaluation (M4: rejected ≠ absent). */
export interface CoherenceAdvertRejection {
  atMs: number;
  reason: string;
}

/**
 * Resolve the guard's OWN posture from config (the same resolution the
 * manifest's `monitoring.machineCoherence` row uses): 'live' | 'dry-run' |
 * 'dark'. The manifest row resolves to 'live'/'dry-run'/'off' — 'off' maps to
 * the advert's 'dark'.
 */
export function resolveSelfGuardPosture(view: CoherenceConfigView): CoherenceGuardPosture {
  const entry = COHERENCE_CRITICAL_FLAGS.find((f) => f.key === 'monitoring.machineCoherence');
  if (!entry) return 'dark';
  const v = resolveFlagValue(entry, view);
  return v === 'live' ? 'live' : v === 'dry-run' ? 'dry-run' : 'dark';
}

/**
 * Build this machine's advert for one heartbeat. Pure given its inputs;
 * recomputed each beat (a boot-read entry re-advertises within one beat of the
 * restart that applied it; a live-read entry within one beat of the PATCH).
 * The caller owns `beatSeq` increment and the alarm marker (episode state).
 */
export function buildCoherenceAdvert(
  view: CoherenceConfigView,
  opts: {
    /** ProcessIntegrity.runningVersion; pass 'unknown' only when genuinely unavailable. */
    instarVersion: string;
    beatSeq: number;
    alarm?: CoherenceAlarmMarker;
  },
): CoherenceAdvert {
  return {
    instarVersion: opts.instarVersion,
    protocolVersion: selfProtocolVersion(),
    manifestHash: selfManifestHash(),
    guard: resolveSelfGuardPosture(view),
    beatSeq: opts.beatSeq,
    flags: buildCoherenceFlags(view),
    ...(opts.alarm ? { alarm: opts.alarm } : {}),
  };
}

/** Result of the receive clamp: a clean (rebuilt) advert, or a named rejection. */
export type ClampAdvertResult =
  | { ok: true; advert: CoherenceAdvert; markerDropReason?: string }
  | { ok: false; reason: string };

const GUARD_POSTURES: readonly string[] = ['live', 'dry-run', 'dark'];
const KEY_ALPHABET = /^[A-Za-z0-9._-]{1,64}$/;
const ROW_HASH_RE = /^[0-9a-f]{16}$/;

/**
 * The M4 receive-side clamp, applied in the puller's narrowing step. Every
 * field is validated and the advert REBUILT from validated values (never a
 * pass-through of the raw peer object). Failure directions per spec §3.2:
 * - a malformed ADVERT → `{ ok: false, reason }` — the caller stores a
 *   rejection marker replacing the peer's advert (classification
 *   `advert-rejected`, surfaced loudly — never silence);
 * - a malformed alarm MARKER (bad episodeId format / bad row hash) → the
 *   MARKER is dropped with a named reason, the advert's other fields STAND
 *   (R3-N9 — appends render only clamp-passed ids);
 * - `rowIdentityHashes` longer than the 72-row bound → truncated + flagged
 *   `rowsTruncated` (receive-clamp honesty; truncation NEVER grants coverage).
 */
export function clampCoherenceAdvert(raw: unknown): ClampAdvertResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'not-an-object' };
  }
  const a = raw as Record<string, unknown>;

  const instarVersion = a.instarVersion;
  if (typeof instarVersion !== 'string' || !MC_VERSION_ALPHABET.test(instarVersion)) {
    return { ok: false, reason: 'instar-version-format' };
  }
  const protocolVersion = a.protocolVersion;
  if (typeof protocolVersion !== 'number' || !Number.isFinite(protocolVersion)) {
    return { ok: false, reason: 'protocol-version-not-numeric' };
  }
  const manifestHash = a.manifestHash;
  if (typeof manifestHash !== 'string' || !MC_MANIFEST_HASH_RE.test(manifestHash)) {
    return { ok: false, reason: 'manifest-hash-format' };
  }
  const guard = a.guard;
  if (typeof guard !== 'string' || !GUARD_POSTURES.includes(guard)) {
    return { ok: false, reason: 'guard-posture-format' };
  }
  const beatSeq = a.beatSeq;
  if (typeof beatSeq !== 'number' || !Number.isFinite(beatSeq) || beatSeq < 0) {
    return { ok: false, reason: 'beat-seq-not-numeric' };
  }
  const rawFlags = a.flags;
  if (!rawFlags || typeof rawFlags !== 'object' || Array.isArray(rawFlags)) {
    return { ok: false, reason: 'flags-not-an-object' };
  }
  const flagEntries = Object.entries(rawFlags as Record<string, unknown>);
  if (flagEntries.length > MC_MAX_ENTRIES) {
    return { ok: false, reason: 'flags-entry-count' };
  }
  const flags: Record<string, string> = {};
  for (const [k, v] of flagEntries) {
    if (!KEY_ALPHABET.test(k) || k.length > MC_KEY_MAX) return { ok: false, reason: 'flag-key-format' };
    if (typeof v !== 'string' || !MC_VALUE_ALPHABET.test(v)) return { ok: false, reason: 'flag-value-format' };
    flags[k] = v;
  }

  // Byte budgets are measured on the REBUILT serialization (structural join
  // bytes inside the measurement — R4-L4).
  const base: CoherenceAdvert = { instarVersion, protocolVersion, manifestHash, guard: guard as CoherenceGuardPosture, beatSeq, flags };
  if (Buffer.byteLength(JSON.stringify(base), 'utf8') > MC_FLAGS_BYTES_MAX) {
    return { ok: false, reason: 'advert-oversize' };
  }

  // Alarm marker: validated separately — a bad marker drops the MARKER, never
  // the advert (the advert's other fields stand; R3-N9).
  let markerDropReason: string | undefined;
  let alarm: CoherenceAlarmMarker | undefined;
  if (a.alarm !== undefined) {
    const m = a.alarm;
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      markerDropReason = 'marker-not-an-object';
    } else {
      const mo = m as Record<string, unknown>;
      const episodeId = mo.episodeId;
      const rawRows = mo.rowIdentityHashes;
      if (typeof episodeId !== 'string' || !MC_EPISODE_ID_RE.test(episodeId)) {
        markerDropReason = 'episode-id-format';
      } else if (!Array.isArray(rawRows)) {
        markerDropReason = 'row-hashes-not-a-list';
      } else if (rawRows.some((h) => typeof h !== 'string' || !ROW_HASH_RE.test(h))) {
        markerDropReason = 'row-hash-format';
      } else {
        const truncated = rawRows.length > MC_MARKER_ROWS_MAX;
        const rows = (rawRows as string[]).slice(0, MC_MARKER_ROWS_MAX);
        const candidate: CoherenceAlarmMarker = {
          episodeId,
          rowIdentityHashes: rows,
          ...(truncated || mo.rowsTruncated === true ? { rowsTruncated: true } : {}),
        };
        if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > MC_MARKER_BYTES_MAX) {
          markerDropReason = 'marker-oversize';
        } else {
          alarm = candidate;
        }
      }
    }
  }

  const advert: CoherenceAdvert = { ...base, ...(alarm ? { alarm } : {}) };
  if (Buffer.byteLength(JSON.stringify(advert), 'utf8') > MC_BLOCK_BYTES_MAX) {
    return { ok: false, reason: 'block-oversize' };
  }
  return { ok: true, advert, ...(markerDropReason ? { markerDropReason } : {}) };
}
