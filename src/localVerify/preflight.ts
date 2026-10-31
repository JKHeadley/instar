/** Pure, installed-verifier decisions for the bounded PR preflight. */
import path from 'node:path';
import { parseVitestJson } from './laneReport.js';

export const PREFLIGHT_LIMITS = Object.freeze({ changedFiles: 40, testFiles: 5, testCases: 200, totalMs: 90_000, teardownReserveMs: 10_000 });
export type PreflightMode = 'off' | 'observe' | 'enforce';

export function effectivePreflightMode(hostMode: unknown, kind: 'main' | 'pr', rediscoverable: boolean): PreflightMode {
  if (kind === 'main' || (hostMode !== 'observe' && hostMode !== 'enforce')) return 'off';
  return hostMode === 'enforce' && !rediscoverable ? 'observe' : hostMode;
}

export function preflightBreadth(changed: number, files: number, cases: number): string | null {
  if (!Number.isSafeInteger(changed) || changed < 0 || changed > PREFLIGHT_LIMITS.changedFiles) return 'changed-files-cap';
  if (!Number.isSafeInteger(files) || files < 0 || files > PREFLIGHT_LIMITS.testFiles) return 'selected-files-cap';
  if (!Number.isSafeInteger(cases) || cases < 0 || cases > PREFLIGHT_LIMITS.testCases) return 'selected-cases-cap';
  if (files === 0 || cases === 0) return 'no-selected-tests';
  return null;
}

/** Vitest list JSON is an array of absolute file identities; reject aliases and escapes. */
export function parsePreflightList(text: string | null, root: string, filesOnly: boolean): { files: string[]; cases: number } | null {
  if (text === null || text.length > 1024 * 1024) return null;
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(doc)) return null;
  const files = new Set<string>();
  for (const row of doc) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const x = row as Record<string, unknown>;
    if (typeof x.file !== 'string' || !path.isAbsolute(x.file)) return null;
    if (!filesOnly && (typeof x.name !== 'string' || !x.name.trim())) return null;
    const rel = path.relative(root, x.file).split(path.sep).join('/');
    if (!rel || rel.startsWith('../') || rel === '..' || path.isAbsolute(rel) || !rel.endsWith('.test.ts')) return null;
    if (filesOnly && files.has(rel)) return null;
    files.add(rel);
  }
  return { files: [...files].sort(), cases: filesOnly ? 0 : doc.length };
}

/** Only an assertion failure in a selected file is stable-red evidence. */
export function preflightAssertionFailures(text: string | null, root: string, selected: readonly string[]): string[] | null {
  if (text === null || text.length > 2 * 1024 * 1024) return null;
  let doc: unknown;
  try { doc = JSON.parse(text); parseVitestJson(text, root); } catch { return null; }
  const rows = (doc as { testResults: unknown[] }).testResults;
  if (rows.length === 0) return null;
  const selectedSet = new Set(selected);
  const seen = new Set<string>();
  const failed = new Set<string>();
  for (const row of rows) {
    const r = row as { name: string; status?: string; assertionResults: Array<{ status?: string }> };
    const file = path.relative(root, r.name).split(path.sep).join('/');
    if (!selectedSet.has(file) || seen.has(file)) return null;
    seen.add(file);
    if (r.status !== 'passed' && r.status !== 'failed') return null;
    if (r.assertionResults.length === 0) return null;
    const assertions = r.assertionResults;
    if (assertions.some((a) => !a || !['passed', 'failed', 'skipped', 'todo', 'disabled'].includes(a.status ?? ''))) return null;
    if (r.status === 'passed' && assertions.some((a) => a.status === 'failed')) return null;
    if (assertions.some((a) => a.status === 'failed')) failed.add(file);
    else if (r.status === 'failed') return null; // collection/hook failure, not an assertion
  }
  if (seen.size !== selectedSet.size) return null;
  return [...failed].sort();
}

export function repeatedFailedFile(first: readonly string[] | null, second: readonly string[] | null, firstUnhandled: number | null, secondUnhandled: number | null): string | null {
  if (firstUnhandled !== 0 || secondUnhandled !== 0 || !first || !second) return null;
  return first.find((f) => second.includes(f)) ?? null;
}
