/**
 * benchmarkDivergenceRegistry — the three exact-match tables + the mirror
 * loader the Benchmark-Divergence Detector joins on
 * (docs/specs/benchmark-divergence-detector.md FD1/FD2/FD5/FD6).
 *
 * - ENROLLED_PAIRS (FD2): the runtime join `decisionPointId → taskId`. NOT
 *   LLM_BENCH_COVERAGE (whose keys are COMPONENT names with compound task
 *   strings) — no entry ⇒ pair not enrolled (fail-closed).
 * - MODEL_ID_NORMALIZATION (FD5): versioned exact-match production↔battery
 *   model-id table. Fuzzy/substring matching FORBIDDEN; mutable aliases
 *   (`*-latest`) are refused at validation; unmapped ⇒ `no-benched-baseline
 *   (unmapped: true)`. A near-empty table degrades to the safe inert default.
 * - PROMPT_TEMPLATE_REGISTRY (FD6): compile-time `taskId → templateExport`
 *   via STATIC imports of the wave-1 prompt builders' exported templates —
 *   never a file path, never a line number, never a dynamic import from
 *   mirror fields (a mirror field is untrusted data; path characters pass any
 *   id clamp, so the only safe resolver is static).
 * - Mirror loader (FD1): reads the git-tracked content-free predictions file
 *   through FD9-style type clamps (mirror inputs are untrusted). A missing or
 *   unparseable mirror is a FIRST-CLASS state (`present: false`) — never an
 *   exception, never misreported as `no-benched-baseline`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { EXTERNAL_HOG_CLASSIFIER_PROMPT_TEMPLATE } from '../monitoring/ExternalHogClassifierPrompt.js';
import { TONE_GATE_PROMPT_TEMPLATE } from '../core/MessagingToneGate.js';
import { DP_EXTERNAL_HOG_KILL_LEAVE, DP_MESSAGING_TONE_GATE } from './provenanceCoverage.js';
import { FD9_ID_RE } from '../core/benchmarkDivergenceCore.js';

/* ── FD2: enrolled pairs (decisionPointId → taskId) ──────────────────────── */

/**
 * The runtime join, seeded for the two wave-1 pairs. Adding a pair requires
 * BOTH a battery task id AND an FD6 template export — the registry test pins
 * that every enrolled pair statically resolves.
 */
export const ENROLLED_PAIRS: Readonly<Record<string, string>> = {
  [DP_EXTERNAL_HOG_KILL_LEAVE]: 'zombie-classify',
  [DP_MESSAGING_TONE_GATE]: 'tone-gate',
};

/* ── FD5: model-id normalization (versioned, exact-match, fail-closed) ───── */

export const MODEL_ID_NORMALIZATION_VERSION = 1;

/**
 * Production model id → battery model id. IMMUTABLE ids only — a known-mutable
 * alias (`*-latest`) is refused by `validateModelIdTable` (unit-pinned). The
 * battery reports runs under the same immutable public ids production records,
 * so wave-1 entries are identity mappings; a future battery rename lands here
 * as an explicit reviewed row, never a fuzzy match.
 */
export const MODEL_ID_NORMALIZATION: Readonly<Record<string, string>> = {
  'claude-opus-4-8': 'claude-opus-4-8',
  'claude-fable-5': 'claude-fable-5',
  'claude-haiku-4-5-20251001': 'claude-haiku-4-5-20251001',
  'gpt-5.5': 'gpt-5.5',
  'gpt-5.5-codex': 'gpt-5.5-codex',
  'gemini-2.5-pro': 'gemini-2.5-pro',
  'gemini-3.1-pro': 'gemini-3.1-pro',
};

/** FD5 fail-closed normalization: exact match only; miss ⇒ null (unmapped). */
export function normalizeModelId(productionModelId: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(MODEL_ID_NORMALIZATION, productionModelId)) return null;
  return MODEL_ID_NORMALIZATION[productionModelId];
}

/** FD5 table validation: ids must pass the charset clamp and be immutable
 *  (mutable aliases like `*-latest` refused). Returns violations, [] = valid. */
export function validateModelIdTable(table: Readonly<Record<string, string>> = MODEL_ID_NORMALIZATION): string[] {
  const violations: string[] = [];
  for (const [prod, battery] of Object.entries(table)) {
    for (const id of [prod, battery]) {
      if (!FD9_ID_RE.test(id)) violations.push(`model id fails charset clamp: ${id}`);
      if (/-latest$/i.test(id) || id === 'latest') violations.push(`mutable alias refused (FD5): ${id}`);
    }
  }
  return violations;
}

/* ── FD6: static prompt-template registry (taskId → templateExport) ──────── */

export interface PromptTemplateEntry {
  /** The exported template STRING (statically imported — never resolved). */
  readonly template: string;
  /**
   * Annotation/cross-check ONLY (FD1): the module the export lives in. NEVER
   * dynamically imported or resolved as a filesystem path. The mirror's
   * `benchedPromptSource` must match this string or Q0 is `hash-unverifiable`.
   */
  readonly source: string;
}

export const PROMPT_TEMPLATE_REGISTRY: Readonly<Record<string, PromptTemplateEntry>> = {
  'zombie-classify': {
    template: EXTERNAL_HOG_CLASSIFIER_PROMPT_TEMPLATE,
    source: 'src/monitoring/ExternalHogClassifierPrompt.ts#EXTERNAL_HOG_CLASSIFIER_PROMPT_TEMPLATE',
  },
  'tone-gate': {
    template: TONE_GATE_PROMPT_TEMPLATE,
    source: 'src/core/MessagingToneGate.ts#TONE_GATE_PROMPT_TEMPLATE',
  },
};

/* ── FD1: the ONE pinned canonicalization + hash ─────────────────────────── */

/** FD1 canonicalization: the exact template string, LF line endings, no trim. */
export function canonicalizeTemplate(template: string): string {
  return template.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** sha256 over the FD1-canonicalized template (hex). */
export function hashTemplate(template: string): string {
  return crypto.createHash('sha256').update(canonicalizeTemplate(template), 'utf8').digest('hex');
}

/** The live Q0 hash for a task, or null = uncomputable (FD4 hash-unverifiable). */
export function liveTemplateHash(taskId: string): string | null {
  const entry = PROMPT_TEMPLATE_REGISTRY[taskId];
  if (!entry || typeof entry.template !== 'string' || entry.template.length === 0) return null;
  try {
    return hashTemplate(entry.template);
  } catch {
    // @silent-fallback-ok: an uncomputable live hash is a FIRST-CLASS verdict
    // input (hash-unverifiable) — never an exception into the analyzer.
    return null;
  }
}

/* ── FD1: the mirror (git-tracked predictions file) ──────────────────────── */

export interface MirrorTaskEntry {
  perModel: Record<string, { passRate: number; passes: number; deterministic: number }>;
  benchedPromptSource: string | null;
  benchedPromptHash: string | null;
  capturedAt: string | null;
}

export interface BenchmarkMirror {
  present: boolean;
  /** File-level capturedAt (newest task capture when unstamped at the top). */
  capturedAt: string | null;
  tasks: Record<string, MirrorTaskEntry>;
}

/** The default in-repo mirror location (config `benchmarkDivergence.mirrorPath`). */
export const DEFAULT_MIRROR_PATH = 'src/data/benchmarkPredictions.json';

function clampRate(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
}

function clampMirrorCount(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1_000_000 ? v : null;
}

function clampIsoStamp(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 40) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? v : null;
}

/**
 * Load + clamp the mirror (FD1/FD9 — mirror fields are UNTRUSTED data: ids
 * charset-clamped, rates [0,1], counts bounded integers, unknown fields
 * dropped; a perModel entry whose rate disagrees with passes/deterministic by
 * more than rounding is dropped). Missing or unparseable file ⇒
 * `{ present: false }` — the FD4 fail-closed stale-mirror state, never a throw.
 */
export function loadBenchmarkMirror(absolutePath: string, readFile: (p: string) => string = (p) => fs.readFileSync(p, 'utf-8')): BenchmarkMirror {
  let raw: unknown;
  try {
    raw = JSON.parse(readFile(absolutePath));
  } catch {
    // @silent-fallback-ok: a missing/unparseable mirror is the designed
    // present:false state (FD4 stale-mirror suppression) — never a throw.
    return { present: false, capturedAt: null, tasks: {} };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { present: false, capturedAt: null, tasks: {} };
  const body = raw as Record<string, unknown>;
  const tasksRaw = body.tasks && typeof body.tasks === 'object' && !Array.isArray(body.tasks)
    ? (body.tasks as Record<string, unknown>)
    : {};
  const tasks: Record<string, MirrorTaskEntry> = {};
  let newestCapture: string | null = clampIsoStamp(body.capturedAt);
  for (const [taskId, entryRaw] of Object.entries(tasksRaw)) {
    if (!FD9_ID_RE.test(taskId)) continue;
    if (!entryRaw || typeof entryRaw !== 'object' || Array.isArray(entryRaw)) continue;
    const e = entryRaw as Record<string, unknown>;
    const perModelRaw = e.perModel && typeof e.perModel === 'object' && !Array.isArray(e.perModel)
      ? (e.perModel as Record<string, unknown>)
      : {};
    const perModel: MirrorTaskEntry['perModel'] = {};
    for (const [modelId, statsRaw] of Object.entries(perModelRaw)) {
      if (!FD9_ID_RE.test(modelId)) continue;
      if (!statsRaw || typeof statsRaw !== 'object') continue;
      const s = statsRaw as Record<string, unknown>;
      const passRate = clampRate(s.passRate);
      const passes = clampMirrorCount(s.passes);
      const deterministic = clampMirrorCount(s.deterministic);
      if (passRate === null || passes === null || deterministic === null) continue;
      if (deterministic <= 0 || passes > deterministic) continue;
      // Internal consistency: the rate must agree with passes/deterministic.
      if (Math.abs(passRate - passes / deterministic) > 0.005) continue;
      perModel[modelId] = { passRate, passes, deterministic };
    }
    const capturedAt = clampIsoStamp(e.capturedAt);
    if (capturedAt && (!newestCapture || Date.parse(capturedAt) > Date.parse(newestCapture))) newestCapture = capturedAt;
    tasks[taskId] = {
      perModel,
      benchedPromptSource: typeof e.benchedPromptSource === 'string' ? e.benchedPromptSource.slice(0, 256) : null,
      benchedPromptHash:
        typeof e.benchedPromptHash === 'string' && /^[0-9a-f]{64}$/i.test(e.benchedPromptHash)
          ? e.benchedPromptHash.toLowerCase()
          : null,
      capturedAt,
    };
  }
  return { present: true, capturedAt: newestCapture, tasks };
}

/** Resolve the mirror path against the package root (in-repo, git-tracked —
 *  meaningful on a source checkout; a dist-only install reports present:false). */
export function resolveMirrorPath(packageRoot: string, mirrorPath?: string): string {
  const rel = mirrorPath && typeof mirrorPath === 'string' ? mirrorPath : DEFAULT_MIRROR_PATH;
  return path.isAbsolute(rel) ? rel : path.join(packageRoot, rel);
}
