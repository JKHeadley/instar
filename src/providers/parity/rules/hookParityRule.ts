/**
 * hookParityRule — parity rule for the Hook functional primitive.
 *
 * Specs:
 *   - specs/instar-concepts/hook.md (canonical shape + event vocabulary)
 *   - specs/frameworks/claude-code/hooks.md
 *   - specs/frameworks/codex-cli/hooks.md
 *
 * Reads canonical hooks from `.instar/hooks/<event>/<name>.<ext>` and
 * verifies each framework renders them correctly (script copy + entry in
 * the framework's settings/config file).
 *
 * v0.1 scope: session-start event only. Adding additional events =
 * extending the EVENT_NAME_MAPPING table at the top of the file.
 *
 * Reuses the Skill prototype's hardening patterns:
 *   - C1: strict slug grammar at every entry point.
 *   - C5: symmetric verify + orphan detection.
 *   - C7: x-instar-stamp comment line distinguishes user-edit-conflict
 *     from canonical drift; remediate refuses to overwrite conflicts.
 *
 * Deferred to v0.2 (tracked in concept spec):
 *   - Events beyond session-start.
 *   - Executable-bit verification (currently set on render; not verified).
 *   - hooks.json/settings.json merge semantics for non-Instar entries.
 *     v0.1 manages only entries whose script paths live under
 *     `.claude/hooks/<canonical-event>/` or `.agent/openai/hooks/<canonical-event>/`.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { IntelligenceFramework } from '../../../core/intelligenceProviderFactory.js';
import type {
  ParityRule,
  ParityMismatch,
  VerifyResult,
} from '../types.js';

const CANONICAL_ROOT = '.instar/hooks';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ALLOWED_EXTS = new Set(['.sh', '.js', '.mjs', '.cjs', '.ts']);
const STAMP_COMMENT_RE = /^#\s*x-instar-stamp:\s*([a-f0-9]{64})\s*$/m;
const STAMP_COMMENT_STRIP_RE = /^#\s*x-instar-stamp:\s*[a-f0-9]{64}\s*\r?\n/m;

const EVENT_NAME_MAPPING = {
  'session-start': { claude: 'SessionStart', codex: 'session_start' },
} as const;

type CanonicalEvent = keyof typeof EVENT_NAME_MAPPING;

const SUPPORTED_EVENTS: ReadonlyArray<CanonicalEvent> = Object.keys(
  EVENT_NAME_MAPPING,
) as CanonicalEvent[];

export class CanonicalHookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalHookError';
  }
}

function validateSlug(value: string, context: string): void {
  if (typeof value !== 'string' || !SLUG_RE.test(value)) {
    throw new CanonicalHookError(
      `${context}: invalid slug "${value}". Must match ${SLUG_RE.source}.`,
    );
  }
}

function validateExt(ext: string, context: string): void {
  if (!ALLOWED_EXTS.has(ext)) {
    throw new CanonicalHookError(
      `${context}: invalid extension "${ext}". Allowed: ${[...ALLOWED_EXTS].join(', ')}`,
    );
  }
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf-8').digest('hex');
}

interface CanonicalHook {
  /** Composite identifier: `<event>/<name>` */
  instanceName: string;
  event: CanonicalEvent;
  name: string;
  ext: string;
  body: string;
  bodyHash: string;
}

function parseInstanceName(instanceName: string): { event: string; name: string; ext: string } {
  const slash = instanceName.indexOf('/');
  if (slash < 0) {
    throw new CanonicalHookError(
      `instanceName "${instanceName}" must be in the form "<event>/<name>.<ext>"`,
    );
  }
  const event = instanceName.slice(0, slash);
  const fileName = instanceName.slice(slash + 1);
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) {
    throw new CanonicalHookError(
      `instanceName "${instanceName}" must end with an extension (.sh, .js, .mjs, .cjs, .ts)`,
    );
  }
  const name = fileName.slice(0, dot);
  const ext = fileName.slice(dot);
  return { event, name, ext };
}

async function readCanonicalHook(projectRoot: string, instanceName: string): Promise<CanonicalHook> {
  const { event, name, ext } = parseInstanceName(instanceName);
  validateSlug(event, 'canonical hook event');
  validateSlug(name, 'canonical hook name');
  validateExt(ext, 'canonical hook extension');
  if (!(event in EVENT_NAME_MAPPING)) {
    throw new CanonicalHookError(
      `event "${event}" is not in the v0.1 supported set. Supported: ${SUPPORTED_EVENTS.join(', ')}`,
    );
  }
  const scriptPath = path.join(projectRoot, CANONICAL_ROOT, event, `${name}${ext}`);
  let body: string;
  try {
    body = await fs.readFile(scriptPath, 'utf-8');
  } catch (err) {
    throw new CanonicalHookError(
      `canonical hook script missing or unreadable: ${path.relative(projectRoot, scriptPath)} — ${(err as Error).message}`,
    );
  }
  // Strip a leading stamp comment from body before hashing so the canonical
  // body hash is stable across rendering cycles.
  const bodyForHash = body.replace(STAMP_COMMENT_STRIP_RE, '');
  return {
    instanceName,
    event: event as CanonicalEvent,
    name,
    ext,
    body: bodyForHash,
    bodyHash: sha256(bodyForHash),
  };
}

async function listCanonicalHookInstances(projectRoot: string): Promise<string[]> {
  const root = path.join(projectRoot, CANONICAL_ROOT);
  const out: string[] = [];
  let eventDirs: string[];
  try {
    eventDirs = (await fs.readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && SLUG_RE.test(e.name))
      .map((e) => e.name);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  for (const event of eventDirs) {
    if (!(event in EVENT_NAME_MAPPING)) continue;
    const eventDir = path.join(root, event);
    let files: Array<{ name: string; isFile: boolean }>;
    try {
      files = (await fs.readdir(eventDir, { withFileTypes: true })).map((e) => ({
        name: e.name,
        isFile: e.isFile(),
      }));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile) continue;
      const dot = f.name.lastIndexOf('.');
      if (dot <= 0) continue;
      const baseName = f.name.slice(0, dot);
      const ext = f.name.slice(dot);
      if (!SLUG_RE.test(baseName)) continue;
      if (!ALLOWED_EXTS.has(ext)) continue;
      out.push(`${event}/${f.name}`);
    }
  }
  return out.sort();
}

function withStamp(body: string, bodyHash: string): string {
  const stampLine = `# x-instar-stamp: ${bodyHash}\n`;
  // Insert stamp right after a shebang if present, else at the top.
  if (body.startsWith('#!')) {
    const nl = body.indexOf('\n');
    if (nl < 0) return body + '\n' + stampLine;
    return body.slice(0, nl + 1) + stampLine + body.slice(nl + 1);
  }
  return stampLine + body;
}

function extractStamp(rendered: string): string | null {
  const m = rendered.match(STAMP_COMMENT_RE);
  return m ? m[1] : null;
}

function bodyWithoutStamp(rendered: string): string {
  return rendered.replace(STAMP_COMMENT_STRIP_RE, '');
}

// ─── Per-framework renderers ───────────────────────────────────────────

interface RenderedHookLayout {
  scriptPath: string;
  configPath: string;
}

function claudeLayout(projectRoot: string, hook: CanonicalHook): RenderedHookLayout {
  return {
    scriptPath: path.join(projectRoot, '.claude/hooks', hook.event, `${hook.name}${hook.ext}`),
    configPath: path.join(projectRoot, '.claude/settings.json'),
  };
}

function codexLayout(projectRoot: string, hook: CanonicalHook): RenderedHookLayout {
  return {
    scriptPath: path.join(projectRoot, '.agent/openai/hooks', hook.event, `${hook.name}${hook.ext}`),
    configPath: path.join(projectRoot, '.agent/openai/hooks.json'),
  };
}

async function readJsonOrDefault<T>(p: string, def: T): Promise<T> {
  try {
    const raw = await fs.readFile(p, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return def;
  }
}

interface ClaudeSettings {
  hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> }>>;
  [k: string]: unknown;
}

interface CodexHooksConfig {
  hooks?: Array<{ event: string; script: string }>;
  [k: string]: unknown;
}

function nativeEventForFramework(event: CanonicalEvent, framework: IntelligenceFramework): string {
  const m = EVENT_NAME_MAPPING[event];
  return framework === 'claude-code' ? m.claude : m.codex;
}

async function renderClaudeHook(projectRoot: string, hook: CanonicalHook): Promise<void> {
  const layout = claudeLayout(projectRoot, hook);
  await fs.mkdir(path.dirname(layout.scriptPath), { recursive: true });
  await fs.writeFile(layout.scriptPath, withStamp(hook.body, hook.bodyHash), 'utf-8');
  await fs.chmod(layout.scriptPath, 0o755);

  // Merge settings.json hook entry.
  const settings = await readJsonOrDefault<ClaudeSettings>(layout.configPath, {});
  const eventKey = nativeEventForFramework(hook.event, 'claude-code');
  const arr = settings.hooks?.[eventKey] ?? [];
  const relScriptPath = path.relative(projectRoot, layout.scriptPath);
  const desiredCommand = `bash ${relScriptPath}`;
  const existing = arr.find((entry) =>
    entry.hooks?.some((h) => h.command === desiredCommand),
  );
  if (!existing) {
    arr.push({
      matcher: '',
      hooks: [{ type: 'command', command: desiredCommand, timeout: 10000 }],
    });
    settings.hooks = { ...(settings.hooks ?? {}), [eventKey]: arr };
    await fs.mkdir(path.dirname(layout.configPath), { recursive: true });
    await fs.writeFile(layout.configPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  }
}

async function renderCodexHook(projectRoot: string, hook: CanonicalHook): Promise<void> {
  const layout = codexLayout(projectRoot, hook);
  await fs.mkdir(path.dirname(layout.scriptPath), { recursive: true });
  await fs.writeFile(layout.scriptPath, withStamp(hook.body, hook.bodyHash), 'utf-8');
  await fs.chmod(layout.scriptPath, 0o755);

  await fs.mkdir(path.dirname(layout.configPath), { recursive: true });
  const config = await readJsonOrDefault<CodexHooksConfig>(layout.configPath, { hooks: [] });
  const eventKey = nativeEventForFramework(hook.event, 'codex-cli');
  const arr = config.hooks ?? [];
  const relScriptPath = path.relative(projectRoot, layout.scriptPath);
  const existing = arr.find((entry) => entry.event === eventKey && entry.script === relScriptPath);
  if (!existing) {
    arr.push({ event: eventKey, script: relScriptPath });
    config.hooks = arr;
    await fs.writeFile(layout.configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  }
}

async function verifyClaudeHook(
  projectRoot: string,
  hook: CanonicalHook,
): Promise<Array<{ reasonCode: ParityMismatch['reasonCode']; detail: string }>> {
  const layout = claudeLayout(projectRoot, hook);
  const issues: Array<{ reasonCode: ParityMismatch['reasonCode']; detail: string }> = [];
  let rendered: string | null = null;
  try {
    rendered = await fs.readFile(layout.scriptPath, 'utf-8');
  } catch {
    issues.push({
      reasonCode: 'missing-rendered-file',
      detail: `expected ${path.relative(projectRoot, layout.scriptPath)} to exist`,
    });
    return issues;
  }
  const stamp = extractStamp(rendered);
  const rBody = bodyWithoutStamp(rendered);
  if (rBody !== hook.body) {
    if (stamp && stamp === hook.bodyHash) {
      issues.push({
        reasonCode: 'user-edit-conflict',
        detail: `claude hook script body differs from canonical but stamp matches — user edited the rendering`,
      });
    } else {
      issues.push({
        reasonCode: 'body-content-mismatch',
        detail: `claude hook script body differs from canonical (stamp ${stamp ? 'stale' : 'missing'})`,
      });
    }
  }
  // settings.json entry presence
  const settings = await readJsonOrDefault<ClaudeSettings>(layout.configPath, {});
  const eventKey = nativeEventForFramework(hook.event, 'claude-code');
  const arr = settings.hooks?.[eventKey] ?? [];
  const relScriptPath = path.relative(projectRoot, layout.scriptPath);
  const desiredCommand = `bash ${relScriptPath}`;
  const hasEntry = arr.some((entry) => entry.hooks?.some((h) => h.command === desiredCommand));
  if (!hasEntry) {
    issues.push({
      reasonCode: 'sibling-artifact-missing',
      detail: `settings.json missing hook entry for ${eventKey} → ${relScriptPath}`,
    });
  }
  return issues;
}

async function verifyCodexHook(
  projectRoot: string,
  hook: CanonicalHook,
): Promise<Array<{ reasonCode: ParityMismatch['reasonCode']; detail: string }>> {
  const layout = codexLayout(projectRoot, hook);
  const issues: Array<{ reasonCode: ParityMismatch['reasonCode']; detail: string }> = [];
  let rendered: string | null = null;
  try {
    rendered = await fs.readFile(layout.scriptPath, 'utf-8');
  } catch {
    issues.push({
      reasonCode: 'missing-rendered-file',
      detail: `expected ${path.relative(projectRoot, layout.scriptPath)} to exist`,
    });
    return issues;
  }
  const stamp = extractStamp(rendered);
  const rBody = bodyWithoutStamp(rendered);
  if (rBody !== hook.body) {
    if (stamp && stamp === hook.bodyHash) {
      issues.push({
        reasonCode: 'user-edit-conflict',
        detail: `codex hook script body differs from canonical but stamp matches — user edited the rendering`,
      });
    } else {
      issues.push({
        reasonCode: 'body-content-mismatch',
        detail: `codex hook script body differs from canonical (stamp ${stamp ? 'stale' : 'missing'})`,
      });
    }
  }
  const config = await readJsonOrDefault<CodexHooksConfig>(layout.configPath, {});
  const eventKey = nativeEventForFramework(hook.event, 'codex-cli');
  const relScriptPath = path.relative(projectRoot, layout.scriptPath);
  const hasEntry = (config.hooks ?? []).some(
    (entry) => entry.event === eventKey && entry.script === relScriptPath,
  );
  if (!hasEntry) {
    issues.push({
      reasonCode: 'sibling-artifact-missing',
      detail: `hooks.json missing entry for ${eventKey} → ${relScriptPath}`,
    });
  }
  return issues;
}

// ─── Orphan detection ──────────────────────────────────────────────────

async function listFrameworkScripts(
  projectRoot: string,
  framework: IntelligenceFramework,
): Promise<Array<{ event: string; name: string; ext: string; fullPath: string }>> {
  const root = framework === 'claude-code'
    ? path.join(projectRoot, '.claude/hooks')
    : path.join(projectRoot, '.agent/openai/hooks');
  let eventDirs: string[];
  try {
    eventDirs = (await fs.readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && SLUG_RE.test(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
  const out: Array<{ event: string; name: string; ext: string; fullPath: string }> = [];
  for (const event of eventDirs) {
    let files: Array<{ name: string; isFile: boolean }>;
    try {
      files = (await fs.readdir(path.join(root, event), { withFileTypes: true })).map((e) => ({
        name: e.name,
        isFile: e.isFile(),
      }));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile) continue;
      const dot = f.name.lastIndexOf('.');
      if (dot <= 0) continue;
      const baseName = f.name.slice(0, dot);
      const ext = f.name.slice(dot);
      if (!SLUG_RE.test(baseName)) continue;
      if (!ALLOWED_EXTS.has(ext)) continue;
      out.push({ event, name: baseName, ext, fullPath: path.join(root, event, f.name) });
    }
  }
  return out;
}

async function findOrphans(
  projectRoot: string,
  framework: IntelligenceFramework,
  canonicalInstances: Set<string>,
): Promise<ParityMismatch[]> {
  const rendered = await listFrameworkScripts(projectRoot, framework);
  const out: ParityMismatch[] = [];
  for (const r of rendered) {
    const instanceName = `${r.event}/${r.name}${r.ext}`;
    if (canonicalInstances.has(instanceName)) continue;
    out.push({
      primitive: 'hook',
      instanceName,
      framework,
      reasonCode: 'orphan-rendering-found',
      detail: `rendered hook script has no canonical counterpart: ${path.relative(projectRoot, r.fullPath)}`,
    });
  }
  return out;
}

async function removeOrphanScripts(
  projectRoot: string,
  framework: IntelligenceFramework,
  canonicalInstances: Set<string>,
): Promise<string[]> {
  const rendered = await listFrameworkScripts(projectRoot, framework);
  const removed: string[] = [];
  for (const r of rendered) {
    const instanceName = `${r.event}/${r.name}${r.ext}`;
    if (canonicalInstances.has(instanceName)) continue;
    await fs.rm(r.fullPath, { force: true });
    removed.push(r.fullPath);
  }
  return removed;
}

// ─── Exported ParityRule ───────────────────────────────────────────────

export const hookParityRule: ParityRule = {
  primitive: 'hook',
  frameworks: ['claude-code', 'codex-cli'],
  remediationPolicy: 'mirror-trust',

  async listInstances(projectRoot) {
    return listCanonicalHookInstances(projectRoot);
  },

  async verify(projectRoot, instanceName): Promise<VerifyResult> {
    let hook: CanonicalHook;
    try {
      hook = await readCanonicalHook(projectRoot, instanceName);
    } catch (err) {
      return {
        ok: false,
        mismatches: [
          {
            primitive: 'hook',
            instanceName,
            framework: 'canonical',
            reasonCode: 'canonical-read-error',
            detail: (err as Error).message,
          },
        ],
      };
    }
    const mismatches: ParityMismatch[] = [];
    for (const framework of this.frameworks) {
      const issues = framework === 'claude-code'
        ? await verifyClaudeHook(projectRoot, hook)
        : await verifyCodexHook(projectRoot, hook);
      for (const issue of issues) {
        mismatches.push({
          primitive: 'hook',
          instanceName,
          framework,
          reasonCode: issue.reasonCode,
          detail: issue.detail,
        });
      }
    }
    return { ok: mismatches.length === 0, mismatches };
  },

  async remediate(projectRoot, instanceName, framework) {
    const hook = await readCanonicalHook(projectRoot, instanceName);
    // Refuse on user-edit-conflict.
    const issues = framework === 'claude-code'
      ? await verifyClaudeHook(projectRoot, hook)
      : await verifyCodexHook(projectRoot, hook);
    const conflict = issues.find((i) => i.reasonCode === 'user-edit-conflict');
    if (conflict) {
      throw new CanonicalHookError(
        `refused to remediate ${instanceName} on ${framework} due to user-edit-conflict: ${conflict.detail}`,
      );
    }
    if (framework === 'claude-code') {
      await renderClaudeHook(projectRoot, hook);
    } else {
      await renderCodexHook(projectRoot, hook);
    }
  },

  async listOrphans(projectRoot): Promise<ParityMismatch[]> {
    const canonical = new Set(await listCanonicalHookInstances(projectRoot));
    const out: ParityMismatch[] = [];
    for (const framework of this.frameworks) {
      out.push(...(await findOrphans(projectRoot, framework, canonical)));
    }
    return out;
  },

  async removeOrphans(projectRoot, framework): Promise<string[]> {
    const canonical = new Set(await listCanonicalHookInstances(projectRoot));
    return removeOrphanScripts(projectRoot, framework, canonical);
  },
};
