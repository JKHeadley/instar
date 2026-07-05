/**
 * routingPriceAuthority.ts — Layer 1 (price authority) + Layer 1b (subsidy/overlay)
 * of the Routing Control Room spend view (docs/specs/routing-control-room-spend-alerts.md).
 *
 * READ-ONLY, REPORTING-SIDE. This module resolves the USD price of a
 * (door, model) usage record AS-OF its timestamp, so the spend view can turn the
 * immutable token rollup (Layer 0/2) into dollars ON READ. It NEVER gates money —
 * Increment A ships no money gate at all (that authority is the separate
 * MeteredSpendLedger of Increment B, deliberately NOT built here). Everything this
 * module does flows DOWN the reporting side: a price correction recomputes the
 * report, never a booking.
 *
 * TWO price stores (spec Layer 1):
 *  - CANONICAL reviewed manifest — git-tracked `scripts/routing-prices.manifest.json`
 *    (the `scripts/model-registry-freshness.manifest.json` runtime-resolution
 *    precedent, DoorwayRegistryReader.ts). Human-written only. In Increment B this is
 *    the sole gate-eligible source; here it is the reporting authority.
 *  - LOCAL observed cache (OPTIONAL) — machine-local `.instar/routing-prices.observed.json`.
 *    Reporting-only, labelled `priceBasis: "observed"`; STRUCTURALLY incapable of
 *    reaching any money gate (there is none in A, and the resolver keeps it in a
 *    separate index the canonical-only path never reads).
 *
 * The in-memory index IS the "regenerable machine-local read index" the spec calls
 * for (spec Layer 1, "regenerable materialized view, rebuilt on boot AND when the
 * manifest mtime/hash changes"). For a manifest of a handful of points an in-memory
 * Map rebuilt on mtime change is the faithful, non-authoritative, reload-on-change
 * realisation of that intent — no separate SQLite substrate is warranted at this
 * scale (documented deviation; see upgrades/side-effects/routing-spend-increment-a.md).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CLI_ROUTING_DOORS, METERED_ROUTING_DOORS } from '../data/llmBenchCoverage.js';

/** A reviewed/observed price point (USD per MILLION tokens), effective-dated. */
export interface RoutingPricePoint {
  door: string;
  /** MUST equal canonical(resolvePositionModelId()) — see spec key-canonicalization. */
  modelId: string;
  inPerMtok: number;
  outPerMtok: number;
  /** OPTIONAL cache-read rate; absent ⇒ cached bills as full input (the over-booking safe direction, FD-19). */
  cachedInPerMtok?: number;
  /** UTC-day-aligned ISO (T00:00:00Z), ALWAYS (FD-18). */
  effectiveAt: string;
  recordedAt?: string;
  source?: string;
  /** Only a human/PIN write may set this (a correction supersede). */
  corrects?: string | null;
  /**
   * REPORTING-ONLY per-token subsidy/discount (Layer 1b). NEVER reaches a money gate.
   * `discount-frac` value ∈ [0,1); `flat-per-mtok` inPerMtok/outPerMtok ≥ 0.
   */
  subsidy?:
    | { kind: 'discount-frac'; value: number }
    | { kind: 'flat-per-mtok'; inPerMtok: number; outPerMtok: number };
}

/** Per-door meta (gate-consumed in Increment B; reporting freshness in A). Lives in the manifest, NEVER config. */
export interface RoutingDoorMeta {
  freshnessSlaDays?: number;
  staleMode?: 'fail-closed' | 'book-conservative-max';
  conservativeMax?: { inPerMtok: number; outPerMtok: number };
}

export interface RoutingPriceManifest {
  schemaVersion?: number;
  version?: number;
  doors?: Record<string, RoutingDoorMeta>;
  points?: RoutingPricePoint[];
}

/** Global default freshness SLA when a door declares none (spec Layer 1). */
export const DEFAULT_FRESHNESS_SLA_DAYS = 45;

/** How the price for a (door, model, ts) was determined. */
export type PriceBasis =
  | 'canonical'
  | 'observed'
  | 'no-matching-point'
  | 'subscription-zero';

export type DoorClass = 'cli' | 'metered' | 'unknown';

export interface PriceResolution {
  door: string;
  modelId: string;
  doorClass: DoorClass;
  priceBasis: PriceBasis;
  /** The effective point (canonical or observed); absent for no-matching-point / subscription-zero. */
  point?: RoutingPricePoint;
  /** Newest canonical point for the door is older than its freshness SLA. */
  priceStale: boolean;
  /** Age (days) of the newest canonical point for the door; null when none. */
  newestPointAgeDays: number | null;
  staleMode?: RoutingDoorMeta['staleMode'];
}

/** Reporting cost for a usage tuple, GROSS and net-of-subsidy (credits are a rollup-level line, applied by the composer). */
export interface ReportingCost {
  grossUsd: number;
  subsidyUsd: number;
  /** grossUsd − subsidyUsd (never negative). */
  netOfSubsidyUsd: number;
  /** Tokens the metered door could NOT price (loud, never silently $0). */
  unpricedTokensIn: number;
  unpricedTokensOut: number;
}

/** A lump-sum operator credit (Layer 1b, reporting-only). */
export interface RoutingCredit {
  keyRef: string;
  amountUsd: number;
  grantedAt: string;
  /** REQUIRED — a credit with no expiry is refused at load. */
  expiresAt: string;
  note?: string;
}

/** Normaliser applied identically to manifest points, recorded model, and resolvePositionModelId(). */
export function canonicalModelId(modelId: string): string {
  return String(modelId ?? '').trim().toLowerCase();
}

function doorClassOf(door: string): DoorClass {
  if (CLI_ROUTING_DOORS.has(door as never)) return 'cli';
  if (METERED_ROUTING_DOORS.has(door as never)) return 'metered';
  return 'unknown';
}

/** Fail-closed point validation (spec A-M5/S-F1): a violating point is DROPPED from the index. */
export function isValidPricePoint(p: unknown): p is RoutingPricePoint {
  if (!p || typeof p !== 'object') return false;
  const pt = p as Record<string, unknown>;
  if (typeof pt.door !== 'string' || !pt.door.trim()) return false;
  if (typeof pt.modelId !== 'string' || !pt.modelId.trim()) return false;
  const inP = pt.inPerMtok;
  const outP = pt.outPerMtok;
  if (typeof inP !== 'number' || !Number.isFinite(inP) || inP < 0) return false;
  if (typeof outP !== 'number' || !Number.isFinite(outP) || outP < 0) return false;
  if (pt.cachedInPerMtok !== undefined) {
    const c = pt.cachedInPerMtok;
    // cachedInPerMtok ≥ 0 AND ≤ inPerMtok (so a typo can never make cost exceed the full-input rate).
    if (typeof c !== 'number' || !Number.isFinite(c) || c < 0 || c > inP) return false;
  }
  if (typeof pt.effectiveAt !== 'string') return false;
  const ms = Date.parse(pt.effectiveAt);
  if (!Number.isFinite(ms)) return false;
  // Day-alignment (FD-18): effectiveAt must be a UTC day boundary.
  if (new Date(ms).toISOString() !== dayAlignedIso(ms)) return false;
  if (pt.subsidy !== undefined && !isValidSubsidy(pt.subsidy)) return false;
  return true;
}

function isValidSubsidy(s: unknown): boolean {
  if (!s || typeof s !== 'object') return false;
  const sub = s as Record<string, unknown>;
  if (sub.kind === 'discount-frac') {
    return typeof sub.value === 'number' && Number.isFinite(sub.value) && sub.value >= 0 && sub.value < 1;
  }
  if (sub.kind === 'flat-per-mtok') {
    return (
      typeof sub.inPerMtok === 'number' && Number.isFinite(sub.inPerMtok) && sub.inPerMtok >= 0 &&
      typeof sub.outPerMtok === 'number' && Number.isFinite(sub.outPerMtok) && sub.outPerMtok >= 0
    );
  }
  return false;
}

/** The UTC-day-aligned ISO (T00:00:00Z) for a timestamp. */
export function dayAlignedIso(ms: number): string {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

function isValidCredit(c: unknown): c is RoutingCredit {
  if (!c || typeof c !== 'object') return false;
  const cr = c as Record<string, unknown>;
  if (typeof cr.keyRef !== 'string' || !cr.keyRef.trim()) return false;
  if (typeof cr.amountUsd !== 'number' || !Number.isFinite(cr.amountUsd) || cr.amountUsd < 0) return false;
  if (typeof cr.grantedAt !== 'string' || !Number.isFinite(Date.parse(cr.grantedAt))) return false;
  if (typeof cr.expiresAt !== 'string' || !Number.isFinite(Date.parse(cr.expiresAt))) return false; // REQUIRED
  return true;
}

export interface RoutingPriceAuthorityOptions {
  /** Agent/project dir — the canonical manifest is `<projectDir>/scripts/routing-prices.manifest.json`. */
  projectDir: string;
  /** Machine-local state dir (`.instar/`) — the observed cache / overlay / credits live here. */
  stateDir: string;
  now?: () => number;
}

/**
 * The reporting price authority. Loads the canonical manifest into a regenerable
 * in-memory index (reload-on-mtime-change), plus the OPTIONAL machine-local observed
 * cache, overlay, and credits ledger. Pure reads — writes nothing.
 */
export class RoutingPriceAuthority {
  private readonly manifestPath: string;
  private readonly observedPath: string;
  private readonly overlayPath: string;
  private readonly creditsPath: string;
  private readonly now: () => number;

  private manifestMtimeMs = -1;
  private doorMeta: Record<string, RoutingDoorMeta> = {};
  /** canonical(door + ' ' + modelId) → points sorted by (effectiveAt, recordedAt) ASC. */
  private canonicalIndex = new Map<string, RoutingPricePoint[]>();
  private observedIndex = new Map<string, RoutingPricePoint[]>();
  private overlaySubsidy = new Map<string, RoutingPricePoint['subsidy']>();
  private creditsCache: RoutingCredit[] = [];
  private manifestPresent = false;

  constructor(opts: RoutingPriceAuthorityOptions) {
    this.manifestPath = path.join(opts.projectDir, 'scripts', 'routing-prices.manifest.json');
    this.observedPath = path.join(opts.stateDir, 'routing-prices.observed.json');
    this.overlayPath = path.join(opts.stateDir, 'routing-prices.overlay.json');
    this.creditsPath = path.join(opts.stateDir, 'routing-credits.json');
    this.now = opts.now ?? (() => Date.now());
    this.reloadIfChanged();
  }

  private static key(door: string, modelId: string): string {
    return `${door} ${canonicalModelId(modelId)}`;
  }

  /** True when the canonical manifest exists on disk (an install without the instar source has none). */
  hasManifest(): boolean {
    return this.manifestPresent;
  }

  /** Rebuild the index when the manifest file changed (mtime poll). The machine-local files are read every call (tiny, optional). */
  reloadIfChanged(): void {
    let mtime = -1;
    try {
      mtime = fs.statSync(this.manifestPath).mtimeMs;
    } catch {
      // @silent-fallback-ok: no manifest on disk (an install without the instar source)
      // is a first-class REPORTING state — the sentinel mtime forces a (harmless) reload
      // that leaves the index empty and metered rows render as no-provider-data / $0.
      mtime = -2;
    }
    if (mtime !== this.manifestMtimeMs) {
      this.manifestMtimeMs = mtime;
      this.loadManifest();
    }
    // The machine-local reporting inputs are re-read each resolve pass (cheap, optional, regenerable).
    this.loadObserved();
    this.loadOverlay();
    this.loadCredits();
  }

  private loadManifest(): void {
    this.canonicalIndex = new Map();
    this.doorMeta = {};
    this.manifestPresent = false;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.manifestPath, 'utf-8'));
    } catch {
      // @silent-fallback-ok: no/unreadable manifest ⇒ an install without the instar
      // source (or a corrupt file). REPORTING degrades to "no-matching-point" for
      // metered doors and "$0 subscription" for CLI doors — never a fabricated price.
      return;
    }
    const m = raw as RoutingPriceManifest;
    if (!m || typeof m !== 'object') return;
    this.manifestPresent = true;
    if (m.doors && typeof m.doors === 'object') {
      for (const [door, meta] of Object.entries(m.doors)) {
        if (meta && typeof meta === 'object') this.doorMeta[door] = meta;
      }
    }
    for (const p of Array.isArray(m.points) ? m.points : []) {
      if (!isValidPricePoint(p)) continue; // fail-closed: drop invalid points from the index
      const normalised: RoutingPricePoint = { ...p, modelId: canonicalModelId(p.modelId) };
      const key = RoutingPriceAuthority.key(normalised.door, normalised.modelId);
      const arr = this.canonicalIndex.get(key) ?? [];
      arr.push(normalised);
      this.canonicalIndex.set(key, arr);
    }
    for (const arr of this.canonicalIndex.values()) arr.sort(cmpPoint);
  }

  private loadObserved(): void {
    this.observedIndex = new Map();
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.observedPath, 'utf-8'));
    } catch {
      // @silent-fallback-ok: the observed cache is an OPTIONAL machine-local reporting
      // input written only by the OFF-by-default refresh job — absence/parse-fail is the
      // normal case and degrades to "no observed prices", never an error.
      return;
    }
    const pts = (raw as RoutingPriceManifest)?.points;
    for (const p of Array.isArray(pts) ? pts : []) {
      if (!isValidPricePoint(p)) continue;
      const normalised: RoutingPricePoint = { ...p, modelId: canonicalModelId(p.modelId) };
      const key = RoutingPriceAuthority.key(normalised.door, normalised.modelId);
      const arr = this.observedIndex.get(key) ?? [];
      arr.push(normalised);
      this.observedIndex.set(key, arr);
    }
    for (const arr of this.observedIndex.values()) arr.sort(cmpPoint);
  }

  private loadOverlay(): void {
    this.overlaySubsidy = new Map();
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.overlayPath, 'utf-8'));
    } catch {
      // @silent-fallback-ok: the operator overlay is an OPTIONAL machine-local reporting
      // adjustment — absence/parse-fail degrades to "no operator subsidy", never an error.
      return;
    }
    const pts = (raw as RoutingPriceManifest)?.points;
    for (const p of Array.isArray(pts) ? pts : []) {
      if (!p || typeof p !== 'object') continue;
      const door = (p as RoutingPricePoint).door;
      const modelId = (p as RoutingPricePoint).modelId;
      const subsidy = (p as RoutingPricePoint).subsidy;
      if (typeof door !== 'string' || typeof modelId !== 'string' || !isValidSubsidy(subsidy)) continue;
      this.overlaySubsidy.set(RoutingPriceAuthority.key(door, modelId), subsidy);
    }
  }

  private loadCredits(): void {
    this.creditsCache = [];
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.creditsPath, 'utf-8'));
    } catch {
      // @silent-fallback-ok: the credits ledger is an OPTIONAL machine-local reporting
      // store — absence/parse-fail degrades to "no credits", never an error.
      return;
    }
    const list = Array.isArray(raw) ? raw : (raw as { credits?: unknown })?.credits;
    for (const c of Array.isArray(list) ? list : []) {
      if (isValidCredit(c)) this.creditsCache.push(c);
    }
  }

  doorClass(door: string): DoorClass {
    return doorClassOf(door);
  }

  doorMetaFor(door: string): RoutingDoorMeta | undefined {
    return this.doorMeta[door];
  }

  /**
   * As-of resolution for a (door, model) at `tsMs`: the point with the greatest
   * effectiveAt ≤ ts (ties → greatest recordedAt, so a `corrects` row supersedes).
   * Canonical first; observed as a labelled reporting fallback; then the
   * doorClass-based subscription-$0 default; else no-matching-point (loud).
   */
  resolve(door: string, modelId: string, tsMs: number): PriceResolution {
    const cls = doorClassOf(door);
    const key = RoutingPriceAuthority.key(door, modelId);
    const newestAgeDays = this.newestCanonicalAgeDays(door, tsMs);
    const staleMode = this.doorMeta[door]?.staleMode;
    const priceStale = this.isDoorStale(door, tsMs);

    const canonical = asOf(this.canonicalIndex.get(key), tsMs);
    if (canonical) {
      return { door, modelId: canonicalModelId(modelId), doorClass: cls, priceBasis: 'canonical', point: canonical, priceStale, newestPointAgeDays: newestAgeDays, staleMode };
    }
    const observed = asOf(this.observedIndex.get(key), tsMs);
    if (observed) {
      return { door, modelId: canonicalModelId(modelId), doorClass: cls, priceBasis: 'observed', point: observed, priceStale, newestPointAgeDays: newestAgeDays, staleMode };
    }
    // A CLI/subscription door with no explicit point is honestly $0-per-token (doorClass default).
    if (cls === 'cli') {
      return { door, modelId: canonicalModelId(modelId), doorClass: cls, priceBasis: 'subscription-zero', priceStale: false, newestPointAgeDays: null };
    }
    // A metered door with no matching point → loud, never $0.
    return { door, modelId: canonicalModelId(modelId), doorClass: cls, priceBasis: 'no-matching-point', priceStale, newestPointAgeDays: newestAgeDays, staleMode };
  }

  /** Newest canonical point's age in days for a door (across all its models), relative to `atMs`. */
  private newestCanonicalAgeDays(door: string, atMs: number): number | null {
    let newest = -Infinity;
    for (const [key, arr] of this.canonicalIndex) {
      if (!key.startsWith(`${door} `)) continue;
      const last = arr[arr.length - 1];
      if (last) {
        const eff = Date.parse(last.effectiveAt);
        if (Number.isFinite(eff) && eff > newest) newest = eff;
      }
    }
    if (!Number.isFinite(newest)) return null;
    return Math.max(0, (atMs - newest) / 86_400_000);
  }

  private isDoorStale(door: string, atMs: number): boolean {
    const age = this.newestCanonicalAgeDays(door, atMs);
    if (age === null) return false; // no canonical point → not "stale" (it's no-matching-point instead)
    const sla = this.doorMeta[door]?.freshnessSlaDays ?? DEFAULT_FRESHNESS_SLA_DAYS;
    return age > sla;
  }

  /**
   * REPORTING cost for a token tuple at a resolved price (spec C2-4 formula), applying
   * a per-token subsidy (point subsidy, then an operator overlay subsidy). Credits are a
   * separate rollup-level line the composer applies. A no-matching-point metered tuple
   * returns $0 gross and surfaces the tokens as UNPRICED (loud), never a fabricated $0.
   */
  reportingCost(
    resolution: PriceResolution,
    tokensIn: number,
    tokensOut: number,
    tokensCached: number,
  ): ReportingCost {
    const tin = Math.max(0, tokensIn || 0);
    const tout = Math.max(0, tokensOut || 0);
    const tcached = Math.min(Math.max(0, tokensCached || 0), tin);

    if (resolution.priceBasis === 'subscription-zero') {
      return { grossUsd: 0, subsidyUsd: 0, netOfSubsidyUsd: 0, unpricedTokensIn: 0, unpricedTokensOut: 0 };
    }
    if (resolution.priceBasis === 'no-matching-point' || !resolution.point) {
      // Metered door we cannot price → the tokens are UNPRICED, never silently $0.
      return { grossUsd: 0, subsidyUsd: 0, netOfSubsidyUsd: 0, unpricedTokensIn: tin, unpricedTokensOut: tout };
    }
    const pt = resolution.point;
    const cachedRate = pt.cachedInPerMtok ?? pt.inPerMtok; // absent ⇒ cached bills as full input (FD-19)
    const gross =
      ((tin - tcached) / 1e6) * pt.inPerMtok +
      (tcached / 1e6) * cachedRate +
      (tout / 1e6) * pt.outPerMtok;

    // Layer 1b subsidy: point subsidy, then operator overlay subsidy (overlay wins).
    const key = RoutingPriceAuthority.key(resolution.door, resolution.modelId);
    const subsidy = this.overlaySubsidy.get(key) ?? pt.subsidy;
    let subsidyUsd = 0;
    if (subsidy) {
      if (subsidy.kind === 'discount-frac') {
        subsidyUsd = gross * subsidy.value;
      } else {
        subsidyUsd =
          ((tin - tcached) / 1e6) * subsidy.inPerMtok +
          (tcached / 1e6) * subsidy.inPerMtok +
          (tout / 1e6) * subsidy.outPerMtok;
      }
    }
    subsidyUsd = Math.min(subsidyUsd, gross); // never make cost negative
    return {
      grossUsd: round6(gross),
      subsidyUsd: round6(subsidyUsd),
      netOfSubsidyUsd: round6(Math.max(0, gross - subsidyUsd)),
      unpricedTokensIn: 0,
      unpricedTokensOut: 0,
    };
  }

  /** Active (non-expired) lump-sum credit total for a key at `atMs` (reporting-only). */
  activeCreditUsd(keyRef: string, atMs: number): number {
    let total = 0;
    for (const c of this.creditsCache) {
      if (c.keyRef !== keyRef) continue;
      if (Date.parse(c.grantedAt) <= atMs && atMs <= Date.parse(c.expiresAt)) total += c.amountUsd;
    }
    return round6(total);
  }
}

function cmpPoint(a: RoutingPricePoint, b: RoutingPricePoint): number {
  const ea = Date.parse(a.effectiveAt);
  const eb = Date.parse(b.effectiveAt);
  if (ea !== eb) return ea - eb;
  const ra = Date.parse(a.recordedAt ?? a.effectiveAt);
  const rb = Date.parse(b.recordedAt ?? b.effectiveAt);
  return ra - rb;
}

/** The point with the greatest effectiveAt ≤ ts (ties → greatest recordedAt). Array is pre-sorted ASC. */
function asOf(points: RoutingPricePoint[] | undefined, tsMs: number): RoutingPricePoint | undefined {
  if (!points || points.length === 0) return undefined;
  let chosen: RoutingPricePoint | undefined;
  for (const p of points) {
    if (Date.parse(p.effectiveAt) <= tsMs) chosen = p;
    else break;
  }
  return chosen;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
