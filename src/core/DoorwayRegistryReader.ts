/**
 * Doorway/Model Knowledge Registry — the read-side merged-view reader (spec
 * `docs/specs/DOORWAY-MODEL-KNOWLEDGE-REGISTRY-SPEC.md`, rollout increment 3, D5).
 *
 * Composes the two layers into one merged view for `GET /doorways`:
 *   1. the git-tracked CANONICAL manifest (`scripts/model-registry-freshness.manifest.json`)
 *      — authoritative `topModels` (with pricing) per door; and
 *   2. this machine's machine-local LIVE scan-state (`.instar/state/doorway-scan.json`,
 *      written by `scripts/doorway-scan.mjs`) — reachability per door.
 *
 * Contract (D5 — exactly two states → two codes):
 *   - canonical manifest present, no scan yet → `{ status:'ok', body:{ scanState:'never-run', … } }`
 *     (each door `reachable:null` / `probeStatus:'never-scanned'` / `lastScannedAt:null`);
 *   - canonical manifest present + scan-state present → `{ status:'ok', body:{ scanState:'scanned', … } }`;
 *   - canonical manifest ABSENT (a non-instar-source install) → `{ status:'no-manifest' }` → route 503
 *     `registry-unavailable-no-instar-source`;
 *   - canonical manifest present but UNPARSEABLE → `{ status:'corrupt' }` → route 503 `registry-corrupt`.
 *
 * Security — Untrusted-on-every-read (§1.3): the machine-local scan-state is a plaintext file a
 * local writer can poison AFTER a clamped write, so every scan-state field this reader USES is
 * re-validated field-by-field here (door id charset/length + known-candidate cross-check,
 * `probeStatus` fixed enum, ISO timestamps) — nothing raw-passes into the `GET /doorways` body.
 * `reachable` is DERIVED from the clamped `probeStatus` (not the stored boolean), so a poisoned
 * `reachable` value is never trusted and P20 unknown≠down semantics hold. The canonical manifest
 * is git-tracked trusted source (the authoritative routing layer, §1.1) — its `topModels` are the
 * reviewed values, projected through a shape guard.
 *
 * The clamp constants below MIRROR the source of truth in `scripts/doorway-scan.mjs` (§1.3). A
 * `.mjs` script can't be safely imported into the server bundle, so they are re-declared here;
 * the unit test pins the mirrored values against the prober's exported enum.
 */
import fs from 'node:fs';
import path from 'node:path';

// ── Mirrored clamp constants (source of truth: scripts/doorway-scan.mjs §1.3). ──

/** The fixed classified probeStatus enum. Never verbatim remote text. */
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
] as const);

export type ProbeStatus = (typeof PROBE_STATUS_ENUM)[number];

/** Route-level sentinel for a door the current scan-state has no entry for (D5(a)). Not a scan-state enum value. */
export const NEVER_SCANNED = 'never-scanned' as const;

const DOOR_ID_RE = /^[A-Za-z0-9._/:-]+$/;
const DOOR_ID_MAX = 80;
const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?$/;
const MACHINE_ID_MAX = 120;
const ARRAY_CAP = 200; // blanket per-array cap (doorways[], topModels[])

/** Clamp a door id, cross-checked against the known candidate set. Non-conforming → null (dropped). */
export function clampDoorId(raw: unknown, knownCandidates: string[]): { id: string; known: boolean } | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t || t.length > DOOR_ID_MAX || !DOOR_ID_RE.test(t)) return null;
  return { id: t, known: knownCandidates.includes(t) };
}

/** Coerce a stored probeStatus to the fixed enum; anything else → 'malformed-response'. */
export function clampProbeStatus(raw: unknown): ProbeStatus {
  return (PROBE_STATUS_ENUM as readonly string[]).includes(raw as string)
    ? (raw as ProbeStatus)
    : 'malformed-response';
}

/** ISO-8601 (date, or full timestamp) parse-or-null. */
export function clampIso(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!ISO_RE.test(t)) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : t;
}

function clampMachineId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const t = raw.replace(/[\x00-\x1f\x7f]/g, '').slice(0, MACHINE_ID_MAX);
  return t || null;
}

/**
 * probeStatus → reachable tri-state (P20). `null` = UNKNOWN ("I couldn't confirm" ≠ "the door is
 * down"). Mirrors `probeStatusToReachable` in doorway-scan.mjs.
 */
export function probeStatusToReachable(status: ProbeStatus): boolean | null {
  switch (status) {
    case 'ok':
      return true;
    // Transient / no-answer → UNKNOWN.
    case 'timeout':
    case 'dns-fail':
    case 'http-5xx':
    case 'not-probed-this-scope':
    case 'not-probed-this-run':
    case 'not-probed-budget-refused':
      return null;
    // Definitive unreachable.
    case 'not-installed':
    case 'http-4xx':
      return false;
    // Parse-drift on a door that DID answer → stays reachable:true (the L5 canary lives in the diff, not here).
    case 'malformed-response':
    case 'oversize-response':
      return true;
    default:
      return null;
  }
}

function asStringOrNull(raw: unknown): string | null {
  return typeof raw === 'string' ? raw : null;
}

export interface DoorwayModelView {
  id: string;
  role: string | null;
  frontier: boolean;
  pricing: unknown;
  verifiedAt: string | null;
}

export interface DoorwayView {
  doorId: string;
  name: string | null;
  /** Canonical door status (e.g. "alive" | "referenced-not-installed"). Trusted source. */
  canonicalStatus: string | null;
  topModels: DoorwayModelView[];
  /** Live tri-state (derived from the clamped probeStatus); null = unknown / never scanned. */
  reachable: boolean | null;
  /** Clamped probeStatus enum, or the route sentinel 'never-scanned'. */
  probeStatus: ProbeStatus | typeof NEVER_SCANNED;
  lastScannedAt: string | null;
}

export interface DoorwayRegistryBody {
  scanState: 'never-run' | 'scanned';
  lastScanAt: string | null;
  machineId: string | null;
  doorways: DoorwayView[];
}

export type DoorwayRegistryResult =
  | { status: 'ok'; body: DoorwayRegistryBody }
  | { status: 'no-manifest' }
  | { status: 'corrupt' };

/** Absolute path to the canonical manifest for a given project (agent) dir. */
export function manifestPath(projectDir: string): string {
  return path.join(projectDir, 'scripts', 'model-registry-freshness.manifest.json');
}

/** Absolute path to the machine-local live scan-state for a given state dir. */
export function scanStatePath(stateDir: string): string {
  return path.join(stateDir, 'state', 'doorway-scan.json');
}

/**
 * Compose the merged doorway/model view. Never throws on a bad scan-state (that only degrades to
 * never-run — the file is machine-local + regenerable). Returns a discriminated result the route
 * maps to the D5 status contract.
 */
export function readDoorwayRegistry(opts: { projectDir: string; stateDir: string }): DoorwayRegistryResult {
  const mp = manifestPath(opts.projectDir);
  if (!fs.existsSync(mp)) return { status: 'no-manifest' };

  let manifest: unknown;
  try {
    manifest = JSON.parse(fs.readFileSync(mp, 'utf-8'));
  } catch {
    return { status: 'corrupt' };
  }
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    typeof (manifest as { doors?: unknown }).doors !== 'object' ||
    (manifest as { doors?: unknown }).doors === null
  ) {
    return { status: 'corrupt' };
  }

  const doors = (manifest as { doors: Record<string, Record<string, unknown>> }).doors;
  const doorIds = Object.keys(doors);
  const candidateList = Array.isArray((manifest as { candidateDoorways?: unknown }).candidateDoorways)
    ? ((manifest as { candidateDoorways: unknown[] }).candidateDoorways.filter((x) => typeof x === 'string') as string[])
    : [];
  // Known-candidate set used to cross-check (and DROP) unknown scan-state door ids.
  const known = Array.from(new Set<string>([...doorIds, ...candidateList]));

  // ── Read + clamp the machine-local scan-state (UNTRUSTED — §1.3). ──
  const sp = scanStatePath(opts.stateDir);
  const scanByDoor = new Map<string, { probeStatus: ProbeStatus; lastScannedAt: string | null }>();
  let lastScanAt: string | null = null;
  let machineId: string | null = null;
  let scanned = false;
  if (fs.existsSync(sp)) {
    try {
      const rawState = JSON.parse(fs.readFileSync(sp, 'utf-8')) as Record<string, unknown>;
      if (rawState && typeof rawState === 'object') {
        lastScanAt = clampIso(rawState.lastScanAt);
        machineId = clampMachineId(rawState.machineId);
        // A scan-state file only counts as "scanned" once a real scan stamped lastScanAt
        // (freshScanState() ships lastScanAt:null → still never-run).
        scanned = lastScanAt !== null;
        const arr = Array.isArray(rawState.doorways)
          ? (rawState.doorways as unknown[]).slice(0, ARRAY_CAP)
          : [];
        for (const d of arr) {
          if (!d || typeof d !== 'object') continue;
          const rec = d as Record<string, unknown>;
          const idc = clampDoorId(rec.id, known);
          if (!idc) continue; // unknown / malformed door id → dropped
          scanByDoor.set(idc.id, {
            probeStatus: clampProbeStatus(rec.probeStatus),
            lastScannedAt: clampIso(rec.lastScannedAt),
          });
        }
      }
    } catch {
      // Corrupt scan-state → treat as never-run; never crash the read (§1.3 log-once-and-fresh).
      scanned = false;
      lastScanAt = null;
      machineId = null;
      scanByDoor.clear();
    }
  }

  const doorways: DoorwayView[] = doorIds.slice(0, ARRAY_CAP).map((doorId) => {
    const door = doors[doorId] ?? {};
    const topModels: DoorwayModelView[] = Array.isArray(door.topModels)
      ? (door.topModels as unknown[])
          .slice(0, ARRAY_CAP)
          .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
          .map((m) => ({
            id: typeof m.id === 'string' ? m.id : '',
            role: asStringOrNull(m.role),
            frontier: m.frontier === true,
            pricing: m.pricing ?? null,
            verifiedAt: asStringOrNull(m.verifiedAt),
          }))
          .filter((m) => m.id !== '')
      : [];
    const live = scanByDoor.get(doorId);
    if (!live) {
      return {
        doorId,
        name: asStringOrNull(door.name),
        canonicalStatus: asStringOrNull(door.status),
        topModels,
        reachable: null,
        probeStatus: NEVER_SCANNED,
        lastScannedAt: null,
      };
    }
    return {
      doorId,
      name: asStringOrNull(door.name),
      canonicalStatus: asStringOrNull(door.status),
      topModels,
      reachable: probeStatusToReachable(live.probeStatus),
      probeStatus: live.probeStatus,
      lastScannedAt: live.lastScannedAt,
    };
  });

  return {
    status: 'ok',
    body: {
      scanState: scanned ? 'scanned' : 'never-run',
      lastScanAt,
      machineId,
      doorways,
    },
  };
}
