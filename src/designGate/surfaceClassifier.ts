import { DESIGN_SURFACES, type DesignSurface } from './standardParser.js';

export interface DesignScreen {
  id: string;
  surface: DesignSurface;
  title: string;
  mainQuestion: string;
  route: string;
  sources: string[];
  shared: string[];
  capture: 'captured' | 'uncaptured';
  trackedBy?: string;
  seed?: { entry: string; version: string };
}
export interface ScreenRegistry { version: 1; screens: DesignScreen[] }
export interface RegistryError { code: string; screen?: string }
/** Repository paths, never URLs or shell fragments. Sources are literal paths, not globs. */
function repoPath(input: string): string | null {
  const p = input;
  if (p.includes('\\')) return null;
  if (!p || p.startsWith('/') || /^[A-Za-z]:/.test(p) || /[\0\r\n]/.test(p)
    || p.split('/').some(s => !s || s === '.' || s === '..')) return null;
  return p;
}
const sourcePath = (p: unknown): p is string => typeof p === 'string' && repoPath(p) !== null && !/[\*?\[\]]/.test(p);
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Structural validation only: this does not certify that a screen has been rendered. */
export function validateScreenRegistry(value: unknown): RegistryError[] {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.screens)) return [{ code: 'invalid-registry' }];
  const errors: RegistryError[] = [];
  const ids = new Set<string>(); const routes = new Set<string>();
  for (const item of value.screens) {
    if (!object(item)) { errors.push({ code: 'invalid-screen' }); continue; }
    const id = typeof item.id === 'string' ? item.id : undefined;
    const fail = (code: string) => errors.push({ code, screen: id });
    if (!id || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) fail('invalid-screen-id');
    if (id && ids.has(id)) fail('duplicate-screen');
    if (id) ids.add(id);
    if (!DESIGN_SURFACES.includes(item.surface as DesignSurface)) fail('invalid-surface');
    if (typeof item.title !== 'string' || !item.title.trim()) fail('missing-title');
    if (typeof item.mainQuestion !== 'string' || !item.mainQuestion.trim()) fail('missing-main-question');
    if (typeof item.route !== 'string' || !item.route.startsWith('/') || item.route.startsWith('//') || /[\0\r\n]/.test(item.route)) fail('invalid-route');
    else {
      const key = `${String(item.surface)}:${item.route}`;
      if (routes.has(key)) fail('duplicate-route');
      routes.add(key);
    }
    if (!Array.isArray(item.sources) || item.sources.length === 0 || !item.sources.every(sourcePath)) fail('invalid-source');
    if (!Array.isArray(item.shared) || !item.shared.every(sourcePath)) fail('invalid-shared-source');
    if (item.capture === 'uncaptured') {
      if (typeof item.trackedBy !== 'string' || !/^CMT-[1-9]\d*$/.test(item.trackedBy)) fail('uncaptured-untracked');
    } else if (item.capture === 'captured') {
      if (!object(item.seed) || !sourcePath(item.seed.entry) || typeof item.seed.version !== 'string' || !item.seed.version.trim()) fail('missing-seed');
    } else fail('invalid-capture-state');
  }
  return errors;
}

export interface SurfaceClassification {
  kind: 'none' | 'policy' | 'ui' | 'unreadable';
  screens: string[];
  uiPaths: string[];
  unregistered: string[];
  policyPaths: string[];
  errors: string[];
}
const isTest = (p: string) => /(?:^|\/)(?:tests?|__tests__|fixtures)(?:\/|$)/.test(p) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(p);
const isPolicy = (p: string) => p === 'docs/DESIGN-STANDARD.md' || p.startsWith('docs/design/')
  || p.startsWith('docs/design-feedback/') || p.startsWith('scripts/design/') || p.startsWith('src/designGate/');
const uiRoot = (p: string) => p.startsWith('dashboard/') || p.startsWith('dashboard-pair/');
const wholeHtml = (text: string) => /<!doctype\s+html\b|<html(?:\s|>)/i.test(text);

/**
 * The executing caller supplies trusted BASE code and the complete name-only git diff.
 * Candidate metadata may register new sources, but cannot erase base classification.
 * Independent harness review and policy lint are separate required consumers.
 */
export function classifyDesignPaths(input: {
  changedPaths: readonly string[] | null;
  baseRegistry: ScreenRegistry | null;
  candidateRegistry?: ScreenRegistry | null;
  /** Current or deleted/base source text; null/absent means unreadable, never non-UI. */
  sourceText?: Readonly<Record<string, string | null>>;
}): SurfaceClassification {
  const out: SurfaceClassification = { kind: 'none', screens: [], uiPaths: [], unregistered: [], policyPaths: [], errors: [] };
  const baseErrors = validateScreenRegistry(input.baseRegistry);
  const candidateErrors = input.candidateRegistry === undefined ? [] : validateScreenRegistry(input.candidateRegistry);
  if (baseErrors.length || candidateErrors.length || input.changedPaths === null) return { ...out, kind: 'unreadable', errors: ['unreadable-policy-or-diff'] };
  const registries = [input.baseRegistry!, ...(input.candidateRegistry ? [input.candidateRegistry] : [])];
  const byPath = new Map<string, Set<string>>();
  for (const registry of registries) for (const screen of registry.screens) for (const source of [...screen.sources, ...screen.shared]) {
    const p = repoPath(source)!;
    const ids = byPath.get(p) ?? new Set<string>(); ids.add(screen.id); byPath.set(p, ids);
  }
  const affected = new Set<string>();
  for (const raw of input.changedPaths!) {
    const p = repoPath(raw);
    if (!p) { out.errors.push('invalid-repository-path'); continue; }
    const registered = byPath.get(p);
    if (isTest(p) && !registered) continue;
    if (isPolicy(p) && !registered) { out.policyPaths.push(p); continue; }
    let ui = uiRoot(p) || !!registered || /\.(?:html?|css)$/i.test(p);
    if (!ui && /\.[cm]?[jt]sx?$/.test(p)) {
      const text = input.sourceText?.[p];
      if (typeof text !== 'string') { out.errors.push(`unreadable-source:${p}`); continue; }
      ui = wholeHtml(text);
    }
    if (!ui) continue;
    out.uiPaths.push(p);
    if (registered) for (const id of registered) affected.add(id);
    else out.unregistered.push(p);
  }
  out.screens = [...affected].sort();
  for (const key of ['uiPaths', 'unregistered', 'policyPaths', 'errors'] as const) out[key] = [...new Set(out[key])].sort();
  out.kind = out.errors.length ? 'unreadable' : out.uiPaths.length ? 'ui' : out.policyPaths.length ? 'policy' : 'none';
  return out;
}
